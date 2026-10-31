import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BackgroundTask, ChatAttachment, ChatCommand, ChatEvent, ChatItem, ChatState, SendPriority, UsageLimit } from '../../shared/model';
import { cleanEnv } from '../auth';
import { tryJson } from '../adapters/claude/fsutil';
import { contextWindowFor } from '../adapters/claude/pricing';
import { hasCheckpoint, inputText, resultText, stripCheckpoint, toolSummary } from './items';
import { killTree } from './registry';
import { findSecret } from './secrets';

// Um funcionário conversando pelo Claudio’s Club: o `claude` em modo stream-json (o mesmo protocolo do SDK),
// com o Claudio’s Club no papel de "host": manda as mensagens, recebe as respostas em tempo real e responde
// os pedidos de permissão. O formato não é documentado como API estável; tudo que é lido daqui
// passa por validação e o resto é ignorado. Testado com o Claude Code 2.1.278.

export const STREAM_FLAGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--include-partial-messages',
  '--permission-prompt-tool', 'stdio',
  // Sem isto o Claude Code recusa trocar para "sem travas" com o processo aberto
  // (`bypass_not_launched`) e ele segue pedindo permissão. Só libera a troca: o modo continua vindo
  // do --permission-mode, e quem troca é o Claudio’s Club (rotas de autonomia só pelo navegador).
  '--allow-dangerously-skip-permissions',
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

/** `background_tasks_changed` traz a lista inteira do que ainda roda em segundo plano. */
const BackgroundTasks = z.array(
  z
    .object({ task_id: z.string(), task_type: z.string().optional(), subagent_type: z.string().optional(), description: z.string().optional() })
    .passthrough(),
);

/** `commands_changed` traz cada comando "/" (e skill) com a descrição. */
const Commands = z.array(z.object({ name: z.string(), description: z.string().optional() }).passthrough());

/** Anexo → bloco de documento da API (texto como texto, PDF em base64). */
export function documentBlock(f: ChatAttachment) {
  return f.mediaType === 'application/pdf'
    ? { type: 'document', title: f.name, source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
    : { type: 'document', title: f.name, source: { type: 'text', media_type: 'text/plain', data: f.data } };
}

/** Onde guardar o "permitir sempre": só nesta conversa, ou no projeto (.claude/settings.local.json). */
export type Remember = 'session' | 'project';

type Suggestion = Record<string, unknown> & { type?: string; rules?: unknown[] };

/**
 * As regras do "permitir sempre". Na conversa, as sugestões do próprio Claude Code (que podem ser
 * trocar o modo, como "edita sozinho"). No projeto, só regras de ferramenta: trocar o modo do
 * projeto inteiro seria demais.
 */
export function rememberRules(tool: string, suggestions: Suggestion[], where: Remember): unknown[] {
  if (where === 'session' && suggestions.length) return suggestions.map((s) => ({ ...s, destination: 'session' }));
  const rules = suggestions.filter((s) => s.type === 'addRules').flatMap((s) => (Array.isArray(s.rules) ? s.rules : []));
  return [{ type: 'addRules', rules: rules.length ? rules : [{ toolName: tool }], behavior: 'allow', destination: where === 'session' ? 'session' : 'localSettings' }];
}

function backgroundTask(t: z.infer<typeof BackgroundTasks>[number]): BackgroundTask {
  const kind = t.task_type === 'local_agent' ? 'agent' : t.task_type === 'local_bash' ? 'shell' : (t.task_type ?? 'tarefa');
  const label = [t.subagent_type, t.description].filter(Boolean).join(': ') || t.task_id;
  return { id: t.task_id, kind, label };
}

export interface ChatProcessOptions {
  sessionId: string;
  /** De quem é a conversa (null: sessão sem ficha). */
  projectId?: string | null;
  staffId?: string | null;
  cwd: string;
  /** Argumentos depois de `claude` (os de stream-json são acrescentados aqui). */
  args: string[];
  onUsage?: (limits: UsageLimit[]) => void;
  /** O processo saiu (`error` com o motivo, se saiu com erro). */
  onExit?: (pid: number | null, error: string | null) => void;
  /** Algo com cara de segredo passou pela conversa (só o tipo; o valor nunca sai daqui). */
  onSecret?: (label: string) => void;
  /**
   * Parou de trabalhar: o turno acabou (`turn`), o que estava em segundo plano terminou
   * (`background`) ou o processo saiu (`exit`).
   */
  onIdle?: (reason: 'turn' | 'background' | 'exit') => void;
  /** Chegou a lista de comandos "/" da sessão. */
  onCommands?: (commands: ChatCommand[]) => void;
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
  /** Pedidos de permissão sem resposta: a entrada original e as sugestões de "permitir sempre". */
  private readonly pending = new Map<string, { input: unknown; tool: string; suggestions: Suggestion[] }>();
  private stderr = '';
  private buf = '';
  private state: ChatState = {
    running: false,
    busy: false,
    compacting: false,
    model: null,
    permissionMode: null,
    context: null,
    error: null,
    background: [],
    commands: [],
    effort: null,
  };
  private window: number | null = null;
  /** Pedidos de controle nossos esperando resposta (troca de modo, modelo, esforço): o que avisar no fim. */
  private readonly controls = new Map<string, { label: string; onOk?: (response: Record<string, unknown>) => void; mode?: boolean }>();
  /** Pedidos que esperam a resposta (ver `request`). */
  private readonly waiters = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
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

  /** Turno em andamento ou algo em segundo plano: fechar o processo agora interromperia trabalho. */
  get working(): boolean {
    return this.busy || this.state.background.length > 0;
  }

  get background(): BackgroundTask[] {
    return this.state.background;
  }

  get staffId(): string | null {
    return this.opts.staffId ?? null;
  }

  get commands(): ChatCommand[] {
    return this.state.commands;
  }

  private setCommands(commands: ChatCommand[]) {
    this.setState({ commands });
    this.opts.onCommands?.(commands);
  }

  private idleCheck(reason: 'turn' | 'background') {
    if (!this.working) this.opts.onIdle?.(reason);
  }

  get currentSeq(): number {
    return this.seq;
  }

  snapshot() {
    return { items: [...this.items.values()], state: { ...this.state }, seq: this.seq };
  }

  start() {
    // No Unix o processo vira líder do próprio grupo: encerrar o grupo leva também os comandos que ele abriu.
    const run =
      this.opts.spawnImpl ??
      ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }));
    // A lista de tarefas (TaskCreate/TaskUpdate) e os pontos de restauração das edições ("voltar até
    // aqui") não vêm ligados no modo -p.
    const env = { ...cleanEnv(), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };
    const child = run('claude', [...STREAM_FLAGS, ...this.opts.args], { cwd: this.opts.cwd, env });
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
  /** O último turno terminou com o ponto de corte (assunto encerrado, memória atualizada). */
  get checkpoint(): boolean {
    return this.checkpointSeen;
  }

  /** Contexto da última resposta (tokens), ou null antes da primeira. */
  get contextUsed(): number | null {
    return this.state.context?.used ?? null;
  }

  get model(): string | null {
    return this.state.model ?? null;
  }

  /** Aviso do Claudio’s Club no meio da conversa (só para você; o funcionário não vê). */
  addNotice(text: string, tone: 'info' | 'warn' = 'info') {
    this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text, tone, at: new Date().toISOString() });
  }

  send(text: string, priority: SendPriority = 'next', images: string[] = [], notice?: string, files: ChatAttachment[] = []) {
    this.checkpointSeen = false;
    const queued = this.state.busy ? priority : undefined;
    if (queued === 'now') this.stopping = true;
    this.scan(text);
    // Imagens e arquivos antes do texto (como o Claude Code faz ao colar um print): blocos da API.
    // Um aviso do Claudio’s Club (ficha atualizada) vai num bloco à parte; a conversa mostra só o seu texto.
    const content = [
      ...images.map(imageBlock).filter((b) => b !== null),
      ...files.map(documentBlock),
      ...(notice ? [{ type: 'text', text: notice }] : []),
      ...(text ? [{ type: 'text', text }] : []),
    ];
    // O id vira o da mensagem no transcript: é por ele que "voltar até aqui" acha o ponto.
    const uuid = randomUUID();
    this.write({ type: 'user', uuid, message: { role: 'user', content }, ...(queued && { priority: queued }) });
    this.putItem({
      kind: 'user',
      id: `u:${uuid}`,
      uuid,
      text,
      at: new Date().toISOString(),
      ...(queued && { queued }),
      ...(images.length && { images: images.length }),
      ...(files.length && { files: files.map((f) => f.name) }),
    });
    this.setState({ busy: true, error: null });
  }

  /** Troca o modo de permissão do processo aberto, sem reiniciar (a ficha mudou de autonomia). */
  setPermissionMode(mode: string, label: string) {
    this.control({ subtype: 'set_permission_mode', mode }, label, { mode: true });
  }

  /** Troca o modelo desta conversa, na hora (a ficha continua como está). */
  setModel(model: string, label: string) {
    // A resposta traz o id do modelo novo: a tela mostra já, sem esperar o próximo turno.
    this.control({ subtype: 'set_model', model }, label, {
      onOk: (res) => typeof res.model === 'string' && this.setState({ model: res.model }),
    });
  }

  /** Troca o esforço (quanto ele pensa) desta conversa, na hora. */
  setEffort(effort: string, label: string) {
    this.control({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } }, label, { onOk: () => this.setState({ effort }) });
  }

  /** Pede algo ao Claude Code e espera a resposta (erro vira exceção com a mensagem dele). */
  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    const done = new Promise<Record<string, unknown>>((resolve, reject) => this.waiters.set(requestId, { resolve, reject }));
    this.write({ type: 'control_request', request_id: requestId, request });
    return done;
  }

  /**
   * Desfaz as edições de arquivo feitas desde a mensagem `uuid` (os arquivos voltam ao que eram
   * antes dela). `dryRun` só conta o que voltaria. Comandos rodados não são desfeitos.
   */
  async rewind(uuid: string, dryRun: boolean): Promise<Record<string, unknown>> {
    const r = await this.request({ subtype: 'rewind_files', user_message_id: uuid, dry_run: dryRun });
    if (!dryRun && r.canRewind !== false) {
      this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Arquivos voltaram ao estado de antes daquela mensagem (a conversa continua).', tone: 'info', at: new Date().toISOString() });
    }
    return r;
  }

  /** Dá um nome à conversa (fica no transcript, como o /rename do Claude Code). */
  async rename(title: string): Promise<void> {
    await this.request({ subtype: 'rename_session', title, source: 'host', session_id: this.sessionId });
  }

  /** Servidores MCP da conversa: só nome e estado (a configuração vem com tokens e não sai daqui). */
  async mcpStatus(): Promise<Array<{ name: string; status: string }>> {
    const r = await this.request({ subtype: 'mcp_status' });
    const list = Array.isArray(r.mcpServers) ? (r.mcpServers as Array<Record<string, unknown>>) : [];
    return list.filter((s) => typeof s.name === 'string').map((s) => ({ name: s.name as string, status: typeof s.status === 'string' ? s.status : '?' }));
  }

  async mcpToggle(name: string, enabled: boolean): Promise<void> {
    await this.request({ subtype: 'mcp_toggle', serverName: name, enabled });
    this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: `MCP ${name} ${enabled ? 'ligado' : 'desligado'} nesta conversa`, tone: 'info', at: new Date().toISOString() });
  }

  /** Para um agent ou comando em segundo plano. */
  async stopTask(taskId: string): Promise<void> {
    await this.request({ subtype: 'stop_task', task_id: taskId });
  }

  /** `mode`: troca de autonomia (se não der, a conversa reabre com a ficha nova). */
  private control(request: Record<string, unknown>, label: string, opts: { onOk?: (response: Record<string, unknown>) => void; mode?: boolean } = {}) {
    const requestId = randomUUID();
    this.controls.set(requestId, { label, ...opts });
    this.write({ type: 'control_request', request_id: requestId, request });
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
   * Responde um pedido de permissão. Aprovar devolve a entrada original, sem mudanças; com
   * `remember`, ainda libera de vez (nesta conversa ou no projeto). Negar leva `message` (o que o
   * funcionário lê), por padrão "negou".
   */
  answer(requestId: string, allow: boolean, message = 'O usuário negou pelo Claudio’s Club.', remember?: Remember): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    const updatedPermissions = allow && remember ? rememberRules(p.tool, p.suggestions, remember) : undefined;
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: p.input, ...(updatedPermissions && { updatedPermissions }) } : { behavior: 'deny', message },
      },
    });
    const item = this.items.get(`p:${requestId}`);
    if (item?.kind === 'permission') this.putItem({ ...item, status: allow ? 'allowed' : 'denied', ...(updatedPermissions && { remembered: remember }) });
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
    // Se não sair sozinho, encerra a árvore (o claude e os comandos que ele abriu).
    const child = this.child;
    setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) void killTree(child.pid);
    }, 3_000).unref?.();
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
          // Sem a lista com descrições (commands_changed), ao menos os nomes.
          const names = Array.isArray(ev.slash_commands) ? ev.slash_commands.filter((c): c is string => typeof c === 'string') : [];
          if (!this.state.commands.length && names.length) this.setCommands(names.map((name) => ({ name, description: '' })));
        } else if (subtype === 'commands_changed') {
          const list = Commands.safeParse(ev.commands);
          if (list.success) this.setCommands(list.data.map((c) => ({ name: c.name, description: (c.description ?? '').slice(0, 200) })));
        } else if (subtype === 'status') this.setState({ compacting: ev.status === 'compacting', ...(mode && { permissionMode: mode }) });
        else if (subtype === 'compact_boundary') {
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Conversa compactada', tone: 'info', at });
          this.setState({ compacting: false });
        } else if (subtype === 'permission_denied') {
          const tool = typeof ev.tool_name === 'string' ? ev.tool_name : 'ferramenta';
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: `${tool}: permissão negada`, tone: 'warn', at });
        } else if (subtype === 'background_tasks_changed') {
          const tasks = BackgroundTasks.safeParse(ev.tasks);
          if (tasks.success) {
            this.setState({ background: tasks.data.map(backgroundTask) });
            if (!tasks.data.length) this.idleCheck('background');
          }
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
            // O ponto de corte (última linha) é para o Claudio’s Club: fica guardado aqui e some do texto.
            if (hasCheckpoint(b.text)) this.checkpointSeen = true;
            this.putItem({ kind: 'assistant', id, text: stripCheckpoint(done.join('\n\n')), at: (prev?.kind === 'assistant' ? prev.at : null) ?? at });
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
        const res = ev.response as { subtype?: string; request_id?: string; error?: string; response?: Record<string, unknown> } | undefined;
        const waiter = res?.request_id ? this.waiters.get(res.request_id) : undefined;
        if (res?.request_id && waiter) {
          this.waiters.delete(res.request_id);
          if (res.subtype === 'success') waiter.resolve(res.response ?? {});
          else waiter.reject(new Error(res.error ?? 'o Claude Code recusou o pedido'));
          return;
        }
        const entry = res?.request_id ? this.controls.get(res.request_id) : undefined;
        if (!res?.request_id || !entry) return;
        this.controls.delete(res.request_id);
        const { label, mode } = entry;
        if (res.subtype === 'success') entry.onOk?.(res.response ?? {});
        // Sem rótulo: deu certo em silêncio (outra troca do mesmo pedido já avisa); erro sempre aparece.
        if (res.subtype === 'success' && !label) return;
        this.putItem(
          res.subtype === 'success'
            ? { kind: 'notice', id: `n:${randomUUID()}`, text: label, tone: 'info', at }
            : {
                kind: 'notice',
                id: `n:${randomUUID()}`,
                // "Sem travas" só entra com o processo aberto já nesse modo: reabre na próxima mensagem.
                text: /bypass/i.test(res.error ?? '')
                  ? `${label}: a conversa reabre nesse modo na próxima mensagem.`
                  : mode
                    ? `Não deu para trocar a autonomia agora (${res.error ?? 'erro'}); vale quando a conversa reabrir.`
                    : `Não deu para aplicar agora (${res.error ?? 'erro'}).`,
                tone: /bypass/i.test(res.error ?? '') ? 'info' : 'warn',
                at,
              },
        );
        if (res.subtype !== 'success' && mode) this.stale = true;
        return;
      }
      case 'control_request': {
        const req = ev.request as
          | { subtype?: string; tool_name?: string; display_name?: string; input?: unknown; description?: string; permission_suggestions?: unknown }
          | undefined;
        const requestId = typeof ev.request_id === 'string' ? ev.request_id : null;
        if (req?.subtype !== 'can_use_tool' || !requestId) return;
        const tool = req.display_name ?? req.tool_name ?? 'ferramenta';
        const suggestions = (Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []).filter(
          (s): s is Suggestion => !!s && typeof s === 'object',
        );
        this.pending.set(requestId, { input: req.input, tool: req.tool_name ?? tool, suggestions });
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
        this.idleCheck('turn');
        return;
      }
    }
  }

  private readonly doneText = new Map<string, string[]>();
  private checkpointSeen = false;

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
    for (const w of this.waiters.values()) w.reject(new Error('a conversa fechou'));
    this.waiters.clear();
    this.setState({ running: false, busy: false, compacting: false, error, background: [] });
    for (const done of this.exitWaiters.splice(0)) done();
    this.opts.onIdle?.('exit');
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
