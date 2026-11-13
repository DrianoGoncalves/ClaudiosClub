import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, SendPriority } from '../../shared/model';
import { CODEX_CONTEXT_WINDOW } from '../adapters/claude/pricing';
import { resolveCodexCommand, type CodexEnvStatus } from '../codexEnv';
import { pickCodexSubstitute, type CodexModelInfo } from '../codexModels';
import { cleanEnv, withoutMycoToken } from '../auth';
import { buildCodexArgs, CodexBlockedError, codexModelOrNull, instructionsInArgv, promptWithInstructions, sandboxFor, type CodexExtraMcp, type CodexMcpServer, type CodexSecrets } from './codexArgs';
import { contextUsed, isModelUnavailable, isToolCall, itemFromCodex, parseCodexFailure, type CodexPhase } from './codexEvents';
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
  /** Texto da ficha: vai em `developer_instructions`; passando de ~24 KB (ou no Windows), no começo do prompt da primeira mensagem (ver `instructionsInArgv`). */
  instructions?: string | null;
  /** Pastas extras com escrita na sandbox de escrita (a pasta das fichas, quando a conversa roda numa worktree). */
  writableRoots?: string[];
  /** A ficha do próprio funcionário (os arquivos que existem): só leitura na sandbox de escrita. */
  readOnlyPaths?: string[];
  /** MCP de SSH da ficha (conexões SSH; null = sem ele). Ver `codexSshMcpArgs` em codexArgs.ts. */
  sshMcp?: CodexMcpServer | null;
  /** MCP do Chrome do usuário (null = sem ele). Ver `codexChromeMcpArgs` em codexArgs.ts. */
  chromeMcp?: CodexMcpServer | null;
  /** MCP do navegador limpo (null = sem ele). Ver `codexCleanBrowserMcpArgs` em codexArgs.ts. */
  cleanMcp?: CodexMcpServer | null;
  /** MCPs da biblioteca e da ficha (projeto, usuário, local). Ver `codexExtraMcpArgs` em codexArgs.ts. */
  extraMcps?: CodexExtraMcp[];
  /** O que o bloqueio de segredos precisa saber; `mycoHome` é obrigatório (ver `CodexSecrets` em codexArgs.ts). */
  secrets: CodexSecrets;
  /**
   * Confere o `codex` instalado antes de cada execução (versão mínima e `network_proxy`, ver codexEnv.ts): com erro, a mensagem vira o erro
   * da conversa e nada roda; sem `network_proxy`, roda sem rede e avisa. Sem esta função a rede fica desligada (falha fechada).
   */
  env?: () => Promise<CodexEnvStatus>;
  /**
   * "Permitir acesso à internet" (a busca na web do Codex, ver `codexSafetyArgs`), lida a CADA execução: a mudança nas Configurações vale na
   * próxima mensagem. Sem esta função, ou se ela falhar, a busca fica desligada (falha fechada).
   */
  internetAccess?: () => Promise<boolean>;
  /** Sistema (os testes trocam). */
  platform?: NodeJS.Platform;
  /** thread_id de uma conversa que já existe: a primeira mensagem já retoma. */
  threadId?: string | null;
  /** Endereço do Claudio’s Club para a sandbox (http://127.0.0.2:<porta>, ver server/callers.ts): vai em `MYCO_URL` no ambiente de cada execução. */
  mycoUrl?: string;
  /** Onde guardar o thread_id para continuar depois que o processo fechar (ou o servidor reiniciar). */
  threadFile?: string;
  /** Chamado quando o Codex dá o thread_id desta conversa (ver CodexSpawn.onThread). */
  onThread?: (threadId: string) => void;
  /**
   * Catálogo de modelos da conta (GET /api/codex/models), para o plano B: se a conta recusar o modelo da ficha, o turno é refeito uma vez
   * com o mais parecido daqui (ver `pickCodexSubstitute`). Sem ele, o plano B roda sem `-m` (o padrão do Codex).
   */
  models?: () => Promise<ReadonlyArray<Pick<CodexModelInfo, 'slug'>>>;
  /**
   * Conversa no motor/modelo secundário (ver `EngineOverride`): o modelo escolhido vale. Se a conta recusar, o turno falha com o erro
   * do modelo recusado, sem o plano B (que trocaria de modelo).
   */
  noSubstitute?: boolean;
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
  /** O plano B (outro modelo) já foi usado nesta mensagem: uma vez só. */
  retried?: boolean;
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
  /** A mensagem desta execução e o modelo que foi em `-m` (null: o padrão do Codex), para o plano B. */
  job: Job | null;
  model: string | null;
  /** Começou sem thread: o `thread.started` dela, se o plano B entrar, é de uma thread vazia. */
  fresh: boolean;
  /** Falhou por modelo que a conta não aceita: quando o processo fechar, o plano B refaz o turno. */
  retry: boolean;
}

const newRun = (): Run => ({ key: randomUUID().slice(0, 8), ended: false, tools: new Set(), lastError: null, stderr: '', buf: '', closed: false, job: null, model: null, fresh: false, retry: false });

export class CodexProcess extends ChatProcess {
  private current: ChildProcessWithoutNullStreams | null = null;
  private run: Run | null = null;
  private readonly queue: Job[] = [];
  private thread: string | null;
  private closing = false;
  /** O plano B está escolhendo o modelo, ou o Codex está sendo conferido: a fila espera (não abre outra execução no meio). */
  private holding = false;
  /** O aviso de que a rede local ficou desligada (falta o `network_proxy`) já foi dado: uma vez por conversa. */
  private networkWarned = false;

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

  override send(text: string, priority: SendPriority = 'next', images: string[] = [], notice?: string, files: ChatAttachment[] = [], fromStaff = false) {
    if (!this.state.running || this.closing) throw new Error('a conversa não está aberta');
    this.lastActivity = Date.now();
    this.checkpointSeen = false;
    const queued = this.state.busy ? priority : undefined;
    // Mesma regra do processo Claude: o que você escreve é "owner"; o que outro funcionário manda não tem origem.
    this.scan(text, fromStaff ? undefined : 'owner');
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
    const bypass = mode === 'bypassPermissions' ? ' No Codex, mesmo assim, a escrita fica na pasta de trabalho e a rede só alcança o Claudio’s Club (127.0.0.2).' : '';
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
    if (this.current || this.closing || this.holding || !this.state.running) return;
    const job = this.queue.shift();
    if (!job) return;
    const item = this.items.get(job.itemId);
    if (item?.kind === 'user' && item.queued) {
      const { queued: _queued, ...rest } = item;
      this.putItem(rest);
    }
    this.launch(job);
  }

  /**
   * Abre a execução de uma mensagem. Com `env`, confere antes o `codex` instalado (a fila espera enquanto isso); sem ele, a rede fica
   * desligada. `override`: o plano B manda o modelo desta mensagem (null = sem `-m`); a ficha e o estado da conversa não mudam.
   */
  private launch(job: Job, override?: { model: string | null }) {
    const check = this.codex.env;
    const internet = this.codex.internetAccess;
    const none: CodexEnvStatus = { error: null, version: null, networkProxy: false, notice: null };
    if (!check && !internet) {
      this.exec(job, override, none, false);
      return;
    }
    this.holding = true;
    // A opção de internet é lida nesta execução (não na criação da conversa); erro ao ler = desligada.
    const access = internet ? internet().catch(() => false) : Promise.resolve(false);
    const status = check
      ? check().catch((err): CodexEnvStatus => ({ error: `não consegui conferir o Codex: ${err instanceof Error ? err.message : String(err)}`, version: null, networkProxy: false, notice: null }))
      : Promise.resolve(none);
    void Promise.all([status, access]).then(([st, internetAccess]) => {
      this.holding = false;
      if (this.closing || !this.state.running) return;
      this.exec(job, override, st, internetAccess);
    });
  }

  private exec(job: Job, override: { model: string | null } | undefined, status: CodexEnvStatus, internetAccess: boolean) {
    const o = this.codex;
    // Alias ou id do Claude (opus, sonnet…) não vale para o Codex: vai sem `-m` (o padrão dele), e o plano B nem entra (não há modelo pedido).
    const model = override ? override.model : codexModelOrNull(this.state.model);
    const run = newRun();
    run.job = job;
    run.model = model;
    run.fresh = this.thread === null;
    this.run = run;
    // Cada execução é um turno do Codex (o fim do turno é o fim da execução): o teto começa aqui, zerado.
    this.startTurnBudget();
    // Falha fechada: Codex que não serve, segredo que não dá para proteger ou qualquer erro ao montar a linha de comando acaba o turno com
    // a mensagem (a conversa fica livre), em vez de rodar sem proteção ou travar em "trabalhando".
    if (status.error) {
      this.closeRun(run, null, status.error);
      return;
    }
    if (!status.networkProxy && status.notice && !this.networkWarned) {
      this.networkWarned = true;
      this.addNotice(status.notice, 'warn');
    }
    let args: string[];
    try {
      args = buildCodexArgs({
        cwd: o.cwd,
        model,
        effort: this.state.effort,
        sandbox: sandboxFor(this.state.permissionMode),
        instructions: o.instructions,
        writableRoots: o.writableRoots,
        readOnlyPaths: o.readOnlyPaths,
        sshMcp: o.sshMcp,
        chromeMcp: o.chromeMcp,
        cleanMcp: o.cleanMcp,
        extraMcps: o.extraMcps,
        secrets: o.secrets,
        network: status.networkProxy ? 'loopback' : 'off',
        internetAccess,
        threadId: this.thread,
        platform: o.platform,
      });
    } catch (err) {
      this.closeRun(run, null, err instanceof CodexBlockedError ? err.message : `não foi possível preparar o codex: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Ficha grande demais para a linha de comando: vai no começo do prompt da primeira mensagem (as seguintes continuam a mesma thread).
    const prompt = o.instructions && !instructionsInArgv(o.instructions, o.platform) && this.thread === null ? promptWithInstructions(o.instructions, job.prompt) : job.prompt;
    // O mesmo ambiente do Claude (MYCO_SESSION_ID e MYCO_TOKEN para o despertador e as tarefas por curl), sem as variáveis CLAUDE*/ANTHROPIC*, e
    // MYCO_URL: o endereço do Claudio’s Club que a sandbox alcança. O token é o mesmo em todas as execuções da conversa (uma por mensagem).
    const env = {
      ...withoutMycoToken(cleanEnv()),
      MYCO_SESSION_ID: o.sessionId,
      ...(o.mycoToken && { MYCO_TOKEN: o.mycoToken }),
      ...(o.mycoUrl && { MYCO_URL: o.mycoUrl }),
    };
    // No Unix o processo vira líder do próprio grupo: encerrar o grupo leva também os comandos que ele abriu. No Windows o `codex` é um
    // `.cmd` do npm: `resolveCodexCommand` acha o JS dele, sem shell (ver codexEnv.ts). Só o spawn padrão passa por aí.
    const make =
      o.spawnImpl ??
      ((_cmd, a, so) => {
        const { command, prefix } = resolveCodexCommand();
        return spawn(command, [...prefix, ...a], { ...so, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      });
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
    child.stdin.end(prompt);
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
    this.endTurnBudget();
    if (run.buf.trim()) this.handle(tryJson(run.buf.trim()) as Record<string, unknown> | null);
    run.buf = '';
    if (this.current && this.run === run) this.current = null;
    const stopped = this.stopping;
    this.stopping = false;
    // Você parou a execução que ia refazer o turno: vale o parar.
    if (run.retry && stopped) {
      run.retry = false;
      run.ended = false;
    }
    if (!run.ended) {
      if (stopped) this.endTurn(run, { kind: 'stopped' });
      else {
        const failed = spawnError ?? (code && code !== 0 ? (run.lastError ?? (run.stderr.trim() || `o codex saiu com código ${code}`)) : run.lastError);
        this.failTurn(run, failed ?? 'O Codex terminou sem responder.');
      }
    }
    if (this.run === run) this.run = null;
    if (this.closing) this.finishSession(null);
    else if (run.retry) void this.retryWithSubstitute(run);
    else this.pump();
  }

  /**
   * O turno falhou. Se foi porque a conta não aceita o modelo (o caso do `gpt-6.1-sol` configurado mas recusado), o turno não termina:
   * o plano B o refaz uma vez com outro modelo (ver `retryWithSubstitute`). Qualquer outra falha, ou a segunda, vira o erro da conversa.
   */
  private failTurn(run: Run, text: string) {
    if (run.ended) return;
    if (run.job && !run.job.retried && run.model && isModelUnavailable(text)) {
      // Modelo que o dono escolheu para o secundário: não há plano B, o erro diz qual modelo a conta recusou.
      if (this.codex.noSubstitute) {
        this.endTurn(run, { kind: 'failed', text: `modelo secundário ${run.model} recusado pelo Codex` });
        return;
      }
      run.ended = true;
      run.retry = true;
      return;
    }
    this.endTurn(run, { kind: 'failed', text });
  }

  /**
   * Plano B: a mesma mensagem, uma vez, com o modelo mais parecido do catálogo (mesma família, versão mais nova) ou sem `-m` se não há
   * parecido. Vale só para esta mensagem: a ficha não muda e a próxima volta a pedir o modelo dela. Se foi o `resume` que falhou, a thread
   * é a mesma; se foi a primeira execução, a thread que ela abriu está vazia e é descartada (recomeça limpo).
   */
  private async retryWithSubstitute(run: Run) {
    const job = run.job!;
    const wanted = run.model!;
    this.holding = true;
    let substitute: string | null = null;
    try {
      substitute = pickCodexSubstitute(wanted, (await this.codex.models?.()) ?? []);
    } catch {
      // sem catálogo: roda no padrão do Codex
    }
    this.holding = false;
    if (this.closing || !this.state.running) return;
    if (run.fresh) {
      this.thread = null;
      if (this.codex.threadFile) void fs.rm(this.codex.threadFile, { force: true }).catch(() => {});
    }
    this.addNotice(`O modelo ${wanted} não está disponível na sua conta; usei ${substitute ?? 'o padrão do Codex'} nesta mensagem. Troque na ficha se quiser.`, 'warn');
    job.retried = true;
    this.launch(job, { model: substitute });
  }

  private endTurn(run: Run, outcome: { kind: 'ok' } | { kind: 'stopped' } | { kind: 'failed'; text: string }) {
    if (run.ended) return;
    run.ended = true;
    this.endTurnBudget();
    const at = new Date().toISOString();
    let limit: { resetsIn?: number } | null = null;
    if (outcome.kind === 'stopped') {
      if (!this.closing) this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Turno interrompido', tone: 'info', at });
    } else if (outcome.kind === 'failed') {
      // O limite de uso do ChatGPT aparece como erro da conversa e o gerente agenda o "continue", como no Claude (ver manager.limitHit).
      const failure = parseCodexFailure(outcome.text);
      if (failure.limit) limit = failure;
      this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: failure.text, tone: 'error', at });
    }
    // Uma vez por turno, como o ChatProcess: o limite (com a hora que o próprio erro deu, se deu), ou o fim sem limite.
    if (limit) this.codex.onUsageLimit?.({ resetsAt: limit.resetsIn === undefined ? null : Date.now() + limit.resetsIn * 1000, window: null });
    else this.codex.onTurnWithoutLimit?.();
    if (this.queue.length && !this.closing) return; // a próxima mensagem já espera: segue ocupado
    this.waitingReply = false;
    this.setState({ busy: false, compacting: false });
    this.idleCheck('turn');
  }

  private finishSession(error: string | null) {
    if (!this.state.running) return;
    this.endTurnBudget();
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
    // Teto do turno: confere o tempo a cada evento (o fim do turno não entra: quem acaba o turno é ele).
    if (ev.type !== 'turn.completed' && ev.type !== 'turn.failed') this.checkTurnCap();
    switch (ev.type) {
      case 'thread.started': {
        const id = typeof ev.thread_id === 'string' && THREAD_ID.test(ev.thread_id) ? ev.thread_id : null;
        if (id && id !== this.thread) {
          this.thread = id;
          if (this.codex.threadFile) void writeCodexThread(this.codex.threadFile, id).catch(() => {});
          this.codex.onThread?.(id);
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
        this.checkTurnCap();
        return;
      case 'turn.completed': {
        const used = contextUsed(ev.usage, run.tools.size);
        if (used) this.setState({ context: { used, window: CODEX_CONTEXT_WINDOW, percent: Math.round((used / CODEX_CONTEXT_WINDOW) * 100) } });
        this.endTurn(run, { kind: 'ok' });
        return;
      }
      case 'turn.failed': {
        const error = (ev.error ?? {}) as { message?: unknown };
        this.failTurn(run, typeof error.message === 'string' && error.message ? error.message : (run.lastError ?? ''));
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
    if (isToolCall(raw)) {
      run.tools.add(next.id);
      // Teto do turno: a ferramenta conta uma vez (o id já vem com a chave da execução, e o dedupe é pelo id).
      this.budget.countTool(next.id);
    }
    // Segredos: tudo que o funcionário escreve, roda e lê passa pelo filtro (só o tipo vai para o aviso; ver secrets.ts).
    if (next.kind === 'assistant') {
      this.scan(next.text, 'staff-reply');
      if (hasCheckpoint(next.text)) this.checkpointSeen = true;
      this.putItem({ ...next, text: stripCheckpoint(next.text), at: (prev?.kind === 'assistant' ? prev.at : null) ?? next.at });
    } else if (next.kind === 'tool') {
      this.scan(next.input, 'tool-input');
      if (next.result) this.scan(next.result, 'tool-result');
      this.putItem({ ...next, at: (prev?.kind === 'tool' ? prev.at : null) ?? next.at });
    } else {
      this.putItem(next);
    }
  }
}
