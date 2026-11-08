import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Autonomy,
  ChatAttachment,
  ChatCommand,
  ChatEvent,
  ChatItem,
  ChatMcp,
  ChatSnapshot,
  ContextSwitch,
  LiveSession,
  QuestionAnnotations,
  QuestionAnswers,
  QuotaBoost,
  RewindPreview,
  SendPriority,
  StaffProfile,
  UsageLimit,
} from '../../shared/model';
import { writeAtomic } from '../staff/store';
import { readHistory } from './history';
import type { CodexSpawn } from './codexArgs';
import { CodexProcess } from './codexProcess';
import { ChatProcess, type ChatProcessOptions, type Remember } from './process';
import { finalQuestion } from './question';
import { CEILING_AT, contextNotice, kTokens, NOTICE_AT, rereadUsd, switchDecision, usd, type TurnInfo } from './contextPolicy';
import { BOOST_NOTICE, CONTEXT_NOTICE } from './items';
import { InboxState } from '../inboxState';
import { isAlive, killTree, type ChatRegistry } from './registry';
import { CONTINUE_TEXT, type AutoContinue, type AutoContinueEvent, type Pending } from './autoContinue';
import { limitNotice, MAX_LIMIT_HITS, resumePlan, type LimitHit } from './usageLimit';
import { WAKE_MAX_STREAK, WakeStreakError, wakeNotice, type WakeInput } from './wake';
import { readUsage } from '../usage';

export interface ChatSpawn {
  sessionId: string;
  cwd: string;
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

export interface ChatManagerOptions {
  /** ~/.claude/projects */
  transcriptsDir: string;
  /** Cópias trazidas ("Trazer" de uma conversa aberta em outro lugar): original → cópia. Sem ele, só em memória. */
  copiesFile?: string;
  /** Onde gravar o consumo lido das conversas (o mesmo arquivo que o mod myco-tap grava). */
  usageFile: string;
  listLive: () => Promise<LiveSession[]>;
  /** Monta a linha de comando (ficha, autonomia, MCPs) de quem vai conversar. */
  /** `forkFrom`: sessão nova que começa como cópia desta (duplicar a conversa). */
  resolve: (projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string) => Promise<ChatSpawn | null>;
  /**
   * Você escolheu modelo/esforço no seletor do chat: guarda na ficha, na conversa e como "último" do
   * funcionário (a conversa reabre assim; conversa nova sem modelo na ficha herda o último). Só grava
   * escolha sua; a folga de cota não passa por aqui. Sem ele, nada é gravado.
   */
  rememberChoice?: (projectId: string, staffId: string, sessionId: string, choice: { model?: string; effort?: string }) => Promise<void>;
  /** Conversa parada há mais que isso fecha o processo (a sessão continua no disco). */
  idleMs?: number;
  spawnImpl?: ChatProcessOptions['spawnImpl'];
  /** Processos abertos, gravados em disco para achar os órfãos depois de um reinício. */
  registry?: ChatRegistry;
  /** Testes trocam (pid vivo? / encerrar processo). */
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number) => Promise<void>;
  log?: (line: string) => void;
  /** Você aprovou o plano de uma conversa (a tarefa dela passa para "fazendo", com o plano). */
  onPlanApproved?: (sessionId: string, plan: string) => void;
  /** Uma mensagem sua foi para a conversa (a tarefa dela volta para "fazendo"). */
  onSent?: (sessionId: string) => void;
  /** Uma conversa parou de trabalhar (a fila de tarefas do funcionário anda). */
  onIdle?: (sessionId: string, projectId: string, staffId: string | null, reason: 'turn' | 'background' | 'exit') => void;
  /** O que a caixa lembra entre reinícios; sem ele, fica só na memória. */
  inbox?: InboxState;
  /** Conversa nova quando o assunto fecha (o config); sem ele, `auto`. */
  contextSwitch?: () => Promise<ContextSwitch>;
  /** Conversas que nunca trocam sozinhas (a de uma tarefa: o quadro segue por ela). */
  keepSession?: (sessionId: string) => Promise<boolean>;
  /** Folga de cota agora (com "otimizar assinatura" ligado); sem ele, nunca. */
  quotaBoost?: () => Promise<QuotaBoost | null>;
  /** Limite de uso estourado: agenda o "continue" para quando ele voltar (ver autoContinue.ts); sem ele, só avisa. */
  autoContinue?: AutoContinue;
  /** Despertador (ver wake.ts): outra instância do agendador, com arquivo e pendências próprios; sem ele, a rota responde 404. */
  wakeups?: AutoContinue;
  /** Relógio do despertador (testes trocam). */
  now?: () => number;
}

export class ChatError extends Error {}

type Listener = (e: ChatEvent) => void;

/** Começo do aviso de ficha atualizada (o histórico do chat o esconde, ver items.ts). */
export const FICHA_NOTICE = '[MyCo] Sua ficha foi atualizada depois que esta conversa começou.';

/** Autonomia da ficha → modo que o processo aberto reporta e aceita em `set_permission_mode`. */
const CLI_MODE: Record<Autonomy, string> = { plan: 'plan', manual: 'default', acceptEdits: 'acceptEdits', auto: 'auto', bypassPermissions: 'bypassPermissions' };
const AUTONOMY_NAME: Record<Autonomy, string> = {
  plan: 'só planeja',
  manual: 'pede aprovação',
  acceptEdits: 'edita sozinho',
  auto: 'automático',
  bypassPermissions: 'sem travas',
};

/** Onde a sessão está aberta e como liberar. */
function holdMessage(o: NonNullable<ChatSnapshot['elsewhere']>): string {
  if (o.orphan) return `ficou um processo do Claudio’s Club de antes do reinício do servidor (pid ${o.pid}): clique em Trazer para encerrá-lo`;
  const where = o.entrypoint === 'claude-desktop' ? 'no app do Claude' : o.entrypoint === 'sdk-cli' ? 'em outro programa (sdk-cli)' : 'num terminal';
  return `a sessão continua aberta ${where} (pid ${o.pid}): feche lá e tente de novo`;
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
  const { autonomy: _a, updatedAt: _u, portrait: _p, sessions: _s, firstTask: _f, lastModel: _lm, lastEffort: _le, ...rest } = p;
  return rest;
}

/**
 * Transcript de uma sessão: na pasta do projeto, ou em outra (a sessão de um funcionário com
 * worktree própria fica na pasta da worktree). O id é um UUID, então não há ambiguidade.
 */
export async function findTranscript(transcriptsDir: string, projectId: string, sessionId: string): Promise<string> {
  const direct = path.join(transcriptsDir, projectId, `${sessionId}.jsonl`);
  if (await fs.access(direct).then(() => true, () => false)) return direct;
  for (const dir of await fs.readdir(transcriptsDir).catch(() => [] as string[])) {
    const file = path.join(transcriptsDir, dir, `${sessionId}.jsonl`);
    if (await fs.access(file).then(() => true, () => false)) return file;
  }
  return direct;
}

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
  private readonly secrets: Array<{ id: string; sessionId: string; label: string; at: string }> = [];
  /** Conversas cuja última mensagem veio de outro funcionário (delegação), e não de você. */
  private readonly delegated = new Set<string>();
  /** Perguntas em aberto e avisos que não são segredo (sobrevivem a um reinício, ver inboxState.ts). */
  private readonly inbox: InboxState;
  /** Fim do último turno de cada conversa: tamanho do contexto, ponto de corte (sobrevive ao processo fechar). */
  private readonly turns = new Map<string, TurnInfo & { ceilingNoted?: number }>();
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
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: ChatManagerOptions) {
    this.inbox = opts.inbox ?? new InboxState();
    opts.autoContinue?.subscribe((e) => this.autoContinueEvent(e));
    opts.wakeups?.subscribe((e) => this.wakeEvent(e));
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref();
  }

  has(sessionId: string): boolean {
    return this.chats.has(sessionId);
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
    const live = chat?.running ? chat.snapshot() : null;
    let file = await findTranscript(this.opts.transcriptsDir, projectId, sessionId);
    // Cópia recém-duplicada: o Claude Code só grava o transcript dela na primeira mensagem; até lá,
    // o histórico é o da original.
    const source = this.forks.get(sessionId);
    if (source && !(await fs.access(file).then(() => true, () => false))) file = await findTranscript(this.opts.transcriptsDir, projectId, source);
    // Com processo aberto, o histórico vai até o início dele; o resto vem pelo SSE.
    const { items, context } = await readHistory(file, { before: live && !source ? chat!.startedAt : undefined });
    // Sem processo (fechou por inatividade, ou o servidor reiniciou), o aviso de limite de uso não tem onde viver:
    // volta da pendência guardada, com a mesma hora e o mesmo botão.
    const waiting = live ? null : await this.opts.autoContinue?.get(sessionId);
    const wake = live ? null : await this.opts.wakeups?.get(sessionId);
    return {
      sessionId,
      history: [...items, ...(waiting ? [this.waitingNotice(waiting)] : []), ...(wake?.projectId === projectId ? [this.waitingWake(wake)] : [])],
      live,
      context,
      elsewhere: await this.elsewhere(sessionId),
      commands: this.commands.get(projectId) ?? [],
      copy: await this.copyOf(sessionId),
    };
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
   * `delegated`: quem mandou foi outro funcionário (pela API), não você pelo Claudio’s Club.
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
  ): Promise<string> {
    return this.deliver(projectId, sessionId, staffId, text, priority, images, files, delegated, false);
  }

  /**
   * O "continue" que o Claudio’s Club manda sozinho quando o limite de uso volta. Vai pelo mesmo caminho de
   * `send` (acorda a conversa se estiver fechada), mas não cancela o que está agendado: foi ele que agendou.
   */
  async continueChat(projectId: string, sessionId: string, staffId: string | null): Promise<void> {
    await this.deliver(projectId, sessionId, staffId, CONTINUE_TEXT, undefined, [], [], this.delegated.has(sessionId), true);
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
    const pending: Pending = { projectId, sessionId, staffId: chat.staffId, at, resetsAt: at, text: input.text };
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

  private async deliver(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    text: string,
    priority: SendPriority | undefined,
    images: string[],
    files: ChatAttachment[],
    delegated: boolean,
    auto: boolean,
  ): Promise<string> {
    const chat = await this.ensure(projectId, sessionId, staffId);
    // Qualquer mensagem sua (ou de outro funcionário) na conversa vale mais que o "continue" agendado.
    if (!auto) {
      await this.opts.autoContinue?.cancel(chat.sessionId, 'message');
      this.wakeStreak.delete(chat.sessionId); // alguém falou: a conta dos despertadores seguidos recomeça
    }
    if (delegated) this.delegated.add(chat.sessionId);
    else this.delegated.delete(chat.sessionId);
    this.inbox.setQuestion(chat.sessionId, null); // respondeu (ou mandou outra coisa): a pergunta sai da caixa
    // A ficha mudou depois que esta conversa começou: o aviso vai junto, uma vez só. Conversa grande:
    // o funcionário fica sabendo do tamanho e do custo (ele não vê isso sozinho).
    const ficha = this.fichaNotices.get(chat.sessionId);
    this.fichaNotices.delete(chat.sessionId);
    const used = chat.contextUsed;
    const big = used !== null && used >= NOTICE_AT ? contextNotice(used, chat.model, CONTEXT_NOTICE, chat.fast) : null;
    const boost = await this.applyBoost(chat);
    const notice = [ficha, big, boost].filter(Boolean).join('\n\n') || undefined;
    chat.send(text, priority, images, notice, files);
    this.opts.onSent?.(chat.sessionId);
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
        chat.setPermissionMode(mode, `Autonomia agora: ${AUTONOMY_NAME[next.autonomy]}`);
      }
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
    const chat = await this.ensure(projectId, sessionId, staffId);
    // Escolha sua nesta conversa: a folga de cota não troca nem desfaz mais (até o processo reabrir).
    if (s.model || s.effort) this.boosts.set(chat, 'manual');
    if (s.model) chat.setModel(s.model, `Modelo desta conversa: ${s.model}`);
    if (s.effort) chat.setEffort(s.effort, `Esforço desta conversa: ${s.effort}`);
    if (s.autonomy) chat.setPermissionMode(CLI_MODE[s.autonomy], `Autonomia desta conversa: ${AUTONOMY_NAME[s.autonomy]}`);
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

  answer(
    sessionId: string,
    requestId: string,
    allow: boolean,
    opts: { message?: string; executeAs?: Autonomy; remember?: Remember; answers?: QuestionAnswers; annotations?: QuestionAnnotations } = {},
  ): boolean {
    const chat = this.chats.get(sessionId);
    const plan = chat?.pendingPermissions().find((p) => p.id === `p:${requestId}`)?.plan;
    if (!chat?.answer(requestId, allow, opts.message, opts.remember, { answers: opts.answers, annotations: opts.annotations })) return false;
    if (allow && opts.executeAs) chat.setPermissionMode(CLI_MODE[opts.executeAs], `Executando como: ${AUTONOMY_NAME[opts.executeAs]}`);
    if (allow && plan !== undefined) this.opts.onPlanApproved?.(sessionId, plan);
    return true;
  }

  /**
   * O que espera você nas conversas abertas no Claudio’s Club: pedidos de permissão sem resposta (o plano
   * pronto entre eles) e conversas que pararam com erro.
   */
  attention(): Array<{ sessionId: string; pending: Array<Extract<ChatItem, { kind: 'permission' }>>; error: string | null }> {
    const out: Array<{ sessionId: string; pending: Array<Extract<ChatItem, { kind: 'permission' }>>; error: string | null }> = [];
    for (const [sessionId, chat] of this.chats) {
      const pending = chat.running ? chat.pendingPermissions() : [];
      const error = chat.error;
      if (pending.length || error) out.push({ sessionId, pending, error });
    }
    return out;
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
   * tira e não avisa mais desse tipo nesta conversa: era um exemplo, um teste, um valor público.
   */
  dismissSecret(id: string, notSecret = false): boolean {
    if (notSecret) this.inbox.mute(id);
    const i = this.secrets.findIndex((s) => s.id === id);
    if (i === -1) return notSecret;
    this.secrets.splice(i, 1);
    return true;
  }

  private noteSecret(sessionId: string, label: string) {
    const id = `${sessionId}:${label}`;
    if (this.secrets.some((s) => s.id === id) || this.inbox.isMuted(id)) return;
    this.secrets.push({ id, sessionId, label, at: new Date().toISOString() });
    this.log(`${sessionId}: ${label} apareceu na conversa (aviso na caixa)`);
  }

  /** Última resposta da conversa aberta no Claudio’s Club (para o aviso "terminou"); null se não for daqui. */
  lastAssistantText(sessionId: string): string | null {
    return this.chats.get(sessionId)?.lastAssistantText() ?? null;
  }

  /** Processos do Claudio’s Club de antes de um reinício do servidor, ainda vivos (ver `adopt`). */
  async orphans(live: LiveSession[]): Promise<Array<{ sessionId: string; pid: number; status: string | null }>> {
    const registry = this.opts.registry;
    if (!registry) return [];
    const alive = this.opts.isAlive ?? isAlive;
    const out: Array<{ sessionId: string; pid: number; status: string | null }> = [];
    for (const rec of Object.values(await registry.read())) {
      if (rec.server === process.pid || alive(rec.server)) continue;
      const s = live.find((l) => l.pid === rec.pid && l.sessionId === rec.sessionId && l.alive);
      if (s) out.push({ sessionId: rec.sessionId, pid: rec.pid, status: s.status });
    }
    return out;
  }

  interrupt(sessionId: string) {
    this.chats.get(sessionId)?.interrupt();
  }

  /** Alguma conversa aberta do funcionário está trabalhando (fora `exceptSession`). */
  staffWorking(staffId: string, exceptSession?: string): boolean {
    for (const c of this.chats.values()) {
      if (c.running && c.staffId === staffId && c.sessionId !== exceptSession && c.working) return true;
    }
    return false;
  }

  /** A conversa do funcionário que está no meio de um turno agora, se for uma só (senão, null). */
  workingSession(staffId: string): string | null {
    const busy = [...this.chats.values()].filter((c) => c.running && c.staffId === staffId && c.busy);
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

  /** Fecha todas as conversas e espera os processos saírem (o Claudio’s Club vai parar ou reiniciar). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.chats.values()].map((c) => c.stopAndWait()));
  }

  stop(sessionId: string) {
    this.chats.get(sessionId)?.stop();
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

  private async ensure(projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string): Promise<ChatProcess> {
    const existing = sessionId ? this.chats.get(sessionId) : undefined;
    // Ficha nova só reabre com tudo parado: agents em segundo plano morreriam com o processo.
    if (existing?.running && !(existing.stale && !existing.working)) return existing;
    if (existing?.running) await existing.stopAndWait(); // reabre com a ficha nova
    if (sessionId) {
      const other = await this.elsewhere(sessionId);
      // Órfão do próprio Claudio’s Club: ninguém mais fala com ele, então mandar mensagem já é o "Trazer".
      if (other?.orphan) {
        this.log(`${sessionId}: retomada aqui, encerrando processo órfão do Claudio’s Club (pid ${other.pid}, ${other.status ?? 'sem status'})`);
        await this.endProcess(sessionId, other.pid);
      } else if (other) {
        this.log(`${sessionId} bloqueada: aberta em ${other.orphan ? 'processo órfão do Claudio’s Club' : (other.entrypoint ?? '?')} (pid ${other.pid})`);
        throw new ChatError(holdMessage(other));
      }
    }
    const spawn = await this.opts.resolve(projectId, sessionId, staffId, forkFrom);
    if (!spawn) throw new ChatError('funcionário ou projeto não encontrado');
    // Claude ou Codex: o resto do manager fala com os dois do mesmo jeito (ver codexProcess.ts).
    const codex = spawn.engine === 'codex' ? spawn.codex : undefined;
    if (spawn.engine === 'codex' && !codex) throw new ChatError('a conversa do Codex veio sem os dados para abrir');
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
      onUsageLimit: (hit) => this.limitHit(spawn.sessionId, projectId, staffId, hit),
      onTurnWithoutLimit: () => void this.limitStreak.delete(spawn.sessionId),
      onSecret: (label) => this.noteSecret(spawn.sessionId, label),
      onIdle: (reason) => {
        if (reason !== 'exit') this.noteQuestion(spawn.sessionId);
        if (reason === 'turn') void this.noteTurn(spawn.sessionId).catch(() => {});
        this.opts.onIdle?.(spawn.sessionId, projectId, staffId, reason);
      },
      onCommands: (commands) => this.commands.set(projectId, commands),
      onExit: (pid, error) => {
        this.log(`${spawn.sessionId} saiu (pid ${pid})${error ? `: ${error.slice(0, 200)}` : ''}`);
        if (pid !== null) void this.opts.registry?.remove(spawn.sessionId, pid).catch(() => {});
      },
      spawnImpl: this.opts.spawnImpl,
    };
    const chat = codex
      ? new CodexProcess({
          ...base,
          permissionMode: CLI_MODE[codex.autonomy],
          instructions: codex.instructions,
          writableRoots: codex.writableRoots,
          secrets: codex.secrets,
          threadId: codex.threadId,
          threadFile: codex.threadFile,
        })
      : new ChatProcess({ ...base, args: spawn.args });
    this.chats.set(spawn.sessionId, chat);
    // O aviso de limite de uso ficou no processo anterior (a pendência guardada recria o dele, logo abaixo).
    this.limitNotices.delete(spawn.sessionId);
    this.wakeNotices.delete(spawn.sessionId);
    this.launched.set(chat, { model, effort });
    // Escolha gravada (reabrir ou duplicar): vale a sua, a folga de cota não atropela.
    if (spawn.chosen) this.boosts.set(chat, 'manual');
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
    await this.endProcess(sessionId, other.pid);
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
    await this.endProcess(sessionId, other.pid);
  }

  /** Encerra a árvore do processo, espera ele sair e tira o registro dele (se houver). */
  private async endProcess(sessionId: string, pid: number): Promise<void> {
    await (this.opts.kill ?? killTree)(pid);
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
      if (rec.server === process.pid) continue;
      if (!alive(rec.pid)) {
        await registry.remove(rec.sessionId, rec.pid);
        continue;
      }
      if (alive(rec.server)) continue; // outro servidor do Claudio’s Club ainda cuida dele
      const s = live.find((l) => l.pid === rec.pid && l.sessionId === rec.sessionId);
      if (s && s.status !== 'busy') {
        this.log(`${rec.sessionId}: processo órfão parado (pid ${rec.pid}, ${s.status ?? 'sem status'}) encerrado na subida`);
        await (this.opts.kill ?? killTree)(rec.pid);
        await registry.remove(rec.sessionId, rec.pid);
      }
    }
  }

  private async elsewhere(sessionId: string): Promise<ChatSnapshot['elsewhere']> {
    const own = this.ownPids();
    const live = (await this.opts.listLive()).find((s) => s.sessionId === sessionId && s.alive && !own.has(s.pid));
    if (!live) return null;
    // Aberto por um servidor do Claudio’s Club que já morreu: ninguém mais fala com esse processo.
    const rec = (await this.opts.registry?.read())?.[sessionId];
    const orphan = !!rec && rec.pid === live.pid && rec.server !== process.pid && !(this.opts.isAlive ?? isAlive)(rec.server);
    return { pid: live.pid, entrypoint: live.entrypoint, status: live.status, orphan };
  }

  private log(line: string) {
    (this.opts.log ?? ((l: string) => console.log(`[chat] ${l}`)))(line);
  }

  /**
   * O processo avisa o limite estourado logo antes de avisar o fim do turno, na mesma volta. Guardar a
   * promessa do agendamento aqui, de forma síncrona, é o que deixa `awaitingLimit` certo para quem
   * perguntar depois, venha o fim do turno antes ou depois de o agendamento terminar.
   */
  private limitHit(sessionId: string, projectId: string, staffId: string | null, hit: LimitHit) {
    const run = this.noteUsageLimit(sessionId, projectId, staffId, hit).catch((err) => this.log(`${sessionId}: limite de uso: ${err instanceof Error ? err.message : String(err)}`));
    this.limitRuns.set(sessionId, run);
    void run.then(() => {
      if (this.limitRuns.get(sessionId) === run) this.limitRuns.delete(sessionId);
    });
  }

  /**
   * A conversa parou no limite de uso e há um "continue" agendado para ela? Espera o agendamento em curso
   * terminar; depois a pendência (guardada em disco) responde, também ao vigia de sessões, que vê o fim do
   * turno com atraso. Opção desligada ou pendência cancelada: não.
   */
  async awaitingLimit(sessionId: string): Promise<boolean> {
    await this.limitRuns.get(sessionId);
    return !!(await this.opts.autoContinue?.get(sessionId));
  }

  /**
   * O turno parou no limite de uso da assinatura: agenda o "continue" (se a opção estiver ligada) e avisa na
   * conversa. Na `MAX_LIMIT_HITS`-ésima vez seguida desiste: a tarefa é entregue como antes e o aviso diz que
   * não deu (a conta recomeça; o próximo estouro, depois de uma mensagem sua, volta a agendar).
   */
  private async noteUsageLimit(sessionId: string, projectId: string, staffId: string | null, hit: LimitHit) {
    const streak = (this.limitStreak.get(sessionId) ?? 0) + 1;
    this.limitStreak.set(sessionId, streak);
    const now = Date.now();
    const file = await readUsage(this.opts.usageFile).catch(() => null);
    const plan = resumePlan(hit, [...(file?.limits ?? []), ...this.knownLimits.values()], now);
    const pending: Pending = { projectId, sessionId, staffId, at: plan.at, resetsAt: plan.resetsAt };
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
      if (!chat.running) this.chats.delete(id);
      else if (!chat.working && Date.now() - chat.lastActivity > idle) chat.stop();
    }
  }
}
