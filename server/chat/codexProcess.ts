import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, SendPriority } from '../../shared/model';
import { CODEX_CONTEXT_WINDOW } from '../adapters/claude/pricing';
import { cleanEnv } from '../auth';
import { buildCodexArgs, sandboxFor } from './codexArgs';
import { contextUsed, isToolCall, itemFromCodex, parseCodexFailure, type CodexPhase } from './codexEvents';
import { hasCheckpoint, stripCheckpoint } from './items';
import { ChatProcess, type ChatProcessOptions } from './process';
import { killTree } from './registry';
import { tryJson } from '../adapters/claude/fsutil';

// Um funcionário conversando pelo Claudio’s Club no Codex (CLI da OpenAI), com a mesma cara do ChatProcess: o manager,
// a tela e as tarefas falam com os dois do mesmo jeito. A diferença está por baixo: o Codex não tem um processo que fica
// aberto lendo mensagens. Cada mensagem é uma execução (`codex exec --json`, e `codex exec resume <thread_id> --json` nas
// seguintes) com o prompt pelo stdin; o fim do turno é o fim da execução. Interromper é matar a execução. Não há pedido de
// permissão: o exec não pergunta, a sandbox decide (ver codexArgs.ts). Os eventos viram os mesmos itens da conversa
// (codexEvents.ts), e tudo que passa por aqui vai pelo filtro de segredos, como no caminho do Claude.

export interface CodexProcessOptions extends Omit<ChatProcessOptions, 'args'> {
  /** Modo de permissão do Claudio’s Club (plan, default, acceptEdits, auto, bypassPermissions): vira a sandbox a cada execução. */
  permissionMode: string;
  /** Texto da ficha (developer_instructions). */
  instructions?: string | null;
  /** Pastas extras com escrita na sandbox de escrita (a ficha, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** Saída de `codexSecretArgs` (ver codexArgs.ts). */
  secretArgs?: string[];
  /** thread_id de uma conversa que já existe: a primeira mensagem já retoma. */
  threadId?: string | null;
  /** Onde guardar o thread_id para continuar depois que o processo fechar (ou o servidor reiniciar). */
  threadFile?: string;
  /** Troca o encerramento da execução nos testes (o padrão encerra o grupo de processos). */
  kill?: (child: ChildProcessWithoutNullStreams) => void;
}

/** Id de conversa do Codex: só o que serve de argumento sem risco (UUID). */
const THREAD_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/** O thread_id guardado; null se não há arquivo ou ele não vale. */
export async function readCodexThread(file: string): Promise<string | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  const id = raw === null ? null : (tryJson(raw) as { threadId?: unknown } | null)?.threadId;
  return typeof id === 'string' && THREAD_ID.test(id) ? id : null;
}

async function writeCodexThread(file: string, threadId: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ threadId, savedAt: new Date().toISOString() }) + '\n');
}

interface Job {
  prompt: string;
  /** Id do item da mensagem na conversa (perde o `queued` quando a vez dela chega). */
  itemId: string;
}

/** O que se sabe de uma execução enquanto ela roda. */
interface Run {
  /** Torna únicos os ids dos itens (o Codex reinicia `item_0` a cada execução). */
  key: string;
  /** O fim do turno (turn.completed, turn.failed ou o processo ter saído) já foi tratado. */
  ended: boolean;
  /** Ferramentas usadas (ids): base da estimativa de contexto. */
  tools: Set<string>;
  /** Última mensagem de `error` (o texto do erro, se o turno acabar sem turn.failed). */
  lastError: string | null;
  stderr: string;
  buf: string;
  closed: boolean;
}

const newRun = (): Run => ({ key: randomUUID().slice(0, 8), ended: false, tools: new Set(), lastError: null, stderr: '', buf: '', closed: false });

export class CodexProcess extends ChatProcess {
  private current: ChildProcessWithoutNullStreams | null = null;
  private run: Run | null = null;
  private readonly queue: Job[] = [];
  private thread: string | null;
  private closing = false;

  constructor(private readonly codex: CodexProcessOptions) {
    super({ ...codex, args: [] });
    this.thread = codex.threadId && THREAD_ID.test(codex.threadId) ? codex.threadId : null;
    this.state = { ...this.state, permissionMode: codex.permissionMode };
  }

  override get engine(): 'claude' | 'codex' {
    return 'codex';
  }

  /** Pid da execução em andamento; entre as mensagens não há processo. */
  override get pid(): number | null {
    return this.current?.pid ?? null;
  }

  /** O thread_id do Codex desta conversa, depois da primeira execução (ou o que já veio gravado). */
  get threadId(): string | null {
    return this.thread;
  }

  /** Não abre processo: o Codex só roda quando chega uma mensagem. */
  override start() {
    this.setState({ running: true, error: null });
  }

  // ---- mensagens ----

  override send(text: string, priority: SendPriority = 'next', images: string[] = [], notice?: string, files: ChatAttachment[] = []) {
    if (!this.state.running || this.closing) throw new Error('a conversa não está aberta');
    this.lastActivity = Date.now();
    this.checkpointSeen = false;
    const queued = this.state.busy ? priority : undefined;
    this.scan(text);
    // Arquivo de texto vai dentro do prompt; imagem e PDF ainda não vão ao Codex (aviso).
    const inline = files.filter((f) => f.mediaType !== 'application/pdf');
    const skipped = images.length + (files.length - inline.length);
    if (skipped) this.addNotice(`${skipped === 1 ? 'Um anexo' : `${skipped} anexos`} (imagem ou PDF) não ${skipped === 1 ? 'foi' : 'foram'} enviado${skipped === 1 ? '' : 's'} ao Codex: este motor ainda lê só texto.`, 'warn');
    const prompt = [notice, ...inline.map((f) => `Arquivo anexado: ${f.name}\n\`\`\`\n${f.data}\n\`\`\``), text].filter(Boolean).join('\n\n') || '(mensagem vazia)';
    const id = `u:${randomUUID()}`;
    this.putItem({
      kind: 'user',
      id,
      text,
      at: new Date().toISOString(),
      ...(queued && { queued }),
      ...(images.length && { images: images.length }),
      ...(files.length && { files: files.map((f) => f.name) }),
    });
    const job: Job = { prompt, itemId: id };
    this.waitingReply = true;
    this.setState({ busy: true, error: null });
    if (queued === 'now' && this.current) {
      // Passa na frente: encerra a execução atual (o turno dela termina como interrompido) e esta é a próxima.
      this.queue.unshift(job);
      this.stopCurrent();
      return;
    }
    this.queue.push(job);
    this.pump();
  }

  /** Interromper = matar a execução em andamento (a conversa fica no que o Codex já gravou). */
  override interrupt() {
    this.stopCurrent();
  }

  override stop() {
    if (!this.state.running || this.closing) return;
    this.closing = true;
    this.queue.length = 0;
    if (this.current) this.stopCurrent();
    else this.finishSession(null);
  }

  override compact() {
    this.addNotice('O Codex não tem /compact aqui. Para uma conversa mais leve, abra uma conversa nova: a ficha e a memória levam o essencial.', 'warn');
  }

  // ---- ajustes: valem na próxima execução (cada mensagem abre a sua) ----

  override setPermissionMode(mode: string, label: string) {
    this.setState({ permissionMode: mode });
    const bypass = mode === 'bypassPermissions' ? ' No Codex, mesmo assim, a escrita fica na pasta de trabalho e sem rede.' : '';
    const later = this.state.busy ? ' Vale a partir da próxima mensagem.' : '';
    this.addNotice(`${label}.${bypass}${later}`.replace(/\.\.$/, '.'));
  }

  override setModel(model: string, label: string) {
    this.setState({ model });
    if (label) this.addNotice(label);
  }

  override setEffort(effort: string, label: string) {
    this.setState({ effort });
    if (label) this.addNotice(label);
  }

  // ---- o que só existe no Claude Code ----

  override request(_request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return Promise.reject(new Error('não existe no Codex'));
  }

  override async rename(_title: string): Promise<void> {
    // O nome da conversa é do Claude Code (transcript); no Codex não há onde gravar.
  }

  override async mcpStatus(): Promise<Array<{ name: string; status: string }>> {
    return [];
  }

  override async mcpToggle(_name: string, _enabled: boolean): Promise<void> {
    throw new Error('os MCPs não valem no Codex (ainda)');
  }

  override async stopTask(_taskId: string): Promise<void> {
    throw new Error('não há agents nem comandos em segundo plano no Codex');
  }

  // ---- execução ----

  /** Próxima mensagem da fila, se nenhuma execução está rodando. */
  private pump() {
    if (this.current || this.closing || !this.state.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const item = this.items.get(job.itemId);
    if (item?.kind === 'user' && item.queued) {
      const { queued: _queued, ...rest } = item;
      this.putItem(rest);
    }
    this.launch(job);
  }

  private launch(job: Job) {
    const o = this.codex;
    const args = buildCodexArgs({
      cwd: o.cwd,
      model: this.state.model,
      effort: this.state.effort,
      sandbox: sandboxFor(this.state.permissionMode),
      instructions: o.instructions,
      writableRoots: o.writableRoots,
      secretArgs: o.secretArgs,
      threadId: this.thread,
    });
    const run = newRun();
    this.run = run;
    // O mesmo ambiente do Claude (MYCO_SESSION_ID para o despertador e as tarefas por curl), sem as variáveis CLAUDE*/ANTHROPIC*.
    const env = { ...cleanEnv(), MYCO_SESSION_ID: o.sessionId };
    // No Unix o processo vira líder do próprio grupo: encerrar o grupo leva também os comandos que ele abriu.
    const make =
      o.spawnImpl ??
      ((cmd, a, so) => spawn(cmd, a, { ...so, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }));
    let child: ChildProcessWithoutNullStreams;
    try {
      child = make('codex', args, { cwd: o.cwd, env });
    } catch (err) {
      this.current = null;
      this.closeRun(run, null, `não foi possível iniciar o codex: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.current = child;
    child.stdin.on('error', () => {}); // o codex pode sair antes de ler o prompt inteiro
    child.stdin.end(job.prompt);
    child.stdout.on('data', (chunk: Buffer) => this.feed(run, chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      run.stderr = (run.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    child.on('error', (err) => this.closeRun(run, null, `não foi possível iniciar o codex: ${err.message}`));
    child.on('close', (code) => this.closeRun(run, code));
  }

  private stopCurrent() {
    const child = this.current;
    if (!child) return;
    this.stopping = true;
    if (this.codex.kill) this.codex.kill(child);
    else if (child.pid) void killTree(child.pid);
  }

  private feed(run: Run, text: string) {
    this.lastActivity = Date.now();
    run.buf += text;
    let nl: number;
    while ((nl = run.buf.indexOf('\n')) !== -1) {
      const line = run.buf.slice(0, nl).trim();
      run.buf = run.buf.slice(nl + 1);
      if (line) this.handle(tryJson(line) as Record<string, unknown> | null);
    }
  }

  /** A execução terminou (o processo fechou os canais, ou nem abriu). Sem turn.completed/turn.failed no caminho, o turno acaba aqui. */
  private closeRun(run: Run, code: number | null, spawnError?: string) {
    if (run.closed) return;
    run.closed = true;
    if (run.buf.trim()) this.handle(tryJson(run.buf.trim()) as Record<string, unknown> | null);
    run.buf = '';
    if (this.current && this.run === run) this.current = null;
    const stopped = this.stopping;
    this.stopping = false;
    if (!run.ended) {
      if (stopped) this.endTurn(run, { kind: 'stopped' });
      else {
        const failed = spawnError ?? (code && code !== 0 ? (run.lastError ?? (run.stderr.trim() || `o codex saiu com código ${code}`)) : run.lastError);
        this.endTurn(run, { kind: 'failed', text: failed ?? 'O Codex terminou sem responder.' });
      }
    }
    if (this.run === run) this.run = null;
    if (this.closing) this.finishSession(null);
    else this.pump();
  }

  private endTurn(run: Run, outcome: { kind: 'ok' } | { kind: 'stopped' } | { kind: 'failed'; text: string }) {
    if (run.ended) return;
    run.ended = true;
    const at = new Date().toISOString();
    if (outcome.kind === 'stopped') {
      if (!this.closing) this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Turno interrompido', tone: 'info', at });
    } else if (outcome.kind === 'failed') {
      // O limite de uso do ChatGPT aparece como erro da conversa; o Claudio’s Club não continua sozinho (v1).
      this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: parseCodexFailure(outcome.text).text, tone: 'error', at });
    }
    if (this.queue.length && !this.closing) return; // a próxima mensagem já espera: segue ocupado
    this.waitingReply = false;
    this.setState({ busy: false, compacting: false });
    this.idleCheck('turn');
  }

  private finishSession(error: string | null) {
    if (!this.state.running) return;
    this.opts.onExit?.(null, error);
    this.waitingReply = false;
    this.setState({ running: false, busy: false, compacting: false, error, background: [] });
    for (const done of this.exitWaiters.splice(0)) done();
    this.opts.onIdle?.('exit');
  }

  // ---- eventos do `codex exec --json` ----

  /** Exposto para os testes alimentarem eventos sem processo. */
  override handle(ev: Record<string, unknown> | null) {
    if (!ev || typeof ev.type !== 'string') return;
    const run = (this.run ??= newRun());
    switch (ev.type) {
      case 'thread.started': {
        const id = typeof ev.thread_id === 'string' && THREAD_ID.test(ev.thread_id) ? ev.thread_id : null;
        if (id && id !== this.thread) {
          this.thread = id;
          if (this.codex.threadFile) void writeCodexThread(this.codex.threadFile, id).catch(() => {});
        }
        return;
      }
      case 'turn.started':
        this.setState({ busy: true });
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.onItem(run, ev.type.slice(5) as CodexPhase, ev.item);
        return;
      case 'turn.completed': {
        const used = contextUsed(ev.usage, run.tools.size);
        if (used) this.setState({ context: { used, window: CODEX_CONTEXT_WINDOW, percent: Math.round((used / CODEX_CONTEXT_WINDOW) * 100) } });
        this.endTurn(run, { kind: 'ok' });
        return;
      }
      case 'turn.failed': {
        const error = (ev.error ?? {}) as { message?: unknown };
        this.endTurn(run, { kind: 'failed', text: typeof error.message === 'string' && error.message ? error.message : (run.lastError ?? '') });
        return;
      }
      case 'error':
        // O mesmo texto vem de novo no turn.failed (que é quem avisa a conversa); sozinho, vale no fim da execução.
        if (typeof ev.message === 'string') run.lastError = ev.message;
        return;
    }
  }

  private onItem(run: Run, phase: CodexPhase, raw: unknown) {
    const next = itemFromCodex(raw, run.key, new Date().toISOString(), phase);
    if (!next) return;
    const prev = this.items.get(next.id);
    if (isToolCall(raw)) run.tools.add(next.id);
    // Segredos: tudo que o funcionário escreve, roda e lê passa pelo filtro (só o tipo vai para o aviso; ver secrets.ts).
    if (next.kind === 'assistant') {
      this.scan(next.text);
      if (hasCheckpoint(next.text)) this.checkpointSeen = true;
      this.putItem({ ...next, text: stripCheckpoint(next.text), at: (prev?.kind === 'assistant' ? prev.at : null) ?? next.at });
    } else if (next.kind === 'tool') {
      this.scan(next.input);
      if (next.result) this.scan(next.result);
      this.putItem({ ...next, at: (prev?.kind === 'tool' ? prev.at : null) ?? next.at });
    } else {
      this.putItem(next);
    }
  }
}
