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
  RewindPreview,
  SendPriority,
  StaffProfile,
  UsageLimit,
} from '../../shared/model';
import { writeAtomic } from '../staff/store';
import { readHistory } from './history';
import { ChatProcess, type ChatProcessOptions, type Remember } from './process';
import { finalQuestion } from './question';
import { CEILING_AT, contextNotice, kTokens, NOTICE_AT, rereadUsd, switchDecision, usd, type TurnInfo } from './contextPolicy';
import { CONTEXT_NOTICE } from './items';
import { InboxState } from '../inboxState';
import { isAlive, killTree, type ChatRegistry } from './registry';

export interface ChatSpawn {
  sessionId: string;
  cwd: string;
  args: string[];
}

export interface ChatManagerOptions {
  /** ~/.claude/projects */
  transcriptsDir: string;
  /** Onde gravar o consumo lido das conversas (o mesmo arquivo que o mod myco-tap grava). */
  usageFile: string;
  listLive: () => Promise<LiveSession[]>;
  /** Monta a linha de comando (ficha, autonomia, MCPs) de quem vai conversar. */
  /** `forkFrom`: sessão nova que começa como cópia desta (duplicar a conversa). */
  resolve: (projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string) => Promise<ChatSpawn | null>;
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

/** O que entra na linha de comando da conversa, fora a autonomia (que troca sem reabrir). */
function launchFields(p: StaffProfile) {
  const { autonomy: _a, updatedAt: _u, portrait: _p, sessions: _s, firstTask: _f, ...rest } = p;
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
  /** Segredos vistos nas conversas (um aviso por tipo por sessão, até você dispensar). */
  private readonly secrets: Array<{ id: string; sessionId: string; label: string; at: string }> = [];
  /** Conversas cuja última mensagem veio de outro funcionário (delegação), e não de você. */
  private readonly delegated = new Set<string>();
  /** Perguntas em aberto e avisos que não são segredo (sobrevivem a um reinício, ver inboxState.ts). */
  private readonly inbox: InboxState;
  /** Fim do último turno de cada conversa: tamanho do contexto, ponto de corte (sobrevive ao processo fechar). */
  private readonly turns = new Map<string, TurnInfo & { ceilingNoted?: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: ChatManagerOptions) {
    this.inbox = opts.inbox ?? new InboxState();
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
    return { sessionId, history: items, live, context, elsewhere: await this.elsewhere(sessionId), commands: this.commands.get(projectId) ?? [] };
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
    const chat = await this.ensure(projectId, sessionId, staffId);
    if (delegated) this.delegated.add(chat.sessionId);
    else this.delegated.delete(chat.sessionId);
    this.inbox.setQuestion(chat.sessionId, null); // respondeu (ou mandou outra coisa): a pergunta sai da caixa
    // A ficha mudou depois que esta conversa começou: o aviso vai junto, uma vez só. Conversa grande:
    // o funcionário fica sabendo do tamanho e do custo (ele não vê isso sozinho).
    const ficha = this.fichaNotices.get(chat.sessionId);
    this.fichaNotices.delete(chat.sessionId);
    const used = chat.contextUsed;
    const big = used !== null && used >= NOTICE_AT ? contextNotice(used, chat.model, CONTEXT_NOTICE) : null;
    const notice = [ficha, big].filter(Boolean).join('\n\n') || undefined;
    chat.send(text, priority, images, notice, files);
    this.opts.onSent?.(chat.sessionId);
    return chat.sessionId;
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
      const policy = (await this.opts.contextSwitch?.()) ?? 'auto';
      if (switchDecision(info, Date.now(), policy) === 'switch') {
        const fresh = await this.ensure(projectId, null, staffId);
        fresh.addNotice(
          `Seguiu numa conversa nova: a anterior tinha ${kTokens(info.used!)} e o assunto dela tinha fechado (a memória leva o essencial). Ela continua na lista de conversas, se precisar voltar.`,
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
    const info = { at: Date.now(), used: chat.contextUsed, checkpoint: chat.checkpoint, model: chat.model, ceilingNoted: prev?.ceilingNoted };
    this.turns.set(sessionId, info);
    if (info.used === null || this.delegated.has(sessionId)) return;
    const policy = (await this.opts.contextSwitch?.()) ?? 'auto';
    if (policy === 'off') return;
    const cost = usd(rereadUsd(info.used, info.model));
    if (switchDecision(info, info.at, policy) === 'suggest') {
      chat.addNotice(`Assunto fechado, com ${kTokens(info.used)} de contexto: a próxima pergunta sai mais barata numa conversa nova (+ Nova), e a memória leva o essencial.`);
    } else if (!info.checkpoint && info.used >= CEILING_AT) {
      // Uma vez a cada 100k a mais: avisar a cada resposta seria só barulho.
      const step = Math.floor(info.used / 100_000);
      if ((info.ceilingNoted ?? 0) < step) {
        info.ceilingNoted = step;
        chat.addNotice(`Esta conversa tem ${kTokens(info.used)}: cada resposta relê tudo (cerca de ${cost}). Quando o assunto fechar, o funcionário registra na memória e a próxima mensagem segue numa conversa nova.`, 'warn');
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
    if (s.model) chat.setModel(s.model, `Modelo desta conversa: ${s.model}`);
    if (s.effort) chat.setEffort(s.effort, `Esforço desta conversa: ${s.effort}`);
    if (s.autonomy) chat.setPermissionMode(CLI_MODE[s.autonomy], `Autonomia desta conversa: ${AUTONOMY_NAME[s.autonomy]}`);
    return chat.sessionId;
  }

  answer(
    sessionId: string,
    requestId: string,
    allow: boolean,
    opts: { message?: string; executeAs?: Autonomy; remember?: Remember } = {},
  ): boolean {
    const chat = this.chats.get(sessionId);
    const plan = chat?.pendingPermissions().find((p) => p.id === `p:${requestId}`)?.plan;
    if (!chat?.answer(requestId, allow, opts.message, opts.remember)) return false;
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

  /** Conversas paradas numa pergunta para você, para a caixa "precisa de mim". */
  pendingQuestions(): Array<{ sessionId: string; text: string; at: string }> {
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
    const q = this.delegated.has(sessionId) ? null : finalQuestion(this.chats.get(sessionId)?.lastAssistantText() ?? null);
    this.inbox.setQuestion(sessionId, q ? { text: q, at: new Date().toISOString() } : null);
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
      if (other) {
        this.log(`${sessionId} bloqueada: aberta em ${other.orphan ? 'processo órfão do Claudio’s Club' : (other.entrypoint ?? '?')} (pid ${other.pid})`);
        throw new ChatError(holdMessage(other));
      }
    }
    const spawn = await this.opts.resolve(projectId, sessionId, staffId, forkFrom);
    if (!spawn) throw new ChatError('funcionário ou projeto não encontrado');
    const chat = new ChatProcess({
      sessionId: spawn.sessionId,
      projectId,
      staffId,
      cwd: spawn.cwd,
      args: spawn.args,
      onUsage: (limits) => void this.saveUsage(spawn.sessionId, limits),
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
    });
    this.chats.set(spawn.sessionId, chat);
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
    await (this.opts.kill ?? killTree)(other.pid);
    const alive = this.opts.isAlive ?? isAlive;
    for (let i = 0; i < 50 && alive(other.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(other.pid)) throw new ChatError(`não consegui encerrar o processo ${other.pid}`);
    await this.opts.registry?.remove(sessionId, other.pid).catch(() => {});
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

  private async saveUsage(sessionId: string, limits: UsageLimit[]) {
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
