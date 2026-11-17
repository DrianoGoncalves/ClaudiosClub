import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACK_CANCELLED_DAYS, AUTO_REVIEW_ROUNDS, CHANGED_FILES_MAX, TASK_STATUSES, isClosed, satisfiesDependency, type Autonomy, type BoardConfig, type CancelRequest, type ChatItem, type ChatSnapshot, type Engine, type EngineOverride, type HeldMessage, type HumanAction, type StaffProfile, type Task, type TaskCode, type TaskCreateResult, type TaskCreateWarning, type TaskDelivery, type TaskFallback, type TaskHandoff, type TaskPause, TaskRetry, type TaskQuestion, type TaskSession, type TaskStatus, type TaskSummary, type TestRun, type TurnCapHit, type UsageStopHit } from '../shared/model';
import { kanbanProgress } from '../shared/kanbanProgress';
import { BoardConfigInput, DEFAULT_BOARD_CONFIG, readBoardConfig, writeBoardConfig } from './boardConfig';
import { codePath, type CodeEdit } from './chat/codeEdits';
import { findSecret } from './chat/secrets';
import type { SecondOpinionInput } from './adapters/codex';
import { buildHandoff, collectGit, oldConversationExtract } from './fallbackHandoff';
import { DELIVERY_SUMMARY_MAX, parseDeliveryNotes } from './deliveryNotes';
import { hasGuide } from './projectGuide';
import type { LimitHit } from './chat/usageLimit';
import { CLOSING_LINE, RESUME_TEXT } from './chat/items';
import { capReason } from './chat/turnCap';
import { ChatClosingError } from './chat/manager';
import type { Caller } from './callers';
import type { Reservation } from './resourceGate';
import { CapabilityError } from './engineCapability';
import { writeAtomic } from './staff/store';
import { checkpoint, CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';
import { ENGINE_LABEL, atHour, atMostAutonomy, autonomyOfMode, executeAutonomyOf, limitReading, limitOfStop, otherEngine, overrideOfFallback, shouldFallback, type OtherEngineReading } from './taskFallback';
import { UsageStopError } from './usageStop';
import { ESCALATE_AFTER_MS, HELD_MAX_FAILS, OUTCOME_HOLD_MAX_MS, PermanentError, REASK_AFTER_MS, REVIEW_WAIT_MS, failedRetry, isTransient, nextRetry, retryDue } from './retryPolicy';
import { appendRun, newRunId, readRuns, type RunOutcome, type RunTrigger, type TaskRunEvent } from './taskRuns';
import { hashSkillFolders } from './skillLibrary';
import { convertSkills, knownNamesOf, planSkills, type SkillSource } from './skillAccess';
import { StageTimer } from './stageTimer';

// Tarefas por projeto: `<projeto>/.myco/tasks.json`, ao lado das fichas. Cada tarefa vai para um
// funcionário; ao começar, abre uma conversa nova com a descrição. Ela anda sozinha:
//   planejando → fazendo  quando você aprova o plano no cartão de plano (o plano fica guardado);
//   fazendo → revisão     quando o turno dele termina (trabalhando → parado);
//   revisão → fazendo     quando você manda outra mensagem na conversa da tarefa;
//   revisão automática    com revisor marcado, ao entregar ele revisa sozinho (até AUTO_REVIEW_ROUNDS rodadas: a entrega e as
//                         reauditorias). A resposta vem com APROVADO ou REPROVADO na primeira linha e os achados
//                         com severidade (🔴 bloqueia, 🟡 importante, 🟢 detalhe; ver requestReview): REPROVADO só
//                         com algum 🔴. Com SPEC.md no projeto, o revisor confere o guia. Aprovada: pronto (fica em
//                         revisão se falta mesclar a worktree). Reprovada: os ajustes vão para a conversa dele, e a
//                         tarefa volta para fazendo. Estourado o limite, a tarefa fica com você.
// "Aguardar" (waiting) é sua: tarefa parada, fora da fila e do limite de ocupação, com motivo opcional. Só
// "pronto" arquiva sozinho; "pronto" também sai sozinho na aprovação.
// "Cancelada" (cancelled) fecha a tarefa sem entrega (ver `cancel`): guarda o histórico, não conta como entregue e NÃO libera quem
// depende dela (só 'done' satisfaz dependência); o dono decide, na caixa, o que fazer com os dependentes (ver `resolveCancelledBlocker`).
// `reopen` a devolve para "a fazer".
//
// Uma tarefa por vez por funcionário. Começar com ele ocupado (outra tarefa planejando ou fazendo,
// ou uma conversa dele trabalhando) põe na fila dele; quando ele fica livre, o Claudio’s Club manda primeiro
// os ajustes que você deixou em tarefas anteriores (guardados enquanto ele estava ocupado) e
// depois a próxima da fila, na ordem do quadro.
// A ordem da fila é a de entrada (`queuedAt`) até alguém reordenar (`reorder`, posição gravada em `queueRank`): o usuário mexe em qualquer card;
// o gestor, só nos que ele pediu e só trocando de lugar entre eles; o funcionário não muda a ordem, só sugere (vira aviso a quem pediu).
// O pedido para começar (`start`) pode ter prazo (`StartOpts.deadlineMs`): se a vez do funcionário ou a abertura da conversa demora mais que
// isso, quem pediu recebe a tarefa já na fila e o início segue em segundo plano (ver `start`).
//
// Nada fica esquecido (o `tick` roda na subida e a cada minuto):
//   "a fazer"  com responsável, sem dependência pendente, sem dúvida aberta e que você não tirou da fila entra na fila dele sozinho (ver
//              `enqueueIdle`): ocupado, espera a vez; livre, começa. Em Aguardar nada anda: é a coluna de quem você quer parado.
//              Com conversa (a que já trabalhou e morreu), a vez dele a retoma na mesma conversa (ver `resumeTodo`), com a checagem de ação cortada da
//              órfã: efeito incerto vai para Aguardar. O ajuste guardado enviado a ela leva o card para fazendo (ver `takeNext`).
//   "revisão"  com revisor (ver `reviewerOf`) tem de ter a conversa de revisão: a que não abriu (consumo, reinício, ficha) é refeita com backoff
//              e jitter e, passado o prazo, vai para a caixa com o motivo (ver `retryReviews`, `resumeReviews` e `stuckState`).
// A conversa de revisão roda em paralelo: não edita arquivo (abre com `reviewOnly`), então não espera o trabalho do revisor nem entra na fila de
// trabalho dele (ver `staffBusy`).

export class TaskError extends Error {}
/** Quem chamou não pode responder esta dúvida (não é o gestor que pediu, ou não é a conversa dele): 403 na rota. */
export class TaskForbiddenError extends TaskError {}
/** A dúvida já foi respondida (ou a pergunta não está mais aberta): 409 na rota. */
export class TaskConflictError extends TaskError {}

export const SAFE_ID = /^[a-z0-9-]{1,40}$/;

/** O que fazer com uma tarefa que espera por outra que foi cancelada (ou apagada): ver `resolveCancelledBlocker` e `cancel`. */
export type DependentAction = 'release' | 'cancel' | 'wait';
/** A escolha do dono, por id de tarefa. Sem entrada para uma tarefa = segue esperando, sem marca (aparece na caixa). */
export type DependentChoices = Record<string, DependentAction>;
const DEPENDENT_ACTIONS: readonly string[] = ['release', 'cancel', 'wait'];
/** Teto de escolhas por pedido (o quadro não tem tanta tarefa esperando uma só). */
const MAX_DEPENDENT_CHOICES = 500;
const dependentsSchema = z
  .record(z.string().regex(SAFE_ID, 'dependents: id de tarefa inválido'), z.enum(['release', 'cancel', 'wait'], { message: 'dependents: use release, cancel ou wait' }))
  .refine((m) => Object.keys(m).length <= MAX_DEPENDENT_CHOICES, `dependents: no máximo ${MAX_DEPENDENT_CHOICES} tarefas`);
const cancelSchema = z.object({ reason: z.string().max(2000).optional() });

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new TaskError(r.error.issues[0]?.message ?? 'pedido inválido');
  return r.data;
}

/**
 * O corpo de `POST .../tasks/:id/cancel`: `{ reason?: string, dependents?: { [taskId]: 'release' | 'cancel' | 'wait' } }`. Só a tela
 * (`fromBrowser`) decide sobre as tarefas que esperam: com o token do funcionário o campo `dependents` é ignorado (nem é lido), porque
 * o funcionário cancela a própria tarefa e não decide sobre as dos outros. TaskError (400) se o corpo é inválido.
 */
export function cancelRequest(body: unknown, fromBrowser: boolean): { reason?: string; dependents?: DependentChoices } {
  if (!fromBrowser) return parseBody(cancelSchema, body);
  return parseBody(cancelSchema.extend({ dependents: dependentsSchema.optional() }), body);
}

/**
 * O corpo de `POST .../tasks/:id/cancel-request` e de `.../cancel-request/refuse`: `{ reason: string }`, obrigatório (uma linha, até CANCEL_REASON_MAX
 * caracteres). TaskError (400) sem motivo ou com corpo inválido.
 */
export function reasonRequest(body: unknown, what: string): string {
  const { reason } = parseBody(z.object({ reason: z.string({ message: `reason: diga o motivo ${what}` }).max(2000) }), body);
  const clean = cleanReason(reason);
  if (!clean) throw new TaskError(`reason: diga o motivo ${what}`);
  return clean;
}

/** O corpo de `POST .../tasks/:id/delete`: `{ dependents?: { [taskId]: 'release' | 'cancel' | 'wait' } }` (a rota é só da tela). */
export function deleteRequest(body: unknown): { dependents?: DependentChoices } {
  return parseBody(z.object({ dependents: dependentsSchema.optional() }), body);
}

/** A escolha para `id`, se há uma válida (ignora chave herdada do protótipo e valor desconhecido). */
function choiceOf(choices: DependentChoices | undefined, id: string): DependentAction | undefined {
  if (!choices || !Object.hasOwn(choices, id)) return undefined;
  const c = choices[id];
  return c && DEPENDENT_ACTIONS.includes(c) ? c : undefined;
}

/** As tarefas abertas (não encerradas) que esperam `blockerId` direto. */
const openDependentsOf = (tasks: Task[], blockerId: string): Task[] => tasks.filter((t) => t.id !== blockerId && !isClosed(t) && t.blockedBy?.includes(blockerId));
const MAX_HISTORY = 30;
/** Conversas guardadas por tarefa (`sessions`): passando disso, sai a mais antiga. */
const MAX_SESSIONS = 50;
/** Conversa de tarefa parada há menos que isto não é dada como órfã (ver `orphan`). */
const ORPHAN_MS = 2 * 60_000;
/** Dúvidas que a tarefa leva ao gestor; a seguinte fica com você. */
const MAX_QUESTIONS = 3;
/** Falhas seguidas ao perguntar se há "continue" agendado: com este tanto, a órfã deixa de presumir que há e retoma (ver `orphan`). */
const AWAITING_FAILS_MAX = 3;
/** Pedido que o revisor recebe quando respondeu sem o veredito (ver `chaseReviews`). */
const REASK_TEXT = 'Responda com APROVADO ou REPROVADO na primeira linha, exatamente assim, e depois os achados.';
/** Pedidos de revisão que o tick faz por rodada e por projeto (ver `retryReviews` e `resumeReviews`): o resto fica para a próxima. */
const REVIEWS_PER_TICK = 3;
/** Cards de "a fazer" que a varredura põe na fila por rodada e por projeto (ver `enqueueIdle`). */
const ENQUEUE_PER_TICK = 5;
/** A nota do histórico quando o fim do turno leva a tarefa para "revisão" (ver `workDone` e `reviewLost`). */
const TURN_ENDED = 'turno terminou';
/** Motivo do cancelamento: o que passa disso é cortado (vai para a caixa, o histórico e o aviso a quem pediu). */
const CANCEL_REASON_MAX = 300;
/** Tamanho máximo da dúvida escrita e da resposta por texto. */
const QUESTION_TEXT_MAX = 2000;
/** Resumo da resposta guardado no cartão. */
const ANSWER_MAX = 300;

/** Dependências: ids de tarefas do projeto, sem repetir. Existência e ciclo são conferidos ao gravar (ver checkBlockedBy). */
const BlockedBy = z
  .array(z.string().regex(SAFE_ID, 'dependência com id inválido'))
  .max(20, 'dependências demais (máx. 20)')
  .refine((ids) => new Set(ids).size === ids.length, 'a mesma tarefa aparece mais de uma vez nas dependências');

export const TaskInput = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120, 'título longo demais (máx. 120)'),
  description: z.string().trim().max(8000).default(''),
  goal: z.string().trim().max(300, 'meta longa demais (máx. 300)').transform((v) => v || null).nullable().optional(),
  acceptance: z.string().trim().max(2000, 'critério de aceite longo demais (máx. 2000)').transform((v) => v || null).nullable().optional(),
  staffId: z.string().regex(SAFE_ID).nullable().default(null),
  reviewerId: z.string().regex(SAFE_ID).nullable().default(null),
  blockedBy: BlockedBy.default([]),
  /** false = só criar: a tarefa fica em Aguardar, sem começar. */
  start: z.boolean().default(true),
  /** Chave de idempotência (ver `TaskService.create`): quem repete o pedido (retry) manda a mesma. */
  idempotencyKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,100}$/, 'idempotencyKey: de 8 a 100 caracteres (letras, números, . _ : -); uma chave por tarefa, a mesma em cada retry do mesmo pedido')
    .optional(),
});

export const TaskPatch = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120).optional(),
  description: z.string().trim().max(8000).optional(),
  goal: z.string().trim().max(300, 'meta longa demais (máx. 300)').transform((v) => v || null).nullable().optional(),
  acceptance: z.string().trim().max(2000, 'critério de aceite longo demais (máx. 2000)').transform((v) => v || null).nullable().optional(),
  blockedBy: BlockedBy.optional(),
  staffId: z.string().regex(SAFE_ID).nullable().optional(),
  reviewerId: z.string().regex(SAFE_ID).nullable().optional(),
  status: z
    .enum(TASK_STATUSES)
    .refine((s) => s !== 'cancelled', 'para cancelar use a ação Cancelar da tarefa (cancel), não a mudança de coluna')
    .optional(),
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

/** O que o funcionário edita pela API, numa tarefa que ainda não começou (ver `TaskService.editFrom`). O resto (status, revisor, PR…) é da tela ou do fluxo. */
export const STAFF_EDITABLE = ['title', 'description', 'acceptance', 'goal', 'blockedBy', 'staffId'] as const;
export const TaskStaffEdit = TaskPatch.pick({ title: true, description: true, acceptance: true, goal: true, blockedBy: true }).extend({
  staffId: z.string({ message: 'staffId: o id de quem vai fazer a tarefa' }).regex(SAFE_ID, 'staffId inválido').optional(),
});

/** Teto da posição pedida (o quadro não tem fila de funcionário tão grande); a posição acima do tamanho da fila é recusada pelo serviço. */
const QUEUE_POSITION_MAX = 500;
/** Motivo da sugestão de ordem: uma linha, até este tamanho. */
const SUGGEST_REASON_MAX = 300;
/** Uma sugestão de ordem por tarefa neste intervalo: o aviso vai para a conversa de quem pediu, e quem a faz não pode enchê-la. */
const SUGGEST_COOLDOWN_MS = 10 * 60_000;
/** Título parecido do mesmo solicitante ao mesmo responsável dentro desta janela gera o aviso de possível duplicata na criação (só aviso; ver `duplicatesOf`). */
const DUPLICATE_WINDOW_MS = 10 * 60_000;
/** No máximo estas tarefas parecidas vão no aviso. */
const DUPLICATES_SHOWN = 3;

/**
 * O corpo de `POST .../tasks/:id/order`: exatamente um entre `to` (posição na fila, 1 = a próxima, ou 'top'), `step` (um lugar acima ou abaixo)
 * e `suggest` (só do responsável pela tarefa; pede `reason`). Campo desconhecido é recusado (400).
 */
export const TaskOrderBody = z
  .object({
    to: z.union([z.literal('top'), z.number().int().min(1).max(QUEUE_POSITION_MAX)], { message: "to: 'top' ou a posição na fila (1 em diante)" }).optional(),
    step: z.enum(['up', 'down'], { message: "step: 'up' ou 'down'" }).optional(),
    suggest: z.enum(['up', 'down', 'top'], { message: "suggest: 'up', 'down' ou 'top'" }).optional(),
    // Uma linha só: o texto vai para a conversa de quem pediu e para o histórico do card.
    reason: z
      .string()
      .trim()
      .min(1, 'reason: diga o motivo da sugestão')
      .max(SUGGEST_REASON_MAX, `reason: no máximo ${SUGGEST_REASON_MAX} caracteres`)
      .transform((v) => v.replace(/\s+/g, ' '))
      .optional(),
  })
  .strict()
  .refine((b) => [b.to, b.step, b.suggest].filter((v) => v !== undefined).length === 1, 'mande só um entre to, step e suggest')
  .refine((b) => (b.suggest === undefined) === (b.reason === undefined), 'reason vai junto de suggest (e só com ele)');
type TaskOrder = z.infer<typeof TaskOrderBody>;

/** O que `reorder` devolve: o card movido e de onde para onde (posição na fila), ou o aviso da sugestão (nada mudou). */
export type TaskOrderResult =
  | { ok: true; moved: { from: number; to: number; of: number }; task: Task }
  | { ok: true; suggested: true; notified: string };

/** A coluna da tarefa, para a recusa de edição (o mesmo nome que a tela usa). */
const COLUMN_NAME: Record<TaskStatus, string> = { waiting: 'Aguardar', todo: 'A fazer', planning: 'Planejando', doing: 'Fazendo', review: 'Revisão', done: 'Finalizado', cancelled: 'Cancelada' };

export interface TaskServiceDeps {
  /** Pasta do projeto (null: projeto não encontrado). */
  projectPath: (projectId: string) => Promise<string | null>;
  /** Projetos onde procurar tarefas quando chega um aviso de uma conversa (aprovou, terminou…). */
  projectIds: () => Promise<string[]>;
  readProfile: (projectId: string, staffId: string) => Promise<StaffProfile | null>;
  /**
   * Abre uma conversa nova com o funcionário e manda a mensagem; devolve a sessão. `override`: o motor secundário (ver `Switch`).
   * `reviewOnly`: conversa de revisão, que não edita arquivos do projeto (só a memória dele, pelo MCP); ver `requestReview`.
   */
  send: (projectId: string, staffId: string, text: string, force: boolean, override?: EngineOverride, reviewOnly?: boolean) => Promise<string>;
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
  /** Alguma conversa dele, neste projeto, no Claudio’s Club está trabalhando (turno ou segundo plano), fora `exceptSession` (uma ou várias). */
  isWorking?: (projectId: string, staffId: string, exceptSession?: string | readonly string[]) => boolean;
  /** Esta conversa (só ela) está trabalhando agora, turno ou segundo plano? Sem ela, a revisão e o card em "a fazer" olham as conversas todas do funcionário. */
  isSessionWorking?: (sessionId: string) => boolean;
  /** O servidor está fechando para reiniciar: fim de turno não conclui tarefa (a órfã do boot retoma). */
  closing?: () => boolean;
  /**
   * Gate de recursos da fila (ver resourceGate.ts): só a partida automática da próxima tarefa passa por ele (começar à mão não).
   * Ok, devolve o `release`, chamado ao fim da partida (sempre). Segurada, a tarefa fica na fila com o motivo.
   */
  resourceGate?: () => Promise<Reservation>;
  /** Manda na conversa que já existe (os ajustes guardados). */
  sendTo?: (projectId: string, sessionId: string, staffId: string, text: string, images: string[], origin?: string) => Promise<string>;
  /**
   * Aviso da plataforma na conversa que já existe (o pedido de cancelamento ao responsável): vai como o "continue" e o despertador, então não
   * conta como "você respondeu" (a tarefa em revisão não volta para fazendo) nem tira o que estava agendado na conversa.
   */
  sendNotice?: (projectId: string, sessionId: string, staffId: string, text: string) => Promise<string>;
  /** Versão de cada skill marcada (pela pasta real; chave = ref), para o registro da tentativa (padrão: hashSkillFolders; os testes trocam). */
  skillHashes?: (entries: Array<{ key: string; dir: string }>) => Promise<Record<string, string>>;
  /** As skills que existem agora (Global e do projeto), para achar a pasta de cada marcada. Sem ela, o registro sai sem versões. */
  skillSources?: (projectId: string) => Promise<{ globalSkills: SkillSource[]; projectSkills: SkillSource[] }>;
  /** Segunda opinião de outro modelo sobre o diff (o Codex, ver adapters/codex.ts); sem ele, indisponível. */
  secondOpinion?: (input: SecondOpinionInput) => Promise<string>;
  /**
   * O turno desta conversa parou no limite de uso da assinatura e o "continue" está agendado? Então ele
   * não é entrega: a tarefa fica em "fazendo" até o "continue" rodar e o turno terminar de verdade.
   */
  awaitingLimit?: (sessionId: string) => Promise<boolean>;
  /**
   * Espera a decisão de retomada automática desta conversa (turno que falhou por causa passageira, ver ChatManager.turnEnded): só depois dela
   * `turnCap` (ação cortada ou tentativas esgotadas) e `awaitingLimit` (retomada marcada) dizem o que fazer com o fim do turno.
   */
  settleRetry?: (sessionId: string) => Promise<void>;
  /** A retomada automática marcada para esta conversa (a tentativa e a hora), ou null: vai em `Task.retry` na listagem. */
  retryOf?: (sessionId: string) => Promise<TaskRetry | null>;
  /**
   * O turno desta conversa parou no teto de ferramentas ou de minutos (ver turnCap.ts) e ninguém mandou mensagem depois? Então
   * não é entrega nem órfã: a tarefa vai para Aguardar, com o motivo.
   */
  turnCap?: (sessionId: string) => TurnCapHit | null;
  /**
   * Conversa órfã (o servidor caiu no meio do turno): a última ação ficou sem resultado e mexe fora do projeto? Então já fica
   * segura na caixa (ver ChatManager.restartCut) e volta o motivo; a tarefa vai para Aguardar em vez de retomar sozinha.
   */
  restartCut?: (projectId: string, sessionId: string) => Promise<TurnCapHit | null>;
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
  /** Tira o "continue" e o despertador da conversa (motivo: troca de motor ou cancelamento da tarefa; não entrega nada). Devolve a hora do despertador, se havia um. */
  cancelContinue?: (sessionId: string) => Promise<number | null>;
  /** O título que você deu à conversa (se deu): o card automático nasce com ele. Sem ele, o título vem do pedido. */
  conversationTitle?: (sessionId: string) => Promise<string | null>;
  /** Interrompe o turno em andamento da conversa (como o botão Parar do chat); a conversa continua aberta. Sem turno, não faz nada. */
  interruptSession?: (sessionId: string) => void;
  /**
   * Nega o que a conversa ainda espera de você (o cartão do plano, uma permissão, uma pergunta) sem acionar os ganchos da tarefa: a tarefa
   * foi cancelada, e aprovar um plano pendente depois não pode executar nada. A interrupção do turno não tira o cartão.
   */
  dismissPending?: (sessionId: string, message: string) => void;
  /** Pré-checagem da troca: a conversa no motor do override abriria? Lança o erro que ela daria (ver StaffService.assertOverrideRunnable). */
  assertRunnable?: (projectId: string, staffId: string, override: EngineOverride, exceptSession?: string) => Promise<void>;
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
  /** A pergunta (AskUserQuestion) ainda está aberta na conversa de trabalho? */
  hasAsk?: (sessionId: string, requestId: string) => boolean;
  /** Responde a pergunta aberta na conversa de trabalho; false se ela já não estava aberta. `by`: quem respondeu (o gestor, se omitido). */
  answerAsk?: (sessionId: string, requestId: string, answers: Record<string, string | string[]>, by?: 'manager' | 'user') => boolean;
  /** Onde escrever o tempo das etapas do começo de uma tarefa quando ele demora (padrão: console.warn). */
  log?: (line: string) => void;
  /** A partir de quanto tempo o começo de uma tarefa escreve o tempo de cada etapa no log (padrão: `START_SLOW_MS`). */
  slowMs?: number;
}

/** A conversa da dúvida ao gestor: o que ele responde ali não é da tarefa (ver answerQuestion). */
type Role = 'work' | 'review' | 'deploy' | 'question';

const OCCUPIED: TaskStatus[] = ['planning', 'doing'];
/** Tarefas cuja conversa de troca volta no boot e segue no secundário: tudo, menos pronta (que sai do quadro ou é arquivada). */
const RESTORABLE: TaskStatus[] = ['todo', 'waiting', 'planning', 'doing', 'review'];
/** Leitura do limite do Codex na fila de início: guardada por este tempo (não abre um `codex` a cada tick). O meio do turno lê fresco. */
const CODEX_LIMIT_TTL_MS = 5 * 60_000;

/** O motor da ficha está no limite e a tarefa não pode começar agora: fica na fila até o limite baixar (ver `startPlan`). */
class LimitWaitError extends Error {}

/** A partida falhou por motivo que vale para a fila toda dele (consumo da conta ou do motor, servidor reiniciando), não por motivo da tarefa. */
const isGlobalStart = (err: unknown): err is UsageStopError | LimitWaitError | ChatClosingError => err instanceof UsageStopError || err instanceof LimitWaitError || err instanceof ChatClosingError;

/** Ainda não começou nem saiu de "a fazer"/Aguardar: a tarefa que o começo em segundo plano (ou a fila) ainda pode abrir. */
const unstarted = (t: Task) => !t.sessionId && (t.status === 'todo' || t.status === 'waiting');

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

/** O que `createFromRoutine` fez: criou; já havia a deste minuto (`idemKey`); ou a anterior da mesma rotina ainda está aberta. */
export type RoutineTask = { kind: 'created' | 'repeated' | 'open'; task: Task };

/** Quem abre a tentativa no registro (ver taskRuns.ts): o gatilho ('manual' se omitido) e, quando houver, as skills da execução. */
export interface RunStart {
  trigger?: RunTrigger;
  skills?: Record<string, string>;
}

/** O pedido de começar. `deadlineMs`: prazo para responder (ver `TaskService.start`); sem ele, espera o começo inteiro. */
export interface StartOpts extends RunStart {
  deadlineMs?: number;
}

/** Prazo das rotas (o POST de tarefa do gestor e o "Começar" da tela): passou, a resposta vem com a tarefa na fila e o começo segue sem elas. */
export const START_DEADLINE_MS = 5_000;
/** O começo de uma tarefa que passa disto escreve o tempo de cada etapa no log. */
const START_SLOW_MS = 2_000;
/** Marca de quem perdeu a corrida para o prazo (ver `start`). */
const LATE = Symbol('late');

export class TaskService {
  /**
   * sessionId → onde está a tarefa daquela conversa (e se é o trabalho, a revisão ou o deploy). `auto`: o card é automático
   * (`Task.autoCreated`), e a conversa continua sendo uma conversa direta (sem fila, troca de motor da tarefa nem mensagem guardada).
   */
  private readonly bySession = new Map<string, { projectId: string; taskId: string; role: Role; auto?: boolean }>();
  /** Edições de código por conversa, uma de cada vez; o fim do turno espera por elas (ver `onCodeEdit` e `workDone`). */
  private readonly edits = new Map<string, Promise<void>>();
  /** Conversas que a troca de motor já deixou para trás: o que chegar delas (fim do turno, limite…) não é da tarefa. */
  private readonly retired = new Set<string>();
  /** Última leitura do limite do Codex feita para a fila de início (ver readLimit). */
  private codexLimit: { at: number; value: LimitHit | null | 'unknown' } | null = null;
  private indexed = false;
  /** Quando este processo subiu: pergunta por opções de antes disso perdeu a conversa (ver restartAsks). */
  private readonly bootedAt = Date.now();
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Uma "vez de quem é" por funcionário: dois avisos juntos não começam duas tarefas. */
  private readonly kicks = new Map<string, Promise<void>>();
  /** Envios que o tick e a partida têm em voo (dúvida ao gestor, revisão automática, re-pedido): dois `tick` juntos não mandam duas vezes. */
  private readonly inFlight = new Set<string>();
  /** Falhas seguidas de `awaitingLimit` por conversa (ver `orphan`). */
  private readonly limitFails = new Map<string, number>();
  /** Quando saiu a última sugestão de ordem de cada tarefa (`projeto:tarefa`), para o intervalo `SUGGEST_COOLDOWN_MS`. Some no reinício, sem custo. */
  private readonly orderSuggested = new Map<string, number>();

  constructor(private readonly deps: TaskServiceDeps) {}

  async list(projectId: string): Promise<Task[] | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const tasks = await this.restartAsks(projectId, dir, await readTasks(dir));
    for (const t of tasks) {
      // Vários cards automáticos podem ter a mesma conversa (um por rodada de edição): vale o último, o mais novo.
      if (t.sessionId && !this.retired.has(t.sessionId)) this.bySession.set(t.sessionId, { projectId, taskId: t.id, role: 'work', ...(t.autoCreated && { auto: true }) });
      if (t.review?.sessionId) this.bySession.set(t.review.sessionId, { projectId, taskId: t.id, role: 'review' });
      if (t.deploy?.sessionId) this.bySession.set(t.deploy.sessionId, { projectId, taskId: t.id, role: 'deploy' });
      if (t.question?.managerSession) this.bySession.set(t.question.managerSession, { projectId, taskId: t.id, role: 'question' });
    }
    const pos = queuePositions(tasks);
    return Promise.all(
      tasks.map(async (t) => {
        const out = withPause(await this.withRetry(withArchive(t)), tasks);
        return pos.has(t.id) ? { ...out, queuePos: pos.get(t.id)! } : out;
      }),
    );
  }

  /** `Task.retry` na listagem: a retomada automática marcada para a conversa de uma tarefa que está "fazendo" (derivado, não gravado). Erro ao ler: sai sem. */
  private async withRetry(t: Task): Promise<Task> {
    if (!this.deps.retryOf || t.status !== 'doing' || !t.sessionId) return t;
    const retry = await this.deps.retryOf(t.sessionId).catch(() => null);
    return retry ? { ...t, retry } : t;
  }

  /**
   * Pergunta por opções de antes deste processo: a pendente na conversa morreu com ele. Vira dúvida escrita, e a resposta do
   * gestor chega como mensagem. Só o que foi perguntado antes de subir; o de agora fica como está.
   */
  private async restartAsks(projectId: string, dir: string, tasks: Task[]): Promise<Task[]> {
    const stale = (t: Task) => t.question?.source === 'ask' && t.question.status !== 'answered' && Date.parse(t.question.askedAt) < this.bootedAt;
    if (!tasks.some(stale)) return tasks;
    await this.mutate(projectId, (all) =>
      all.map((t) => (stale(t) && t.question ? noted({ ...t, question: { ...t.question, source: 'text' } }, 'dúvida de antes do reinício: a resposta do gestor chega como mensagem') : t)),
    );
    return readTasks(dir);
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
   * O motor secundário da conversa acompanha o estado da tarefa: encerrada (pronta, arquivada ou cancelada), a conversa sai do manager; saindo de
   * encerrada ou de aguardar, volta com a ficha atual. A troca que deixou a conversa antiga para trás não é do secundário: nada.
   */
  private async syncOverride(projectId: string, before: Task, after: Task): Promise<void> {
    if (!after.fallback || !after.sessionId || before.status === after.status) return;
    if (after.fallback.fromSession === after.sessionId) return;
    if (isClosed(after)) {
      this.deps.clearOverride?.(after.sessionId);
      return;
    }
    if (isClosed(before) || before.status === 'waiting') {
      const override = await this.fallbackOverride(projectId, after);
      if (override) this.deps.setOverride?.(after.sessionId, override);
      else await this.noteSecondaryMoved(projectId, after.id);
    }
  }

  /**
   * `requestedBy`: o gestor (funcionário) que pediu, pela API; recebe o resumo na entrega. `requestedSession`: a conversa dele
   * que pediu (o token dele, pela API); sem ela, a que está no turno agora.
   *
   * Idempotência: com `idempotencyKey`, o pedido repetido (retry de quem não recebeu a resposta) não cria outra tarefa. A chave vale por solicitante
   * (`requestedBy`, ou o usuário pela tela): a mesma chave com o mesmo conteúdo devolve a tarefa de antes (`idempotentReplay`), sem gravar nem
   * começar nada; com outro conteúdo, 409 (TaskConflictError). A conferência é a primeira (antes de qualquer outra: a ficha pode ter mudado desde o
   * primeiro pedido) e de novo dentro da gravação, que é uma por vez por projeto (dois pedidos juntos com a mesma chave criam uma tarefa só).
   * Sem chave, tudo como antes. Título parecido do mesmo solicitante ao mesmo responsável em `DUPLICATE_WINDOW_MS` só gera `warnings`: a tarefa é criada.
   */
  async create(projectId: string, body: unknown, requestedBy: string | null = null, requestedSession?: string): Promise<TaskCreateResult | null> {
    const input = parseOr(TaskInput, body);
    // Pedida por um gestor sem `reviewerId` no pedido: ele mesmo confere a entrega. Um `reviewerId` mandado (null inclusive) vale.
    const sentReviewer = typeof body === 'object' && body !== null && 'reviewerId' in body;
    const createKey = input.idempotencyKey ? { by: requestedBy ?? 'you', key: input.idempotencyKey, hash: contentHash(input, sentReviewer) } : undefined;
    if (createKey) {
      const dir = await this.deps.projectPath(projectId);
      if (!dir) return null;
      const prior = replayOf(await readTasks(dir), createKey);
      if (prior) return { ...prior, idempotentReplay: true };
    }
    if (input.staffId) await this.staffOrThrow(projectId, input.staffId);
    const manager = requestedBy ? await this.staffOrThrow(projectId, requestedBy) : null;
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
      goal: input.goal ?? null,
      acceptance: input.acceptance ?? null,
      ...(input.blockedBy.length && { blockedBy: input.blockedBy }),
      status: initial,
      staffId: input.staffId,
      reviewerId,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      ...(createKey && { createKey }),
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: initial, by: manager ? 'auto' : 'you', ...(manager && { note: `pedida por ${manager.name}` }) }],
    };
    const seen: { replay?: Task; warnings?: TaskCreateWarning[] } = {};
    const ok = await this.mutate(projectId, (tasks) => {
      // Outro pedido com a mesma chave gravou enquanto este esperava a vez: vale a tarefa dele.
      const prior = createKey ? replayOf(tasks, createKey) : undefined;
      if (prior) {
        seen.replay = prior;
        return tasks;
      }
      checkBlockedBy(task.id, input.blockedBy, tasks);
      seen.warnings = duplicatesOf(tasks, task, Date.parse(now));
      return [...tasks, task];
    });
    if (!ok) return null;
    if (seen.replay) return { ...seen.replay, idempotentReplay: true };
    return seen.warnings?.length ? { ...task, warnings: seen.warnings } : task;
  }

  /**
   * O POST de tarefa do gestor: `create` e, com `opts.start`, o começo (com prazo, ver `start`). O pedido já gravou quando o começo roda: se o começo
   * falhar, a resposta é a tarefa gravada (não a falha), com `startError`, porque quem recebe uma falha tenta de novo e cria a tarefa em dobro. A tarefa
   * fica em "a fazer" e a varredura do tick (`enqueueIdle`) a põe na fila. Retry com a mesma chave (`idempotentReplay`) devolve a tarefa sem começar de novo.
   * `opts.stage`: avisa em que etapa está (o cronômetro da rota).
   */
  async createAndStart(
    projectId: string,
    body: unknown,
    requestedBy: string | null,
    requestedSession: string | undefined,
    opts: { start: boolean; deadlineMs?: number; stage?: (name: string) => void },
  ): Promise<TaskCreateResult | null> {
    opts.stage?.('criar');
    const created = await this.create(projectId, body, requestedBy, requestedSession);
    if (!created || created.idempotentReplay || !opts.start) return created;
    const { warnings } = created;
    try {
      opts.stage?.('começar');
      const started = await this.start(projectId, created.id, false, { deadlineMs: opts.deadlineMs });
      return { ...(started ?? created), ...(warnings && { warnings }) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      (this.deps.log ?? ((line: string) => console.warn(line)))(`[tarefas] criar ${created.id}: gravada, mas o começo falhou: ${msg}`);
      const stored = ((await this.list(projectId).catch(() => null)) ?? []).find((t) => t.id === created.id) ?? created;
      return { ...stored, ...(warnings && { warnings }), startError: msg };
    }
  }

  /**
   * Rotina de tarefa (`mode: 'task'`): cria, na ficha, a tarefa com a mensagem da rotina como descrição. Confere dentro da própria
   * gravação (uma por vez por projeto, ver `mutate`): já existe tarefa com o mesmo `idemKey` (mesmo minuto) → não cria (`repeated`);
   * a mesma ficha tem tarefa da mesma rotina ainda não encerrada (nem pronta nem cancelada) → não cria (`open`, com a tarefa anterior). A tarefa nasce NA FILA
   * (`queuedAt`, no mesmo gravar): se o servidor cair antes de quem chama dar `kickStaff`, o tick do boot a pega. A partida vai
   * pelo `takeNext` (gatilho 'routine'), que respeita ocupação, consumo e gate de recursos.
   */
  async createFromRoutine(projectId: string, staffId: string, routine: { id: string; name: string; message: string }, minute: string): Promise<RoutineTask> {
    const idemKey = `rotina:${staffId}:${routine.id}:${minute}`;
    const now = new Date().toISOString();
    // "Rotina: <nome>" quando cabe em 120 (o nome tem até 60, então cabe sempre; o corte é a conta de quem lê).
    const prefixed = `Rotina: ${routine.name}`;
    const task: Task = {
      id: `t-${randomBytes(3).toString('hex')}`,
      title: prefixed.length <= 120 ? prefixed : routine.name.slice(0, 120),
      description: routine.message,
      goal: null,
      acceptance: null,
      staffId,
      reviewerId: null,
      routineId: routine.id,
      idemKey,
      status: 'todo',
      queuedAt: now,
      queuedForce: false,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: 'todo', by: 'auto', note: `da rotina "${routine.name}"` }],
    };
    const seen: { result?: RoutineTask } = {};
    const ok = await this.mutate(projectId, (tasks) => {
      const same = tasks.find((t) => t.idemKey === idemKey);
      if (same) {
        seen.result = { kind: 'repeated', task: same };
        return tasks;
      }
      const open = tasks.find((t) => t.staffId === staffId && t.routineId === routine.id && !isClosed(t));
      if (open) {
        seen.result = { kind: 'open', task: open };
        return tasks;
      }
      seen.result = { kind: 'created', task };
      return [...tasks, task];
    });
    if (!ok || !seen.result) throw new TaskError('projeto não encontrado');
    return seen.result;
  }

  async update(projectId: string, taskId: string, body: unknown): Promise<Task | null> {
    const patch = parseOr(TaskPatch, body);
    if (patch.staffId) await this.staffOrThrow(projectId, patch.staffId);
    // Revisor e responsável não podem ser a mesma pessoa, mesmo quando só um dos dois muda.
    const dir = await this.deps.projectPath(projectId);
    const cur = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    // Cancelada só volta pelo `reopen` (limpa os campos do cancelamento e vai para "a fazer"); a coluna não muda por aqui.
    if (cur?.status === 'cancelled' && patch.status !== undefined) throw new TaskConflictError('a tarefa foi cancelada: reabra antes de mudar de coluna');
    if (cur)
      await this.checkReviewer(
        projectId,
        patch.reviewerId !== undefined ? patch.reviewerId : (cur.reviewerId ?? null),
        patch.staffId !== undefined ? patch.staffId : cur.staffId,
        patch.reviewerId !== undefined,
      );
    let before: Task | undefined;
    const out = await this.change(projectId, taskId, (t, all) => {
      before = t;
      if (patch.blockedBy) checkBlockedBy(t.id, patch.blockedBy, all);
      const next = withPatch(t, patch, 'you');
      // Fora da fila: você tirou, trocou o responsável ou levou o cartão para outra coluna.
      const leaves = patch.queued === false || next.staffId !== t.staffId || next.status !== 'todo';
      const out = leaves && next.queuedAt ? { ...next, queuedAt: null, queuedForce: false, resourceWait: null, startRetry: undefined } : next;
      // "Tirar da fila" é escolha sua: a varredura do tick (ver `enqueueIdle`) não a põe de volta. Mudar de coluna ou de responsável solta a marca.
      const stays = t.status === 'todo' && out.status === 'todo' && out.staffId === t.staffId;
      const unqueued = patch.queued === false ? out.status === 'todo' : stays && !!t.unqueued;
      return unqueued ? { ...out, unqueued: true } : out.unqueued ? { ...out, unqueued: undefined } : out;
    });
    // Saiu de "fazendo" à mão (ou mudou de dono, ou tirou dependência): quem estava com ela pode pegar a próxima.
    for (const s of new Set([before?.staffId, out?.staffId])) if (s) void this.kick(projectId, s);
    // Virou pronta à mão: quem dependia dela pode começar (fora de qualquer `locked`, ver wakeDependents).
    if (out?.status === 'done' && before?.status !== 'done') {
      await this.wakeDependents(projectId, taskId);
      await this.settleRequester(projectId, out, 'foi para pronto', null);
    }
    // "A fazer" com responsável começa na hora (ou entra na fila dele), como "Começar". O kick acima não pega este cartão (sem queuedAt).
    const becameTodo = out?.status === 'todo' && (before?.status !== 'todo' || before?.staffId !== out.staffId);
    if (out && becameTodo && out.staffId && !out.sessionId && !out.queuedAt && patch.queued !== false) {
      try {
        return (await this.start(projectId, taskId)) ?? out;
      } catch (err) {
        // O cartão já foi gravado em "a fazer": quem não consegue começar (TaskError) não derruba a mudança.
        if (!(err instanceof TaskError)) throw err;
        return out;
      }
    }
    return out;
  }

  /**
   * Apaga a tarefa. Recusa (TaskConflictError) se outra tarefa ainda não encerrada depende dela; as encerradas (prontas ou
   * canceladas) que dependiam dela têm o id tirado de `blockedBy`. Dependente cancelada não barra.
   *
   * `opts.dependents`: o dono decide, no mesmo gesto, o que fazer com cada dependente aberta DIRETA, e só vale se o mapa cobre TODAS elas
   * (com 'release' ou 'cancel'; 'wait' não existe aqui, a bloqueadora some). Mapa incompleto ou com 'wait' numa direta: nada é aplicado e
   * a recusa é a de sempre. Tudo ou nada: o mapa é conferido contra o estado ATUAL e aplicado na MESMA gravação que apaga (uma só mutação),
   * então dependente nova que apareceu no meio do caminho recusa o pedido inteiro, sem deixar parte cancelada com a tarefa ainda de pé:
   *   - 'release': o id sai do `blockedBy` dela e, sem outra espera e na fila, o dono dela é acordado (fluxo normal);
   *   - 'cancel': ela é cancelada (motivo: "a tarefa “X” foi apagada") e as que esperavam por ela seguem o mapa como no `cancel`, onde
   *     'wait' também vale (a bloqueadora delas fica cancelada, não apagada). O que sobra do cancelamento (conversa, cascata, avisos) roda
   *     depois da gravação, como em `cancel` (ver `afterCancel`). A gravação não espera a vez do funcionário de cada uma (como `cancel`
   *     faz): quem espera por uma tarefa aberta não começa (`blockers`), então não há começo nem entrega para atravessar.
   */
  async remove(projectId: string, taskId: string, opts: { dependents?: DependentChoices } = {}): Promise<boolean> {
    const choices = opts.dependents;
    const released = new Set<string>();
    const cancelled: Array<{ before: Task; out: Task }> = [];
    let found: Task | undefined;
    const ok = await this.mutate(projectId, (tasks) => {
      found = tasks.find((t) => t.id === taskId);
      const open = found ? openDependentsOf(tasks, taskId) : [];
      // Mapa incompleto: nada é aplicado, e a recusa abaixo lista quem depende.
      const covered = !!choices && !!found && open.length > 0 && open.every((d) => choiceOf(choices, d.id) === 'release' || choiceOf(choices, d.id) === 'cancel');
      if (covered) for (const d of open) if (choiceOf(choices, d.id) === 'release') released.add(d.id);
      const cancelIds = new Set(covered ? open.filter((d) => choiceOf(choices, d.id) === 'cancel').map((d) => d.id) : []);
      const left = open.filter((t) => !released.has(t.id) && !cancelIds.has(t.id));
      if (left.length)
        throw new TaskConflictError(`outras tarefas dependem dela: ${left.map((t) => `“${t.title}”`).join(', ')}; decida o que fazer com elas ou tire a dependência antes de apagar`);
      const title = found?.title ?? '';
      return tasks
        .filter((t) => t.id !== taskId)
        .map((t) => {
          let cur = t;
          if (cancelIds.has(t.id)) {
            cur = cancelledTask(t, 'user', `a tarefa “${title}” foi apagada`);
            cancelled.push({ before: t, out: cur });
          }
          if (!cur.blockedBy?.includes(taskId)) return cur;
          if (!released.has(cur.id) || isClosed(cur)) return { ...cur, blockedBy: cur.blockedBy.filter((d) => d !== taskId) };
          const rest = cur.blockedBy.filter((d) => d !== taskId);
          const { blockedBy: _, ...others } = withoutAck(cur, taskId);
          return noted({ ...others, ...(rest.length && { blockedBy: rest }) }, `liberada da espera por “${title}” (apagada)`);
        });
    });
    // As canceladas pelo mapa: o que o cancelamento faz depois de gravar (conversa, cascata pelo mesmo mapa, avisos, fila).
    for (const c of cancelled) {
      await this.syncOverride(projectId, c.before, c.out);
      await this.afterCancel(projectId, c.before, c.out, { by: 'user', reason: c.out.cancelReason ?? null, dependents: choices });
    }
    // Apagada com tentativa aberta: o registro fecha como cancelada (o registro em si fica, é append-only).
    await this.logEnd(projectId, found, 'cancelled', 'tarefa apagada');
    if (found?.staffId) void this.kick(projectId, found.staffId);
    // Liberadas sem outra espera: o dono delas pega a vez (o `takeNext` confere a fila e o limite de ocupação).
    if (ok && found && released.size) {
      const all = (await this.list(projectId)) ?? [];
      for (const d of all) if (released.has(d.id) && d.staffId && !isClosed(d) && !blockers(d, all).length) void this.kick(projectId, d.staffId);
    }
    // Apagada a última aberta do gestor: as aprovadas retidas dele saem agora. Encerrada (pronta ou cancelada) já avisou ao fechar.
    if (ok && found && !isClosed(found)) await this.settleRequester(projectId, found, 'foi apagada', null);
    return !!ok && !!found;
  }

  /**
   * Cancela a tarefa, de qualquer status não encerrado (TaskConflictError se já está pronta ou cancelada): ela fecha sem entrega, guarda
   * o histórico e a conversa, e NÃO libera quem depende dela (cancelada bloqueia, ver `blockers`). `by`: 'user' (a tela) ou o id do
   * funcionário que cancela a própria tarefa (ver `cancelFrom`). Ordem, para o fim do turno não entregar nada:
   *   1. grava "cancelada" (com a vez do funcionário, como começar e entregar), ANTES de parar a conversa: o `workDone`, o `onIdle`, a
   *      órfã e a troca de motor já veem que não é mais "fazendo" (e `workDone` tem a guarda explícita);
   *   2. interrompe o turno em andamento (o da conversa de trabalho e também o da revisão e o do deploy, se houver), nega o plano ou a
   *      permissão que ainda esperavam resposta; fecha a tentativa aberta no registro ('cancelled'); tira o "continue" do limite e o despertador;
   *   3. avisa quem pediu a tarefa e os gestores de quem esperava por ela, e anda a fila do funcionário.
   * Não apaga branch nem worktree e não desfaz o que já foi alterado. Veredito de revisão que chegar depois é ignorado (ver `approve`).
   *
   * `dependents` (só da tela): a escolha do dono para cada tarefa que esperava por ela, aplicada depois de cancelar com o que
   * `resolveCancelledBlocker` faz ('release', 'cancel', 'wait'). Cada dependente aberta DIRETA segue o mapa; 'cancel' faz a cascata
   * continuar nas que esperavam por essa, com o mesmo mapa (cada tarefa é cancelada uma vez só, então ciclo e dependente de duas
   * canceladas da cascata não repetem nem travam). Sem entrada no mapa a dependente fica esperando e aparece na caixa; entrada de quem
   * não depende de uma cancelada é ignorada. Dependente que mudou entre a leitura e a ação (409) é pulada.
   */
  async cancel(projectId: string, taskId: string, opts: { by: string; reason?: string | null; dependents?: DependentChoices; guard?: (t: Task) => void }): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const reason = cleanReason(opts.reason);
    const run = async () => {
      const seen: { before?: Task } = {};
      const out = await this.change(projectId, taskId, (t) => {
        if (isClosed(t)) throw new TaskConflictError(t.status === 'done' ? 'a tarefa já está pronta' : 'a tarefa já foi cancelada');
        // `guard`: a condição de quem cancela, conferida aqui (no que está gravado agora, na vez do funcionário): ver `cancelByRequester`.
        opts.guard?.(t);
        seen.before = t;
        return cancelledTask(t, opts.by, reason);
      });
      return { out, before: seen.before };
    };
    const staffId = (await readTasks(dir)).find((t) => t.id === taskId)?.staffId;
    const { out, before } = staffId ? await this.locked(projectId, staffId, run) : await run();
    if (!out || !before) return null;
    await this.afterCancel(projectId, before, out, { by: opts.by, reason, dependents: opts.dependents });
    return out;
  }

  /**
   * O que vem depois de gravar "cancelada" (por `cancel`, ou pela exclusão com mapa, ver `remove`): a conversa e o resto, a tentativa
   * fechada, a escolha do dono sobre quem esperava, os avisos e a fila. Daqui para a frente tudo é "o que sobrou": a tarefa já está
   * cancelada, então uma falha ao parar uma conversa não desfaz nada nem derruba o pedido. `before`: a tarefa como estava; `out`: como ficou.
   */
  private async afterCancel(projectId: string, before: Task, out: Task, opts: { by: string; reason: string | null; dependents?: DependentChoices }): Promise<void> {
    // A conversa de trabalho e também a de revisão e a de deploy (se houver): nenhuma continua por conta de uma tarefa que não entrega.
    // Card automático: a conversa de trabalho é a sua conversa direta, e cancelar o registro não a interrompe.
    for (const sessionId of new Set([before.autoCreated ? null : before.sessionId, before.review?.sessionId, before.deploy?.sessionId])) if (sessionId) await this.silenceSession(sessionId);
    const { reason } = opts;
    await this.logEnd(projectId, before, 'cancelled', reason ? `tarefa cancelada: ${reason}` : 'tarefa cancelada');
    // O que o dono decidiu, no mesmo gesto, sobre quem esperava por ela. Antes do aviso abaixo, que só conta quem ficou esperando.
    const direct = openDependentsOf((await this.list(projectId)) ?? [], out.id);
    if (opts.dependents) await this.applyDependentChoices(projectId, out, opts.dependents);
    // Quem esperava por ela (gestor de cada dependente) fica sabendo; a caixa do dono mostra o par (ver stuckDependencies).
    this.warnDependents(projectId, out.id, stuckReason(out));
    if (out.requestedBy) {
      const who = opts.by === 'user' ? 'pelo usuário' : `por ${(await this.deps.readProfile(projectId, opts.by).catch(() => null))?.name ?? 'o funcionário'}`;
      // O que ficou de quem esperava: o que o dono decidiu (liberar, cancelar junto, continuar esperando) ou "segue esperando" para o que ele não decidiu.
      const line = dependentsLine(direct, (await this.list(projectId)) ?? [], out.id);
      const text = `[MyCo] Tarefa “${out.title}” (id ${out.id}) foi cancelada ${who}${reason ? `: ${reason}` : ''}. Não haverá entrega; o que já foi feito continua na branch e na worktree.${line ? ` ${line}` : ''}`;
      // Quem pediu foi quem cancelou: ele já sabe (a resposta do pedido dele diz). Só as aprovadas retidas dele, se esta era a última aberta, ainda saem.
      await this.settleRequester(projectId, out, 'foi cancelada', opts.by === out.requestedBy ? null : text, true);
    }
    if (out.staffId) void this.kick(projectId, out.staffId);
  }

  /**
   * Para o que a conversa ainda faz por conta da tarefa cancelada: interrompe o turno (como o botão Parar; a conversa continua aberta),
   * nega o que esperava de você (o cartão do plano não executa nada depois), assenta o limite que acabou de agendar o "continue" e tira
   * o "continue" e o despertador. Cada passo falha em silêncio (sem turno aberto, conversa fechada).
   */
  private async silenceSession(sessionId: string): Promise<void> {
    try {
      this.deps.interruptSession?.(sessionId);
    } catch {
      // sem turno aberto
    }
    try {
      this.deps.dismissPending?.(sessionId, 'A tarefa foi cancelada: não execute nada.');
    } catch {
      // conversa já fechada
    }
    // O limite que acabou de agendar o "continue" tem de ter terminado de agendar para o cancelamento pegá-lo.
    await this.deps.settleLimit?.(sessionId).catch(() => {});
    await this.deps.cancelContinue?.(sessionId).catch(() => {});
  }

  /**
   * O funcionário cancela uma tarefa pela API, em dois casos (a identidade é sempre a do token, nunca a declarada no corpo):
   *   - o responsável cancela a dele (o usuário pediu na conversa da tarefa, ou ele aceita um pedido de cancelamento, ver `requestCancel`). Só vale com o
   *     token da conversa ATUAL da tarefa (a de trabalho, `sessionId`): outra conversa dele ou a de um revisor levam 403 (TaskForbiddenError);
   *   - quem pediu a tarefa (`requestedBy`) cancela a que ELE criou e que nunca começou (ver `cancelByRequester`), com motivo obrigatório.
   * O revisor e qualquer outro levam 403. Tarefa que não existe: null.
   */
  async cancelFrom(projectId: string, taskId: string, caller: Caller | null, reason?: string | null): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!task) return null;
    if (isWorkerOf(task, caller, projectId)) return this.cancel(projectId, taskId, { by: caller!.staffId!, reason });
    if (caller?.staffId && caller.projectId === projectId && task.requestedBy === caller.staffId) return this.cancelByRequester(projectId, task, caller.staffId, reason);
    throw new TaskForbiddenError('só o funcionário da tarefa, pela conversa dela, ou quem a pediu (se ela nunca começou) cancela a tarefa por aqui; o usuário cancela pelo Claudio’s Club');
  }

  /**
   * Quem pediu a tarefa a cancela, com motivo obrigatório, SE ELA NUNCA COMEÇOU (`neverStarted`: a coluna não basta, olha conversa, tentativa, histórico e
   * entrega). A conferência roda dentro da gravação, na vez do responsável (a mesma de `start` e da fila): uma partida que já está abrindo a conversa termina
   * antes, e este pedido a encontra começada (409); uma que vem depois encontra a tarefa cancelada e não começa. Tarefa que já começou: 409, o caminho é o pedido de cancelamento
   * (`requestCancel`). O que já foi feito não é desfeito (nada foi feito, se nunca começou).
   */
  private async cancelByRequester(projectId: string, task: Task, me: string, reason: string | null | undefined): Promise<Task | null> {
    const why = mandatoryReason(reason, 'do cancelamento');
    return this.cancel(projectId, task.id, {
      by: me,
      reason: why,
      guard: (t) => {
        if (t.requestedBy !== me) throw new TaskForbiddenError('só quem pediu a tarefa a cancela por aqui');
        if (!neverStarted(t))
          throw new TaskConflictError(
            `a tarefa já começou (ou já teve conversa): quem a faz decide. Mande um pedido de cancelamento com o motivo, POST ${CANCEL_REQUEST_ROUTE(projectId, t.id)}`,
          );
      },
    });
  }

  /**
   * Quem pediu a tarefa pede o cancelamento dela ao responsável, com motivo obrigatório, quando ela JÁ COMEÇOU (o que nunca começou ele cancela direto, ver
   * `cancelByRequester`: 409 aqui). Só o dono do token que a pediu (403 para o responsável, o revisor, outro gestor e quem não tem token). O pedido fica em
   * `Task.cancelRequest` (com uma nota no histórico) e é ENTREGUE na conversa do responsável (ver `deliverCancelRequest`: o tick o refaz depois de reinício,
   * troca de conversa ou falha). Um pedido aberto por vez (409 com outro `pending`); depois de decidido ou sem efeito, outro pode ser feito. O responsável
   * aceita cancelando (`cancelFrom`) ou recusa com o porquê (`refuseCancel`). A tarefa encerrada: 409. Tarefa que não existe: null.
   */
  async requestCancel(projectId: string, taskId: string, caller: Caller | null, reason: string | null | undefined): Promise<Task | null> {
    const me = staffOfCaller(caller, projectId, 'pede o cancelamento de uma tarefa');
    const dir = await this.deps.projectPath(projectId);
    const first = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!first) return null;
    if (first.requestedBy !== me) throw new TaskForbiddenError('só quem pediu a tarefa pede o cancelamento dela');
    const why = mandatoryReason(reason, 'do pedido de cancelamento');
    const mine = await this.staffOrThrow(projectId, me);
    const run = () =>
      this.change(projectId, taskId, (t) => {
        if (t.requestedBy !== me) throw new TaskForbiddenError('só quem pediu a tarefa pede o cancelamento dela');
        if (isClosed(t)) throw new TaskConflictError(t.status === 'done' ? 'a tarefa já está pronta' : 'a tarefa já foi cancelada');
        if (neverStarted(t)) throw new TaskConflictError(`a tarefa nunca começou: cancele direto, POST ${CANCEL_ROUTE(projectId, t.id)} com o motivo (reason)`);
        if (t.cancelRequest?.status === 'pending') throw new TaskConflictError('já há um pedido de cancelamento desta tarefa esperando a decisão de quem a faz');
        const cancelRequest: CancelRequest = { by: me, reason: why, at: new Date().toISOString(), status: 'pending' };
        return noted({ ...t, cancelRequest }, `pedido de cancelamento de ${mine.name}: ${why}`);
      });
    // Na vez do responsável (a de `start`): a conferência "já começou" vale contra uma partida em andamento.
    const out = first.staffId ? await this.locked(projectId, first.staffId, run) : await run();
    if (!out) return null;
    await this.deliverCancelRequest(projectId, taskId);
    return (await this.fresh(projectId, taskId)) ?? out;
  }

  /**
   * O responsável RECUSA o pedido de cancelamento (aceitar é cancelar a tarefa, `cancelFrom`), dizendo por quê (obrigatório). Só com o token da conversa
   * ATUAL da tarefa, como `cancelFrom` (403 para os outros, inclusive quem pediu). A decisão (`refused`, `answer`, quando e quem) fica em `Task.cancelRequest` e
   * no histórico, e quem pediu é avisado, na conversa em que pediu (se o aviso falhar, o tick o refaz: `notifyRetry`). 409 sem pedido esperando decisão
   * ou com a tarefa encerrada. Tarefa que não existe: null.
   */
  async refuseCancel(projectId: string, taskId: string, caller: Caller | null, reason: string | null | undefined): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const first = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!first) return null;
    if (!isWorkerOf(first, caller, projectId)) throw new TaskForbiddenError('só o funcionário da tarefa, pela conversa dela, recusa o pedido de cancelamento');
    const me = caller!.staffId!;
    const why = mandatoryReason(reason, 'da recusa');
    const [mine, asker] = await Promise.all([this.staffOrThrow(projectId, me), first.cancelRequest ? this.deps.readProfile(projectId, first.cancelRequest.by) : null]);
    const run = () =>
      this.change(projectId, taskId, (t) => {
        if (isClosed(t)) throw new TaskConflictError(t.status === 'done' ? 'a tarefa já está pronta' : 'a tarefa já foi cancelada');
        // Na vez dele, de novo: a tarefa pode ter trocado de responsável ou de conversa desde a leitura.
        if (!isWorkerOf(t, caller, projectId)) throw new TaskForbiddenError('só o funcionário da tarefa, pela conversa dela, recusa o pedido de cancelamento');
        const cr = t.cancelRequest;
        if (cr?.status !== 'pending') throw new TaskConflictError('não há pedido de cancelamento esperando decisão nesta tarefa');
        const at = new Date().toISOString();
        const decided: CancelRequest = { ...cr, status: 'refused', decidedAt: at, decidedBy: me, answer: why, waiting: undefined, retry: undefined, notifyRetry: { attempts: 0, nextAt: at, firstAt: at } };
        return noted({ ...t, cancelRequest: decided }, `pedido de cancelamento de ${asker?.name ?? 'quem pediu'} recusado por ${mine.name}: ${why}`);
      });
    const out = await this.locked(projectId, first.staffId!, run);
    if (!out) return null;
    await this.tellRefusal(projectId, taskId);
    return (await this.fresh(projectId, taskId)) ?? out;
  }

  /**
   * Leva o pedido de cancelamento (`Task.cancelRequest` em `pending`) à conversa ATUAL do responsável (`sessionId`), como aviso da plataforma (`sendNotice`: não
   * move a tarefa em revisão nem tira o "continue" agendado). Quando entra (ou volta a entrar) na vez dele (a de `start`): sem conversa, nada (o tick tenta
   * quando ela existir); responsável em outra tarefa ou conversa, o pedido espera a vez (`waiting`), sem contar como falha, porque ele só trabalha numa coisa por
   * vez; envio que falha vira `retry` com backoff (o tick repete). Grava `deliveredAt` e a conversa (`deliveredSession`). Um por vez por tarefa.
   */
  private async deliverCancelRequest(projectId: string, taskId: string): Promise<void> {
    const key = `cancel-request:${projectId}:${taskId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const first = await this.fresh(projectId, taskId);
      if (!first || !cancelDeliveryDue(first, this.bootedAt)) return;
      const staffId = first.staffId!;
      await this.locked(projectId, staffId, async () => {
        const t = await this.fresh(projectId, taskId);
        // Na vez dele, de novo: decidido, cancelado ou entregue por outro caminho enquanto esperava.
        if (!t || !cancelDeliveryDue(t, this.bootedAt) || t.staffId !== staffId) return;
        const sessionId = t.sessionId!;
        const tasks = (await this.list(projectId)) ?? [];
        const busyWith = occupant(tasks, staffId, t.id);
        if (busyWith || this.staffBusy(projectId, tasks, staffId, sessionId)) {
          const name = (await this.deps.readProfile(projectId, staffId))?.name ?? 'o responsável';
          const waiting = busyWith ? `${name} está em “${busyWith.title}”` : `${name} está numa conversa`;
          await this.change(projectId, taskId, (x) => (x.cancelRequest?.status === 'pending' && x.cancelRequest.waiting !== waiting ? { ...x, cancelRequest: { ...x.cancelRequest, waiting } } : x));
          return;
        }
        try {
          const send = this.deps.sendNotice;
          if (!send) throw new PermanentError('sem como mandar o aviso à conversa do responsável');
          await send(projectId, sessionId, staffId, await this.cancelRequestText(projectId, t, t.cancelRequest!));
          const at = new Date().toISOString();
          await this.change(projectId, taskId, (x) => (x.cancelRequest?.status === 'pending' ? { ...x, cancelRequest: { ...x.cancelRequest, deliveredAt: at, deliveredSession: sessionId, waiting: undefined, retry: undefined } } : x));
        } catch (err) {
          const now = new Date();
          await this.change(projectId, taskId, (x) => (x.cancelRequest?.status === 'pending' ? { ...x, cancelRequest: { ...x.cancelRequest, retry: failedRetry(x.cancelRequest.retry, err, now) } } : x)).catch(() => {});
        }
      });
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** O pedido de cancelamento como o responsável o lê: quem pede e por quê, e os dois caminhos (cancelar, ou recusar com o porquê), pelo endereço do motor da conversa dele. */
  private async cancelRequestText(projectId: string, t: Task, cr: CancelRequest): Promise<string> {
    const [asker, worker] = await Promise.all([this.deps.readProfile(projectId, cr.by), t.staffId ? this.deps.readProfile(projectId, t.staffId) : null]);
    const engine: Engine = t.sessions?.find((s) => s.id === t.sessionId)?.engine ?? t.fallback?.engine ?? (worker?.engine === 'codex' ? 'codex' : 'claude');
    const api = engine === 'codex' ? this.deps.sandboxApiUrl : this.deps.apiUrl;
    if (!api) throw new PermanentError('sem endereço da API: quem faz a tarefa não tem como decidir');
    const curl = (route: string, hint: string) => `curl -s -X POST -H "x-myco: 1" -H "x-myco-token: $MYCO_TOKEN" -H "content-type: application/json" -d '{"reason": "${hint}"}' ${api}${route}`;
    const who = asker ? `${asker.name} (${asker.role})` : 'Quem pediu a tarefa';
    return [
      `[MyCo] Pedido de cancelamento da tarefa “${t.title}” (id \`${t.id}\`): ${who}, que a pediu, quer cancelá-la. Motivo: “${cr.reason}”.`,
      'Decida antes de seguir com o trabalho (até decidir, não gaste mais esforço nela):',
      `- Aceitar: cancele pela API do Claudio’s Club com \`${curl(CANCEL_ROUTE(projectId, t.id), '<o motivo, em uma frase>')}\` (o token da sua conversa já está em $MYCO_TOKEN; escreva o motivo sem aspas simples) e pare por aí, sem mais nada. Cancelar não desfaz o que já foi feito: continua na branch e na worktree.`,
      `- Recusar (a tarefa deve seguir): diga por quê com \`${curl(`${CANCEL_REQUEST_ROUTE(projectId, t.id)}/refuse`, '<por que a tarefa segue, em uma frase>')}\` e continue. ${asker?.name ?? 'Quem pediu'} é avisado do seu motivo.`,
      'O pedido e a sua decisão ficam registrados na tarefa. Se não estiver claro o que fazer, pergunte ao usuário antes de decidir.',
    ].join('\n');
  }

  /**
   * Avisa quem pediu a tarefa que o responsável recusou o pedido de cancelamento, e o motivo dele, na conversa em que pediu. A marca `notifyRetry` é gravada junto da recusa
   * (a decisão e a obrigação de avisar nascem juntas) e sai quando o aviso chega; falhando, o tick refaz com backoff. Um por vez por tarefa.
   */
  private async tellRefusal(projectId: string, taskId: string): Promise<void> {
    const key = `cancel-refusal:${projectId}:${taskId}`;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const t = await this.fresh(projectId, taskId);
      const cr = t?.cancelRequest;
      if (!t || !cr || cr.status !== 'refused' || !cr.notifyRetry || !t.requestedBy) return;
      try {
        const notify = this.deps.notify;
        if (!notify) throw new PermanentError('sem como avisar quem pediu a tarefa');
        const worker = t.staffId ? await this.deps.readProfile(projectId, t.staffId) : null;
        await notify(
          projectId,
          t.requestedBy,
          `[MyCo] ${worker?.name ?? 'Quem faz a tarefa'} recusou o seu pedido de cancelar a tarefa “${t.title}” (id ${t.id}). Motivo dele: “${cr.answer}”. A tarefa segue; o pedido e a recusa estão no histórico dela. Se ainda quiser tirá-la, fale com o usuário: só ele cancela à força, pelo Claudio’s Club.`,
          t.requestedSession ?? null,
        );
        await this.change(projectId, taskId, (x) => (x.cancelRequest?.status === 'refused' ? { ...x, cancelRequest: { ...x.cancelRequest, notifyRetry: undefined } } : x));
      } catch (err) {
        const now = new Date();
        await this.change(projectId, taskId, (x) => (x.cancelRequest?.status === 'refused' && x.cancelRequest.notifyRetry ? { ...x, cancelRequest: { ...x.cancelRequest, notifyRetry: failedRetry(x.cancelRequest.notifyRetry, err, now) } } : x)).catch(() => {});
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** O tick: pedido de cancelamento que ainda precisa chegar ao responsável (ver `cancelDeliveryDue`) e aviso de recusa que não chegou a quem pediu; o backoff manda. */
  private async retryCancelRequests(projectId: string, tasks: Task[], now: Date): Promise<void> {
    const at = now.getTime();
    for (const t of tasks) {
      const cr = t.cancelRequest;
      if (!cr) continue;
      if (cr.status === 'refused' && cr.notifyRetry && retryDue(cr.notifyRetry, at)) await this.tellRefusal(projectId, t.id);
      else if (cancelDeliveryDue(t, this.bootedAt) && (!cr.retry || retryDue(cr.retry, at))) await this.deliverCancelRequest(projectId, t.id);
    }
  }

  /**
   * O funcionário edita pela API (`STAFF_EDITABLE`) uma tarefa que ainda não começou: em Aguardar ou A fazer, sem conversa. Só com o token da
   * conversa dele, e só quem pediu a tarefa (`requestedBy`) ou o gestor de quem a faz; quem a faz não a edita (o critério de pronto não é de quem
   * entrega). Não muda a coluna nem tira da fila; trocar o responsável (só para quem reporta a quem edita) leva a tarefa de A fazer ao fim da
   * fila do novo. Os campos mandados substituem os atuais. 403 (TaskForbiddenError) sem permissão, 409 (TaskConflictError) se a tarefa já
   * começou, TaskError (400) no pedido; tarefa que não existe: null.
   *
   * A checagem de coluna é a da própria gravação (`change`, uma por vez por projeto) e a edição espera a vez do funcionário (a mesma de `start`
   * e da fila): a partida que já está abrindo a conversa termina antes (a tarefa vira "fazendo" e a edição é recusada), e a que vem depois lê o
   * texto já editado. Sem a vez, o funcionário já chamado com o texto antigo ficaria sem saber da edição gravada.
   */
  async editFrom(projectId: string, taskId: string, caller: Caller | null, body: unknown): Promise<Task | null> {
    const me = caller?.staffId;
    if (!me || caller.projectId !== projectId) throw new TaskForbiddenError('só um funcionário, com o token da conversa dele (x-myco-token), edita tarefa por aqui; o usuário edita pelo Claudio’s Club');
    const dir = await this.deps.projectPath(projectId);
    const first = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!dir || !first) return null;
    const run = async () => {
      const task = (await readTasks(dir)).find((t) => t.id === taskId);
      if (!task) return null;
      // A vez foi pedida pelo responsável de antes: se ele mudou nesse meio tempo, o que vale é a leitura nova (outra vez).
      if (task.staffId !== first.staffId) throw new TaskConflictError('a tarefa mudou de responsável enquanto você a editava; leia de novo e tente outra vez');
      const mine = await this.deps.readProfile(projectId, me);
      if (!mine) throw new TaskForbiddenError('funcionário não encontrado neste projeto');
      if (task.staffId === me) throw new TaskForbiddenError('quem faz a tarefa não a edita (o critério de pronto não é de quem entrega); peça a quem a passou');
      const manages = !!task.staffId && !!(await this.deps.readProfile(projectId, task.staffId))?.reportsTo.includes(me);
      if (task.requestedBy !== me && !manages) throw new TaskForbiddenError('só quem pediu a tarefa ou o gestor de quem a faz a edita por aqui');
      // `requestedBy` é o hábito de quem passa tarefa: quem edita é o dono do token, então o declarado não conta.
      const sent = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).filter((k) => k !== 'requestedBy') : [];
      const extra = sent.filter((k) => !(STAFF_EDITABLE as readonly string[]).includes(k));
      if (extra.length) throw new TaskError(`campo que não se edita por aqui: ${extra.join(', ')} (só ${STAFF_EDITABLE.join(', ')})`);
      const { requestedBy: _, ...fields } = (body ?? {}) as Record<string, unknown>;
      const patch = parseOr(TaskStaffEdit, fields);
      if (Object.values(patch).every((v) => v === undefined)) throw new TaskError(`nada para editar: mande ao menos um de ${STAFF_EDITABLE.join(', ')}`);
      // Quem recebe: só quem reporta a quem edita (como ao passar a tarefa). Quem já é o responsável não conta como troca.
      const owner = patch.staffId && patch.staffId !== task.staffId ? await this.staffOrThrow(projectId, patch.staffId) : null;
      if (owner && !owner.reportsTo.includes(me)) throw new TaskForbiddenError('só dá para passar a tarefa a quem reporta a você');
      const seen: { before?: Task } = {};
      const out = await this.change(projectId, taskId, (t, all) => {
        // Daqui para baixo vale o que está gravado agora: a tela ou outro caminho pode ter mexido desde a leitura acima.
        if (t.status !== 'waiting' && t.status !== 'todo')
          throw new TaskConflictError(`a tarefa está em “${COLUMN_NAME[t.status]}”: por aqui só se edita em Aguardar e A fazer; o complemento vai pela conversa da tarefa`);
        if (t.sessionId) throw new TaskConflictError('a tarefa já começou (tem conversa): o complemento vai pela conversa dela, e uma edição aqui não chegaria a quem faz');
        if (t.staffId !== task.staffId || (t.requestedBy ?? null) !== (task.requestedBy ?? null)) throw new TaskConflictError('a tarefa mudou enquanto você a editava; leia de novo e tente outra vez');
        if (patch.blockedBy) checkBlockedBy(t.id, patch.blockedBy, all);
        if (owner && t.reviewerId === owner.id) throw new TaskError(`${owner.name} é o revisor desta tarefa: a revisão precisa ser de outro funcionário`);
        seen.before = t;
        const note = `editada por ${mine.name}: ${STAFF_EDITABLE.filter((k) => patch[k] !== undefined).join(', ')}${owner ? ` (agora com ${owner.name})` : ''}`;
        const next = noted(withPatch(t, patch, 'auto'), note);
        // Outro responsável: a vaga na fila é do novo, no fim (a posição antiga era na fila do outro); sem o que a partida anterior deixou.
        return owner && next.queuedAt ? { ...next, queuedAt: new Date().toISOString(), queueRank: undefined, queuedForce: false, resourceWait: null, startRetry: undefined } : next;
      });
      return out && seen.before ? { out, before: seen.before } : null;
    };
    const done = first.staffId ? await this.locked(projectId, first.staffId, run) : await run();
    if (!done) return null;
    // Quem perdeu a tarefa, quem a ganhou e o dono dela (se saiu uma dependência): quem estiver livre pega a vez (o `takeNext` confere fila e ocupação).
    for (const s of new Set([done.before.staffId, done.out.staffId])) if (s) void this.kick(projectId, s);
    return done.out;
  }

  /**
   * Muda a ordem da fila de um funcionário (`Task.queueRank`) ou, do responsável, sugere a ordem. Corpo: `TaskOrderBody`. Quem pode:
   *   - o usuário (`fromBrowser`): qualquer card da fila de qualquer funcionário, para uma posição (`to`: número ou 'top') ou um lugar acima ou
   *     abaixo (`step`);
   *   - o gestor que pediu o card (`requestedBy`, com o token da conversa dele): só os cards que ele pediu e só `step`. O card troca de lugar com o card
   *     dele mais próximo na fila, então nenhum card de outro solicitante muda de posição (furar a fila de outro é só do usuário). `to` é 403;
   *   - o responsável pela tarefa: nunca muda a ordem (403); `suggest` + `reason` vira aviso a quem pediu o card e não altera nada (ver `suggestOrder`);
   *   - qualquer outro: 403.
   * Só se reordena card na fila (A fazer, com `queuedAt`): outro, ou movimento que não muda nada, é 409. Tarefa que não existe: null. Cada movimento
   * deixa uma nota no histórico do card movido (quem moveu, de que posição para qual). A permissão é desta função, não da tela.
   */
  async reorder(projectId: string, taskId: string, caller: Caller | null, fromBrowser: boolean, body: unknown): Promise<TaskOrderResult | null> {
    const me = fromBrowser ? null : (caller?.staffId ?? null);
    if (!fromBrowser && (!me || caller?.projectId !== projectId)) throw new TaskForbiddenError('só o usuário (pelo Claudio’s Club) ou um funcionário, com o token da conversa dele (x-myco-token), mexe na ordem da fila');
    const order = parseOr(TaskOrderBody, body ?? {});
    const dir = await this.deps.projectPath(projectId);
    const all = dir ? await readTasks(dir) : [];
    const first = all.find((t) => t.id === taskId);
    if (!dir || !first) return null;
    if (fromBrowser) {
      if (order.suggest !== undefined) throw new TaskError('a sugestão é de quem faz a tarefa; o usuário reordena com to ou step');
    } else if (first.staffId === me) {
      // Quem faz a tarefa não escolhe o que vem antes dela: a ordem é de quem pediu (e do usuário), senão o executor se priorizaria.
      if (order.suggest === undefined) throw new TaskForbiddenError('quem faz a tarefa não muda a ordem da fila: mande uma sugestão (suggest e reason) e quem pediu decide');
    } else if (first.requestedBy && first.requestedBy === me) {
      if (order.suggest !== undefined) throw new TaskError('quem pediu a tarefa reordena (step: up ou down), não sugere');
      if (order.step === undefined) throw new TaskForbiddenError('o gestor só sobe ou desce (step) as tarefas que pediu; furar a fila de outro solicitante é só do usuário');
    } else {
      throw new TaskForbiddenError('só quem pediu a tarefa (ou o usuário) muda a ordem; quem faz a tarefa só sugere');
    }
    if (order.suggest !== undefined) return this.suggestOrder(projectId, first, me!, queueOf(all, first.staffId!), order.suggest, order.reason!);
    if (!inQueue(first)) throw new TaskConflictError('a tarefa não está na fila: só se reordena o que está em A fazer esperando a vez do responsável');
    const [owner, actor] = await Promise.all([this.staffOrThrow(projectId, first.staffId!), me ? this.deps.readProfile(projectId, me) : null]);
    const who = fromBrowser ? 'você' : (actor?.name ?? me!);
    const seen: { from?: number; to?: number; of?: number } = {};
    const ok = await this.mutate(projectId, (tasks) => {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) return tasks;
      // Daqui para baixo vale o que está gravado agora: a vez dele ou a tela pode ter mexido desde a leitura acima.
      if (t.staffId !== first.staffId || (t.requestedBy ?? null) !== (first.requestedBy ?? null)) throw new TaskConflictError('a tarefa mudou enquanto você a reordenava; leia de novo e tente outra vez');
      if (!inQueue(t)) throw new TaskConflictError('a tarefa saiu da fila (já começou, ou mudou de coluna): leia de novo');
      const queue = queueOf(tasks, t.staffId!);
      const next = reordered(queue, t.id, order, fromBrowser ? () => true : (x) => x.requestedBy === me);
      const from = queue.findIndex((x) => x.id === t.id);
      if (!next) throw new TaskConflictError(order.step ? `já é a ${order.step === 'up' ? 'primeira' : 'última'} ${fromBrowser ? 'da fila' : 'das suas na fila'}` : 'a tarefa já está nessa posição');
      const to = next.findIndex((x) => x.id === t.id);
      Object.assign(seen, { from: from + 1, to: to + 1, of: queue.length });
      // A fila inteira ganha posição (1, 2, 3…): quem entrar depois não tem e vai para o fim. Só a movida ganha nota e muda de `updatedAt`.
      const rank = new Map(next.map((x, i) => [x.id, i + 1]));
      const at = new Date().toISOString();
      const note = `fila de ${owner.name} reordenada por ${who}: posição ${from + 1} → ${to + 1} de ${queue.length}`;
      return tasks.map((x) => {
        const r = rank.get(x.id);
        if (r === undefined) return x;
        if (x.id !== t.id) return x.queueRank === r ? x : { ...x, queueRank: r };
        return { ...x, queueRank: r, updatedAt: at, history: [...x.history, { at, status: x.status, by: fromBrowser ? ('you' as const) : ('auto' as const), note }].slice(-MAX_HISTORY) };
      });
    });
    if (!ok || seen.from === undefined) return null;
    // A frente da fila pode ter mudado (a primeira estava bloqueada, ou esperando nova tentativa): quem está livre pega a vez.
    void this.kick(projectId, first.staffId!);
    const task = (await this.list(projectId))?.find((t) => t.id === taskId);
    return task ? { ok: true, moved: { from: seen.from, to: seen.to!, of: seen.of! }, task } : null;
  }

  /**
   * O responsável sugere subir, descer ou levar ao topo um card da fila dele: vira aviso a quem pediu o card (`notify`, na conversa em que pediu) e uma nota no
   * histórico do card; a ordem não muda, quem decide é quem pediu (ou o usuário). Card pedido pelo usuário (sem `requestedBy`): 409, a sugestão vai a ele pela
   * conversa. Uma por tarefa a cada `SUGGEST_COOLDOWN_MS`. Aviso que não chega: erro (a sugestão não se perde calada).
   */
  private async suggestOrder(projectId: string, task: Task, me: string, queue: Task[], move: 'up' | 'down' | 'top', reason: string): Promise<TaskOrderResult> {
    if (!inQueue(task)) throw new TaskConflictError('a tarefa não está na fila: só se sugere a ordem de card em A fazer esperando a vez');
    const managerId = task.requestedBy;
    if (!managerId) throw new TaskConflictError('a tarefa foi pedida pelo usuário, não por um gestor: diga a sugestão a ele na conversa');
    const [mine, manager] = await Promise.all([this.staffOrThrow(projectId, me), this.deps.readProfile(projectId, managerId)]);
    if (!manager) throw new TaskConflictError('quem pediu a tarefa não está mais neste projeto: diga a sugestão ao usuário na conversa');
    const notify = this.deps.notify;
    if (!notify) throw new TaskError('sem como avisar quem pediu a tarefa agora: diga a sugestão ao usuário na conversa');
    const key = `${projectId}:${task.id}`;
    const last = this.orderSuggested.get(key);
    if (last !== undefined && Date.now() - last < SUGGEST_COOLDOWN_MS) throw new TaskConflictError('você já sugeriu uma ordem para esta tarefa há pouco: espere quem pediu decidir');
    // Reserva antes de enviar: dois pedidos juntos não mandam dois avisos.
    this.orderSuggested.set(key, Date.now());
    const what = move === 'top' ? 'passar para o topo' : move === 'up' ? 'subir' : 'descer';
    const pos = queue.findIndex((t) => t.id === task.id) + 1;
    const text = `[MyCo] ${mine.name} sugere mudar a ordem da fila dele: ${what} a tarefa “${task.title}” (id ${task.id}, a ${pos}ª de ${queue.length}), que você pediu. Motivo: “${reason}”. É só uma sugestão: a ordem não mudou. Você decide (pode reordenar as tarefas que pediu; furar a fila de outro solicitante é só do usuário).`;
    try {
      await notify(projectId, managerId, text, task.requestedSession ?? null);
    } catch (err) {
      this.orderSuggested.delete(key);
      throw new TaskError(`o aviso não chegou a ${manager.name}: ${(err as Error).message}`);
    }
    await this.change(projectId, task.id, (t) => noted(t, `${mine.name} sugeriu ${what} na fila: ${reason}`)).catch(() => {});
    return { ok: true, suggested: true, notified: managerId };
  }

  /**
   * Reabre a cancelada: volta para "a fazer", sem começar sozinha (fora da fila) e sem a conversa antiga (o "Começar" abre uma nova; a
   * antiga continua na lista de conversas da tarefa). Limpa os campos do cancelamento e as marcas "continuar esperando" que
   * outras tarefas guardavam sobre ela (ver `resolveCancelledBlocker`). TaskConflictError se não está cancelada.
   */
  async reopen(projectId: string, taskId: string): Promise<Task | null> {
    const seen: { before?: Task; after?: Task } = {};
    const ok = await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.id !== taskId) return t.ackCancelled?.some((a) => a.id === taskId) ? withoutAck(t, taskId) : t;
        if (t.status !== 'cancelled') throw new TaskConflictError('só tarefa cancelada pode ser reaberta');
        seen.before = t;
        seen.after = reopenedTask(t);
        return seen.after;
      }),
    );
    if (!ok || !seen.before || !seen.after) return null;
    // A conversa antiga já não é a da tarefa: o que chegar dela (fim de turno, mensagem sua) não mexe na tarefa.
    if (seen.before.sessionId) {
      this.retired.add(seen.before.sessionId);
      this.bySession.delete(seen.before.sessionId);
    }
    return seen.after;
  }

  /**
   * O dono decide o que fazer com `taskId` (a dependente) que espera `blockerId`, uma tarefa cancelada (item 'blocked' da caixa):
   *   - 'release': tira a cancelada do `blockedBy` da dependente; sem outra espera e na fila, o dono dela é acordado (fluxo normal);
   *   - 'cancel': cancela a dependente também (motivo: "a tarefa “X” foi cancelada");
   *   - 'wait': continua esperando, e o par some da caixa por ACK_CANCELLED_DAYS dias (`ackCancelled`, ver `stuckDependencies`), ou até a
   *     bloqueadora ser reaberta; passado o prazo, o item volta à caixa para o dono decidir de novo.
   * TaskConflictError se a dependente está encerrada, não depende mais dela ou ela não está cancelada.
   * `dependents` (só no 'cancel'): segue a cascata nas que esperavam pela dependente (ver `cancel`).
   */
  async resolveCancelledBlocker(projectId: string, taskId: string, blockerId: string, action: DependentAction, dependents?: DependentChoices): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const all = dir ? await readTasks(dir) : [];
    const dep = all.find((t) => t.id === taskId);
    if (!dir || !dep) return null;
    const blocker = all.find((t) => t.id === blockerId);
    if (!blocker || blocker.status !== 'cancelled' || !dep.blockedBy?.includes(blockerId) || isClosed(dep))
      throw new TaskConflictError('esta tarefa não espera mais por uma tarefa cancelada (a situação mudou)');
    if (action === 'cancel') return this.cancel(projectId, taskId, { by: 'user', reason: `a tarefa “${blocker.title}” foi cancelada`, dependents });
    const out = await this.change(projectId, taskId, (d) => {
      if (isClosed(d) || !d.blockedBy?.includes(blockerId)) throw new TaskConflictError('esta tarefa não espera mais por uma tarefa cancelada (a situação mudou)');
      if (action === 'wait') {
        // Repetir renova o prazo (uma entrada por bloqueadora); as vencidas saem junto.
        const kept = (withoutAck(d, blockerId).ackCancelled ?? []).filter((a) => acked(d, a.id));
        return noted({ ...d, ackCancelled: [...kept, { id: blockerId, at: new Date().toISOString() }] }, `segue esperando “${blocker.title}” (cancelada); o aviso volta à caixa em ${ACK_CANCELLED_DAYS} dias`);
      }
      const rest = d.blockedBy.filter((id) => id !== blockerId);
      const { blockedBy: _, ...others } = withoutAck(d, blockerId);
      return noted({ ...others, ...(rest.length && { blockedBy: rest }) }, `liberada da espera por “${blocker.title}” (cancelada)`);
    });
    // Sem outra espera e na fila: o dono dela pega (o `takeNext` confere a fila e o limite de ocupação).
    if (action === 'release' && out?.staffId && !isClosed(out) && !blockers(out, (await this.list(projectId)) ?? []).length) void this.kick(projectId, out.staffId);
    return out;
  }

  /** Aplica `choices` às tarefas abertas que esperam `blocker` (já cancelada) direto; quem não tem escolha fica como está. */
  private async applyDependentChoices(projectId: string, blocker: Task, choices: DependentChoices): Promise<void> {
    const ids = openDependentsOf((await this.list(projectId)) ?? [], blocker.id).map((t) => t.id);
    for (const id of ids) {
      const action = choiceOf(choices, id);
      if (!action) continue;
      try {
        await this.resolveCancelledBlocker(projectId, id, blocker.id, action, choices);
      } catch (err) {
        // Encerrada ou liberada no meio do caminho (uma cascata anterior, ou o dono em outra aba): não precisa mais de escolha.
        if (!(err instanceof TaskConflictError)) throw err;
      }
    }
  }

  /**
   * A ficha `staffId` foi apagada (com tarefas abertas, por sua confirmação). As tarefas abertas dela ficam no quadro
   * sem responsável (staffId null, fora da fila); "fazendo", "planejando" e "a fazer" voltam para "a fazer", sem conversa
   * (sessionId), plano nem mensagens guardadas; "revisão" mantém a conversa; "aguardar" fica em aguardar. Quem era o
   * revisor dela fica sem revisor. Encerradas (prontas e canceladas) não mudam. Cada tarefa mudada ganha uma linha no histórico. Devolve quantas.
   */
  async releaseStaff(projectId: string, staffId: string): Promise<number> {
    let released = 0;
    // Tentativas abertas que a troca de conversa zera: fecham como canceladas, depois da gravação.
    const cancelled: Task[] = [];
    // Bloqueadoras que perderam o responsável ou o revisor: avisam quem espera por elas (depois da gravação).
    const lost: Array<{ id: string; reason: string }> = [];
    await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (isClosed(t)) return t;
        const asWorker = t.staffId === staffId;
        const asReviewer = t.reviewerId === staffId;
        if (!asWorker && !asReviewer) return t;
        released++;
        lost.push({ id: t.id, reason: asWorker ? 'sem responsável' : 'sem revisor' });
        if (!asWorker) return noted({ ...t, reviewerId: null }, 'revisor excluído');
        const loose: Task = { ...t, staffId: null, queuedAt: null, queuedForce: false, resourceWait: null, startRetry: undefined, ...(asReviewer && { reviewerId: null }) };
        // Em revisão, a conversa de trabalho continua (sessionId fica). Nas outras, a conversa e o plano são da
        // pessoa que saiu e as mensagens guardadas iam para ela: zerados, quem pegar a tarefa começa do zero.
        if (t.status === 'review' || t.status === 'waiting') return noted(loose, 'responsável excluído');
        if (t.runId) cancelled.push(t);
        const fresh: Task = { ...loose, sessionId: null, plan: null, held: [], fallback: undefined, runId: null };
        return t.status === 'todo' ? noted(fresh, 'responsável excluído') : moved(fresh, 'todo', 'auto', 'responsável excluído');
      }),
    );
    for (const t of cancelled) await this.logEnd(projectId, t, 'cancelled', 'responsável excluído');
    for (const l of lost) this.warnDependents(projectId, l.id, l.reason);
    return released;
  }

  /**
   * Começa: conversa nova com o funcionário, com o título e a descrição. Com a ficha em "só
   * planeja", a tarefa vai para "planejando"; senão, para "fazendo". Com ele ocupado, entra na
   * fila dele e começa sozinha quando ele ficar livre.
   * Com `deadlineMs`, quem pediu não espera mais que isso: a vez do funcionário (`locked`) e a abertura da conversa podem demorar muito, e o pedido
   * ficaria preso. Passado o prazo, a resposta vem com a tarefa já na fila dele (`todo` com `queuedAt`) e o começo segue em segundo plano, na mesma
   * vez de sempre: quem abre a conversa continua sendo um só (o que entra na vez confere `sessionId` de novo). Se o começo falhar depois disso,
   * a tarefa fica na fila com o motivo e a fila tenta de novo (ver `startFailedLate`).
   */
  async start(projectId: string, taskId: string, force = false, opts: StartOpts = {}): Promise<Task | null> {
    const { deadlineMs, ...run } = opts;
    const log = this.deps.log ?? ((line: string) => console.warn(line));
    const timer = new StageTimer(`começar ${taskId}`, log, this.deps.slowMs ?? START_SLOW_MS);
    const job = this.startJob(projectId, taskId, force, run, timer).finally(() => timer.finish());
    if (!deadlineMs) return job;
    let timeout: NodeJS.Timeout | undefined;
    const late = new Promise<typeof LATE>((resolve) => {
      timeout = setTimeout(() => resolve(LATE), deadlineMs);
    });
    try {
      const done = await Promise.race([job, late]);
      if (done !== LATE) return done;
    } finally {
      clearTimeout(timeout);
    }
    const at = timer.where();
    timer.answeredEarly = true;
    log(`[tarefas] começar ${taskId}: passou do prazo de ${deadlineMs} ms, parado em "${at?.name ?? '?'}" há ${at?.ms ?? 0} ms; responde na fila e o começo segue em segundo plano`);
    void job.catch((err) => this.startFailedLate(projectId, taskId, err, log));
    return this.queueLate(projectId, taskId, force);
  }

  /** Passou do prazo: a tarefa vai para a fila dele (se ainda não começou) e a resposta leva essa versão. O começo de verdade segue sem esta gravação. */
  private queueLate(projectId: string, taskId: string, force: boolean): Promise<Task | null> {
    return this.change(projectId, taskId, (t) => {
      // O começo gravou antes (já tem conversa), ou a tarefa saiu de "a fazer" (cancelada, arrastada): não mexe.
      if (!unstarted(t)) return t;
      const from = t.status === 'waiting' ? moved(t, 'todo', 'you', 'saiu de aguardar') : t;
      const queued: Task = { ...from, queuedAt: from.queuedAt ?? new Date().toISOString(), queuedForce: force, unqueued: undefined };
      return noted(queued, 'o começo passou do prazo da resposta (a vez dele ou a conversa demora): na fila, começa em segundo plano');
    });
  }

  /** O começo que seguia depois do prazo falhou: a tarefa já está na fila; ela guarda o motivo e, se é da tarefa, o backoff (como na `takeNext`). */
  private async startFailedLate(projectId: string, taskId: string, err: unknown, log: (line: string) => void): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[tarefas] começar ${taskId}: o começo em segundo plano falhou: ${msg}`);
    const why = `não começou: ${msg}`;
    await this.change(projectId, taskId, (t) => {
      if (!unstarted(t)) return t;
      const marked = isGlobalStart(err) ? t : { ...t, startRetry: failedRetry(t.startRetry, err, new Date()) };
      return t.history.at(-1)?.note === why ? marked : noted(marked, why);
    }).catch(() => {});
  }

  /** O começo inteiro, sem prazo. `timer` marca onde o tempo vai (ver `StageTimer`). */
  private async startJob(projectId: string, taskId: string, force: boolean, opts: RunStart, timer: StageTimer): Promise<Task | null> {
    timer.stage('projectPath');
    const dir = await this.deps.projectPath(projectId);
    timer.stage('leitura');
    const tasks = dir ? await readTasks(dir) : [];
    const task = tasks.find((t) => t.id === taskId);
    if (!dir || !task) return null;
    if (task.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: reabra antes de começar');
    if (!task.staffId) throw new TaskError('escolha quem vai cuidar da tarefa');
    if (task.sessionId) throw new TaskError('a tarefa já começou: continue pela conversa dela');
    timer.stage('ficha');
    const profile = await this.staffOrThrow(projectId, task.staffId);
    const staffId = task.staffId;
    // Na fila, a tarefa vai para A fazer (de Aguardar, como de A fazer): só a fila anda com "a fazer".
    const enqueue = (t: Task, note?: string) => {
      const from = t.status === 'waiting' ? moved(t, 'todo', 'you', 'saiu de aguardar') : t;
      const queued: Task = { ...from, queuedAt: from.queuedAt ?? new Date().toISOString(), queuedForce: force, unqueued: undefined };
      return note ? noted(queued, note) : queued;
    };
    // Na mesma vez do funcionário que a fila: dois "Começar" juntos não abrem duas conversas.
    timer.stage('lock');
    return this.locked(projectId, staffId, async () => {
      timer.stage('fila');
      const fresh = await readTasks(dir);
      // Mudou de responsável entre a leitura e a vez dele (edição): quem começa é o novo, pela fila dele, e não o de antes com a ficha dele.
      const now = fresh.find((t) => t.id === taskId);
      if (now && now.staffId !== staffId) return now;
      // Cancelada enquanto esperava a vez (quem pediu a tarefa a cancelou, ver `cancelByRequester`): não começa nem volta para a fila.
      if (now?.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: reabra antes de começar');
      // Outro começo (a fila, ou um "Começar" repetido, ou o que passou do prazo) abriu a conversa enquanto esperava a vez: não começa de novo,
      // nem volta a pô-la na fila.
      if (now?.sessionId) return now;
      // Bloqueada: entra na fila com o motivo, sem erro. Começa sozinha quando as dependências ficarem prontas (ver wakeDependents).
      const open = blockers(now ?? task, fresh);
      // O motivo (quem falta) não fica gravado: a caixa e o quadro o calculam na leitura (ver blockers e stuckDependencies).
      if (open.length) return this.change(projectId, taskId, (t) => enqueue(t));
      const busyWith = occupant(fresh, staffId, taskId);
      if (!busyWith && !this.staffBusy(projectId, fresh, staffId)) {
        try {
          return await this.startNow(projectId, taskId, profile, force, undefined, { trigger: opts.trigger ?? 'manual', skills: opts.skills }, timer);
        } catch (err) {
          // Limite de consumo na hora (da empresa, ou o do motor da ficha sem troca), ou o servidor reiniciando: não começou,
          // mas fica na fila dele (o tick tenta de novo; no reinício, o tick do boot). Outros erros sobem.
          if (!isGlobalStart(err)) throw err;
          const why =
            err instanceof ChatClosingError
              ? `não começou: o Claudio’s Club está reiniciando; na fila de ${profile.name}, começa quando o servidor voltar`
              : `não começou: ${err.message}; na fila de ${profile.name}, começa quando o consumo baixar`;
          return this.change(projectId, taskId, (t) => enqueue(t, why));
        }
      }
      const note = busyWith ? `na fila de ${profile.name}, depois de “${busyWith.title}”` : `na fila de ${profile.name} (ele está numa conversa)`;
      return this.change(projectId, taskId, (t) => enqueue(t, note));
    });
  }

  /**
   * `run`: a partida abre uma tentativa nova no registro (ver taskRuns.ts), com o que a abriu. Sem ele (troca no meio do turno),
   * a tentativa segue a que estava aberta. `timer`: o cronômetro do pedido, quando há um (ver `start`).
   */
  private async startNow(projectId: string, taskId: string, profile: StaffProfile, force: boolean, sw?: Switch, run?: RunStart, timer?: StageTimer): Promise<Task | null> {
    timer?.stage('leitura');
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    // Com troca combinada (no meio do turno), a conversa antiga ainda é a da tarefa até a nova abrir.
    if (!dir || !task || (task.sessionId && !sw) || task.status === 'cancelled') return null;
    // Sem troca combinada: o limite do motor da ficha agora decide (começa, troca para o secundário, ou espera na fila).
    timer?.stage('plano');
    const plan = sw ? {} : await this.startPlan(projectId, task, profile);
    if (plan.wait) throw new LimitWaitError(plan.wait);
    const s = sw ?? plan.switch;
    const text =
      s?.text ??
      [
        `[Tarefa "${task.title}"]`,
        s?.line ?? '',
        ...(await this.requesterLines(projectId, task)),
        task.description,
        task.goal && `Meta: ${task.goal}`,
        task.acceptance && `Critério de aceite: ${task.acceptance}`,
        this.cancelLine(projectId, task, s?.override.engine ?? profile.engine ?? 'claude'),
        CLOSING_LINE,
      ]
        .filter(Boolean)
        .join('\n\n');
    let sessionId: string;
    timer?.stage('conversa');
    try {
      // Sem override, o envio é o de sempre (4 argumentos): só a troca carrega o motor secundário.
      sessionId = s?.override
        ? await this.deps.send(projectId, profile.id, text, force, s.override)
        : await this.deps.send(projectId, profile.id, text, force);
    } catch (err) {
      if (!s) throw err;
      // Reiniciando: não foi o motor secundário que falhou; quem chamou põe na fila (no meio do turno, ver `sw`).
      if (err instanceof ChatClosingError && !sw) throw err;
      const why = `não abriu no motor secundário: ${(err as Error).message}`;
      // No meio do turno, a antiga já foi parada: a tarefa vai para Aguardar com o motivo, e quem decide é você.
      if (sw) {
        const seen: { before?: Task } = {};
        await this.change(projectId, taskId, (t) => {
          seen.before = t;
          return moved({ ...t, queuedAt: null, waitReason: why, runId: null }, 'waiting', 'auto', why);
        });
        await this.logEnd(projectId, seen.before, 'limit', why);
        throw err;
      }
      // Limite da empresa (UsageStopError) sobe: quem chamou põe na fila, como sempre.
      if (err instanceof UsageStopError) throw err;
      // No início, a tarefa continua na fila, como estaria sem fallback. A troca não é gravada: a fila tenta de novo com o limite de hoje.
      return this.change(projectId, taskId, (t) => {
        const from = t.status === 'waiting' ? moved(t, 'todo', 'auto', 'saiu de aguardar') : t;
        const queued = { ...from, queuedAt: from.queuedAt ?? new Date().toISOString(), queuedForce: force, unqueued: undefined };
        return from.history.at(-1)?.note === why ? queued : noted(queued, why);
      });
    }
    // Tentativa nova só na partida (a troca no meio do turno segue a que estava aberta). A conversa já abriu: o registro vai agora.
    timer?.stage('registro');
    const runId = run && !sw ? await this.logStart(projectId, task, run.trigger ?? 'manual', run.skills ?? (await this.skillsOf(projectId, profile))) : undefined;
    const branch = await this.deps.branchFor(dir, profile).catch(() => null);
    this.bySession.set(sessionId, { projectId, taskId, role: 'work' });
    timer?.stage('gravar');
    return this.change(projectId, taskId, (t) => {
      // A troca no meio do turno não muda a fase: a tarefa segue em "fazendo" ou "planejando", como estava.
      const next: TaskStatus = sw ? t.status : profile.autonomy === 'plan' ? 'planning' : 'doing';
      // A conversa que abriu entra no histórico da tarefa (partida e troca de motor, que também passam aqui).
      const engine: Engine = s?.override.engine ?? (profile.engine === 'codex' ? 'codex' : 'claude');
      const started = withSession(
        { ...t, sessionId, branch: branch ?? t.branch, queuedAt: null, queuedForce: false, resourceWait: null, fallbackBlocked: undefined, startRetry: undefined, unqueued: undefined, ...(s && { fallback: s.fallback }), ...(runId && { runId }) },
        { id: sessionId, role: 'work', staffId: profile.id, engine, at: new Date().toISOString() },
      );
      const moving = moved(started, next, 'auto', `com ${profile.name}`);
      return s ? noted(moving, s.note) : moving;
    });
  }

  /**
   * Como o funcionário cancela esta tarefa e quando: só se o usuário pedir sem dúvida; na dúvida, pergunta; nunca "cancelar" marcando
   * como pronta ou apagando. Traz o id da tarefa e o curl (endereço do motor da conversa: o Codex fala pelo da sandbox). Sem endereço
   * da API (ver `apiUrl`), vazio: não há como ele chamar.
   */
  private cancelLine(projectId: string, task: Task, engine: Engine): string {
    const api = engine === 'codex' ? this.deps.sandboxApiUrl : this.deps.apiUrl;
    if (!api) return '';
    const curl = `curl -s -X POST -H "x-myco: 1" -H "x-myco-token: $MYCO_TOKEN" -H "content-type: application/json" -d '{"reason": "<o motivo, em uma frase>"}' ${api}/api/projects/${projectId}/tasks/${task.id}/cancel`;
    return [
      `Cancelar esta tarefa (id \`${task.id}\`): se o usuário pedir, sem dúvida, para cancelar esta tarefa, cancele pela API do Claudio’s Club com \`${curl}\` (o token da sua conversa já está em $MYCO_TOKEN; escreva o motivo sem aspas simples) e pare por aí, sem mais nada.`,
      'Se não estiver claro se é para cancelar a tarefa ou só parar ou mudar algo, pergunte antes de cancelar. Nunca marque a tarefa como pronta nem a apague para "cancelar".',
    ].join(' ');
  }

  /** As linhas de quem pediu a tarefa: "Pedida por…" e a regra da dúvida (vai para ele, não para o usuário). Vale para qualquer motor. */
  private async requesterLines(projectId: string, task: Task): Promise<string[]> {
    const manager = task.requestedBy ? await this.deps.readProfile(projectId, task.requestedBy) : null;
    if (!manager) return [];
    return [`Pedida por ${manager.name} (${manager.role}), que vai conferir a sua entrega.`, askManagerLine(manager)];
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
    if (hit === null || hit === 'unknown') {
      // Sem limite agora, a espera de troca (se havia) já não vale: a partida segue como sempre.
      if (task.fallbackBlocked) await this.change(projectId, task.id, (t) => ({ ...t, fallbackBlocked: undefined }));
      return {};
    }
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
      // Fica na fila com a espera gravada (`fallbackBlocked`); a nota sai do `wait`, pelo caminho da fila (ver `isGlobalStart`).
      const until = hit.resetsAt === null ? null : new Date(hit.resetsAt).toISOString();
      await this.change(projectId, task.id, (t) => ({ ...t, fallbackBlocked: blockedOf(err, secondary.engine, engine, until, t.fallbackBlocked) }));
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
    // Card automático: a conversa é direta, e o limite dela é da troca direta (ver server/directFallback.ts), não da tarefa.
    if (where?.role !== 'work' || where.auto) return;
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
        // A própria conversa (`exceptSession`) não conta como "outra" viva: o Codex dela é que está no limite, não um concorrente.
        await this.deps.assertRunnable?.(projectId, staffId, sw.override, ev.sessionId);
      } catch (err) {
        const why = `troca para ${ENGINE_LABEL[secondary.engine]} não feita: ${(err as Error).message}`;
        const until = ev.hit.resetsAt === null ? null : new Date(ev.hit.resetsAt).toISOString();
        await this.change(projectId, taskId, (t) => noted({ ...t, fallbackBlocked: blockedOf(err, secondary.engine, ev.engine, until, t.fallbackBlocked) }, `limite do ${ENGINE_LABEL[ev.engine]} no meio do turno: ${why}; segue como antes`));
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
        const seen: { before?: Task } = {};
        await this.change(projectId, taskId, (t) => {
          if (t.status === 'waiting') return t;
          seen.before = t;
          return moved({ ...t, queuedAt: null, waitReason: why, runId: null }, 'waiting', 'auto', why);
        });
        await this.logEnd(projectId, seen.before, 'limit', why);
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
      task: { id: task.id, title: task.title, description: task.description, goal: task.goal, acceptance: task.acceptance },
      from: { engine: from, reason: 'limit', resetsAt: hit.resetsAt },
      to,
      userMessages: old.userMessages,
      lastAssistantText: old.lastAssistantText,
      git,
      // Com `/` também no Windows: a instrução vai para o modelo, que lê o caminho como texto.
      memoryPath: path.posix.join('.myco', 'staff', `${profile.id}.memory.md`),
      closing: [...(await this.requesterLines(projectId, task)), this.cancelLine(projectId, task, to.engine), CLOSING_LINE].filter(Boolean),
      notes: wakeAt ? [`havia um despertador agendado para ${atHour(wakeAt)}: reagende se ainda fizer sentido.`] : [],
    });
  }

  /**
   * Sua mensagem para a conversa de uma tarefa enquanto o funcionário está em outra: fica guardada
   * na tarefa e vai quando ele ficar livre. Devolve o motivo, ou null se pode mandar já.
   */
  async hold(sessionId: string, msg: { text: string; images?: string[]; origin?: string; ask?: HeldMessage['ask']; doubt?: true }): Promise<string | null> {
    const where = await this.where(sessionId);
    // Card automático: a conversa é direta, a sua mensagem não espera a vez de outra tarefa.
    if (!where || where.role !== 'work' || where.auto) return null;
    const tasks = (await this.list(where.projectId)) ?? [];
    const task = tasks.find((t) => t.id === where.taskId);
    // Cancelada já não é a tarefa dele: a mensagem não espera a vez de ninguém, vai direto para a conversa.
    if (!task?.staffId || task.status === 'cancelled') return null;
    const busyWith = occupant(tasks, task.staffId, task.id);
    if (!busyWith && !this.staffBusy(where.projectId, tasks, task.staffId, sessionId)) return null;
    const name = (await this.deps.readProfile(where.projectId, task.staffId))?.name ?? 'ele';
    const reason = busyWith ? `espera ${name} terminar “${busyWith.title}”` : `espera ${name} terminar a conversa em que está`;
    const held: HeldMessage = { id: randomBytes(4).toString('hex'), at: new Date().toISOString(), text: msg.text, ...(msg.images?.length && { images: msg.images }), ...(msg.origin && { origin: msg.origin }), ...(msg.ask && { ask: msg.ask }), ...(msg.doubt && { doubt: true as const }), reason };
    await this.change(where.projectId, task.id, (t) => noted({ ...t, held: [...(t.held ?? []), held] }, `ajuste guardado: ${reason}`));
    return reason;
  }

  /**
   * "Reenviar" o ajuste guardado que não chegou (`stuckState` 'resend'): zera as falhas e a hora da próxima tentativa de cada mensagem
   * guardada e acorda o funcionário, que manda na hora se estiver livre. `fromBrowser` é o do pedido (navegador pareado), nunca do corpo:
   * sem ele, 403 (TaskForbiddenError). Tarefa que não existe: null (404). Encerrada ou sem ajuste guardado: 409 (TaskConflictError).
   */
  async resendHeld(projectId: string, taskId: string, fromBrowser: boolean): Promise<Task | null> {
    if (!fromBrowser) throw new TaskForbiddenError('só você, pelo Claudio’s Club, reenvia o ajuste guardado');
    const task = await this.fresh(projectId, taskId);
    if (!task) return null;
    if (isClosed(task)) throw new TaskConflictError('a tarefa está encerrada: não há ajuste a reenviar');
    if (!task.held?.length) throw new TaskConflictError('não há ajuste guardado nesta tarefa');
    const out = await this.change(projectId, taskId, (t) =>
      noted({ ...t, held: (t.held ?? []).map(({ attempts: _attempts, nextAt: _nextAt, ...m }) => m) }, 'ajuste guardado: nova tentativa pedida por você'),
    );
    if (task.staffId) await this.kick(projectId, task.staffId);
    return (await this.fresh(projectId, taskId)) ?? out;
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
    if (this.deps.closing?.()) return;
    await this.workDone(sessionId);
    if (projectId && staffId) await this.kick(projectId, staffId);
  }

  /**
   * Rede de segurança (na subida e de tempos em tempos): dúvida sem resposta do gestor no prazo (vai para você) e a que ainda não chegou a
   * ele (reenvio com backoff), revisão automática que não começou, que se perdeu num reinício ou que ficou sem veredito, aviso retido ou que falhou, tarefa em "fazendo"
   * cuja conversa morreu no meio do turno (ver `orphan`), e quem tem fila ou ajuste esperando e está livre. Cada passo é isolado: o que
   * falha num não segura os outros (a próxima rodada tenta de novo).
   */
  async tick(now = new Date()): Promise<void> {
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      await this.safely(() => this.escalateDoubts(projectId, tasks, now));
      await this.safely(() => this.retryDoubts(projectId, tasks, now));
      await this.safely(() => this.retryCancelRequests(projectId, tasks, now));
      await this.safely(() => this.retryReviews(projectId, tasks, now));
      await this.safely(() => this.chaseReviews(projectId, tasks, now));
      await this.safely(() => this.resumeReviews(projectId, tasks));
      await this.safely(() => this.releaseOutcomes(projectId, tasks, now));
      await this.safely(() => this.enqueueIdle(projectId, tasks));
      for (const t of tasks) if (t.status === 'doing' && t.sessionId && t.staffId) await this.orphan(projectId, t.id, t.staffId, now);
      // Acorda só quem tem ajuste guardado ou tarefa na fila que já pode começar: fila só de bloqueadas não acorda ninguém.
      const waiting = new Set(tasks.filter((t) => t.staffId && (t.held?.length || (t.queuedAt && !blockers(t, tasks).length))).map((t) => t.staffId!));
      for (const s of waiting) await this.kick(projectId, s);
    }
  }

  private async safely(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch {
      // A próxima rodada refaz o passo (o que ele decide vem do estado gravado).
    }
  }

  /** Dúvida com o gestor há mais que ESCALATE_AFTER_MS sem resposta vai para você (demora nunca conta como resposta). O retry ao gestor, se havia, continua. */
  private async escalateDoubts(projectId: string, tasks: Task[], now: Date): Promise<void> {
    for (const t of tasks) {
      const q = t.question;
      if (isClosed(t) || q?.status !== 'open' || now.getTime() - Date.parse(q.askedAt) <= ESCALATE_AFTER_MS) continue;
      await this.change(projectId, t.id, (x) =>
        x.question?.status === 'open' && x.question.id === q.id
          ? noted({ ...x, question: { ...x.question, status: 'escalated', escalatedAt: now.toISOString() } }, 'dúvida sem resposta do gestor no prazo: vai para você')
          : x,
      );
      this.freeQueue(projectId, t);
    }
  }

  /** A dúvida acabou de ir para você: sem edição, a tarefa deixa de ocupar o funcionário e a fila dele anda já (ver `releasesStaff`; com edição, o kick não muda nada). */
  private freeQueue(projectId: string, t: Task): void {
    if (t.staffId) void this.kick(projectId, t.staffId);
  }

  /** Dúvida que ainda não chegou ao gestor e já pode tentar de novo. Uma por gestor por rodada (um gestor no limite não leva várias conversas de uma vez). */
  private async retryDoubts(projectId: string, tasks: Task[], now: Date): Promise<void> {
    const asked = new Set<string>();
    for (const t of tasks) {
      if (isClosed(t) || !t.requestedBy || !t.question || !doubtDue(t.question, now.getTime()) || asked.has(t.requestedBy)) continue;
      asked.add(t.requestedBy);
      await this.sendDoubt(projectId, t.id, t.question.id);
    }
  }

  /**
   * Revisão automática que não começou (`reviewRetry`): tenta de novo quando chega a hora, com backoff e jitter. Passado REVIEW_WAIT_MS desde a
   * primeira falha, a tarefa também é sua: uma nota, o aviso aos dependentes, a caixa (`stuckState`) e, se quem pediu é quem revisa, o aviso da
   * entrega (uma vez) — mas as tentativas não param: a revisão abre quando o motivo passar. A que já não está nessa entrega perde a marca.
   * No máximo REVIEWS_PER_TICK pedidos por rodada (um reinício com vários cards parados não abre todas as conversas juntas).
   */
  private async retryReviews(projectId: string, tasks: Task[], now: Date): Promise<void> {
    const at = now.getTime();
    let opened = 0;
    for (const t of tasks) {
      const rr = t.reviewRetry;
      if (!rr) continue;
      if (!onDelivery(t, rr.deliveryAt)) {
        await this.change(projectId, t.id, (x) => (x.reviewRetry && !onDelivery(x, x.reviewRetry.deliveryAt) ? { ...x, reviewRetry: undefined } : x));
        continue;
      }
      if (!rr.expired && at - Date.parse(rr.firstAt) >= REVIEW_WAIT_MS) {
        let expired: Task | null = null;
        await this.change(projectId, t.id, (x) => {
          if (!x.reviewRetry || x.reviewRetry.expired || !onDelivery(x, rr.deliveryAt)) return x;
          return (expired = noted({ ...x, reviewRetry: { ...x.reviewRetry, expired: true } }, 'revisão automática não começou em 30 min: a tarefa fica com você'));
        });
        const stuck = expired as Task | null;
        if (!stuck) continue;
        this.warnDependents(projectId, stuck.id, stuckReason(stuck));
        if (selfReview(stuck) && stuck.sessionId) await this.tellManager(projectId, stuck, stuck.sessionId);
        continue;
      }
      // Vencida (a caixa já avisa) também segue tentando, no passo mais lento: o motivo passa (o consumo volta, o dono troca o revisor) e a revisão abre
      // sozinha, sem o dono empurrar o card. Abrindo, `requestReview` limpa a marca e o aviso some.
      if (!retryDue(rr, at) || opened >= REVIEWS_PER_TICK) continue;
      const key = `review:${projectId}:${t.id}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      opened++;
      try {
        const fresh = ((await this.list(projectId)) ?? []).find((x) => x.id === t.id);
        if (fresh && fresh.reviewRetry && onDelivery(fresh, fresh.reviewRetry.deliveryAt)) await this.autoReview(projectId, fresh);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Entrega que ficou sem o pedido de revisão: o servidor reiniciou entre o fim do turno e o `autoReview` (os testes da entrega levam minutos,
   * ver `workDone`), e nada mais olhava para ela (`retryReviews` só vê `reviewRetry`; `chaseReviews`, `review` aberto). Pede a revisão como se a
   * entrega tivesse chegado agora (ver `reviewLost`). O pedido que sai deixa `review`, o que falha deixa `reviewRetry` ou uma nota, e os dois
   * tiram a tarefa daqui: é uma vez por entrega. A chave é a de `workDone` e `retryReviews`: entrega em andamento não é entrega perdida.
   */
  private async resumeReviews(projectId: string, tasks: Task[]): Promise<void> {
    let opened = 0;
    for (const t of tasks) {
      if (!reviewLost(t) || opened >= REVIEWS_PER_TICK) continue;
      const key = `review:${projectId}:${t.id}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      opened++;
      try {
        // Relê com a chave na mão: o estado pode ter mudado desde o começo do tick.
        const fresh = ((await this.list(projectId)) ?? []).find((x) => x.id === t.id);
        if (!fresh || !reviewLost(fresh) || !(await this.reviewerOf(projectId, fresh))) continue;
        // Os testes desta entrega nunca rodaram: os guardados são de uma anterior e diriam ao revisor que não precisa rodar.
        const stale = fresh.tests && fresh.delivery && fresh.tests.at < fresh.delivery.at;
        await this.autoReview(projectId, stale ? ((await this.change(projectId, t.id, (x) => ({ ...x, tests: undefined }))) ?? fresh) : fresh);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Card em "a fazer" que ninguém pôs na fila (a partida falhou por um erro que não é de consumo, ou você o arrastou de outra coluna com uma conversa já
   * aberta): com responsável, sem dependência pendente (`blockers`), sem dúvida aberta e fora de Aguardar, não há por que esperar. Entra na fila do responsável, e
   * o `takeNext` decide: ocupado, espera a vez (não está empacado); livre, começa. Quem você tirou da fila (`unqueued`) fica como está. O card cuja
   * conversa já está trabalhando (o ajuste guardado foi para ela) só volta para fazendo. No máximo ENQUEUE_PER_TICK por rodada.
   */
  private async enqueueIdle(projectId: string, tasks: Task[]): Promise<void> {
    const woken = new Set<string>();
    let n = 0;
    for (const t of tasks) {
      if (n >= ENQUEUE_PER_TICK) break;
      if (!idleTodo(t, tasks) || !(await this.deps.readProfile(projectId, t.staffId!))) continue;
      const sessionId = t.sessionId;
      const working = !!sessionId && this.deps.isSessionWorking?.(sessionId) === true;
      let done = false;
      await this.change(projectId, t.id, (x, all) => {
        if (!idleTodo(x, all) || x.sessionId !== sessionId) return x;
        done = true;
        if (working) return moved(x, 'doing', 'auto', 'a conversa dela está trabalhando: a tarefa volta para fazendo');
        return noted({ ...x, queuedAt: new Date().toISOString(), queuedForce: false }, sessionId ? 'em a fazer fora da fila: entrou na fila, para retomar a conversa dela' : 'em a fazer fora da fila: entrou na fila');
      });
      if (!done) continue;
      n++;
      woken.add(t.staffId!);
    }
    for (const s of woken) await this.kick(projectId, s);
  }

  /**
   * Revisão que não anda: o revisor respondeu sem veredito, ou a conversa dele ficou sem resposta e parada (morreu). Marca a hora de
   * re-pedir (`reaskAt`); chegada a hora, pede UMA vez o "APROVADO ou REPROVADO" na conversa dele. Depois disso, sem veredito, a tarefa é
   * sua (ver `stuckState`). Só vale com o revisor marcado na tarefa: é o veredito dele que a move.
   */
  private async chaseReviews(projectId: string, tasks: Task[], now: Date): Promise<void> {
    const at = now.getTime();
    for (const t of tasks) {
      const r = t.review;
      if (t.status !== 'review' || !r || !t.reviewerId || t.reviewerId !== r.staffId || r.reasked) continue;
      if (!r.reaskAt) {
        // Sem resposta, a conversa do revisor parada e passado o tempo da conversa órfã: ela morreu (ou nunca respondeu). Olha só a conversa de revisão:
        // ele pode estar trabalhando em outra (a revisão roda em paralelo), e isso não a mantém viva.
        const working = this.deps.isSessionWorking ? this.deps.isSessionWorking(r.sessionId) : this.deps.isWorking?.(projectId, r.staffId);
        if (r.doneAt || at - Date.parse(r.at) <= ORPHAN_MS || working !== false) continue;
        await this.change(projectId, t.id, (x) => (x.review?.sessionId === r.sessionId && !x.review.reaskAt && !x.review.doneAt ? { ...x, review: { ...x.review, reaskAt: new Date(at + REASK_AFTER_MS).toISOString() } } : x));
        continue;
      }
      if (!retryDue({ nextAt: r.reaskAt }, at)) continue;
      const key = `reask:${projectId}:${t.id}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        await this.reask(projectId, t.id, r.sessionId, now);
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  /** O re-pedido do veredito, uma vez. Falha no envio conta como o re-pedido (não repete a cada rodada): em REVIEW_WAIT_MS a tarefa vira sua. */
  private async reask(projectId: string, taskId: string, sessionId: string, now: Date): Promise<void> {
    // Relê: o veredito pode ter chegado, ou a revisão ter sido trocada, enquanto esperava a vez.
    const t = ((await this.list(projectId)) ?? []).find((x) => x.id === taskId);
    const r = t?.review;
    if (!t || t.status !== 'review' || !r || r.sessionId !== sessionId || r.reasked || !r.reaskAt || !t.reviewerId || t.reviewerId !== r.staffId) return;
    let error: string | null = null;
    try {
      if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa do revisor');
      await this.deps.sendTo(projectId, sessionId, r.staffId, REASK_TEXT, []);
    } catch (err) {
      // Reiniciando: o re-pedido não saiu e não conta; a próxima rodada tenta.
      if (err instanceof ChatClosingError) return;
      error = (err as Error).message;
    }
    const at = now.toISOString();
    await this.change(projectId, taskId, (x) =>
      x.review?.sessionId === sessionId && !x.review.reasked
        ? noted({ ...x, review: { ...x.review, reasked: true, reaskAt: at } }, error ? `não deu para pedir o veredito de novo ao revisor: ${error}` : 'revisão sem veredito: pedido de novo ao revisor')
        : x,
    );
  }

  /**
   * Aviso a quem pediu que ficou retido há mais de OUTCOME_HOLD_MAX_MS, ou que saiu e falhou (`outcomePending`) e já pode ser reenviado: sai
   * agora, num aviso só por gestor (ver `settleRequester`).
   */
  private async releaseOutcomes(projectId: string, tasks: Task[], now: Date): Promise<void> {
    const at = now.getTime();
    const done = new Set<string>();
    for (const t of tasks) {
      if (!t.requestedBy || t.status !== 'done' || !t.outcomeHeld || done.has(t.requestedBy)) continue;
      const due = t.outcomePending ? retryDue(t.outcomePending, at) : at - Date.parse(t.outcomeHeldAt ?? t.updatedAt) > OUTCOME_HOLD_MAX_MS;
      if (!due) continue;
      done.add(t.requestedBy);
      await this.settleRequester(projectId, t, '', `[MyCo] Tarefa “${t.title}” (id ${t.id}): ${outcomeLine(t)}.`, false, true);
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
      // Dúvida ao gestor ou a você: a conversa parou de propósito, à espera da resposta. Não é órfã.
      if (t.question?.status === 'open' || t.question?.status === 'escalated') return false;
      // Parou no teto (o motivo ficou guardado antes da interrupção): não é órfã nem vai para revisão. Vai para Aguardar.
      // Card automático não: a conversa é direta, o teto só encerrou o turno, e o card segue para revisão como qualquer entrega.
      const cap = t.autoCreated ? null : this.deps.turnCap?.(t.sessionId);
      if (cap) return !!(await this.parkForCap(projectId, taskId, t.sessionId, cap));
      // A retomada vale para esta ida a "fazendo": se ela saiu e voltou depois, conta de novo.
      const resumed = t.resumedAt && !t.history.some((h) => h.at > t.resumedAt! && h.status !== 'doing') ? t.resumedAt : null;
      if (now.getTime() - Date.parse(resumed ?? t.updatedAt) < ORPHAN_MS) return false;
      // Erro ao perguntar: não mexe (aqui, errar é mandar mensagem ou tirar de "fazendo" à toa)... até AWAITING_FAILS_MAX falhas seguidas:
      // daí a pergunta não está servindo, e a órfã retoma em vez de ficar parada para sempre.
      const sid = t.sessionId;
      const waitingLimit = await (this.deps.awaitingLimit?.(sid) ?? Promise.resolve(false)).then(
        (v) => {
          this.limitFails.delete(sid);
          return v;
        },
        () => {
          const fails = (this.limitFails.get(sid) ?? 0) + 1;
          this.limitFails.set(sid, fails);
          return fails < AWAITING_FAILS_MAX;
        },
      );
      if (waitingLimit) return false;
      // Card automático: ninguém mandou a conversa fazer isto, então o Club não manda "continue" nela; o que ela já alterou vai para revisão.
      if (resumed || t.autoCreated) {
        let stopped: Task | null = null;
        const seen: { before?: Task } = {};
        await this.change(projectId, taskId, (x) => {
          if (x.status !== 'doing') return x;
          seen.before = x;
          return (stopped = moved({ ...x, runId: null }, 'review', 'auto', 'conversa parou sem terminar'));
        });
        // Como numa entrega (commit e aviso ao gestor), mas sem testes nem revisão automática: está pela metade.
        if (stopped) {
          await this.logEnd(projectId, seen.before, 'stopped');
          await this.markDelivery(projectId, stopped);
          await this.recordDelivery(projectId, stopped, t.sessionId);
          await this.tellManager(projectId, stopped, t.sessionId, true);
          this.warnDependents(projectId, taskId, 'conversa parou sem terminar; está em revisão');
        }
        return true;
      }
      // A última ação ficou pela metade e mexe fora do projeto (push, deploy, servidor): retomar sozinho poderia repeti-la.
      // Segura a conversa para você (caixa de entrada) e a tarefa vai para Aguardar. Erro ao conferir: retoma como sempre.
      const cut = await (this.deps.restartCut?.(projectId, t.sessionId) ?? Promise.resolve(null)).catch(() => null);
      if (cut) return !!(await this.parkForCap(projectId, taskId, t.sessionId, cut));
      const at = now.toISOString();
      try {
        if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa de trabalho');
        await this.deps.sendTo(projectId, t.sessionId, staffId, RESUME_TEXT, []);
        // A retomada é a mesma tentativa (com o mesmo runId, se ela estava aberta): o fim dela sai com esse runId.
        const runId = await this.logStart(projectId, t, 'resume');
        await this.change(projectId, taskId, (x) => noted({ ...x, resumedAt: at, runId }, 'conversa parou sem terminar: retomada'));
      } catch (err) {
        // Reiniciando: a retomada não chegou e não conta como tentativa; o tick do boot tenta de novo.
        if (err instanceof ChatClosingError) return false;
        // Conta como a tentativa: na próxima, sem conversa trabalhando, vai para revisão.
        await this.change(projectId, taskId, (x) => noted({ ...x, resumedAt: at }, `conversa parou sem terminar; não deu para retomar: ${(err as Error).message}`));
      }
      return false;
    });
    if (freed) await this.kick(projectId, staffId);
  }

  /**
   * Alguma conversa dele trabalha (fora `own`)? Não contam as das tarefas paradas (`parked`): a pergunta por opções pendente de quem
   * espera a sua resposta deixa a conversa "ocupada" para o chat, mas não é trabalho. Com uma só dispensada vai o id, como sempre foi
   * (`exceptSession` de antes); sem nenhuma, a chamada de antes.
   */
  private staffBusy(projectId: string, tasks: Task[], staffId: string, own?: string): boolean {
    const idle = tasks.filter((t) => t.staffId === staffId && t.sessionId && !t.autoCreated && OCCUPIED.includes(t.status) && parked(t)).map((t) => t.sessionId!);
    // A revisão que ele faz roda em paralelo (não edita nada): não conta como trabalho, nem segura a fila dele nem o ajuste de outra tarefa dele.
    const reviewing = reviewSessionsOf(tasks, staffId);
    const except = [...idle.filter((s) => s !== own), ...(own ? [own] : []), ...reviewing.filter((s) => s !== own && !idle.includes(s))];
    return this.deps.isWorking?.(projectId, staffId, except.length > 1 ? except : except[0]) ?? false;
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

  /** Para quem chama de fora (rotina de tarefa, que já gravou a tarefa na fila): o mesmo `kick`, esperando a vez dele. */
  async kickStaff(projectId: string, staffId: string): Promise<void> {
    await this.kick(projectId, staffId);
  }

  /** Se ele está livre: primeiro os ajustes guardados (o mais antigo antes), depois a próxima da fila. */
  private kick(projectId: string, staffId: string): Promise<void> {
    return this.locked(projectId, staffId, () => this.takeNext(projectId, staffId)).catch(() => {});
  }

  /**
   * `taskId` acabou de ficar pronta ('done'; cancelada não passa por aqui, ela não libera ninguém): acorda o dono de cada tarefa que dependia dela e agora está livre (ver `blockers`).
   * Só fora de `locked`: o kick espera a vez do funcionário, e de dentro dela travaria. O kick é disparado sem await.
   */
  private async wakeDependents(projectId: string, taskId: string): Promise<void> {
    const tasks = (await this.list(projectId)) ?? [];
    for (const d of tasks)
      if (d.staffId && !isClosed(d) && d.blockedBy?.includes(taskId) && !blockers(d, tasks).length) void this.kick(projectId, d.staffId);
  }

  /**
   * `blockerId` ficou empacada por `reason` (já gravado): avisa o gestor (requestedBy) de cada dependente aberto, uma mensagem por
   * gestor. Sem `reason`, não faz nada. Sem `await`, de propósito: pode estar dentro de `locked` (órfã), e o aviso não pode esperar a vez.
   * Falha de aviso não quebra a transição (o catch fica aqui).
   */
  private warnDependents(projectId: string, blockerId: string, reason: string | null): void {
    if (!reason) return;
    void this.doWarnDependents(projectId, blockerId, reason).catch(() => {});
  }

  /**
   * Não repete: o último motivo avisado fica em `blockAlert` da bloqueadora, e só avisa de novo se o motivo mudar (ou ela voltar a
   * andar ou ficar pronta, ver mutate). Dependente sem gestor não recebe nada aqui: a caixa do dono mostra (ver stuckDependencies).
   * A marca só é gravada se todos os avisos foram entregues; senão, a próxima mudança tenta de novo.
   */
  private async doWarnDependents(projectId: string, blockerId: string, reason: string): Promise<void> {
    const notify = this.deps.notify;
    if (!notify) return;
    const tasks = (await this.list(projectId)) ?? [];
    const blocker = tasks.find((t) => t.id === blockerId);
    if (!blocker || blocker.status === 'done' || blocker.status === 'doing' || blocker.status === 'planning') return;
    if (blocker.blockAlert === reason) return;
    // Quem o dono mandou "continuar esperando" (ackCancelled, dentro do prazo) já foi decidido: não é aviso.
    const open = tasks.filter((d) => d.id !== blockerId && !isClosed(d) && d.requestedBy && d.blockedBy?.includes(blockerId) && !acked(d, blockerId));
    const byManager = new Map<string, Task[]>();
    for (const d of open) byManager.set(d.requestedBy!, [...(byManager.get(d.requestedBy!) ?? []), d]);
    if (!byManager.size) return;
    const sent = await Promise.allSettled(
      [...byManager].map(([managerId, deps]) => {
        // Na conversa em que pediram, se for uma só; senão, a mais recente dele (ver index.ts, `notify`).
        const sessions = new Set(deps.map((d) => d.requestedSession ?? null));
        return notify(projectId, managerId, blockedText(blocker, deps, reason), sessions.size === 1 ? ([...sessions][0] ?? null) : null);
      }),
    );
    if (sent.some((r) => r.status === 'rejected')) return;
    await this.change(projectId, blockerId, (t) => ({ ...t, blockAlert: reason }));
  }

  /**
   * As versões das skills que a ficha marca, pela pasta real (chave = ref, `global:x` ou `project:x`), para o registro da tentativa.
   * Erro: sai vazio, a tentativa abre do mesmo jeito.
   */
  private async skillsOf(projectId: string, profile: StaffProfile): Promise<Record<string, string>> {
    const refs = profile.skills ?? [];
    if (!refs.length || !this.deps.skillSources) return {};
    try {
      const sources = await this.deps.skillSources(projectId);
      const marked = convertSkills(refs, knownNamesOf(sources)).skills;
      const present = planSkills(marked, sources.globalSkills, sources.projectSkills).present;
      return await (this.deps.skillHashes ?? hashSkillFolders)(present.map((p) => ({ key: p.ref, dir: p.dir })));
    } catch {
      return {};
    }
  }

  private async takeNext(projectId: string, staffId: string): Promise<void> {
    const tasks = (await this.list(projectId)) ?? [];
    // A tarefa parada (dúvida escalada sem edição, ou com a resposta dela guardada esperando a vez dele) não ocupa: a próxima da fila começa, e o ajuste vai antes dela.
    // Quem ocupa (planejando ou fazendo) segura a fila; só o ajuste guardado dela própria pode ir, para a conversa que está rodando.
    const occ = occupant(tasks, staffId);
    // Só o ajuste que pode ir agora: o que já falhou espera a hora da próxima tentativa, e o que falhou HELD_MAX_FAILS vezes espera você (ver `stuckState`).
    const at = Date.now();
    const sendable = (t: Task) => (t.held ?? []).filter((m) => (m.attempts ?? 0) < HELD_MAX_FAILS && (!m.nextAt || Date.parse(m.nextAt) <= at));
    const adjust = tasks
      .filter((t) => t.staffId === staffId && t.sessionId && t.status !== 'cancelled' && (!occ || t.id === occ.id) && sendable(t).length)
      .sort((a, b) => sendable(a)[0]!.at.localeCompare(sendable(b)[0]!.at))[0];
    if ((occ && !adjust) || this.staffBusy(projectId, tasks, staffId, adjust?.sessionId ?? undefined)) return;
    if (adjust && this.deps.sendTo) {
      const sid = adjust.sessionId!;
      const held = sendable(adjust);
      // A resposta a uma pergunta por opções vai para a pergunta pendente da conversa; sem ela (a conversa reabriu), o texto vai como mensagem, como os outros.
      const answered = held.filter((m) => m.ask && this.deps.hasAsk?.(sid, m.ask.requestId) && this.deps.answerAsk?.(sid, m.ask.requestId, m.ask.answers, m.ask.by));
      const rest = held.filter((m) => !answered.includes(m));
      const text = rest.map((m) => m.text).filter(Boolean).join('\n\n');
      const origin = rest.map((m) => m.origin).filter(Boolean).join('\n\n');
      let failed: unknown = null;
      if (rest.length) {
        try {
          await this.deps.sendTo(projectId, sid, staffId, text, rest.flatMap((m) => m.images ?? []), origin || undefined);
        } catch (err) {
          failed = err;
        }
      }
      if (failed) {
        // Conta a falha em cada ajuste que ia junto, com a hora da próxima tentativa, e segue para a fila: um ajuste que não chega (limite de
        // consumo, conversa fechada) não pode segurar a próxima tarefa dele. A nota não se repete a cada tentativa. As respostas que já
        // chegaram à pergunta saem da lista.
        const failedIds = new Set(rest.map((m) => m.id));
        const answeredIds = new Set(answered.map((m) => m.id));
        const why = `o ajuste guardado não foi: ${(failed as Error).message}`;
        await this.change(projectId, adjust.id, (t) => {
          const at = new Date();
          const marked = { ...t, held: (t.held ?? []).filter((m) => !answeredIds.has(m.id)).map((m) => (failedIds.has(m.id) ? { ...m, attempts: (m.attempts ?? 0) + 1, nextAt: nextRetry((m.attempts ?? 0) + 1, at) } : m)) };
          return t.history.at(-1)?.note === why ? marked : noted(marked, why);
        });
      } else {
        const sent = new Set(held.map((m) => m.id));
        // O ajuste é a tentativa corrente da tarefa (ou abre uma, se ela não tinha nenhuma aberta).
        const runId = await this.logStart(projectId, adjust, 'adjust');
        await this.change(projectId, adjust.id, (t) => {
          const next = { ...t, runId, held: (t.held ?? []).filter((m) => !sent.has(m.id)) };
          // A conversa voltou a trabalhar: o card em "a fazer" ou em Aguardar vai para fazendo, senão ela roda por fora do status (`occupant` não vê o
          // funcionário ocupado e a retomada de queda, que olha "fazendo", não pega). Sai da fila: a conversa já tem a mensagem.
          if (t.autoCreated || (t.status !== 'todo' && t.status !== 'waiting')) return noted(next, 'ajuste guardado enviado');
          return moved({ ...next, queuedAt: null, queuedForce: false, resourceWait: null, startRetry: undefined, unqueued: undefined }, 'doing', 'auto', 'ajuste guardado enviado: a conversa voltou a trabalhar, a tarefa volta para fazendo');
        });
        return;
      }
    }
    // A que ocupa segue rodando: o ajuste que não foi (ou sem envio) não libera a fila dele.
    if (occ) return;
    // A fila dele na ordem de `queueCmp` (a posição de quem reordenou, depois a de entrada, `queuedAt`; empate: a ordem do quadro). Bloqueada pula (a checagem
    // é aqui, na hora de começar), e a que falhou por motivo dela espera a hora da próxima tentativa (`startRetry`) sem segurar as outras. Com conversa
    // (`sessionId`) é o card que voltou para "a fazer" depois de ter começado (ver `enqueueIdle`): a vez dele retoma essa conversa em vez de abrir outra.
    const ready = tasks
      .filter((t) => t.staffId === staffId && inQueue(t) && !heldFirst(t) && !blockers(t, tasks).length && (!t.startRetry || retryDue(t.startRetry, at)))
      .sort(queueCmp);
    if (!ready.length) return;
    const profile = await this.deps.readProfile(projectId, staffId);
    if (!profile) return;
    let lastWhy: string | null = null;
    for (const next of ready) {
      // A anterior pode ter aberto a conversa mesmo falhando (erro depois do envio): não abre outra por cima.
      if (next !== ready[0] && this.staffBusy(projectId, tasks, staffId)) return;
      // Só a partida automática passa pelo gate: começar à mão (start) ignora. Segurada, a tarefa fica na fila com o motivo. O gate vale para toda a fila: para aqui.
      const gate = await this.deps.resourceGate?.();
      if (gate && !gate.ok) return this.holdForResources(projectId, next.id, gate.reason);
      try {
        // Passou: a espera acabou (sai já, para não ficar "aguardando" se o limite de consumo barrar a partida logo depois).
        if (next.resourceWait) await this.change(projectId, next.id, (t) => ({ ...t, resourceWait: null }));
        // Tarefa de rotina entra na fila com o gatilho 'routine' (a fila não muda o que a abriu).
        // Null: a tarefa saiu da fila no meio (cancelada, ou já começou); segue a próxima.
        if (await (next.sessionId ? this.resumeTodo(projectId, next, profile) : this.startNow(projectId, next.id, profile, !!next.queuedForce, undefined, { trigger: next.routineId ? 'routine' : 'queue' }))) return;
      } catch (err) {
        const why = `não começou: ${(err as Error).message}`;
        // Motivo da fila toda (consumo, reinício): só esta ganha a nota e a fila para, sem repetir a nota a cada tick; "Começar" de novo tenta já.
        if (isGlobalStart(err)) {
          await this.change(projectId, next.id, (t) => (t.history.at(-1)?.note === why ? t : noted(t, why)));
          return;
        }
        // Motivo dela: continua na fila com a nota (uma vez) e a próxima tentativa com backoff; a próxima da fila segue neste tick.
        await this.change(projectId, next.id, (t) => {
          const marked = { ...t, startRetry: failedRetry(t.startRetry, err, new Date()) };
          return t.history.at(-1)?.note === why ? marked : noted(marked, why);
        });
        // A mesma falha em duas seguidas: a causa não é da tarefa (ex.: a ficha ou o motor dele). Não varre a fila inteira atrás dela.
        if (why === lastWhy) return;
        lastWhy = why;
      } finally {
        gate?.release();
      }
    }
  }

  /**
   * A vez de um card que voltou para "a fazer" tendo já uma conversa (você o arrastou de volta, ou a conversa seguiu depois de uma parada): em vez de abrir
   * outra, manda a retomada para a conversa dele, e o card vai para fazendo. Respeita a linha de parada de consumo como o início de uma tarefa (a menos que você
   * tenha confirmado ao pôr na fila). Devolve null se a tarefa saiu de "a fazer" no meio. Erro: o `takeNext` cuida (backoff da tarefa, ou a fila toda espera).
   */
  private async resumeTodo(projectId: string, task: Task, profile: StaffProfile): Promise<Task | null> {
    const sessionId = task.sessionId;
    if (!sessionId) return null;
    if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa de trabalho');
    const engine: Engine = task.fallback?.engine ?? (profile.engine === 'codex' ? 'codex' : 'claude');
    const stop = task.queuedForce ? null : await this.deps.stopHit?.(projectId, profile.id, engine).catch(() => null);
    if (stop) throw new UsageStopError(stop);
    // A conversa pode ter morrido no meio de uma ação com efeito fora do projeto (push, deploy, comando no servidor): retomar sozinho poderia repeti-la.
    // Mesma checagem da órfã: o corte já guardado (reinício ou retomada de turno) ou o que o transcript mostra agora. Segura para você (caixa de entrada)
    // e o card vai para Aguardar; erro ao conferir: retoma como sempre. Teto de ferramentas/minutos e retomadas esgotadas não são efeito incerto.
    const held = this.deps.turnCap?.(sessionId);
    const cut = (held && (held.kind === 'restart' || (held.kind === 'retry' && held.why === 'cut')) ? held : null) ?? (await (this.deps.restartCut?.(projectId, sessionId) ?? Promise.resolve(null)).catch(() => null));
    if (cut) {
      await this.parkForCap(projectId, task.id, sessionId, cut);
      return null;
    }
    const text = [
      `[Tarefa "${task.title}"]`,
      'A tarefa voltou para "A fazer" e chegou a sua vez: retome-a nesta conversa, de onde parou (o que já foi feito vale).',
      ...(await this.requesterLines(projectId, task)),
      task.description,
      task.goal && `Meta: ${task.goal}`,
      task.acceptance && `Critério de aceite: ${task.acceptance}`,
      this.cancelLine(projectId, task, engine),
      CLOSING_LINE,
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.deps.sendTo(projectId, sessionId, profile.id, text, []);
    const runId = await this.logStart(projectId, task, 'resume');
    return this.change(projectId, task.id, (t) => {
      if (t.status !== 'todo' || t.sessionId !== sessionId) return t;
      const next: TaskStatus = profile.autonomy === 'plan' && !t.plan ? 'planning' : 'doing';
      return moved({ ...t, queuedAt: null, queuedForce: false, resourceWait: null, startRetry: undefined, unqueued: undefined, runId }, next, 'auto', `retomada na fila, na conversa que ela já tinha, com ${profile.name}`);
    });
  }

  /**
   * O gate de recursos segurou a partida: a tarefa fica na fila com o motivo e desde quando (`resourceWait`). A nota no
   * histórico só quando o estado muda (de liberado para segurado); o tick repete o motivo sem gravar nota nova.
   */
  private async holdForResources(projectId: string, taskId: string, reason: string): Promise<void> {
    const at = new Date().toISOString();
    await this.change(projectId, taskId, (t) => {
      if (t.resourceWait?.reason === reason) return t;
      const next = { ...t, resourceWait: { reason, since: t.resourceWait?.since ?? at } };
      return t.resourceWait ? next : noted(next, `aguardando recursos: ${reason}`);
    });
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
    // Cancelada não é entrega: mesclar a levaria para "pronto" e liberaria quem depende dela.
    if (task.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: não dá para mesclar');
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    try {
      const m = await mergeCode(dir, place, task.title, { skipTests, upTo: deliveredAt(task) });
      let cancelledMeanwhile = false;
      const out = await this.change(projectId, taskId, (t) => {
        // A mescla demora: cancelada nesse intervalo, a tarefa NÃO vira pronta (liberaria quem depende dela). O código já entrou, e fica dito no histórico.
        if (t.status === 'cancelled') {
          cancelledMeanwhile = true;
          return noted(t, `mesclado em ${m.base} (${m.sha}) depois de cancelada: a tarefa continua cancelada`);
        }
        return moved({ ...t, tests: m.tests ?? t.tests ?? null, merged: { at: new Date().toISOString(), sha: m.sha, branch: m.branch, base: m.base } }, 'done', 'auto', `mesclado em ${m.base} (${m.sha})`);
      });
      if (cancelledMeanwhile) throw new TaskConflictError(`a tarefa foi cancelada durante a mescla: o código já entrou em ${m.base} (${m.sha}), mas ela continua cancelada`);
      await this.wakeDependents(projectId, taskId);
      if (out?.status === 'done') await this.settleRequester(projectId, out, `mesclada em ${m.base}, foi para pronto`, null);
      return out;
    } catch (err) {
      if (err instanceof CodeError && err.tests) await this.change(projectId, taskId, (t) => ({ ...t, tests: err.tests }));
      throw err;
    }
  }

  /**
   * Pede a outro funcionário que revise o código da tarefa (numa conversa nova dele). `assign`: o pedido
   * do quadro marca esse revisor na tarefa (reviewerId), e o veredito move a tarefa como na revisão
   * automática. Sem ele, só anota a revisão e o revisor marcado (se houver) não muda.
   * `delivery` (só o caminho automático, ver `autoReview`): `at` da entrega que motivou o pedido. Ao gravar, a tarefa tem de continuar em
   * "revisão" e nessa entrega; se mudou enquanto a conversa do revisor abria (cancelada, aprovada, nova entrega), é conflito e nada é gravado.
   */
  async requestReview(projectId: string, taskId: string, reviewerId: string, force = false, opts: { assign?: boolean; delivery?: { at: string | null } } = {}): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    if (task.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: reabra antes de pedir revisão');
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
    // Card automático: o projeto pode ter mudanças de outras conversas, então a lista do que ESTA conversa alterou é a que vale.
    const own = task.autoCreated && task.changedFiles?.length ? `Arquivos que esta conversa alterou (confira só eles): ${task.changedFiles.slice(0, 30).join(', ')}${task.changedFiles.length > 30 ? '…' : ''}` : '';
    const guide = (await hasGuide(dir)) ? 'Leia `SPEC.md`: o que contrariar o guia é 🔴.' : '';
    // Severidade: só 🔴 reprova. Com 🟡 ou 🟢 apenas, a primeira linha é APROVADO e a lista vira observações.
    const text = [
      `[Revisão da tarefa "${task.title}"]`,
      `${profile?.name ?? 'Um colega'} terminou a tarefa e ela precisa de revisão.`,
      task.description && `O que foi pedido:\n${task.description}`,
      task.acceptance && `Critério de aceite (confira a entrega contra ele):\n${task.acceptance}`,
      where,
      files,
      own,
      // Só de tarefa pedida por gestor os testes são da última entrega (workDone roda); fora disso podem ser velhos.
      task.requestedBy ? testsLine(task.tests) : '',
      guide,
      'Responda com APROVADO ou REPROVADO na primeira linha, exatamente assim. Em seguida, os achados, cada um com arquivo:linha, o porquê e a severidade: 🔴 bloqueia, 🟡 importante, 🟢 detalhe. REPROVADO só se houver algum 🔴; só 🟡 ou 🟢 é APROVADO, com a lista depois como observações. Algo inventado (API, arquivo, opção ou resultado que não existe) é 🔴. Não mude o código: só revise.',
    ]
      .filter(Boolean)
      .join('\n\n');
    // Só aprova ou reprova: a conversa abre sem edição de arquivo (ver `reviewOnly`) e não entra na fila de trabalho dele (ver `staffBusy`).
    const sessionId = await this.deps.send(projectId, reviewer.id, text, force, undefined, true);
    this.bySession.set(sessionId, { projectId, taskId, role: 'review' });
    const at = new Date().toISOString();
    try {
      return await this.change(projectId, taskId, (t) => {
        // Cancelada enquanto a conversa do revisor abria: ela não volta para "revisão" (um APROVADO depois a levaria a pronto).
        if (t.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: reabra antes de pedir revisão');
        if (opts.delivery && !onDelivery(t, opts.delivery.at)) throw new TaskConflictError('a tarefa mudou desde a entrega: a revisão automática não vale mais');
        return withSession(
          moved({ ...t, review: { staffId: reviewer.id, sessionId, at }, reviewRetry: undefined, ...(opts.assign && { reviewerId: reviewer.id }) }, 'review', 'auto', `revisão pedida a ${reviewer.name}`),
          { id: sessionId, role: 'review', staffId: reviewer.id, engine: reviewer.engine === 'codex' ? 'codex' : 'claude', at },
        );
      });
    } catch (err) {
      // A conversa do revisor já abriu e a tarefa não a guarda: ela não fica revisando por conta de ninguém.
      this.bySession.delete(sessionId);
      await this.silenceSession(sessionId);
      throw err;
    }
  }

  /** Pede o deploy ao funcionário de infra, com o checklist (backup, estado antes e depois, runbook). */
  async requestDeploy(projectId: string, taskId: string, infraId: string, force = false): Promise<Task | null> {
    const { task } = await this.context(projectId, taskId);
    if (task.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: não há o que publicar');
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
    try {
      return await this.change(projectId, taskId, (t) => {
        // Cancelada enquanto a conversa de deploy abria: não publica nada por uma tarefa que não vai ser entregue.
        if (t.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: não há o que publicar');
        const at = new Date().toISOString();
        const history = [...t.history, { at, status: t.status, by: 'auto' as const, note: `deploy pedido a ${infra.name}` }].slice(-MAX_HISTORY);
        return { ...t, deploy: { staffId: infra.id, sessionId, at }, history, updatedAt: at };
      });
    } catch (err) {
      this.bySession.delete(sessionId);
      await this.silenceSession(sessionId);
      throw err;
    }
  }

  /** Aprovou o plano da conversa: planejando → fazendo, com o plano guardado. */
  async onPlanApproved(sessionId: string, plan: string): Promise<void> {
    // Cancelada: o cartão do plano que ficou pendente não executa nada, nem grava o plano (ver `silenceSession`, que o nega ao cancelar).
    await this.onSession(sessionId, 'work', (t) => (t.status === 'cancelled' ? t : t.status === 'planning' || t.status === 'todo' ? moved({ ...t, plan }, 'doing', 'auto', 'plano aprovado') : { ...t, plan }));
  }

  /**
   * Recusou o plano da conversa: planejando → aguardar, sem executar. Quem pediu é avisado e a fila do
   * funcionário anda. Fora de planejando, não mexe.
   */
  async onPlanRejected(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return;
    let rejected: Task | null = null;
    const seen: { before?: Task } = {};
    await this.change(where.projectId, where.taskId, (t) => {
      if (t.status !== 'planning') return t;
      seen.before = t;
      rejected = moved({ ...t, runId: null }, 'waiting', 'auto', 'plano recusado pelo usuário');
      return rejected;
    });
    const out = rejected as Task | null;
    if (!out) return;
    this.warnDependents(where.projectId, out.id, stuckReason(out));
    // O plano recusado não vai ser executado: a tentativa (se aberta) fecha como cancelada.
    await this.logEnd(where.projectId, seen.before, 'cancelled', 'plano recusado');
    await this.tellRequester(where.projectId, out, `[MyCo] O usuário recusou o plano da tarefa “${out.title}” (id ${out.id}); ela foi para Aguardar e não será executada.`);
    if (out.staffId) await this.kick(where.projectId, out.staffId);
  }

  /**
   * Pergunta com opções (AskUserQuestion) na conversa de trabalho de uma tarefa pedida por gestor: vai para ele, numa conversa
   * nova dele, e a tarefa segue. True se foi ao gestor; false, a pergunta fica com você, como antes.
   */
  async onAsk(sessionId: string, requestId: string, questions: NonNullable<TaskQuestion['questions']>): Promise<boolean> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work') return false;
    const t = ((await this.list(where.projectId)) ?? []).find((x) => x.id === where.taskId);
    if (!t?.requestedBy || (t.status !== 'doing' && t.status !== 'planning')) return false;
    // Uma dúvida por vez: com outra aberta ou escalada, esta fica com você.
    if (t.question && t.question.status !== 'answered') return false;
    return this.askManager(where.projectId, t, { id: requestId, source: 'ask', questions, status: 'open', askedAt: new Date().toISOString() });
  }

  /** A pergunta foi respondida na conversa do funcionário (pelo usuário, no chat): fecha a dúvida. Repetida, não muda nada. */
  async onAskAnswered(sessionId: string, requestId: string, by: 'manager' | 'user', summary: string): Promise<void> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work') return;
    await this.change(where.projectId, where.taskId, (t) => closeQuestion(t, requestId, by, summary) ?? t);
  }

  /**
   * A dúvida da tarefa é respondida pelo gestor que pediu (pela API, na conversa dele ou na que a dúvida abriu) ou por você (`asUser`, só
   * quando a rota vem do navegador pareado: nunca do corpo do pedido). Pergunta por opções: a resposta vai para a conversa do funcionário
   * (deps.answerAsk). Dúvida escrita: vai a ele como mensagem (guardada, se ele está ocupado). `escalate` (só do gestor): a decisão é do
   * usuário, a dúvida passa para você; você não tem para quem escalar. Quem responde primeiro fecha: a outra resposta leva 409, e o
   * funcionário recebe uma só. A conferência e o fechamento acontecem na vez do funcionário (`locked`), no mesmo passo do envio.
   */
  async answerQuestion(
    projectId: string,
    taskId: string,
    caller: { staffId: string; sessionId: string } | null,
    body: { questionId: string; answers?: Record<string, string | string[]>; text?: string; escalate?: boolean },
    asUser = false,
  ): Promise<Task | null> {
    const { task } = await this.context(projectId, taskId);
    if (!asUser && !caller) throw new TaskForbiddenError('só o gestor que pediu a tarefa responde à dúvida dela');
    if (task.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: a dúvida não vale mais');
    if (!asUser && caller!.staffId !== task.requestedBy) throw new TaskForbiddenError('só o gestor que pediu a tarefa responde à dúvida dela');
    const q = task.question;
    if (!asUser && caller!.sessionId !== q?.managerSession && caller!.sessionId !== task.requestedSession) throw new TaskForbiddenError('responda pela conversa em que a dúvida chegou');
    if (!q || q.id !== body.questionId) throw new TaskError('não há essa dúvida aberta nesta tarefa');
    if (q.status === 'answered') throw answeredConflict(q);
    if (body.escalate) {
      if (asUser) throw new TaskError('a dúvida já é sua: responda a ela');
      const out = await this.change(projectId, taskId, (t) =>
        t.question?.id === q.id && t.question.status !== 'answered'
          ? noted({ ...t, question: { ...t.question, status: 'escalated', escalatedAt: new Date().toISOString(), pending: undefined } }, 'o gestor não decide: vai para você')
          : t,
      );
      if (out) this.freeQueue(projectId, out);
      return out;
    }
    const by = asUser ? 'user' : 'manager';
    const answers = body.answers;
    const from = asUser ? 'do usuário' : `de ${(await this.deps.readProfile(projectId, caller!.staffId))?.name ?? 'o gestor'}`;
    if (q.source === 'ask') {
      if (!answers) throw new TaskError('a pergunta é por opções: mande answers');
      // Sem a pergunta pendente na conversa (ou sem como respondê-la), não há o que responder: 409.
      const gone = () => new TaskConflictError('essa pergunta já foi respondida (não está mais aberta na conversa do funcionário)');
      const askStaff = task.staffId;
      const askSession = task.sessionId;
      if (!askStaff || !askSession) throw gone();
      return this.locked(projectId, askStaff, async () => {
        // Na vez dele, de novo: cancelada ou já respondida por outro enquanto esperava, a resposta não chega à pergunta.
        this.stillOpen(await this.fresh(projectId, taskId), q.id);
        if (!this.deps.hasAsk?.(askSession, q.id)) throw gone();
        // Ele está em outra tarefa: a resposta espera a vez dele, como ajuste guardado, e chega à pergunta antes da fila (ver `takeNext`).
        // A pergunta continua pendente na conversa parada até lá (ela não conta como trabalho, ver `staffBusy`).
        const held = await this.hold(askSession, { text: `Resposta ${from} à sua dúvida: ${answersText(answers)}`, ask: { requestId: q.id, answers, by }, doubt: true });
        if (!held && !this.deps.answerAsk?.(askSession, q.id, answers, by)) throw gone();
        return this.change(projectId, taskId, (t) => closeQuestion(t, q.id, by, answersText(answers)) ?? t);
      });
    }
    const text = (body.text ?? (answers ? answersText(answers) : '')).trim();
    if (!text) throw new TaskError('escreva a resposta (text)');
    if (text.length > QUESTION_TEXT_MAX) throw new TaskError(`resposta longa demais (máx. ${QUESTION_TEXT_MAX})`);
    const sendTo = this.deps.sendTo;
    if (!task.staffId || !task.sessionId || !sendTo) throw new TaskError('sem conversa de trabalho para mandar a resposta');
    const staffId = task.staffId;
    const work = task.sessionId;
    const msg = `Resposta ${from} à sua dúvida: ${text}`;
    // Ocupado com outra tarefa, a resposta espera a vez dele (como um ajuste guardado); se o envio falhar, nada é marcado.
    return this.locked(projectId, staffId, async () => {
      // Na vez dele, de novo: cancelada ou já respondida por outro enquanto esperava, a resposta não vai para a conversa dela (nem fica guardada).
      this.stillOpen(await this.fresh(projectId, taskId), q.id);
      if (!(await this.hold(work, { text: msg, doubt: true }))) await sendTo(projectId, work, staffId, msg, []);
      return this.change(projectId, taskId, (t) => closeQuestion(t, q.id, by, text) ?? t);
    });
  }

  /** A tarefa como está agora no arquivo (a conferência na vez do funcionário). */
  private async fresh(projectId: string, taskId: string): Promise<Task | undefined> {
    return ((await this.list(projectId)) ?? []).find((t) => t.id === taskId);
  }

  /** A dúvida `qid` ainda aceita resposta? Cancelada, trocada ou já respondida (por quem for): 409 com o que foi dito. */
  private stillOpen(t: Task | undefined, qid: string): void {
    if (t?.status === 'cancelled') throw new TaskConflictError('a tarefa foi cancelada: a dúvida não vale mais');
    if (!t?.question || t.question.id !== qid) throw new TaskConflictError('essa dúvida não está mais aberta nesta tarefa');
    if (t.question.status === 'answered') throw answeredConflict(t.question);
  }

  /**
   * Dúvida no fim do turno (tarefa de gestor, em fazendo ou planejando). Com `DÚVIDA:` na última mensagem, leva ao gestor (se
   * não há dúvida aberta) e a tarefa não entrega: true. Sem o marcador, a dúvida escrita aberta é fechada (o funcionário seguiu
   * em frente) e a entrega segue. Pergunta por opções aberta não fecha sozinha (o turno não acabou): true.
   */
  private async doubtHeld(projectId: string, t: Task, sessionId: string): Promise<boolean> {
    if (!t.requestedBy || (t.status !== 'doing' && t.status !== 'planning')) return false;
    const open = t.question && t.question.status !== 'answered' ? t.question : null;
    const text = doubtFrom(this.deps.lastText?.(sessionId) ?? null);
    if (text) {
      if (!open) await this.askManager(projectId, t, { id: `q-${randomBytes(3).toString('hex')}`, source: 'text', text, status: 'open', askedAt: new Date().toISOString() });
      return true;
    }
    if (!open) return false;
    if (open.source === 'ask') return true;
    await this.change(projectId, t.id, (x) => closeQuestion(x, open.id, 'user', 'o funcionário seguiu sem a resposta do gestor') ?? x);
    return false;
  }

  /**
   * Leva a dúvida ao gestor que pediu: numa conversa nova dele, com a pergunta e como responder. Sem endereço da API ou no limite de
   * dúvidas, ela vai direto para você (escalada). Envio que falha por motivo que passa (limite de consumo, conversa fechando) fica
   * `open` com `pending`: o tick tenta de novo com backoff (ver `sendDoubt`). True se foi ao gestor agora.
   */
  private async askManager(projectId: string, t: Task, q: TaskQuestion): Promise<boolean> {
    const manager = t.requestedBy;
    const count = t.questionCount ?? 0;
    if (!manager) return false;
    const { apiUrl } = await this.doubtRoute(projectId, manager);
    if (!apiUrl || count >= MAX_QUESTIONS) {
      const why = count >= MAX_QUESTIONS ? `já são ${MAX_QUESTIONS} dúvidas ao gestor: esta vai para você` : 'sem endereço da API o gestor não tem como responder: vai para você';
      await this.change(projectId, t.id, (x) => noted({ ...x, question: { ...q, status: 'escalated', escalatedAt: new Date().toISOString() } }, why));
      this.freeQueue(projectId, t);
      return false;
    }
    // A contagem (`questionCount`) só sobe quando a dúvida chega ao gestor, uma vez por dúvida: tentar de novo não gasta as MAX_QUESTIONS.
    await this.change(projectId, t.id, (x) => noted({ ...x, question: { ...q, status: 'open' } }, 'dúvida levada ao gestor'));
    return this.sendDoubt(projectId, t.id, q.id);
  }

  /** O gestor responde pelo endereço do motor da ficha dele: o Codex roda na sandbox, que não alcança 127.0.0.1. */
  private async doubtRoute(projectId: string, manager: string): Promise<{ engine: Engine; apiUrl: string | undefined; known: boolean }> {
    const profile = await this.deps.readProfile(projectId, manager);
    const engine: Engine = profile?.engine ?? 'claude';
    return { engine, apiUrl: engine === 'codex' ? this.deps.sandboxApiUrl : this.deps.apiUrl, known: !!profile };
  }

  /**
   * Manda a dúvida `qid` ao gestor, se ela ainda precisa ir: relê a tarefa e confere que não está encerrada, que é esta dúvida, que não foi
   * respondida e que o gestor ainda não a recebeu (`managerSession`). Um por vez por dúvida (`inFlight`), então dois `tick` juntos mandam um
   * envio só. Chegando, grava a conversa do gestor, conta a dúvida (`questionCount`, uma vez) e limpa o `pending`. Falhando, `doubtFailed`.
   */
  private async sendDoubt(projectId: string, taskId: string, qid: string): Promise<boolean> {
    const key = `doubt:${projectId}:${qid}`;
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    try {
      const t = await this.fresh(projectId, taskId);
      const q = t?.question;
      const manager = t?.requestedBy;
      if (!t || !manager || isClosed(t) || !q || q.id !== qid || q.status === 'answered' || q.managerSession) return false;
      try {
        const { engine, apiUrl, known } = await this.doubtRoute(projectId, manager);
        if (!known) throw new PermanentError('o gestor não está mais na equipe');
        if (!apiUrl) throw new PermanentError('sem endereço da API o gestor não tem como responder');
        const who = (t.staffId ? await this.deps.readProfile(projectId, t.staffId) : null)?.name ?? 'O funcionário';
        const managerSession = await this.deps.send(projectId, manager, doubtText(apiUrl, projectId, t, who, q), false);
        this.bySession.set(managerSession, { projectId, taskId, role: 'question' });
        await this.change(projectId, taskId, (x) =>
          x.question?.id === qid && !x.question.managerSession
            ? withSession(
                { ...x, questionCount: (x.questionCount ?? 0) + 1, question: { ...x.question, managerSession, pending: undefined } },
                { id: managerSession, role: 'question', staffId: manager, engine, at: new Date().toISOString() },
              )
            : x,
        );
        return true;
      } catch (err) {
        await this.doubtFailed(projectId, taskId, qid, err);
        return false;
      }
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * O envio da dúvida ao gestor falhou. Passa sozinho (limite de consumo, conversa fechando, envio): continua `open` (ou `escalated`, se já
   * foi para você) com `pending` = próxima tentativa; a nota entra só na primeira vez. Não passa (sem API, gestor fora da equipe): vai para você.
   */
  private async doubtFailed(projectId: string, taskId: string, qid: string, err: unknown): Promise<void> {
    const error = (err as Error).message;
    const now = new Date();
    const out = await this.change(projectId, taskId, (x) => {
      const q = x.question;
      if (!q || q.id !== qid || q.status === 'answered' || q.managerSession) return x;
      if (!isTransient(err)) {
        return noted({ ...x, question: { ...q, status: 'escalated', escalatedAt: q.escalatedAt ?? now.toISOString(), pending: undefined } }, `não deu para levar a dúvida ao gestor (${error}): vai para você`);
      }
      const next = { ...x, question: { ...q, pending: failedRetry(q.pending, err, now) } };
      return q.pending ? next : noted(next, `não deu para levar a dúvida ao gestor (${error}): nova tentativa em instantes`);
    });
    if (out?.question?.status === 'escalated') this.freeQueue(projectId, out);
  }

  /** Mandou mensagem na conversa da tarefa: em revisão, ela volta para "fazendo". */
  async onSent(sessionId: string): Promise<void> {
    // Card automático não volta: a edição seguinte depois da revisão abre um card novo (ver `onCodeEdit`); só a reprovação o devolve a "fazendo".
    await this.onSession(sessionId, 'work', (t) => (t.status === 'review' && !t.autoCreated ? moved(t, 'doing', 'auto', 'você respondeu') : null));
  }

  /**
   * A revisão automática do quadro deste projeto (ver boardConfig.ts); null se o projeto não existe. Responsável que já não é da equipe
   * não vale: volta como desligada (o arquivo só muda quando você grava de novo).
   */
  async boardConfig(projectId: string): Promise<BoardConfig | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const config = await readBoardConfig(dir);
    if (config.reviewerId && !(await this.deps.readProfile(projectId, config.reviewerId))) return DEFAULT_BOARD_CONFIG;
    return config;
  }

  /**
   * Grava a revisão automática do quadro: `{ autoReview, reviewerId }`, os dois sempre. Ligada exige o responsável, que precisa ser da
   * equipe do projeto. Desligada guarda o responsável escolhido (a tela o mostra de novo ao ligar). Vale para as tarefas que chegarem
   * em revisão daqui para a frente (ver `reviewerOf`). Só a tela chama (a rota confere). TaskError (400) se o corpo é inválido.
   */
  async setBoardConfig(projectId: string, body: unknown): Promise<BoardConfig | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const input = parseOr(BoardConfigInput, body);
    if (input.autoReview && !input.reviewerId) throw new TaskError('escolha quem revisa');
    if (input.reviewerId && !(await this.deps.readProfile(projectId, input.reviewerId))) throw new TaskError('revisor não encontrado neste projeto');
    await writeBoardConfig(dir, input);
    return input;
  }

  /**
   * Um funcionário alterou arquivo(s) com as ferramentas de edição (ver chat/codeEdits.ts; Claude e Codex do mesmo jeito). Toda alteração de
   * código de uma conversa SEM tarefa fica registrada no quadro: o Club abre sozinho um card ligado a ela (`autoCreated`, `sessionId`),
   * em "fazendo", com o funcionário como responsável, sem `requestedBy` (como o card que você cria) e com o pedido como descrição. No fim
   * do turno ele vai para "revisão" (ver `workDone`) com a lista dos arquivos (`changedFiles`), e a revisão segue `reviewerOf`.
   *
   * Idempotente: uma conversa tem no máximo um card automático em "fazendo". Evento repetido, edições juntas e reinício só juntam arquivos
   * ao card aberto; a edição que vem depois de o card ir para "revisão" (ou fechar) abre um card novo. Conversa de trabalho de tarefa
   * comum não abre card: só junta os arquivos à lista da tarefa (`noteTaskEdit`). Fora: revisão, deploy e dúvida, o que fica fora da
   * pasta do projeto e tudo em `.myco/` (ver `codePath`).
   *
   * É registro, não trava: a escrita nunca espera por isto (quem chama não espera, e erro aqui só é engolido pelo chamador). Limite
   * aceito: edição só por shell (`sed`, `node -e`, scripts) não é vista, então não gera card.
   */
  onCodeEdit(ev: CodeEdit): Promise<void> {
    // Uma de cada vez por conversa (e o fim do turno espera pela fila, ver `workDone`): duas edições juntas nunca abrem dois cards.
    const run = (this.edits.get(ev.sessionId) ?? Promise.resolve()).then(() => this.recordEdit(ev));
    const tail = run.catch(() => {});
    this.edits.set(ev.sessionId, tail);
    void tail.then(() => {
      if (this.edits.get(ev.sessionId) === tail) this.edits.delete(ev.sessionId);
    });
    return run;
  }

  private async recordEdit(ev: CodeEdit): Promise<void> {
    const dir = await this.deps.projectPath(ev.projectId);
    if (!dir) return;
    // Primeiro o que é barato: memória, ficha e o que está fora do projeto saem aqui, sem tocar no quadro.
    const files = [...new Set(ev.files.map((f) => codePath(f, ev.cwd, dir)).filter((f): f is string => !!f))];
    if (!files.length) return;
    const where = await this.where(ev.sessionId);
    // O trabalho de uma tarefa comum: a edição entra na lista dela, que é a prova de "nada editado ainda" da dúvida escalada (ver `releasesStaff`).
    if (where?.role === 'work' && !where.auto) return this.noteTaskEdit(where.projectId, where.taskId, ev.sessionId, dir, files);
    // A conversa já é de uma tarefa (revisão, deploy ou dúvida), ou a troca de motor a deixou para trás: o card é o dela.
    if (where ? !(where.role === 'work' && where.auto) : await this.isTaskConversation(ev.sessionId)) return;
    const open = (await readTasks(dir)).find(openAutoCard(ev.sessionId));
    if (open && files.every((f) => open.changedFiles?.includes(f))) return;
    const profile = await this.deps.readProfile(ev.projectId, ev.staffId);
    if (!profile) return;
    // O que só o card novo precisa (o aberto já tem): fora da gravação, que é uma por vez por projeto.
    const request = open ? '' : requestOf(ev.request);
    const title = open ? '' : autoTitle((await this.deps.conversationTitle?.(ev.sessionId).catch(() => null)) ?? null, request);
    const branch = open ? null : await this.deps.branchFor(dir, profile).catch(() => null);
    const now = new Date().toISOString();
    const card: Task = {
      id: `t-${randomBytes(3).toString('hex')}`,
      title,
      description: request,
      goal: null,
      acceptance: null,
      status: 'doing',
      staffId: profile.id,
      reviewerId: null,
      sessionId: ev.sessionId,
      sessions: [{ id: ev.sessionId, role: 'work', staffId: profile.id, engine: ev.engine, at: now }],
      plan: null,
      branch,
      pr: null,
      createdAt: now,
      updatedAt: now,
      autoCreated: true,
      changedFiles: files.slice(0, CHANGED_FILES_MAX),
      history: [{ at: now, status: 'doing', by: 'auto', note: `card automático: ${profile.name} alterou código do projeto` }],
    };
    const seen: { created?: Task } = {};
    // Confere de novo, dentro da gravação: ela é uma por vez por projeto, e o card aberto de agora pode ser outro (ou nenhum).
    const ok = await this.mutate(ev.projectId, (tasks) => {
      const cur = tasks.find(openAutoCard(ev.sessionId));
      if (!cur) {
        // O card aberto sumiu entre a leitura e a gravação (foi para revisão ou cancelado): o novo sai sem o pedido, que só se lê com ele.
        seen.created = card.title ? card : { ...card, title: AUTO_TITLE };
        return [...tasks, seen.created];
      }
      const merged = [...new Set([...(cur.changedFiles ?? []), ...files])].slice(0, CHANGED_FILES_MAX);
      if (merged.length === (cur.changedFiles?.length ?? 0)) return tasks;
      return tasks.map((t) => (t.id === cur.id ? { ...t, changedFiles: merged, updatedAt: now } : t));
    });
    if (ok && seen.created) this.bySession.set(ev.sessionId, { projectId: ev.projectId, taskId: seen.created.id, role: 'work', auto: true });
  }

  /** Junta `files` à lista da tarefa comum cuja conversa de trabalho é `sessionId` (só enquanto a tarefa está aberta e a conversa é a atual dela). Sem novidade, não grava. */
  private async noteTaskEdit(projectId: string, taskId: string, sessionId: string, dir: string, files: string[]): Promise<void> {
    const current = (await readTasks(dir)).find((t) => t.id === taskId);
    if (!current || current.sessionId !== sessionId || isClosed(current) || files.every((f) => current.changedFiles?.includes(f))) return;
    await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.id !== taskId || t.sessionId !== sessionId || isClosed(t)) return t;
        const merged = [...new Set([...(t.changedFiles ?? []), ...files])].slice(0, CHANGED_FILES_MAX);
        return merged.length === (t.changedFiles?.length ?? 0) ? t : { ...t, changedFiles: merged };
      }),
    );
  }

  /**
   * O turno de uma conversa da tarefa terminou. Do trabalho: fazendo → revisão. Da revisão: anota a
   * resposta e o veredito, e com revisor automático aprova ou reprova (ver onReviewTurn). Do deploy:
   * anota que a resposta chegou (a tarefa não muda de coluna sozinha por isso).
   */
  async onTurnDone(sessionId: string): Promise<void> {
    // Fechando: nada conclui (ver `onIdle`). A tarefa fica em "fazendo" e a órfã do boot retoma a conversa.
    if (this.deps.closing?.()) return;
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
    // Sem veredito, com o revisor marcado: re-pede UMA vez daqui a REASK_AFTER_MS (ver `chaseReviews`).
    const task = await this.change(where.projectId, where.taskId, (t) => {
      const answered = noteHandoff(t, 'review', 'revisão respondida', verdict) ?? t;
      return isCurrent && verdict === null ? withReask(answered) : answered;
    });
    if (!task || !isCurrent || !verdict || task.status !== 'review' || !task.reviewerId || task.reviewerId !== task.review?.staffId) return;
    const reviewer = (await this.deps.readProfile(where.projectId, task.reviewerId))?.name ?? 'o revisor';
    if (verdict === 'approved') return this.approve(where.projectId, task.id, reviewer);
    return this.reject(where.projectId, task.id, reviewer, reviewText ?? '');
  }

  /** Aprovada pelo revisor: pronto, a não ser que o código ainda esteja numa worktree por mesclar. */
  private async approve(projectId: string, taskId: string, reviewer: string): Promise<void> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    // Veredito que chega depois de a tarefa sair de "revisão" (cancelada, por exemplo) não decide nada.
    if (task.status !== 'review') return;
    const place = task.staffId ? await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null) : null;
    const head = `[MyCo] Tarefa “${task.title}” (id ${task.id}): `;
    if (place?.where === 'worktree' && !task.merged) {
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `aprovada por ${reviewer}; falta mesclar`) : t));
      if (selfReview(task)) await this.tellRequester(projectId, task, `${head}aprovada; falta mesclar a worktree.`);
      return;
    }
    const done = await this.change(projectId, taskId, (t) => (t.status === 'review' ? moved(t, 'done', 'auto', `aprovada por ${reviewer}`) : t));
    if (done?.status !== 'done') return;
    await this.wakeDependents(projectId, taskId);
    await this.settleRequester(projectId, done, 'foi para pronto', selfReview(task) ? `${head}aprovada na sua revisão, foi para pronto.` : null);
  }

  /**
   * Reprovada: a resposta do revisor vai para a conversa de trabalho, como ajuste. Com ele ocupado
   * (outra tarefa, ou outra conversa dele), o ajuste fica guardado e a tarefa segue em revisão; quando
   * a mensagem for enviada, ela volta para fazendo. Livre, a tarefa vai para fazendo e a mensagem
   * entra na conversa dele. Quando o turno dele terminar, a próxima rodada é pedida (workDone).
   */
  private async reject(projectId: string, taskId: string, reviewer: string, reviewText: string): Promise<void> {
    const { dir, task } = await this.context(projectId, taskId);
    // Veredito que chega depois de a tarefa sair de "revisão" (cancelada, por exemplo): não manda ajuste nenhum.
    if (task.status !== 'review') return;
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
      // Na vez dele, de novo: cancelada (ou fora de revisão) enquanto esperava, nada é guardado nem mandado à conversa dela.
      const now = ((await this.list(projectId)) ?? []).find((t) => t.id === taskId);
      if (now?.status !== 'review' || now.sessionId !== work) return;
      const reason = await this.hold(work, { text: msg });
      if (reason) {
        await this.change(projectId, taskId, (t) => (t.status === 'review' ? rework(noted(t, `reprovada por ${reviewer}`)) : t));
        return;
      }
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? rework(moved(t, 'doing', 'auto', `reprovada por ${reviewer}`)) : t));
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

  /**
   * Quem revisa a tarefa que chegou em "revisão", na ordem: o `reviewerId` dela (inclui o gestor que pediu, ver `create`); o responsável
   * da revisão do quadro (ver boardConfig.ts), se ela está ligada, ele ainda é da equipe e não foi quem executou; senão ninguém, e a
   * tarefa fica com você (aprova ou reprova pela tela). `fromBoard`: veio do quadro, então o pedido o marca na tarefa (`assign`), e o
   * veredito dele move a tarefa como na revisão automática de sempre.
   */
  private async reviewerOf(projectId: string, task: Task): Promise<{ id: string; fromBoard: boolean } | null> {
    if (task.reviewerId) return { id: task.reviewerId, fromBoard: false };
    const dir = await this.deps.projectPath(projectId);
    const board = dir ? await readBoardConfig(dir) : DEFAULT_BOARD_CONFIG;
    if (!board.autoReview || !board.reviewerId || board.reviewerId === task.staffId) return null;
    if (!(await this.deps.readProfile(projectId, board.reviewerId))) return null;
    return { id: board.reviewerId, fromBoard: true };
  }

  /** Entregue com revisor (o da tarefa ou o do quadro, ver `reviewerOf`): pede a revisão sozinho, até AUTO_REVIEW_ROUNDS rodadas. */
  private async autoReview(projectId: string, task: Task): Promise<void> {
    const reviewer = await this.reviewerOf(projectId, task);
    if (!reviewer) return;
    const deliveryAt = task.delivery?.at ?? null;
    if ((task.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS) {
      // Só anota o limite se a tarefa ainda está em "revisão" e nesta entrega: cancelada (ou já aprovada, ou com entrega nova) enquanto
      // isso, a nota seria falsa e ninguém precisa ser avisado.
      let written = false;
      const capped = await this.change(projectId, task.id, (t) => {
        if (!onDelivery(t, deliveryAt)) return t;
        written = true;
        return noted(t, capNote(AUTO_REVIEW_ROUNDS));
      });
      if (!written) return;
      if (capped) this.warnDependents(projectId, task.id, stuckReason(capped));
      if (selfReview(task))
        await this.tellRequester(projectId, task, `[MyCo] Tarefa “${task.title}” (id ${task.id}): o limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas foi atingido; o que sobrou fica com você.`);
      return;
    }
    try {
      await this.requestReview(projectId, task.id, reviewer.id, false, { delivery: { at: deliveryAt }, ...(reviewer.fromBoard && { assign: true }) });
      await this.change(projectId, task.id, (t) => ({ ...t, reviewRounds: (t.reviewRounds ?? 0) + 1 }));
    } catch (err) {
      const now = ((await this.list(projectId)) ?? []).find((t) => t.id === task.id);
      // Cancelada, aprovada ou com entrega nova no meio do caminho: quem fez isso já tratou quem pediu (ou a entrega nova trata). "Entregou"
      // agora seria falso ou repetido, e não há revisão a anotar.
      if (!now || !onDelivery(now, deliveryAt)) return;
      // O pedido chegou a abrir a revisão (só a contagem de rodadas falhou): ela segue, e o desfecho é avisado a quem pediu quando sair.
      if (now.review?.sessionId && now.review.sessionId !== task.review?.sessionId) return;
      // Passa sozinho (limite de consumo, conversa fechando): o tick tenta de novo por até REVIEW_WAIT_MS, e só no fim a tarefa é sua e quem
      // pediu é avisado (ver `retryReviews`). O pedido que não tem como dar certo (ficha, revisor) segue como antes: nota e aviso na hora.
      if (retryable(err)) {
        await this.change(projectId, task.id, (t) => {
          if (!onDelivery(t, deliveryAt)) return t;
          const prev = t.reviewRetry?.deliveryAt === deliveryAt ? t.reviewRetry : undefined;
          // Vencida continua vencida: o aviso (nota, dependentes, gestor) saiu uma vez, e as tentativas seguintes não o repetem.
          const next = { ...t, reviewRetry: { ...failedRetry(prev, err, new Date()), deliveryAt, ...(prev?.expired && { expired: true }) } };
          return prev ? next : noted(next, `revisão automática não começou: ${(err as Error).message}`);
        });
        return;
      }
      // O que não passa sozinho (ficha, revisor, conflito de estado) vira aviso já, com o motivo na caixa (`stuckState`): a tarefa não fica em "revisão"
      // sem ninguém saber. O tick ainda confere de vez em quando (`retryReviews`): o dono pode ter trocado o revisor, e a revisão abre sem ele empurrar.
      let first = false;
      let flagged: Task | null = null;
      await this.change(projectId, task.id, (t) => {
        if (!onDelivery(t, deliveryAt)) return t;
        const prev = t.reviewRetry?.deliveryAt === deliveryAt ? t.reviewRetry : undefined;
        first = !prev;
        const next = { ...t, reviewRetry: { ...failedRetry(prev, err, new Date()), deliveryAt, expired: true } };
        return (flagged = prev ? next : noted(next, `revisão automática não começou: ${(err as Error).message}`));
      });
      const stuck = flagged as Task | null;
      if (!stuck || !first) return;
      this.warnDependents(projectId, stuck.id, stuckReason(stuck));
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
    // Edição que ainda está sendo registrada (o card automático nasce dela) entra antes de fechar o turno.
    await this.edits.get(sessionId);
    const where = await this.where(sessionId);
    if (where?.role !== 'work') return;
    // Turno que falhou por causa passageira: a decisão de retomar (marcar a retomada, ou segurar a conversa para você) sai antes de ler o que vem abaixo.
    await this.deps.settleRetry?.(sessionId).catch(() => {});
    // Parou no teto de ferramentas ou de minutos: não é entrega (nem revisão). Vai para Aguardar, com o motivo, e a fila anda.
    // Card automático não: o teto só encerrou o turno da conversa direta, e o que ela alterou vai para revisão.
    const cap = where.auto ? null : this.deps.turnCap?.(sessionId);
    if (cap) {
      const parked = await this.parkForCap(where.projectId, where.taskId, sessionId, cap);
      if (parked?.staffId) void this.kick(where.projectId, parked.staffId);
      return;
    }
    // Parou no limite de uso com o "continue" agendado: não é entrega. Fica em "fazendo", ninguém é avisado
    // e a fila não anda (a tarefa segue ocupando o funcionário). Erro ao perguntar: vale como hoje, entrega.
    if (await this.deps.awaitingLimit?.(sessionId).catch(() => false)) return;
    const current = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    // Fim de uma conversa que já não é a da tarefa (trocou de motor, ou outra): não entrega, não fecha, não anda a fila.
    if (!current || current.sessionId !== sessionId) return;
    // Cancelada: o fim do turno (o que o cancelamento interrompeu, ou um despertador solto) não entrega, não manda para revisão e não
    // retoma nada. Quem cancelou já andou a fila (ver `cancel`).
    if (current.status === 'cancelled') return;
    const staffId = current.staffId;
    if (!staffId) return;
    // Dúvida ao gestor (ver doubtHeld): com `DÚVIDA:` ou pergunta por opções aberta, a tarefa não entrega agora.
    if (await this.doubtHeld(where.projectId, current, sessionId)) return;
    // A chave vale da entrega até o pedido de revisão: com a tarefa já em "revisão" e os testes rodando (minutos), o `tick` não a toma por
    // perdida (ver `resumeReviews`). Quem já a tem (outro aviso do mesmo turno) a solta; este só solta a que pegou.
    const key = `review:${where.projectId}:${where.taskId}`;
    const owns = !this.inFlight.has(key);
    if (owns) this.inFlight.add(key);
    try {
      // Na vez dele: a próxima tarefa só começa depois que a entrega desta tem o seu commit.
      const deliveredTask = await this.locked(where.projectId, staffId, async () => {
        let delivered: Task | null = null;
        const seen: { before?: Task } = {};
        // Confere de novo, lá dentro: o estado pode ter mudado enquanto esperava a vez.
        await this.change(where.projectId, where.taskId, (t) => {
          if (t.status !== 'doing' || t.sessionId !== sessionId) return t;
          seen.before = t;
          return (delivered = moved({ ...t, runId: null }, 'review', 'auto', TURN_ENDED));
        });
        if (delivered) {
          await this.logEnd(where.projectId, seen.before, 'delivered');
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
    } finally {
      if (owns) this.inFlight.delete(key);
    }
  }

  /**
   * Turno da tarefa parou no teto: ela sai de "fazendo" para Aguardar, com o motivo (sem commit, sem revisão, sem aviso ao
   * gestor). Só se ainda estiver "fazendo" (ou em "a fazer", o card cuja conversa trabalhou por fora do status, ver `resumeTodo`) com esta
   * conversa. Devolve a tarefa, se foi para Aguardar agora.
   */
  private async parkForCap(projectId: string, taskId: string, sessionId: string, hit: TurnCapHit): Promise<Task | null> {
    return this.parkWaiting(projectId, taskId, sessionId, capReason(hit), 'auto', 'limit', ['doing', 'todo']);
  }

  /**
   * Passa a tarefa de `from` (com esta conversa) para Aguardar, com o motivo; fecha a tentativa no registro (`outcome`) e avisa os dependentes.
   * Vale também quando a órfã cai aqui (dentro de `locked`): o aviso não espera a vez do funcionário. Devolve a tarefa, se foi para Aguardar agora.
   */
  private async parkWaiting(
    projectId: string,
    taskId: string,
    sessionId: string,
    why: string,
    by: 'you' | 'auto',
    outcome: RunOutcome,
    from: readonly TaskStatus[],
    skip?: (t: Task) => boolean,
  ): Promise<Task | null> {
    let parked: Task | null = null;
    const seen: { before?: Task } = {};
    await this.change(projectId, taskId, (t) => {
      if (!from.includes(t.status) || t.sessionId !== sessionId || skip?.(t)) return t;
      seen.before = t;
      parked = moved({ ...t, queuedAt: null, waitReason: why, runId: null }, 'waiting', by, why);
      return parked;
    });
    const back = parked as Task | null;
    if (back) this.warnDependents(projectId, taskId, stuckReason(back));
    if (parked) await this.logEnd(projectId, seen.before, outcome, why);
    return parked;
  }

  /**
   * Você fechou a conversa de trabalho de uma tarefa enquanto ela trabalhava (ver `ChatManager.close`): a tarefa vai para Aguardar, com a nota,
   * ANTES de o processo sair. Sem isso a saída contaria como fim de turno e entregaria a tarefa para revisão, e a órfã a reabriria sozinha.
   * Fica como está: card automático (a conversa é direta), conversa de revisão ou deploy, e a tarefa com dúvida aberta (a conversa só espera a
   * resposta, e a resposta a reabre). A fila do funcionário anda. Devolve a tarefa, se foi para Aguardar.
   */
  async parkClosed(sessionId: string): Promise<Task | null> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work' || where.auto) return null;
    const asking = (t: Task) => t.question?.status === 'open' || t.question?.status === 'escalated';
    const parked = await this.parkWaiting(where.projectId, where.taskId, sessionId, CLOSED_BY_YOU, 'you', 'stopped', ['doing', 'planning', 'todo'], asking);
    if (parked?.staffId) void this.kick(where.projectId, parked.staffId);
    return parked;
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
      task.acceptance && `Critério de aceite (confira contra ele):\n${task.acceptance}`,
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

  /**
   * `task` (pedida por um gestor) acabou de fechar (pronta, apagada ou cancelada). Agrupa os desfechos APROVADOS para não gastar um turno do
   * gestor por tarefa: `own` é o aviso dela (só a aprovada pela revisão dele tem; pronta à mão ou apagada vem sem, e só serve de
   * gatilho). `immediate` (cancelada: o gestor espera uma entrega que não vem): `own` sai na hora, mesmo com outra tarefa aberta dele
   * (as retidas continuam esperando a última). Com outra tarefa dele ainda em andamento (fora de pronto, Aguardar e "A fazer" sem responsável), o aviso fica retido (`outcomeHeld`); sem
   * nenhuma, sai UM aviso com o dela e a lista das retidas, e as marcas são limpas. Reprovação, limite, bloqueio e falha não passam
   * por aqui: vão na hora. Decidir e marcar/limpar é uma única gravação (`mutate` é uma por vez por projeto): dois fechamentos quase
   * juntos nunca mandam a mesma lista, e uma retida só sai por quem a limpou.
   *
   * Tarefa parada que só você destrava (ver `stuckState`: `selfHeals` falso) não segura o aviso, e o aviso retido sai sozinho depois de
   * OUTCOME_HOLD_MAX_MS (ver `releaseOutcomes`, que chama com `force`: a decisão de mandar já foi tomada). Aviso que falha ao ir para a
   * conversa de quem pediu não se perde: a tarefa volta a `outcomeHeld` com `outcomePending` (o tick reenvia com backoff).
   */
  private async settleRequester(projectId: string, task: Task, line: string, own: string | null, immediate = false, force = false): Promise<void> {
    const manager = task.requestedBy;
    if (!manager || !this.deps.notify) return;
    const seen: { held: Task[]; hold: boolean } = { held: [], hold: false };
    const at = new Date().toISOString();
    // As marcas de antes de limpar: se o aviso falhar, elas voltam (a contagem de falhas e o início da retenção não se perdem).
    const before = new Map<string, Pick<Task, 'outcomePending' | 'outcomeHeldAt'>>();
    const ok = await this.mutate(projectId, (tasks) => {
      seen.held = [];
      seen.hold = false;
      before.clear();
      for (const t of tasks) if (t.requestedBy === manager && t.outcomeHeld) before.set(t.id, { outcomePending: t.outcomePending, outcomeHeldAt: t.outcomeHeldAt });
      const mine = tasks.filter((t) => t.requestedBy === manager && t.id !== task.id);
      // Aguardar, "A fazer" sem responsável e o que está parado esperando você são cards parados, e as encerradas (prontas ou canceladas)
      // não andam: não seguram o aviso.
      if (!force && mine.some((t) => !isClosed(t) && t.status !== 'waiting' && !(t.status === 'todo' && !t.staffId) && stuckState(t)?.selfHeals !== false)) {
        // Ainda tem tarefa aberta: o aviso próprio fica retido; sem aviso próprio, nada a fazer agora.
        seen.hold = true;
        return own ? tasks.map((t) => (t.id === task.id && t.status === 'done' ? { ...t, outcomeHeld: true, outcomeHeldAt: t.outcomeHeldAt ?? at } : t)) : tasks;
      }
      seen.held = mine.filter((t) => t.outcomeHeld && t.status === 'done');
      return tasks.map((t) => (t.requestedBy === manager && t.outcomeHeld ? { ...t, outcomeHeld: undefined, outcomeHeldAt: undefined, outcomePending: undefined } : t));
    });
    if (!ok || (seen.hold && !(immediate && own)) || (!own && !seen.held.length)) return;
    // Mensagem para a conversa de quem pediu; sem aviso próprio, diz o que fechou.
    const parts = [own ?? `[MyCo] Tarefa “${task.title}” (id ${task.id}): ${line}.`];
    if (seen.held.length)
      parts.push(
        `Aprovadas antes, com o aviso retido até agora (você não tem mais tarefas em aberto):\n${seen.held.map((t) => `- “${t.title}” (id ${t.id}): ${outcomeLine(t)}`).join('\n')}`,
      );
    try {
      await this.deps.notify(projectId, manager, parts.join('\n\n'), task.requestedSession ?? null);
    } catch (err) {
      // Não foi: as prontas que iam nele voltam a retidas, com a hora de tentar de novo. (Cancelada e apagada não têm marca: seguem sem reenvio.)
      const lost = new Set([task.id, ...seen.held.map((t) => t.id)]);
      const now = new Date();
      await this.mutate(projectId, (tasks) =>
        tasks.map((t) =>
          lost.has(t.id) && t.status === 'done'
            ? { ...t, outcomeHeld: true, outcomeHeldAt: before.get(t.id)?.outcomeHeldAt ?? at, outcomePending: failedRetry(before.get(t.id)?.outcomePending, err, now) }
            : t,
        ),
      ).catch(() => {});
    }
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
   * Abre no registro a tentativa da tarefa, ou segue a que já está aberta (retomada e ajuste). Devolve o runId, que a tarefa
   * guarda. Erro de gravação não derruba a tarefa (a conversa já abriu): só a linha fica de fora.
   */
  private async logStart(projectId: string, task: Task, trigger: RunTrigger, skills?: Record<string, string>): Promise<string> {
    const runId = task.runId ?? newRunId();
    const dir = await this.deps.projectPath(projectId);
    if (dir)
      await appendRun(dir, {
        ev: 'start',
        runId,
        taskId: task.id,
        staffId: task.staffId ?? '',
        sessionId: task.sessionId ?? undefined,
        trigger,
        ...(task.idemKey && { idemKey: task.idemKey }),
        ...(skills && { skills }),
        at: new Date().toISOString(),
      }).catch(() => {});
    return runId;
  }

  /** Fecha no registro a tentativa aberta de `task` (com o mesmo runId). Sem tentativa aberta, não faz nada. Quem chama tira o runId da tarefa. */
  private async logEnd(projectId: string, task: Task | undefined, outcome: RunOutcome, note?: string): Promise<void> {
    if (!task?.runId) return;
    const dir = await this.deps.projectPath(projectId);
    if (dir)
      await appendRun(dir, {
        ev: 'end',
        runId: task.runId,
        taskId: task.id,
        staffId: task.staffId ?? '',
        sessionId: task.sessionId ?? undefined,
        outcome,
        ...(note && { note }),
        at: new Date().toISOString(),
      }).catch(() => {});
  }

  /** Os eventos de execução da tarefa, do registro (ver taskRuns.ts). Projeto inexistente: null. */
  async runs(projectId: string, taskId: string): Promise<TaskRunEvent[] | null> {
    const dir = await this.deps.projectPath(projectId);
    return dir ? readRuns(dir, taskId) : null;
  }

  /**
   * Por projeto: tarefas em aberto (tudo que não está encerrado, Aguardar inclusive; pronta e cancelada não contam), quantas esperam
   * revisão e o progresso do kanban (pontos/máximo, ver shared/kanbanProgress.ts). Projetos sem nada em
   * aberto ficam de fora.
   */
  async summary(): Promise<Record<string, TaskSummary>> {
    const out: Record<string, TaskSummary> = {};
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      const open = tasks.filter((t) => !isClosed(t)).length;
      if (open) out[projectId] = { open, review: tasks.filter((t) => t.status === 'review').length, progress: kanbanProgress(tasks) };
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

  /**
   * A conversa é de uma tarefa (o trabalho, a revisão ou o deploy dela)? A conversa de um card automático não: ela segue como conversa
   * direta (troca de assunto, troca de motor no limite), e o card é só o registro do que ela alterou.
   */
  async isTaskSession(sessionId: string): Promise<boolean> {
    const where = await this.where(sessionId);
    return !!where && !(where.role === 'work' && where.auto);
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

  /** `fn` recebe a tarefa e o quadro inteiro (para conferir dependências); lançar aborta a gravação. */
  private async change(projectId: string, taskId: string, fn: (t: Task, all: Task[]) => Task): Promise<Task | null> {
    const seen: { before?: Task; after?: Task } = {};
    const ok = await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.id !== taskId) return t;
        seen.before = t;
        seen.after = fn(t, tasks);
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
      const next = clearStaleRanks(clearBlockAlerts(fn(await readTasks(dir))));
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
 * Como readTasks, mas sem engolir nada: arquivo que existe e não lê, JSON ruim, lista que não é lista ou tarefa sem id LANÇAM
 * (quem chama aborta). Ausente = lista vazia. Status desconhecido fica na lista (quem chama trata como não concluída).
 * Usado pela exclusão da retenção (server/retentionSweep.ts), onde ler pela metade protegeria menos do que deveria.
 */
export async function readTasksStrict(dir: string): Promise<Task[]> {
  let raw: string;
  try {
    raw = await fs.readFile(tasksFile(dir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
  if (!Array.isArray(data)) throw new Error('tasks.json não é uma lista');
  return data.map((t) => {
    if (!t || typeof t !== 'object' || typeof (t as Task).id !== 'string') throw new Error('tarefa sem id no tasks.json');
    const task = t as Task;
    return { ...task, status: fromLegacy(task.status) };
  });
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

/**
 * As dependências de `task` que ainda não satisfazem (só 'done' satisfaz, ver `satisfiesDependency`), como ids. Cancelada BLOQUEIA:
 * fechou sem entrega, e o dono decide o que fazer com quem esperava (ver `resolveCancelledBlocker`). Dependência que não existe mais
 * no quadro não bloqueia (a gravação já recusa id solto; isto só evita travar uma tarefa por um id perdido à mão).
 */
export function blockers(task: Task, tasks: Task[]): string[] {
  return (task.blockedBy ?? []).filter((id) => {
    const dep = tasks.find((t) => t.id === id);
    return !!dep && !satisfiesDependency(dep);
  });
}

/**
 * Uma tarefa parada, pela regra única (ver `stuckState`): `reason` em pt-BR; `selfHeals`, a fila se recupera sozinha (retry em andamento);
 * `humanAction`, o que só você resolve (null = nada, ou a cancelada, que tem os botões próprios); `since`, desde quando.
 */
export interface StuckState {
  reason: string;
  selfHeals: boolean;
  humanAction: HumanAction | null;
  since: string;
}

/**
 * A tarefa espera o limite do motor da ficha baixar (`fallbackBlocked`, ver `startPlan`): a troca não serve agora. Vale até `until`
 * passar (ou sem `until`, até a partida ou o cancelamento limpar). Sem humanAction: a fila se destrava sozinha quando o limite baixa.
 */
function fallbackWait(t: Task, now: number): StuckState | null {
  const fb = t.fallbackBlocked;
  if (!fb || (fb.until !== null && now >= Date.parse(fb.until))) return null;
  return {
    reason: `espera o limite do ${ENGINE_LABEL[fb.from]} baixar: a troca para o ${ENGINE_LABEL[fb.engine]} não serve agora (${FALLBACK_MOTIVO[fb.reason]}: ${fb.detail})`,
    selfHeals: true,
    humanAction: null,
    since: fb.since,
  };
}

/**
 * Por que a tarefa está parada, e quem a destrava (ou null, se não está). É a regra única: a caixa (kinds 'blocked', 'question' e
 * 'stuck') a lê na leitura, o aviso aos gestores usa o mesmo texto (`stuckReason`) e o aviso retido a quem pediu confere `selfHeals`
 * (ver `settleRequester`). Só o estado gravado e a hora (`now`) contam. Cancelada, Aguardar, dúvida escalada, ajuste que não chega,
 * revisão automática que não começou ou sem veredito, limite de revisões automáticas e revisão sem responsável.
 */
export function stuckState(t: Task, now = Date.now()): StuckState | null {
  const since = t.updatedAt;
  if (t.status === 'cancelled') return { reason: t.cancelReason ? `cancelada: ${t.cancelReason}` : 'cancelada', selfHeals: false, humanAction: null, since: t.cancelledAt ?? since };
  if (t.status === 'waiting') return { reason: t.waitReason ? `em Aguardar: ${t.waitReason}` : 'em Aguardar', selfHeals: false, humanAction: 'decide', since };
  if (isClosed(t)) return null;
  const q = t.question;
  if ((t.status === 'doing' || t.status === 'planning') && q && q.status !== 'answered') {
    if (q.status === 'escalated') return { reason: 'dúvida escalada: espera a sua resposta', selfHeals: false, humanAction: 'answer', since: q.escalatedAt ?? q.askedAt };
    // Ainda não chegou ao gestor, mas o retry está em andamento (passados ESCALATE_AFTER_MS ela vira escalada).
    if (q.pending && !q.managerSession) return { reason: 'dúvida a caminho do gestor (nova tentativa em andamento)', selfHeals: true, humanAction: null, since: q.pending.firstAt };
  }
  // Depois da dúvida (ela vence), antes dos outros: a espera do limite do motor da ficha (ver `fallbackWait`).
  const wait = fallbackWait(t, now);
  if (wait) return wait;
  const stale = t.held?.find((m) => (m.attempts ?? 0) >= HELD_MAX_FAILS);
  if (stale) return { reason: 'ajuste guardado não chega ao funcionário', selfHeals: false, humanAction: 'resend', since: stale.at };
  if (t.status !== 'review') return null;
  const rr = t.reviewRetry;
  if (rr && (rr.expired || now - Date.parse(rr.firstAt) >= REVIEW_WAIT_MS))
    return { reason: `a revisão automática não começou${rr.lastError ? `: ${rr.lastError}` : ''}`, selfHeals: false, humanAction: 'review', since: rr.firstAt };
  // O revisor foi re-pedido uma vez e segue sem veredito: respondeu de novo sem ele, ou não respondeu em REVIEW_WAIT_MS.
  const r = t.review;
  if (t.reviewerId && r && t.reviewerId === r.staffId && r.reasked && !r.verdict && r.reaskAt && ((r.doneAt && r.doneAt > r.reaskAt) || now - Date.parse(r.reaskAt) >= REVIEW_WAIT_MS))
    return { reason: 'a revisão automática ficou sem veredito', selfHeals: false, humanAction: 'review', since: r.reaskAt };
  // reviewRounds sobe logo depois de pedir a revisão: com a última em curso já é AUTO_REVIEW_ROUNDS. Por isso o limite só conta com a última revisão
  // respondida (doneAt) e sem aprovação (aprovada, ela só espera a mescla). A nota do limite como última linha do histórico (de qualquer N) também
  // vale: é a tarefa que parou no limite antigo (2) e a entrega seguinte ficou sem revisar. O dono decide por ela, como no limite de agora.
  if (t.reviewerId && t.review?.doneAt && t.review.verdict !== 'approved' && ((t.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS || CAP_NOTE.test(t.history.at(-1)?.note ?? '')))
    return { reason: 'limite de revisões automáticas atingido', selfHeals: false, humanAction: 'decide', since };
  if (!t.staffId) return { reason: 'sem responsável', selfHeals: false, humanAction: 'decide', since };
  return null;
}

/** O texto da parada (ver `stuckState`), ou null se a tarefa não está parada. */
export const stuckReason = (t: Task): string | null => stuckState(t)?.reason ?? null;

/** Uma tarefa que só você destrava e tem aviso próprio na caixa (ver `ownAlerts`). */
export interface OwnAlert {
  task: Task;
  /** `humanAction` null: a espera do limite da ficha (ver `fallbackWait`), sem ação sua; o aviso sai para você ver, e some sozinho. */
  state: StuckState & { humanAction: 'answer' | 'review' | 'resend' | null };
}

/**
 * As tarefas do quadro que só você destrava e têm aviso próprio na caixa: dúvida escalada (kind 'question') e revisão ou ajuste parados
 * (kind 'stuck'), e a espera do limite da ficha (kind 'stuck', sem ação sua). Aguardar, limite de revisões e sem responsável aparecem só
 * para quem as espera (kind 'blocked'): o dono as parou, ou já as vê no quadro. Tarefa encerrada não entra.
 */
export function ownAlerts(tasks: Task[], now = Date.now()): OwnAlert[] {
  const out: OwnAlert[] = [];
  for (const task of tasks) {
    if (isClosed(task)) continue;
    const state = stuckState(task, now);
    if (!state) continue;
    if (state.humanAction === 'answer' || state.humanAction === 'review' || state.humanAction === 'resend') out.push({ task, state: { ...state, humanAction: state.humanAction } });
    // A dúvida "a caminho do gestor" também tem humanAction null: só a espera do limite entra (é a mesma razão que `stuckState` deu).
    else if (state.humanAction === null && fallbackWait(task, now)?.reason === state.reason) out.push({ task, state: { ...state, humanAction: null } });
  }
  return out;
}

/** O erro vale uma nova tentativa? Os `TaskError` (ficha, revisor, conflito de estado) são validações nossas: repetir dá o mesmo. */
const retryable = (err: unknown): boolean => isTransient(err) && !(err instanceof TaskError);

/** A dúvida ainda precisa ir ao gestor e a hora chegou? Com `pending`, na hora marcada; `open` sem `pending` (o servidor caiu entre gravar e mandar), passado o tempo de uma conversa órfã. A escalada sem `pending` não tenta. */
function doubtDue(q: TaskQuestion, at: number): boolean {
  if (q.status === 'answered' || q.managerSession) return false;
  if (q.pending) return retryDue(q.pending, at);
  return q.status === 'open' && at - Date.parse(q.askedAt) > ORPHAN_MS;
}

/** 409: quem respondeu primeiro e o que disse. */
const answeredConflict = (q: TaskQuestion) => new TaskConflictError(`${q.answeredBy === 'manager' ? 'o gestor' : 'o usuário'} já respondeu: ${q.answer ?? ''}`);

/** Revisão sem veredito com o revisor marcado na tarefa: marca a hora de re-pedir (uma vez; ver `chaseReviews`). */
function withReask(t: Task): Task {
  const r = t.review;
  if (t.status !== 'review' || !r || !t.reviewerId || t.reviewerId !== r.staffId || r.reasked) return t;
  return { ...t, review: { ...r, reaskAt: new Date(Date.now() + REASK_AFTER_MS).toISOString() } };
}

/** A linha do histórico quando o limite de revisões automáticas acaba (ver `autoReview`); `n` é o limite de quando foi escrita. */
const capNote = (n: number) => `limite de ${n} revisões automáticas; o que sobrou fica com você: aceitar como trade-off (anotar em "Decisões" no SPEC.md) ou pedir ajuste`;
/** Reconhece a nota do limite de qualquer época (o N muda: 2 no limite antigo, 3 hoje); ver `stuckReason`. */
const CAP_NOTE = /^limite de \d+ revisões automáticas;/;

/** O motivo (e a nota do histórico) da tarefa que foi para Aguardar porque você fechou a conversa dela no meio do turno (ver `parkClosed`). */
export const CLOSED_BY_YOU = 'conversa fechada por você';

/**
 * O que ficou de quem esperava a tarefa cancelada (`direct`: as abertas que dependiam dela, de antes da escolha do dono), lido do quadro
 * de agora (`now`): o que o dono decidiu, ou "segue esperando" para o que ele não decidiu. Vazio sem dependentes.
 */
function dependentsLine(direct: Task[], now: Task[], blockerId: string): string {
  const released: Task[] = [];
  const cancelled: Task[] = [];
  const chosen: Task[] = [];
  const left: Task[] = [];
  for (const d of direct) {
    const cur = now.find((t) => t.id === d.id);
    if (!cur) continue;
    if (cur.status === 'cancelled') cancelled.push(cur);
    else if (!cur.blockedBy?.includes(blockerId)) released.push(cur);
    else (acked(cur, blockerId) ? chosen : left).push(cur);
  }
  const names = (l: Task[]) => l.map((d) => `“${d.title}” (id ${d.id})`).join(', ');
  return [
    released.length && `O usuário liberou da espera por ela: ${names(released)}.`,
    cancelled.length && `O usuário cancelou junto: ${names(cancelled)}.`,
    chosen.length && `O usuário decidiu que seguem esperando por ela: ${names(chosen)}.`,
    left.length && `Seguem esperando por ela, e a decisão é do usuário: ${names(left)}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Um dependente aberto (`task`) que espera uma bloqueadora empacada (`blocker`), com o motivo dela. */
export interface StuckDependency {
  task: Task;
  blocker: Task;
  reason: string;
  /** A bloqueadora se recupera sozinha, e `humanAction` é o que só você resolve nela (ver `stuckState`). */
  selfHeals: boolean;
  humanAction: HumanAction | null;
}

/**
 * Os pares dependente → bloqueadora empacada do quadro, para a caixa do dono (ver `blockers` e `stuckReason`). Dependente encerrada
 * (pronta ou cancelada) não espera mais ninguém. Bloqueadora cancelada que o dono mandou "continuar esperando" (`ackCancelled`)
 * não aparece por ACK_CANCELLED_DAYS dias (ver `acked`), ou até ser reaberta (o `reopen` limpa a marca); vencido o prazo, o par volta.
 * `now`: o instante da leitura (ms).
 */
export function stuckDependencies(tasks: Task[], now = Date.now()): StuckDependency[] {
  const out: StuckDependency[] = [];
  for (const d of tasks) {
    if (isClosed(d)) continue;
    for (const id of blockers(d, tasks)) {
      const blocker = tasks.find((t) => t.id === id)!;
      if (blocker.status === 'cancelled' && acked(d, id, now)) continue;
      const state = stuckState(blocker, now);
      if (state) out.push({ task: d, blocker, reason: state.reason, selfHeals: state.selfHeals, humanAction: state.humanAction });
    }
  }
  return out;
}

/** Cartão esquecido: tarefa em "a fazer" que fica parada mais que isso (dias) vira aviso na caixa do dono (ver `notStartedTasks`). */
export const NOT_STARTED_AFTER_DAYS = 2;

/** Uma tarefa esquecida em "a fazer" (`task`), parada há `days` dias inteiros (no mínimo NOT_STARTED_AFTER_DAYS). */
export interface NotStartedTask {
  task: Task;
  days: number;
}

/**
 * Os cartões esquecidos do quadro, para a caixa do dono (kind 'notStarted'): em "a fazer", FORA da fila (sem `queuedAt`: a da fila
 * começa sozinha), sem conversa e sem bloqueadora (`blockers`: a que espera outra aberta ou cancelada tem o aviso próprio, 'blocked'),
 * e parada há mais de NOT_STARTED_AFTER_DAYS dias, pelo que for mais recente entre `updatedAt` e a última linha do histórico. Calculado
 * na leitura, nada gravado: começar (sai de "a fazer" ou entra na fila), cancelar, apagar ou editar (o `updatedAt` anda) tira o aviso.
 * Sem responsável também vale: o dono precisa escolher um, e "Começar" diz isso.
 */
export function notStartedTasks(tasks: Task[], now = Date.now()): NotStartedTask[] {
  const out: NotStartedTask[] = [];
  const limit = NOT_STARTED_AFTER_DAYS * 86_400_000;
  for (const t of tasks) {
    if (t.status !== 'todo' || t.queuedAt || t.sessionId || blockers(t, tasks).length) continue;
    const times = [Date.parse(t.updatedAt), Date.parse(t.history?.at(-1)?.at ?? '')].filter(Number.isFinite);
    if (!times.length) continue;
    const idle = now - Math.max(...times);
    if (idle > limit) out.push({ task: t, days: Math.floor(idle / 86_400_000) });
  }
  return out;
}

/** Bloqueadora que voltou a andar (fazendo ou planejando) ou ficou pronta: o último aviso aos gestores já não vale (ver doWarnDependents). */
function clearBlockAlerts(tasks: Task[]): Task[] {
  return tasks.map((t) => (t.blockAlert && (t.status === 'doing' || t.status === 'planning' || t.status === 'done') ? { ...t, blockAlert: null } : t));
}

/** O aviso ao gestor de quem espera: quem parou, o motivo e os dependentes dele (um gestor, uma mensagem). */
function blockedText(blocker: Task, deps: Task[], reason: string): string {
  const names = deps.map((d) => `“${d.title}” (id ${d.id})`).join(', ');
  return `[MyCo] A tarefa “${blocker.title}” (id ${blocker.id}) parou: ${reason}. ${deps.length > 1 ? 'Estas tarefas esperam' : 'Esta tarefa espera'} por ela para começar: ${names}.`;
}

/**
 * Dependências novas de `id`: têm de existir no projeto (`all`), não podem ser a própria tarefa, e nenhuma pode depender
 * (direta ou indiretamente) dela, senão haveria ciclo. Lança TaskError com o motivo; não grava nada.
 */
function checkBlockedBy(id: string, deps: string[], all: Task[]): void {
  const byId = new Map(all.map((t) => [t.id, t]));
  for (const d of deps) {
    if (d === id) throw new TaskError('uma tarefa não pode depender dela mesma');
    if (!byId.has(d)) throw new TaskError(`dependência não encontrada neste projeto: ${d}`);
  }
  for (const d of deps) {
    const seen = new Set<string>();
    const stack = [d];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) throw new TaskError(`ciclo de dependências: “${byId.get(d)!.title}” já depende, direta ou indiretamente, desta tarefa`);
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(byId.get(cur)?.blockedBy ?? []));
    }
  }
}

/** O card automático desta conversa que ainda está em "fazendo" (no máximo um: a conversa é uma só). */
const openAutoCard = (sessionId: string) => (t: Task) => t.autoCreated === true && t.sessionId === sessionId && t.status === 'doing';

/** Título do card automático quando nem a conversa nem o pedido dão um. */
const AUTO_TITLE = 'Alteração de código';

/** O pedido que o card automático guarda: o card fica em texto em `.myco/tasks.json` (versionável), então só o começo. */
const AUTO_REQUEST_MAX = 2000;

/**
 * O pedido como descrição do card: a sua última mensagem na conversa, cortada. Com cara de segredo (chave, token), nada: o card fica em
 * texto no projeto, e o que o guarda de segredo é a conversa, não o quadro.
 */
function requestOf(text: string | null): string {
  const t = (text ?? '').trim();
  return !t || findSecret(t) ? '' : t.slice(0, AUTO_REQUEST_MAX);
}

/** O título do card automático: o que você deu à conversa, senão a primeira linha do pedido (curta), senão o genérico. */
function autoTitle(custom: string | null, request: string): string {
  const own = (custom ?? '').replace(/\s+/g, ' ').trim();
  if (own) return own.slice(0, 120);
  const line = request.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return !line ? AUTO_TITLE : line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/**
 * Dúvida escalada a você e nada editado ainda (sem `changedFiles` nem `checkpoint`): a tarefa espera a sua resposta sem prender o
 * funcionário, e a próxima da fila dele começa. Dúvida com o gestor (`open`) ou com edição continua ocupando. A worktree é do
 * funcionário, não da tarefa (ver `locateCode`): ter uma não libera nem prende.
 */
export function releasesStaff(t: Task): boolean {
  return t.question?.status === 'escalated' && !t.changedFiles?.length && !t.checkpoint;
}

/**
 * Parada sem prender o funcionário: espera a sua resposta (`releasesStaff`) ou guarda a resposta da dúvida que chegou com ele em outra tarefa
 * (`HeldMessage.doubt`; sem isso a própria pausada viraria a ocupante). O ajuste comum não conta: a conversa dela pode estar com o turno rodando.
 */
const parked = (t: Task): boolean => releasesStaff(t) || !!t.held?.some((m) => m.doubt);

/**
 * Card em "a fazer" que nada segura e que está fora da fila (ver `enqueueIdle`): com responsável, sem dependência pendente, sem dúvida aberta e que você não tirou
 * da fila de propósito. Aguardar nunca entra (a coluna é outra).
 */
function idleTodo(t: Task, all: Task[]): boolean {
  return t.status === 'todo' && !!t.staffId && !t.queuedAt && !t.unqueued && !heldFirst(t) && !blockers(t, all).length && !(t.question && t.question.status !== 'answered');
}

/** Card com conversa e ajuste guardado: quem retoma a conversa é o ajuste (ver `takeNext`), não a vez da fila, que mandaria a retomada por cima dele. */
const heldFirst = (t: Task): boolean => !!t.sessionId && !!t.held?.length;

/** As conversas de revisão que `staffId` conduz (de qualquer rodada ou tarefa): rodam em paralelo com o trabalho dele, que não espera por elas (ver `staffBusy`). */
function reviewSessionsOf(tasks: Task[], staffId: string): string[] {
  const ids = new Set<string>();
  for (const t of tasks) {
    if (t.review?.staffId === staffId && t.review.sessionId) ids.add(t.review.sessionId);
    for (const s of t.sessions ?? []) if (s.role === 'review' && s.staffId === staffId) ids.add(s.id);
  }
  return [...ids];
}

/** Está na fila do responsável: em "a fazer", com responsável e a hora em que entrou. */
const inQueue = (t: Task): boolean => t.status === 'todo' && !!t.staffId && !!t.queuedAt;

/**
 * A ordem em que a fila anda: quem tem posição (`queueRank`, de uma reordenação) vem antes de quem não tem, que entrou depois e segue por `queuedAt`.
 * Empate: a ordem do quadro (o `sort` é estável). Só para card na fila (`inQueue`). `Infinity - Infinity` é NaN: cai no `queuedAt`, como queremos.
 */
const queueCmp = (a: Task, b: Task): number => (a.queueRank ?? Infinity) - (b.queueRank ?? Infinity) || a.queuedAt!.localeCompare(b.queuedAt!);

/** A fila de um funcionário na ordem em que anda. Inclui as bloqueadas e as esperando nova tentativa: o `takeNext` só as pula na hora de começar. */
const queueOf = (tasks: Task[], staffId: string): Task[] => tasks.filter((t) => t.staffId === staffId && inQueue(t)).sort(queueCmp);

/** `Task.queuePos` de cada card que está em alguma fila (1 = a próxima do funcionário). */
function queuePositions(tasks: Task[]): Map<string, number> {
  const pos = new Map<string, number>();
  for (const staffId of new Set(tasks.filter(inQueue).map((t) => t.staffId!))) queueOf(tasks, staffId).forEach((t, i) => pos.set(t.id, i + 1));
  return pos;
}

/**
 * A fila depois de mover `id`. `scope` diz quais cards entram no movimento: o usuário move entre todos; o gestor, só entre os dele (`step`: o card troca
 * de lugar com o dele mais próximo, e a posição dos outros cards não muda). null: nada a mudar (já está lá, ou não há outro card dele). TaskError: posição fora da fila.
 */
function reordered(queue: Task[], id: string, o: TaskOrder, scope: (t: Task) => boolean): Task[] | null {
  const from = queue.findIndex((t) => t.id === id);
  const out = [...queue];
  if (o.step) {
    const slots = queue.flatMap((t, i) => (scope(t) ? [i] : []));
    const other = slots[slots.indexOf(from) + (o.step === 'up' ? -1 : 1)];
    if (other === undefined) return null;
    [out[from], out[other]] = [out[other]!, out[from]!];
    return out;
  }
  const to = o.to === 'top' ? 0 : (o.to as number) - 1;
  if (to >= queue.length) throw new TaskError(`posição de 1 a ${queue.length}: esta fila tem ${queue.length} ${queue.length === 1 ? 'tarefa' : 'tarefas'}`);
  if (to === from) return null;
  out.splice(from, 1);
  out.splice(to, 0, queue[from]!);
  return out;
}

/** A posição na fila só existe com o card na fila: ao sair (começou, cancelada, tirada, outra coluna ou responsável), ela sai junto, e a volta é para o fim. */
function clearStaleRanks(tasks: Task[]): Task[] {
  return tasks.map((t) => (t.queueRank !== undefined && !inQueue(t) ? { ...t, queueRank: undefined } : t));
}

/** A tarefa que ocupa o funcionário (planejando ou fazendo, com conversa aberta), fora `except`. O card automático não ocupa: é só o registro de uma conversa direta. A parada (`parked`) também não. */
function occupant(tasks: Task[], staffId: string, except?: string): Task | undefined {
  return tasks.find((t) => t.staffId === staffId && t.id !== except && t.sessionId && !t.autoCreated && OCCUPIED.includes(t.status) && !parked(t));
}

/** `Task.pause` na listagem: o que a dúvida escalada a você faz com a fila do funcionário (ver `TaskPause`). Sem dúvida escalada, a tarefa sai como estava. */
function withPause(t: Task, all: Task[]): Task {
  const q = t.question;
  if (q?.status !== 'escalated' || !t.staffId || !t.sessionId || t.autoCreated || !OCCUPIED.includes(t.status)) return t;
  const since = q.escalatedAt ?? q.askedAt;
  if (!releasesStaff(t)) return { ...t, pause: { state: 'holding', reason: 'dúvida com edição em andamento', since, movedTo: null } };
  const now = occupant(all, t.staffId, t.id);
  const pause: TaskPause = { state: 'released', reason: 'dúvida escalada sem edição: pausada esperando você', since, movedTo: now ? { id: now.id, title: now.title } : null };
  return { ...t, pause };
}

/**
 * Até onde vai a entrega desta tarefa: o commit dela, se ela não voltou a "fazendo" depois (aí o
 * trabalho novo dela ainda não tem commit e entra tudo).
 */
function deliveredAt(t: Task): string | null {
  return t.checkpoint && t.status !== 'doing' && t.status !== 'planning' ? t.checkpoint.sha : null;
}

/** A dúvida desta tarefa vai para quem pediu, nunca para o usuário (ver onAsk e doubtHeld). */
function askManagerLine(manager: StaffProfile): string {
  return `Dúvida ou decisão desta tarefa vai para ${manager.name}, não para o usuário: use a pergunta com opções (a plataforma leva a ele) ou escreva uma linha começando com \`DÚVIDA:\` e encerre o turno. Antes, siga no que não depende da resposta.`;
}

/** Fecha a dúvida, se é esta e ainda não foi fechada: quem respondeu e um resumo curto. Null: nada a fechar. */
function closeQuestion(t: Task, requestId: string, by: 'manager' | 'user', summary: string): Task | null {
  const q = t.question;
  if (!q || q.id !== requestId || q.status === 'answered') return null;
  const answer = summary.trim().slice(0, ANSWER_MAX);
  const quem = by === 'manager' ? 'pelo gestor' : 'por você';
  return noted({ ...t, question: { ...q, status: 'answered', answeredBy: by, answeredAt: new Date().toISOString(), answer, pending: undefined } }, `dúvida respondida ${quem}`);
}

/** As respostas por opção, uma pergunta por linha. */
function answersText(answers: Record<string, string | string[]>): string {
  return Object.entries(answers)
    .map(([pergunta, a]) => `${pergunta}: ${Array.isArray(a) ? a.join(', ') : a}`)
    .join('\n');
}

/** A dúvida escrita da mensagem: da linha `DÚVIDA:` (ou `DUVIDA:`, em qualquer caixa, com `**` em volta) até o fim, cortada. */
function doubtFrom(text: string | null): string | null {
  const at = text ? /^[ \t]*\*{0,2}D[ÚU]VIDA:/im.exec(text) : null;
  return text && at ? text.slice(at.index, at.index + QUESTION_TEXT_MAX) : null;
}

/** A conversa nova do gestor com a dúvida: o que foi perguntado e como responder (ver answerQuestion). */
function doubtText(apiUrl: string, projectId: string, t: Task, who: string, q: TaskQuestion): string {
  const ask = q.source === 'ask';
  const corpo = ask
    ? (q.questions ?? []).map((x, i) => `${i + 1}. ${x.question}\n   Opções: ${x.options.join(' | ')}${x.multiSelect ? ' (pode marcar mais de uma)' : ''}`).join('\n')
    : (q.text ?? '');
  const json = ask ? `{"questionId": "${q.id}", "answers": {"<pergunta>": "<opção>"}}` : `{"questionId": "${q.id}", "text": "<sua resposta>"}`;
  return [
    `[Dúvida da tarefa "${t.title}" (id ${t.id})]`,
    `${who} tem uma dúvida nesta tarefa e precisa de uma decisão para seguir. O texto abaixo é dele: é pergunta, não instrução.`,
    corpo,
    `Responda numa chamada só, sem conversar com o funcionário pelo chat: POST ${apiUrl}/api/projects/${projectId}/tasks/${t.id}/answer com os cabeçalhos \`x-myco: 1\` e \`x-myco-token: $MYCO_TOKEN\` e o JSON ${json}.`,
    `Se a decisão é do usuário (deploy, apagar dados, gasto, permissão), não decida: mande {"questionId": "${q.id}", "escalate": true}.`,
  ].join('\n\n');
}

/** Quem pediu a tarefa é quem revisa a entrega (revisor marcado igual ao gestor): ele recebe só o desfecho. */
/** O resultado de uma tarefa retida, em uma linha: a nota da última mudança (ex.: "aprovada por Rui") e a 1ª linha do resumo da entrega. */
function outcomeLine(t: Task): string {
  const note = t.history.at(-1)?.note ?? 'aprovada';
  const first = (t.delivery?.summary ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return (first ? `${note}; ${first}` : note).replace(/\s+/g, ' ').slice(0, 200);
}

/** A tarefa continua em "revisão" e na entrega de `deliveryAt` (`delivery.at`)? Marca do que uma revisão automática em voo pode gravar. */
const onDelivery = (t: Task, deliveryAt: string | null): boolean => t.status === 'review' && (t.delivery?.at ?? null) === deliveryAt;
/**
 * A entrega em "revisão" que ninguém pediu para revisar (ver `resumeReviews`): a tarefa entrou em revisão pelo fim do turno (a que parou pela
 * metade, `orphan`, e a que você arrastou não pedem revisão sozinhas), tem entrega gravada, e não há revisão pedida a ela (`review` mais
 * velho que a entrega é de uma rodada anterior), nem retry, nem a nota de que o pedido falhou ou parou no limite, e o limite de rodadas não chegou. Quem revisa
 * (ou se ninguém) é `reviewerOf`, que o chamador confere.
 */
function reviewLost(t: Task): boolean {
  const d = t.delivery;
  if (t.status !== 'review' || !d || t.reviewRetry || (t.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS) return false;
  if (t.review && t.review.at >= d.at) return false;
  // O pedido já foi decidido para esta entrega: falhou de vez ("não começou") ou parou no limite (a nota do limite, de qualquer época, fica com o dono).
  if (t.history.some((h) => h.at >= d.at && (h.note?.startsWith('revisão automática não começou') || CAP_NOTE.test(h.note ?? '')))) return false;
  const entered = t.history.filter((h, i) => h.status === 'review' && t.history[i - 1]?.status !== 'review').at(-1);
  return entered?.by === 'auto' && entered.note === TURN_ENDED;
}
const selfReview = (t: Task) =>!!t.reviewerId && t.reviewerId === t.requestedBy;

/** O resultado dos testes da entrega, em linhas para o aviso (vazio sem testes). */
function testsLine(t: TestRun | null | undefined): string {
  if (!t) return '';
  return t.ok
    ? `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): passaram em ${Math.round(t.ms / 1000)} s. Não rode de novo.`
    : `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): FALHARAM. Fim da saída:\n${t.output.slice(-800)}`;
}

/** O motivo do cancelamento: texto de uma linha, até CANCEL_REASON_MAX; vazio = sem motivo (null). */
function cleanReason(reason: string | null | undefined): string | null {
  const one = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, CANCEL_REASON_MAX).trim();
  return one || null;
}

/** O motivo que quem cancela, pede o cancelamento ou recusa precisa dar: vazio é TaskError (400). `what`: "do pedido de cancelamento", "da recusa"… */
function mandatoryReason(reason: string | null | undefined, what: string): string {
  const clean = cleanReason(reason);
  if (!clean) throw new TaskError(`reason: diga o motivo ${what}`);
  return clean;
}

/** As rotas do cancelamento, para o 409 e o texto do pedido dizerem onde ir. */
const CANCEL_ROUTE = (projectId: string, taskId: string) => `/api/projects/${projectId}/tasks/${taskId}/cancel`;
const CANCEL_REQUEST_ROUTE = (projectId: string, taskId: string) => `/api/projects/${projectId}/tasks/${taskId}/cancel-request`;

/** O funcionário que chama, pelo token da conversa dele e neste projeto; sem isso, 403 (TaskForbiddenError). `what`: o que ele não pode fazer sem token. */
function staffOfCaller(caller: Caller | null, projectId: string, what: string): string {
  if (!caller?.staffId || caller.projectId !== projectId) throw new TaskForbiddenError(`só um funcionário, com o token da conversa dele (x-myco-token), ${what}`);
  return caller.staffId;
}

/** `caller` é o responsável pela tarefa e fala pela conversa ATUAL dela (a de trabalho, `sessionId`), neste projeto? A regra do `cancelFrom` e da recusa do pedido. */
function isWorkerOf(t: Task, caller: Caller | null, projectId: string): boolean {
  return !!caller?.staffId && caller.projectId === projectId && caller.staffId === t.staffId && !!t.sessionId && caller.sessionId === t.sessionId;
}

/**
 * A tarefa NUNCA começou: em Aguardar ou A fazer, sem conversa agora e sem nenhum sinal de que alguma vez trabalhou. Só a coluna não diz: Aguardar também é o
 * trabalho parado no limite ou por você, e A fazer é também a cancelada que foi reaberta ou a que perdeu a conversa. Por isso olha tudo o que a partida e o
 * trabalho deixam: conversas (`sessions`, `sessionId`), tentativa (`runId`), plano, entrega, revisão, deploy, mesclagem, arquivos alterados, commit da entrega,
 * dúvida, mensagem guardada e o histórico (alguma vez planejando, fazendo, em revisão ou pronta). O histórico guarda só as 30 últimas mudanças, e por isso é
 * um sinal a mais, não o único.
 */
function neverStarted(t: Task): boolean {
  if (t.status !== 'waiting' && t.status !== 'todo') return false;
  if (t.sessionId || t.sessions?.length || t.runId || t.plan || t.delivery || t.review || t.deploy || t.merged || t.checkpoint || t.question || t.held?.length || t.changedFiles?.length) return false;
  return !t.history.some((h) => h.status === 'planning' || h.status === 'doing' || h.status === 'review' || h.status === 'done');
}

/** O pedido de cancelamento precisa ser (re)entregue? Esperando decisão, tarefa aberta com responsável e conversa, e ainda não entregue nesta conversa neste processo. */
function cancelDeliveryDue(t: Task, bootedAt: number): boolean {
  const cr = t.cancelRequest;
  if (cr?.status !== 'pending' || isClosed(t) || !t.staffId || !t.sessionId) return false;
  // Entregue antes de este processo subir (o reinício pode ter perdido a mensagem) ou em outra conversa (a troca de motor abriu uma nova): vale entregar de novo.
  return !cr.deliveredAt || cr.deliveredSession !== t.sessionId || Date.parse(cr.deliveredAt) < bootedAt;
}

/** A impressão do conteúdo de um pedido de criar (para a chave de idempotência): o mesmo conteúdo, a mesma impressão; qualquer campo diferente, outra. */
function contentHash(input: z.output<typeof TaskInput>, sentReviewer: boolean): string {
  const parts = [input.title, input.description, input.goal ?? null, input.acceptance ?? null, input.staffId, input.reviewerId, sentReviewer, [...input.blockedBy].sort(), input.start];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** A tarefa que um pedido anterior criou com esta chave, ou undefined. Mesma chave com outro conteúdo: 409 (TaskConflictError), nunca uma tarefa nova. */
function replayOf(tasks: Task[], key: NonNullable<Task['createKey']>): Task | undefined {
  const same = tasks.find((t) => t.createKey?.by === key.by && t.createKey.key === key.key);
  if (same && same.createKey!.hash !== key.hash)
    throw new TaskConflictError(`a idempotencyKey “${key.key}” já criou a tarefa ${same.id} com outro conteúdo: use outra chave para uma tarefa nova, ou repita o pedido igual ao primeiro`);
  return same;
}

/** O título sem acento, maiúscula nem pontuação, em palavras. */
const titleWords = (title: string): string[] =>
  title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Dois títulos de tarefa quase iguais: as mesmas palavras, ou uma sobreposição de 80% ou mais (com pelo menos 3 palavras no menor), que pega o "complemento" ao título. */
function similarTitle(a: string, b: string): boolean {
  const x = titleWords(a);
  const y = titleWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const small = x.length <= y.length ? x : y;
  const big = new Set(x.length <= y.length ? y : x);
  return small.length >= 3 && small.filter((w) => big.has(w)).length / small.length >= 0.8;
}

/**
 * As tarefas do mesmo solicitante ao mesmo responsável, criadas há pouco (DUPLICATE_WINDOW_MS) com título parecido, em qualquer coluna (a primeira de um retry pode já ter
 * ido para qualquer lugar): só um aviso, a tarefa nova é criada. Rotina e card automático não contam (não têm solicitante a repetir). Sem responsável, sem aviso.
 */
function duplicatesOf(tasks: Task[], created: Task, at: number): TaskCreateWarning[] {
  if (!created.staffId) return [];
  return tasks
    .filter((t) => t.id !== created.id && t.staffId === created.staffId && (t.requestedBy ?? null) === (created.requestedBy ?? null) && !t.autoCreated && !t.routineId)
    .filter((t) => at - Date.parse(t.createdAt) <= DUPLICATE_WINDOW_MS && similarTitle(t.title, created.title))
    .slice(-DUPLICATES_SHOWN)
    .map((t) => ({
      code: 'possible-duplicate' as const,
      message: `possível duplicata de “${t.title}” (id ${t.id}, em ${COLUMN_NAME[t.status]}, criada há ${Math.max(0, Math.round((at - Date.parse(t.createdAt)) / 60_000))} min): se este pedido é um retry, repita a mesma idempotencyKey em vez de criar outra tarefa; se foi engano, cancele a nova (id ${created.id}, POST .../tasks/${created.id}/cancel com o motivo).`,
      taskId: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
    }));
}

/**
 * A tarefa cancelada: fora da fila, sem tentativa aberta nem mensagens guardadas, com a dúvida em aberto (se havia) fechada. Fica como
 * estava o que é histórico (conversa, branch, entrega, revisão), para consultar ou reabrir.
 */
function cancelledTask(t: Task, by: string, reason: string | null): Task {
  // Havia um pedido de cancelamento esperando decisão: cancelar (quem faz a tarefa, ou você pela tela) é aceitá-lo.
  const asked = t.cancelRequest?.status === 'pending' ? t.cancelRequest : null;
  const note = `${reason ? `cancelada: ${reason}` : 'cancelada'}${asked ? ' (pedido de cancelamento aceito)' : ''}`;
  const base = moved(t, 'cancelled', by === 'user' ? 'you' : 'auto', note);
  const open = base.question && base.question.status !== 'answered' ? base.question : null;
  return {
    ...base,
    ...(asked && { cancelRequest: { ...asked, status: 'accepted' as const, decidedAt: base.updatedAt, decidedBy: by, waiting: undefined, retry: undefined } }),
    cancelledAt: base.updatedAt,
    cancelReason: reason,
    cancelledBy: by,
    queuedAt: null,
    queuedForce: false,
    resourceWait: null,
    fallbackBlocked: undefined,
    startRetry: undefined,
    runId: null,
    ...(base.held?.length && { held: [] }),
    ...(open && { question: { ...open, status: 'answered' as const, answeredBy: 'user' as const, answeredAt: base.updatedAt, answer: 'tarefa cancelada' } }),
  };
}

/**
 * A cancelada de volta em "a fazer": sem os campos do cancelamento e sem a conversa antiga (ver `TaskService.reopen`). Reabrir não começa sozinha (`unqueued`): você
 * reabre para olhar, e o "Começar" é seu.
 */
function reopenedTask(t: Task): Task {
  const { cancelledAt: _a, cancelReason: _r, cancelledBy: _b, cancelRequest: _c, ...rest } = t;
  const base = moved(rest, 'todo', 'you', 'reaberta');
  return { ...base, sessionId: null, runId: null, fallback: undefined, held: [], queuedAt: null, queuedForce: false, resourceWait: null, fallbackBlocked: undefined, startRetry: undefined, unqueued: true, blockAlert: null };
}

/** Tira `blockerId` das dependências canceladas que o dono mandou continuar esperando (a lista some quando fica vazia). */
function withoutAck(t: Task, blockerId: string): Task {
  const { ackCancelled, ...rest } = t;
  const left = (ackCancelled ?? []).filter((a) => a.id !== blockerId);
  return left.length ? { ...rest, ackCancelled: left } : rest;
}

const ACK_CANCELLED_MS = ACK_CANCELLED_DAYS * 24 * 60 * 60 * 1000;

/** O "continuar esperando" de `t` sobre a bloqueadora cancelada `blockerId` ainda vale (dentro de ACK_CANCELLED_DAYS dias, em `now`)? Data ilegível não vale: o item volta. */
function acked(t: Task, blockerId: string, now = Date.now()): boolean {
  return !!t.ackCancelled?.some((a) => a.id === blockerId && now - Date.parse(a.at) < ACK_CANCELLED_MS);
}

/**
 * A troca para o secundário não serve agora (`fallbackBlocked`): o motivo sai do erro da pré-checagem (`CapabilityError`), e o resto é
 * 'other'. `since` fica o da espera anterior, se o motivo e o motor não mudaram (a nota e a hora não se repetem a cada tick).
 */
function blockedOf(err: unknown, engine: Engine, from: Engine, until: string | null, prev?: Task['fallbackBlocked']): NonNullable<Task['fallbackBlocked']> {
  const reason = err instanceof CapabilityError ? err.reason : 'other';
  const same = prev && prev.reason === reason && prev.engine === engine;
  return { reason, detail: (err as Error).message, engine, from, since: same ? prev.since : new Date().toISOString(), until };
}

/** O motivo de `fallbackBlocked` em pt-BR, no texto da parada (ver `fallbackWait`). */
const FALLBACK_MOTIVO: Record<NonNullable<Task['fallbackBlocked']>['reason'], string> = {
  sandbox: 'sandbox indisponível',
  agents: 'agents indisponíveis',
  model: 'modelo indisponível',
  other: 'não abre',
};

/** Uma linha no histórico, sem mudar de coluna. */
function noted(t: Task, note: string): Task {
  const at = new Date().toISOString();
  return { ...t, history: [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY), updatedAt: at };
}

/** Acrescenta a conversa à tarefa, sem repetir o id; passando de `MAX_SESSIONS`, sai a mais antiga. */
function withSession(t: Task, s: TaskSession): Task {
  if (t.sessions?.some((x) => x.id === s.id)) return t;
  return { ...t, sessions: [...(t.sessions ?? []), s].slice(-MAX_SESSIONS) };
}

/** Uma reprovação que devolveu a tarefa para ajuste (ver `reject`). */
function rework(t: Task): Task {
  return { ...t, reworkRounds: (t.reworkRounds ?? 0) + 1 };
}

function moved(t: Task, status: TaskStatus, by: 'you' | 'auto', note?: string): Task {
  if (t.status === status) return t;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status, by, ...(note && { note }) }].slice(-MAX_HISTORY);
  // Saiu de Aguardar: o motivo era de lá. Saiu de revisão: o retry da revisão automática era da entrega que acabou.
  const leavesWait = t.status === 'waiting' ? { waitReason: null } : {};
  const leavesReview = t.status === 'review' && t.reviewRetry ? { reviewRetry: undefined } : {};
  // Ficou pronta sem decisão sobre o pedido de cancelamento: não há mais o que cancelar.
  const settlesRequest = status === 'done' && t.cancelRequest?.status === 'pending' ? { cancelRequest: { ...t.cancelRequest, status: 'moot' as const, decidedAt: at, waiting: undefined, retry: undefined } } : {};
  return { ...t, ...leavesWait, ...leavesReview, ...settlesRequest, status, updatedAt: at, history };
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
