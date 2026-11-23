import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AskedQuestion,
  Autonomy,
  BackgroundTask,
  ChatAttachment,
  ChatCommand,
  ChatEvent,
  ChatItem,
  ChatMcp,
  ChatSnapshot,
  CodexUsage,
  ContextSwitch,
  EngineOverride,
  LiveSession,
  QuestionAnnotations,
  QuestionAnswers,
  QuotaBoost,
  RewindPreview,
  SendPriority,
  StaffProfile,
  TaskQuestion,
  UsageLimit,
} from '../../shared/model';
import { writeAtomic } from '../staff/store';
import type { Worktree } from '../staff/worktree';
import { updateGitPolicyAutonomy } from '../staff/gitMcp';
import { codexHistoryOf } from '../adapters/codex/rollout';
import { isProjectDir } from '../adapters/claude/paths';
import { MAX_ITEMS, readHistory, TAIL_BYTES } from './history';
import { dropSeamEchoes } from './seam';
import type { CodexSpawn } from './codexArgs';
import type { CodexEnvStatus } from '../codexEnv';
import type { CodexModelInfo } from '../codexModels';
import { CodexProcess } from './codexProcess';
import type { CodeEdit } from './codeEdits';
import { locateSecretFile } from './secretOrigin';
import { denialWeight, type DeniedInfo } from './denied';
import { ChatProcess, type ChatProcessOptions, type Remember } from './process';
import { cleanAnswers } from './questions';
import { finalQuestion } from './question';
import { CEILING_AT, contextNotice, kTokens, NOTICE_AT, rereadUsd, switchDecision, usd, type TurnInfo } from './contextPolicy';
import { BOOST_NOTICE, CONTEXT_NOTICE, RETRY_TEXT, STAFF_NOTICE } from './items';
import { InboxState } from '../inboxState';
import { isAlive, killTree, type ChatRegistry } from './registry';
import { confirmProcess, startedBeforeBoot, type ProcLister } from '../procIdentity';
import { CONTINUE_TEXT, type AutoContinue, type AutoContinueEvent, type CancelBy, type Pending, type RetryInfo } from './autoContinue';
import { attemptsAllowed, backoffMs, classifyTurnError, errorLine, isAuthFailure, retryField, retryNotice, TurnRetryLedger, type Transient, type TurnEnd, type TurnError } from './turnRetry';
import { limitNotice, MAX_LIMIT_HITS, resumePlan, type LimitHit, type ResumePlan } from './usageLimit';
import { codexLimitHit } from '../codexUsage';
import { WAKE_MAX_STREAK, WakeStreakError, wakeNotice, type WakeInput } from './wake';
import { readUsage } from '../usage';
import type { SessionTokens } from '../callers';
import { resumeText, type ResumeEntry } from './resume';
import { externalBackground, externalCutWithAgents, subagentsDirOf } from './cutAction';
import { legacyLabel, worseVerdict, type ClassifiedSecret, type SecretHint, type SecretKind, type SecretReason, type SecretSource, type SecretVerdict } from './secrets';
import { capReason, capText, presumedStop, type TurnCaps } from './turnCap';
import type { ConsultStamp, TurnCapHit } from '../../shared/model';

export interface ChatSpawn {
  sessionId: string;
  cwd: string;
  /** Conversa de consulta de outro projeto (server/consult/): o carimbo de quem perguntou. Ela abre sem token, nega todo pedido de permissão e não conta como trabalho do funcionário. */
  consult?: ConsultStamp;
  /** Argumentos do `claude`. Com `engine: 'codex'` ficam vazios: valem os de `codex`. */
  args: string[];
  /** Quem roda a conversa; ausente = `claude`. */
  engine?: 'claude' | 'codex';
  /** Como abrir a conversa no Codex (só com `engine: 'codex'`). */
  codex?: CodexSpawn;
  /**
   * O modelo/esforço da linha de comando vêm de uma escolha gravada nesta conversa (ou na de origem,
   * ao duplicar). Vale como escolha à mão: a folga de cota não troca nem desfaz.
   */
  chosen?: boolean;
}

/** O limite de uso estourou numa conversa (ver `onUsageLimit`). `engine`: o motor da conversa, não o da ficha. */
export interface UsageLimitEvent {
  sessionId: string;
  projectId: string;
  staffId: string | null;
  engine: 'claude' | 'codex';
  hit: LimitHit;
}

export interface ChatManagerOptions {
  /** ~/.claude/projects */
  transcriptsDir: string;
  /**
   * A conversa é do projeto? (ver server/sessionScope.ts `sessionInProject`). O histórico do Codex vem do rollout, que não diz o projeto: sem esta
   * prova, `snapshot` o leria pelo id da conversa, de qualquer projeto. Sem ele, o histórico do Codex não é escopado (só nos testes).
   */
  sessionInProject?: (projectId: string, sessionId: string) => Promise<boolean>;
  /** Onde o Codex guarda o id de cada conversa (`<runDir>/<sessão>/codex-thread.json`). Padrão: ~/.myco/run. */
  runDir?: string;
  /** Cópias trazidas ("Trazer" de uma conversa aberta em outro lugar): original → cópia. Sem ele, só em memória. */
  copiesFile?: string;
  /** Onde gravar o consumo lido das conversas (o mesmo arquivo que o mod myco-tap grava). */
  usageFile: string;
  /**
   * Os limites do Codex (conta do ChatGPT), lidos na hora em que a conversa do Codex bate no limite: é de onde sai a hora
   * de voltar. Sem ele (ou sem leitura), o "continue" do Codex vai daqui a 30 min.
   */
  codexLimits?: () => Promise<CodexUsage | null>;
  listLive: () => Promise<LiveSession[]>;
  /** Monta a linha de comando (ficha, autonomia, MCPs) de quem vai conversar. */
  /** `forkFrom`: sessão nova que começa como cópia desta (duplicar a conversa). */
  /** `place`: a worktree do card, para a conversa NOVA de trabalho abrir nela (ver `TaskService.startNow`); ignorado ao reabrir uma conversa (a pasta gravada vale). */
  resolve: (projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string, engineOverride?: EngineOverride, reviewOnly?: boolean, consult?: ConsultStamp, place?: Worktree) => Promise<ChatSpawn | null>;
  /** Uma conversa de consulta (server/consult/) terminou um turno, ou saiu: o serviço de consulta lê a resposta e a entrega. */
  onConsultIdle?: (consultId: string, sessionId: string, reason: 'turn' | 'background' | 'exit') => void;
  /**
   * Você escolheu modelo/esforço no seletor do chat: guarda na ficha, na conversa e como "último" do
   * funcionário (a conversa reabre assim; conversa nova sem modelo na ficha herda o último). Só grava
   * escolha sua; a folga de cota não passa por aqui. Sem ele, nada é gravado.
   */
  rememberChoice?: (projectId: string, staffId: string, sessionId: string, choice: { model?: string; effort?: string }) => Promise<void>;
  /** O motor recusou o modelo da ficha (não existe mais): grava a marca `modelObsolete` nela. Sem ele, a marca não é gravada. */
  markModelObsolete?: (projectId: string, staffId: string, model: string, engine: 'claude' | 'codex') => Promise<void>;
  /** Conversa parada há mais que isso fecha o processo (a sessão continua no disco). */
  idleMs?: number;
  spawnImpl?: ChatProcessOptions['spawnImpl'];
  /** Quanto cada conversa do Claude espera o processo sair sozinho ao fechar, antes de encerrar a árvore dele (testes encurtam). */
  stopGraceMs?: number;
  /** Até quando `close` espera o processo sair (testes encurtam). */
  closeWaitMs?: number;
  /**
   * Você vai fechar uma conversa que está trabalhando (confirmou): a tarefa de trabalho dela sai de "fazendo" para Aguardar ANTES de o processo
   * sair (a saída conta como fim de turno e entregaria a tarefa para revisão). Erro aqui não impede o fechamento.
   */
  beforeClose?: (sessionId: string) => Promise<unknown>;
  /** Modelos do Codex da conta, para o plano B de quem roda no Codex (ver CodexProcess); sem ele, o plano B roda no padrão do Codex. */
  codexModels?: () => Promise<ReadonlyArray<Pick<CodexModelInfo, 'slug'>>>;
  /** Confere o `codex` instalado antes de cada execução (versão mínima e `network_proxy`, ver server/codexEnv.ts); sem ele, a rede do Codex fica desligada. */
  codexEnv?: () => Promise<CodexEnvStatus>;
  /** A sandbox do Codex quebrou numa conversa (ver CodexProcess.onSandboxFailure); o index.ts liga na CodexCapability. */
  onCodexSandboxFailure?: (text: string) => void;
  /** A saída de uma ferramenta do Codex trouxe a falha do usuário local do sandbox no Windows, a política de senha (ver CodexProcess.onPasswordPolicyFailure); o index.ts leva o aviso à caixa. */
  onCodexPasswordPolicyFailure?: () => void;
  /** Uma conversa do Codex vai abrir: o index.ts faz a checagem prévia da política de senha do Windows (ver CodexPasswordPolicy.check). Não espera: a conversa não atrasa por causa dela. */
  onCodexOpen?: () => void;
  /** Tokens das conversas (`MYCO_TOKEN` no ambiente de cada uma, ver server/callers.ts). Sem ele, as conversas abrem sem token. */
  tokens?: SessionTokens;
  /** A pasta do projeto (a raiz que o `files/read` abre), para o aviso de segredo achar o arquivo que um comando leu (ver `locateSecretFile`). Sem ele, o aviso fica sem arquivo nesse caso. */
  projectDirOf?: (projectId: string) => Promise<string | null>;
  /** Processos abertos, gravados em disco para achar os órfãos depois de um reinício. */
  registry?: ChatRegistry;
  /** Testes trocam (pid vivo? / encerrar processo / nome e hora de criação do processo que tem o pid). */
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<void>;
  inspectProcess?: ProcLister;
  log?: (line: string) => void;
  /** Você aprovou o plano de uma conversa (a tarefa dela passa para "fazendo", com o plano). */
  onPlanApproved?: (sessionId: string, plan: string) => void;
  /** Você recusou o plano de uma conversa (a tarefa dela sai da fila e vai para Aguardar). */
  onPlanRejected?: (sessionId: string) => void;
  /** Um plano (ExitPlanMode) ficou pendente numa conversa: o card da tarefa o leva a quem pediu, se foi um gestor (ver `TaskService.onPlan`). */
  onPlan?: (sessionId: string, requestId: string, plan: string) => void;
  /** O plano foi negado sem ser recusado de vez (o funcionário ajusta e apresenta de novo): a espera de decisão do card acaba. */
  onPlanDenied?: (sessionId: string, requestId: string) => void;
  /** Uma pergunta só de escolhas (AskUserQuestion) espera resposta numa conversa (a dúvida da tarefa dela vai ao gestor). */
  onAsk?: (sessionId: string, requestId: string, questions: NonNullable<TaskQuestion['questions']>) => void;
  /** Uma pergunta (AskUserQuestion) foi respondida, recusada ou pulada: `by` diz quem fechou, `summary` é o resumo para a tarefa. */
  onAskAnswered?: (sessionId: string, requestId: string, by: 'manager' | 'user', summary: string) => void;
  /** Uma mensagem sua foi para a conversa (a tarefa dela volta para "fazendo"). */
  onSent?: (sessionId: string) => void;
  /** Um funcionário alterou arquivo(s) com as ferramentas de edição (Claude e Codex; ver chat/codeEdits.ts): o quadro abre o card automático. */
  onEdit?: (edit: CodeEdit) => void;
  /** Uma conversa parou de trabalhar (a fila de tarefas do funcionário anda). `engine` é o do processo que parou (o do Codex não passa pelo vigia de turnos, ver `TaskService.onIdle`). */
  onIdle?: (sessionId: string, projectId: string, staffId: string | null, reason: 'turn' | 'background' | 'exit', engine: 'claude' | 'codex') => void;
  /** O que a caixa lembra entre reinícios; sem ele, fica só na memória. */
  inbox?: InboxState;
  /** Conversa nova quando o assunto fecha (o config); sem ele, `auto`. */
  contextSwitch?: () => Promise<ContextSwitch>;
  /** Conversas que nunca trocam sozinhas (a de uma tarefa: o quadro segue por ela). */
  keepSession?: (sessionId: string) => Promise<boolean>;
  /**
   * A tarefa de uma conversa de trabalho ou deploy, para o alerta "ação barrada" da caixa (ver `deniedHits`); null = conversa livre, de card automático, de revisão
   * ou de dúvida (não gera alerta). Sem ele, nenhuma conversa gera.
   */
  denialTask?: (sessionId: string) => Promise<{ taskId: string; title: string } | null>;
  /**
   * A conversa de tarefa (a mesma de `denialTask`) roda sem a fila de validação pesada porque a conta do Codex tem `hooks.json` (ver `noteGuardOff`): grava a nota na tarefa, uma vez por
   * conversa, e devolve a tarefa para o item da caixa; null = não é conversa de tarefa (fica só o aviso do chat). Sem ele, nenhuma conversa gera.
   */
  heavyGuardOff?: (sessionId: string) => Promise<{ taskId: string; title: string } | null>;
  /** Folga de cota agora (com "otimizar assinatura" ligado); sem ele, nunca. */
  quotaBoost?: () => Promise<QuotaBoost | null>;
  /** Limite de uso estourado: agenda o "continue" para quando ele voltar (ver autoContinue.ts); sem ele, só avisa. */
  autoContinue?: AutoContinue;
  /** Despertador (ver wake.ts): outra instância do agendador, com arquivo e pendências próprios; sem ele, a rota responde 404. */
  wakeups?: AutoContinue;
  /**
   * Retomada automática do turno que falhou por causa passageira (ver turnRetry.ts): a terceira instância do agendador, só para esperar o
   * horário e mandar a mensagem. Quem decide retomar é este manager (opção, ação externa cortada, despertador, parada). Sem ela, nada retoma.
   */
  retries?: AutoContinue;
  /** O orçamento de tentativas por turno original, guardado em disco; sem ele, só na memória. */
  retryLedger?: TurnRetryLedger;
  /** Sorteio do jitter do backoff (testes trocam). */
  random?: () => number;
  /** Relógio do despertador (testes trocam). */
  now?: () => number;
  /** Teto por turno (ferramentas e minutos), lido a cada turno que começa (ver turnCap.ts); sem ele, sem teto. */
  turnCaps?: () => Promise<TurnCaps>;
}

export class ChatError extends Error {}

/** Entrega recusada: o servidor está reiniciando (a rota responde 503). */
export class ChatClosingError extends ChatError {
  constructor() {
    super('o Claudio’s Club está reiniciando; tente de novo em instantes');
  }
}

/**
 * Fechar a conversa foi recusado e nada foi fechado (a rota responde 409 com `code`): `working` = está trabalhando e faltou a confirmação;
 * `uncertain` = mesmo confirmado, matar agora poderia cortar uma ação que mexe fora do projeto (`action` diz qual, ver cutAction.ts).
 */
export class CloseRefusedError extends ChatError {
  constructor(
    readonly code: 'working' | 'uncertain',
    message: string,
    readonly action?: string,
  ) {
    super(message);
  }
}

/** O que `close` fez: `closed` = havia processo e ele saiu; `interrupted` = estava trabalhando (turno cortado, com a sua confirmação). */
export interface CloseResult {
  closed: boolean;
  interrupted: boolean;
}

/** Até quando `close` espera o processo sair (o `stop()` do claude já encerra a árvore à força aos 3 s). */
const CLOSE_WAIT_MS = 10_000;
/** Quantas ferramentas distintas o alerta de ação barrada lista (o resto só entra na contagem). */
const DENIED_TOOLS_MAX = 5;

type Listener = (e: ChatEvent) => void;

/** O processo que um registro ou arquivo de sessão aponta: o que `killVerified` confere antes de encerrar (`key` identifica a sessão em `reusedPids`). */
interface KillTarget {
  pid: number;
  startedAt: string | null;
  key: string;
}
type Elsewhere = NonNullable<ChatSnapshot['elsewhere']> & { target: KillTarget };

/** Começo do aviso de ficha atualizada (o histórico do chat o esconde, ver items.ts). */
export const FICHA_NOTICE = '[MyCo] Sua ficha foi atualizada depois que esta conversa começou.';

/** O que o funcionário lê quando o usuário recusa o plano (fixo: nada do que foi digitado vai junto). */
export const PLAN_REJECTED_MESSAGE = 'O usuário recusou o plano: não execute nada desta tarefa. Responda em uma linha que entendeu e pare.';

/** Autonomia da ficha → modo que o processo aberto reporta e aceita em `set_permission_mode`. */
const CLI_MODE: Record<Autonomy, string> = { plan: 'plan', manual: 'default', acceptEdits: 'acceptEdits', auto: 'auto', bypassPermissions: 'bypassPermissions' };
const AUTONOMY_NAME: Record<Autonomy, string> = {
  plan: 'só planeja',
  manual: 'pede aprovação',
  acceptEdits: 'edita sozinho',
  auto: 'automático',
  bypassPermissions: 'sem travas',
};

/** Aviso no topo do histórico: o que passou do limite da conversa ao vivo e do trecho lido do transcript só está no arquivo. A tela o escreve no idioma dela (`note`). */
function olderInFile(): ChatItem {
  return { kind: 'notice', id: 'n:older-in-file', text: 'Mensagens mais antigas ficam só no arquivo da conversa.', tone: 'info', at: null, note: 'older-in-file' };
}

/** Onde a sessão está aberta e como liberar. */
function holdMessage(o: NonNullable<ChatSnapshot['elsewhere']>): string {
  if (o.orphan) return `ficou um processo do Claudio’s Club de antes do reinício do servidor (pid ${o.pid}): clique em Trazer para encerrá-lo`;
  const where = o.entrypoint === 'claude-desktop' ? 'no app do Claude' : o.entrypoint === 'sdk-cli' ? 'em outro programa (sdk-cli)' : 'num terminal';
  return `a sessão continua aberta ${where} (pid ${o.pid}): feche lá e tente de novo`;
}

/**
 * O que a tarefa guarda da pergunta: uma resposta por linha (`pergunta: opção`). Sem resposta, "pulou" (aprovou sem escolher)
 * ou "recusou" (negou).
 */
function askSummary(questions: AskedQuestion[], allow: boolean, answers: QuestionAnswers | undefined): string {
  if (!allow) return 'recusou a pergunta';
  const given = cleanAnswers(questions, answers, undefined).answers;
  const lines = Object.entries(given).map(([pergunta, a]) => `${pergunta}: ${Array.isArray(a) ? a.join(', ') : a}`);
  return lines.length ? lines.join('\n') : 'pulou a pergunta';
}

/** Valor de uma opção na linha de comando (`--model opus` → 'opus'), ou null. */
function argOf(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : null;
}

/** "sáb., 14:00": quando a folga de cota acaba (o reset da cota de 7 dias), no fuso desta máquina. */
function boostEnd(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** O que entra na linha de comando da conversa, fora a autonomia (que troca sem reabrir). */
function launchFields(p: StaffProfile) {
  const { autonomy: _a, updatedAt: _u, portrait: _p, sessions: _s, firstTask: _f, lastModel: _lm, lastEffort: _le, modelObsolete: _mo, ...rest } = p;
  return rest;
}

/**
 * Transcript de uma sessão: na pasta do projeto, ou na de uma worktree dele (a sessão de um funcionário com worktree própria fica na pasta
 * da worktree). Só as pastas do próprio projeto (`isProjectDir`): o id da conversa vem do pedido e não acha o transcript de outro projeto.
 */
export async function findTranscript(transcriptsDir: string, projectId: string, sessionId: string): Promise<string> {
  const direct = path.join(transcriptsDir, projectId, `${sessionId}.jsonl`);
  if (await fs.access(direct).then(() => true, () => false)) return direct;
  for (const dir of await fs.readdir(transcriptsDir).catch(() => [] as string[])) {
    if (!isProjectDir(projectId, dir)) continue;
    const file = path.join(transcriptsDir, dir, `${sessionId}.jsonl`);
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  return direct;
}

/** Os argumentos de `deliver` depois do projeto e da conversa (os de `deliverNow`, na mesma ordem). */
type DeliverRest = [
  staffId: string | null,
  text: string,
  priority: SendPriority | undefined,
  images: string[],
  files: ChatAttachment[],
  delegated: boolean,
  auto: boolean,
  origin?: string,
  engineOverride?: EngineOverride,
  guard?: () => boolean,
  reviewOnly?: boolean,
  consult?: ConsultStamp,
  place?: Worktree,
];

/** Conversas abertas pelo Claudio’s Club, uma por sessão (= funcionário). */
export class ChatManager {
  private readonly chats = new Map<string, ChatProcess>();
  /** Abas ouvindo cada sessão: listener → como parar de ouvir o processo atual. */
  private readonly streams = new Map<string, Map<Listener, () => void>>();
  /** Conversas cuja ficha mudou: o aviso para reler vai na próxima mensagem de cada uma. */
  private readonly fichaNotices = new Map<string, string>();
  /** Por projeto: os comandos "/" da última sessão que abriu. */
  private readonly commands = new Map<string, ChatCommand[]>();
  /** Conversas duplicadas: cópia → original (para o histórico antes da primeira mensagem). */
  private readonly forks = new Map<string, string>();
  private copies: Record<string, string> | null = null;
  /** Segredos vistos nas conversas (um aviso por tipo por sessão, até você dispensar). */
  // `file` e `cwd` ficam só no servidor (o caminho como o motor o deu, que pode ser absoluto): o inbox os troca pelo caminho relativo do projeto.
  // `occurrence` também (identidade da ocorrência para o "não é segredo"): o inbox não a leva. `hint` é o que a tela do Club mostra.
  private readonly secrets: Array<{
    id: string;
    sessionId: string;
    label: string;
    kind: SecretKind;
    detail?: string;
    verdict: SecretVerdict;
    reason: SecretReason;
    hint?: SecretHint;
    occurrence: string;
    source?: SecretSource;
    file?: string;
    /** A linha do segredo em `file`, quando `locateSecret` a achou (ver `SecretHit.line`). */
    line?: number;
    cwd?: string;
    at: string;
  }> = [];
  /**
   * Ação barrada (kind 'denied'): no máximo uma por conversa, a do turno mais recente. Só na memória, como os segredos. `shown` é a negação que o item mostra (ver `denialWeight`).
   * `ignored`: o turno que você dispensou em cada conversa, para uma negação seguinte do mesmo turno não trazer o alerta de volta.
   */
  private readonly denied = new Map<string, { id: string; turn: string; taskId: string; taskTitle: string; shown: DeniedInfo; count: number; tools: string[]; at: string }>();
  private readonly deniedIgnored = new Map<string, string>();
  /**
   * Fila de validação pesada desligada por `hooks.json` na conta do Codex (kind 'error', id `guardoff:<sessão>`): um item por conversa de tarefa, só na memória. `guardOffNow` são as
   * conversas que estão sem a fila agora (síncrono: o item só entra se ainda estiver ali quando a tarefa for lida).
   */
  private readonly guardOff = new Map<string, { id: string; taskId: string; taskTitle: string; file: string; at: string }>();
  private readonly guardOffNow = new Set<string>();
  /** Conversas cuja última mensagem veio de outro funcionário (delegação), e não de você. */
  private readonly delegated = new Set<string>();
  /** As conversas de consulta de outro projeto abertas aqui (sessão → id da consulta; ver `isConsultSession`). Só em memória: o carimbo na ficha e o registro das consultas guardam o resto. */
  private readonly consultSessions = new Map<string, string>();
  /** Registros de pid que a conferência de identidade achou em outro processo (`pid:startedAt` do arquivo de sessão): não contam como conversa aberta em outro lugar. Só na memória. */
  private readonly reusedPids = new Set<string>();
  /** Quando cada conversa parou com erro (`onExit`): o carimbo que a dispensa do alerta guarda, para um erro novo voltar. Só na memória, como o erro. */
  private readonly errorAt = new Map<string, string>();
  /**
   * Conversas no motor/modelo secundário (sessão → override). Vale para a conversa inteira: continue, respawn e reabrir usam o mesmo.
   * Só na memória do processo: depois de reiniciar o Claudio’s Club, a conversa volta ao motor da ficha.
   */
  private readonly overrides = new Map<string, EngineOverride>();
  /** Quem assinou o limite no meio do turno (ver `onUsageLimit`). */
  private readonly limitListeners: Array<(ev: UsageLimitEvent) => void> = [];
  /** Perguntas em aberto e avisos que não são segredo (sobrevivem a um reinício, ver inboxState.ts). */
  private readonly inbox: InboxState;
  /** Fim do último turno de cada conversa: tamanho do contexto, ponto de corte (sobrevive ao processo fechar). */
  private readonly turns = new Map<string, TurnInfo & { ceilingNoted?: number }>();
  /** Avisos de tarefa desviados: conversa de origem → conversa nova para onde o aviso seguiu (ver `sendToRequester`). */
  private readonly requesterRedirects = new Map<string, string>();
  /** Modelo e esforço com que cada processo abriu (para onde a folga de cota volta). */
  private readonly launched = new WeakMap<ChatProcess, { model: string | null; effort: string | null }>();
  /** Folga de cota em cada processo: ligada, ou você trocou o modelo/esforço à mão (vale a sua escolha). */
  private readonly boosts = new WeakMap<ChatProcess, 'on' | 'manual'>();
  /** Último consumo (5h/7d) visto nas conversas, por janela: a hora de voltar quando o stream não diz. */
  private readonly knownLimits = new Map<string, UsageLimit>();
  /**
   * O aviso de limite de uso mais recente de cada conversa aberta (para trocar o texto quando muda). Cada
   * aviso guarda a própria hora: um estouro novo não reescreve o anterior com a hora dele.
   */
  private readonly limitNotices = new Map<string, { id: string; resetsAt: number; scheduled: boolean }>();
  /** O aviso do despertador de cada conversa aberta enquanto ele espera (para trocar a hora no mesmo aviso). */
  private readonly wakeNotices = new Map<string, string>();
  /** Estouros de limite seguidos por conversa, desde o último turno que terminou sem limite (ver `MAX_LIMIT_HITS`). */
  private readonly limitStreak = new Map<string, number>();
  /** Despertadores que dispararam seguidos por conversa, desde a última mensagem que não foi de despertador (ver `WAKE_MAX_STREAK`). */
  private readonly wakeStreak = new Map<string, number>();
  /** Estouros de limite ainda sendo agendados, por conversa (ver `awaitingLimit`). */
  private readonly limitRuns = new Map<string, Promise<unknown>>();
  /** Decisões de retomada ainda em andamento, por conversa: registradas de forma síncrona no fim do turno, antes da ociosidade (ver `turnEnded`). */
  private readonly retryRuns = new Map<string, Promise<unknown>>();
  /**
   * Parar, interromper, mandar mensagem, teto: cada um soma 1 aqui, de forma síncrona. A retomada que começou antes (decidindo, ou no meio do
   * envio assíncrono) confere o número que viu e desiste se mudou, mesmo que o cancelamento da pendência ainda não tenha terminado.
   */
  private readonly retryGen = new Map<string, number>();
  /** O aviso da retomada de cada conversa aberta (para trocar o texto no mesmo aviso). */
  private readonly retryNotices = new Map<string, string>();
  /** Mensagens a caminho de cada conversa que já existe (ver `deliver`): o processo ainda abrindo não conta como parado (ver `turnAlive`). */
  private readonly sending = new Map<string, number>();
  /**
   * O último turno de cada conversa de funcionário que terminou em erro do motor sem retomada (login recusado, ou erro que não passa sozinho): a tarefa de trabalho lê daqui, no fim do
   * turno, para ir a Aguardar em vez de revisão (ver `engineStopOf`). Em memória: sai no turno bem-sucedido seguinte e em qualquer mensagem não automática.
   */
  private readonly engineStops = new Map<string, Extract<TurnCapHit, { kind: 'engine' }>>();
  /** O orçamento de tentativas por turno original (o "continue" automático não abre orçamento novo). */
  private readonly retryLedger: TurnRetryLedger;
  /** O servidor está reiniciando: nenhuma entrega nova entra (ver `closing`). */
  private shuttingDown = false;
  private readonly timer: NodeJS.Timeout;
  private readonly runDir: string;

  constructor(private readonly opts: ChatManagerOptions) {
    this.runDir = opts.runDir ?? path.join(os.homedir(), '.myco', 'run');
    this.inbox = opts.inbox ?? new InboxState();
    this.retryLedger = opts.retryLedger ?? new TurnRetryLedger();
    opts.autoContinue?.subscribe((e) => this.autoContinueEvent(e));
    opts.wakeups?.subscribe((e) => this.wakeEvent(e));
    opts.retries?.subscribe((e) => this.retryEvent(e));
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref();
  }

  has(sessionId: string): boolean {
    return this.chats.has(sessionId);
  }

  /** O projeto da conversa aberta agora (null: não está aberta aqui). */
  liveProject(sessionId: string): string | null {
    return this.chats.get(sessionId)?.projectId ?? null;
  }

  /** A conversa aberta de outro projeto não recebe nada daqui: a mensagem não cruza projetos, nem com o id certo da conversa. */
  private assertSameProject(projectId: string, sessionId: string | null): void {
    const open = sessionId ? this.chats.get(sessionId) : undefined;
    if (open?.projectId && open.projectId !== projectId) throw new ChatError('essa conversa é de outro projeto');
  }

  /** A conversa tem transcript na pasta do próprio projeto (não vale a de outra pasta, como a de worktree: essa a ficha do projeto é que prova). */
  async hasOwnTranscript(projectId: string, sessionId: string): Promise<boolean> {
    // Os dois viram nome de arquivo e de pasta: só id, nunca caminho (nem `..`).
    if (![projectId, sessionId].every((s) => /^[\w.-]+$/.test(s) && !/^\.+$/.test(s))) return false;
    return fs.access(path.join(this.opts.transcriptsDir, projectId, `${sessionId}.jsonl`)).then(() => true, () => false);
  }

  /** O histórico do Codex da conversa pode ser lido pelo projeto? Aberta aqui, vale o projeto com que abriu; fechada, a prova é `sessionInProject`. */
  private async codexSessionOf(projectId: string, sessionId: string): Promise<boolean> {
    const open = this.chats.get(sessionId);
    if (open?.projectId) return open.projectId === projectId;
    return this.opts.sessionInProject ? this.opts.sessionInProject(projectId, sessionId) : true;
  }

  /** O trabalho atual desta conversa foi pedido por outro funcionário (ver `send`)? */
  isDelegated(sessionId: string): boolean {
    return this.delegated.has(sessionId);
  }

  /** Pids dos processos abertos pelo Claudio’s Club (não contam como "aberto em outro lugar"). */
  ownPids(): Set<number> {
    return new Set([...this.chats.values()].map((c) => c.pid).filter((p): p is number => p !== null));
  }

  async snapshot(projectId: string, sessionId: string): Promise<ChatSnapshot> {
    const chat = this.chats.get(sessionId);
    // Itens, `seq` e corte saem da mesma foto, num passo síncrono (nenhum `await` entre eles): o histórico vai até onde estes
    // itens começam e a tela abre o stream depois deste `seq`. O que chegar (ou sair da memória) durante as leituras abaixo
    // não se perde: os itens já estão aqui, e os eventos novos vêm no stream.
    const live = chat?.running ? chat.snapshot() : null;
    const cut = live && chat && !this.forks.has(sessionId) ? chat.cut : null;
    let file = await findTranscript(this.opts.transcriptsDir, projectId, sessionId);
    // Cópia recém-duplicada: o Claude Code só grava o transcript dela na primeira mensagem; até lá,
    // o histórico é o da original.
    const source = this.forks.get(sessionId);
    if (source && !(await fs.access(file).then(() => true, () => false))) file = await findTranscript(this.opts.transcriptsDir, projectId, source);
    // Com processo aberto, o histórico vai até o início dele; o resto vem em `live`. Se a conversa já passou do limite de itens
    // do processo (ver MAX_LIVE_ITEMS), `live` só tem os mais recentes: o histórico vai até onde eles começam.
    const before = live && !source ? (cut?.before ?? chat!.startedAt) : undefined;
    // Sem transcript do Claude, a conversa é do Codex: o histórico vem do rollout dele (ver adapters/codex/rollout.ts).
    const claude = await fs.access(file).then(() => true, () => false);
    const codex = claude || !(await this.codexSessionOf(projectId, sessionId)) ? null : await codexHistoryOf(this.runDir, sessionId, { before }).catch(() => null);
    const read = codex ?? (await readHistory(file, { before }));
    const { context } = read;
    // Os ids do rollout não são os do vivo (`a:<ordinal>` x `a:<execução>:<id>`): a mesma resposta pode estar nos dois lados da emenda.
    const items = codex && cut && live ? dropSeamEchoes(read.items, live.items) : read.items;
    // O histórico é só o fim do transcript (MAX_ITEMS itens, TAIL_BYTES do arquivo): se não chega ao item mais antigo que saiu
    // da conversa ao vivo, um aviso no topo diz que o resto está no arquivo.
    const older = cut && (await this.historyStopsShort(items, cut.oldest, claude ? file : null)) ? [olderInFile()] : [];
    // Sem processo (fechou por inatividade, ou o servidor reiniciou), o aviso de limite de uso não tem onde viver:
    // volta da pendência guardada, com a mesma hora e o mesmo botão.
    const waiting = live ? null : await this.opts.autoContinue?.get(sessionId);
    const wake = live ? null : await this.opts.wakeups?.get(sessionId);
    const retry = live ? null : await this.opts.retries?.get(sessionId);
    return {
      sessionId,
      history: [
        ...older,
        ...items,
        ...(waiting ? [this.waitingNotice(waiting)] : []),
        ...(wake?.projectId === projectId ? [this.waitingWake(wake)] : []),
        ...(retry?.retry && retry.projectId === projectId ? [this.waitingRetry(retry, retry.retry)] : []),
      ],
      live,
      context,
      elsewhere: await this.elsewhere(sessionId).then((o) => o && { pid: o.pid, entrypoint: o.entrypoint, status: o.status, orphan: o.orphan }),
      commands: this.commands.get(projectId) ?? [],
      copy: await this.copyOf(sessionId),
      ...(this.overrides.has(sessionId) && { fallback: this.overrides.get(sessionId) }),
    };
  }

  /**
   * O histórico lido pode estar cortado no começo (o limite de itens, ou o arquivo passa do trecho lido) e o primeiro item dele
   * não vai até o mais antigo que saiu da conversa ao vivo (`oldest`)? Então há mensagens que só o arquivo tem.
   */
  private async historyStopsShort(items: ChatItem[], oldest: string, file: string | null): Promise<boolean> {
    const bigFile = file ? ((await fs.stat(file).catch(() => null))?.size ?? 0) > TAIL_BYTES : false;
    if (items.length < MAX_ITEMS && !bigFile) return false;
    const first = items[0]?.at ?? null;
    return !first || first >= oldest;
  }

  /** Comandos "/" do projeto vistos na última sessão aberta (o menu funciona antes de abrir outra). */
  commandsFor(projectId: string): ChatCommand[] {
    return this.commands.get(projectId) ?? [];
  }

  /** "Voltar até aqui": desfaz as edições de arquivo feitas desde a mensagem `uuid`. */
  async rewind(projectId: string, sessionId: string, staffId: string | null, uuid: string, dryRun: boolean): Promise<RewindPreview> {
    const chat = await this.ensure(projectId, sessionId, staffId);
    try {
      const r = await chat.rewind(uuid, dryRun);
      return {
        canRewind: r.canRewind !== false,
        files: Array.isArray(r.filesChanged) ? r.filesChanged.filter((f): f is string => typeof f === 'string') : [],
        insertions: typeof r.insertions === 'number' ? r.insertions : 0,
        deletions: typeof r.deletions === 'number' ? r.deletions : 0,
        ...(typeof r.error === 'string' && { error: r.error }),
      };
    } catch (err) {
      return { canRewind: false, files: [], insertions: 0, deletions: 0, error: (err as Error).message };
    }
  }

  /**
   * Duplica a conversa: uma sessão nova com o histórico desta, para tentar outro caminho sem
   * perder a original. Devolve a sessão nova.
   */
  private async readCopies(): Promise<Record<string, string>> {
    if (!this.copies) {
      const raw = this.opts.copiesFile ? await fs.readFile(this.opts.copiesFile, 'utf8').catch(() => '{}') : '{}';
      try {
        this.copies = JSON.parse(raw) as Record<string, string>;
      } catch {
        this.copies = {};
      }
    }
    return this.copies;
  }

  /** A cópia trazida para cá desta conversa (a mais nova, se a cópia também foi trazida); null se não há. */
  async copyOf(sessionId: string): Promise<string | null> {
    const copies = await this.readCopies();
    let id = sessionId;
    const seen = new Set<string>();
    while (copies[id] && !seen.has(id)) {
      seen.add(id);
      id = copies[id]!;
    }
    return id === sessionId ? null : id;
  }

  /**
   * "Trazer" uma conversa aberta em outro lugar (app, terminal): a cópia aqui, com o histórico. Já trazida antes,
   * volta para a mesma cópia em vez de criar outra; a original segue lá, sem sincronizar.
   */
  async bring(projectId: string, sessionId: string, staffId: string | null): Promise<string> {
    const existing = await this.copyOf(sessionId);
    if (existing) return existing;
    const copy = await this.fork(projectId, sessionId, staffId);
    const copies = await this.readCopies();
    copies[sessionId] = copy;
    if (this.opts.copiesFile) {
      await fs.mkdir(path.dirname(this.opts.copiesFile), { recursive: true });
      await writeAtomic(this.opts.copiesFile, JSON.stringify(copies, null, 2) + '\n');
    }
    return copy;
  }

  async fork(projectId: string, sessionId: string, staffId: string | null): Promise<string> {
    const chat = await this.ensure(projectId, null, staffId, sessionId);
    this.forks.set(chat.sessionId, sessionId);
    return chat.sessionId;
  }

  /**
   * Dá um nome à conversa. Aberta, pelo próprio Claude Code; fechada, a mesma linha que o /rename
   * grava, no fim do transcript (sem abrir processo só para isso).
   */
  async rename(projectId: string, sessionId: string, title: string): Promise<void> {
    const chat = this.chats.get(sessionId);
    if (chat?.running) return chat.rename(title);
    const file = await findTranscript(this.opts.transcriptsDir, projectId, sessionId);
    if (!(await fs.access(file).then(() => true, () => false))) throw new ChatError('a conversa ainda não tem histórico para renomear');
    await fs.appendFile(file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }) + '\n');
  }

  /** Servidores MCP da conversa aberta (abre se preciso). */
  async mcp(projectId: string, sessionId: string, staffId: string | null): Promise<ChatMcp[]> {
    return (await this.ensure(projectId, sessionId, staffId)).mcpStatus();
  }

  async mcpToggle(projectId: string, sessionId: string, staffId: string | null, name: string, enabled: boolean): Promise<void> {
    await (await this.ensure(projectId, sessionId, staffId)).mcpToggle(name, enabled);
  }

  /** Para um agent ou comando em segundo plano de uma conversa aberta. */
  async stopTask(sessionId: string, taskId: string): Promise<void> {
    const chat = this.chats.get(sessionId);
    if (!chat?.running) throw new ChatError('a conversa não está aberta');
    await chat.stopTask(taskId);
  }

  /**
   * Manda uma mensagem, abrindo o processo se preciso. `sessionId` null = sessão nova da ficha.
   * `priority` só conta com o funcionário trabalhando; `images` são data URLs (prints colados).
   * `delegated`: quem mandou foi outro funcionário (pela API), não você pelo Claudio’s Club. `origin`: o carimbo de quem
   * mandou (ver server/chat/origin.ts); sem ele, a marca genérica.
   * `engineOverride`: conversa nova no motor/modelo secundário (vale para a conversa inteira). Numa sessão já aberta, vale o que
   * ela guardou; o que vier aqui é ignorado.
   * `reviewOnly`: conversa nova de revisão de tarefa, que não edita arquivos do projeto (ver `StaffService.chatSpawn`); a ficha guarda e
   * reabrir mantém, então só a abertura precisa dizer.
   */
  async send(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    text: string,
    priority?: SendPriority,
    images: string[] = [],
    files: ChatAttachment[] = [],
    delegated = false,
    origin?: string,
    engineOverride?: EngineOverride,
    reviewOnly = false,
    consult?: ConsultStamp,
    place?: Worktree,
  ): Promise<string> {
    return this.deliver(projectId, sessionId, staffId, text, priority, images, files, delegated, false, origin, engineOverride, undefined, reviewOnly, consult, place);
  }

  /**
   * O "continue" que o Claudio’s Club manda sozinho quando o limite de uso volta. Vai pelo mesmo caminho de
   * `send` (acorda a conversa se estiver fechada), mas não cancela o que está agendado: foi ele que agendou.
   */
  async continueChat(projectId: string, sessionId: string, staffId: string | null): Promise<void> {
    await this.deliver(projectId, sessionId, staffId, CONTINUE_TEXT, undefined, [], [], this.delegated.has(sessionId), true);
  }

  /**
   * Aviso da plataforma numa conversa que já existe (o pedido de cancelamento ao responsável de uma tarefa). Vai pelo caminho de `send` (acorda a
   * conversa se estiver fechada e entra no meio do turno, se houver), mas como o "continue": não é "você respondeu" (a tarefa em revisão não volta
   * para fazendo) e não tira o que estava agendado na conversa (o "continue" do limite, a retomada automática).
   */
  async sendNotice(projectId: string, sessionId: string, staffId: string | null, text: string): Promise<string> {
    return this.deliver(projectId, sessionId, staffId, text, 'next', [], [], this.delegated.has(sessionId), true);
  }

  /**
   * Na hora marcada, a retomada de um turno que falhou (ver `turnEnded`): manda o texto fixo pelo mesmo caminho do envio normal, acordando a
   * conversa se estiver fechada. Não cancela o "continue" do limite nem o despertador, e não abre orçamento novo (é uma mensagem da plataforma).
   * Antes de escrever na conversa confere de novo, de forma síncrona, que nada a invalidou no meio do envio (Parar, interrupção, mensagem,
   * teto, reinício): se invalidou, desiste sem escrever. Conversa que já voltou a trabalhar por outro caminho não recebe segunda mensagem.
   */
  async retryChat(p: Pending): Promise<void> {
    const gen = this.retryGen.get(p.sessionId) ?? 0;
    const still = () => !!this.opts.retries?.current(p) && (this.retryGen.get(p.sessionId) ?? 0) === gen;
    if (!still()) throw new ChatError('a retomada foi cancelada');
    if (this.isBusy(p.sessionId)) return;
    await this.deliver(p.projectId, p.sessionId, p.staffId, p.text ?? RETRY_TEXT, undefined, [], [], this.delegated.has(p.sessionId), true, undefined, undefined, still);
  }

  /**
   * Retoma depois do reinício: a conversa estava no meio de um turno quando o servidor saiu. Reabre com a ficha e
   * manda o aviso (ver resume.ts). Não mexe no "continue" nem no despertador agendados: são de outra fila.
   */
  async resumeChat(entry: ResumeEntry): Promise<void> {
    try {
      const sid = await this.deliver(entry.projectId, entry.sessionId, entry.staffId, resumeText(entry.hadPending), undefined, [], [], false, true);
      this.chats.get(sid)?.addNotice('Retomada após o reinício do Claudio’s Club.');
      // O turno já voltou por aqui: a retomada por falha passageira que ainda estivesse marcada mandaria um segundo "continue".
      await this.opts.retries?.cancel(sid, 'resume');
    } catch (err) {
      // Se a conversa chegou a abrir, o aviso fica nela; senão, só o log de quem chamou.
      this.chats.get(entry.sessionId)?.addNotice(`Não retomada após o reinício: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      throw err;
    }
  }

  /**
   * O botão Cancelar do aviso de limite de uso: devolve se havia algo agendado. Pendência de outro projeto
   * não é desta rota: devolve null (a rota responde 404) e não mexe nela.
   */
  async cancelAutoContinue(projectId: string, sessionId: string): Promise<boolean | null> {
    const auto = this.opts.autoContinue;
    if (!auto) return false;
    const pending = await auto.get(sessionId);
    if (pending && pending.projectId !== projectId) return null;
    return auto.cancel(sessionId, 'user');
  }

  /**
   * Despertador: "me chame de novo nesta conversa daqui a `seconds` segundos com esta mensagem". Uma por conversa (a nova
   * troca a anterior, e o aviso na conversa troca a hora). Só vale para conversa aberta aqui e do projeto: do contrário
   * devolve null (a rota responde 404). Devolve a hora marcada (ms). Depois de `WAKE_MAX_STREAK` despertadores seguidos
   * sem mensagem do usuário, recusa (`WakeStreakError`): quem acorda a si mesmo sem fim precisa pedir ao usuário.
   */
  async scheduleWake(projectId: string, sessionId: string, input: WakeInput): Promise<{ at: number } | null> {
    const wakeups = this.opts.wakeups;
    const chat = this.chats.get(sessionId);
    if (!wakeups || !chat?.running || chat.projectId !== projectId) return null;
    if ((this.wakeStreak.get(sessionId) ?? 0) >= WAKE_MAX_STREAK) throw new WakeStreakError();
    const at = this.now() + input.seconds * 1000;
    const pending: Pending = { projectId, sessionId, staffId: chat.staffId, at, resetsAt: at, text: input.text, ...(chat.engine === 'codex' && { engine: 'codex' as const }) };
    await wakeups.schedule(pending);
    this.showWake(pending);
    return { at };
  }

  /**
   * Cancela o despertador da conversa (o botão do aviso, ou o próprio funcionário): devolve se havia algo marcado.
   * Pendência de outro projeto não é desta rota: devolve null (404) e não mexe nela.
   */
  async cancelWake(projectId: string, sessionId: string, by: 'user' | 'staff'): Promise<boolean | null> {
    const wakeups = this.opts.wakeups;
    if (!wakeups) return false;
    const pending = await wakeups.get(sessionId);
    if (pending && pending.projectId !== projectId) return null;
    return wakeups.cancel(sessionId, by);
  }

  /**
   * Agendamentos pendentes de um projeto (a tela central): os despertadores e os "continue" do limite de uso, do que
   * vence primeiro ao último. Sem o agendador configurado, aquele tipo vem vazio.
   */
  async listSchedules(projectId: string): Promise<Array<{ kind: 'wake' | 'continue'; sessionId: string; staffId: string | null; at: string; text: string }>> {
    const wakes = ((await this.opts.wakeups?.list()) ?? []).filter((p) => p.projectId === projectId);
    const continues = ((await this.opts.autoContinue?.list()) ?? []).filter((p) => p.projectId === projectId);
    const items = [
      ...wakes.map((p) => ({ kind: 'wake' as const, sessionId: p.sessionId, staffId: p.staffId, at: p.at, text: p.text ?? '' })),
      ...continues.map((p) => ({ kind: 'continue' as const, sessionId: p.sessionId, staffId: p.staffId, at: p.at, text: CONTINUE_TEXT })),
    ];
    return items.sort((a, b) => a.at - b.at).map((i) => ({ ...i, at: new Date(i.at).toISOString() }));
  }

  /**
   * Na hora marcada: a mensagem do despertador vai pelo mesmo caminho do envio normal (fila se a conversa estiver
   * ocupada, reabre com a ficha se estiver fechada). Não cancela o "continue" do limite de uso agendado, nem o contrário.
   */
  async wakeChat(p: Pending): Promise<void> {
    if (!p.text) throw new ChatError('o despertador está sem mensagem');
    await this.deliver(p.projectId, p.sessionId, p.staffId, p.text, 'later', [], [], this.delegated.has(p.sessionId), true);
    this.wakeStreak.set(p.sessionId, (this.wakeStreak.get(p.sessionId) ?? 0) + 1);
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Recusa entrega nova enquanto o servidor reinicia (antes de abrir processo, para não deixar conversa pela metade). */
  private assertOpen(): void {
    if (this.shuttingDown) throw new ChatClosingError();
  }

  /**
   * Manda a mensagem (ver `deliverNow`) e, enquanto ela está a caminho, conta a conversa como viva (`turnAlive`): abrir o processo leva segundos, e nesse meio tempo a conversa ainda
   * não aparece como aberta nem trabalhando. Sem isso, a conferência de "parou no meio" (`restartCut`) lê um transcript com a ação sem resultado e segura uma conversa que está voltando.
   */
  private async deliver(projectId: string, sessionId: string | null, ...rest: DeliverRest): Promise<string> {
    if (!sessionId) return this.deliverNow(projectId, sessionId, ...rest);
    this.sending.set(sessionId, (this.sending.get(sessionId) ?? 0) + 1);
    try {
      return await this.deliverNow(projectId, sessionId, ...rest);
    } finally {
      const left = (this.sending.get(sessionId) ?? 1) - 1;
      if (left > 0) this.sending.set(sessionId, left);
      else this.sending.delete(sessionId);
    }
  }

  private async deliverNow(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    text: string,
    priority: SendPriority | undefined,
    images: string[],
    files: ChatAttachment[],
    delegated: boolean,
    auto: boolean,
    origin?: string,
    engineOverride?: EngineOverride,
    /** A retomada automática passa aqui: devolve falso se algo a invalidou (ver `retryChat`); conferido antes de abrir a conversa e antes de escrever nela. */
    guard?: () => boolean,
    reviewOnly = false,
    consult?: ConsultStamp,
    place?: Worktree,
  ): Promise<string> {
    this.assertOpen();
    // Antes de qualquer mudança de estado (a retomada abaixo, o que `ensure` abre): a conversa aberta de outro projeto não é desta chamada.
    this.assertSameProject(projectId, sessionId);
    // Mensagem que não é da plataforma abre turno original novo: a retomada em voo (decidindo, ou no meio do envio) deixa de valer já, de forma
    // síncrona. A pendência e o orçamento só saem quando a mensagem entra (abaixo): se a conversa não abrir, a retomada marcada segue valendo.
    if (!auto && sessionId) this.voidRetry(sessionId);
    if (guard && !guard()) throw new ChatError('a retomada foi cancelada');
    const chat = await this.ensure(projectId, sessionId, staffId, undefined, engineOverride, reviewOnly, consult, place);
    // Qualquer mensagem sua (ou de outro funcionário) na conversa vale mais que o "continue" agendado.
    if (!auto) {
      this.dropRetry(chat.sessionId, 'message'); // conversa nova: o id só existe agora
      await this.opts.autoContinue?.cancel(chat.sessionId, 'message');
      await this.opts.retries?.cancel(chat.sessionId, 'message');
      this.wakeStreak.delete(chat.sessionId); // alguém falou: a conta dos despertadores seguidos recomeça
    }
    if (delegated) this.delegated.add(chat.sessionId);
    else this.delegated.delete(chat.sessionId);
    this.inbox.setQuestion(chat.sessionId, null); // respondeu (ou mandou outra coisa): a pergunta sai da caixa
    this.inbox.setTurnCap(chat.sessionId, null); // turno novo: o aviso do teto (caixa e tarefa) já não vale
    if (!auto) this.engineStops.delete(chat.sessionId); // e o erro do motor do turno de antes (o "continue" da plataforma não o apaga: a conversa segue parada)
    this.inbox.forgetErrors(chat.sessionId); // e a dispensa do erro e do teto de antes junto
    // A ficha mudou depois que esta conversa começou: o aviso vai junto, uma vez só. Conversa grande:
    // o funcionário fica sabendo do tamanho e do custo (ele não vê isso sozinho).
    const ficha = this.fichaNotices.get(chat.sessionId);
    this.fichaNotices.delete(chat.sessionId);
    const used = chat.contextUsed;
    const big = used !== null && used >= NOTICE_AT ? contextNotice(used, chat.model, CONTEXT_NOTICE, chat.fast) : null;
    const boost = await this.applyBoost(chat);
    // Último passo assíncrono: daqui até o `send` nada espera, então a conferência vale para a escrita.
    if (guard && !guard()) throw new ChatError('a retomada foi cancelada');
    // "continue" e despertador são da plataforma, mesmo na conversa delegada: só a mensagem do colega leva a marca.
    const fromStaff = delegated && !auto;
    const notice = [fromStaff ? (origin ?? STAFF_NOTICE) : null, ficha, big, boost].filter(Boolean).join('\n\n') || undefined;
    chat.send(text, priority, images, notice, files, fromStaff);
    // Mensagem da plataforma (continue, despertador, retomada) não é "você respondeu": a tarefa em revisão não se mexe.
    if (!auto) this.opts.onSent?.(chat.sessionId);
    return chat.sessionId;
  }

  /**
   * Folga de cota (ver server/quotaBoost.ts), conferida a cada mensagem: começou, a conversa vai para
   * o Opus em esforço máximo; acabou, volta ao modelo e ao esforço com que abriu. Devolve o aviso para
   * o funcionário (os agents também mudam de esforço), só na troca. Se você trocou o modelo ou o
   * esforço à mão nesta conversa (ou a conversa abriu com uma escolha gravada), vale a sua escolha.
   */
  private async applyBoost(chat: ChatProcess): Promise<string | null> {
    // A folga de cota é do Claude (Opus em esforço máximo): numa conversa do Codex nunca troca o modelo.
    if (chat.engine === 'codex') return null;
    const state = this.boosts.get(chat);
    if (state === 'manual' || !this.opts.quotaBoost) return null;
    const boost = await this.opts.quotaBoost().catch(() => null);
    if (boost && !state) {
      this.boosts.set(chat, 'on');
      const end = boostEnd(boost.until);
      chat.setModel('opus', `Folga de cota até ${end}: esta conversa vai no Opus, em esforço máximo, e os agents pensam mais. Volta sozinho quando a folga acabar.`);
      chat.setEffort('max', '');
      return `${BOOST_NOTICE} até ${end}: esta conversa está no Opus, em esforço máximo. Ao chamar agents, passe effort: "xhigh" para o revisor e o pesquisador e effort: "medium" para o executor.`;
    }
    if (!boost && state === 'on') {
      this.boosts.delete(chat);
      const base = this.launched.get(chat);
      chat.setModel(base?.model ?? 'default', 'A folga de cota acabou: esta conversa voltou ao modelo e ao esforço de antes.');
      // Sem esforço na linha de comando, o padrão do Claude Code (alto).
      chat.setEffort(base?.effort ?? 'high', '');
      return `${BOOST_NOTICE} acabou: esta conversa voltou ao modelo e ao esforço de antes. Chame os agents sem effort (vale o de cada um).`;
    }
    return null;
  }

  /**
   * A sua mensagem, digitada no Claudio’s Club. Se o funcionário fechou o assunto (ponto de corte) numa
   * conversa grande, ou o cache já esfriou, ela segue numa conversa nova: lê só a ficha e a memória,
   * em vez de reler tudo. A anterior continua na lista, e um aviso conta o que aconteceu.
   */
  async sendFromUser(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    text: string,
    priority?: SendPriority,
    images: string[] = [],
    files: ChatAttachment[] = [],
  ): Promise<string> {
    this.assertOpen();
    const info = sessionId ? this.turns.get(sessionId) : undefined;
    const open = sessionId ? this.chats.get(sessionId) : undefined;
    if (sessionId && staffId && info && !open?.busy && !(await this.opts.keepSession?.(sessionId))) {
      const policy = (await this.opts.contextSwitch?.()) ?? 'suggest';
      if (switchDecision(info, Date.now(), policy) === 'switch') {
        const fresh = await this.ensure(projectId, null, staffId);
        // A mensagem foi para outra conversa: o "continue" agendado na anterior não vale mais.
        await this.opts.autoContinue?.cancel(sessionId, 'message');
        // Desviou uma vez: se você voltar à anterior pela lista, a mensagem fica nela.
        this.turns.delete(sessionId);
        const cost = rereadUsd(info.used!, info.model, info.fast);
        const reread = cost === null ? '' : ` Cada chamada ao modelo relia tudo (${usd(cost)}).`;
        fresh.addNotice(
          `Seguiu numa conversa nova: a anterior tinha ${kTokens(info.used!)} e o assunto dela tinha fechado.${reread} Esta começa só com a ficha e a memória, que leva o essencial. A anterior continua na lista de conversas: voltando a ela, a mensagem fica lá.`,
        );
        this.log(`${sessionId}: ponto de corte com ${kTokens(info.used!)}; a mensagem seguiu em ${fresh.sessionId}`);
        return this.send(projectId, fresh.sessionId, staffId, text, priority, images, files);
      }
    }
    return this.send(projectId, sessionId, staffId, text, priority, images, files);
  }

  /**
   * Aviso de desfecho de tarefa (entregue, ou a revisão terminou) para o gestor que pediu, na conversa dele.
   * Mesma regra da sua mensagem (ver sendFromUser): conversa grande com o assunto fechado, ou acima do teto,
   * segue numa conversa nova. Desfechos seguintes que caem numa conversa desviada vão para a mesma nova
   * (`requesterRedirects`, seguindo a cadeia). A anterior continua na lista; não cancela nada nela.
   */
  async sendToRequester(projectId: string, sessionId: string | null, staffId: string | null, text: string): Promise<string> {
    this.assertOpen();
    let target = sessionId;
    while (target && this.requesterRedirects.has(target)) target = this.requesterRedirects.get(target)!;
    const info = target ? this.turns.get(target) : undefined;
    const open = target ? this.chats.get(target) : undefined;
    if (target && staffId && info && !open?.busy && !(await this.opts.keepSession?.(target))) {
      // Continue do limite ou despertador pendente: o gestor ainda está acompanhando algo nela.
      const waiting = !!(await this.opts.autoContinue?.get(target)) || !!(await this.opts.wakeups?.get(target));
      const policy = (await this.opts.contextSwitch?.()) ?? 'suggest';
      const closed = policy === 'auto' && switchDecision(info, this.now(), 'auto') === 'switch';
      const ceiling = policy === 'auto' && info.used !== null && info.used >= CEILING_AT;
      if (!waiting && (closed || ceiling)) {
        const fresh = await this.ensure(projectId, null, staffId);
        this.requesterRedirects.set(target, fresh.sessionId);
        const used = info.used!;
        const cost = rereadUsd(used, info.model, info.fast);
        const reread = cost === null ? '' : ` Cada chamada ao modelo relia tudo (${usd(cost)}).`;
        const why = closed ? 'o assunto dela tinha fechado' : `passou do teto de ${kTokens(CEILING_AT)} sem fechar o assunto`;
        fresh.addNotice(
          `Seguiu numa conversa nova: o aviso desta tarefa não entrou na anterior, que tinha ${kTokens(used)} e ${why}.${reread} Esta começa só com a ficha e a memória. A anterior continua na lista de conversas.`,
        );
        this.log(`${target}: aviso da tarefa seguiu em ${fresh.sessionId} (a anterior tinha ${kTokens(used)})`);
        return this.send(projectId, fresh.sessionId, staffId, text, 'later');
      }
    }
    return this.send(projectId, target, staffId, text, 'later');
  }

  /**
   * Fim de um turno: guarda o tamanho e o ponto de corte para decidir a próxima mensagem, e avisa
   * você quando não troca sozinho (o ajuste está em "sugerir", ou a conversa passou do teto sem
   * fechar o assunto).
   */
  private async noteTurn(sessionId: string) {
    const chat = this.chats.get(sessionId);
    if (!chat) return;
    const prev = this.turns.get(sessionId);
    const info = { at: Date.now(), used: chat.contextUsed, checkpoint: chat.checkpoint, model: chat.model, ttl: chat.cacheTtl, fast: chat.fast, ceilingNoted: prev?.ceilingNoted };
    this.turns.set(sessionId, info);
    if (info.used === null || this.delegated.has(sessionId)) return;
    const policy = (await this.opts.contextSwitch?.()) ?? 'suggest';
    if (policy === 'off') return;
    // Sem preço conhecido para o modelo, o aviso fala só do tamanho: nada de valor estimado.
    const usdCost = rereadUsd(info.used, info.model, info.fast);
    const cost = usdCost === null ? null : usd(usdCost);
    if (switchDecision(info, info.at, policy) === 'suggest') {
      chat.addNotice(`Assunto fechado, com ${kTokens(info.used)} de contexto${cost ? ` (cada chamada ao modelo relê tudo: ${cost})` : ''}: a próxima pergunta sai mais barata numa conversa nova (o + ao lado da lista de conversas), que começa só com a ficha e a memória.`);
    } else if (!info.checkpoint && info.used >= CEILING_AT) {
      // Uma vez a cada 100k a mais: avisar a cada resposta seria só barulho.
      const step = Math.floor(info.used / 100_000);
      if ((info.ceilingNoted ?? 0) < step) {
        info.ceilingNoted = step;
        chat.addNotice(`Esta conversa tem ${kTokens(info.used)}${cost ? `: cada chamada ao modelo relê tudo (${cost})` : ''}. Quando o assunto fechar, o funcionário registra na memória e a próxima mensagem segue numa conversa nova.`, 'warn');
      }
    }
  }

  /** O modo de permissão da conversa mudou: o MCP de git (se a conversa tem) confere o novo na próxima chamada (ver gitMcp.ts, `git-policy.json`). */
  private gitMode(sessionId: string, mode: string): void {
    const autonomy = (Object.keys(CLI_MODE) as Autonomy[]).find((a) => CLI_MODE[a] === mode);
    if (autonomy) void updateGitPolicyAutonomy(path.join(this.runDir, sessionId), autonomy).catch(() => {});
  }

  /**
   * A ficha mudou: a autonomia vale já nas conversas abertas dela; o resto (modelo, MCPs,
   * ferramentas) só com o processo reaberto, o que acontece na próxima mensagem com o funcionário
   * parado. O texto da ficha fica gravado no prompt de sistema da conversa até o /compact: a
   * próxima mensagem de cada conversa dela leva um aviso para reler o arquivo.
   */
  profileChanged(prev: StaffProfile, next: StaffProfile, fichaPath: string | null = null) {
    const restart = JSON.stringify(launchFields(prev)) !== JSON.stringify(launchFields(next));
    if (restart) {
      const where = fichaPath ? `em ${fichaPath}` : 'no arquivo da sua ficha';
      const notice = `${FICHA_NOTICE} Releia-a agora (${where}) e siga a versão do arquivo daqui em diante.`;
      for (const { id } of next.sessions) this.fichaNotices.set(id, notice);
    }
    for (const { id } of next.sessions) {
      const chat = this.chats.get(id);
      if (!chat?.running) continue;
      if (restart) chat.stale = true;
      const mode = CLI_MODE[next.autonomy];
      if (prev.autonomy !== next.autonomy || (chat.permissionMode && chat.permissionMode !== mode)) {
        this.gitMode(id, mode);
        chat.setPermissionMode(mode, `Autonomia agora: ${AUTONOMY_NAME[next.autonomy]}`);
      }
    }
  }

  /**
   * A memória pessoal mudou: as conversas abertas dessas fichas (todas as cópias da pessoa) reabrem com o prompt novo
   * na próxima mensagem, com o funcionário parado (mesmo caminho do `stale` da ficha). Sem aviso no chat: o texto vai no prompt.
   */
  personChanged(sessionIds: string[]) {
    for (const id of sessionIds) {
      const chat = this.chats.get(id);
      if (chat?.running) chat.stale = true;
    }
  }

  async compact(projectId: string, sessionId: string, staffId: string | null) {
    (await this.ensure(projectId, sessionId, staffId)).compact();
  }

  /**
   * Responde um pedido de permissão. `executeAs` ("Aprovar e executar" no cartão de plano): depois
   * de aprovar, o processo troca para essa autonomia, já que o fim do modo plano cai em "pede tudo".
   */
  /**
   * Ajustes na conversa, sem editar a ficha e sem reabrir: modelo, esforço e autonomia. Abre o
   * processo se preciso (conversa nova também); devolve a sessão.
   */
  async settings(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    s: { model?: string; effort?: string; autonomy?: Autonomy },
  ): Promise<string> {
    // Conversa no secundário: o modelo e o esforço são os dele. Trocar aqui gravaria na ficha uma escolha que o secundário não usa.
    if (sessionId && (s.model || s.effort) && this.overrides.has(sessionId)) {
      throw new ChatError('Esta conversa roda no motor secundário: o modelo e o esforço são os dele e não mudam aqui.');
    }
    const chat = await this.ensure(projectId, sessionId, staffId);
    if (s.effort === 'ultra' && chat.engine !== 'codex') throw new ChatError('O esforço ultra só existe no Codex');
    // Escolha sua nesta conversa: a folga de cota não troca nem desfaz mais (até o processo reabrir).
    if (s.model || s.effort) this.boosts.set(chat, 'manual');
    if (s.model) chat.setModel(s.model, `Modelo desta conversa: ${s.model}`);
    if (s.effort) chat.setEffort(s.effort, `Esforço desta conversa: ${s.effort}`);
    if (s.autonomy) {
      this.gitMode(chat.sessionId, CLI_MODE[s.autonomy]);
      chat.setPermissionMode(CLI_MODE[s.autonomy], `Autonomia desta conversa: ${AUTONOMY_NAME[s.autonomy]}`);
    }
    // Fica na ficha para a conversa reabrir assim; falha ao gravar não desfaz a troca já feita.
    if (staffId && (s.model || s.effort)) {
      try {
        await this.opts.rememberChoice?.(projectId, staffId, chat.sessionId, { model: s.model, effort: s.effort });
      } catch (err) {
        this.log(`${chat.sessionId}: não consegui gravar o modelo/esforço na ficha: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return chat.sessionId;
  }

  /** Há pedido (permissão ou pergunta) com este id sem resposta nesta conversa. */
  hasPending(sessionId: string, requestId: string): boolean {
    return this.chats.get(sessionId)?.hasPending(requestId) ?? false;
  }

  /** Responde um pedido. Só com o pedido pendente é que os ganchos rodam (`by`: quem responde; padrão, você). */
  answer(
    sessionId: string,
    requestId: string,
    allow: boolean,
    opts: { message?: string; executeAs?: Autonomy; reject?: boolean; remember?: Remember; answers?: QuestionAnswers; annotations?: QuestionAnnotations; by?: 'manager' | 'user' } = {},
  ): boolean {
    const chat = this.chats.get(sessionId);
    const pending = chat?.pendingPermissions().find((p) => p.id === `p:${requestId}`);
    const plan = pending?.plan;
    const asked = pending?.questions;
    // Recusar um plano é de vez: o texto que o funcionário lê é fixo (não vai o que foi digitado na tela).
    const rejectPlan = !allow && !!opts.reject && plan !== undefined;
    const message = rejectPlan ? PLAN_REJECTED_MESSAGE : opts.message;
    if (!chat?.answer(requestId, allow, message, opts.remember, { answers: opts.answers, annotations: opts.annotations })) return false;
    if (allow && opts.executeAs) {
      this.gitMode(sessionId, CLI_MODE[opts.executeAs]);
      chat.setPermissionMode(CLI_MODE[opts.executeAs], `Executando como: ${AUTONOMY_NAME[opts.executeAs]}`);
    }
    if (allow && plan !== undefined) this.opts.onPlanApproved?.(sessionId, plan);
    if (rejectPlan) this.opts.onPlanRejected?.(sessionId);
    else if (!allow && plan !== undefined) this.opts.onPlanDenied?.(sessionId, requestId);
    if (asked) this.opts.onAskAnswered?.(sessionId, requestId, opts.by ?? 'user', askSummary(asked, allow, opts.answers));
    return true;
  }

  /**
   * O que espera você nas conversas abertas no Claudio’s Club: pedidos de permissão sem resposta (o plano
   * pronto entre eles) e conversas que pararam com erro (fora o que você já dispensou, ver `dismissError`).
   */
  attention(): Array<{ sessionId: string; pending: Array<Extract<ChatItem, { kind: 'permission' }>>; error: string | null }> {
    const out: Array<{ sessionId: string; pending: Array<Extract<ChatItem, { kind: 'permission' }>>; error: string | null }> = [];
    for (const [sessionId, chat] of this.chats) {
      const pending = chat.running ? chat.pendingPermissions() : [];
      const error = chat.error && !this.inbox.isErrorDismissed(`error:${sessionId}`, this.errorAt.get(sessionId) ?? '') ? chat.error : null;
      if (pending.length || error) out.push({ sessionId, pending, error });
    }
    return out;
  }

  /**
   * O pedido de permissão mais antigo que a conversa espera de você (ferramenta e desde quando), ou null. Só leitura do processo, nada gravado.
   * Pergunta com opções não entra: o gestor a responde (ver `onAsk`). O Codex não tem esse cartão (a sandbox decide), então nunca devolve nada.
   */
  permissionWaitOf(sessionId: string): { tool: string; since: string } | null {
    const chat = this.chats.get(sessionId);
    if (!chat?.running) return null;
    const first = chat.pendingPermissions().find((p) => !p.questions && p.at);
    return first ? { tool: first.tool, since: first.at! } : null;
  }

  /**
   * "Ignorar" num alerta de erro da caixa: `error:<sessão>` (a conversa parou com erro) ou `cap:<sessão>` (o turno parou no teto).
   * O carimbo guardado é o da ocorrência de agora, lido aqui (não o que a tela diz): outro erro ou outro teto da conversa volta a avisar.
   * Sem alerta ali (a tela está velha), não há o que dispensar.
   */
  dismissError(id: string): boolean {
    const m = /^(error|cap):(.+)$/.exec(id);
    if (!m) return false;
    const sessionId = m[2]!;
    const at = m[1] === 'cap' ? this.inbox.turnCaps().find((c) => c.sessionId === sessionId)?.at : this.chats.get(sessionId)?.error ? (this.errorAt.get(sessionId) ?? '') : undefined;
    if (at === undefined) return false;
    this.inbox.dismissError(id, at);
    return true;
  }

  /** A conversa está aberta no Claudio’s Club e no meio de um turno (ou esperando uma aprovação). */
  isBusy(sessionId: string): boolean {
    const chat = this.chats.get(sessionId);
    return !!chat?.running && chat.busy;
  }

  /** A conversa está aberta e no meio de um turno ou com algo em segundo plano (o "trabalhando" que decide o `onIdle`). */
  isWorking(sessionId: string): boolean {
    const chat = this.chats.get(sessionId);
    return !!chat?.running && chat.working;
  }

  /**
   * O que a conversa tem em andamento agora: o turno (`busy`) e o que roda em segundo plano, com o que o Claude Code listou (`background_tasks_changed`; o `background` do Codex é a lista dos
   * subagents e já sai vazia no fim do turno). null = conversa fechada. A tarefa lê no fim do turno para não entregar trabalho que continua (ver `TaskService.holdBackground`).
   */
  liveWork(sessionId: string): { busy: boolean; background: BackgroundTask[] } | null {
    const chat = this.chats.get(sessionId);
    return chat?.running ? { busy: chat.busy, background: [...chat.background] } : null;
  }

  /** Conversas do Codex com uma execução em andamento (o processo da mensagem; entre as mensagens não há). Ver a CodexCapability. */
  codexRunning(): string[] {
    return [...this.chats.values()].filter((c) => c.running && c.engine === 'codex' && c.pid !== null).map((c) => c.sessionId);
  }

  /**
   * As conversas do Codex abertas, como sessões vivas. O Codex não grava ~/.claude/sessions, então sem isto o quadro não mostra o
   * "trabalhando" delas. `claude` são as sessões do adapter: o que já está lá (pelo id) fica de fora, para não duplicar.
   * `pid`: o processo da execução em andamento; 0 entre as mensagens (o Codex não mantém processo aberto entre elas).
   */
  codexLive(claude: LiveSession[]): LiveSession[] {
    const known = new Set(claude.map((s) => s.sessionId));
    const out: LiveSession[] = [];
    for (const c of this.chats.values()) {
      if (!c.running || c.engine !== 'codex' || known.has(c.sessionId)) continue;
      out.push({
        sessionId: c.sessionId,
        pid: c.pid ?? 0,
        cwd: c.cwd,
        name: null,
        status: c.working ? 'busy' : 'idle',
        alive: true,
        entrypoint: null,
        kind: null,
        startedAt: c.startedAt,
        statusUpdatedAt: new Date(c.lastActivity).toISOString(),
      });
    }
    return out;
  }

  /** Conversas paradas numa pergunta para você, para a caixa "precisa de mim". */
  pendingQuestions(): Array<{ sessionId: string; text: string; at: string; itemId?: string }> {
    return this.inbox.questions();
  }

  /** "Ok, vi": a pergunta sai da caixa sem você responder. */
  dismissQuestion(sessionId: string): boolean {
    const had = this.inbox.questions().some((q) => q.sessionId === sessionId);
    this.inbox.setQuestion(sessionId, null);
    return had;
  }

  /**
   * O turno terminou: se a resposta acaba perguntando algo, fica na caixa até você responder.
   * Conversa delegada fica de fora: quem pediu (o gestor) recebe a entrega e responde.
   */
  private noteQuestion(sessionId: string) {
    const last = this.delegated.has(sessionId) ? null : (this.chats.get(sessionId)?.lastAssistant() ?? null);
    const q = finalQuestion(last?.text ?? null);
    this.inbox.setQuestion(sessionId, q && last ? { text: q, at: new Date().toISOString(), itemId: last.id } : null);
  }

  /** Segredos que apareceram nas conversas, para a caixa "precisa de mim". */
  secretHits() {
    return [...this.secrets];
  }

  /**
   * "Já troquei" tira o aviso (se o segredo aparecer de novo, volta). "Não é segredo" (`notSecret`)
   * tira e não avisa mais daquela ocorrência (aquele valor, nesta conversa): era um exemplo, um teste, um valor público.
   * Outra ocorrência do mesmo tipo (outro valor) avisa de novo. Sem o aviso na lista (a tela está velha), não há ocorrência a dispensar.
   */
  dismissSecret(id: string, notSecret = false): boolean {
    const i = this.secrets.findIndex((s) => s.id === id);
    if (i === -1) return notSecret;
    if (notSecret) this.inbox.mute(`${id}#${this.secrets[i]!.occurrence}`);
    this.secrets.splice(i, 1);
    return true;
  }

  /** As ações barradas nas conversas de tarefa, para a caixa "precisa de mim" (ver `noteDenied`). */
  deniedHits() {
    return [...this.denied].map(([sessionId, d]) => ({ sessionId, ...d }));
  }

  /** "Ignorar" no alerta de ação barrada (`denied:<sessão>:<turno>`): o alerta sai e o resto daquele turno não o traz de volta. Sem o alerta ali (a tela está velha), não há o que dispensar. */
  dismissDenied(id: string): boolean {
    for (const [sessionId, d] of this.denied) {
      if (d.id !== id) continue;
      this.denied.delete(sessionId);
      this.deniedIgnored.set(sessionId, d.turn);
      return true;
    }
    return false;
  }

  /**
   * Uma ferramenta de uma conversa foi barrada por uma regra de permissão. Conversa de tarefa gera um alerta por turno: as negações seguintes do mesmo turno só entram na
   * conta (e trocam o que o alerta mostra se forem de mais peso); um turno novo com negação troca o alerta inteiro (o mais recente é o que vale, sem enxurrada).
   * A tarefa é lida antes e a gravação não espera nada depois (duas negações juntas não abrem dois alertas).
   */
  private async noteDenied(sessionId: string, turn: string, d: DeniedInfo) {
    if (this.deniedIgnored.get(sessionId) === turn) return;
    const task = await this.opts.denialTask?.(sessionId);
    if (!task || this.deniedIgnored.get(sessionId) === turn) return;
    const prev = this.denied.get(sessionId);
    if (prev?.turn === turn) {
      prev.count += 1;
      if (!prev.tools.includes(d.tool) && prev.tools.length < DENIED_TOOLS_MAX) prev.tools.push(d.tool);
      if (denialWeight(d.layer) > denialWeight(prev.shown.layer)) prev.shown = d;
      return;
    }
    this.denied.set(sessionId, { id: `denied:${sessionId}:${turn}`, turn, taskId: task.taskId, taskTitle: task.title, shown: d, count: 1, tools: [d.tool], at: new Date().toISOString() });
    this.log(`${sessionId}: ${d.tool} barrado (${d.layer}) na tarefa ${task.taskId} (aviso na caixa)`);
  }

  /** As conversas de tarefa que rodam sem a fila de validação pesada por causa do `hooks.json` da conta, para a caixa "precisa de mim" (ver `noteGuardOff`). */
  guardOffHits() {
    return [...this.guardOff].map(([sessionId, g]) => ({ sessionId, ...g }));
  }

  /** "Ignorar" no alerta da fila desligada (`guardoff:<sessão>`): o alerta sai e a conversa não o traz de volta (só um arquivo que some e volta, ou um reinício). Sem o alerta ali (a tela está velha), não há o que dispensar. */
  dismissGuardOff(id: string): boolean {
    for (const [sessionId, g] of this.guardOff) {
      if (g.id !== id) continue;
      this.guardOff.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * O Codex de uma conversa passou a rodar sem a fila de validação pesada (`file` = o `hooks.json` da conta) ou voltou a ter a fila (null). Conversa de tarefa leva o aviso ao lugar
   * onde alguém o vê: a nota da tarefa (uma vez por conversa, mesmo depois de reinício) e a caixa; o aviso do chat o processo já deu. O processo chama uma vez por mudança, não por
   * execução. A tarefa é lida depois (o item só entra se a conversa ainda está sem a fila) e falha de leitura não derruba nada.
   */
  private async noteGuardOff(sessionId: string, file: string | null) {
    if (!file) {
      this.guardOffNow.delete(sessionId);
      this.guardOff.delete(sessionId);
      return;
    }
    this.guardOffNow.add(sessionId);
    const task = await this.opts.heavyGuardOff?.(sessionId);
    if (!task || !this.guardOffNow.has(sessionId)) return;
    this.guardOff.set(sessionId, { id: `guardoff:${sessionId}`, taskId: task.taskId, taskTitle: task.title, file, at: new Date().toISOString() });
    this.log(`${sessionId}: fila de validação pesada desligada (hooks.json na conta) na tarefa ${task.taskId} (aviso na caixa e na tarefa)`);
  }

  /**
   * O segredo veio da saída de um comando que leu arquivos sem apontar um só (`origin.command`): descobre qual arquivo do projeto o tem e o põe no aviso
   * (`file` relativo ao projeto, `cwd` a raiz do projeto, e a `line`). Roda depois de o aviso entrar, sem atrasar o stream; só preenche aviso que ainda existe,
   * é da mesma ocorrência e continua sem arquivo. Nunca lança nem registra o valor: o log leva só o caminho.
   */
  private async locateSecret(sessionId: string, id: string, hit: ClassifiedSecret, origin: { command: string; cwd: string; projectId: string }) {
    try {
      const projectDir = await this.opts.projectDirOf?.(origin.projectId);
      if (!projectDir) return;
      const found = await locateSecretFile({ command: origin.command, cwd: origin.cwd, projectDir, occurrence: hit.occurrence, kind: hit.kind, pepper: this.inbox.pepper() });
      const entry = this.secrets.find((s) => s.id === id && s.occurrence === hit.occurrence);
      if (!found || !entry || entry.file) return;
      entry.file = found.file;
      entry.cwd = projectDir;
      if (found.line) entry.line = found.line;
      this.log(`${sessionId}: ${hit.label}: arquivo ${JSON.stringify(found.file)}${found.line ? ` (linha ${found.line})` : ''}`);
    } catch {
      // achar o arquivo é um extra: o aviso já está na caixa sem ele
    }
  }

  private noteSecret(sessionId: string, hit: ClassifiedSecret, source?: SecretSource, file?: { path: string; cwd: string }, origin?: { command: string; cwd: string; projectId: string }) {
    const { label } = hit;
    const id = `${sessionId}:${label}`;
    // "Não é segredo" de antes valia para o rótulo todo (`id`, ou o rótulo da versão anterior: ver legacyLabel) e continua valendo; o de agora é por ocorrência.
    const old = legacyLabel(label);
    const muted = this.inbox.isMuted(id) || (old !== null && this.inbox.isMuted(`${sessionId}:${old}`)) || this.inbox.isMuted(`${id}#${hit.occurrence}`);
    if (muted) return;
    const entry = {
      id,
      sessionId,
      label,
      kind: hit.kind,
      ...(hit.detail && { detail: hit.detail }),
      verdict: hit.verdict,
      reason: hit.reason,
      ...(hit.hint && { hint: hit.hint }),
      occurrence: hit.occurrence,
      ...(source && { source }),
      ...(file && { file: file.path, cwd: file.cwd }),
      at: new Date().toISOString(),
    };
    const i = this.secrets.findIndex((s) => s.id === id);
    if (i === -1) {
      this.secrets.push(entry);
      this.log(`${sessionId}: ${label} apareceu na conversa (aviso na caixa)`);
    } else if (worseVerdict(hit.verdict, this.secrets[i]!.verdict)) {
      // Um aviso por conversa e tipo (id acima): fica o da primeira ocorrência (com o arquivo dela), mas sobe de gravidade se vier uma mais grave.
      this.secrets[i] = entry;
      this.log(`${sessionId}: ${label} voltou mais grave (${hit.verdict})`);
    } else {
      return;
    }
    if (origin && !file) void this.locateSecret(sessionId, id, hit, origin);
  }

  /** Última resposta da conversa aberta no Claudio’s Club (para o aviso "terminou"); null se não for daqui. */
  lastAssistantText(sessionId: string): string | null {
    return this.chats.get(sessionId)?.lastAssistantText() ?? null;
  }

  /** O pid dessa sessão foi conferido e é de outro processo (o sistema o reaproveitou): não é conversa, por mais "viva" que o arquivo diga. */
  isReusedPid(l: Pick<LiveSession, 'pid' | 'startedAt'>): boolean {
    return this.reusedPids.has(`${l.pid}:${l.startedAt ?? ''}`);
  }

  /** Processos do Claudio’s Club de antes de um reinício do servidor, ainda vivos (ver `adopt`). */
  async orphans(live: LiveSession[]): Promise<Array<{ sessionId: string; pid: number; status: string | null }>> {
    const registry = this.opts.registry;
    if (!registry) return [];
    const alive = this.opts.isAlive ?? isAlive;
    const out: Array<{ sessionId: string; pid: number; status: string | null }> = [];
    for (const rec of Object.values(await registry.read())) {
      // Registro de antes do boot: o pid dele (e o do servidor que o gravou) já é de outro processo; `cleanOrphans` o tira do arquivo.
      if (startedBeforeBoot(rec.startedAt) || rec.server === process.pid || alive(rec.server)) continue;
      const s = live.find((l) => l.pid === rec.pid && l.sessionId === rec.sessionId && l.alive && !this.isReusedPid(l));
      if (s) out.push({ sessionId: rec.sessionId, pid: rec.pid, status: s.status });
    }
    return out;
  }

  /**
   * O turno da conversa estourou o teto (ferramentas ou minutos). Antes da interrupção: guarda o motivo (a tarefa lê ao
   * terminar o turno, ver tasks.ts) e tira o "continue" e o despertador, para ela não retomar sozinha.
   */
  private turnCapped(sessionId: string, hit: TurnCapHit): void {
    this.inbox.setTurnCap(sessionId, { ...hit, at: new Date().toISOString() });
    this.log(
      `${sessionId}: ${
        hit.kind === 'restart'
          ? `não retomada: o reinício cortou "${hit.action}"`
          : hit.kind === 'retry' || hit.kind === 'engine'
            ? `não retomada sozinha: ${capReason(hit)}`
            : `turno parado pelo teto (${hit.kind === 'tools' ? 'ferramentas' : 'minutos'}, limite ${hit.limit})`
      }`,
    );
    this.voidRetry(sessionId);
    void this.opts.autoContinue?.cancel(sessionId, 'cap').catch(() => {});
    void this.opts.wakeups?.cancel(sessionId, 'cap').catch(() => {});
    void this.opts.retries?.cancel(sessionId, 'cap').catch(() => {});
  }

  /**
   * O reinício cortou a conversa numa ação com efeito fora do projeto (ver cutAction.ts): ela não volta sozinha. Fica na caixa
   * como o teto (e a tarefa vai para Aguardar) até você mandar mensagem nova.
   */
  holdCut(sessionId: string, action: string): TurnCapHit {
    const hit: TurnCapHit = { kind: 'restart', action };
    this.turnCapped(sessionId, hit);
    return hit;
  }

  /**
   * Conversa de tarefa que parou sem o servidor ter fechado direito (queda): a última ação, no transcript, ficou sem resultado
   * e mexe fora do projeto? Então segura (ver `holdCut`) e devolve o motivo; senão, null (a tarefa retoma como sempre).
   */
  async restartCut(projectId: string, sessionId: string): Promise<TurnCapHit | null> {
    // Conversa com turno vivo (ou com mensagem abrindo o processo) não parou no meio de nada: o transcript dela sempre mostra a ferramenta em andamento sem resultado.
    if (this.turnAlive(sessionId)) return null;
    const { history } = await this.snapshot(projectId, sessionId);
    const action = await this.cutOf(projectId, sessionId, history, false);
    // O turno pode ter voltado enquanto o transcript era lido: conferido de novo, de forma síncrona, antes de segurar a conversa (`holdCut` cancela a retomada e o "continue").
    return action && !this.turnAlive(sessionId) ? this.holdCut(sessionId, action) : null;
  }

  /** A conversa tem turno vivo: aberta e no meio de um turno (ou com algo em segundo plano), ou com uma mensagem a caminho que ainda abre o processo (ver `deliver`). */
  private turnAlive(sessionId: string): boolean {
    const chat = this.chats.get(sessionId);
    return !!(chat?.running && chat.working) || (this.sending.get(sessionId) ?? 0) > 0;
  }

  /**
   * A ação com efeito fora do projeto que o corte deixou pela metade nestes itens (ver `externalCutWithAgents`): o subagent cortado que
   * só mexeu no projeto não conta. Os subagents do Claude ficam ao lado do transcript; o Codex não tem essa pasta (conservador).
   * `background`: o que ainda rodava em segundo plano quando o processo caiu (só o Claude confere, ver `externalBackground`; no Codex, qualquer
   * tarefa dessas é incerta). O que sobrar incerto sai como "em segundo plano: <rótulo>", antes das ferramentas sem resultado.
   */
  private async cutOf(projectId: string | null, sessionId: string, items: readonly ChatItem[], awaitingAnswer: boolean, background: readonly BackgroundTask[] = [], engine: 'claude' | 'codex' = 'claude'): Promise<string | null> {
    // Sem projeto (conversa sem ficha) não há onde achar o transcript: os subagents ficam sem conferência (conservador).
    const dir = projectId ? subagentsDirOf(await findTranscript(this.opts.transcriptsDir, projectId, sessionId)) : null;
    const open = engine === 'claude' ? await externalBackground(background, items, dir) : (background[0] ?? null);
    if (open) return `em segundo plano: ${open.label}`;
    return externalCutWithAgents(items, awaitingAnswer, dir);
  }

  /** O motivo do teto desta conversa, se o turno dela parou nele e ninguém mandou mensagem depois. */
  turnCapOf(sessionId: string): TurnCapHit | null {
    return this.inbox.turnCapOf(sessionId);
  }

  /** As conversas que pararam no teto (a caixa de entrada lê daqui), fora as que você dispensou (`turnCapOf` segue contando, é o estado da tarefa). */
  turnCaps(): Array<TurnCapHit & { sessionId: string; at: string }> {
    return this.inbox.turnCaps().filter((c) => !this.inbox.isErrorDismissed(`cap:${c.sessionId}`, c.at));
  }

  interrupt(sessionId: string) {
    // Primeiro a retomada (a conversa pode estar fechada à espera dela, e o `interrupt` do processo lança sem processo aberto).
    this.dropRetry(sessionId, 'user');
    this.chats.get(sessionId)?.interrupt();
  }

  /**
   * Nega os pedidos que a conversa ainda espera de você (o plano pronto, uma permissão, uma pergunta), sem acionar os ganchos de tarefa
   * (plano recusado, pergunta respondida): a tarefa foi cancelada e a interrupção do turno não tira o cartão, então aprovar o plano depois
   * deixaria o funcionário seguir para a execução. Devolve quantos foram negados.
   */
  dismissPending(sessionId: string, message: string): number {
    const chat = this.chats.get(sessionId);
    let n = 0;
    for (const p of chat?.pendingPermissions() ?? []) {
      try {
        if (chat?.answer(p.id.replace(/^p:/, ''), false, message)) n++;
      } catch {
        // o processo já saiu: o pedido caiu junto
      }
    }
    return n;
  }

  /**
   * Alguma conversa aberta deste funcionário, neste projeto, está trabalhando (fora `exceptSession`). A mesma ficha
   * em outro projeto não conta: cada projeto tem o seu funcionário.
   */
  staffWorking(projectId: string, staffId: string, exceptSession?: string | readonly string[]): boolean {
    return this.anyStaffChat(projectId, staffId, exceptSession, (c) => c.working);
  }

  /**
   * Como `staffWorking`, mas só com turno em andamento (ou pedido sem resposta): a conversa parada que deixou algo em segundo plano não conta. É o "ocupado" que o quadro mostra;
   * quem segura a fila continua sendo `staffWorking`.
   */
  staffTurning(projectId: string, staffId: string, exceptSession?: string | readonly string[]): boolean {
    return this.anyStaffChat(projectId, staffId, exceptSession, (c) => c.busy);
  }

  private anyStaffChat(projectId: string, staffId: string, exceptSession: string | readonly string[] | undefined, active: (c: ChatProcess) => boolean): boolean {
    const except = typeof exceptSession === 'string' ? [exceptSession] : (exceptSession ?? []);
    for (const c of this.chats.values()) {
      // A conversa de consulta de outro projeto roda em paralelo (só lê): não segura a fila do funcionário.
      if (c.running && c.projectId === projectId && c.staffId === staffId && !except.includes(c.sessionId) && !this.consultSessions.has(c.sessionId) && active(c)) return true;
    }
    return false;
  }

  /** A conversa é de consulta de outro projeto (server/consult/)? Só vale para as abertas neste servidor; o registro das consultas guarda o resto. */
  isConsultSession(sessionId: string): boolean {
    return this.consultSessions.has(sessionId);
  }

  /** O id da consulta de uma conversa aberta aqui (ou undefined). */
  consultIdOf(sessionId: string): string | undefined {
    return this.consultSessions.get(sessionId);
  }

  /** Esta conversa de consulta terminou o turno com erro do motor (login recusado, erro que não passa sozinho)? Ou parada no limite de uso, esperando o "continue"? */
  async consultTurn(sessionId: string): Promise<{ failed: boolean; waiting: boolean }> {
    const waiting = await this.awaitingLimit(sessionId);
    return { failed: !!this.engineStopOf(sessionId), waiting };
  }

  /** Quantas conversas, em todos os projetos, estão trabalhando agora (o teto do gate de recursos conta isto). */
  activeTurns(): number {
    let n = 0;
    for (const c of this.chats.values()) if (c.running && c.working) n++;
    return n;
  }

  /** A conversa deste funcionário, neste projeto, que está no meio de um turno agora, se for uma só (senão, null). */
  workingSession(projectId: string, staffId: string): string | null {
    const busy = [...this.chats.values()].filter((c) => c.running && c.projectId === projectId && c.staffId === staffId && c.busy && !this.consultSessions.has(c.sessionId));
    return busy.length === 1 ? busy[0]!.sessionId : null;
  }

  /** Quantas conversas abertas estão no meio de um turno ou com algo em segundo plano. */
  working(): { busy: number; background: number } {
    let busy = 0;
    let background = 0;
    for (const c of this.chats.values()) {
      if (!c.running) continue;
      if (c.busy) busy++;
      else if (c.background.length) background++;
    }
    return { busy, background };
  }

  /**
   * O servidor vai sair para reiniciar: nenhuma entrega nova entra (mensagem sua, de outro funcionário, "continue",
   * despertador, tarefa). As que já estão no meio do turno seguem até o snapshot (ver `busySessions`).
   */
  closing(): void {
    this.shuttingDown = true;
  }

  /** O servidor já está fechando para reiniciar (ver `closing`). */
  isClosing(): boolean {
    return this.shuttingDown;
  }

  /** Conversas abertas no meio de um turno (ou com pedido pendente), com o que o reinício precisa para reabri-las. */
  async busySessions(): Promise<ResumeEntry[]> {
    const out: Array<Promise<ResumeEntry>> = [];
    for (const c of this.chats.values()) {
      if (!c.running || !c.busy || !c.projectId) continue;
      // O estado de cada conversa é lido já, antes de qualquer espera (a conferência do subagent lê arquivo).
      const { projectId, sessionId, staffId, engine, cwd, awaitingAnswer: hadPending } = c;
      const items = c.snapshot().items;
      // `cut`: a ação com efeito fora do projeto que o fechamento vai cortar no meio (ver cutAction.ts); com ela, a conversa não volta sozinha.
      // Com pedido de permissão pendente, a ferramenta que espera a permissão não rodou: não conta (ver externalCut).
      out.push(this.cutOf(projectId, sessionId, items, hadPending).then((cut) => ({ projectId, sessionId, staffId, engine, cwd, hadPending, ...(cut && { cut }) })));
    }
    return Promise.all(out);
  }

  /** Conversas com processo aberto, em turno ou ociosas (a exclusão da retenção não mexe nelas). */
  runningSessionIds(): string[] {
    return [...this.chats.values()].filter((c) => c.running).map((c) => c.sessionId);
  }

  /** Fecha todas as conversas e espera os processos saírem (o Claudio’s Club vai parar ou reiniciar). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.chats.values()].map((c) => c.stopAndWait()));
  }

  stop(sessionId: string) {
    this.dropRetry(sessionId, 'user');
    this.chats.get(sessionId)?.stop();
  }

  /**
   * Você fecha uma conversa para liberar memória: encerra o processo e os filhos dele (MCPs), pelo mesmo `stop` do `reap`, e a sessão continua
   * no disco. Não mexe em despertador, "continue" nem ajuste guardado: o que estava agendado reabre a conversa quando chegar a hora.
   * Parada: fecha. Trabalhando (turno, pedido sem resposta ou algo em segundo plano): sem `confirm` recusa (`working`); com ele, confere a ação
   * cortada como o reinício (ver `cutOf`, `closeBlock`): efeito incerto também recusa (`uncertain`, com a ação). Conferido, a tarefa de trabalho
   * dela vai para Aguardar antes de o processo sair (`beforeClose`) e o processo sai como fechamento nosso (sem erro "saiu com código 1").
   * Sem processo aberto, não há o que fechar (`closed: false`, sem erro).
   */
  async close(sessionId: string, opts: { confirm?: boolean } = {}): Promise<CloseResult> {
    const chat = this.chats.get(sessionId);
    if (!chat?.running) return { closed: false, interrupted: false };
    if (chat.working) {
      if (!opts.confirm) throw new CloseRefusedError('working', 'a conversa está trabalhando: fechar corta o turno em andamento; confirme para fechar');
      const action = await this.closeBlock(chat);
      if (action) throw new CloseRefusedError('uncertain', `não fechei: matar agora poderia cortar uma ação que mexe fora do projeto (${action}); espere terminar ou confira antes`, action);
    }
    // Lido depois da conferência (que espera disco): o turno pode ter acabado nesse meio-tempo, e aí nada é cortado.
    if (!chat.running) return { closed: false, interrupted: false };
    const interrupted = chat.working;
    if (interrupted) await Promise.resolve(this.opts.beforeClose?.(sessionId)).catch(() => {});
    await this.closeProcess(chat);
    this.log(`${sessionId}: fechada por você${interrupted ? ' (estava trabalhando)' : ''}`);
    return { closed: true, interrupted };
  }

  /**
   * O que arquivar fecha (rota /api/archive; `kind` e `id` como no `ArchiveRequest`): uma conversa, ou uma sessão sem ficha, fecha o processo dela com a regra de
   * `close` (trabalhando sem `confirm` ou com efeito incerto recusa, e quem chama não arquiva); `staff:<id>` (funcionário) e projeto fecham só as conversas
   * paradas deles, e as que trabalham seguem abertas. Devolve quantas fechou e quantas deixou trabalhando.
   */
  async closeForArchive(req: { kind: 'project' | 'session' | 'conversation'; id: string }, confirm?: boolean): Promise<{ closed: number; working: number }> {
    if (req.kind === 'project') return this.closeIdle((c) => c.projectId === req.id);
    if (req.kind === 'session' && req.id.startsWith('staff:')) {
      const staffId = req.id.slice('staff:'.length);
      return this.closeIdle((c) => c.staffId === staffId);
    }
    const result = await this.close(req.id, { confirm });
    return { closed: result.closed ? 1 : 0, working: 0 };
  }

  /**
   * Fecha as conversas paradas que `match` escolhe: as que trabalham seguem abertas, sem recusa. Devolve quantas fechou e quantas deixou trabalhando.
   */
  async closeIdle(match: (c: { sessionId: string; projectId: string | null; staffId: string | null }) => boolean): Promise<{ closed: number; working: number }> {
    const mine = [...this.chats.values()].filter((c) => c.running && match({ sessionId: c.sessionId, projectId: c.projectId, staffId: c.staffId }));
    const idle = mine.filter((c) => !c.working);
    const results = await Promise.all(idle.map((c) => this.closeProcess(c).then(() => true, () => false)));
    return { closed: results.filter(Boolean).length, working: mine.length - idle.length };
  }

  /** `stopAndWait` com teto: o processo que não sai a tempo vira erro (a conversa não fechou), em vez de a rota esperar para sempre. */
  private async closeProcess(chat: ChatProcess): Promise<void> {
    const wait = this.opts.closeWaitMs ?? CLOSE_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ChatError('a conversa não fechou a tempo; tente de novo')), wait);
    });
    try {
      await Promise.race([chat.stopAndWait(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * O que impede fechar já uma conversa que trabalha, mesmo confirmado: algo em segundo plano (agent ou comando que morreria junto, e do qual
   * não se sabe o efeito) ou a ação com efeito fora do projeto que o turno deixaria pela metade (a mesma conferência do reinício, inclusive os
   * subagents). Erro ao conferir conta como incerto. Devolve o resumo da ação, ou null se pode fechar.
   */
  private async closeBlock(chat: ChatProcess): Promise<string | null> {
    const bg = chat.background[0];
    if (bg) return `em segundo plano: ${bg.label}`;
    return this.cutOf(chat.projectId, chat.sessionId, chat.snapshot().items, chat.awaitingAnswer).catch(() => 'uma ação que não deu para conferir');
  }

  /**
   * O SSE de uma aba segue a sessão, não o processo: quando a conversa reabre (fechou por
   * inatividade, a ficha mudou, o claude saiu), quem está ouvindo passa para o processo novo.
   */
  subscribe(sessionId: string, after: number, listener: Listener): (() => void) | null {
    const chat = this.chats.get(sessionId);
    if (!chat) return null;
    let subs = this.streams.get(sessionId);
    if (!subs) this.streams.set(sessionId, (subs = new Map()));
    subs.set(listener, chat.subscribe(listener, after));
    return () => {
      subs.get(listener)?.();
      subs.delete(listener);
      if (!subs.size && this.streams.get(sessionId) === subs) this.streams.delete(sessionId);
    };
  }

  private async ensure(projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string, engineOverride?: EngineOverride, reviewOnly = false, consult?: ConsultStamp, place?: Worktree): Promise<ChatProcess> {
    this.assertSameProject(projectId, sessionId);
    const existing = sessionId ? this.chats.get(sessionId) : undefined;
    // Ficha nova só reabre com tudo parado: agents em segundo plano morreriam com o processo.
    if (existing?.running && !(existing.stale && !existing.working)) return existing;
    if (existing?.running) await existing.stopAndWait(); // reabre com a ficha nova
    if (sessionId) {
      const other = await this.elsewhere(sessionId);
      // Órfão do próprio Claudio’s Club: ninguém mais fala com ele, então mandar mensagem já é o "Trazer".
      if (other?.orphan) {
        this.log(`${sessionId}: retomada aqui, encerrando processo órfão do Claudio’s Club (pid ${other.pid}, ${other.status ?? 'sem status'})`);
        await this.endProcess(sessionId, other.target);
      } else if (other) {
        this.log(`${sessionId} bloqueada: aberta em ${other.orphan ? 'processo órfão do Claudio’s Club' : (other.entrypoint ?? '?')} (pid ${other.pid})`);
        throw new ChatError(holdMessage(other));
      }
    }
    // Conversa já aberta no secundário segue nele (continue, respawn, reabrir); o pedido de uma conversa nova vale só para ela.
    const override = sessionId ? this.overrides.get(sessionId) : engineOverride;
    const spawn = await this.opts.resolve(projectId, sessionId, staffId, forkFrom, override, reviewOnly, consult, place);
    if (!spawn) throw new ChatError('funcionário ou projeto não encontrado');
    if (override) this.overrides.set(spawn.sessionId, override);
    // Consulta de outro projeto: marcada já, antes de o processo abrir (sem token, sem aprovação, fora da conta de trabalho do funcionário; ver `isConsultSession`).
    if (spawn.consult) this.consultSessions.set(spawn.sessionId, spawn.consult.id);
    // Claude ou Codex: o resto do manager fala com os dois do mesmo jeito (ver codexProcess.ts).
    const codex = spawn.engine === 'codex' ? spawn.codex : undefined;
    if (spawn.engine === 'codex' && !codex) throw new ChatError('a conversa do Codex veio sem os dados para abrir');
    if (codex) {
      try {
        this.opts.onCodexOpen?.();
      } catch {
        // a checagem prévia é aviso: nunca impede a conversa de abrir
      }
    }
    const model = codex ? codex.model : argOf(spawn.args, '--model');
    const effort = codex ? codex.effort : argOf(spawn.args, '--effort');
    const base: Omit<ChatProcessOptions, 'args'> = {
      sessionId: spawn.sessionId,
      projectId,
      staffId,
      cwd: spawn.cwd,
      model,
      effort,
      onUsage: (limits) => void this.saveUsage(spawn.sessionId, limits),
      onUsageLimit: (hit) => this.limitHit(spawn.sessionId, projectId, staffId, hit, codex ? 'codex' : 'claude'),
      secretPepper: this.inbox.pepper(),
      // Conversa no secundário não marca a ficha: o modelo que a conta recusou é o dele, não o da ficha.
      onModelUnavailable: (model) => {
        if (!override && staffId) this.modelUnavailable(spawn.sessionId, projectId, staffId, model, codex ? 'codex' : 'claude');
      },
      onTurnWithoutLimit: () => void this.limitStreak.delete(spawn.sessionId),
      onTurnEnd: (end) => this.turnEnded(spawn.sessionId, projectId, staffId, codex ? 'codex' : 'claude', end),
      onSecret: (hit, source, file, command) =>
        this.noteSecret(spawn.sessionId, hit, source, file ? { path: file, cwd: spawn.cwd } : undefined, command ? { command, cwd: spawn.cwd, projectId } : undefined),
      onDenied: (denied, turn) => void this.noteDenied(spawn.sessionId, turn, denied).catch(() => {}),
      // Só conversa de funcionário (com ficha): a sem ficha pede antes de agir e não é do quadro.
      onEdit: (files) => {
        if (!staffId) return;
        this.opts.onEdit?.({ sessionId: spawn.sessionId, projectId, staffId, engine: codex ? 'codex' : 'claude', cwd: spawn.cwd, files, request: this.chats.get(spawn.sessionId)?.lastUserText() ?? null });
      },
      onIdle: (reason) => {
        if (reason !== 'exit') this.noteQuestion(spawn.sessionId);
        if (reason === 'turn') void this.noteTurn(spawn.sessionId).catch(() => {});
        this.opts.onIdle?.(spawn.sessionId, projectId, staffId, reason, codex ? 'codex' : 'claude');
        if (spawn.consult) this.opts.onConsultIdle?.(spawn.consult.id, spawn.sessionId, reason);
      },
      onCommands: (commands) => this.commands.set(projectId, commands),
      turnCaps: this.opts.turnCaps,
      onTurnCap: (hit) => this.turnCapped(spawn.sessionId, hit),
      onAsk: (requestId, questions) => this.opts.onAsk?.(spawn.sessionId, requestId, questions),
      // O Codex não tem ExitPlanMode (a sandbox decide): o gancho só dispara no Claude, e `onPlan` confere o motor da conversa de novo.
      onPlan: (requestId, plan) => this.opts.onPlan?.(spawn.sessionId, requestId, plan),
      // Quem ela é para a API: o mesmo token em toda execução da conversa (o Codex abre uma por mensagem), regerado se o servidor reiniciou.
      // Consulta de outro projeto não recebe token: sem ele a conversa não alcança nenhuma rota (chat/send, tarefa, contratação, nova consulta). Um salto só.
      mycoToken: spawn.consult ? undefined : this.opts.tokens?.issue({ staffId, projectId, sessionId: spawn.sessionId, engine: codex ? 'codex' : 'claude' }),
      ...(spawn.consult && { denyPermissions: 'Conversa de consulta de outro projeto: só leitura da pasta do projeto, e nenhum pedido de permissão é aprovado.' }),
      onExit: (pid, error) => {
        this.log(`${spawn.sessionId} saiu (pid ${pid})${error ? `: ${error.slice(0, 200)}` : ''}`);
        if (error) this.errorAt.set(spawn.sessionId, new Date().toISOString());
        if (pid !== null) void this.opts.registry?.remove(spawn.sessionId, pid).catch(() => {});
      },
      spawnImpl: this.opts.spawnImpl,
      stopGraceMs: this.opts.stopGraceMs,
    };
    const chat = codex
      ? new CodexProcess({
          ...base,
          permissionMode: CLI_MODE[codex.autonomy],
          instructions: codex.instructions,
          writableRoots: codex.writableRoots,
          readOnlyPaths: codex.readOnlyPaths,
          sshMcp: codex.sshMcp,
          memoriaMcp: codex.memoriaMcp,
          gitMcp: codex.gitMcp,
          readOnly: codex.readOnly,
          consult: codex.consult,
          chromeMcp: codex.chromeMcp,
          cleanMcp: codex.cleanMcp,
          extraMcps: codex.extraMcps,
          mcpSnapshotFile: codex.mcpSnapshotFile,
          agents: codex.agents,
          heavyGuard: codex.heavyGuard,
          onHeavyGuard: (off) => void this.noteGuardOff(spawn.sessionId, off).catch(() => {}),
          onLog: (line) => this.log(`${spawn.sessionId}: ${line}`),
          secrets: codex.secrets,
          threadId: codex.threadId,
          threadFile: codex.threadFile,
          onThread: codex.onThread,
          onSandboxFailure: this.opts.onCodexSandboxFailure,
          onPasswordPolicyFailure: this.opts.onCodexPasswordPolicyFailure,
          mycoUrl: codex.mycoUrl,
          models: this.opts.codexModels,
          env: this.opts.codexEnv,
          internetAccess: codex.internetAccess,
          // Modelo do secundário: sem plano B (a conta recusa, a conversa mostra o erro).
          noSubstitute: !!override,
        })
      : new ChatProcess({ ...base, args: spawn.args });
    this.chats.set(spawn.sessionId, chat);
    // O aviso de limite de uso ficou no processo anterior (a pendência guardada recria o dele, logo abaixo).
    this.limitNotices.delete(spawn.sessionId);
    this.wakeNotices.delete(spawn.sessionId);
    this.launched.set(chat, { model, effort });
    // Escolha gravada (reabrir ou duplicar): vale a sua, a folga de cota não atropela. O mesmo no secundário (o modelo dele é o da conversa).
    if (spawn.chosen || override) this.boosts.set(chat, 'manual');
    // Abas já abertas nesta sessão passam a ouvir o processo novo, desde o começo dele.
    const subs = this.streams.get(spawn.sessionId);
    if (subs) for (const [listener, unsubscribe] of subs) {
      unsubscribe();
      subs.set(listener, chat.subscribe(listener, 0));
    }
    chat.start();
    this.log(`${spawn.sessionId} aberta (pid ${chat.pid ?? '?'})`);
    if (chat.pid !== null) {
      await this.opts.registry
        ?.add({ sessionId: spawn.sessionId, pid: chat.pid, server: process.pid, startedAt: chat.startedAt })
        .catch(() => {});
    }
    // Reabriu com o "continue" ainda agendado (o processo anterior fechou por inatividade, ou o servidor
    // reiniciou): o aviso volta com a hora guardada.
    const waiting = await this.opts.autoContinue?.get(spawn.sessionId);
    if (waiting) this.showLimit(waiting, true);
    // O mesmo vale para o despertador: o aviso volta com a hora guardada (a contagem continua de onde estava).
    const waitingWake = await this.opts.wakeups?.get(spawn.sessionId);
    if (waitingWake) this.showWake(waitingWake);
    // E a retomada de um turno que falhou, ainda marcada (a conversa fechou ou o servidor reiniciou enquanto esperava).
    const waitingRetry = await this.opts.retries?.get(spawn.sessionId);
    if (waitingRetry) this.showRetry(waitingRetry);
    return chat;
  }

  /**
   * Botão "Trazer para o Claudio’s Club". Processo órfão do próprio Claudio’s Club (o servidor que o abriu morreu, e
   * ninguém mais fala com ele): encerra para a conversa reabrir aqui. Aberta de verdade em outro
   * lugar (terminal, app do Claude): não mexe e diz onde fechar.
   */
  async adopt(sessionId: string): Promise<void> {
    const other = await this.elsewhere(sessionId);
    if (!other) return;
    if (!other.orphan) throw new ChatError(holdMessage(other));
    this.log(`${sessionId}: encerrando processo órfão do Claudio’s Club (pid ${other.pid}, ${other.status ?? 'sem status'})`);
    await this.endProcess(sessionId, other.target);
  }

  /**
   * Botão "Assumir aqui" (sessão aberta no app do Claude ou num terminal, não órfã). Encerra só a árvore
   * daquele processo, para a conversa seguir aqui. Trabalhando no meio do turno, recusa: encerrar
   * mataria o que ela está fazendo.
   */
  async takeOver(sessionId: string): Promise<void> {
    const other = await this.elsewhere(sessionId);
    if (!other) return;
    if (other.orphan) throw new ChatError(holdMessage(other));
    // Só com status conhecido de parada: sem status não dá para saber se ela está no meio do turno.
    if (other.status !== 'waiting' && other.status !== 'idle') {
      throw new ChatError(`a sessão está trabalhando agora (pid ${other.pid}): encerrar no meio do turno faria ela parar. Espere terminar e tente de novo`);
    }
    this.log(`${sessionId}: assumida aqui, encerrando o processo de ${other.entrypoint ?? '?'} (pid ${other.pid}, ${other.status ?? 'sem status'})`);
    await this.endProcess(sessionId, other.target);
  }

  /**
   * Antes de encerrar um pid vindo do registro ou do arquivo de sessão: confere que ele ainda é o processo da conversa (ver `confirmProcess`).
   * O sistema reaproveita pids (depois de reiniciar o PC, ou de o processo sair): o pid de outro processo não é tocado, só sai o registro
   * dele e a sessão deixa de contar como aberta em outro lugar. `unknown` (não deu para olhar): nada é encerrado nem apagado.
   */
  private async killVerified(sessionId: string, target: KillTarget): Promise<'killed' | 'skipped' | 'unknown'> {
    const identity = await confirmProcess(target.pid, target.startedAt, this.opts.inspectProcess);
    if (identity === 'unknown') return 'unknown';
    if (identity !== 'same') {
      this.log(`${sessionId}: pid ${target.pid} ${identity === 'gone' ? 'já saiu' : 'é de outro processo (o número foi reaproveitado)'}: nada encerrado, registro tirado`);
      this.reusedPids.add(target.key);
      await this.opts.registry?.remove(sessionId, target.pid).catch(() => {});
      return 'skipped';
    }
    await (this.opts.kill ?? killTree)(target.pid);
    return 'killed';
  }

  /** Encerra a árvore do processo (se for o da conversa), espera ele sair e tira o registro dele (se houver). */
  private async endProcess(sessionId: string, target: KillTarget): Promise<void> {
    const pid = target.pid;
    const verdict = await this.killVerified(sessionId, target);
    if (verdict === 'unknown') throw new ChatError(`não consegui conferir se o processo ${pid} é o da conversa: nada foi encerrado. Feche-o à mão`);
    if (verdict === 'skipped') return;
    const alive = this.opts.isAlive ?? isAlive;
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(pid)) throw new ChatError(`não consegui encerrar o processo ${pid}`);
    await this.opts.registry?.remove(sessionId, pid).catch(() => {});
  }

  /**
   * Na subida do servidor: órfãos parados (esperando você ou uma aprovação que nunca vai chegar)
   * são encerrados; os que estão trabalhando terminam o turno sozinhos e ficam para o "Trazer".
   */
  async cleanOrphans(): Promise<void> {
    const registry = this.opts.registry;
    if (!registry) return;
    const alive = this.opts.isAlive ?? isAlive;
    const live = await this.opts.listLive();
    for (const rec of Object.values(await registry.read())) {
      // De antes do boot do PC: o processo morreu junto, e os pids dele e do servidor que o abriu já podem ser de outros (por isso vem antes das conferências de pid).
      if (startedBeforeBoot(rec.startedAt)) {
        this.log(`${rec.sessionId}: registro de antes do boot do PC (pid ${rec.pid}) tirado, nenhum processo encerrado`);
        await registry.remove(rec.sessionId, rec.pid);
        continue;
      }
      if (rec.server === process.pid) continue;
      if (!alive(rec.pid)) {
        await registry.remove(rec.sessionId, rec.pid);
        continue;
      }
      if (alive(rec.server)) continue; // outro servidor do Claudio’s Club ainda cuida dele
      const s = live.find((l) => l.pid === rec.pid && l.sessionId === rec.sessionId);
      if (s && s.status !== 'busy') {
        const verdict = await this.killVerified(rec.sessionId, { pid: rec.pid, startedAt: rec.startedAt || s.startedAt, key: `${s.pid}:${s.startedAt ?? ''}` });
        if (verdict === 'unknown') continue;
        if (verdict === 'killed') {
          this.log(`${rec.sessionId}: processo órfão parado (pid ${rec.pid}, ${s.status ?? 'sem status'}) encerrado na subida`);
          await registry.remove(rec.sessionId, rec.pid);
        }
      }
    }
  }

  private async elsewhere(sessionId: string): Promise<Elsewhere | null> {
    const own = this.ownPids();
    const live = (await this.opts.listLive()).find((s) => s.sessionId === sessionId && s.alive && !own.has(s.pid) && !this.isReusedPid(s) && !startedBeforeBoot(s.startedAt));
    if (!live) return null;
    const rec = (await this.opts.registry?.read())?.[sessionId];
    const mine = !!rec && rec.pid === live.pid;
    if (mine && startedBeforeBoot(rec.startedAt)) return null; // registro de antes do boot: o pid é de outro processo
    // Aberto por um servidor do Claudio’s Club que já morreu: ninguém mais fala com esse processo.
    const orphan = mine && rec.server !== process.pid && !(this.opts.isAlive ?? isAlive)(rec.server);
    // A hora de criação que a conferência compara: a do registro (gravada no spawn) quando há, senão a do arquivo de sessão.
    return { pid: live.pid, entrypoint: live.entrypoint, status: live.status, orphan, target: { pid: live.pid, startedAt: (mine && rec.startedAt) || live.startedAt, key: `${live.pid}:${live.startedAt ?? ''}` } };
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(`[chat] ${l}`)))(line);
  }

  /**
   * O processo avisa o limite estourado logo antes de avisar o fim do turno, na mesma volta. Guardar a
   * promessa do agendamento aqui, de forma síncrona, é o que deixa `awaitingLimit` certo para quem
   * perguntar depois, venha o fim do turno antes ou depois de o agendamento terminar.
   */
  private limitHit(sessionId: string, projectId: string, staffId: string | null, hit: LimitHit, engine: 'claude' | 'codex' = 'claude') {
    const run = this.noteUsageLimit(sessionId, projectId, staffId, hit, engine).catch((err) => this.log(`${sessionId}: limite de uso: ${err instanceof Error ? err.message : String(err)}`));
    this.limitRuns.set(sessionId, run);
    void run.then(() => {
      if (this.limitRuns.get(sessionId) === run) this.limitRuns.delete(sessionId);
    });
    // Depois de guardar o agendamento: quem ouve pode esperar `settledLimit` e cancelar o "continue" sem corrida.
    for (const cb of this.limitListeners) cb({ sessionId, projectId, staffId, engine, hit });
  }

  /** O motor recusou o modelo da ficha: a marca vai para a ficha (ver `markModelObsolete`). Falha de gravação só vai para o log. */
  private modelUnavailable(sessionId: string, projectId: string, staffId: string, model: string, engine: 'claude' | 'codex') {
    void this.opts.markModelObsolete?.(projectId, staffId, model, engine).catch((err) => this.log(`${sessionId}: modelo obsoleto: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Quem quer saber do limite no meio do turno (ex.: a troca de motor de uma tarefa). Chamado logo depois de agendar o "continue". */
  onUsageLimit(cb: (ev: UsageLimitEvent) => void): void {
    this.limitListeners.push(cb);
  }

  /** Espera o agendamento do limite desta conversa terminar (se houve um): só então a pendência do "continue" existe. */
  async settledLimit(sessionId: string): Promise<void> {
    await this.limitRuns.get(sessionId);
  }

  /**
   * A conversa parou no limite de uso e há um "continue" agendado para ela? Espera o agendamento em curso
   * terminar; depois a pendência (guardada em disco) responde, também ao vigia de sessões, que vê o fim do
   * turno com atraso. Opção desligada ou pendência cancelada: não.
   */
  async awaitingLimit(sessionId: string): Promise<boolean> {
    await this.limitRuns.get(sessionId);
    await this.retryRuns.get(sessionId);
    // Também a retomada de um turno que falhou: enquanto ela está marcada, o turno não terminou (a tarefa segue em "fazendo").
    return !!(await this.opts.autoContinue?.get(sessionId)) || !!(await this.opts.retries?.get(sessionId));
  }

  /** Espera a decisão de retomada desta conversa terminar (se houve uma): só então o motivo da parada (`turnCapOf`) e a pendência existem. */
  async settledRetry(sessionId: string): Promise<void> {
    await this.retryRuns.get(sessionId);
  }

  /**
   * A retomada marcada para esta conversa (a tentativa e a hora), para a tela: o card segue em "fazendo" enquanto ela existe. Null se não
   * há. Pendência de outro projeto não é desta conversa.
   */
  async retryOf(sessionId: string): Promise<{ attempt: number; max: number; at: string; kind: 'transient' | 'unknown'; error: string } | null> {
    const p = await this.opts.retries?.get(sessionId);
    return p?.retry ? { attempt: p.retry.attempt, max: p.retry.max, at: new Date(p.at).toISOString(), kind: p.retry.kind, error: p.retry.error } : null;
  }

  /** Soma 1 à geração da retomada: a que está decidindo ou no meio do envio vê que mudou e desiste (ver `retryGen`). Síncrono. */
  private voidRetry(sessionId: string): void {
    this.retryGen.set(sessionId, (this.retryGen.get(sessionId) ?? 0) + 1);
  }

  /** Alguém assumiu a conversa (Parar, interrupção, mensagem): a retomada não vale mais e o orçamento do turno recomeça no próximo. */
  private dropRetry(sessionId: string, by: CancelBy): void {
    this.voidRetry(sessionId);
    this.retryLedger.clear(sessionId);
    void this.opts.retries?.cancel(sessionId, by).catch(() => {});
  }

  /**
   * Um turno de funcionário acabou (gancho `onTurnEnd` do processo, ainda antes de a conversa ser dada como parada). Terminou bem: fecha o
   * orçamento do turno original. Falhou, ou o processo caiu no meio: decide se retoma sozinho. A decisão é assíncrona; a promessa é guardada aqui,
   * de forma síncrona, para `awaitingLimit` e `settledRetry` a esperarem (o fim do turno não pode mandar a tarefa para revisão antes disso).
   */
  private turnEnded(sessionId: string, projectId: string, staffId: string | null, engine: 'claude' | 'codex', end: TurnEnd): void {
    const retries = this.opts.retries;
    if (end.kind === 'ok') {
      this.engineStops.delete(sessionId);
      // O turno terminou normal: a parada "no meio de…" guardada antes dele era presumida e não se confirmou (a conversa estava viva). O fim de turno da tarefa (que vem logo depois) não a lê mais.
      if (presumedStop(this.inbox.turnCapOf(sessionId))) this.inbox.setTurnCap(sessionId, null);
      if (!retries) return;
      // Sucesso real: o turno original acabou. Uma retomada que ainda estivesse marcada mandaria um "continue" a mais.
      this.retryLedger.clear(sessionId);
      void retries.cancel(sessionId, 'resume').catch(() => {});
      return;
    }
    // Só conversa de funcionário: a sem ficha é sua, e é você quem decide continuar.
    if (!staffId) return;
    // Login recusado ou expirado (o sinal estruturado do motor, ver `isAuthFailure`): tentar de novo não adianta e não gasta o orçamento da retomada (`retryLedger.take` nem é chamado).
    // A retomada já marcada de um turno anterior também sai: ela mandaria um "continue" que falharia do mesmo jeito.
    if (isAuthFailure(end.error)) {
      this.noteEngineStop(sessionId, engine, 'auth', end.error);
      this.voidRetry(sessionId);
      void retries?.cancel(sessionId, 'cap').catch(() => {});
      return;
    }
    // Sem o agendador (testes), só o erro do turno segue adiante: a queda sem causa não tinha como ser retomada.
    if (!retries && end.kind !== 'failed') return;
    const gen = this.retryGen.get(sessionId) ?? 0;
    const run = this.planRetry(sessionId, projectId, staffId, engine, end, gen).catch((err) => this.log(`${sessionId}: retomada: ${err instanceof Error ? err.message : String(err)}`));
    this.retryRuns.set(sessionId, run);
    void run.then(() => {
      if (this.retryRuns.get(sessionId) === run) this.retryRuns.delete(sessionId);
    });
  }

  /**
   * A decisão de retomar. Só retoma: opção ligada; erro passageiro (ou processo que caiu sem causa: no máximo 1 tentativa); nenhuma ação com efeito
   * fora do projeto cortada pela metade; orçamento do turno original com tentativas; nada marcado que já volte à conversa (limite de uso,
   * despertador que vence antes); e nada invalidou no caminho (`gen`). Sem isso: o erro do turno que não é passageiro (ou com a opção desligada) vira
   * `engineStops` (a tarefa vai para Aguardar, não para revisão), e a queda sem causa com a opção desligada segue como antes (o turno terminou);
   * ação cortada e tentativas esgotadas seguram a conversa para você (caixa de entrada, e a tarefa vai para Aguardar).
   */
  private async planRetry(sessionId: string, projectId: string, staffId: string, engine: 'claude' | 'codex', end: Exclude<TurnEnd, { kind: 'ok' }>, gen: number): Promise<void> {
    const retries = this.opts.retries;
    const voided = () => (this.retryGen.get(sessionId) ?? 0) !== gen || this.shuttingDown;
    // O erro do turno que não vai ser retomado: o turno não entregou nada (a menos que algo em segundo plano ainda o acorde).
    const noRetry = (e: TurnError, background: readonly unknown[]) => {
      if (!background.length && !voided()) this.noteEngineStop(sessionId, engine, 'error', e);
    };
    if (!(await retries?.enabled().catch(() => false))) return end.kind === 'failed' ? noRetry(end.error, end.background) : undefined;
    const retriesOn = retries!;
    let transient: Transient | null = null;
    if (end.kind === 'failed') {
      transient = classifyTurnError(end.error);
      if (!transient) return noRetry(end.error, end.background);
      // Ainda há agent ou comando em segundo plano: a conversa não parou, e o que terminar volta a acordá-la sozinho.
      if (end.background.length) return;
    }
    const kind: RetryInfo['kind'] = transient ? 'transient' : 'unknown';
    const label = transient?.label ?? 'o processo caiu sem aviso';
    // Efeito externo incerto: uma ação que mexe fora do projeto ficou pela metade, ou algo em segundo plano morreu junto e o transcript não o
    // mostra só no projeto (agent ou comando que só edita/testa não conta). Retomar poderia repetir a ação.
    const cut = await this.cutOf(projectId, sessionId, end.items, end.awaitingAnswer, end.background, engine).catch(() => 'uma ação que não deu para conferir');
    if (voided()) return;
    if (cut) return this.holdRetry(sessionId, { kind: 'retry', why: 'cut', action: cut, error: label });
    const used = this.retryLedger.get(sessionId)?.attempts ?? 0;
    if (used >= attemptsAllowed(kind)) return this.holdRetry(sessionId, { kind: 'retry', why: 'exhausted', attempts: used, error: label });
    // Quem já volta à conversa não precisa de outra mensagem: o "continue" do limite de uso, e o despertador que vence antes da retomada.
    const wait = Math.max(backoffMs(used + 1, this.opts.random), transient?.retryAfterMs ?? 0);
    const at = this.now() + wait;
    const [limit, wake] = await Promise.all([this.opts.autoContinue?.get(sessionId), this.opts.wakeups?.get(sessionId)]);
    if (voided()) return;
    if (limit || (wake && wake.at <= at)) {
      this.log(`${sessionId}: ${label}; sem retomada própria (${limit ? 'o "continue" do limite de uso' : 'o despertador'} já volta à conversa)`);
      return;
    }
    const budget = this.retryLedger.take(sessionId, this.now());
    const info: RetryInfo = { turnId: budget.turnId, attempt: budget.attempts, max: attemptsAllowed(kind), kind, error: label };
    const pending: Pending = { projectId, sessionId, staffId, at, resetsAt: at, text: RETRY_TEXT, retry: info, ...(engine === 'codex' && { engine }) };
    if (!(await retriesOn.schedule(pending))) return;
    if (voided()) {
      // Parou no meio do agendamento: a pendência que acabou de entrar não vale.
      await retriesOn.cancel(sessionId, 'message').catch(() => false);
      return;
    }
    this.log(`${sessionId}: ${label}; retomo às ${new Date(at).toISOString()} (tentativa ${info.attempt} de ${info.max})`);
    this.showRetry(pending);
  }

  /** Guarda o erro do motor que terminou o turno sem retomada (ver `engineStops`). A tarefa de trabalho o lê no fim do turno (`engineStopOf`). */
  private noteEngineStop(sessionId: string, engine: 'claude' | 'codex', why: 'auth' | 'error', e: TurnError): void {
    this.engineStops.set(sessionId, { kind: 'engine', why, engine, error: errorLine(e) });
  }

  /** O turno de trabalho desta conversa terminou em erro do motor, sem retomada, e ninguém mandou mensagem depois? Só leitura (ver `holdEngineStop`). */
  engineStopOf(sessionId: string): Extract<TurnCapHit, { kind: 'engine' }> | null {
    return this.engineStops.get(sessionId) ?? null;
  }

  /**
   * A tarefa de trabalho foi a Aguardar por causa do erro do motor (`engineStopOf`): guarda o motivo na caixa do dono (`cap:`, como o teto: some na próxima mensagem) e o diz na
   * conversa, e tira o "continue" e o despertador (um login recusado os faria falhar de novo). Só a tarefa chama: conversa solta com o mesmo erro só mostra o aviso do turno.
   */
  holdEngineStop(sessionId: string): void {
    const hit = this.engineStops.get(sessionId);
    if (!hit) return;
    this.turnCapped(sessionId, hit);
    const chat = this.chats.get(sessionId);
    if (chat?.running) chat.addNotice(capText(hit), 'warn');
  }

  /** A retomada não vai acontecer e a conversa precisa de você: guarda o motivo (caixa de entrada e tarefa em Aguardar) e avisa na conversa. */
  private holdRetry(sessionId: string, hit: Extract<TurnCapHit, { kind: 'retry' }>): void {
    this.turnCapped(sessionId, hit);
    const chat = this.chats.get(sessionId);
    if (chat?.running) chat.addNotice(capText(hit), 'warn');
  }

  /** O aviso da retomada que a conversa fechada mostra, vindo da pendência guardada (igual ao do processo aberto). */
  private waitingRetry(p: Pending, r: RetryInfo): ChatItem {
    return { kind: 'notice', id: `n:retry:${p.sessionId}`, text: retryNotice.waiting(p.at, r, r.error), tone: 'warn', at: null, retry: retryField('waiting', r, { at: p.at, error: r.error }) };
  }

  /** O aviso da retomada na conversa aberta: troca o texto do que já está lá, ou põe um novo. */
  private showRetry(p: Pending): void {
    const chat = this.chats.get(p.sessionId);
    if (!chat?.running || !p.retry) return;
    const id = this.retryNotices.get(p.sessionId) ?? `n:retry:${randomUUID()}`;
    this.retryNotices.set(p.sessionId, id);
    chat.setRetryNotice(id, retryNotice.waiting(p.at, p.retry, p.retry.error), 'warn', retryField('waiting', p.retry, { at: p.at, error: p.retry.error }));
  }

  /** O que o agendador fez com a retomada de uma conversa: reflete no aviso dela. */
  private retryEvent(e: AutoContinueEvent): void {
    const p = e.pending;
    if (e.type === 'deferred') return this.showRetry(p);
    const old = this.retryNotices.get(p.sessionId);
    this.retryNotices.delete(p.sessionId);
    const chat = this.chats.get(p.sessionId);
    if (!chat?.running) return;
    const id = old ?? `n:retry:${randomUUID()}`;
    const r = p.retry;
    if (e.type === 'sent') {
      if (r) chat.setRetryNotice(id, retryNotice.sent(r), 'info', retryField('sent', r));
      else chat.setRetryNotice(id, retryNotice.cancelled, 'info', retryField('cancelled'));
    } else if (e.type === 'failed') chat.setRetryNotice(id, retryNotice.failed(e.error), 'warn', retryField('failed', r, { error: e.error }));
    else if (e.type === 'dropped') chat.setRetryNotice(id, retryNotice.dropped, 'warn', retryField('dropped', r));
    else if (old) chat.setRetryNotice(old, retryNotice.cancelled, 'info', retryField('cancelled', r));
  }

  /**
   * Põe a conversa no motor/modelo secundário (ver `overrides`). No boot, a tarefa que trocou de motor (`Task.fallback`)
   * volta a rodar no secundário, para o continue e o resume seguirem nele.
   */
  setOverride(sessionId: string, override: EngineOverride): void {
    this.overrides.set(sessionId, override);
  }

  /** Tira o motor secundário da conversa (a tarefa fechou, ou a conversa deixou de ser a dela). */
  clearOverride(sessionId: string): void {
    this.overrides.delete(sessionId);
  }

  /** O motor/modelo secundário com que a conversa roda agora (undefined = no motor da ficha). */
  overrideOf(sessionId: string): EngineOverride | undefined {
    return this.overrides.get(sessionId);
  }

  /**
   * O turno parou no limite de uso da assinatura: agenda o "continue" (se a opção estiver ligada) e avisa na
   * conversa. Na `MAX_LIMIT_HITS`-ésima vez seguida desiste: a tarefa é entregue como antes e o aviso diz que
   * não deu (a conta recomeça; o próximo estouro, depois de uma mensagem sua, volta a agendar).
   * A hora de voltar é da conta do motor da conversa: o Codex não usa a janela do Claude, e vice-versa.
   */
  private async noteUsageLimit(sessionId: string, projectId: string, staffId: string | null, hit: LimitHit, engine: 'claude' | 'codex') {
    const streak = (this.limitStreak.get(sessionId) ?? 0) + 1;
    this.limitStreak.set(sessionId, streak);
    const now = Date.now();
    let plan: ResumePlan;
    if (engine === 'codex') {
      // Ordem: o reset que o próprio erro deu (`resets_in_seconds`); senão a janela esgotada do leitor do Codex; senão 30 min.
      if (hit.resetsAt !== null) plan = resumePlan(hit, [], now);
      else {
        const usage = (await this.opts.codexLimits?.().catch(() => null)) ?? null;
        plan = resumePlan(codexLimitHit(usage, now) ?? { resetsAt: null, window: null }, [], now);
      }
    } else {
      const file = await readUsage(this.opts.usageFile).catch(() => null);
      plan = resumePlan(hit, [...(file?.limits ?? []), ...this.knownLimits.values()], now);
    }
    const pending: Pending = { projectId, sessionId, staffId, at: plan.at, resetsAt: plan.resetsAt, ...(engine === 'codex' && { engine }) };
    if (streak >= MAX_LIMIT_HITS && (await this.opts.autoContinue?.giveUp(pending, `o limite de uso estourou ${streak} vezes seguidas`))) {
      this.limitStreak.delete(sessionId);
      this.log(`${sessionId}: limite de uso atingido ${streak} vezes seguidas; desisti do "continue" sozinho`);
      return;
    }
    const scheduled = (await this.opts.autoContinue?.schedule(pending)) ?? false;
    this.log(`${sessionId}: limite de uso atingido; ${scheduled ? 'continua' : 'volta'} às ${new Date(scheduled ? plan.at : plan.resetsAt).toISOString()} (${plan.source})`);
    this.showLimit(pending, scheduled, true);
  }

  /** O aviso do limite que a conversa fechada mostra, vindo da pendência guardada (igual ao do processo aberto). */
  private waitingNotice(p: Pending): ChatItem {
    return { kind: 'notice', id: `n:limit:${p.sessionId}`, text: limitNotice.waiting(p.resetsAt, Date.now()), tone: 'warn', at: null, action: 'cancel-auto-continue' };
  }

  /** O aviso do limite na conversa aberta: troca o texto do que já está lá, ou põe um novo (`fresh`: outro estouro). */
  private showLimit(p: Pending, scheduled: boolean, fresh = false) {
    const chat = this.chats.get(p.sessionId);
    if (!chat?.running) return;
    const now = Date.now();
    const old = this.limitNotices.get(p.sessionId);
    // Outro estouro: o aviso anterior fica com a hora dele, só deixa de prometer o "continue" (e de ter o botão).
    if (old && fresh && old.scheduled) chat.setNotice(old.id, limitNotice.back(old.resetsAt, now), 'warn');
    const id = old && !fresh ? old.id : `n:limit:${randomUUID()}`;
    this.limitNotices.set(p.sessionId, { id, resetsAt: p.resetsAt, scheduled });
    chat.setNotice(id, scheduled ? limitNotice.waiting(p.resetsAt, now) : limitNotice.back(p.resetsAt, now), 'warn', scheduled ? 'cancel-auto-continue' : undefined);
  }

  /** O que o agendador fez com a pendência de uma conversa: reflete no aviso dela. */
  private autoContinueEvent(e: AutoContinueEvent) {
    const p = e.pending;
    const chat = this.chats.get(p.sessionId);
    const old = this.limitNotices.get(p.sessionId);
    if (e.type === 'deferred') return this.showLimit(p, true);
    this.limitNotices.delete(p.sessionId);
    if (!chat?.running) return;
    const now = Date.now();
    const id = old?.id ?? `n:limit:${randomUUID()}`;
    if (e.type === 'sent') chat.setNotice(id, limitNotice.continued(now), 'info');
    else if (e.type === 'failed') chat.setNotice(id, e.gaveUp ? limitNotice.gaveUp : limitNotice.failed(e.error), 'warn');
    else if (old) chat.setNotice(old.id, limitNotice.back(old.resetsAt, now), 'warn');
  }

  /** O aviso do despertador que a conversa fechada mostra, vindo da pendência guardada (igual ao do processo aberto). */
  private waitingWake(p: Pending): ChatItem {
    return { kind: 'notice', id: `n:wake:${p.sessionId}:${p.at}`, text: wakeNotice.waiting(p.at), tone: 'info', at: null, action: 'cancel-wake', wake: 'waiting', wakeAt: p.at };
  }

  /** O aviso do despertador na conversa aberta: troca a hora do que já está lá, ou põe um novo. */
  private showWake(p: Pending) {
    const chat = this.chats.get(p.sessionId);
    if (!chat?.running) return;
    const id = this.wakeNotices.get(p.sessionId) ?? `n:wake:${randomUUID()}`;
    this.wakeNotices.set(p.sessionId, id);
    chat.setWakeNotice(id, wakeNotice.waiting(p.at), 'waiting', p.at);
  }

  /** O que o agendador fez com o despertador de uma conversa: reflete no aviso dela. */
  private wakeEvent(e: AutoContinueEvent) {
    const p = e.pending;
    if (e.type === 'deferred') return this.showWake(p);
    const old = this.wakeNotices.get(p.sessionId);
    this.wakeNotices.delete(p.sessionId);
    const chat = this.chats.get(p.sessionId);
    if (!chat?.running) return;
    const now = this.now();
    if (e.type === 'sent') chat.setWakeNotice(old ?? `n:wake:${randomUUID()}`, wakeNotice.sent(now), 'sent', now);
    else if (e.type === 'failed') chat.setWakeNotice(old ?? `n:wake:${randomUUID()}`, wakeNotice.failed(e.error), 'failed', now);
    else if (old) chat.setWakeNotice(old, wakeNotice.cancelled, 'cancelled', now);
  }

  private async saveUsage(sessionId: string, limits: UsageLimit[]) {
    for (const l of limits) this.knownLimits.set(l.kind, l);
    const kept = limits.filter((l) => l.kind === 'five_hour' || l.kind === 'seven_day');
    if (!kept.length) return;
    const body = { updatedAt: new Date().toISOString(), sessionId, limits: kept };
    await writeAtomic(this.opts.usageFile, JSON.stringify(body, null, 2) + '\n').catch(() => {});
  }

  private reap() {
    const idle = this.opts.idleMs ?? 15 * 60_000;
    for (const [id, chat] of this.chats) {
      if (!chat.running) {
        this.chats.delete(id);
        this.errorAt.delete(id);
        this.opts.tokens?.revoke(id);
      } else if (!chat.working && Date.now() - chat.lastActivity > idle) chat.stop();
    }
  }
}
