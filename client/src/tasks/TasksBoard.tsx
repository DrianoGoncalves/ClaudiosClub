import { Fragment, useCallback, useEffect, useState, type DragEvent } from 'react';
import { AUTO_REVIEW_ROUNDS, isClosed, type BoardConfig, type CostReport, type InboxItem, type ProjectPause, type StaffProfile, type Task as TaskModel, type TaskCreateResult, type TaskCreateWarning, type TaskHandoff, type TaskStatus } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { pollVisible } from '../usePoll';
import { Markdown } from '../chat/markdown';
import { formatAgo, formatShare } from '../format';
import { t, locale } from '../i18n';
import { BranchIcon, ClockIcon, ReviewIcon } from '../icons';
import { PrimaryReturnBadge, PrimaryReturnLine, TaskFallbackBadge } from '../staff/FallbackBadge';
import { AutoBadge, AutoInfo } from './AutoCard';
import { BoardReview, useBoardCommit, useBoardReview } from './BoardReview';
import { CommitBadge, CommitBlock } from './TaskCommit';
import { FallbackWaitBadge, fallbackWaitText } from './FallbackWait';
import { ReviewDelegate } from './ReviewDelegate';
import { reviewPlan } from './reviewRule';
import { OwnerBadge, ReviewWho } from './ReviewWho';
import { TaskCodePanel } from './TaskCodePanel';
import { DoubtBadge, DoubtBlock } from './TaskDoubt';
import { PauseNote } from './TaskPause';
import { PausedBanner, PauseButton, useProjectPause } from './ProjectPauseBar';
import { RetryBadge } from './TaskRetry';
import { SubtaskBadges, SubtaskBlock, SubtaskStack } from './TaskSubtasks';
import { ResourceWaitBadge, resourceWaitText } from './ResourceWait';
import { BlockedBadge, BlockedByField, blockerName, openBlockers, sameDeps, shownBlockers } from './TaskDeps';
import { waitClass, waitWarm } from './waitTone';
import { dependentRows, type DepMap, type DepMode } from './cancelDeps';
import { cancelledWho, duplicateWarnings } from './cancelRequest';
import { CancelRequestBadge, CancelRequestBlock, DuplicateNote } from './TaskCancelRequest';
import { planPending, planSessions } from './planPending';
import { PermissionGo, PermissionWaitBadge, PermissionWaitBlock, permissionTarget, permissionText, type PermissionText } from './PermissionWait';
import { FollowUpBadge, FollowUpBlock } from './TaskFollowUps';
import { chatFollowUpIds, conversationItemFor, verdictShown } from './followUpNotice';
import { giveBackBody, giveBackHeldNote } from './noCode';
import { NoCodeBadge, NoCodeBlock } from './TaskNoCode';
import { TaskCloseDialog } from './TaskCloseDialog';
import { TaskCostBlock } from './TaskCostBlock';
import { SectionSummary } from './SectionSummary';
import { codeSummary } from './codeSummary';
import { primaryNoteText } from './primaryReturn';
import { dropAfter, dropPosition, orderMoves, orderNoteText, queuePosOf, queueSize, stepOfKey, type OrderBody, type OrderMoves } from './queueOrder';
import { TaskRuns } from './TaskRuns';
import { askConfirm } from '../lib/dialogStore';

// Quadro de tarefas de um projeto: aguardar → a fazer → fazendo → revisão → pronto.
// Os status são 7 (ver server/tasks.ts); na tela, "planejando" vai em Fazendo, e "cancelada" não é coluna: fica num grupo recolhido no fim de Pronto.
// Arrastar um cartão muda a coluna; o resto anda sozinho com a conversa da tarefa.

/**
 * Revisão automática (contrato com o servidor): `reviewerId` preenchido = ligada; `reviewRounds` = rodadas já
 * feitas (até AUTO_REVIEW_ROUNDS); o veredito vem em `review.verdict`.
 */
type Task = TaskModel & {
  reviewerId?: string | null;
  reviewRounds?: number;
  review?: (TaskHandoff & { verdict?: 'approved' | 'rejected' | null }) | null;
};
type TaskPatch = Parameters<typeof api.updateTask>[2];
/** Limites do servidor (TaskInput em server/tasks.ts). */
const GOAL_MAX = 300;
const ACCEPTANCE_MAX = 2000;

/** Colunas do quadro: o status de quem é soltado nela e os que ela mostra. */
const COLUMNS: { status: TaskStatus; shows: TaskStatus[] }[] = [
  { status: 'waiting', shows: ['waiting'] },
  { status: 'todo', shows: ['todo'] },
  { status: 'doing', shows: ['planning', 'doing'] },
  { status: 'review', shows: ['review'] },
  { status: 'done', shows: ['done'] },
];
/** A coluna em que o status aparece (a cancelada não tem: fica no grupo recolhido de Pronto, e não se arrasta). */
export const columnOf = (s: TaskStatus): TaskStatus | null => COLUMNS.find((c) => c.shows.includes(s))?.status ?? null;

/**
 * Ordem dentro da coluna: a última atualização no topo. Os que esperam por você (`first`: plano para aprovar de verdade, ver
 * `planPending`) vão antes de tudo; planejando sem plano esperando é trabalho normal. Empate de data mantém a ordem que veio do servidor.
 */
export function byRecent<T extends Pick<TaskModel, 'status' | 'updatedAt'>>(tasks: T[], first: (t: T) => boolean = () => false): T[] {
  const at = (t: T) => Date.parse(t.updatedAt) || 0;
  return [...tasks].sort((a, b) => Number(first(b)) - Number(first(a)) || at(b) - at(a));
}

/**
 * Ordem de A fazer: a fila primeiro, na ordem em que o servidor começa (`queuePos`: a 1ª de cada funcionário antes das 2ªs, em
 * empate a que veio antes do servidor), então a próxima a ser feita fica no topo; as fora da fila vêm depois, pela última atualização.
 */
export function byQueue<T extends Pick<TaskModel, 'status' | 'updatedAt' | 'queuePos'>>(tasks: T[]): T[] {
  const queued = tasks.filter((t) => queuePosOf(t) > 0).sort((a, b) => queuePosOf(a) - queuePosOf(b));
  return [...queued, ...byRecent(tasks.filter((t) => queuePosOf(t) === 0))];
}

/**
 * Os textos da fila (chip do cartão e linha do detalhe). Com bloqueadora segurando a tarefa (`pending`: aprovada mas ainda sem
 * mesclar também conta, só a mesclagem a libera), a fila não promete início: só mostra a posição. Sem ela, diz quando começa.
 */
export const queueKeys = (pending: boolean, busy: boolean) =>
  ({
    chip: pending ? 'tasks.queuedOrderHint' : 'tasks.queuedHint',
    detail: pending ? 'tasks.queueOnly' : busy ? 'tasks.queueBusy' : 'tasks.queueFree',
  }) as const;

const LABEL: Record<TaskStatus, string> = {
  waiting: t('tasks.statusWaiting'),
  todo: t('tasks.statusTodo'),
  planning: t('tasks.statusPlanning'),
  doing: t('tasks.statusDoing'),
  review: t('tasks.statusReview'),
  done: t('tasks.statusDone'),
  cancelled: t('tasks.statusCancelled'),
};

const HELP: Record<TaskStatus, string> = {
  waiting: t('tasks.helpWaiting'),
  todo: t('tasks.helpTodo'),
  planning: t('tasks.helpPlanning'),
  doing: t('tasks.helpDoing'),
  review: t('tasks.helpReview'),
  done: t('tasks.helpDone'),
  cancelled: t('tasks.helpCancelled'),
};

/**
 * Funcionários na ordem da hierarquia: quem reporta a você primeiro, depois os subordinados
 * (pelo primeiro gestor, como no organograma). No mesmo nível, orquestrador antes; depois por nome.
 */
export function byHierarchy(staff: StaffProfile[]): StaffProfile[] {
  const byId = new Map(staff.map((s) => [s.id, s]));
  const depth = (s: StaffProfile) => {
    const seen = new Set([s.id]);
    let d = 0;
    for (let m = byId.get(s.reportsTo[0] ?? ''); m && !seen.has(m.id); m = byId.get(m.reportsTo[0] ?? '')) {
      seen.add(m.id);
      d++;
    }
    return d;
  };
  const orch = (s: StaffProfile) => (/orquestr/i.test(s.role) ? 0 : 1);
  return staff
    .map((s) => ({ s, d: depth(s) }))
    .sort((a, b) => a.d - b.d || orch(a.s) - orch(b.s) || a.s.name.localeCompare(b.s.name, 'pt-BR'))
    .map((x) => x.s);
}

interface Props {
  projectId: string;
  projectName: string;
  /** Funcionários com ficha deste projeto. */
  staff: StaffProfile[];
  costs: CostReport | null;
  onClose: () => void;
  /** Abre o painel do funcionário (e a conversa da tarefa). */
  onOpenStaff: (staffId: string) => void;
  /** As tarefas mudaram (o cabeçalho da sala relê o resumo). */
  onChanged: () => void;
  /** Abre com esta tarefa selecionada (Ctrl+K). */
  initialTaskId?: string | null;
  /** Abre os agendamentos (despertadores) do projeto. */
  onOpenSchedules?: () => void;
  /** Só para teste: o render no servidor não roda o efeito que lê as tarefas, então o quadro começa com estas em vez de "carregando". */
  initialTasks?: Task[];
  /** Só para teste, como `initialTasks`: a pausa do projeto de partida (null = rodando); sem ela o quadro a lê do servidor. */
  initialPause?: ProjectPause | null;
  /** A caixa "precisa de mim" (useInbox): o selo "Plano para aprovar" só vale com um item `plan` da conversa da tarefa. Sem ela, nenhuma tarefa tem plano esperando. */
  inboxItems?: InboxItem[];
  /** Abre a conversa de um aviso da caixa, já no cartão dele (o atalho "Responder no chat" do pedido de permissão). Sem ela, o quadro só mostra o selo. */
  onOpenInbox?: (item: InboxItem) => void;
}

const NO_ITEMS: InboxItem[] = [];

export function TasksBoard({ projectId, projectName, staff, costs, onClose, onOpenStaff, onChanged, initialTaskId = null, onOpenSchedules, initialTasks, initialPause, inboxItems = NO_ITEMS, onOpenInbox }: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(initialTasks ?? null);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  /** O cartão da fila sobre o qual se arrasta outro da mesma fila, e de que lado dele o arrastado entra (`after`: abaixo). */
  const [overCard, setOverCard] = useState<{ id: string; after: boolean } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  /** Diálogo de cancelar ou apagar aberto, para a tarefa `id`. */
  const [closing, setClosing] = useState<{ mode: DepMode; id: string } | null>(null);
  /** O card sem código que está sendo devolvido ao responsável (o botão espera o envio). */
  const [givingBack, setGivingBack] = useState<string | null>(null);
  /** O que o último "Devolver" deixou quando não falhou: a mensagem ficou guardada (aviso neutro, não erro). Vale só para o card dele. */
  const [giveBackNote, setGiveBackNote] = useState<{ id: string; text: string } | null>(null);
  /** Aviso de possível duplicata da última tarefa criada aqui (a nova, e as parecidas); some ao fechar o aviso ou ao abrir o formulário de novo. */
  const [dup, setDup] = useState<{ createdId: string; warnings: TaskCreateWarning[] } | null>(null);
  const boardReview = useBoardReview(projectId);
  const boardCommit = useBoardCommit(projectId);
  const projectPause = useProjectPause(projectId, projectName, onChanged, initialPause);
  const now = Date.now();

  const load = useCallback(() => {
    api.tasks(projectId).then((t) => setTasks(t ?? []), (e: Error) => setError(e.message));
  }, [projectId]);

  // As tarefas andam sozinhas (plano aprovado, turno terminado): relê de tempos em tempos.
  useEffect(() => {
    load();
    return pollVisible(load, 5000);
  }, [load]);

  useEffect(() => {
    // Com o diálogo de cancelar/apagar aberto, o Esc é dele (fecha só o diálogo).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !closing && (selected ? setSelected(null) : onClose());
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, selected, closing]);

  // O erro de uma tarefa não segue para a próxima.
  useEffect(() => setError(null), [selected]);

  // A tarefa do diálogo sumiu (apagada aqui ou em outra aba): o diálogo fecha.
  useEffect(() => {
    if (closing && tasks && !tasks.some((x) => x.id === closing.id)) setClosing(null);
  }, [closing, tasks]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const move = (t: Task, status: TaskStatus) => t.status !== status && act(() => api.updateTask(projectId, t.id, { status }));
  /** Muda o lugar do cartão na fila do responsável (o servidor confere quem pode e recusa o que não muda nada). */
  const reorder = (t: Task, body: OrderBody) => act(() => api.reorderTask(projectId, t.id, body));
  const start = (t: Task) => act(() => withUsageConfirm((force) => api.startTask(projectId, t.id, force)));
  const nameOf = (id: string | null) => staff.find((s) => s.id === id)?.name ?? null;
  /** Cancelar ou apagar, já com a resposta do diálogo (o erro vai para ele, que continua aberto). */
  const closeTask = async (task: Task, mode: DepMode, input: { reason?: string; dependents: DepMap }) => {
    const dependents = Object.keys(input.dependents).length ? input.dependents : undefined;
    if (mode === 'cancel') await api.cancelTask(projectId, task.id, { ...(input.reason && { reason: input.reason }), ...(dependents && { dependents }) });
    else {
      await api.deleteTask(projectId, task.id, dependents);
      setSelected(null);
    }
    load();
    onChanged();
  };
  const costOf = (t: Task) => {
    const usd = t.sessionId ? costs?.projects[projectId]?.sessions[t.sessionId] : undefined;
    return usd !== undefined && costs?.total.usd ? formatShare(usd, costs.total.usd) : null;
  };
  const current = tasks?.find((t) => t.id === selected) ?? null;
  /** Plano esperando você nesta tarefa: planejando e com item `plan` na caixa para a conversa dela (o status sozinho não prova). */
  const planSess = planSessions(inboxItems);
  const awaitingPlan = (t: Task) => planPending(t, planSess);
  /** O pedido de permissão que a conversa da tarefa espera de você (`Task.permissionWait`): o texto do selo, ou null. */
  const permissionOf = (t: Task): PermissionText | null => permissionText(t.permissionWait, nameOf(t.staffId), now, awaitingPlan(t));
  /** O atalho para o cartão do pedido no chat (undefined sem a prop do App, sem aviso na tela ou sem conversa). */
  const openPermission = (t: Task) => {
    const target = onOpenInbox && permissionOf(t) ? permissionTarget(t, inboxItems, { id: projectId, name: projectName }) : null;
    return target ? () => onOpenInbox!(target) : undefined;
  };
  /** O atalho para a conversa de trabalho onde o follow-up da tarefa espera a sua decisão (undefined sem a prop do App ou sem follow-up lá). */
  const openFollowUpChat = (task: Task) => {
    const item = onOpenInbox ? conversationItemFor(task.id, inboxItems, projectId) : null;
    return item ? () => onOpenInbox!(item) : undefined;
  };
  /** Card sem código: devolve ao responsável com uma mensagem na conversa de trabalho dele (que tira a marca); sem a conversa, o erro diz para cancelar. */
  const giveBack = async (task: Task) => {
    // Um envio por vez: o clique repetido mandaria a mensagem duas vezes ao funcionário (a marca só sai no primeiro envio).
    if (givingBack) return;
    setGivingBack(task.id);
    setGiveBackNote(null);
    try {
      await act(async () => {
        const body = giveBackBody(task);
        if (!body) throw new Error(t('tasks.noCodeNoSession'));
        const held = giveBackHeldNote(await withUsageConfirm((force) => api.chatSend(projectId, { ...body, force })));
        if (held) setGiveBackNote({ id: task.id, text: held });
      });
    } finally {
      setGivingBack(null);
    }
  };
  /** O projeto publica? (tem funcionário com servidor ou já teve pedido de deploy): só aí "não publicado" faz sentido. */
  const hasDeploy = staff.some((s) => s.servers.length > 0) || !!tasks?.some((t) => t.deploy);
  /** A tarefa que ocupa o funcionário agora (planejando ou fazendo). */
  const busyWith = (t: Task) =>
    tasks?.find((o) => o.id !== t.id && o.staffId === t.staffId && o.sessionId && (o.status === 'doing' || o.status === 'planning')) ?? null;
  /** Os passos de ordem do cartão (null: fora da fila ou sozinho nela). */
  const movesOf = (t: Task) => orderMoves(t, tasks ?? []);
  /** As dependências que seguram a tarefa (só a que ainda não começou espera por elas). */
  const waitingOn = (t: Task) => (!t.sessionId && (t.status === 'todo' || t.status === 'waiting') ? openBlockers(t, tasks ?? []) : []);
  /** As que o selo "Esperando" ainda mostra: a bloqueadora já aprovada sai (ver `shownBlockers`); sobra só a posição na fila. */
  const waitingShown = (t: Task) => shownBlockers(waitingOn(t));
  /** Pronto parado há mais de 7 dias (o servidor marca): fora do quadro, atrás do "Ver arquivadas". */
  const archived = (tasks ?? []).filter((t) => t.archived);
  /** Canceladas: fora das colunas, no grupo recolhido de Pronto. Nunca contam como prontas. */
  const cancelled = (tasks ?? []).filter((t) => t.status === 'cancelled');
  const closingTask = closing ? (tasks?.find((t) => t.id === closing.id) ?? null) : null;

  /**
   * Arrastar outro cartão da mesma fila sobre este: ele entra antes (metade de cima) ou depois (metade de baixo) daqui, e o traço azul mostra onde.
   * O alvo é a pilha toda (`currentTarget`: o cartão e a bandeja de subtarefas); a metade vale para o cartão, e sobre a bandeja é sempre "depois".
   * O soltar na coluna, que muda de coluna, não entra. null: não vale aqui (outra fila, ou já está ali).
   */
  const dropOn = (task: Task, e: DragEvent<HTMLElement>) => {
    const box = (e.currentTarget.querySelector('.task-card') ?? e.currentTarget).getBoundingClientRect();
    const after = dropAfter(e.clientY, box, !!(e.target as Element).closest('.task-subs-tray'));
    return { after, to: dropPosition(tasks?.find((x) => x.id === dragging), task, after) };
  };

  const card = (task: Task) => (
    <Fragment key={task.id}>
      {/* Subtarefas (card que aguarda) ou card de origem (subtarefa): a bandeja fica colada no cartão, fora do botão (botão não cabe dentro de botão). O alvo do arrasto é a pilha: a bandeja conta como parte do cartão. */}
      <SubtaskStack
        task={task}
        tasks={tasks ?? []}
        labels={LABEL}
        onOpen={setSelected}
        onDragOver={(e) => {
          const { after, to } = dropOn(task, e);
          // Sem lugar válido aqui: apaga o traço de antes e deixa o evento subir (a coluna segue valendo para mudar de coluna).
          if (to === null) return setOverCard((o) => (o?.id === task.id ? null : o));
          e.preventDefault();
          e.stopPropagation();
          setOver(null);
          setOverCard((o) => (o?.id === task.id && o.after === after ? o : { id: task.id, after }));
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCard((o) => (o?.id === task.id ? null : o));
        }}
        onDrop={(e) => {
          const { to } = dropOn(task, e);
          if (to === null) return;
          e.preventDefault();
          e.stopPropagation();
          const dragged = tasks?.find((x) => x.id === dragging);
          setOverCard(null);
          setDragging(null);
          if (dragged) void reorder(dragged, { to });
        }}
      >
      <button
        className={`task-card ${selected === task.id ? 'is-selected' : ''} ${task.archived || task.status === 'cancelled' ? 'is-archived' : ''} ${awaitingPlan(task) ? 'is-waiting' : ''} ${dragging === task.id ? 'is-dragging' : ''} ${overCard?.id === task.id ? (overCard.after ? 'is-drop-after' : 'is-drop-before') : ''}`}
        draggable={task.status !== 'cancelled'}
        onDragStart={(e) => {
          // O Firefox só começa o arrasto com algum dado no pacote; o resto do quadro lê o cartão pelo estado.
          e.dataTransfer.setData('text/plain', task.id);
          e.dataTransfer.effectAllowed = 'move';
          setDragging(task.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setOverCard(null);
        }}
        onKeyDown={(e) => {
          // Sem botão de ordem no cartão: com ele em foco, Alt + ↑/↓ sobe ou desce um lugar na fila.
          const step = stepOfKey(e.key, e.altKey);
          if (!step || !movesOf(task)?.[step]) return;
          e.preventDefault();
          void reorder(task, { step });
        }}
        onClick={() => setSelected(task.id)}
      >
        <span className="task-title">{task.title}</span>
        <StatusBadge task={task} hasDeploy={hasDeploy} planWaiting={awaitingPlan(task)} />
        <PermissionWaitBadge text={permissionOf(task)} />
        <NoCodeBadge task={task} />
        <VerdictBadge task={task} nameOf={nameOf} />
        {task.status === 'review' && <OwnerBadge plan={reviewPlan(task, boardReview.config)} />}
        <DoubtBadge question={task.question} requestedBy={task.requestedBy} nameOf={nameOf} warm={waitWarm(task.status)} />
        <CancelRequestBadge request={task.cancelRequest} nameOf={nameOf} />
        <FollowUpBadge task={task} />
        <CommitBadge task={task} />
        <PauseNote pause={task.pause} staffName={nameOf(task.staffId)} now={now} />
        <SubtaskBadges task={task} nameOf={nameOf} />
        <span className="task-meta muted small">
          <span className="task-id" title={t('tasks.idHint')}>
            {task.id}
          </span>{' '}
          · {nameOf(task.staffId) ?? t('tasks.noOwner')}
          {task.requestedBy && ` · ${t('tasks.requestedBy', { name: nameOf(task.requestedBy) ?? task.requestedBy })}`}
          {costOf(task) && ` · ${costOf(task)}`} · {formatAgo(now - Date.parse(task.updatedAt))}
        </span>
        {task.status === 'cancelled' && (
          <span className="task-run-note muted small" title={task.cancelReason ?? undefined}>
            {t('tasks.cancelledBy', { name: cancelledWho(task, nameOf) })}
            {task.cancelReason && ` · ${task.cancelReason}`}
          </span>
        )}
        {task.branch && (
          <span className="task-branch small">
            <BranchIcon /> {task.branch}
          </span>
        )}
        {task.reviewerId && (
          <span className="task-reviewer small" title={t('tasks.autoReviewHint', { name: nameOf(task.reviewerId) ?? task.reviewerId })}>
            <ReviewIcon /> {nameOf(task.reviewerId) ?? task.reviewerId}
            {!!task.reviewRounds && ` · ${t('tasks.reviewRounds', { n: task.reviewRounds, max: AUTO_REVIEW_ROUNDS })}`}
          </span>
        )}
        <AutoBadge task={task} />
        {task.fallback && <TaskFallbackBadge fallback={task.fallback} />}
        <PrimaryReturnBadge task={task} />
        <FallbackWaitBadge wait={task.fallbackBlocked} now={now} warm={waitWarm(task.status)} />
        {/* Esperando dependência: o selo diz por quais tarefas; na fila ou não, ela só começa quando ficarem prontas. O laranja de espera é só da coluna A fazer. */}
        <BlockedBadge blockers={waitingShown(task)} warm={waitWarm(task.status)} />
        {/* A ordem na fila não é aviso: fica no visual padrão, sem o laranja da espera. */}
        {queuePosOf(task) > 0 && !waitingShown(task).length && (
          <span className="task-queue small" title={t(queueKeys(waitingOn(task).length > 0, false).chip)}>
            {t('tasks.queuePos', { pos: queuePosOf(task), who: nameOf(task.staffId) ?? t('tasks.ownerFallback') })}
          </span>
        )}
        <ResourceWaitBadge wait={task.resourceWait} now={now} warm={waitWarm(task.status)} />
        <RetryBadge retry={task.retry} now={now} />
        {!!task.held?.length && (
          <span className={`task-queue${waitClass(waitWarm(task.status))} small`} title={t('tasks.heldHint')}>
            {t(task.held.length === 1 ? 'tasks.heldOne' : 'tasks.heldOther', { n: task.held.length })}
          </span>
        )}
      </button>
      </SubtaskStack>
      {/* Atalho do pedido de permissão: fora do botão do cartão (botão não cabe dentro de botão). */}
      <PermissionGo onOpen={openPermission(task)} />
      {/* Motivo de Aguardar: fica fora do botão (o cartão é um botão, e campo não cabe dentro). Salva ao sair do campo. */}
      {task.status === 'waiting' && (
        <input
          key={task.waitReason ?? ''}
          className="task-wait-reason small"
          defaultValue={task.waitReason ?? ''}
          maxLength={200}
          placeholder={t('tasks.waitReasonPlaceholder')}
          aria-label={t('tasks.waitReasonPlaceholder')}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim() || null;
            if (next !== (task.waitReason ?? null)) void act(() => api.updateTask(projectId, task.id, { waitReason: next }));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
    </Fragment>
  );

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tasks-modal" role="dialog" aria-label={t('tasks.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <div className="tasks-head-title">
            <h2>{t('tasks.title', { name: projectName })}</h2>
            {projectPause.pause !== undefined && <PauseButton paused={projectPause.pause !== null} busy={projectPause.busy} onClick={projectPause.toggle} />}
          </div>
          <span className="tasks-head-actions">
            {onOpenSchedules && (
              <button className="btn-secondary btn-with-icon" onClick={onOpenSchedules} title={t('schedules.openTitle')}>
                <ClockIcon /> {t('schedules.open')}
              </button>
            )}
            <button
              className="btn-primary"
              onClick={() => {
                setDup(null);
                setAdding(true);
              }}
            >
              {t('tasks.newTask')}
            </button>
            <button className="drawer-close in-head" onClick={onClose} aria-label={t('tasks.close')}>
              ×
            </button>
          </span>
        </header>
        {projectPause.pause && <PausedBanner pause={projectPause.pause} now={now} />}
        {projectPause.error && <p className="error small" role="alert">{projectPause.error}</p>}
        {/* Com o detalhe aberto o erro aparece nele: no celular o detalhe cobre o quadro inteiro. */}
        {error && !current && <p className="error small" role="alert">{error}</p>}
        {dup && (
          <DuplicateNote
            warnings={dup.warnings}
            createdId={dup.createdId}
            now={now}
            statusLabel={(s) => LABEL[s]}
            onOpen={setSelected}
            onClose={() => setDup(null)}
          />
        )}
        <BoardReview review={boardReview} commit={boardCommit} staff={byHierarchy(staff)} />
        {adding && (
          <TaskForm
            staff={byHierarchy(staff)}
            tasks={tasks ?? []}
            onCancel={() => setAdding(false)}
            onSave={async (input, andStart) => {
              setError(null);
              let made: TaskCreateResult | null;
              try {
                // Só criar (start false): a tarefa fica em Aguardar.
                made = await api.createTask(projectId, { ...input, start: andStart });
              } catch (e) {
                // Recusada (ex.: dependência que não existe): o formulário fica aberto, com o que foi digitado.
                setError((e as Error).message);
                return;
              }
              setAdding(false);
              // Criada, mas parecida com uma de há pouco: só aviso (a tarefa existe); você decide qual cancelar.
              const similar = duplicateWarnings(made);
              setDup(made && similar.length ? { createdId: made.id, warnings: similar } : null);
              await act(async () => {
                if (andStart && made?.staffId) await withUsageConfirm((force) => api.startTask(projectId, made!.id, force));
              });
            }}
          />
        )}
        {!tasks ? (
          <p className="muted">{t('tasks.loading')}</p>
        ) : (
          <div className="tasks-columns">
            {COLUMNS.map(({ status, shows }) => {
              const shown = tasks.filter((t) => !t.archived && shows.includes(t.status));
              const col = status === 'todo' ? byQueue(shown) : byRecent(shown, awaitingPlan);
              return (
                <section
                  key={status}
                  className={`tasks-col tasks-col-${status} ${over === status ? 'is-over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(status);
                  }}
                  onDragLeave={() => setOver((o) => (o === status ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setOver(null);
                    const t = tasks.find((x) => x.id === dragging);
                    // Na mesma coluna não muda nada (plano para aprovar continua plano; no ar continua no ar).
                    if (t && t.status !== 'cancelled' && columnOf(t.status) !== status) void move(t, status);
                    setDragging(null);
                  }}
                >
                  <h3 title={HELP[status]}>
                    {LABEL[status]} <span className="muted">{col.length || ''}</span>
                  </h3>
                  {col.map(card)}
                  {status === 'done' && archived.length > 0 && (
                    <>
                      <button
                        className="link small tasks-archived-toggle"
                        aria-expanded={showArchived}
                        title={t('tasks.archivedHint')}
                        onClick={() => setShowArchived((v) => !v)}
                      >
                        {showArchived ? t('tasks.hideArchived') : t('tasks.showArchived', { n: archived.length })}
                      </button>
                      {showArchived && byRecent(archived).map(card)}
                    </>
                  )}
                  {/* Canceladas: o mesmo grupo recolhido das arquivadas, no fim de Pronto (fechou sem entrega, então não é "pronta"). */}
                  {status === 'done' && cancelled.length > 0 && (
                    <>
                      <button className="link small tasks-archived-toggle" aria-expanded={showCancelled} title={HELP.cancelled} onClick={() => setShowCancelled((v) => !v)}>
                        {showCancelled ? t('tasks.hideCancelled') : t('tasks.showCancelled', { n: cancelled.length })}
                      </button>
                      {showCancelled && byRecent(cancelled).map(card)}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {current && (
          <TaskDetail
            key={current.id}
            projectId={projectId}
            onChanged={() => {
              load();
              onChanged();
            }}
            onOpenStaff={onOpenStaff}
            task={current}
            staff={staff}
            board={boardReview.config}
            cost={costOf(current)}
            onClose={() => setSelected(null)}
            onSave={(patch) => act(() => api.updateTask(projectId, current.id, patch as TaskPatch))}
            onMove={(s) => void move(current, s)}
            onStart={() => void start(current)}
            error={error}
            tasks={tasks ?? []}
            waitingOn={waitingOn(current)}
            waitingShown={waitingShown(current)}
            busyWith={busyWith(current)}
            queuePos={queuePosOf(current)}
            queueTotal={queueSize(tasks ?? [], current.staffId)}
            moves={movesOf(current)}
            onUnqueue={() => void act(() => api.updateTask(projectId, current.id, { queued: false }))}
            onOpen={() => current.staffId && onOpenStaff(current.staffId)}
            permission={permissionOf(current)}
            onOpenPermission={openPermission(current)}
            chatFollowUps={chatFollowUpIds(current.id, inboxItems, projectId)}
            onOpenChat={openFollowUpChat(current)}
            givingBack={givingBack === current.id}
            giveBackNote={giveBackNote?.id === current.id ? giveBackNote.text : null}
            onGiveBack={() => void giveBack(current)}
            onOpenTask={setSelected}
            nameOf={nameOf}
            onCancel={() => setClosing({ mode: 'cancel', id: current.id })}
            onReopen={() => void act(() => api.reopenTask(projectId, current.id))}
            onDelete={async () => {
              // Com tarefas esperando por esta, apagar pede decidir o que fazer com elas (o diálogo); sem elas, segue como sempre.
              if (dependentRows(current.id, tasks ?? []).length) return setClosing({ mode: 'delete', id: current.id });
              if (await askConfirm(t('tasks.confirmDelete', { title: current.title })))
                void act(async () => {
                  await api.deleteTask(projectId, current.id);
                  setSelected(null);
                });
            }}
          />
        )}
        {closing && closingTask && (
          <TaskCloseDialog
            key={`${closing.mode}:${closing.id}`}
            mode={closing.mode}
            task={closingTask}
            tasks={tasks ?? []}
            nameOf={nameOf}
            onConfirm={(input) => closeTask(closingTask, closing.mode, input)}
            onClose={() => setClosing(null)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Selo do cartão: plano esperando você (Fazendo, amarelo) e, em Pronto, se ainda falta o deploy (projeto que publica).
 * Planejando sem plano esperando é trabalho normal: selo neutro, sem chamar a atenção.
 */
function StatusBadge({ task, hasDeploy, planWaiting }: { task: Task; hasDeploy: boolean; planWaiting: boolean }) {
  if (task.status === 'planning')
    return planWaiting ? (
      <span className="task-badge is-waiting" title={HELP.planning}>
        {t('tasks.badgePlan')}
      </span>
    ) : (
      <span className="task-badge small" title={t('tasks.helpPlanningWorking')}>
        {LABEL.planning}
      </span>
    );
  if (task.status === 'cancelled')
    return (
      <span className="task-badge small" title={HELP.cancelled}>
        {LABEL.cancelled}
      </span>
    );
  if (task.status === 'done' && hasDeploy)
    return (
      <span className="task-badge small" title={t('tasks.badgeNotLiveHint')}>
        {t('tasks.badgeNotLive')}
      </span>
    );
  return null;
}

/**
 * Veredito da revisão (aprovada/reprovada por quem revisou), quando houver. "Aprovada" não aparece com follow-up aberto: a tarefa não está toda resolvida, e o selo de follow-ups
 * pendentes ocupa o lugar dele (ver `verdictShown`); decididos todos, volta.
 */
function VerdictBadge({ task, nameOf }: { task: Task; nameOf: (id: string | null) => string | null }) {
  const verdict = task.review?.verdict;
  if (!verdict || !verdictShown(task)) return null;
  const name = nameOf(task.review!.staffId) ?? task.review!.staffId;
  return (
    <span className={`task-badge small ${verdict === 'approved' ? 'is-approved' : 'is-rejected'}`}>
      {t(verdict === 'approved' ? 'tasks.verdictApproved' : 'tasks.verdictRejected', { name })}
    </span>
  );
}

/**
 * "Revisão automática": marcado, mostra quem revisa (os do projeto, menos quem faz). Desmarcado = null.
 * Ao marcar, já escolhe o primeiro da lista.
 */
function ReviewerField({
  staff,
  ownerId,
  value,
  onChange,
}: {
  staff: StaffProfile[];
  ownerId: string | null;
  value: string | null;
  onChange: (reviewerId: string | null) => void;
}) {
  const options = staff.filter((s) => s.id !== ownerId);
  return (
    <>
      <label className="check" title={options.length ? t('tasks.autoReviewHelp', { n: AUTO_REVIEW_ROUNDS }) : t('tasks.autoReviewNobody')}>
        <input
          type="checkbox"
          checked={!!value}
          disabled={!value && !options.length}
          onChange={(e) => onChange(e.target.checked ? (options[0]?.id ?? null) : null)}
        />
        {t('tasks.autoReview')}
      </label>
      {value && (
        <label>
          {t('tasks.whoReviews')}
          <select value={value} onChange={(e) => onChange(e.target.value)}>
            {/* Revisor que saiu do projeto: aparece como está, em vez de fingir que é o primeiro da lista. */}
            {!options.some((s) => s.id === value) && <option value={value}>{value}</option>}
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — {s.role}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}

/** Meta e critério de aceite: o servidor aceita vazio (= sem), então só vão os preenchidos. */
function GoalFields({
  goal,
  acceptance,
  onGoal,
  onAcceptance,
}: {
  goal: string;
  acceptance: string;
  onGoal: (v: string) => void;
  onAcceptance: (v: string) => void;
}) {
  return (
    <>
      <label title={t('tasks.goalHint')}>
        {t('tasks.fieldGoal')}
        <input value={goal} maxLength={GOAL_MAX} placeholder={t('tasks.goalPlaceholder')} onChange={(e) => onGoal(e.target.value)} />
      </label>
      <label title={t('tasks.acceptanceHint')}>
        {t('tasks.fieldAcceptance')}
        <textarea rows={3} value={acceptance} maxLength={ACCEPTANCE_MAX} placeholder={t('tasks.acceptancePlaceholder')} onChange={(e) => onAcceptance(e.target.value)} />
      </label>
    </>
  );
}

function TaskForm({
  staff,
  tasks,
  onSave,
  onCancel,
}: {
  staff: StaffProfile[];
  /** As outras tarefas do projeto (para marcar "Bloqueada por"). */
  tasks: Task[];
  onSave: (
    input: { title: string; description: string; staffId: string | null; reviewerId: string | null; goal?: string; acceptance?: string; blockedBy?: string[] },
    andStart: boolean,
  ) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [staffId, setStaffId] = useState<string>(staff[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (andStart: boolean) => {
    if (!title.trim()) return;
    setBusy(true);
    await onSave(
      {
        title: title.trim(),
        description: description.trim(),
        staffId: staffId || null,
        reviewerId,
        ...(goal.trim() && { goal: goal.trim() }),
        ...(acceptance.trim() && { acceptance: acceptance.trim() }),
        ...(blockedBy.length && { blockedBy }),
      },
      andStart,
    );
    setBusy(false);
  };
  return (
    <form
      className="task-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(true);
      }}
    >
      <label>
        {t('tasks.fieldTitle')}
        <input value={title} maxLength={120} autoFocus placeholder={t('tasks.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('tasks.fieldDescription')}
        <textarea rows={3} value={description} maxLength={8000} placeholder={t('tasks.descPlaceholder')} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        {t('tasks.fieldOwner')}
        <select
          value={staffId}
          onChange={(e) => {
            setStaffId(e.target.value);
            // Quem faz não revisa a própria tarefa.
            if (e.target.value === reviewerId) setReviewerId(null);
          }}
        >
          <option value="">{t('tasks.nobodyYet')}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
      </label>
      <ReviewerField staff={staff} ownerId={staffId || null} value={reviewerId} onChange={setReviewerId} />
      {/* Opcionais, recolhidos: o formulário curto basta para a maioria das tarefas. */}
      <details className="collapse task-form-more">
        <summary>{t('tasks.formMore')}</summary>
        <div className="task-form-more-body">
          <GoalFields goal={goal} acceptance={acceptance} onGoal={setGoal} onAcceptance={setAcceptance} />
          <BlockedByField tasks={tasks} selfId={null} value={blockedBy} labels={LABEL} onChange={setBlockedBy} />
        </div>
      </details>
      <p className="actions">
        <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !staffId} title={t('tasks.createHint')}>
          {t('tasks.createAndStart')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !title.trim()} onClick={() => void submit(false)}>
          {t('tasks.createOnly')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('tasks.cancel')}
        </button>
      </p>
    </form>
  );
}

function TaskDetail({
  projectId,
  task,
  staff,
  board,
  cost,
  onClose,
  onSave,
  onMove,
  onStart,
  error,
  tasks,
  waitingOn,
  waitingShown,
  busyWith,
  queuePos,
  queueTotal,
  moves,
  onUnqueue,
  onOpen,
  permission,
  onOpenPermission,
  chatFollowUps,
  onOpenChat,
  givingBack,
  giveBackNote,
  onGiveBack,
  onOpenTask,
  onDelete,
  onCancel,
  onReopen,
  nameOf,
  onChanged,
  onOpenStaff,
}: {
  projectId: string;
  task: Task;
  staff: StaffProfile[];
  /** A revisão automática do quadro (null = ainda não lida ou servidor sem a opção). */
  board: BoardConfig | null;
  cost: string | null;
  onChanged: () => void;
  onOpenStaff: (staffId: string) => void;
  onClose: () => void;
  onSave: (patch: Partial<Pick<Task, 'title' | 'description' | 'staffId' | 'pr' | 'branch' | 'reviewerId' | 'goal' | 'acceptance' | 'blockedBy'>>) => Promise<void>;
  onMove: (s: TaskStatus) => void;
  onStart: () => void;
  /** O erro da última ação (ex.: dependência em ciclo, apagar tarefa de que outra depende): aparece aqui, onde o dedo está. */
  error: string | null;
  /** Todas as tarefas do projeto (as candidatas a dependência). */
  tasks: Task[];
  /** As dependências que ainda seguram esta tarefa (a cancelada continua segurando). */
  waitingOn: { id: string; title: string; status: TaskStatus }[];
  /** As de `waitingOn` que o texto "Esperando" ainda mostra (sem a bloqueadora já aprovada). */
  waitingShown: { id: string; title: string; status: TaskStatus }[];
  /** A tarefa em que o responsável está agora (aí "Começar" põe na fila). */
  busyWith: Task | null;
  queuePos: number;
  /** Quantos cartões a fila do responsável tem. */
  queueTotal: number;
  /** Os passos de ordem que o cartão aceita (null: fora da fila ou sozinho nela; aí o detalhe não fala de ordem). */
  moves: OrderMoves | null;
  onUnqueue: () => void;
  onOpen: () => void;
  /** O pedido de permissão que a conversa da tarefa espera de você (null: nenhum, ou o plano já avisa). */
  permission: PermissionText | null;
  /** Abre o chat no cartão do pedido (undefined: sem como abrir daqui). */
  onOpenPermission?: () => void;
  /** Os follow-ups abertos desta tarefa que esperam na conversa de trabalho (item da caixa com a conversa): aqui o detalhe só aponta para lá. */
  chatFollowUps: ReadonlySet<string>;
  /** Abre a conversa de trabalho onde eles esperam (undefined: sem como abrir daqui). */
  onOpenChat?: () => void;
  /** Card sem código: o envio ao responsável está em andamento (o botão fica desligado). */
  givingBack: boolean;
  /** Card sem código: a mensagem do "Devolver" ficou guardada (aviso neutro; null: nada a dizer). */
  giveBackNote: string | null;
  /** Card sem código: devolve ao responsável (uma mensagem na conversa dele). */
  onGiveBack: () => void;
  /** Abre o detalhe de outra tarefa do quadro (a subtarefa ou o card de origem). */
  onOpenTask: (id: string) => void;
  onDelete: () => void;
  /** Abre o diálogo de cancelar (toda tarefa não encerrada). */
  onCancel: () => void;
  /** Reabre a cancelada. */
  onReopen: () => void;
  nameOf: (staffId: string | null) => string | null;
}) {
  /** Textos do porquê de a tarefa não andar: laranja só com o cartão em A fazer, como no selo do cartão. */
  const waitText = `muted${waitWarm(task.status) ? ' task-wait-text' : ''} small`;
  const fbWait = fallbackWaitText(task.fallbackBlocked, Date.now());
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [pr, setPr] = useState(task.pr ?? '');
  const [goal, setGoal] = useState(task.goal ?? '');
  const [acceptance, setAcceptance] = useState(task.acceptance ?? '');
  const [blockedBy, setBlockedBy] = useState(task.blockedBy ?? []);
  const goalChanged = goal.trim() !== (task.goal ?? '');
  const acceptanceChanged = acceptance.trim() !== (task.acceptance ?? '');
  const depsChanged = !sameDeps(blockedBy, task.blockedBy ?? []);
  const dirty = title !== task.title || description !== task.description || pr !== (task.pr ?? '') || goalChanged || acceptanceChanged || depsChanged;
  const who = staff.find((s) => s.id === task.staffId);
  return (
    <aside className="task-detail">
      <header className="task-detail-head">
        <span className="kicker" title={task.archived ? t('tasks.archivedHint') : undefined}>
          {LABEL[task.status]}
          {task.archived && ` · ${t('tasks.archivedTag')}`}
          {' · '}
          <span className="task-id" title={t('tasks.idHint')}>
            {task.id}
          </span>
        </span>
        <button className="drawer-close in-head" onClick={onClose} aria-label={t('tasks.closeDetails')}>
          ×
        </button>
      </header>
      {/* Gruda no topo ao rolar: o botão que falhou (Salvar, Apagar) pode estar longe daqui. */}
      {error && (
        <p className="error small task-detail-error" role="alert">
          {error}
        </p>
      )}
      {/* No topo, antes de tudo: é o que trava o card e só você destrava (a conversa espera a sua permissão). */}
      <PermissionWaitBlock text={permission} onOpen={onOpenPermission} />
      {/* No topo: explica por que o card está parado em Fazendo e leva à subtarefa (ou ao card de origem); no celular o detalhe cobre o quadro. */}
      <SubtaskBlock task={task} tasks={tasks} labels={LABEL} staffName={who?.name ?? null} onOpen={onOpenTask} />
      {/* Card = código: o card que terminou sem editar nada não foi para revisão; quem pediu decide (cancelar com motivo ou devolver ao responsável). */}
      <NoCodeBlock task={task} nameOf={nameOf} busy={givingBack} note={giveBackNote} onCancel={onCancel} onGiveBack={onGiveBack} />
      {/* Também no topo: o resumo dos follow-ups e o caminho para a conversa onde eles esperam (o card costuma estar Finalizado: nada mais pede a sua atenção nele). */}
      <FollowUpBlock task={task} tasks={tasks} team={staff} nameOf={nameOf} now={Date.now()} projectId={projectId} chatIds={chatFollowUps} onOpenChat={onOpenChat} onOpenTask={onOpenTask} onChanged={onChanged} />
      <label>
        {t('tasks.fieldTitle')}
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('tasks.description')}
        <textarea rows={4} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <GoalFields goal={goal} acceptance={acceptance} onGoal={setGoal} onAcceptance={setAcceptance} />
      <BlockedByField tasks={tasks} selfId={task.id} value={blockedBy} labels={LABEL} onChange={setBlockedBy} collapsible />
      <label>
        {t('tasks.fieldOwner')}
        <select
          value={task.staffId ?? ''}
          disabled={!!task.sessionId}
          title={task.sessionId ? t('tasks.ownerLocked') : undefined}
          onChange={(e) =>
            void onSave(e.target.value && e.target.value === task.reviewerId ? { staffId: e.target.value, reviewerId: null } : { staffId: e.target.value || null })
          }
        >
          <option value="">{t('tasks.nobody')}</option>
          {byHierarchy(staff).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
      </label>
      <ReviewerField staff={byHierarchy(staff)} ownerId={task.staffId} value={task.reviewerId ?? null} onChange={(reviewerId) => void onSave({ reviewerId })} />
      <label>
        PR
        <input value={pr} placeholder="https://github.com/…/pull/123" onChange={(e) => setPr(e.target.value)} />
      </label>
      {dirty && (
        <p className="actions">
          <button
            className="btn-primary"
            onClick={() =>
              void onSave({
                title,
                description,
                pr: pr || null,
                // Só o que mudou: o servidor confere dependência (existe? faz ciclo?) a cada envio.
                ...(goalChanged && { goal: goal.trim() || null }),
                ...(acceptanceChanged && { acceptance: acceptance.trim() || null }),
                ...(depsChanged && { blockedBy }),
              })
            }
          >
            {t('tasks.save')}
          </button>
        </p>
      )}
      <p className="muted small">
        {task.branch && (
          <>
            <BranchIcon /> {task.branch} ·{' '}
          </>
        )}
        {cost ? t('tasks.costSuffix', { cost }) : t('tasks.noCostYet')}
        {task.pr && (
          <>
            {' · '}
            <a href={task.pr} target="_blank" rel="noreferrer">
              {t('tasks.openPr')}
            </a>
          </>
        )}
      </p>
      {/* Tarefa que nunca começou (criada e parada) não tem conversa: sem custo para mostrar. */}
      {(task.sessionId || task.history.length > 1) && (
        <TaskCostBlock
          projectId={projectId}
          taskId={task.id}
          version={`${task.updatedAt}:${task.runId ?? ''}`}
          nameOf={(id) => (id ? (staff.find((s) => s.id === id)?.name ?? id) : t('tasks.noOwner'))}
        />
      )}
      {task.fallback && (
        <p className="small">
          <TaskFallbackBadge fallback={task.fallback} />
        </p>
      )}
      <PrimaryReturnLine task={task} />
      {fbWait && <p className={waitText}>{fbWait.hint}</p>}
      <AutoInfo task={task} open={task.status === 'review'} />
      <CommitBlock task={task} />
      <PauseNote pause={task.pause} staffName={nameOf(task.staffId)} now={Date.now()} />
      <RetryBadge retry={task.retry} now={Date.now()} withHint />
      <DoubtBlock
        question={task.question}
        requestedBy={task.requestedBy}
        nameOf={(id) => staff.find((s) => s.id === id)?.name ?? null}
        now={Date.now()}
        answer={{ projectId, taskId: task.id, onAnswered: onChanged }}
      />
      <CancelRequestBlock request={task.cancelRequest} staffName={who?.name ?? null} nameOf={nameOf} now={Date.now()} open={!isClosed(task)} />
      {task.status === 'cancelled' && (
        // Uma frase por linha (quem e quando; o motivo; o que a coluna significa), no tamanho de parágrafo do painel.
        <div className="task-cancelled">
          <p>
            {t('tasks.cancelledDetail', {
              name: cancelledWho(task, nameOf),
              when: new Date(task.cancelledAt ?? task.updatedAt).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
            })}
          </p>
          {task.cancelReason && <p>{t('tasks.cancelledWhy', { reason: task.cancelReason })}</p>}
          <p className="muted">{HELP.cancelled}</p>
        </div>
      )}
      {waitingShown.length > 0 && (
        <p className={waitText}>
          {t('tasks.blockedDetail', { names: waitingShown.map(blockerName).join(', ') })}
          {waitingShown.some((o) => o.status === 'cancelled') && ` ${t('tasks.blockedCancelledHint')}`}{' '}
          {queuePos > 0 && (
            <button className="link small" onClick={onUnqueue}>
              {t('tasks.unqueue')}
            </button>
          )}
        </p>
      )}
      {/* A ordem na fila não é aviso: texto padrão, sem o laranja da espera. */}
      {queuePos > 0 && waitingShown.length === 0 && (
        <p className="muted small">
          {t(queueKeys(waitingOn.length > 0, !!busyWith).detail, {
            who: who?.name ?? t('tasks.ownerFallback'),
            pos: queuePos,
            title: busyWith?.title ?? '',
          })}{' '}
          <button className="link small" onClick={onUnqueue}>
            {t('tasks.unqueue')}
          </button>
        </p>
      )}
      {/* Só você muda a ordem da fila de um funcionário pela tela (arrastando o cartão no quadro); ele sugere, e o gestor que pediu o cartão reordena os dele (ver o Histórico). */}
      {moves && (
        <div className="task-order-box">
          <p className="small">{t('tasks.orderLabel', { who: who?.name ?? t('tasks.ownerFallback'), pos: queuePos, total: queueTotal })}</p>
          <p className="muted small">{t('tasks.orderHint', { who: who?.name ?? t('tasks.ownerFallback') })}</p>
        </div>
      )}
      {task.resourceWait && (
        <p className={waitText}>
          {resourceWaitText(task.resourceWait, Date.now())}. {t('tasks.resourceWaitHint')}
        </p>
      )}
      {!!task.held?.length && (
        <p className={waitText}>
          {task.held.length === 1 ? t('tasks.heldMineOne') : t('tasks.heldMineOther', { n: task.held.length })}: {task.held[0]!.reason}.{' '}
          {t('tasks.heldNext')}
        </p>
      )}
      <p className="actions">
        {task.status === 'cancelled' && (
          <button className="btn-primary" onClick={onReopen} title={t('tasks.reopenHint')}>
            {t('tasks.reopen')}
          </button>
        )}
        {!task.sessionId && queuePos === 0 && task.status !== 'cancelled' && (
          <button
            className="btn-primary"
            disabled={!task.staffId}
            onClick={onStart}
            title={
              !task.staffId
                ? t('tasks.pickOwner')
                : waitingOn.length
                  ? t('tasks.startBlockedHint')
                  : busyWith
                    ? t('tasks.startBusyHint', { who: who?.name ?? '', title: busyWith.title })
                    : t('tasks.startHint', { who: who?.name ?? '' })
            }
          >
            {busyWith || waitingOn.length ? t('tasks.enqueue') : t('tasks.start')}
          </button>
        )}
        {task.sessionId && who && (
          <button className="btn-secondary" onClick={onOpen}>
            {t('tasks.openChat', { who: who.name })}
          </button>
        )}
        {task.status === 'review' && (
          <button className="btn-primary" onClick={() => onMove('done')}>
            {t('tasks.approve')}
          </button>
        )}
        {/* A cancelada não muda de coluna: o servidor pede reabrir antes. */}
        {task.status !== 'cancelled' && (
          <select className="task-move" value={columnOf(task.status) ?? ''} onChange={(e) => onMove(e.target.value as TaskStatus)} aria-label={t('tasks.moveTo')}>
            {COLUMNS.map(({ status: s }) => (
              <option key={s} value={s}>
                {t('tasks.moveOption', { status: LABEL[s] })}
              </option>
            ))}
          </select>
        )}
      </p>
      {task.status === 'review' && (
        <ReviewWho
          plan={reviewPlan(task, board)}
          workerName={who?.name ?? t('tasks.ownerFallback')}
          reviewerName={(id) => nameOf(id) ?? id}
          asked={!!task.review}
        />
      )}
      {task.status === 'review' && <ReviewDelegate projectId={projectId} task={task} staff={byHierarchy(staff)} onChanged={onChanged} onOpenStaff={onOpenStaff} />}
      {task.sessionId && (
        <details className="collapse">
          <SectionSummary label={t('tasks.sectionCode')} sum={codeSummary(task, (id) => nameOf(id) ?? id)} />
          <TaskCodePanel projectId={projectId} task={task} staff={staff} onChanged={onChanged} onOpenStaff={onOpenStaff} />
        </details>
      )}
      {task.plan && (
        <details className="collapse">
          <summary>{t('tasks.approvedPlan')}</summary>
          <div className="task-plan">
            <Markdown text={task.plan} />
          </div>
        </details>
      )}
      <details className="collapse">
        <summary>{t('tasks.history')}</summary>
        <ul className="task-history small">
          {[...task.history].reverse().map((h, i) => {
            // Nota de ordem da fila: a frase já diz quem mexeu (você, ou o gestor que pediu o cartão) ou quem sugeriu; "automático" enganaria.
            const order = orderNoteText(h.note, h.by);
            // A volta ao motor principal também vem em pt do servidor: escrita no idioma da tela, com quem a fez (o sistema) na frente.
            const primary = primaryNoteText(h.note);
            return (
              <li key={i}>
                {new Date(h.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {LABEL[h.status]}
                {order ? ` (${order})` : ` (${h.by === 'auto' ? t('tasks.byAuto') : t('tasks.byYou')}${h.note ? `: ${primary ?? h.note})` : ')'}`}
              </li>
            );
          })}
        </ul>
      </details>
      <TaskRuns projectId={projectId} taskId={task.id} version={`${task.updatedAt}:${task.runId ?? ''}`} />
      <p className="actions">
        {!isClosed(task) && (
          <button className="btn-secondary" onClick={onCancel} title={t('tasks.cancelTaskHint')}>
            {t('tasks.cancelTask')}
          </button>
        )}
        <button className="btn-secondary task-delete" onClick={onDelete}>
          {t('tasks.deleteTask')}
        </button>
      </p>
    </aside>
  );
}
