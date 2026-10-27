import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChatEvent, ChatItem, ChatState, SendPriority, UsageLimit } from '../../shared/model';
import { cleanEnv } from '../auth';
import { tryJson } from '../adapters/claude/fsutil';
import { contextWindowFor } from '../adapters/claude/pricing';
import { inputText, resultText, toolSummary } from './items';
import { findSecret } from './secrets';

// Um funcionário conversando pelo MyCo: o `claude` em modo stream-json (o mesmo protocolo do SDK),
// com o MyCo no papel de "host": manda as mensagens, recebe as respostas em tempo real e responde
// os pedidos de permissão. O formato não é documentado como API estável; tudo que é lido daqui
// passa por validação e o resto é ignorado. Testado com o Claude Code 2.1.278.

export const STREAM_FLAGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
];

const MAX_LOG = 5_000;

/** `data:image/png;base64,...` → bloco de imagem da mensagem; null se não for uma data URL de imagem. */
export function imageBlock(dataUrl: string) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } } : null;
}

const UnifiedWindows = z.record(
  z.object({ utilization: z.number(), resetsAt: z.number().optional(), status: z.string().optional() }).passthrough(),
);

export interface ChatProcessOptions {
  sessionId: string;
  cwd: string;
  /** Argumentos depois de `claude` (os de stream-json são acrescentados aqui). */
  args: string[];
  onUsage?: (limits: UsageLimit[]) => void;
  /** O processo saiu (`error` com o motivo, se saiu com erro). */
  onExit?: (pid: number | null, error: string | null) => void;
  /** Algo com cara de segredo passou pela conversa (só o tipo; o valor nunca sai daqui). */
  onSecret?: (label: string) => void;
  /** Troca o `spawn` real nos testes. */
  spawnImpl?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
}

type Listener = (e: ChatEvent) => void;

export class ChatProcess {
  readonly sessionId: string;
  readonly startedAt = new Date().toISOString();
  lastActivity = Date.now();
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private readonly log: ChatEvent[] = [];
  private readonly items = new Map<string, ChatItem>();
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Map<string, unknown>();
  private stderr = '';
  private buf = '';
  private state: ChatState = { running: false, busy: false, compacting: false, model: null, permissionMode: null, context: null, error: null };
  private window: number | null = null;
  /** Pedidos de controle nossos esperando resposta (troca de modo): id → o que avisar no fim. */
  private readonly controls = new Map<string, string>();
  /** O próximo resultado com erro é de um turno que nós paramos (botão Parar ou mensagem `now`). */
  private stopping = false;
  /** A ficha mudou depois que o processo abriu: reabre quando estiver parado. */
  stale = false;
  private exitWaiters: Array<() => void> = [];

  constructor(private readonly opts: ChatProcessOptions) {
    this.sessionId = opts.sessionId;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get running(): boolean {
    return this.state.running;
  }

  get permissionMode(): string | null {
    return this.state.permissionMode;
  }

  get busy(): boolean {
    return this.state.busy || this.pending.size > 0;
  }

  get currentSeq(): number {
    return this.seq;
  }

  snapshot() {
    return { items: [...this.items.values()], state: { ...this.state }, seq: this.seq };
  }

  start() {
    const run = this.opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    const child = run('claude', [...STREAM_FLAGS, ...this.opts.args], { cwd: this.opts.cwd, env: cleanEnv() });
    this.child = child;
    this.setState({ running: true, error: null });
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    child.on('error', (err) => this.finish(`não foi possível iniciar o claude: ${err.message}`));
    child.on('exit', (code) => this.finish(code && code !== 0 ? this.stderr.trim() || `o claude saiu com código ${code}` : null));
  }

  subscribe(listener: Listener, after = 0): () => void {
    for (const e of this.log) if (e.seq > after) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Com o turno em andamento, a mensagem vai com prioridade (ver SendPriority); parado, é um turno
   * novo e a prioridade não importa.
   */
  send(text: string, priority: SendPriority = 'next', images: string[] = []) {
    const queued = this.state.busy ? priority : undefined;
    if (queued === 'now') this.stopping = true;
    this.scan(text);
    // Imagens antes do texto (como o Claude Code faz ao colar um print): blocos base64 da API.
    const content = [...images.map(imageBlock).filter((b) => b !== null), ...(text ? [{ type: 'text', text }] : [])];
    this.write({ type: 'user', message: { role: 'user', content }, ...(queued && { priority: queued }) });
    this.putItem({
      kind: 'user',
      id: `u:${randomUUID()}`,
      text,
      at: new Date().toISOString(),
      ...(queued && { queued }),
      ...(images.length && { images: images.length }),
    });
    this.setState({ busy: true, error: null });
  }

  /** Troca o modo de permissão do processo aberto, sem reiniciar (a ficha mudou de autonomia). */
  setPermissionMode(mode: string, label: string) {
    const requestId = randomUUID();
    this.controls.set(requestId, label);
    this.write({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } });
  }

  /** Espera o processo sair (para reabrir com a ficha nova). */
  async stopAndWait(): Promise<void> {
    if (!this.state.running) return;
    const done = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.stop();
    await done;
  }

  compact() {
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } });
    this.setState({ busy: true, compacting: true });
  }

  interrupt() {
    if (this.state.busy) this.stopping = true;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  /**
   * Responde um pedido de permissão. Aprovar devolve a entrada original, sem mudanças; negar
   * leva `message` (o que o funcionário lê), por padrão "negou".
   */
  answer(requestId: string, allow: boolean, message = 'O usuário negou pelo MyCo.'): boolean {
    if (!this.pending.has(requestId)) return false;
    const input = this.pending.get(requestId);
    this.pending.delete(requestId);
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message },
      },
    });
    const item = this.items.get(`p:${requestId}`);
    if (item?.kind === 'permission') this.putItem({ ...item, status: allow ? 'allowed' : 'denied' });
    return true;
  }

  /** Pedidos de permissão ainda sem resposta (a caixa "precisa de mim" lê daqui). */
  /** Guarda de segredos: avisa o tipo do que apareceu (ver secrets.ts). */
  private scan(text: string) {
    if (!this.opts.onSecret) return;
    const hit = findSecret(text);
    if (hit) this.opts.onSecret(hit.label);
  }

  lastAssistantText(): string | null {
    const items = [...this.items.values()];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'assistant' && it.text.trim()) return it.text;
    }
    return null;
  }

  pendingPermissions(): Array<Extract<ChatItem, { kind: 'permission' }>> {
    return [...this.items.values()].filter(
      (i): i is Extract<ChatItem, { kind: 'permission' }> => i.kind === 'permission' && i.status === 'pending',
    );
  }

  get error(): string | null {
    return this.state.error;
  }

  stop() {
    this.child?.stdin.end();
    // Se não sair sozinho, encerra.
    setTimeout(() => this.child?.kill(), 3_000).unref?.();
  }

  // ---- leitura do stream ----

  private onData(text: string) {
    this.lastActivity = Date.now();
    this.buf += text;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.handle(tryJson(line) as Record<string, unknown> | null);
    }
  }

  /** Exposto para os testes alimentarem eventos sem processo. */
  handle(ev: Record<string, unknown> | null) {
    if (!ev || typeof ev.type !== 'string') return;
    // Eventos de subagents (parent_tool_use_id preenchido) ficam fora da conversa principal.
    if (ev.parent_tool_use_id) return;
    const at = new Date().toISOString();

    switch (ev.type) {
      case 'system': {
        const subtype = ev.subtype;
        const mode = typeof ev.permissionMode === 'string' ? ev.permissionMode : null;
        // Cada turno começa com um init, inclusive o da mensagem que esperou na fila (`later`).
        if (subtype === 'init') {
          this.setState({ busy: true, ...(typeof ev.model === 'string' && { model: ev.model }), ...(mode && { permissionMode: mode }) });
        } else if (subtype === 'status') this.setState({ compacting: ev.status === 'compacting', ...(mode && { permissionMode: mode }) });
        else if (subtype === 'compact_boundary') {
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Conversa compactada', tone: 'info', at });
          this.setState({ compacting: false });
        } else if (subtype === 'permission_denied') {
          const tool = typeof ev.tool_name === 'string' ? ev.tool_name : 'ferramenta';
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: `${tool}: permissão negada`, tone: 'warn', at });
        }
        return;
      }
      case 'stream_event': {
        const event = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        const msgId = typeof ev.api_message_id === 'string' ? ev.api_message_id : null;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text && msgId) {
          const id = `a:${msgId}`;
          if (!this.items.has(id)) this.putItem({ kind: 'assistant', id, text: '', at });
          const item = this.items.get(id)!;
          if (item.kind === 'assistant') item.text += event.delta.text;
          this.emit({ type: 'delta', seq: ++this.seq, id, text: event.delta.text });
        }
        return;
      }
      case 'assistant': {
        const msg = ev.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, number> } | undefined;
        if (!msg) return;
        const msgId = msg.id ?? randomUUID();
        for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string') {
            const id = `a:${msgId}`;
            const prev = this.items.get(id);
            // As deltas já montaram o texto; o bloco final substitui (e junta blocos de uma mesma resposta).
            const done = this.doneText.get(id) ?? [];
            done.push(b.text);
            this.doneText.set(id, done);
            this.putItem({ kind: 'assistant', id, text: done.join('\n\n'), at: (prev?.kind === 'assistant' ? prev.at : null) ?? at });
          } else if (b.type === 'tool_use' && typeof b.id === 'string') {
            const name = typeof b.name === 'string' ? b.name : 'ferramenta';
            const input = inputText(b.input);
            this.scan(input);
            this.putItem({ kind: 'tool', id: `t:${b.id}`, name, summary: toolSummary(name, b.input), input, result: null, isError: false, at });
          }
        }
        const u = msg.usage;
        if (u) {
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          const window = this.window ?? contextWindowFor(msg.model ?? this.state.model);
          if (used > 0) this.setState({ context: { used, window, percent: Math.round((used / window) * 100) } });
        }
        return;
      }
      case 'user': {
        const msg = ev.message as { content?: unknown } | undefined;
        for (const b of (Array.isArray(msg?.content) ? msg!.content : []) as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const tool = this.items.get(`t:${b.tool_use_id}`);
          const result = resultText(b.content);
          this.scan(result);
          if (tool?.kind === 'tool') this.putItem({ ...tool, result, isError: b.is_error === true });
        }
        return;
      }
      case 'control_response': {
        const res = ev.response as { subtype?: string; request_id?: string; error?: string } | undefined;
        const label = res?.request_id ? this.controls.get(res.request_id) : undefined;
        if (!res?.request_id || label === undefined) return;
        this.controls.delete(res.request_id);
        this.putItem(
          res.subtype === 'success'
            ? { kind: 'notice', id: `n:${randomUUID()}`, text: label, tone: 'info', at }
            : {
                kind: 'notice',
                id: `n:${randomUUID()}`,
                // "Sem travas" só entra com o processo aberto já nesse modo: reabre na próxima mensagem.
                text: /bypass/i.test(res.error ?? '')
                  ? `${label}: a conversa reabre nesse modo na próxima mensagem.`
                  : `Não deu para trocar a autonomia agora (${res.error ?? 'erro'}); vale quando a conversa reabrir.`,
                tone: /bypass/i.test(res.error ?? '') ? 'info' : 'warn',
                at,
              },
        );
        if (res.subtype !== 'success') this.stale = true;
        return;
      }
      case 'control_request': {
        const req = ev.request as { subtype?: string; tool_name?: string; display_name?: string; input?: unknown; description?: string } | undefined;
        const requestId = typeof ev.request_id === 'string' ? ev.request_id : null;
        if (req?.subtype !== 'can_use_tool' || !requestId) return;
        const tool = req.display_name ?? req.tool_name ?? 'ferramenta';
        this.pending.set(requestId, req.input);
        // Fim do modo plano: o plano vem inteiro em `input.plan` e vira um cartão para aprovar.
        const plan = req.tool_name === 'ExitPlanMode' ? (req.input as { plan?: unknown } | undefined)?.plan : undefined;
        this.putItem({
          kind: 'permission',
          id: `p:${requestId}`,
          tool,
          summary: plan !== undefined ? 'plano pronto para aprovar' : toolSummary(req.tool_name ?? tool, req.input),
          description: typeof req.description === 'string' ? req.description : null,
          input: inputText(req.input),
          status: 'pending',
          at,
          ...(typeof plan === 'string' && { plan }),
        });
        return;
      }
      case 'rate_limit_event': {
        const info = ev.rate_limit_info as { unifiedWindows?: unknown } | undefined;
        const parsed = UnifiedWindows.safeParse(info?.unifiedWindows);
        if (parsed.success && this.opts.onUsage) {
          this.opts.onUsage(
            Object.entries(parsed.data).map(([kind, w]) => ({
              kind,
              // utilization vem de 0 a 1.
              percentUsed: Math.round(w.utilization * 1000) / 10,
              resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
            })),
          );
        }
        return;
      }
      case 'result': {
        const usage = ev.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        const windows = Object.values(usage ?? {}).map((m) => m.contextWindow).filter((w): w is number => !!w);
        if (windows.length) {
          this.window = Math.max(...windows);
          const c = this.state.context;
          if (c) this.setState({ context: { ...c, window: this.window, percent: Math.round((c.used / this.window) * 100) } });
        }
        this.doneText.clear();
        const stopped = this.stopping && ev.subtype === 'error_during_execution';
        this.stopping = false;
        if (stopped) {
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Turno interrompido', tone: 'info', at });
        } else if (ev.is_error === true) {
          const text = typeof ev.result === 'string' && ev.result ? ev.result : 'O turno terminou com erro.';
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text, tone: 'error', at });
        }
        this.setState({ busy: false, compacting: false });
        return;
      }
    }
  }

  private readonly doneText = new Map<string, string[]>();

  private finish(error: string | null) {
    if (!this.state.running) return;
    const pid = this.child?.pid ?? null;
    this.child = null;
    this.opts.onExit?.(pid, error);
    for (const id of this.pending.keys()) {
      const item = this.items.get(`p:${id}`);
      if (item?.kind === 'permission') this.putItem({ ...item, status: 'denied' });
    }
    this.pending.clear();
    this.controls.clear();
    this.setState({ running: false, busy: false, compacting: false, error });
    for (const done of this.exitWaiters.splice(0)) done();
  }

  private write(obj: unknown) {
    this.lastActivity = Date.now();
    if (!this.child) throw new Error('a conversa não está aberta');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  private putItem(item: ChatItem) {
    this.items.set(item.id, item);
    this.emit({ type: 'item', seq: ++this.seq, item: { ...item } });
  }

  private setState(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', seq: ++this.seq, state: { ...this.state } });
  }

  private emit(e: ChatEvent) {
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    for (const l of this.listeners) l(e);
  }
}
