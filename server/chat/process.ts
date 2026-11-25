import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AskedQuestion, BackgroundTask, ChatAttachment, ChatCommand, ChatEvent, ChatItem, ChatState, SendPriority, TaskQuestion, TurnCapHit, TurnRetryNotice, UsageLimit } from '../../shared/model';
import { cleanEnv, withoutMycoToken } from '../auth';
import { tryJson } from '../adapters/claude/fsutil';
import { contextWindowFor } from '../adapters/claude/pricing';
import { cacheTtlOf } from './contextPolicy';
import { claudeEditedFile, claudeToolCommand, claudeToolFile } from './codeEdits';
import { classifyDenial, denialNotice } from './denial';
import { claudeDenied, type DeniedInfo } from './denied';
import { hasCheckpoint, inputText, resultText, stripCheckpoint, toolSummary } from './items';
import { ASK_TOOL, cleanAnswers, parseQuestions } from './questions';
import { killTree } from './registry';
import { scanSecrets, type ClassifiedSecret, type SecretSource } from './secrets';
import { capText, TurnBudget, type TurnCaps } from './turnCap';
import type { TurnContext, TurnEnd } from './turnRetry';
import { isClaudeModelNotFound } from './modelNotFound';
import { limitFromRateLimitEvent, limitFromText, mergeHits, type LimitHit } from './usageLimit';

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

/**
 * Quantos itens a conversa aberta guarda na memória (os mais recentes). O resto já está no transcript e volta de lá no
 * snapshot (ver `cut`). A tela não corta o que chega (só pinta o fim da lista, ver client/src/chat/chatWindow.ts): se cortasse,
 * o histórico ficaria para trás e sobraria um buraco no meio.
 */
export const MAX_LIVE_ITEMS = 400;

/** Até onde a memória deste processo já não cobre a conversa: o que for mais antigo vem do transcript (ver `cut`). */
export interface ChatCut {
  /** Instante (ISO) do primeiro item que ficou na memória depois do último que saiu: o histórico do transcript vai até aqui. */
  before: string;
  /** Instante do item mais antigo que ficou de fora (o histórico alcançou tudo se ele chega a antes disto). */
  oldest: string;
}

const laterOf = (a: string | null, b: string | null) => (a && b ? (a > b ? a : b) : (a ?? b));

/** `data:image/png;base64,...` → bloco de imagem da mensagem; null se não for uma data URL de imagem. */
export function imageBlock(dataUrl: string) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } } : null;
}

const UnifiedWindows = z.record(
  z.string(),
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
 * As regras do "permitir sempre". Na conversa, as sugestões do próprio Claude Code que liberam ou mudam o modo (como
 * "edita sozinho"). No projeto, só regras de ferramenta: trocar o modo do projeto inteiro seria demais.
 * Só regras de `allow`: uma sugestão que remove, substitui ou põe ask/deny derrubaria o acesso aos MCPs da ficha (ver mcpAccess.ts).
 */
export function rememberRules(tool: string, suggestions: Suggestion[], where: Remember): unknown[] {
  const allowRules = (s: Suggestion) => s.type === 'addRules' && s.behavior === 'allow';
  const safe = suggestions.filter((s) => s.type === 'setMode' || s.type === 'addDirectories' || allowRules(s));
  if (where === 'session' && safe.length) return safe.map((s) => ({ ...s, destination: 'session' }));
  const rules = suggestions.filter(allowRules).flatMap((s) => (Array.isArray(s.rules) ? s.rules : []));
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
  /** Modelo e esforço com que a linha de comando abre: o estado já os mostra antes do primeiro turno (o `init` ainda pode atualizar o modelo). */
  model?: string | null;
  effort?: string | null;
  onUsage?: (limits: UsageLimit[]) => void;
  /** O turno acabou porque o limite de uso da assinatura estourou (uma vez por turno; ver usageLimit.ts). */
  onUsageLimit?: (hit: LimitHit) => void;
  /** O motor recusou o modelo pedido (não existe mais na conta): a conversa segue no padrão (ver `retryOnDefault`). */
  onModelUnavailable?: (model: string) => void;
  /** O turno acabou sem estourar o limite (resposta normal, outro erro, ou interrompido por você): zera a conta de estouros seguidos. */
  onTurnWithoutLimit?: () => void;
  /**
   * Como o turno acabou, antes do aviso de ocioso (`onIdle`): terminou bem, falhou com o erro do motor, ou o processo saiu no meio dele (ver
   * `TurnEnd`). Turno que você parou (Parar, interrupção, fechamento) e o que estourou o limite de uso não passam por aqui. É por este gancho que o
   * manager decide retomar sozinho, e ele precisa registrar a espera de forma síncrona antes de a conversa ser dada como parada.
   */
  onTurnEnd?: (end: TurnEnd) => void;
  /** O processo saiu (`error` com o motivo, se saiu com erro). */
  onExit?: (pid: number | null, error: string | null) => void;
  /**
   * Algo com cara de segredo passou pela conversa (o tipo, o palpite de ser real e a dica mascarada; o valor nunca sai daqui). Chamado uma vez por
   * rótulo achado no texto, do mais grave ao menos grave. `file`: o arquivo da ferramenta onde ele apareceu, como o motor o deu (absoluto ou
   * relativo à pasta da conversa); sem ele, o aviso não aponta arquivo (ver `claudeToolFile` e `codexToolFile`). `command`: o segredo veio da SAÍDA de um comando
   * de shell que não aponta um arquivo só (vários arquivos, `;`, pipe): o manager descobre depois qual arquivo do projeto o tem (ver `locateSecretFile`).
   */
  onSecret?: (hit: ClassifiedSecret, source?: SecretSource, file?: string, command?: string) => void;
  /** Sal da instalação para a identidade da ocorrência do segredo (ver `ClassifiedSecret.occurrence`); sem ele, o hash não tem sal. */
  secretPepper?: string;
  /**
   * Arquivo(s) alterado(s) com sucesso pelas ferramentas de edição (Claude: Edit, MultiEdit, Write, NotebookEdit, também as dos subagents;
   * Codex: `file_change` concluído). Os caminhos vêm como o motor os deu. Edição que falhou (ou foi negada) não chega aqui; edição por
   * shell também não (ver chat/codeEdits.ts). O manager repassa para o quadro (card automático).
   */
  onEdit?: (files: string[]) => void;
  /**
   * Uma ferramenta foi barrada por uma regra de permissão (Claude: o aviso de negação do chat, também o dos subagents; Codex: item recusado pela sandbox, ver
   * denied.ts). `turn` identifica o turno (o manager agrupa por ele). Registro, não trava: erro de quem recebe nunca derruba a leitura do stream.
   */
  onDenied?: (denied: DeniedInfo, turn: string) => void;
  /**
   * Parou de trabalhar: o turno acabou (`turn`), o que estava em segundo plano terminou
   * (`background`) ou o processo saiu (`exit`).
   */
  onIdle?: (reason: 'turn' | 'background' | 'exit') => void;
  /** Chegou a lista de comandos "/" da sessão. */
  onCommands?: (commands: ChatCommand[]) => void;
  /** Quantos itens guardar na memória (os mais recentes); padrão `MAX_LIVE_ITEMS`. Os testes baixam. */
  maxItems?: number;
  /** Teto por turno (ver turnCap.ts), lido a cada turno que começa; sem ele, sem teto. */
  turnCaps?: () => Promise<TurnCaps>;
  /** O turno passou do teto: chamado antes de interromper, para o manager guardar o motivo (a tarefa lê depois). */
  onTurnCap?: (hit: TurnCapHit) => void;
  /** Relógio do teto (os testes trocam). */
  clock?: () => number;
  /** Pergunta só de escolhas (AskUserQuestion) esperando resposta: no formato da dúvida da tarefa (ver TaskQuestion). Texto e número não vão. */
  onAsk?: (requestId: string, questions: NonNullable<TaskQuestion['questions']>) => void;
  /** `MYCO_TOKEN` da conversa (ver server/callers.ts): vai no ambiente, ao lado do `MYCO_SESSION_ID`, para as chamadas à API do Claudio’s Club. */
  mycoToken?: string;
  /**
   * Conversa de consulta de outro projeto (server/consult/): TODO pedido de permissão (`can_use_tool`) é negado na hora, com esta mensagem, sem virar cartão de aprovação nem aviso para o dono
   * (um clique distraído liberaria a leitura fora do projeto). Também não aceita troca do modo de permissão. Ausente = conversa comum.
   */
  denyPermissions?: string;
  /** Troca o `spawn` real nos testes. */
  spawnImpl?: (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  /** Quanto o `stop()` espera o claude sair sozinho antes de encerrar a árvore dele (padrão 3 s; os testes encurtam). */
  stopGraceMs?: number;
}

type Listener = (e: ChatEvent) => void;

export class ChatProcess {
  readonly sessionId: string;
  readonly startedAt = new Date().toISOString();
  lastActivity = Date.now();
  private child: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private readonly log: ChatEvent[] = [];
  /** Só os `maxItems` mais recentes (e o que não pode sair: ver `pinned`); o resto está no transcript. */
  protected readonly items = new Map<string, ChatItem>();
  /** `at` do primeiro item mantido depois do último que saiu de `items`; null = nada saiu. */
  private evictBefore: string | null = null;
  /** `at` do primeiro item que saiu de `items`. */
  private evictedFrom: string | null = null;
  /** Resposta que está chegando em deltas agora (não pode sair de `items` no meio). */
  private streamingId: string | null = null;
  private readonly listeners = new Set<Listener>();
  /** Pedidos de permissão sem resposta: a entrada original e as sugestões de "permitir sempre". */
  private readonly pending = new Map<string, { input: unknown; tool: string; suggestions: Suggestion[]; questions?: AskedQuestion[] }>();
  protected stderr = '';
  /** `stop()` já foi chamado: a saída que vem depois é nossa, não falha (no Windows o `taskkill /F` sai com código 1). */
  private closedByUs = false;
  /** Último erro que o próprio claude escreveu no stream (mensagem de erro do assistente ou `result` com `is_error`): vale quando ele sai com código e sem stderr. */
  private streamError: string | null = null;
  /** O tipo e o status HTTP que o claude pôs na mensagem de erro sintética do assistente (`error`, `apiErrorStatus`): a classificação do erro do turno os lê. */
  private apiError: { kind: string | null; status: number | null } | null = null;
  private buf = '';
  protected state: ChatState = {
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
  protected window: number | null = null;
  /** Pedidos de controle nossos esperando resposta (troca de modo, modelo, esforço): o que avisar no fim. */
  private readonly controls = new Map<string, { label: string; onOk?: (response: Record<string, unknown>) => void; mode?: boolean }>();
  /** Pedidos que esperam a resposta (ver `request`). */
  private readonly waiters = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  /** O próximo resultado com erro é de um turno que nós paramos (botão Parar ou mensagem `now`). */
  protected stopping = false;
  /** Mandamos algo (mensagem ou /compact) e o turno disso ainda não terminou (ver o `result` de aviso). */
  protected waitingReply = false;
  /** A ficha mudou depois que o processo abriu: reabre quando estiver parado. */
  stale = false;
  protected exitWaiters: Array<() => void> = [];
  /** Conta do turno em andamento contra o teto (ferramentas e minutos; ver turnCap.ts). */
  protected readonly budget = new TurnBudget();
  private capTimer: NodeJS.Timeout | null = null;

  constructor(protected readonly opts: ChatProcessOptions) {
    this.sessionId = opts.sessionId;
    this.state = { ...this.state, model: opts.model ?? null, effort: opts.effort ?? null };
    this.wantedModel = opts.model ?? null;
  }

  /** Modelo que a conversa pediu (o que se escreveu em `setModel`, ou o da linha de comando): o que a recusa do motor fala. */
  private wantedModel: string | null = null;
  /** Mensagens do usuário já escritas e ainda sem resposta (uma resposta por mensagem, na ordem): a que levou a recusa é a primeira. */
  private readonly unanswered: Array<{ content: unknown[] }> = [];
  /** O turno já trocou para o padrão por causa de modelo inexistente: uma vez só (ver `retryOnDefault`). */
  private modelRetried = false;

  /** Quem roda esta conversa: o `claude` (aqui) ou o Codex (ver codexProcess.ts). */
  get engine(): 'claude' | 'codex' {
    return 'claude';
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** Pasta onde a conversa roda (a da ficha, ou o worktree do funcionário). */
  get cwd(): string {
    return this.opts.cwd;
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

  /** Algum pedido (permissão ou pergunta) sem resposta agora (o reinício avisa para refazê-lo, ver resume.ts). */
  get awaitingAnswer(): boolean {
    return this.pending.size > 0;
  }

  /** Turno em andamento ou algo em segundo plano: fechar o processo agora interromperia trabalho. */
  get working(): boolean {
    return this.busy || this.state.background.length > 0;
  }

  get background(): BackgroundTask[] {
    return this.state.background;
  }

  get projectId(): string | null {
    return this.opts.projectId ?? null;
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

  protected idleCheck(reason: 'turn' | 'background') {
    if (!this.working) this.opts.onIdle?.(reason);
  }

  get currentSeq(): number {
    return this.seq;
  }

  /**
   * A foto da conversa num instante: itens (cópias, que as deltas seguintes não alteram), estado e `seq`. O stream que a tela abre
   * depois (`after` = esse `seq`) continua exatamente dali. Quem também precisa de `cut` lê os dois no mesmo passo síncrono
   * (ver ChatManager.snapshot): um `await` entre eles deixaria sair itens que não estariam em nenhum dos dois lados.
   */
  snapshot() {
    return { items: [...this.items.values()].map((i) => ({ ...i })), state: { ...this.state }, seq: this.seq };
  }

  /**
   * Quando a conversa passou do limite de itens, de onde o histórico do transcript precisa começar a valer para a tela ver
   * tudo: o snapshot traz só os itens que ficaram, então o que veio antes de `before` volta do transcript (ver
   * ChatManager.snapshot). null = nada saiu: o histórico vai até a abertura do processo.
   */
  get cut(): ChatCut | null {
    return this.evictBefore ? { before: this.evictBefore, oldest: this.evictedFrom ?? this.evictBefore } : null;
  }

  start() {
    // No Unix o processo vira líder do próprio grupo: encerrar o grupo leva também os comandos que ele abriu.
    const run =
      this.opts.spawnImpl ??
      ((cmd, args, o) => spawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }));
    // A lista de tarefas (TaskCreate/TaskUpdate) e os pontos de restauração das edições ("voltar até
    // aqui") não vêm ligados no modo -p.
    // MYCO_SESSION_ID: o funcionário sabe o id da própria conversa (o despertador, ver wake.ts, o usa nos comandos dele). MYCO_TOKEN: quem ele é
    // para a API (cabeçalho x-myco-token nos curl da ficha, ver server/callers.ts).
    const env = {
      ...withoutMycoToken(cleanEnv()),
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1',
      MYCO_SESSION_ID: this.opts.sessionId,
      ...(this.opts.mycoToken && { MYCO_TOKEN: this.opts.mycoToken }),
    };
    const child = run('claude', [...STREAM_FLAGS, ...this.opts.args], { cwd: this.opts.cwd, env });
    this.child = child;
    this.closedByUs = false;
    this.streamError = null;
    this.apiError = null;
    this.setState({ running: true, error: null });
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2_000);
    });
    child.on('error', (err) => this.finish(`não foi possível iniciar o claude: ${err.message}`));
    child.on('exit', (code, signal) => this.finish(this.exitError(code), { code, signal }));
    // EPIPE/"write after end" no stdin de um processo que está saindo: sem ouvinte, o evento 'error' derrubaria o servidor inteiro. A saída do processo já é tratada acima.
    child.stdin?.on('error', () => undefined);
  }

  /** O erro da conversa quando o processo sai: nenhum se saiu limpo ou se fomos nós que fechamos; senão o stderr, o último erro do stream, ou o código. */
  private exitError(code: number | null): string | null {
    if (this.closedByUs || !code) return null;
    return this.stderr.trim() || this.streamError || `o claude saiu com código ${code}`;
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

  /** Validade do cache desta conversa (ms), pela última resposta que gravou nele; null antes disso. */
  get cacheTtl(): number | null {
    return this.cacheTtlMs;
  }

  /** A última resposta veio no modo rápido. */
  get fast(): boolean {
    return this.fastMode;
  }

  get model(): string | null {
    return this.state.model ?? null;
  }

  /** Aviso do Claudio’s Club no meio da conversa (só para você; o funcionário não vê). */
  addNotice(text: string, tone: 'info' | 'warn' = 'info') {
    this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text, tone, at: new Date().toISOString() });
  }

  /**
   * Aviso do limite de uso: cria o item, ou troca o que já tem esse id (o aviso muda de texto quando o
   * "continue" sai, é cancelado ou a hora muda). `action` põe o botão de cancelar.
   */
  setNotice(id: string, text: string, tone: 'info' | 'warn', action?: 'cancel-auto-continue') {
    this.putItem({ kind: 'notice', id, text, tone, at: new Date().toISOString(), ...(action && { action }) });
  }

  /**
   * Aviso do despertador: cria o item, ou troca o que já tem esse id (a hora mudou, voltou, foi cancelado). A contagem
   * regressiva não vem no texto: o cliente a faz a partir de `wakeAt`.
   */
  setWakeNotice(id: string, text: string, wake: 'waiting' | 'sent' | 'cancelled' | 'failed', wakeAt: number) {
    this.putItem({
      kind: 'notice',
      id,
      text,
      tone: wake === 'failed' ? 'warn' : 'info',
      at: new Date().toISOString(),
      wake,
      wakeAt,
      ...(wake === 'waiting' && { action: 'cancel-wake' as const }),
    });
  }

  /** Aviso da retomada automática: igual a `setNotice`, com o estado em campos (`retry`); o texto é o de reserva. */
  setRetryNotice(id: string, text: string, tone: 'info' | 'warn', retry: TurnRetryNotice) {
    this.putItem({ kind: 'notice', id, text, tone, at: new Date().toISOString(), retry });
  }

  send(text: string, priority: SendPriority = 'next', images: string[] = [], notice?: string, files: ChatAttachment[] = [], fromStaff = false) {
    this.checkpointSeen = false;
    const queued = this.state.busy ? priority : undefined;
    if (queued === 'now') this.stopping = true;
    // Mensagem de outro funcionário (delegação) não é "sua": sem origem, o aviso diz só "no chat".
    this.scan(text, fromStaff ? undefined : 'owner');
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
    this.unanswered.push({ content });
    this.putItem({
      kind: 'user',
      id: `u:${uuid}`,
      uuid,
      text,
      at: new Date().toISOString(),
      ...(queued && { queued }),
      ...(images.length && { images: images.length }),
      ...(files.length && { files: files.map((f) => f.name) }),
      ...(fromStaff && { fromStaff }),
    });
    this.waitingReply = true;
    this.streamError = null;
    this.apiError = null;
    this.startTurnBudget();
    this.setState({ busy: true, error: null });
  }

  /** O que o manager precisa para decidir a retomada de um turno que acabou (ver `TurnEnd`): lido já, antes de qualquer limpeza do estado. */
  protected turnContext(): TurnContext {
    return { items: this.snapshot().items, awaitingAnswer: this.awaitingAnswer, background: [...this.state.background] };
  }

  /** Troca o modo de permissão do processo aberto, sem reiniciar (a ficha mudou de autonomia). */
  setPermissionMode(mode: string, label: string) {
    // Consulta: o modo `default` é o que mantém a leitura dentro da pasta do projeto (ver buildClaudeConsultArgs); nenhuma troca vale.
    if (this.opts.denyPermissions) return;
    this.control({ subtype: 'set_permission_mode', mode }, label, { mode: true });
  }

  /** Troca o modelo desta conversa, na hora (a ficha continua como está). */
  setModel(model: string, label: string) {
    this.wantedModel = model;
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
    const content = [{ type: 'text', text: '/compact' }];
    this.write({ type: 'user', message: { role: 'user', content } });
    this.unanswered.push({ content });
    this.waitingReply = true;
    this.setState({ busy: true, compacting: true });
  }

  interrupt() {
    if (this.state.busy) this.stopping = true;
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  protected clock(): number {
    return this.opts.clock?.() ?? Date.now();
  }

  /**
   * Um turno começa (mensagem numa conversa parada, ou o `init` do claude): zera a conta e lê os tetos. Confere
   * de 15 s em 15 s (e a cada evento, ver `checkTurnCap`). Com turno já contado, não faz nada.
   */
  protected startTurnBudget(): void {
    if (this.budget.active) return;
    this.turnKey = randomUUID().slice(0, 8);
    this.budget.begin(this.clock());
    const caps = this.opts.turnCaps?.();
    if (caps) void caps.then((c) => { this.budget.setCaps(c); this.checkTurnCap(); }, () => {});
    this.capTimer = setInterval(() => this.checkTurnCap(), 15_000);
    this.capTimer.unref?.();
  }

  /** O turno acabou (ou o processo saiu): para de contar e de conferir. */
  protected endTurnBudget(): void {
    this.budget.end();
    if (this.capTimer) clearInterval(this.capTimer);
    this.capTimer = null;
  }

  /**
   * Estourou o teto: avisa o manager (que guarda o motivo antes da interrupção), põe o aviso no chat e interrompe como o
   * botão Parar. Uma vez por turno: a conta para de disparar depois disso.
   */
  protected checkTurnCap(): void {
    const hit = this.budget.check(this.clock());
    if (!hit) return;
    this.opts.onTurnCap?.(hit);
    this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: capText(hit), tone: 'warn', at: new Date().toISOString(), cap: hit });
    try {
      this.interrupt();
    } catch {
      // sem processo aberto: o turno já tinha acabado
    }
  }

  /** Pedido seu (permissão ou pergunta) entrou ou saiu da fila: o relógio do teto para enquanto você decide. */
  private pendingChanged(): void {
    this.budget.setPaused(this.pending.size > 0, this.clock());
  }

  /**
   * Responde um pedido de permissão. Aprovar devolve a entrada original, sem mudanças; com
   * `remember`, ainda libera de vez (nesta conversa ou no projeto). Negar leva `message` (o que o
   * funcionário lê), por padrão "negou". Numa pergunta com opções (AskUserQuestion), aprovar leva
   * `reply.answers` (sem nenhuma, o Claude lê "não respondeu") e nunca vira "permitir sempre":
   * liberar de vez faria as próximas perguntas passarem sem ninguém responder.
   */
  answer(
    requestId: string,
    allow: boolean,
    message = 'O usuário negou pelo Claudio’s Club.',
    remember?: Remember,
    reply?: { answers?: unknown; annotations?: unknown },
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.pendingChanged();
    const asking = p.tool === ASK_TOOL;
    const updatedPermissions = allow && remember && !asking ? rememberRules(p.tool, p.suggestions, remember) : undefined;
    const given = allow && p.questions ? cleanAnswers(p.questions, reply?.answers, reply?.annotations) : undefined;
    const input =
      given && p.input && typeof p.input === 'object'
        ? { ...p.input, answers: given.answers, ...(Object.keys(given.annotations).length > 0 && { annotations: given.annotations }) }
        : p.input;
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: input, ...(updatedPermissions && { updatedPermissions }) } : { behavior: 'deny', message },
      },
    });
    const item = this.items.get(`p:${requestId}`);
    if (item?.kind === 'permission') {
      this.putItem({
        ...item,
        status: allow ? 'allowed' : 'denied',
        ...(updatedPermissions && { remembered: remember }),
        ...(given && { answers: given.answers }),
      });
    }
    return true;
  }

  /** Guarda de segredos: avisa o tipo, o palpite e a dica do que apareceu (ver secrets.ts). Vale para o Claude e para o Codex (este herda daqui). */
  protected scan(text: string, source?: SecretSource, file?: string | null, command?: string | null) {
    if (!this.opts.onSecret) return;
    // O comando só serve à saída dele (`tool-result`) e quando o arquivo não está dado: no que o próprio comando escreveu (`tool-input`) não há de onde ler.
    const from = source === 'tool-result' && !file && command ? command : undefined;
    for (const hit of scanSecrets(text, { file, cwd: this.opts.cwd, pepper: this.opts.secretPepper })) this.opts.onSecret(hit, source, file ?? undefined, from);
  }

  lastAssistantText(): string | null {
    return this.lastAssistant()?.text ?? null;
  }

  /** A última mensagem com texto de quem fala com o funcionário (você ou um colega): o pedido que o card automático guarda. */
  lastUserText(): string | null {
    const items = [...this.items.values()];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'user' && it.text.trim()) return it.text;
    }
    return null;
  }

  /** A última resposta com texto (o balão onde uma pergunta no fim da conversa aparece). */
  lastAssistant(): { id: string; text: string } | null {
    const items = [...this.items.values()];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'assistant' && it.text.trim()) return { id: it.id, text: it.text };
    }
    return null;
  }

  /** Há pedido (permissão ou pergunta) com este id ainda sem resposta. */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Pedidos de permissão ainda sem resposta (a caixa "precisa de mim" lê daqui). */
  pendingPermissions(): Array<Extract<ChatItem, { kind: 'permission' }>> {
    return [...this.items.values()].filter(
      (i): i is Extract<ChatItem, { kind: 'permission' }> => i.kind === 'permission' && i.status === 'pending',
    );
  }

  get error(): string | null {
    return this.state.error;
  }

  /**
   * Pedimos para fechar e o processo ainda não saiu (até ~3 s, mais o `killTree`). Nessa janela `running` segue verdadeiro, mas nada pode ser escrito nele:
   * quem vai mandar mensagem espera sair e reabre (ver `ChatManager.ensure`).
   */
  get isClosing(): boolean {
    return this.closedByUs && this.state.running;
  }

  stop() {
    const child = this.child;
    if (child) this.closedByUs = true;
    child?.stdin.end();
    // Se não sair sozinho, encerra a árvore (o claude e os comandos que ele abriu).
    setTimeout(() => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) void killTree(child.pid);
    }, this.opts.stopGraceMs ?? 3_000).unref?.();
  }

  // ---- leitura do stream ----

  /** Conta as ferramentas de uma mensagem do assistente (também as dos subagents) e confere o teto logo depois. */
  private countToolUses(ev: Record<string, unknown>): void {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_use' && typeof b.id === 'string') this.budget.countTool(b.id);
    }
    this.checkTurnCap();
  }

  /** Chamadas de edição (id da ferramenta → arquivo) que ainda esperam o resultado: só quem deu certo vai para `onEdit`. */
  private readonly editCalls = new Map<string, string>();

  /** Chamadas com arquivo-alvo (Read e as de edição; id da ferramenta → arquivo) que ainda esperam o resultado: o aviso de segredo no resultado aponta esse arquivo. */
  private readonly toolFiles = new Map<string, string>();

  /** Comandos de shell (Bash e PowerShell; id da ferramenta → comando) que ainda esperam o resultado: se a saída traz segredo, o manager descobre qual arquivo que o comando leu o tem. */
  private readonly toolCommands = new Map<string, string>();

  /**
   * Edição que deu certo, vista nas ferramentas do Claude (a conversa e os subagents): a chamada (`tool_use`) guarda o arquivo e o resultado
   * (`tool_result`) sem `is_error` o libera. Negada, falha ou sem resultado não conta.
   */
  private trackEdits(ev: Record<string, unknown>): void {
    if (!this.opts.onEdit) return;
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    const done: string[] = [];
    for (const b of content as Array<Record<string, unknown>>) {
      if (ev.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const file = claudeEditedFile(b.name, b.input);
        // O teto só protege a memória de um processo longo cujas chamadas nunca voltam.
        if (file && this.editCalls.size < 1_000) this.editCalls.set(b.id, file);
      } else if (ev.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const file = this.editCalls.get(b.tool_use_id);
        if (file === undefined) continue;
        this.editCalls.delete(b.tool_use_id);
        if (b.is_error !== true) done.push(file);
      }
    }
    if (!done.length) return;
    // Registro, não trava: quem recebe nunca derruba a leitura do stream.
    try {
      this.opts.onEdit(done);
    } catch {
      // o quadro registra o que puder
    }
  }

  protected onData(text: string) {
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
    // Teto do turno: as ferramentas contam antes do filtro abaixo (as dos subagents também gastam), e o tempo é conferido a cada evento.
    if (ev.type === 'assistant') this.countToolUses(ev);
    if (ev.type !== 'result') this.checkTurnCap();
    // As edições dos subagents também valem (o card automático registra toda alteração de código), então contam antes do filtro abaixo.
    if (ev.type === 'assistant' || ev.type === 'user') this.trackEdits(ev);
    // Eventos de subagents (parent_tool_use_id preenchido) ficam fora da conversa principal; só a negação deles vai para o alerta (ver `trackSubDenials`).
    if (ev.parent_tool_use_id) {
      if (this.opts.onDenied && (ev.type === 'assistant' || ev.type === 'user')) this.trackSubDenials(ev);
      return;
    }
    const at = new Date().toISOString();

    switch (ev.type) {
      case 'system': {
        const subtype = ev.subtype;
        const mode = typeof ev.permissionMode === 'string' ? ev.permissionMode : null;
        // Cada turno começa com um init, inclusive o da mensagem que esperou na fila (`later`).
        if (subtype === 'init') {
          // Turno que o próprio claude começa (mensagem da fila dele): a conta começa aqui; com turno já contado, não muda nada.
          this.startTurnBudget();
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
          // O texto da negação (quem barrou e por quê) vem no resultado da ferramenta: ele troca este aviso.
          const id = `n:${randomUUID()}`;
          this.denialNotices.set(typeof ev.tool_use_id === 'string' ? ev.tool_use_id : `name:${tool}`, id);
          this.putItem({ kind: 'notice', id, text: `${tool}: permissão negada`, tone: 'warn', at, tool });
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
          // Fixa antes de criar: o item que está chegando em deltas nunca sai de `items` (ver `pinned`).
          this.streamingId = id;
          if (!this.items.has(id)) this.putItem({ kind: 'assistant', id, text: '', at });
          const item = this.items.get(id);
          if (item?.kind === 'assistant') item.text += event.delta.text;
          this.emit({ type: 'delta', seq: ++this.seq, id, text: event.delta.text });
        }
        return;
      }
      case 'assistant': {
        const msg = ev.message as { id?: string; model?: string; content?: unknown; usage?: Record<string, number> } | undefined;
        if (!msg) return;
        // O erro de limite chega como uma mensagem "sintética" do assistente (não uma resposta dele).
        if (ev.isApiErrorMessage === true || msg.model === '<synthetic>' || typeof ev.error === 'string') {
          this.apiError = { kind: typeof ev.error === 'string' ? ev.error : null, status: typeof ev.apiErrorStatus === 'number' ? ev.apiErrorStatus : null };
          for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
            const hit = b.type === 'text' ? limitFromText(b.text) : null;
            if (hit) this.limitSeen = { ...mergeHits(this.limitSeen, hit), confirmed: true };
            if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) this.streamError = b.text.trim().slice(0, 500);
          }
        }
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
            const input = inputText(b.input, name);
            const file = claudeToolFile(name, b.input);
            // O resultado (a leitura de um arquivo) chega depois: guarda o arquivo da chamada até lá.
            if (file && this.opts.onSecret && this.toolFiles.size < 1_000) this.toolFiles.set(b.id, file);
            const command = this.opts.onSecret ? claudeToolCommand(name, b.input) : null;
            if (command && this.toolCommands.size < 1_000) this.toolCommands.set(b.id, command);
            this.scan(input, 'tool-input', file);
            this.putItem({ kind: 'tool', id: `t:${b.id}`, name, summary: toolSummary(name, b.input), input, result: null, isError: false, at });
          }
        }
        const u = msg.usage;
        if (u) {
          const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          const window = this.window ?? contextWindowFor(msg.model ?? this.state.model);
          if (used > 0) this.setState({ context: { used, window, percent: Math.round((used / window) * 100) } });
          this.cacheTtlMs = cacheTtlOf(u) ?? this.cacheTtlMs;
          this.fastMode = (u as { speed?: unknown }).speed === 'fast';
        }
        return;
      }
      case 'user': {
        const msg = ev.message as { content?: unknown } | undefined;
        for (const b of (Array.isArray(msg?.content) ? msg!.content : []) as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
          const tool = this.items.get(`t:${b.tool_use_id}`);
          const result = resultText(b.content);
          const file = this.toolFiles.get(b.tool_use_id);
          const command = this.toolCommands.get(b.tool_use_id);
          this.toolFiles.delete(b.tool_use_id);
          this.toolCommands.delete(b.tool_use_id);
          this.scan(result, 'tool-result', file, command);
          if (tool?.kind === 'tool') {
            this.putItem({ ...tool, result, isError: b.is_error === true });
            // Erro de ferramenta: o texto do resultado pode ser uma negação (troca o aviso do evento, ou abre um) e já tira a espera.
            if (b.is_error === true) {
              this.denialFromResult(b.tool_use_id, tool.name, result);
              continue;
            }
          }
          // Sem negação a tratar: a ferramenta já saiu de `items` (ver `evict`) ou o resultado não é erro. Ninguém vai trocar o
          // texto de um aviso que ficou esperando por este id, e a espera dele não pode ficar para sempre.
          this.denialNotices.delete(b.tool_use_id);
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
        // Consulta: nada de cartão nem de pendência (não entra na caixa "precisa de mim" nem espera o dono). A negação sai antes de qualquer outra coisa.
        if (this.opts.denyPermissions) {
          this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: this.opts.denyPermissions } } });
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: `Pedido de permissão negado na hora (${tool}): conversa de consulta, só leitura da pasta do projeto.`, tone: 'info', at });
          return;
        }
        const suggestions = (Array.isArray(req.permission_suggestions) ? req.permission_suggestions : []).filter(
          (s): s is Suggestion => !!s && typeof s === 'object',
        );
        // Pergunta com opções: as perguntas validadas viram um cartão para responder (entrada
        // que não dá para ler fica no cartão genérico).
        const questions = req.tool_name === ASK_TOOL ? parseQuestions(req.input) : null;
        this.pending.set(requestId, { input: req.input, tool: req.tool_name ?? tool, suggestions, ...(questions && { questions }) });
        this.pendingChanged();
        // Fim do modo plano: o plano vem inteiro em `input.plan` e vira um cartão para aprovar.
        const plan = req.tool_name === 'ExitPlanMode' ? (req.input as { plan?: unknown } | undefined)?.plan : undefined;
        this.putItem({
          kind: 'permission',
          id: `p:${requestId}`,
          tool,
          summary: plan !== undefined ? 'plano pronto para aprovar' : toolSummary(req.tool_name ?? tool, req.input),
          description: typeof req.description === 'string' ? req.description : null,
          input: inputText(req.input, req.tool_name ?? tool),
          status: 'pending',
          at,
          ...(typeof plan === 'string' && { plan }),
          ...(questions && { questions }),
        });
        // Só perguntas de escolha vão ao gestor: o formato dele não tem texto livre nem número (ficam com você).
        if (questions?.every((q) => q.kind === 'choice')) {
          this.opts.onAsk?.(requestId, questions.map((q) => ({ question: q.question, options: q.options.map((o) => o.label), ...(q.multiSelect && { multiSelect: true }) })));
        }
        return;
      }
      case 'rate_limit_event': {
        // `rejected`: o limite estourou. Só vale se o turno terminar parado por isso (ver `result`).
        const rejected = limitFromRateLimitEvent(ev);
        if (rejected) this.limitSeen = { ...mergeHits(this.limitSeen, rejected), confirmed: this.limitSeen?.confirmed ?? false };
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
        // Aviso de comando em segundo plano que só entra no histórico, sem chamar o modelo (num_turns 0): ao
        // retomar uma conversa que morreu com um comando rodando, o claude registra que ele parou num "turno"
        // próprio, com init e result, antes da nossa mensagem. Não é fim de turno: segue ocupado se a nossa
        // ainda vai rodar, e ninguém é avisado de que parou.
        if (ev.num_turns === 0 && (ev.origin as { kind?: unknown } | undefined)?.kind === 'task-notification') {
          this.setState({ busy: this.waitingReply });
          return;
        }
        this.waitingReply = false;
        const usage = ev.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        const windows = Object.values(usage ?? {}).map((m) => m.contextWindow).filter((w): w is number => !!w);
        if (windows.length) {
          this.window = Math.max(...windows);
          const c = this.state.context;
          if (c) this.setState({ context: { ...c, window: this.window, percent: Math.round((c.used / this.window) * 100) } });
        }
        this.doneText.clear();
        this.streamingId = null;
        const hit = ev.is_error === true ? limitFromText(ev.result) : null;
        if (hit) this.limitSeen = { ...mergeHits(this.limitSeen, hit), confirmed: true };
        // Parar, interromper ou fechar: este turno acabou por vontade nossa e nunca é retomado sozinho, qualquer que seja o erro dele.
        const intentional = this.stopping || this.closedByUs;
        const stopped = this.stopping && ev.subtype === 'error_during_execution';
        this.stopping = false;
        const apiError = this.apiError;
        const priorError = this.streamError;
        this.apiError = null;
        this.streamError = !stopped && ev.is_error === true && typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim().slice(0, 500) : null;
        // Modelo pedido que não existe mais: o turno não termina; o padrão e a mesma mensagem (uma vez, ver `retryOnDefault`).
        const sent = this.unanswered.shift();
        if (!stopped && sent && ev.is_error === true && !this.modelRetried && this.wantedModel && this.wantedModel !== 'default' && isClaudeModelNotFound(ev)) {
          this.limitSeen = null;
          this.retryOnDefault(this.wantedModel, sent.content);
          return;
        }
        this.modelRetried = false;
        if (stopped) {
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text: 'Turno interrompido', tone: 'info', at });
        } else if (ev.is_error === true) {
          const text = typeof ev.result === 'string' && ev.result ? ev.result : 'O turno terminou com erro.';
          this.putItem({ kind: 'notice', id: `n:${randomUUID()}`, text, tone: 'error', at });
        }
        // O limite estourou neste turno: o evento `rejected` sozinho só vale se o turno terminou com erro. Turno
        // que você interrompeu (parar/interromper) não vale: quem parou foi você, não o limite.
        const limit = this.limitSeen;
        this.limitSeen = null;
        if (!stopped && limit && (limit.confirmed || ev.is_error === true)) this.opts.onUsageLimit?.({ resetsAt: limit.resetsAt, window: limit.window });
        else {
          this.opts.onTurnWithoutLimit?.();
          if (ev.is_error !== true) this.opts.onTurnEnd?.({ kind: 'ok' });
          // Erro do turno, com o motor sem mais nada na fila (se outra mensagem já espera, o trabalho segue sozinho). O texto é o do resultado
          // (ou a mensagem de erro sintética que veio antes): nunca a saída de uma ferramenta.
          else if (!intentional && !stopped && !this.unanswered.length) {
            const status = typeof ev.api_error_status === 'number' ? ev.api_error_status : (apiError?.status ?? null);
            const text = typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : (priorError ?? '');
            this.opts.onTurnEnd?.({ kind: 'failed', error: { text: text.slice(0, 500), status, kind: apiError?.kind ?? null }, ...this.turnContext() });
          }
        }
        this.endTurnBudget();
        this.setState({ busy: false, compacting: false });
        this.idleCheck('turn');
        return;
      }
    }
  }

  /**
   * O modelo `model` não existe mais: avisa, põe o padrão e escreve de novo a mensagem que levou a recusa (a mesma, com as imagens,
   * anexos e avisos que trazia). O turno segue aberto; se a segunda tentativa também for recusada, vale o erro normal (sem laço).
   */
  private retryOnDefault(model: string, content: unknown[]) {
    this.modelRetried = true;
    this.waitingReply = true;
    this.opts.onModelUnavailable?.(model);
    this.addNotice(`O modelo ${model} não existe mais. Esta conversa segue no modelo padrão; troque o modelo na ficha.`, 'warn');
    // Sem rótulo: a troca dá certo em silêncio (o aviso acima já diz). Se ela falhar, a mensagem sai mesmo assim e a recusa dela cai no erro normal.
    this.setModel('default', '');
    this.write({ type: 'user', uuid: randomUUID(), message: { role: 'user', content } });
    this.unanswered.push({ content });
  }

  private readonly doneText = new Map<string, string[]>();
  /** Limite de uso visto neste turno; `confirmed`: um texto de erro de limite confirmou (não só o evento). */
  private limitSeen: (LimitHit & { confirmed: boolean }) | null = null;
  protected checkpointSeen = false;
  private cacheTtlMs: number | null = null;
  private fastMode = false;
  /** Avisos de negação esperando o texto do resultado (chave: id do tool_use, ou `name:<ferramenta>` sem id). */
  private readonly denialNotices = new Map<string, string>();
  /** Chamadas dos subagents (id da ferramenta → nome) que ainda esperam o resultado: se vier negada, o alerta diz qual ferramenta foi. */
  private readonly subCalls = new Map<string, string>();
  /** O turno de agora (muda quando um começa): o que o alerta "ação barrada" usa para agrupar as negações. */
  protected turnKey = randomUUID().slice(0, 8);

  /** Registro da negação para o manager: nunca derruba a leitura do stream. */
  protected noteDenied(denied: DeniedInfo): void {
    try {
      this.opts.onDenied?.(denied, this.turnKey);
    } catch {
      // o alerta registra o que puder
    }
  }

  /**
   * `exit`: o processo saiu (e como). Saída no meio de um turno ocupado, sem fechamento nosso (`stop`), é um turno perdido: o manager decide
   * se retoma (ver `TurnEnd`). Ocupação, intenção de parada e ação pendente são lidas antes de o estado ser limpo, aqui embaixo.
   */
  private finish(error: string | null, exit?: { code: number | null; signal: NodeJS.Signals | null }) {
    if (!this.state.running) return;
    const lost: TurnEnd | null =
      exit && !this.closedByUs && this.busy
        ? {
            kind: 'lost',
            error: {
              text: (error ?? this.streamError ?? (exit.signal ? `o claude foi encerrado pelo sinal ${exit.signal} no meio do turno` : `o claude saiu no meio do turno (código ${exit.code ?? '?'})`)).slice(0, 500),
              status: this.apiError?.status ?? null,
              kind: this.apiError?.kind ?? null,
            },
            ...this.turnContext(),
          }
        : null;
    const pid = this.child?.pid ?? null;
    this.child = null;
    this.endTurnBudget();
    this.opts.onExit?.(pid, error);
    for (const id of this.pending.keys()) {
      const item = this.items.get(`p:${id}`);
      if (item?.kind === 'permission') this.putItem({ ...item, status: 'denied' });
    }
    this.pending.clear();
    this.controls.clear();
    this.unanswered.length = 0;
    this.modelRetried = false;
    for (const w of this.waiters.values()) w.reject(new Error('a conversa fechou'));
    this.waiters.clear();
    this.waitingReply = false;
    this.setState({ running: false, busy: false, compacting: false, error, background: [] });
    for (const done of this.exitWaiters.splice(0)) done();
    if (lost) this.opts.onTurnEnd?.(lost);
    this.opts.onIdle?.('exit');
  }

  private write(obj: unknown) {
    this.lastActivity = Date.now();
    if (!this.child) throw new Error('a conversa não está aberta');
    // Fechando (o stdin já terminou): escrever daria "write after end". Erro limpo, e a mensagem não some calada.
    if (this.child.stdin.writableEnded || this.child.stdin.destroyed) throw new Error('a conversa está fechando: mande de novo em instantes');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  protected putItem(item: ChatItem) {
    const isNew = !this.items.has(item.id);
    this.items.set(item.id, item);
    this.emit({ type: 'item', seq: ++this.seq, item: { ...item } });
    // Só item novo faz sair o mais antigo: trocar um que já está aqui (resultado, status) não muda o tamanho.
    if (isNew) this.evict(item.id);
  }

  /** Não pode sair de `items` agora: pedido sem resposta, ferramenta rodando (com o turno aberto) ou resposta chegando. */
  private pinned(item: ChatItem): boolean {
    if (item.id === this.streamingId) return true;
    if (item.kind === 'permission') return item.status === 'pending';
    // Sem turno aberto, uma ferramenta sem resultado é órfã (o resultado não vem mais): pode sair como as outras.
    if (item.kind === 'tool') return item.result === null && this.busy;
    return false;
  }

  /**
   * Passou do limite: tira os mais antigos, na ordem em que entraram, menos o que `pinned` segura e o item que acabou de entrar.
   * Quem procura um item que saiu (resultado de ferramenta, resposta a um pedido, aviso trocado) já trata a ausência: o
   * resultado de uma ferramenta que saiu não cria nada (um item sem nome nem entrada só estragaria o cartão que a tela ainda tem).
   * Os eventos dos itens que saíram também saem do log: quem abre o stream do começo não os recebe (o histórico os traz do
   * transcript, ver `cut`) e a tela não mostra o mesmo item de dois lugares.
   */
  private evict(justPut: string) {
    let excess = this.items.size - (this.opts.maxItems ?? MAX_LIVE_ITEMS);
    if (excess <= 0) return;
    const gone = new Set<string>();
    let after: string | null = null; // `at` do primeiro item que ficou depois do último que saiu
    let lastGone: string | null = null;
    let wantNext = false;
    for (const [id, item] of this.items) {
      if (excess > 0 && id !== justPut && !this.pinned(item)) {
        gone.add(id);
        excess--;
        this.evictedFrom ??= item.at;
        lastGone = item.at;
        after = null;
        wantNext = true;
      } else if (wantNext) {
        after = item.at;
        wantNext = false;
      }
    }
    if (!gone.size) return;
    for (const id of gone) this.items.delete(id);
    this.evictBefore = laterOf(this.evictBefore, after ?? lastGone);
    const kept = this.log.filter((e) => !(e.type === 'item' ? gone.has(e.item.id) : e.type === 'delta' && gone.has(e.id)));
    this.log.splice(0, this.log.length, ...kept);
  }

  /** Erro de ferramenta: se for negação, o texto troca o aviso do evento (ou abre um, se o evento não veio). */
  private denialFromResult(toolUseId: string, tool: string, text: string) {
    const denial = classifyDenial(text);
    const key = this.denialNotices.has(toolUseId) ? toolUseId : `name:${tool}`;
    const id = this.denialNotices.get(key) ?? (denial.layer === 'other' ? null : `n:${randomUUID()}`);
    this.denialNotices.delete(key);
    if (!id) return;
    const prev = this.items.get(id);
    const at = prev?.kind === 'notice' ? prev.at : new Date().toISOString();
    this.putItem({ kind: 'notice', id, text: denialNotice(tool, denial), tone: 'warn', at, tool, denial });
    this.noteDenied(claudeDenied(tool, denial));
  }

  /**
   * Negação dentro de um subagent (o executor do roteiro "planeje primeiro"): os eventos dele não entram na conversa, mas a regra que barrou vale para o turno inteiro.
   * Sem o evento `permission_denied` (que aqui não é lido), só o texto do resultado que se reconhece como negação conta; erro comum não.
   */
  private trackSubDenials(ev: Record<string, unknown>): void {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const b of content as Array<Record<string, unknown>>) {
      if (ev.type === 'assistant' && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        if (this.subCalls.size < 1_000) this.subCalls.set(b.id, b.name);
      } else if (ev.type === 'user' && b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const tool = this.subCalls.get(b.tool_use_id);
        this.subCalls.delete(b.tool_use_id);
        if (!tool || b.is_error !== true) continue;
        const denial = classifyDenial(resultText(b.content));
        if (denial.layer !== 'other') this.noteDenied(claudeDenied(tool, denial));
      }
    }
  }

  protected setState(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', seq: ++this.seq, state: { ...this.state } });
  }

  protected emit(e: ChatEvent) {
    this.log.push(e);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    for (const l of this.listeners) l(e);
  }
}
