import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TASK_STATUSES, type Autonomy, type ChatItem, type ChatSnapshot, type Engine, type EngineOverride, type HeldMessage, type StaffProfile, type Task, type TaskCode, type TaskDelivery, type TaskFallback, type TaskHandoff, type TaskStatus, type TaskSummary, type TestRun, type UsageStopHit } from '../shared/model';
import type { SecondOpinionInput } from './adapters/codex';
import { buildHandoff, collectGit, oldConversationExtract } from './fallbackHandoff';
import { DELIVERY_SUMMARY_MAX, parseDeliveryNotes } from './deliveryNotes';
import { hasGuide } from './projectGuide';
import type { LimitHit } from './chat/usageLimit';
import { CLOSING_LINE, RESUME_TEXT } from './chat/items';
import type { Caller } from './callers';
import { writeAtomic } from './staff/store';
import { checkpoint, CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';
import { ENGINE_LABEL, atHour, atMostAutonomy, autonomyOfMode, executeAutonomyOf, limitReading, limitOfStop, otherEngine, overrideOfFallback, shouldFallback, type OtherEngineReading } from './taskFallback';
import { UsageStopError } from './usageStop';

// Tarefas por projeto: `<projeto>/.myco/tasks.json`, ao lado das fichas. Cada tarefa vai para um
// funcionário; ao começar, abre uma conversa nova com a descrição. Ela anda sozinha:
//   planejando → fazendo  quando você aprova o plano no cartão de plano (o plano fica guardado);
//   fazendo → revisão     quando o turno dele termina (trabalhando → parado);
//   revisão → fazendo     quando você manda outra mensagem na conversa da tarefa;
//   revisão automática    com revisor marcado, ao entregar ele revisa sozinho (até 2 rodadas: a entrega e uma
//                         reauditoria). A resposta vem com APROVADO ou REPROVADO na primeira linha e os achados
//                         com severidade (🔴 bloqueia, 🟡 importante, 🟢 detalhe; ver requestReview): REPROVADO só
//                         com algum 🔴. Com SPEC.md no projeto, o revisor confere o guia. Aprovada: pronto (fica em
//                         revisão se falta mesclar a worktree). Reprovada: os ajustes vão para a conversa dele, e a
//                         tarefa volta para fazendo. Estourado o limite, a tarefa fica com você.
// "Aguardar" (waiting) é sua: tarefa parada, fora da fila e do limite de ocupação, com motivo opcional. Só
// "pronto" arquiva sozinho; "pronto" também sai sozinho na aprovação.
//
// Uma tarefa por vez por funcionário. Começar com ele ocupado (outra tarefa planejando ou fazendo,
// ou uma conversa dele trabalhando) põe na fila dele; quando ele fica livre, o Claudio’s Club manda primeiro
// os ajustes que você deixou em tarefas anteriores (guardados enquanto ele estava ocupado) e
// depois a próxima da fila, na ordem do quadro.

export class TaskError extends Error {}

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
const MAX_HISTORY = 30;
/** Quantas revisões automáticas uma tarefa pede antes de ficar com você: a entrega e uma reauditoria. */
const AUTO_REVIEW_ROUNDS = 2;
/** Conversa de tarefa parada há menos que isto não é dada como órfã (ver `orphan`). */
const ORPHAN_MS = 2 * 60_000;

export const TaskInput = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120, 'título longo demais (máx. 120)'),
  description: z.string().trim().max(8000).default(''),
  staffId: z.string().regex(SAFE_ID).nullable().default(null),
  reviewerId: z.string().regex(SAFE_ID).nullable().default(null),
  /** false = só criar: a tarefa fica em Aguardar, sem começar. */
  start: z.boolean().default(true),
});

export const TaskPatch = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120).optional(),
  description: z.string().trim().max(8000).optional(),
  staffId: z.string().regex(SAFE_ID).nullable().optional(),
  reviewerId: z.string().regex(SAFE_ID).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  waitReason: z.string().trim().max(200, 'motivo longo demais (máx. 200)').transform((v) => v || null).nullable().optional(),
  pr: z
    .string()
    .trim()
    .max(500)
    .regex(/^(https?:\/\/\S+)?$/, 'o PR precisa ser um link (https://…)')
    .transform((v) => v || null)
    .nullable()
    .optional(),
  branch: z.string().trim().max(200).transform((v) => v || null).nullable().optional(),
  /** Tirar da fila (pôr é pelo "Começar"). */
  queued: z.literal(false).optional(),
});

export interface TaskServiceDeps {
  /** Pasta do projeto (null: projeto não encontrado). */
  projectPath: (projectId: string) => Promise<string | null>;
  /** Projetos onde procurar tarefas quando chega um aviso de uma conversa (aprovou, terminou…). */
  projectIds: () => Promise<string[]>;
  readProfile: (projectId: string, staffId: string) => Promise<StaffProfile | null>;
  /** Abre uma conversa nova com o funcionário e manda a mensagem; devolve a sessão. `override`: o motor secundário (ver `Switch`). */
  send: (projectId: string, staffId: string, text: string, force: boolean, override?: EngineOverride) => Promise<string>;
  /** Avisa um funcionário (o gestor que pediu a tarefa): na conversa `sessionId`, ou na mais recente dele. */
  notify?: (projectId: string, staffId: string, text: string, sessionId?: string | null) => Promise<void>;
  /** A conversa do funcionário, neste projeto, que está no meio de um turno agora (quem chamou a API), se for uma só. */
  requesterSession?: (projectId: string, staffId: string) => string | null;
  /** Roda os testes do projeto (os testes trocam); o comando vem de detectTest, nunca do pedido. */
  runTests?: (cwd: string, command: string) => Promise<TestRun>;
  /** A última resposta de uma conversa (o resumo da entrega). */
  lastText?: (sessionId: string) => string | null;
  /** Branch em que ele vai trabalhar (a da worktree dele, ou a atual do projeto). */
  branchFor: (projectPath: string, profile: StaffProfile) => Promise<string | null>;
  /** Alguma conversa dele, neste projeto, no Claudio’s Club está trabalhando (turno ou segundo plano), fora `exceptSession`. */
  isWorking?: (projectId: string, staffId: string, exceptSession?: string) => boolean;
  /** Manda na conversa que já existe (os ajustes guardados). */
  sendTo?: (projectId: string, sessionId: string, staffId: string, text: string, images: string[], origin?: string) => Promise<string>;
  /** Segunda opinião de outro modelo sobre o diff (o Codex, ver adapters/codex.ts); sem ele, indisponível. */
  secondOpinion?: (input: SecondOpinionInput) => Promise<string>;
  /**
   * O turno desta conversa parou no limite de uso da assinatura e o "continue" está agendado? Então ele
   * não é entrega: a tarefa fica em "fazendo" até o "continue" rodar e o turno terminar de verdade.
   */
  awaitingLimit?: (sessionId: string) => Promise<boolean>;
  /** Põe a conversa no motor secundário (ver `restoreFallbacks`): só na memória do servidor. */
  setOverride?: (sessionId: string, override: EngineOverride) => void;
  /** Limite agora de um motor: LimitHit, null (sem limite) ou 'unknown' (sem leitura: não troca às cegas). */
  readLimit?: (engine: Engine) => Promise<LimitHit | null | 'unknown'>;
  /**
   * A trava de consumo deste motor agora (5h/7d da empresa, ou o orçamento do projeto), como `usageStopHit` do servidor. Null se
   * não barra. Só a janela (5h/7d) dispara a troca; o orçamento espera na fila, como antes.
   */
  stopHit?: (projectId: string, staffId: string, engine: Engine) => Promise<UsageStopHit | null>;
  /** Espera o agendamento do limite desta conversa terminar (se houve um), antes de cancelar o "continue". */
  settleLimit?: (sessionId: string) => Promise<void>;
  /** Tira o "continue" e o despertador da conversa (motivo: troca de motor). Devolve a hora do despertador, se havia um. */
  cancelContinue?: (sessionId: string) => Promise<number | null>;
  /** Pré-checagem da troca: a conversa no motor do override abriria? Lança o erro que ela daria (ver StaffService.assertOverrideRunnable). */
  assertRunnable?: (projectId: string, staffId: string, override: EngineOverride) => Promise<void>;
  /** Tira o motor secundário da conversa no manager (a tarefa fechou). */
  clearOverride?: (sessionId: string) => void;
  /** Para o processo da conversa (o turno que estourou o limite). */
  stopSession?: (sessionId: string) => void;
  /** Foto da conversa, para o handoff (o histórico do motor antigo). */
  snapshot?: (projectId: string, sessionId: string) => Promise<ChatSnapshot>;
  /** Endereço da API para quem roda fora da sandbox (http://127.0.0.1:<porta>): com ele, a dúvida da tarefa vai ao gestor. */
  apiUrl?: string;
  /** Endereço da sandbox que o Codex alcança (http://127.0.0.2:<porta>): a dúvida do Codex vai por ele. */
  sandboxApiUrl?: string;
}

type Role = 'work' | 'review' | 'deploy';

const OCCUPIED: TaskStatus[] = ['planning', 'doing'];
/** Tarefas cuja conversa de troca volta no boot e segue no secundário: tudo, menos pronta (que sai do quadro ou é arquivada). */
const RESTORABLE: TaskStatus[] = ['todo', 'waiting', 'planning', 'doing', 'review'];
/** Leitura do limite do Codex na fila de início: guardada por este tempo (não abre um `codex` a cada tick). O meio do turno lê fresco. */
const CODEX_LIMIT_TTL_MS = 5 * 60_000;

/** O motor da ficha está no limite e a tarefa não pode começar agora: fica na fila até o limite baixar (ver `startPlan`). */
class LimitWaitError extends Error {}

/** Troca de motor combinada para abrir a conversa: começo (o limite da ficha) ou meio do turno (o handoff). */
interface Switch {
  override: EngineOverride;
  fallback: TaskFallback;
  /** Uma linha a mais no texto da tarefa ("Você está no motor secundário…"). */
  line?: string;
  /** No meio do turno: a mensagem inteira é o handoff (ver `onLimit`). */
  text?: string;
  /** Para o histórico, quando a conversa nova abre. */
  note: string;
}

export class TaskService {
  /** sessionId → onde está a tarefa daquela conversa (e se é o trabalho, a revisão ou o deploy). */
  private readonly bySession = new Map<string, { projectId: string; taskId: string; role: Role }>();
  /** Conversas que a troca de motor já deixou para trás: o que chegar delas (fim do turno, limite…) não é da tarefa. */
  private readonly retired = new Set<string>();
  /** Última leitura do limite do Codex feita para a fila de início (ver readLimit). */
  private codexLimit: { at: number; value: LimitHit | null | 'unknown' } | null = null;
  private indexed = false;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Uma "vez de quem é" por funcionário: dois avisos juntos não começam duas tarefas. */
  private readonly kicks = new Map<string, Promise<void>>();

  constructor(private readonly deps: TaskServiceDeps) {}

  async list(projectId: string): Promise<Task[] | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const tasks = await readTasks(dir);
    for (const t of tasks) {
      if (t.sessionId && !this.retired.has(t.sessionId)) this.bySession.set(t.sessionId, { projectId, taskId: t.id, role: 'work' });
      if (t.review?.sessionId) this.bySession.set(t.review.sessionId, { projectId, taskId: t.id, role: 'review' });
      if (t.deploy?.sessionId) this.bySession.set(t.deploy.sessionId, { projectId, taskId: t.id, role: 'deploy' });
    }
    return tasks.map((t) => withArchive(t));
  }

  /**
   * No boot: a conversa de cada tarefa que trocou de motor (`Task.fallback`) volta a rodar no secundário, para o continue
   * e o resume não caírem no motor da ficha. Devolve quantas conversas foram re-registradas.
   */
  async restoreFallbacks(): Promise<number> {
    let n = 0;
    for (const projectId of await this.deps.projectIds()) {
      for (const t of (await this.list(projectId)) ?? []) {
        if (!t.fallback || !t.sessionId || !RESTORABLE.includes(t.status)) continue;
        // A troca não terminou (o servidor caiu entre gravá-la e abrir a conversa nova): a troca sai da tarefa, e a conversa
        // antiga volta ao motor principal. Se bater o limite de novo, a tarefa pode trocar.
        if (t.fallback.fromSession === t.sessionId) {
          await this.change(projectId, t.id, (x) => noted({ ...x, fallback: undefined }, 'troca interrompida pelo reinício: a conversa volta ao motor da ficha'));
          continue;
        }
        const override = await this.fallbackOverride(projectId, t);
        if (!override) {
          await this.noteSecondaryMoved(projectId, t.id);
          continue;
        }
        this.deps.setOverride?.(t.sessionId, override);
        n++;
      }
    }
    return n;
  }

  /**
   * O motor secundário da tarefa e a autonomia dela, da ficha ATUAL (não do arquivo da tarefa, que pode estar desatualizado ou
   * forjado). Null se a ficha não tem mais secundário, ou se o motor dela não é o da troca. A autonomia segue a fase ("planejando"
   * é plano; o resto, o que executa depois do plano aprovado) e nunca passa da ficha.
   */
  private async fallbackOverride(projectId: string, t: Task): Promise<EngineOverride | null> {
    if (!t.fallback || !t.staffId) return null;
    const profile = await this.deps.readProfile(projectId, t.staffId);
    const sec = profile?.fallback;
    if (!profile || !sec || sec.engine !== t.fallback.engine) return null;
    // Claude como secundário de ficha Codex roda em "aceitar edições" (decisão do dono); o teto da ficha é aplicado em asEngine.
    const claudeDoCodex = sec.engine === 'claude' && profile.engine === 'codex';
    const mode = t.status === 'planning' ? 'plan' : claudeDoCodex ? 'acceptEdits' : executeAutonomyOf(profile.autonomy);
    return { ...overrideOfFallback(sec), autonomy: atMostAutonomy(mode, profile.autonomy) };
  }

  /** A ficha mudou o secundário depois da troca: a conversa volta ao principal, e a tarefa diz isso no histórico (uma vez). */
  private async noteSecondaryMoved(projectId: string, taskId: string): Promise<void> {
    const msg = 'o motor secundário da ficha mudou; a conversa volta ao principal';
    await this.change(projectId, taskId, (t) => (t.history.at(-1)?.note === msg ? t : noted(t, msg)));
  }

  /**
   * O motor secundário da conversa acompanha o estado da tarefa: pronta (ou arquivada), a conversa sai do manager; saindo de
   * pronta ou de aguardar, volta com a ficha atual. A troca que deixou a conversa antiga para trás não é do secundário: nada.
   */
  private async syncOverride(projectId: string, before: Task, after: Task): Promise<void> {
    if (!after.fallback || !after.sessionId || before.status === after.status) return;
    if (after.fallback.fromSession === after.sessionId) return;
    if (after.status === 'done') {
      this.deps.clearOverride?.(after.sessionId);
      return;
    }
    if (before.status === 'done' || before.status === 'waiting') {
      const override = await this.fallbackOverride(projectId, after);
      if (override) this.deps.setOverride?.(after.sessionId, override);
      else await this.noteSecondaryMoved(projectId, after.id);
    }
  }

  /**
   * `requestedBy`: o gestor (funcionário) que pediu, pela API; recebe o resumo na entrega. `requestedSession`: a conversa dele
   * que pediu (o token dele, pela API); sem ela, a que está no turno agora.
   */
  async create(projectId: string, body: unknown, requestedBy: string | null = null, requestedSession?: string): Promise<Task | null> {
    const input = parseOr(TaskInput, body);
    if (input.staffId) await this.staffOrThrow(projectId, input.staffId);
    const manager = requestedBy ? await this.staffOrThrow(projectId, requestedBy) : null;
    // Pedida por um gestor sem `reviewerId` no pedido: ele mesmo confere a entrega. Um `reviewerId` mandado (null inclusive) vale.
    const sentReviewer = typeof body === 'object' && body !== null && 'reviewerId' in body;
    const reviewerId = manager && input.staffId && manager.id !== input.staffId && !sentReviewer ? manager.id : input.reviewerId;
    await this.checkReviewer(projectId, reviewerId, input.staffId, true);
    const now = new Date().toISOString();
    // Sem começar, vai para Aguardar (e não para A fazer): só começa quando você mandar.
    const initial: TaskStatus = input.start ? 'todo' : 'waiting';
    // A entrega volta para a conversa em que o gestor pediu (a que está no turno agora, chamando a
    // API), e não para a mais recente dele, que pode ser outro assunto.
    const task: Task = {
      ...(manager && { requestedBy: manager.id, requestedSession: requestedSession ?? this.deps.requesterSession?.(projectId, manager.id) ?? null }),
      id: `t-${randomBytes(3).toString('hex')}`,
      title: input.title,
      description: input.description,
      status: initial,
      staffId: input.staffId,
      reviewerId,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: initial, by: manager ? 'auto' : 'you', ...(manager && { note: `pedida por ${manager.name}` }) }],
    };
    return (await this.mutate(projectId, (tasks) => [...tasks, task])) ? task : null;
  }

  async update(projectId: string, taskId: string, body: unknown): Promise<Task | null> {
    const patch = parseOr(TaskPatch, body);
    if (patch.staffId) await this.staffOrThrow(projectId, patch.staffId);
    // Revisor e responsável não podem ser a mesma pessoa, mesmo quando só um dos dois muda.
    const dir = await this.deps.projectPath(projectId);
    const cur = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (cur)
      await this.checkReviewer(
        projectId,
        patch.reviewerId !== undefined ? patch.reviewerId : (cur.reviewerId ?? null),
        patch.staffId !== undefined ? patch.staffId : cur.staffId,
        patch.reviewerId !== undefined,
      );
    let before: Task | undefined;
    const out = await this.change(projectId, taskId, (t) => {
      before = t;
      const next = withPatch(t, patch, 'you');
      // Fora da fila: você tirou, trocou o responsável ou levou o cartão para outra coluna.
      const leaves = patch.queued === false || next.staffId !== t.staffId || next.status !== 'todo';
      return leaves && next.queuedAt ? { ...next, queuedAt: null, queuedForce: false } : next;
    });
    // Saiu de "fazendo" à mão (ou mudou de dono): quem estava com ela pode pegar a próxima.
    for (const s of new Set([before?.staffId, out?.staffId])) if (s) void this.kick(projectId, s);
    return out;
  }

  async remove(projectId: string, taskId: string): Promise<boolean> {
    let found: Task | undefined;
    const ok = await this.mutate(projectId, (tasks) => {
      found = tasks.find((t) => t.id === taskId);
      return tasks.filter((t) => t.id !== taskId);
    });
    if (found?.staffId) void this.kick(projectId, found.staffId);
    return !!ok && !!found;
  }

  /**
   * A ficha `staffId` foi apagada (com tarefas abertas, por sua confirmação). As tarefas abertas dela ficam no quadro
   * sem responsável (staffId null, fora da fila); "fazendo", "planejando" e "a fazer" voltam para "a fazer", sem conversa
   * (sessionId), plano nem mensagens guardadas; "revisão" mantém a conversa; "aguardar" fica em aguardar. Quem era o
   * revisor dela fica sem revisor. Concluídas não mudam. Cada tarefa mudada ganha uma linha no histórico. Devolve quantas.
   */
  async releaseStaff(projectId: string, staffId: string): Promise<number> {
    let released = 0;
    await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.status === 'done') return t;
        const asWorker = t.staffId === staffId;
        const asReviewer = t.reviewerId === staffId;
        if (!asWorker && !asReviewer) return t;
        released++;
        if (!asWorker) return noted({ ...t, reviewerId: null }, 'revisor excluído');
        const loose: Task = { ...t, staffId: null, queuedAt: null, queuedForce: false, ...(asReviewer && { reviewerId: null }) };
        // Em revisão, a conversa de trabalho continua (sessionId fica). Nas outras, a conversa e o plano são da
        // pessoa que saiu e as mensagens guardadas iam para ela: zerados, quem pegar a tarefa começa do zero.
        if (t.status === 'review' || t.status === 'waiting') return noted(loose, 'responsável excluído');
        const fresh: Task = { ...loose, sessionId: null, plan: null, held: [], fallback: undefined };
        return t.status === 'todo' ? noted(fresh, 'responsável excluído') : moved(fresh, 'todo', 'auto', 'responsável excluído');
      }),
    );
    return released;
  }

  /**
   * Começa: conversa nova com o funcionário, com o título e a descrição. Com a ficha em "só
   * planeja", a tarefa vai para "planejando"; senão, para "fazendo". Com ele ocupado, entra na
   * fila dele e começa sozinha quando ele ficar livre.
   */
  async start(projectId: string, taskId: string, force = false): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const tasks = dir ? await readTasks(dir) : [];
    const task = tasks.find((t) => t.id === taskId);
    if (!dir || !task) return null;
    if (!task.staffId) throw new TaskError('escolha quem vai cuidar da tarefa');
    if (task.sessionId) throw new TaskError('a tarefa já começou: continue pela conversa dela');
    const profile = await this.staffOrThrow(projectId, task.staffId);
    const staffId = task.staffId;
    // Na fila, a tarefa vai para A fazer (de Aguardar, como de A fazer): só a fila anda com "a fazer".
    const enqueue = (t: Task, note: string) => {
      const from = t.status === 'waiting' ? moved(t, 'todo', 'you', 'saiu de aguardar') : t;
      return noted({ ...from, queuedAt: from.queuedAt ?? new Date().toISOString(), queuedForce: force }, note);
    };
    // Na mesma vez do funcionário que a fila: dois "Começar" juntos não abrem duas conversas.
    return this.locked(projectId, staffId, async () => {
      const busyWith = occupant(await readTasks(dir), staffId, taskId);
      if (!busyWith && !this.deps.isWorking?.(projectId, staffId)) {
        try {
          return await this.startNow(projectId, taskId, profile, force);
        } catch (err) {
          // Limite de consumo na hora (da empresa, ou o do motor da ficha sem troca): não começou, mas fica na fila dele
          // (o tick tenta de novo). Outros erros sobem.
          if (!(err instanceof UsageStopError || err instanceof LimitWaitError)) throw err;
          const why = `não começou: ${err.message}; na fila de ${profile.name}, começa quando o consumo baixar`;
          return this.change(projectId, taskId, (t) => enqueue(t, why));
        }
      }
      const note = busyWith ? `na fila de ${profile.name}, depois de “${busyWith.title}”` : `na fila de ${profile.name} (ele está numa conversa)`;
      return this.change(projectId, taskId, (t) => enqueue(t, note));
    });
  }

  private async startNow(projectId: string, taskId: string, profile: StaffProfile, force: boolean, sw?: Switch): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    // Com troca combinada (no meio do turno), a conversa antiga ainda é a da tarefa até a nova abrir.
    if (!dir || !task || (task.sessionId && !sw)) return null;
    // Sem troca combinada: o limite do motor da ficha agora decide (começa, troca para o secundário, ou espera na fila).
    const plan = sw ? {} : await this.startPlan(projectId, task, profile);
    if (plan.wait) throw new LimitWaitError(plan.wait);
    const s = sw ?? plan.switch;
    const text =
      s?.text ??
      [
        `[Tarefa "${task.title}"]`,
        s?.line ?? '',
        ...(await this.requesterLines(projectId, task, s?.override.engine ?? (profile.engine === 'codex' ? 'codex' : 'claude'))),
        task.description,
        CLOSING_LINE,
      ]
        .filter(Boolean)
        .join('\n\n');
    let sessionId: string;
    try {
      // Sem override, o envio é o de sempre (4 argumentos): só a troca carrega o motor secundário.
      sessionId = s?.override
        ? await this.deps.send(projectId, profile.id, text, force, s.override)
        : await this.deps.send(projectId, profile.id, text, force);
    } catch (err) {
      if (!s) throw err;
      const why = `não abriu no motor secundário: ${(err as Error).message}`;
      // No meio do turno, a antiga já foi parada: a tarefa vai para Aguardar com o motivo, e quem decide é você.
      if (sw) {
        await this.change(projectId, taskId, (t) => moved({ ...t, queuedAt: null, waitReason: why }, 'waiting', 'auto', why));
        throw err;
      }
      // Limite da empresa (UsageStopError) sobe: quem chamou põe na fila, como sempre.
      if (err instanceof UsageStopError) throw err;
      // No início, a tarefa continua na fila, como estaria sem fallback. A troca não é gravada: a fila tenta de novo com o limite de hoje.
      return this.change(projectId, taskId, (t) => {
        const from = t.status === 'waiting' ? moved(t, 'todo', 'auto', 'saiu de aguardar') : t;
        const queued = { ...from, queuedAt: from.queuedAt ?? new Date().toISOString(), queuedForce: force };
        return from.history.at(-1)?.note === why ? queued : noted(queued, why);
      });
    }
    const branch = await this.deps.branchFor(dir, profile).catch(() => null);
    this.bySession.set(sessionId, { projectId, taskId, role: 'work' });
    return this.change(projectId, taskId, (t) => {
      // A troca no meio do turno não muda a fase: a tarefa segue em "fazendo" ou "planejando", como estava.
      const next: TaskStatus = sw ? t.status : profile.autonomy === 'plan' ? 'planning' : 'doing';
      const started = { ...t, sessionId, branch: branch ?? t.branch, queuedAt: null, queuedForce: false, ...(s && { fallback: s.fallback }) };
      const moving = moved(started, next, 'auto', `com ${profile.name}`);
      return s ? noted(moving, s.note) : moving;
    });
  }

  /**
   * As linhas de quem pediu a tarefa: "Pedida por…" e, quando dá, a dúvida ao gestor. `engine`: o motor EFETIVO da conversa
   * (o do override, quando há). O Codex recebe a URL acessível pela sandbox.
   */
  private async requesterLines(projectId: string, task: Task, engine: Engine): Promise<string[]> {
    const manager = task.requestedBy ? await this.deps.readProfile(projectId, task.requestedBy) : null;
    if (!manager) return [];
    const api = engine === 'codex' ? (this.deps.sandboxApiUrl ?? null) : (this.deps.apiUrl ?? null);
    return [
      `Pedida por ${manager.name} (${manager.role}), que vai conferir a sua entrega.`,
      task.requestedSession && api ? askManagerLine(`${api}/api/projects/${projectId}`, manager, task.requestedSession) : '',
    ].filter(Boolean);
  }

  /**
   * Antes de abrir a conversa: o motor da ficha está no limite agora (o do provedor, ou a linha de parada 5h/7d da empresa)?
   * Sem limite (ou sem leitura), começa como sempre. No limite, troca para o secundário se `shouldFallback` deixa; senão,
   * `wait`: a tarefa fica na fila até o limite baixar. O orçamento do projeto não entra aqui: o envio o barra, como antes.
   */
  private async startPlan(projectId: string, task: Task, profile: StaffProfile): Promise<{ switch?: Switch; wait?: string }> {
    // Ficha sem secundário: nada muda em relação ao que já existia (sem pré-checagem; o limite aparece no envio, como sempre).
    if (!profile.fallback) return {};
    const engine: Engine = profile.engine === 'codex' ? 'codex' : 'claude';
    // Início da fila: leitura do Codex em cache (ver readLimit). Quem decide no meio do turno lê fresco.
    const provider = await this.readLimit(engine, { cache: true });
    const hit = limitReading(provider, await this.stopLimit(projectId, profile.id, engine));
    if (hit === null || hit === 'unknown') return {};
    // Veio da linha de parada da empresa (o provedor não deu limite): o texto diz isso, e a volta vai entre parênteses.
    const porStop = provider === null || provider === 'unknown';
    const situacao = porStop ? 'passou da linha de parada' : 'está no limite';
    const secondary = profile.fallback;
    const otherHit = await this.readingOf(projectId, profile.id, otherEngine(engine), true);
    const decision = shouldFallback({ task, profile, engine, hit, otherEngineHit: otherHit, now: Date.now() });
    const volta = atHour(hit.resetsAt);
    const quando = volta ? (porStop ? ` (volta às ${volta})` : ` até ${volta}`) : '';
    if (!decision.ok) return { wait: `${ENGINE_LABEL[engine]} ${situacao}${quando} (${decision.reason})` };
    const override = overrideOfFallback(secondary);
    // Pré-checagem: a conversa nova abre? Se não, fica na fila: sem enviar e sem gravar sessão.
    try {
      await this.deps.assertRunnable?.(projectId, profile.id, override);
    } catch (err) {
      return { wait: `${ENGINE_LABEL[engine]} ${situacao}${quando}; a troca para ${ENGINE_LABEL[secondary.engine]} não abre (${(err as Error).message})` };
    }
    return {
      switch: {
        override,
        fallback: { ...override, from: engine, at: Date.now(), fromSession: null, reason: 'limit-start' },
        line: `Você está no motor secundário (${ENGINE_LABEL[secondary.engine]}) porque ${ENGINE_LABEL[engine]} ${situacao}${quando}.`,
        note: `${ENGINE_LABEL[engine]} ${situacao}: começou no motor secundário (${ENGINE_LABEL[secondary.engine]})`,
      },
    };
  }

  /**
   * O limite de um motor agora (ver `TaskServiceDeps.readLimit`). Erro ao ler = 'unknown': não troca às cegas. Com `cache`, a
   * leitura do Codex é guardada por `CODEX_LIMIT_TTL_MS` (a fila de início, que roda a cada tick); sem ele, sempre fresca.
   */
  private async readLimit(engine: Engine, opts: { cache?: boolean } = {}): Promise<LimitHit | null | 'unknown'> {
    const useCache = engine === 'codex' && !!opts.cache;
    if (useCache && this.codexLimit && Date.now() - this.codexLimit.at < CODEX_LIMIT_TTL_MS) return this.codexLimit.value;
    const value: LimitHit | null | 'unknown' = this.deps.readLimit ? await this.deps.readLimit(engine).catch(() => 'unknown' as const) : 'unknown';
    if (useCache) this.codexLimit = { at: Date.now(), value };
    return value;
  }

  /**
   * A linha de parada da empresa (5h/7d) do motor, como limite (ver `limitOfStop`). Sem o gancho (`stopHit`), ou sem trava: null.
   * Erro ao ler = 'unknown' (não troca às cegas).
   */
  private async stopLimit(projectId: string, staffId: string, engine: Engine): Promise<LimitHit | null | 'unknown'> {
    if (!this.deps.stopHit) return null;
    const stop = await this.deps.stopHit(projectId, staffId, engine).catch(() => 'unknown' as const);
    return stop === 'unknown' ? 'unknown' : stop ? limitOfStop(stop) : null;
  }

  /** O limite de um motor para a troca: o do provedor e a linha de parada da empresa juntos (ver `limitReading`). */
  private async readingOf(projectId: string, staffId: string, engine: Engine, cache: boolean): Promise<OtherEngineReading> {
    return limitReading(await this.readLimit(engine, { cache }), await this.stopLimit(projectId, staffId, engine));
  }

  /**
   * O motor da tarefa estourou o limite no meio do turno (`ChatManager.onUsageLimit`). Se `shouldFallback` deixa, a tarefa
   * passa ao secundário numa conversa nova, com o handoff da antiga. Senão, segue como antes (o "continue" agendado).
   * Ordem: grava a troca antes de matar a antiga; tira o "continue" dela; para o processo; abre a nova.
   */
  async onLimit(ev: { sessionId: string; engine: Engine; hit: LimitHit }): Promise<void> {
    const where = await this.where(ev.sessionId);
    if (where?.role !== 'work') return;
    const { projectId, taskId } = where;
    const staffId = ((await this.list(projectId)) ?? []).find((t) => t.id === taskId)?.staffId;
    if (!staffId) return;
    await this.locked(projectId, staffId, async () => {
      // Antes de tudo: se o limite agendou o "continue", a pendência já existe quando for cancelada.
      await this.deps.settleLimit?.(ev.sessionId);
      const dir = await this.deps.projectPath(projectId);
      const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
      const profile = await this.deps.readProfile(projectId, staffId);
      if (!dir || !task || !profile || task.sessionId !== ev.sessionId || !profile.fallback) return;
      // Só a tarefa em andamento troca: parada, em revisão ou pronta, a conversa não é de quem decide trocar de motor.
      if (task.status !== 'doing' && task.status !== 'planning') return;
      const secondary = profile.fallback;
      const decision = shouldFallback({ task, profile, engine: ev.engine, hit: ev.hit, otherEngineHit: await this.readingOf(projectId, staffId, otherEngine(ev.engine), false), now: Date.now() });
      if (!decision.ok) {
        await this.change(projectId, taskId, (t) => noted(t, `limite do ${ENGINE_LABEL[ev.engine]} no meio do turno: segue como antes (${decision.reason})`));
        return;
      }
      const override = overrideOfFallback(secondary);
      const fallback: TaskFallback = { ...override, from: ev.engine, at: Date.now(), fromSession: ev.sessionId, reason: 'limit-mid' };
      // A foto da antiga, antes de matá-la: o que estava em andamento só existe no processo. O modo em que ela estava também.
      const snap = await (this.deps.snapshot?.(projectId, ev.sessionId) ?? Promise.resolve(null)).catch(() => null);
      // A fase não muda: "planejando" abre em plano; "fazendo" abre no modo em que a antiga estava. Sem leitura do modo, o mínimo
      // (manual). Nunca acima da ficha (ver atMostAutonomy).
      const candidate: Autonomy = task.status === 'planning' ? 'plan' : (autonomyOfMode(snap?.live?.state.permissionMode) ?? 'manual');
      const autonomy = atMostAutonomy(candidate, profile.autonomy);
      const sw: Switch = {
        override: { ...override, autonomy },
        fallback,
        note: `conversa nova no motor secundário (${ENGINE_LABEL[secondary.engine]}), com o resumo da anterior`,
      };
      // Pré-checagem: a conversa nova abriria? (as barreiras do envio, sem gravar nada). Não abre: segue como antes, com o "continue".
      try {
        await this.deps.assertRunnable?.(projectId, staffId, sw.override);
      } catch (err) {
        const why = `troca para ${ENGINE_LABEL[secondary.engine]} não feita: ${(err as Error).message}`;
        await this.change(projectId, taskId, (t) => noted(t, `limite do ${ENGINE_LABEL[ev.engine]} no meio do turno: ${why}; segue como antes`));
        return;
      }
      // a) grava a troca antes de matar a antiga; daqui para a frente, o que chegar dela não é da tarefa.
      this.retired.add(ev.sessionId);
      this.bySession.delete(ev.sessionId);
      await this.change(projectId, taskId, (t) => noted({ ...t, fallback }, `limite do ${ENGINE_LABEL[ev.engine]} no meio do turno: passa para o secundário`));
      try {
        // b) tira o "continue" (e o despertador, se havia: a hora dele vai para o handoff); c) para o processo dela.
        const wakeAt = await this.deps.cancelContinue?.(ev.sessionId);
        this.deps.stopSession?.(ev.sessionId);
        // d) o handoff; e) a conversa nova, com o override e o handoff como mensagem.
        sw.text = await this.handoffText(projectId, dir, task, profile, ev.engine, { engine: secondary.engine, model: secondary.model }, ev.hit, snap, wakeAt ?? null);
        await this.startNow(projectId, taskId, profile, false, sw);
      } catch (err) {
        // Falhou antes de a conversa nova abrir (o startNow já marcou o que dava): fica em Aguardar, sem tentar de novo.
        const why = `troca para o motor secundário não deu certo: ${(err as Error).message}`;
        await this.change(projectId, taskId, (t) => (t.status === 'waiting' ? t : moved({ ...t, queuedAt: null, waitReason: why }, 'waiting', 'auto', why)));
      }
    });
  }

  /**
   * O handoff da conversa antiga: o pedido, as correções do dono, a última resposta, o git, a memória da ficha, o fim de
   * tarefa (o mesmo do texto de início) e o que havia agendado (despertador cancelado, com a hora, se havia).
   */
  private async handoffText(
    projectId: string,
    dir: string,
    task: Task,
    profile: StaffProfile,
    from: Engine,
    to: { engine: Engine; model: string },
    hit: LimitHit,
    snap: ChatSnapshot | null,
    wakeAt: number | null,
  ): Promise<string> {
    const old = oldConversationExtract(snap ?? { history: [], live: null });
    const place = await locateCode(dir, profile.id, !!profile.worktree).catch(() => null);
    const git = await collectGit(place?.path ?? dir).catch(() => null);
    return buildHandoff({
      task: { id: task.id, title: task.title, description: task.description },
      from: { engine: from, reason: 'limit', resetsAt: hit.resetsAt },
      to,
      userMessages: old.userMessages,
      lastAssistantText: old.lastAssistantText,
      git,
      // Com `/` também no Windows: a instrução vai para o modelo, que lê o caminho como texto.
      memoryPath: path.posix.join('.myco', 'staff', `${profile.id}.memory.md`),
      closing: [...(await this.requesterLines(projectId, task, to.engine)), CLOSING_LINE],
      notes: wakeAt ? [`havia um despertador agendado para ${atHour(wakeAt)}: reagende se ainda fizer sentido.`] : [],
    });
  }

  /**
   * Sua mensagem para a conversa de uma tarefa enquanto o funcionário está em outra: fica guardada
   * na tarefa e vai quando ele ficar livre. Devolve o motivo, ou null se pode mandar já.
   */
  async hold(sessionId: string, msg: { text: string; images?: string[]; origin?: string }): Promise<string | null> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return null;
    const tasks = (await this.list(where.projectId)) ?? [];
    const task = tasks.find((t) => t.id === where.taskId);
    if (!task?.staffId) return null;
    const busyWith = occupant(tasks, task.staffId, task.id);
    if (!busyWith && !this.deps.isWorking?.(where.projectId, task.staffId, sessionId)) return null;
    const name = (await this.deps.readProfile(where.projectId, task.staffId))?.name ?? 'ele';
    const reason = busyWith ? `espera ${name} terminar “${busyWith.title}”` : `espera ${name} terminar a conversa em que está`;
    const held: HeldMessage = { id: randomBytes(4).toString('hex'), at: new Date().toISOString(), text: msg.text, ...(msg.images?.length && { images: msg.images }), ...(msg.origin && { origin: msg.origin }), reason };
    await this.change(where.projectId, task.id, (t) => noted({ ...t, held: [...(t.held ?? []), held] }, `ajuste guardado: ${reason}`));
    return reason;
  }

  /** A tarefa cuja conversa de trabalho é `sessionId`, neste projeto (null se não é de tarefa). */
  async taskOfWork(projectId: string, sessionId: string): Promise<Task | null> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work' || where.projectId !== projectId) return null;
    return ((await this.list(projectId)) ?? []).find((t) => t.id === where.taskId) ?? null;
  }

  /**
   * Codex-only exception for a task worker's clarification message to its requester. The source
   * session, active task, requester identity, and requester session must all match the recorded task.
   */
  async mayAskRequester(
    projectId: string,
    caller: Caller | null,
    target: { sessionId: string | null; staffId: string | null },
  ): Promise<boolean> {
    if (!caller?.sandbox || caller.engine !== 'codex' || caller.projectId !== projectId || !caller.staffId || !target.sessionId || !target.staffId) {
      return false;
    }
    const tasks = await this.list(projectId);
    return !!tasks?.some(
      (task) =>
        (task.status === 'planning' || task.status === 'doing') &&
        task.staffId === caller.staffId &&
        task.sessionId === caller.sessionId &&
        task.requestedBy === target.staffId &&
        task.requestedSession === target.sessionId,
    );
  }

  /** As mensagens guardadas desta conversa, como itens do chat. */
  async heldItems(sessionId: string): Promise<ChatItem[]> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return [];
    const task = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    return (task?.held ?? []).map((m) => ({ kind: 'user', id: `h:${m.id}`, text: m.text, at: m.at, held: m.reason, ...(m.images?.length && { images: m.images.length }) }));
  }

  /**
   * Uma conversa do Claudio’s Club parou de trabalhar: se for de uma tarefa, a entrega anda; se for de um
   * funcionário, ele pode pegar o que espera.
   */
  async onIdle(sessionId: string, projectId: string | null, staffId: string | null): Promise<void> {
    await this.workDone(sessionId);
    if (projectId && staffId) await this.kick(projectId, staffId);
  }

  /**
   * Rede de segurança (na subida e de tempos em tempos): tarefa em "fazendo" cuja conversa morreu no
   * meio do turno (ver `orphan`), e quem tem fila ou ajuste esperando e está livre.
   */
  async tick(now = new Date()): Promise<void> {
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      for (const t of tasks) if (t.status === 'doing' && t.sessionId && t.staffId) await this.orphan(projectId, t.id, t.staffId, now);
      const waiting = new Set(tasks.filter((t) => t.staffId && (t.queuedAt || t.held?.length)).map((t) => t.staffId!));
      for (const s of waiting) await this.kick(projectId, s);
    }
  }

  /**
   * "Fazendo" com o funcionário parado (nenhuma conversa dele trabalhando), sem limite de uso nem
   * despertador, e nada mudou há ORPHAN_MS: a conversa morreu no meio do turno (o servidor caiu) e o
   * `onIdle` nunca vem. Na primeira vez, retoma a conversa; se morrer de novo, vai para revisão e a
   * fila anda. Só "fazendo": em "planejando", parado pode ser só esperando a sua resposta.
   */
  private async orphan(projectId: string, taskId: string, staffId: string, now: Date): Promise<void> {
    const isWorking = this.deps.isWorking;
    if (!isWorking) return; // sem saber quem trabalha, não dá para dizer que parou
    const freed = await this.locked(projectId, staffId, async () => {
      const t = ((await this.list(projectId)) ?? []).find((x) => x.id === taskId);
      if (!t?.sessionId || t.status !== 'doing' || t.staffId !== staffId || isWorking(projectId, staffId)) return false;
      // A retomada vale para esta ida a "fazendo": se ela saiu e voltou depois, conta de novo.
      const resumed = t.resumedAt && !t.history.some((h) => h.at > t.resumedAt! && h.status !== 'doing') ? t.resumedAt : null;
      if (now.getTime() - Date.parse(resumed ?? t.updatedAt) < ORPHAN_MS) return false;
      // Erro ao perguntar: não mexe (aqui, errar é mandar mensagem ou tirar de "fazendo" à toa).
      if (await (this.deps.awaitingLimit?.(t.sessionId) ?? Promise.resolve(false)).catch(() => true)) return false;
      if (resumed) {
        let stopped: Task | null = null;
        await this.change(projectId, taskId, (x) => (x.status === 'doing' ? (stopped = moved(x, 'review', 'auto', 'conversa parou sem terminar')) : x));
        // Como numa entrega (commit e aviso ao gestor), mas sem testes nem revisão automática: está pela metade.
        if (stopped) {
          await this.markDelivery(projectId, stopped);
          await this.recordDelivery(projectId, stopped, t.sessionId);
          await this.tellManager(projectId, stopped, t.sessionId, true);
        }
        return true;
      }
      const at = now.toISOString();
      try {
        if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa de trabalho');
        await this.deps.sendTo(projectId, t.sessionId, staffId, RESUME_TEXT, []);
        await this.change(projectId, taskId, (x) => noted({ ...x, resumedAt: at }, 'conversa parou sem terminar: retomada'));
      } catch (err) {
        // Conta como a tentativa: na próxima, sem conversa trabalhando, vai para revisão.
        await this.change(projectId, taskId, (x) => noted({ ...x, resumedAt: at }, `conversa parou sem terminar; não deu para retomar: ${(err as Error).message}`));
      }
      return false;
    });
    if (freed) await this.kick(projectId, staffId);
  }

  /** Um por vez por funcionário (começar, pegar a próxima, mandar ajustes). */
  private locked<T>(projectId: string, staffId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${staffId}`;
    const run = (this.kicks.get(key) ?? Promise.resolve()).then(fn);
    this.kicks.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** Se ele está livre: primeiro os ajustes guardados (o mais antigo antes), depois a próxima da fila. */
  private kick(projectId: string, staffId: string): Promise<void> {
    return this.locked(projectId, staffId, () => this.takeNext(projectId, staffId)).catch(() => {});
  }

  private async takeNext(projectId: string, staffId: string): Promise<void> {
    const tasks = (await this.list(projectId)) ?? [];
    if (occupant(tasks, staffId) || this.deps.isWorking?.(projectId, staffId)) return;
    const adjust = tasks
      .filter((t) => t.staffId === staffId && t.sessionId && t.held?.length)
      .sort((a, b) => a.held![0]!.at.localeCompare(b.held![0]!.at))[0];
    if (adjust && this.deps.sendTo) {
      const held = adjust.held!;
      const text = held.map((m) => m.text).filter(Boolean).join('\n\n');
      const origin = held.map((m) => m.origin).filter(Boolean).join('\n\n');
      try {
        await this.deps.sendTo(projectId, adjust.sessionId!, staffId, text, held.flatMap((m) => m.images ?? []), origin || undefined);
      } catch (err) {
        await this.change(projectId, adjust.id, (t) => noted(t, `o ajuste guardado não foi: ${(err as Error).message}`));
        return;
      }
      const sent = new Set(held.map((m) => m.id));
      await this.change(projectId, adjust.id, (t) => noted({ ...t, held: (t.held ?? []).filter((m) => !sent.has(m.id)) }, 'ajuste guardado enviado'));
      return;
    }
    const next = tasks.find((t) => t.staffId === staffId && t.status === 'todo' && t.queuedAt && !t.sessionId);
    if (!next) return;
    const profile = await this.deps.readProfile(projectId, staffId);
    if (!profile) return;
    try {
      await this.startNow(projectId, next.id, profile, !!next.queuedForce);
    } catch (err) {
      // Continua na fila (ex.: limite de consumo); "Começar" de novo tenta já. Sem repetir a nota a cada tick.
      const why = `não começou: ${(err as Error).message}`;
      await this.change(projectId, next.id, (t) => (t.history.at(-1)?.note === why ? t : noted(t, why)));
    }
  }

  /** O código da tarefa: onde está, o que mudou e se dá para mesclar. */
  async code(projectId: string, taskId: string): Promise<TaskCode | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    return readCode(dir, place, deliveredAt(task));
  }

  /** Roda os testes onde está o código da tarefa e guarda o resultado no cartão. */
  async test(projectId: string, taskId: string): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    const command = await detectTest(dir);
    if (!command) throw new TaskError('não achei testes neste projeto (npm test, composer test ou phpunit)');
    const tests = await runTests(place.path, command);
    return this.change(projectId, taskId, (t) => ({ ...t, tests, updatedAt: new Date().toISOString() }));
  }

  /** Pede ao Codex uma segunda opinião sobre o diff da tarefa e guarda no cartão (só quando você pede). */
  async secondOpinion(projectId: string, taskId: string): Promise<Task | null> {
    if (!this.deps.secondOpinion) throw new TaskError('a segunda opinião não está disponível');
    const { task } = await this.context(projectId, taskId);
    const code = await this.code(projectId, taskId);
    if (!code?.diff.trim()) throw new TaskError('não há mudanças para revisar');
    const text = await this.deps.secondOpinion({ title: task.title, request: task.description, diff: code.diff, truncated: code.truncated });
    const at = new Date().toISOString();
    return this.change(projectId, taskId, (t) => noted({ ...t, secondOpinion: { at, text } }, 'segunda opinião do Codex'));
  }

  /** Mescla a worktree no projeto (testes verdes, ou sem testes confirmado). A tarefa vai para "pronto". */
  async merge(projectId: string, taskId: string, skipTests = false): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    try {
      const m = await mergeCode(dir, place, task.title, { skipTests, upTo: deliveredAt(task) });
      return this.change(projectId, taskId, (t) =>
        moved({ ...t, tests: m.tests ?? t.tests ?? null, merged: { at: new Date().toISOString(), sha: m.sha, branch: m.branch, base: m.base } }, 'done', 'auto', `mesclado em ${m.base} (${m.sha})`),
      );
    } catch (err) {
      if (err instanceof CodeError && err.tests) await this.change(projectId, taskId, (t) => ({ ...t, tests: err.tests }));
      throw err;
    }
  }

  /**
   * Pede a outro funcionário que revise o código da tarefa (numa conversa nova dele). `assign`: o pedido
   * do quadro marca esse revisor na tarefa (reviewerId), e o veredito move a tarefa como na revisão
   * automática. Sem ele, só anota a revisão e o revisor marcado (se houver) não muda.
   */
  async requestReview(projectId: string, taskId: string, reviewerId: string, force = false, opts: { assign?: boolean } = {}): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    if (reviewerId === task.staffId) throw new TaskError('a revisão precisa ser de outro funcionário');
    const reviewer = await this.staffOrThrow(projectId, reviewerId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null);
    const code = place ? await readCode(dir, place).catch(() => null) : null;
    const where = !code
      ? 'O projeto não é um repositório git: leia os arquivos citados na conversa da tarefa.'
      : code.where === 'worktree'
        ? `O código está na worktree \`${code.path}\` (branch \`${code.branch}\`), saindo de \`${code.base}\`. Veja com \`git -C "${code.path}" diff ${code.base}...HEAD\` e \`git -C "${code.path}" status\` (o que ainda não foi commitado).`
        : `As mudanças estão no próprio projeto, sem commit: veja com \`git diff HEAD\`.`;
    const files = code?.files.length ? `Arquivos: ${code.files.slice(0, 30).map((f) => `${f.path} (+${f.add} -${f.del})`).join(', ')}${code.files.length > 30 ? '…' : ''}` : '';
    const guide = (await hasGuide(dir)) ? 'Leia `SPEC.md`: o que contrariar o guia é 🔴.' : '';
    // Severidade: só 🔴 reprova. Com 🟡 ou 🟢 apenas, a primeira linha é APROVADO e a lista vira observações.
    const text = [
      `[Revisão da tarefa "${task.title}"]`,
      `${profile?.name ?? 'Um colega'} terminou a tarefa e ela precisa de revisão.`,
      task.description && `O que foi pedido:\n${task.description}`,
      where,
      files,
      // Só de tarefa pedida por gestor os testes são da última entrega (workDone roda); fora disso podem ser velhos.
      task.requestedBy ? testsLine(task.tests) : '',
      guide,
      'Responda com APROVADO ou REPROVADO na primeira linha, exatamente assim. Em seguida, os achados, cada um com arquivo:linha, o porquê e a severidade: 🔴 bloqueia, 🟡 importante, 🟢 detalhe. REPROVADO só se houver algum 🔴; só 🟡 ou 🟢 é APROVADO, com a lista depois como observações. Algo inventado (API, arquivo, opção ou resultado que não existe) é 🔴. Não mude o código: só revise.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, reviewer.id, text, force);
    this.bySession.set(sessionId, { projectId, taskId, role: 'review' });
    return this.change(projectId, taskId, (t) =>
      moved({ ...t, review: { staffId: reviewer.id, sessionId, at: new Date().toISOString() }, ...(opts.assign && { reviewerId: reviewer.id }) }, 'review', 'auto', `revisão pedida a ${reviewer.name}`),
    );
  }

  /** Pede o deploy ao funcionário de infra, com o checklist (backup, estado antes e depois, runbook). */
  async requestDeploy(projectId: string, taskId: string, infraId: string, force = false): Promise<Task | null> {
    const { task } = await this.context(projectId, taskId);
    const infra = await this.staffOrThrow(projectId, infraId);
    if (!infra.servers.length) throw new TaskError(`${infra.name} não tem acesso a servidores na ficha`);
    const what = task.merged ? `o que foi mesclado em \`${task.merged.base}\` (commit ${task.merged.sha})` : `a entrega da tarefa${task.branch ? ` (branch \`${task.branch}\`)` : ''}`;
    const text = [
      `[Deploy da tarefa "${task.title}"]`,
      `Faça o deploy de ${what}.`,
      task.description && `O que a tarefa entrega:\n${task.description}`,
      'Checklist:\n1. Antes: confira o estado do servidor (serviços, espaço, versão no ar).\n2. Faça backup do que vai mudar.\n3. Publique.\n4. Depois: confira de novo e teste o que a tarefa entrega.\n5. Registre no runbook o que mudou e como desfazer.',
      'Peça minha confirmação antes de qualquer passo irreversível em produção. No fim, responda com o resumo e se ficou no ar.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, infra.id, text, force);
    this.bySession.set(sessionId, { projectId, taskId, role: 'deploy' });
    return this.change(projectId, taskId, (t) => {
      const at = new Date().toISOString();
      const history = [...t.history, { at, status: t.status, by: 'auto' as const, note: `deploy pedido a ${infra.name}` }].slice(-MAX_HISTORY);
      return { ...t, deploy: { staffId: infra.id, sessionId, at }, history, updatedAt: at };
    });
  }

  /** Aprovou o plano da conversa: planejando → fazendo, com o plano guardado. */
  async onPlanApproved(sessionId: string, plan: string): Promise<void> {
    await this.onSession(sessionId, 'work', (t) => (t.status === 'planning' || t.status === 'todo' ? moved({ ...t, plan }, 'doing', 'auto', 'plano aprovado') : { ...t, plan }));
  }

  /**
   * Recusou o plano da conversa: planejando → aguardar, sem executar. Quem pediu é avisado e a fila do
   * funcionário anda. Fora de planejando, não mexe.
   */
  async onPlanRejected(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return;
    let rejected: Task | null = null;
    await this.change(where.projectId, where.taskId, (t) => {
      if (t.status !== 'planning') return t;
      rejected = moved(t, 'waiting', 'auto', 'plano recusado pelo usuário');
      return rejected;
    });
    const out = rejected as Task | null;
    if (!out) return;
    await this.tellRequester(where.projectId, out, `[MyCo] O usuário recusou o plano da tarefa “${out.title}” (id ${out.id}); ela foi para Aguardar e não será executada.`);
    if (out.staffId) await this.kick(where.projectId, out.staffId);
  }

  /** Mandou mensagem na conversa da tarefa: em revisão, ela volta para "fazendo". */
  async onSent(sessionId: string): Promise<void> {
    await this.onSession(sessionId, 'work', (t) => (t.status === 'review' ? moved(t, 'doing', 'auto', 'você respondeu') : null));
  }

  /**
   * O turno de uma conversa da tarefa terminou. Do trabalho: fazendo → revisão. Da revisão: anota a
   * resposta e o veredito, e com revisor automático aprova ou reprova (ver onReviewTurn). Do deploy:
   * anota que a resposta chegou (a tarefa não muda de coluna sozinha por isso).
   */
  async onTurnDone(sessionId: string): Promise<void> {
    await this.onReviewTurn(sessionId);
    await this.onSession(sessionId, 'deploy', (t) => noteHandoff(t, 'deploy', 'deploy respondeu'));
    await this.workDone(sessionId);
  }

  /**
   * A revisão respondeu: anota o veredito (APROVADO ou REPROVADO, na primeira linha). Só a revisão
   * atual da tarefa conta, e só com o revisor marcado nela (pela revisão automática ou pelo pedido do
   * quadro, com `assign`) é que o veredito move a tarefa: aprovada vai para pronto; reprovada, os
   * ajustes voltam para a conversa de trabalho.
   */
  private async onReviewTurn(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (where?.role !== 'review') return;
    const current = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    const isCurrent = current?.review?.sessionId === sessionId;
    const reviewText = this.deps.lastText?.(sessionId) ?? null;
    const verdict = isCurrent ? parseVerdict(reviewText) : undefined;
    const task = await this.change(where.projectId, where.taskId, (t) => noteHandoff(t, 'review', 'revisão respondida', verdict) ?? t);
    if (!task || !isCurrent || !verdict || task.status !== 'review' || !task.reviewerId || task.reviewerId !== task.review?.staffId) return;
    const reviewer = (await this.deps.readProfile(where.projectId, task.reviewerId))?.name ?? 'o revisor';
    if (verdict === 'approved') return this.approve(where.projectId, task.id, reviewer);
    return this.reject(where.projectId, task.id, reviewer, reviewText ?? '');
  }

  /** Aprovada pelo revisor: pronto, a não ser que o código ainda esteja numa worktree por mesclar. */
  private async approve(projectId: string, taskId: string, reviewer: string): Promise<void> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = task.staffId ? await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null) : null;
    const head = `[MyCo] Tarefa “${task.title}” (id ${task.id}): `;
    if (place?.where === 'worktree' && !task.merged) {
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `aprovada por ${reviewer}; falta mesclar`) : t));
      if (selfReview(task)) await this.tellRequester(projectId, task, `${head}aprovada; falta mesclar a worktree.`);
      return;
    }
    await this.change(projectId, taskId, (t) => (t.status === 'review' ? moved(t, 'done', 'auto', `aprovada por ${reviewer}`) : t));
    if (selfReview(task)) await this.tellRequester(projectId, task, `${head}aprovada na sua revisão, foi para pronto.`);
  }

  /**
   * Reprovada: a resposta do revisor vai para a conversa de trabalho, como ajuste. Com ele ocupado
   * (outra tarefa, ou outra conversa dele), o ajuste fica guardado e a tarefa segue em revisão; quando
   * a mensagem for enviada, ela volta para fazendo. Livre, a tarefa vai para fazendo e a mensagem
   * entra na conversa dele. Quando o turno dele terminar, a próxima rodada é pedida (workDone).
   */
  private async reject(projectId: string, taskId: string, reviewer: string, reviewText: string): Promise<void> {
    const { dir, task } = await this.context(projectId, taskId);
    if (!task.staffId || !task.sessionId) {
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `reprovada por ${reviewer}, mas não tem conversa de trabalho: fica com você`) : t));
      return;
    }
    const staffId = task.staffId;
    const work = task.sessionId;
    const lesson = (await hasGuide(dir))
      ? 'Se algum 🔴 mostra uma regra do projeto que pode se repetir (não um erro pontual), registre-a em uma linha, com a data, na seção "Lições da revisão" do `SPEC.md` (crie a seção no fim se não existir). Antes, confira se já não está lá ou em outra seção; no máximo 15 lições: ao passar disso, junte ou tire as velhas. Erro pontual não vira lição.'
      : 'Se algum 🔴 mostra uma regra do projeto que pode se repetir (não um erro pontual), registre-a em uma linha na sua memória, substituindo o que ficou velho. Erro pontual não vira lição.';
    const msg = [
      `[Revisão da tarefa "${task.title}"]`,
      `${reviewer} reprovou a entrega. Os ajustes, como ele escreveu:`,
      reviewText.trim().slice(0, 4000),
      lesson,
      'Faça os ajustes e, quando terminar, responda com um resumo curto do que mudou (e a lição registrada, se houver).',
    ].join('\n\n');
    await this.locked(projectId, staffId, async () => {
      const reason = await this.hold(work, { text: msg });
      if (reason) {
        await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `reprovada por ${reviewer}`) : t));
        return;
      }
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? moved(t, 'doing', 'auto', `reprovada por ${reviewer}`) : t));
      try {
        if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa de trabalho');
        await this.deps.sendTo(projectId, work, staffId, msg, []);
      } catch (err) {
        // Não foi (limite de consumo, conversa fechada…): fica guardado e volta para revisão; o vigia manda depois.
        const error = (err as Error).message;
        const held: HeldMessage = { id: randomBytes(4).toString('hex'), at: new Date().toISOString(), text: msg, reason: `não foi enviado: ${error}` };
        await this.change(projectId, taskId, (t) => {
          const back = t.status === 'doing' ? moved(t, 'review', 'auto', `ajuste de ${reviewer} não foi enviado: ${error}`) : t;
          return { ...back, held: [...(back.held ?? []), held] };
        });
      }
    });
  }

  /** Entregue com revisor marcado: pede a revisão sozinho, até AUTO_REVIEW_ROUNDS rodadas. */
  private async autoReview(projectId: string, task: Task): Promise<void> {
    if (!task.reviewerId) return;
    if ((task.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS) {
      await this.change(projectId, task.id, (t) =>
        noted(t, `limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas; o que sobrou fica com você: aceitar como trade-off (anotar em "Decisões" no SPEC.md) ou pedir ajuste`),
      );
      if (selfReview(task))
        await this.tellRequester(projectId, task, `[MyCo] Tarefa “${task.title}” (id ${task.id}): o limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas foi atingido; o que sobrou fica com você.`);
      return;
    }
    try {
      await this.requestReview(projectId, task.id, task.reviewerId);
      await this.change(projectId, task.id, (t) => ({ ...t, reviewRounds: (t.reviewRounds ?? 0) + 1 }));
    } catch (err) {
      await this.change(projectId, task.id, (t) => noted(t, `revisão automática não começou: ${(err as Error).message}`));
      // Quem pediu ia revisar e a revisão não começou: ele ainda tem de saber da entrega, como antes.
      if (selfReview(task) && task.sessionId) await this.tellManager(projectId, task, task.sessionId);
    }
  }

  /** O revisor: outro funcionário do projeto, e não quem faz a tarefa (`check`: confere se ele existe). */
  private async checkReviewer(projectId: string, reviewerId: string | null, staffId: string | null, check: boolean): Promise<void> {
    if (!reviewerId) return;
    if (reviewerId === staffId) throw new TaskError('a revisão precisa ser de outro funcionário');
    if (check && !(await this.deps.readProfile(projectId, reviewerId))) throw new TaskError('revisor não encontrado neste projeto');
  }

  /**
   * Fazendo → revisão, com o commit da entrega, e a vez passa para o que espera. Vem do vigia de
   * sessões (que lê de tempos em tempos e perde turno curto) e do processo da conversa no Claudio’s Club (que
   * sabe a hora exata); o segundo aviso não muda nada.
   */
  private async workDone(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work') return;
    // Parou no limite de uso com o "continue" agendado: não é entrega. Fica em "fazendo", ninguém é avisado
    // e a fila não anda (a tarefa segue ocupando o funcionário). Erro ao perguntar: vale como hoje, entrega.
    if (await this.deps.awaitingLimit?.(sessionId).catch(() => false)) return;
    const current = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    // Fim de uma conversa que já não é a da tarefa (trocou de motor, ou outra): não entrega, não fecha, não anda a fila.
    if (!current || current.sessionId !== sessionId) return;
    const staffId = current.staffId;
    if (!staffId) return;
    // Na vez dele: a próxima tarefa só começa depois que a entrega desta tem o seu commit.
    const deliveredTask = await this.locked(where.projectId, staffId, async () => {
      let delivered: Task | null = null;
      // Confere de novo, lá dentro: o estado pode ter mudado enquanto esperava a vez.
      await this.change(where.projectId, where.taskId, (t) =>
        t.status === 'doing' && t.sessionId === sessionId ? (delivered = moved(t, 'review', 'auto', 'turno terminou')) : t,
      );
      if (delivered) {
        await this.markDelivery(where.projectId, delivered);
        delivered = await this.recordDelivery(where.projectId, delivered, sessionId);
        // Pedida por um gestor: o Claudio’s Club roda os testes antes de avisar, e o gestor não gasta a conversa
        // dele (a mais longa e cara) rodando de novo.
        const tests = (delivered as Task).requestedBy ? await this.deliveryTests(where.projectId, delivered) : null;
        if (tests) delivered = (await this.change(where.projectId, where.taskId, (t) => ({ ...t, tests }))) ?? delivered;
        // Quem pediu é quem revisa: o aviso sai no desfecho da revisão automática (ver autoReview), não na entrega.
        if (!selfReview(delivered)) await this.tellManager(where.projectId, delivered, sessionId);
      }
      return delivered as Task | null;
    });
    void this.kick(where.projectId, staffId);
    // Fora da vez dele: a revisão automática (com revisor marcado) é pedida depois da entrega.
    if (deliveredTask) await this.autoReview(where.projectId, deliveredTask);
  }

  /**
   * Guarda a entrega no próprio Task (resumo e notas por arquivo), com ou sem gestor: sem isso, o
   * resumo só existe na conversa do gestor.
   */
  private async recordDelivery(projectId: string, task: Task, sessionId: string): Promise<Task> {
    const full = this.deps.lastText?.(sessionId) ?? '';
    const notes = parseDeliveryNotes(full);
    const delivery: TaskDelivery = { at: new Date().toISOString(), summary: full.trim().slice(0, DELIVERY_SUMMARY_MAX), ...(notes && { notes }) };
    return (await this.change(projectId, task.id, (t) => ({ ...t, delivery }))) ?? task;
  }

  /**
   * Tarefa pedida por um gestor foi entregue: ele recebe, na conversa dele, quem entregou, o quê e
   * o resumo, para conferir.
   */
  private async tellManager(projectId: string, task: Task, sessionId: string, interrupted = false): Promise<void> {
    if (!task.requestedBy || !this.deps.notify) return;
    const who = task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    const name = who?.name ?? 'O funcionário';
    const summary = (this.deps.lastText?.(sessionId) ?? '').trim().slice(0, 1500);
    // Interrompida: testes guardados seriam de uma entrega anterior, não desta.
    const t = interrupted ? undefined : task.tests;
    const tests = testsLine(t);
    const text = [
      interrupted
        ? `[MyCo] A conversa de ${name} na tarefa “${task.title}” (id ${task.id}) parou duas vezes sem terminar (o Claudio’s Club reiniciou no meio); ela foi para revisão e a fila dele andou. A entrega pode estar incompleta: confira e, se faltar algo, peça na conversa da tarefa.`
        : `[MyCo] ${name} entregou a tarefa “${task.title}” (id ${task.id}, agora em revisão no quadro).`,
      summary ? `O que ${name} disse:\n${summary}` : `${name} não deixou resumo: veja a conversa da tarefa.`,
      tests,
      interrupted
        ? 'Os testes não foram rodados (entrega incompleta).'
        : t
          ? 'Confira o diff na medida do risco antes de dar como pronto.'
          : 'Confira (diff, testes) antes de dar como pronto.',
      'Ajuste vai para a pessoa, na conversa da tarefa dela, não refaça você.',
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.deps.notify(projectId, task.requestedBy, text, task.requestedSession ?? null).catch(() => {});
  }

  /** Revisor é quem pediu: o desfecho vai para a conversa dele, a em que pediu (ver selfReview). */
  private async tellRequester(projectId: string, task: Task, text: string): Promise<void> {
    if (!task.requestedBy || !this.deps.notify) return;
    await this.deps.notify(projectId, task.requestedBy, text, task.requestedSession ?? null).catch(() => {});
  }

  /** Os testes do projeto onde está o código da entrega (a worktree dele ou o próprio projeto). */
  private async deliveryTests(projectId: string, task: Task): Promise<TestRun | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir || !task.staffId) return null;
    const command = await detectTest(dir);
    if (!command) return null;
    const profile = await this.deps.readProfile(projectId, task.staffId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null);
    return (this.deps.runTests ?? runTests)(place?.path ?? dir, command);
  }

  /**
   * Foi para revisão numa worktree: commita a entrega com o título da tarefa e guarda o commit. A
   * próxima tarefa dele começa na mesma worktree; a mescla desta vai só até aqui.
   */
  private async markDelivery(projectId: string, task: Task): Promise<void> {
    const dir = await this.deps.projectPath(projectId);
    const profile = dir && task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    if (!dir || !profile?.worktree) return;
    const place = await locateCode(dir, task.staffId, true).catch(() => null);
    const sha = place ? await checkpoint(place, task.title).catch(() => null) : null;
    if (sha) await this.change(projectId, task.id, (t) => noted({ ...t, checkpoint: { sha, at: new Date().toISOString() } }, `entrega no commit ${sha.slice(0, 7)}`));
  }

  /**
   * Por projeto: tarefas em aberto (tudo que não é "pronto", Aguardar inclusive) e quantas esperam
   * revisão. Projetos sem nada em aberto ficam de fora.
   */
  async summary(): Promise<Record<string, TaskSummary>> {
    const out: Record<string, TaskSummary> = {};
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      const open = tasks.filter((t) => t.status !== 'done').length;
      if (open) out[projectId] = { open, review: tasks.filter((t) => t.status === 'review').length };
    }
    this.indexed = true;
    return out;
  }

  private async context(projectId: string, taskId: string) {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!dir || !task) throw new TaskError('tarefa não encontrada');
    const profile = task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    return { dir, task, profile };
  }

  private async onSession(sessionId: string, role: Role, fn: (t: Task) => Task | null): Promise<void> {
    const where = await this.where(sessionId);
    if (where && where.role === role) await this.change(where.projectId, where.taskId, (t) => fn(t) ?? t);
  }

  /** A conversa é de uma tarefa (o trabalho, a revisão ou o deploy dela)? */
  async isTaskSession(sessionId: string): Promise<boolean> {
    return !!(await this.where(sessionId));
  }

  /**
   * A conversa é de tarefa, ativa ou não: a de trabalho, revisão ou deploy; as retiradas (antes de um reinício); e a antiga de
   * uma troca de motor (que depois do reinício já não está no índice). O envio direto (server/directFallback.ts) não mexe nelas.
   */
  async isTaskConversation(sessionId: string): Promise<boolean> {
    if (this.retired.has(sessionId) || (await this.isTaskSession(sessionId))) return true;
    for (const projectId of await this.deps.projectIds()) {
      if ((await this.list(projectId) ?? []).some((t) => t.fallback?.fromSession === sessionId)) return true;
    }
    return false;
  }

  private async where(sessionId: string) {
    if (this.retired.has(sessionId)) return null;
    if (!this.bySession.has(sessionId) && !this.indexed) await this.summary(); // primeira vez depois de subir: monta o índice sessão → tarefa
    return this.bySession.get(sessionId) ?? null;
  }

  private async change(projectId: string, taskId: string, fn: (t: Task) => Task): Promise<Task | null> {
    const seen: { before?: Task; after?: Task } = {};
    const ok = await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.id !== taskId) return t;
        seen.before = t;
        seen.after = fn(t);
        return seen.after;
      }),
    );
    if (ok && seen.before && seen.after) await this.syncOverride(projectId, seen.before, seen.after);
    return ok ? (seen.after ?? null) : null;
  }

  /** Lê, muda e grava o arquivo do projeto, um pedido por vez (duas mudanças juntas não se perdem). */
  private async mutate(projectId: string, fn: (tasks: Task[]) => Task[]): Promise<boolean> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return false;
    const file = tasksFile(dir);
    const prev = this.queues.get(file) ?? Promise.resolve();
    const run = prev.then(async () => {
      const next = fn(await readTasks(dir));
      await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
    });
    this.queues.set(file, run.catch(() => {}));
    await run;
    return true;
  }

  private async staffOrThrow(projectId: string, staffId: string): Promise<StaffProfile> {
    const p = await this.deps.readProfile(projectId, staffId);
    if (!p) throw new TaskError('funcionário não encontrado neste projeto');
    return p;
  }
}

const tasksFile = (dir: string) => path.join(dir, '.myco', 'tasks.json');

/**
 * Pronto sem mudança há mais de 7 dias sai do quadro. Derivado na leitura, nunca gravado:
 * qualquer mudança nova (updatedAt) tira do arquivo sozinha, e nada é apagado. Aguardar não arquiva.
 */
export const ARCHIVE_AFTER_MS = 7 * 86_400_000;
function withArchive(t: Task, now = Date.now()): Task {
  const since = Date.parse(t.updatedAt);
  if (t.status === 'done' && Number.isFinite(since) && now - since > ARCHIVE_AFTER_MS)
    return { ...t, archived: true, archivedAt: new Date(since + ARCHIVE_AFTER_MS).toISOString() };
  return t;
}

/** "No ar" saiu do quadro: o que foi gravado com ele segue como "pronto" (o histórico também). */
const fromLegacy = (s: string): TaskStatus => (s === 'live' ? 'done' : (s as TaskStatus));

/** As tarefas do projeto (`.myco/tasks.json`), só leitura; lista vazia se não há arquivo. */
export async function readTasks(dir: string): Promise<Task[]> {
  const raw = await fs.readFile(tasksFile(dir), 'utf8').catch(() => null);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!Array.isArray(data)) return [];
    return (data as Task[])
      .filter((t) => t && typeof t.id === 'string')
      .map((t) => ({ ...t, status: fromLegacy(t.status), history: t.history?.map((h) => ({ ...h, status: fromLegacy(h.status) })) ?? t.history }))
      .filter((t) => TASK_STATUSES.includes(t.status));
  } catch {
    return [];
  }
}

/**
 * O veredito da revisão: a primeira linha não vazia, sem markdown, é APROVADO ou REPROVADO
 * (maiúsculas). Qualquer outra coisa é null e não decide nada.
 */
export function parseVerdict(text: string | null | undefined): 'approved' | 'rejected' | null {
  const first = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  // A linha só com a palavra: "APROVADO, mas o teste X falha" não aprova.
  const line = first.replace(/^[*#_`>\s]+/, '').replace(/[*_`.!:\s]+$/, '');
  if (line === 'APROVADO') return 'approved';
  if (line === 'REPROVADO') return 'rejected';
  return null;
}

/** A revisão ou o deploy respondeu: marca a hora e deixa uma linha no histórico (sem mudar de coluna). */
function noteHandoff(t: Task, kind: 'review' | 'deploy', note: string, verdict?: TaskHandoff['verdict']): Task | null {
  const h = t[kind];
  if (!h) return null;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY);
  return { ...t, [kind]: { ...h, doneAt: at, ...(verdict !== undefined && { verdict }) }, history, updatedAt: at };
}

/** A tarefa que ocupa o funcionário (planejando ou fazendo, com conversa aberta), fora `except`. */
function occupant(tasks: Task[], staffId: string, except?: string): Task | undefined {
  return tasks.find((t) => t.staffId === staffId && t.id !== except && t.sessionId && OCCUPIED.includes(t.status));
}

/**
 * Até onde vai a entrega desta tarefa: o commit dela, se ela não voltou a "fazendo" depois (aí o
 * trabalho novo dela ainda não tem commit e entra tudo).
 */
function deliveredAt(t: Task): string | null {
  return t.checkpoint && t.status !== 'doing' && t.status !== 'planning' ? t.checkpoint.sha : null;
}

/** Dúvida da tarefa vai para quem pediu, na conversa em que pediu, nunca para o usuário. */
function askManagerLine(api: string, manager: StaffProfile, sessionId: string): string {
  const body = JSON.stringify({ sessionId, staffId: manager.id, text: 'sua pergunta' });
  return (
    `Dúvida ou decisão desta tarefa: pergunte a ${manager.name}, não ao usuário (sem pergunta com opções), e siga no que não depende da resposta. ` +
    `POST ${api}/chat/send com os cabeçalhos \`x-myco: 1\` e \`x-myco-token: $MYCO_TOKEN\` e o JSON \`${body}\`.`
  );
}

/** Quem pediu a tarefa é quem revisa a entrega (revisor marcado igual ao gestor): ele recebe só o desfecho. */
const selfReview = (t: Task) => !!t.reviewerId && t.reviewerId === t.requestedBy;

/** O resultado dos testes da entrega, em linhas para o aviso (vazio sem testes). */
function testsLine(t: TestRun | null | undefined): string {
  if (!t) return '';
  return t.ok
    ? `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): passaram em ${Math.round(t.ms / 1000)} s. Não rode de novo.`
    : `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): FALHARAM. Fim da saída:\n${t.output.slice(-800)}`;
}

/** Uma linha no histórico, sem mudar de coluna. */
function noted(t: Task, note: string): Task {
  const at = new Date().toISOString();
  return { ...t, history: [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY), updatedAt: at };
}

function moved(t: Task, status: TaskStatus, by: 'you' | 'auto', note?: string): Task {
  if (t.status === status) return t;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status, by, ...(note && { note }) }].slice(-MAX_HISTORY);
  // Saiu de Aguardar: o motivo era de lá.
  const leavesWait = t.status === 'waiting' ? { waitReason: null } : {};
  return { ...t, ...leavesWait, status, updatedAt: at, history };
}

function withPatch(t: Task, p: z.infer<typeof TaskPatch>, by: 'you' | 'auto'): Task {
  const { status, ...fields } = p;
  const next: Task = { ...t, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() };
  const out = status ? moved(next, status, by) : next;
  // Motivo só existe em Aguardar.
  return out.status !== 'waiting' && out.waitReason ? { ...out, waitReason: null } : out;
}

function parseOr<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new TaskError(r.error.issues[0]?.message ?? 'tarefa inválida');
  return r.data;
}
