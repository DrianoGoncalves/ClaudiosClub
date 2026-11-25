import { Fragment, useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { AUTO_REVIEW_ROUNDS, isClosed, type BoardConfig, type CostReport, type InboxItem, type ProjectPause, type StaffProfile, type StaffQueue, type Task as TaskModel, type TaskCreateResult, type TaskCreateWarning, type TaskHandoff, type TaskStatus } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { pollVisible } from '../usePoll';
import { Markdown } from '../chat/markdown';
import { formatAgo, formatShare } from '../format';
import { t, locale } from '../i18n';
import { BranchIcon, ClockIcon, UserIcon } from '../icons';
import { PrimaryReturnBadge, PrimaryReturnLine, TaskFallbackBadge } from '../staff/FallbackBadge';
import { AutoBadge, AutoInfo } from './AutoCard';
import { BoardReview, useBoardCommit, useBoardReview, useBoardWriter, useFlowCompletion } from './BoardReview';
import { CommitBadge, CommitBlock } from './TaskCommit';
import { FallbackWaitBadge, fallbackWaitText } from './FallbackWait';
import { ReviewDelegate, ReviewStatus } from './ReviewDelegate';
import { byHierarchy } from './reviewPick';
import { fellToOwner, reviewPlan } from './reviewRule';
import { OwnerBadge, ReviewWho } from './ReviewWho';
import { ReviewerChip } from './ReviewerChip';
import { ownerAsks, footerPlan, type AskCard } from './detailActions';
import { NeedsYouStrip, TaskDetailFooter } from './TaskDetailParts';
import { GrowTextarea } from './GrowTextarea';
import { useKeyboardInset } from './useKeyboardInset';
import { TaskCodePanel } from './TaskCodePanel';
import { DoubtBadge, DoubtBlock } from './TaskDoubt';
import { PauseNote, pauseText } from './TaskPause';
import { PausedBanner, PauseButton, useProjectPause } from './ProjectPauseBar';
import { ReleaseBanner, ReleaseDialog, useRelease } from './ReleaseDialog';
import { CiBadge } from './CiBadge';
import { isVersionPause } from './pauseState';
import { QueueDots, useQueues } from './QueueStrip';
import { queueDots } from './queueState';
import { RetryBadge, retryText } from './TaskRetry';
import { SubtaskBadges, SubtaskBlock, SubtaskStack } from './TaskSubtasks';
import { ResourceWaitBadge, resourceWaitHint, resourceWaitText, slotHolder } from './ResourceWait';
import { BlockedBadge, BlockedByField, blockerName, openBlockers, sameDeps, shownBlockers } from './TaskDeps';
import { waitClass, waitWarm } from './waitTone';
import { dependentRows, type DepMap, type DepMode } from './cancelDeps';
import { cancelledWho, duplicateWarnings } from './cancelRequest';
import { CancelRequestBadge, CancelRequestBlock, DuplicateNote } from './TaskCancelRequest';
import { planPending, planSessions } from './planPending';
import { PermissionGo, PermissionWaitBadge, PermissionWaitBlock, permissionTarget, permissionText, type PermissionText } from './PermissionWait';
import { FollowUpBadge, FollowUpBlock } from './TaskFollowUps';
import { followUpsOf } from './followUp';
import { chatFollowUpIds, conversationItemFor, verdictShown } from './followUpNotice';
import { giveBackBody, giveBackHeldNote, noCodeOf } from './noCode';
import { NoCodeBadge, NoCodeBlock } from './TaskNoCode';
import { TaskCloseDialog } from './TaskCloseDialog';
import { TaskCostBlock } from './TaskCostBlock';
import { SectionSummary } from './SectionSummary';
import { codeSummary } from './codeSummary';
import { primaryNoteText } from './primaryReturn';
import { dropAfter, dropPosition, orderMoves, orderNoteText, queuePosOf, queueSize, stepOfKey, type OrderBody, type OrderMoves } from './queueOrder';
import { TaskRuns } from './TaskRuns';
import { askConfirm } from '../lib/dialogStore';
import { Skeleton } from '../lib/Skeleton';
import { cardTone } from '../inbox/alertTone';
import { NeedsYouBadge } from '../inbox/NeedsYouBadge';
import { taskWaitNeeds } from '../inbox/needsYou';

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

export { byHierarchy };

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
  /** Só para teste, como `initialPause`: o estado das filas de partida; sem ele o quadro o lê do servidor. */
  initialQueues?: StaffQueue[] | null;
  /** A caixa "precisa de mim" (useInbox): o selo "Plano para aprovar" só vale com um item `plan` da conversa da tarefa. Sem ela, nenhuma tarefa tem plano esperando. */
  inboxItems?: InboxItem[];
  /** Abre a conversa de um aviso da caixa, já no cartão dele (o atalho "Responder no chat" do pedido de permissão). Sem ela, o quadro só mostra o selo. */
  onOpenInbox?: (item: InboxItem) => void;
}

const NO_ITEMS: InboxItem[] = [];
/** Quantos cartões um grupo longo mostra por vez (ver `limited`). */
export const LIST_STEP = 40;
/** Projeto sem quadro (`null` do servidor): sempre a mesma lista vazia, para o polling não redesenhar à toa. */
const NO_TASKS: Task[] = [];
/** De quanto em quanto tempo o quadro se redesenha sozinho (o "há X min" e as contagens dos selos), já que o polling estável não redesenha nada quando a lista não muda. */
const CLOCK_MS = 30_000;

export function TasksBoard({ projectId, projectName, staff, costs, onClose, onOpenStaff, onChanged, initialTaskId = null, onOpenSchedules, initialTasks, initialPause, initialQueues, inboxItems = NO_ITEMS, onOpenInbox }: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(initialTasks ?? null);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** O que acabou de ser salvo ("detail:<id>" no detalhe, "wait:<id>" no motivo do cartão em Aguardar): mostra "Salvo" por 2,5 s. */
  const [saved, setSaved] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  /** O cartão da fila sobre o qual se arrasta outro da mesma fila, e de que lado dele o arrastado entra (`after`: abaixo). */
  const [overCard, setOverCard] = useState<{ id: string; after: boolean } | null>(null);
  /** Funcionário cujas tarefas estão à mostra em todas as colunas ('' = todos). Só filtra a vista: a ordem e os passos da fila seguem os do servidor. */
  const [staffFilter, setStaffFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  /** Quantos cartões cada grupo longo mostra (ver `limited`), por grupo; sem entrada, LIST_STEP. */
  const [limits, setLimits] = useState<Record<string, number>>({});
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
  const flowCompletion = useFlowCompletion(projectId);
  const boardWriter = useBoardWriter(projectId);
  const projectPause = useProjectPause(projectId, projectName, onChanged, initialPause);
  /** A versão com escopo (ver ReleaseDialog): a faixa lê de 15 em 15 s; a página abre por cima do quadro. */
  const [release, setRelease] = useRelease(projectId);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const queues = useQueues(projectId, initialQueues);
  // O relógio do quadro: sem ele, com a leitura estável, "há 3 min" e as contagens dos selos congelavam enquanto nada mudasse. Só força o
  // redesenho: a hora é lida a cada render (depois de uma ação, "agora" é agora mesmo, não a hora do último tique).
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setClock((n) => n + 1), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();

  const load = useCallback(() => {
    // A lista igual à anterior chega como o mesmo objeto (leitura estável, ver api.ts): o React não redesenha os cartões.
    api.tasks(projectId).then((t) => setTasks(t ?? NO_TASKS), (e: Error) => setError(e.message));
  }, [projectId]);

  // As tarefas andam sozinhas (plano aprovado, turno terminado): relê de tempos em tempos.
  useEffect(() => {
    load();
    return pollVisible(load, 5000);
  }, [load]);

  useEffect(() => {
    // Com o diálogo de cancelar/apagar (ou a página da versão) aberto, o Esc é dele (fecha só o diálogo).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !closing && !releaseOpen && (selected ? setSelected(null) : onClose());
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, selected, closing, releaseOpen]);

  // O erro de uma tarefa não segue para a próxima.
  useEffect(() => setError(null), [selected]);

  // A tarefa do diálogo sumiu (apagada aqui ou em outra aba): o diálogo fecha.
  useEffect(() => {
    if (closing && tasks && !tasks.some((x) => x.id === closing.id)) setClosing(null);
  }, [closing, tasks]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(null), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  /** Troca no quadro a tarefa de mesmo id (a mudança otimista, ou a de antes para desfazer); as outras ficam como estão. */
  const putTask = (next: Task) => setTasks((cur) => (cur ? cur.map((x) => (x.id === next.id ? next : x)) : cur));

  /**
   * Roda a ação e relê o quadro; devolve se deu certo (o erro vai para `error`). Com `optimistic`, o cartão muda na tela antes da resposta (o
   * arrasto não espera o servidor) e volta como era se a ação falhar. A releitura depois da resposta traz o que o servidor decidiu de fato ("Fazendo"
   * com o funcionário ocupado vira fila) e o resto que a ação mexeu (posições da fila, dependentes). A Task da resposta não entra direto: ela vem
   * sem os campos que a listagem calcula (posição na fila, arquivada, permissão), e o cartão piscaria até a releitura.
   */
  const act = async (fn: () => Promise<unknown>, optimistic?: { before: Task; after: Task }) => {
    setError(null);
    if (optimistic) putTask(optimistic.after);
    try {
      await fn();
      load();
      onChanged();
      return true;
    } catch (e) {
      // Desfaz só se o cartão ainda é o da mudança otimista: uma releitura ou outro arrasto depois dela já mostra o estado mais novo.
      if (optimistic) setTasks((cur) => (cur ? cur.map((x) => (x === optimistic.after ? optimistic.before : x)) : cur));
      setError((e as Error).message);
      return false;
    }
  };
  const saveAs = async (key: string, fn: () => Promise<unknown>) => {
    if (await act(fn)) setSaved(key);
  };

  // Mudar de coluna atualiza o `updatedAt`, e o arquivamento é derivado dele (pronta há mais de 7 dias): o cartão otimista já sai do arquivo.
  const move = (t: Task, status: TaskStatus) =>
    t.status !== status &&
    act(() => api.updateTask(projectId, t.id, { status }), { before: t, after: { ...t, status, updatedAt: new Date().toISOString(), archived: false, archivedAt: undefined } });
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
  const inView = (t: Task) => !staffFilter || t.staffId === staffFilter;
  const archived = (tasks ?? []).filter((t) => t.archived && inView(t));
  /** Canceladas: fora das colunas, no grupo recolhido de Pronto. Nunca contam como prontas. */
  const cancelled = (tasks ?? []).filter((t) => t.status === 'cancelled' && inView(t));
  /** Quem aparece no seletor: quem tem tarefa no quadro (mais o escolhido, que pode ter esvaziado). */
  const filterOwners = staff.filter((s) => s.id === staffFilter || !!tasks?.some((t) => t.staffId === s.id));
  /** As bolinhas de quem está ocupado em Fazendo e Revisão (o filtro por funcionário vale para elas). */
  const dots = queueDots(queues, tasks, (id) => nameOf(id), (id) => tasks?.find((x) => x.id === id)?.title ?? id, now, staffFilter, (id) => slotHolder(tasks?.find((x) => x.id === id)?.resourceWait, tasks ?? [], LABEL));
  /** Quem revisa o cartão: o revisor apontado na tarefa; em Revisão, também o do quadro ou o que já recebeu o pedido (`reviewPlan`). Com o dono decidindo, só o apontado (quem reprovou). */
  const cardReviewer = (t: Task): string | null => {
    if (t.reviewerId) return t.reviewerId;
    if (t.status !== 'review') return null;
    const p = reviewPlan(t, boardReview.config);
    return p.kind === 'staff' ? p.id : null;
  };
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
        <span className="task-id muted small" title={t('tasks.idHint')}>
          {task.id}
        </span>
        <span className="task-title">{task.title}</span>
        <NeedsYouBadge needs={taskWaitNeeds(task)} />
        <PermissionWaitBadge text={permissionOf(task)} />
        <DoubtBadge question={task.question} requestedBy={task.requestedBy} nameOf={nameOf} warm={waitWarm(task.status)} />
        <CancelRequestBadge request={task.cancelRequest} nameOf={nameOf} />
        <PauseNote pause={task.pause} staffName={nameOf(task.staffId)} now={now} />
        <SubtaskBadges task={task} nameOf={nameOf} />
        <span className="task-meta muted small">
          <span className="task-owner" title={t('tasks.ownerHint')}>
            <UserIcon /> {nameOf(task.staffId) ?? t('tasks.noOwner')}
          </span>
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
        {cardReviewer(task) && (
          <span className="task-reviewer small" title={t('tasks.autoReviewHint', { name: nameOf(cardReviewer(task)) ?? cardReviewer(task)! })}>
            <span className="task-reviewer-name">{nameOf(cardReviewer(task)) ?? cardReviewer(task)}</span>
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
        <ResourceWaitBadge wait={task.resourceWait} now={now} warm={waitWarm(task.status)} holder={slotHolder(task.resourceWait, tasks ?? [], LABEL)} onOpen={setSelected} />
        <RetryBadge retry={task.retry} now={now} />
        {!!task.held?.length && (
          <span className={`task-queue${waitClass(waitWarm(task.status))} small`} title={t('tasks.heldHint')}>
            {t(task.held.length === 1 ? 'tasks.heldOne' : 'tasks.heldOther', { n: task.held.length })}
          </span>
        )}
        {/* Selos de situação (plano, sem código, veredito, revisor, follow-up, commit): no fim do cartão, depois de quem revisa. */}
        <StatusBadge task={task} hasDeploy={hasDeploy} planWaiting={awaitingPlan(task)} />
        <NoCodeBadge task={task} />
        <VerdictBadge task={task} nameOf={nameOf} />
        {task.status === 'review' && <OwnerBadge plan={reviewPlan(task, boardReview.config)} />}
        <FollowUpBadge task={task} />
        <CommitBadge task={task} />
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
            if (next !== (task.waitReason ?? null)) void saveAs(`wait:${task.id}`, () => api.updateTask(projectId, task.id, { waitReason: next }));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
      {task.status === 'waiting' && saved === `wait:${task.id}` && (
        <span className="save-ok" role="status">
          ✓ {t('tasks.saved')}
        </span>
      )}
    </Fragment>
  );

  /**
   * Os grupos longos (Pronto, arquivadas, canceladas) mostram os LIST_STEP primeiros (já na ordem de mais recente) e um "Mostrar mais": o quadro
   * chegava a ~300 cartões de uma vez, cada um com dezenas de selos. O contador da coluna continua com o total. As outras colunas ficam inteiras:
   * são curtas, e nelas um cartão ativo escondido seria trabalho em andamento sumindo da tela ("A fazer" ainda tem a ordem da fila, que se arrasta).
   */
  const limited = (key: string, list: Task[]) => {
    const max = limits[key] ?? LIST_STEP;
    const rest = list.length - max;
    return (
      <>
        {list.slice(0, max).map(card)}
        {rest > 0 && (
          <button className="link small tasks-archived-toggle" onClick={() => setLimits((l) => ({ ...l, [key]: max + LIST_STEP }))}>
            {t('tasks.showMore', { n: Math.min(LIST_STEP, rest), rest })}
          </button>
        )}
      </>
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tasks-modal" role="dialog" aria-label={t('tasks.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <div className="tasks-head-title">
            <h2>{t('tasks.title', { name: projectName })}</h2>
            {projectPause.pause !== undefined && (
              <PauseButton paused={projectPause.pause !== null} busy={projectPause.busy} onClick={projectPause.toggle} version={isVersionPause(projectPause.pause)} />
            )}
          </div>
          <span className="tasks-head-actions">
            <button className="btn-secondary release-open-btn" onClick={() => setReleaseOpen(true)} title={t('release.openTitle')}>
              {t('release.open')}
            </button>
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
        <ReleaseBanner view={release} onOpen={() => setReleaseOpen(true)} />
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
        <BoardReview review={boardReview} commit={boardCommit} writer={boardWriter} flow={flowCompletion} staff={byHierarchy(staff)} />
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
          <Skeleton label={t('tasks.loading')} variant="columns" />
        ) : (
          <>
          {filterOwners.length > 0 && (
            <div className="tasks-filter">
              <select className="tasks-staff-filter" value={staffFilter} onChange={(e) => setStaffFilter(e.target.value)} aria-label={t('tasks.queueFilter')} title={t('tasks.queueFilter')}>
                <option value="">{t('tasks.queueFilterAll')}</option>
                {byHierarchy(filterOwners).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="tasks-columns">
            {COLUMNS.map(({ status, shows }) => {
              const shown = tasks.filter((t) => !t.archived && shows.includes(t.status) && inView(t));
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
                  <div className="tasks-col-head">
                    <h3 title={HELP[status]}>
                      {LABEL[status]} <span className="muted">{col.length || ''}</span>
                    </h3>
                    {/* Quem está ocupado agora (Fazendo: executando ou fila travada; Revisão: revisando); o texto de cada um só no hover. */}
                    {(status === 'doing' || status === 'review') && <QueueDots dots={dots.filter((d) => d.column === status)} staff={staff} projectId={projectId} onOpenTask={setSelected} />}
                  </div>
                  {status === 'done' ? limited('done', col) : col.map(card)}
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
                      {showArchived && limited('archived', byRecent(archived))}
                    </>
                  )}
                  {/* Canceladas: o mesmo grupo recolhido das arquivadas, no fim de Pronto (fechou sem entrega, então não é "pronta"). */}
                  {status === 'done' && cancelled.length > 0 && (
                    <>
                      <button className="link small tasks-archived-toggle" aria-expanded={showCancelled} title={HELP.cancelled} onClick={() => setShowCancelled((v) => !v)}>
                        {showCancelled ? t('tasks.hideCancelled') : t('tasks.showCancelled', { n: cancelled.length })}
                      </button>
                      {showCancelled && limited('cancelled', byRecent(cancelled))}
                    </>
                  )}
                </section>
              );
            })}
          </div>
          </>
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
            onSave={(patch) => saveAs(`detail:${current.id}`, () => api.updateTask(projectId, current.id, patch as TaskPatch))}
            saved={saved === `detail:${current.id}`}
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
            planWaiting={awaitingPlan(current)}
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
        {releaseOpen && (
          <ReleaseDialog
            projectId={projectId}
            projectName={projectName}
            staff={byHierarchy(staff)}
            tasks={tasks ?? []}
            onClose={() => setReleaseOpen(false)}
            onChanged={(v) => {
              setRelease(v);
              load();
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
      <span className={`task-badge ${cardTone('owner')}`} title={HELP.planning}>
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
    <span className={`task-badge small ${cardTone(verdict === 'approved' ? 'approved' : 'rejected')}`}>
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
        <GrowTextarea rows={3} value={acceptance} maxLength={ACCEPTANCE_MAX} placeholder={t('tasks.acceptancePlaceholder')} onChange={(e) => onAcceptance(e.target.value)} />
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
  saved,
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
  planWaiting,
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
  /** Acabou de salvar com sucesso: mostra "Salvo" no lugar do botão (que some quando não há mais nada a salvar). */
  saved: boolean;
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
  /** Há plano esperando a sua aprovação na conversa da tarefa (item `plan` da caixa): a ação principal do rodapé leva a ela. */
  planWaiting: boolean;
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
  const waitText = `task-note${waitWarm(task.status) ? ' tone-wait' : ''}`;
  const now = Date.now();
  const fbWait = fallbackWaitText(task.fallbackBlocked, now);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [pr, setPr] = useState(task.pr ?? '');
  const [goal, setGoal] = useState(task.goal ?? '');
  const [acceptance, setAcceptance] = useState(task.acceptance ?? '');
  const [blockedBy, setBlockedBy] = useState(task.blockedBy ?? []);
  /** Modo leitura é o padrão: os campos abrem com "Editar" (o corpo do painel é para ler e decidir). */
  const [editing, setEditing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Teclado virtual aberto: o painel sobe o tanto que ele cobre, para o rodapé não ficar atrás dele. */
  const keyboard = useKeyboardInset();
  const goalChanged = goal.trim() !== (task.goal ?? '');
  const acceptanceChanged = acceptance.trim() !== (task.acceptance ?? '');
  const depsChanged = !sameDeps(blockedBy, task.blockedBy ?? []);
  const dirty = title !== task.title || description !== task.description || pr !== (task.pr ?? '') || goalChanged || acceptanceChanged || depsChanged;
  const who = staff.find((s) => s.id === task.staffId);
  const saveEdits = () =>
    void onSave({
      title,
      description,
      pr: pr || null,
      // Só o que mudou: o servidor confere dependência (existe? faz ciclo?) a cada envio.
      ...(goalChanged && { goal: goal.trim() || null }),
      ...(acceptanceChanged && { acceptance: acceptance.trim() || null }),
      ...(depsChanged && { blockedBy }),
    });
  /** Fecha a edição jogando fora o que não foi salvo (o que ficou escondido em campo fechado enganaria). */
  const closeEdit = () => {
    setTitle(task.title);
    setDescription(task.description);
    setPr(task.pr ?? '');
    setGoal(task.goal ?? '');
    setAcceptance(task.acceptance ?? '');
    setBlockedBy(task.blockedBy ?? []);
    setEditing(false);
  };

  const plan = reviewPlan(task, board);
  const asks = ownerAsks({ task, hasPermission: !!permission, plan });
  const foot = footerPlan({ task, asks, queuePos, canOpenPermission: !!onOpenPermission, hasChat: !!(task.sessionId && who), planWaiting });
  /** Rola o corpo até o cartão do pedido e põe o foco nele (o leitor de tela anuncia onde chegou). */
  const goTo = (card: AskCard) => {
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-card="${card}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  };
  const reviewerName = plan.kind === 'staff' ? (nameOf(plan.id) ?? plan.id) : t('tasks.headReviewerYou');
  const showReview = task.status === 'review' && (!!task.review || plan.kind === 'staff' || fellToOwner(plan));
  const pause = pauseText(task.pause, nameOf(task.staffId), now);
  const retry = retryText(task.retry, now);
  const ownerName = who?.name ?? t('tasks.ownerFallback');
  /** Os avisos de espera e fila (um por texto): o corpo da seção recolhida e a linha de resumo dela. */
  const blockedLine =
    waitingShown.length > 0 ? `${t('tasks.blockedDetail', { names: waitingShown.map(blockerName).join(', ') })}${waitingShown.some((o) => o.status === 'cancelled') ? ` ${t('tasks.blockedCancelledHint')}` : ''}` : null;
  const queueLine = queuePos > 0 && waitingShown.length === 0 ? t(queueKeys(waitingOn.length > 0, !!busyWith).detail, { who: ownerName, pos: queuePos, title: busyWith?.title ?? '' }) : null;
  const orderLine = moves ? t('tasks.orderLabel', { who: ownerName, pos: queuePos, total: queueTotal }) : null;
  /** A espera pela vaga de escrita (`resourceWait.holder`) leva o card que ocupa, com link; a de recursos segue com o texto do servidor. */
  const slotOwner = slotHolder(task.resourceWait, tasks, LABEL);
  const resourceHead = task.resourceWait ? resourceWaitText(task.resourceWait, now, slotOwner) : null;
  const resourceLine = resourceHead ? `${resourceHead}. ${resourceWaitHint(slotOwner)}` : null;
  const heldLine = task.held?.length
    ? `${task.held.length === 1 ? t('tasks.heldMineOne') : t('tasks.heldMineOther', { n: task.held.length })}: ${task.held[0]!.reason}. ${t('tasks.heldNext')}`
    : null;
  const waitHeads = [pause?.head, retry?.head, blockedLine, queueLine, orderLine, resourceHead, heldLine, fbWait?.hint].filter((x): x is string => !!x);
  const waitSum = waitHeads.length > 1 ? `${waitHeads[0]} (+${waitHeads.length - 1})` : (waitHeads[0] ?? '');
  const startLabel = busyWith || waitingOn.length ? t('tasks.enqueue') : t('tasks.start');
  const startTitle = !task.staffId
    ? t('tasks.pickOwner')
    : waitingOn.length
      ? t('tasks.startBlockedHint')
      : busyWith
        ? t('tasks.startBusyHint', { who: who?.name ?? '', title: busyWith.title })
        : t('tasks.startHint', { who: who?.name ?? '' });
  /** O cartão de um pedido: o `data-card` é o alvo do atalho da faixa e do rodapé. */
  const slot = (card: AskCard | 'cancelreq', body: ReactNode) => (
    <div className="task-card-slot" data-card={card} tabIndex={-1}>
      {body}
    </div>
  );
  return (
    <aside className="task-detail" style={keyboard ? { bottom: keyboard } : undefined}>
      <header className="task-detail-head">
        <span className="task-id muted small" title={t('tasks.idHint')}>
          {task.id}
        </span>
        <div className="task-detail-top">
          <h3 className="task-detail-title">{task.title}</h3>
          <button className="drawer-close in-head" onClick={onClose} aria-label={t('tasks.closeDetails')}>
            ×
          </button>
        </div>
        <span className="kicker" title={task.archived ? t('tasks.archivedHint') : undefined}>
          {LABEL[task.status]}
          {task.archived && ` · ${t('tasks.archivedTag')}`}
        </span>
        <p className="task-detail-who muted small">
          {t('tasks.headOwner', { name: who?.name ?? t('tasks.nobody') })} · {t('tasks.headReviewer', { name: reviewerName })}
        </p>
      </header>
      <div className="task-detail-body" ref={bodyRef}>
        {/* Gruda no topo ao rolar: o botão que falhou (Salvar, Apagar) pode estar longe daqui. */}
        {error && (
          <p className="error small task-detail-error" role="alert">
            {error}
          </p>
        )}
        <NeedsYouStrip asks={asks} onGo={goTo} />
        {showReview && (
          <section className="task-review-box" data-card="review" tabIndex={-1} aria-label={t('tasks.reviewLabel')}>
            {plan.kind === 'staff' && (
              <div className="task-review-who small">
                <ReviewerChip id={plan.id} staff={staff} projectId={projectId} />
              </div>
            )}
            <ReviewWho plan={plan} workerName={ownerName} reviewerName={(id) => nameOf(id) ?? id} asked={!!task.review} />
            {task.review && (
              <div className="task-code-row">
                <b className="small">{t('tasks.reviewLabel')}</b>
                <ReviewStatus task={task} staff={staff} onOpenStaff={onOpenStaff} />
              </div>
            )}
          </section>
        )}
        {/* Os cartões de pedido, na ordem do que mais trava: a decisão de cada um fica no próprio cartão (resposta, follow-up) ou no rodapé fixo. */}
        {task.question &&
          slot(
            'doubt',
            <DoubtBlock
              question={task.question}
              requestedBy={task.requestedBy}
              nameOf={(id) => staff.find((s) => s.id === id)?.name ?? null}
              now={now}
              answer={{ projectId, taskId: task.id, onAnswered: onChanged }}
            />,
          )}
        {permission && slot('permission', <PermissionWaitBlock text={permission} />)}
        {followUpsOf(task).length > 0 &&
          slot(
            'followup',
            <FollowUpBlock task={task} tasks={tasks} team={staff} nameOf={nameOf} now={now} projectId={projectId} chatIds={chatFollowUps} onOpenChat={onOpenChat} onOpenTask={onOpenTask} onChanged={onChanged} />,
          )}
        {noCodeOf(task) && slot('nocode', <NoCodeBlock task={task} nameOf={nameOf} note={giveBackNote} />)}
        {task.cancelRequest && slot('cancelreq', <CancelRequestBlock request={task.cancelRequest} staffName={who?.name ?? null} nameOf={nameOf} now={now} open={!isClosed(task)} />)}
        {/* Explica por que o card está parado em Fazendo e leva à subtarefa (ou ao card de origem); no celular o detalhe cobre o quadro. */}
        <SubtaskBlock task={task} tasks={tasks} labels={LABEL} staffName={who?.name ?? null} onOpen={onOpenTask} />
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
        <section className="task-read" aria-label={t('tasks.sectionTask')}>
          <div className="task-read-head">
            <b>{t('tasks.sectionTask')}</b>
            <button type="button" className="link task-edit-btn" aria-expanded={editing} onClick={editing ? closeEdit : () => setEditing(true)}>
              {editing ? (dirty ? t('tasks.editDiscard') : t('tasks.editClose')) : t('tasks.edit')}
            </button>
          </div>
          {editing ? (
            <div className="task-edit">
              <label>
                {t('tasks.fieldTitle')}
                <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label>
                {t('tasks.description')}
                <GrowTextarea rows={4} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} />
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
              <p className="actions">
                <button className={dirty ? 'btn-primary' : 'btn-secondary'} disabled={!dirty} onClick={saveEdits}>
                  {t('tasks.save')}
                </button>
                {!dirty && saved && (
                  <span className="save-ok" role="status">
                    ✓ {t('tasks.saved')}
                  </span>
                )}
              </p>
            </div>
          ) : (
            <>
              <div className="task-accept">
                <b className="small">{t('tasks.fieldAcceptance')}</b>
                {task.acceptance ? (
                  <div className="task-read-text">
                    <Markdown text={task.acceptance} />
                  </div>
                ) : (
                  <p className="muted small">{t('tasks.acceptanceNone')}</p>
                )}
              </div>
              {task.description && (
                <details className="collapse">
                  <summary>{t('tasks.description')}</summary>
                  <div className="task-read-text">
                    <Markdown text={task.description} />
                  </div>
                </details>
              )}
              {task.goal && (
                <details className="collapse">
                  <summary>{t('tasks.fieldGoal')}</summary>
                  <div className="task-read-text">
                    <Markdown text={task.goal} />
                  </div>
                </details>
              )}
            </>
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
          {/* O CI do PR do cartão: lido só com o detalhe aberto (e de minuto em minuto enquanto roda), nunca no quadro todo. */}
          {task.pr && /^https:\/\/github\.com\/.+\/pull\/\d+/.test(task.pr) && <CiBadge k={`task:${projectId}:${task.id}:${task.pr}`} load={() => api.taskCi(projectId, task.id)} />}
        </section>
        {task.fallback && (
          <p className="small">
            <TaskFallbackBadge fallback={task.fallback} />
          </p>
        )}
        <PrimaryReturnLine task={task} />
        <AutoInfo task={task} open={task.status === 'review'} />
        {/* Recolhidos: o que se consulta, não o que se decide. */}
        {task.sessionId && (
          <details className="collapse">
            <SectionSummary label={t('tasks.sectionCode')} sum={codeSummary(task, (id) => nameOf(id) ?? id)} />
            <CommitBlock task={task} />
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
        {/* Tarefa que nunca começou (criada e parada) não tem conversa: sem custo para mostrar. */}
        {(task.sessionId || task.history.length > 1) && (
          <TaskCostBlock
            projectId={projectId}
            taskId={task.id}
            version={`${task.updatedAt}:${task.runId ?? ''}`}
            nameOf={(id) => (id ? (staff.find((s) => s.id === id)?.name ?? id) : t('tasks.noOwner'))}
          />
        )}
        {waitHeads.length > 0 && (
          // Em Aguardar e A fazer o porquê de a tarefa não andar é o que o dono veio ler: a seção já abre.
          <details className="collapse" open={task.status === 'waiting' || task.status === 'todo'}>
            <SectionSummary label={t('tasks.sectionWaits')} sum={waitSum} />
            <div className="task-waits">
              <PauseNote pause={task.pause} staffName={nameOf(task.staffId)} now={now} />
              <RetryBadge retry={task.retry} now={now} withHint />
              {fbWait && <p className={waitText}>{fbWait.hint}</p>}
              {blockedLine && <p className={waitText}>{blockedLine}</p>}
              {/* A ordem na fila não é aviso: texto padrão, sem o laranja da espera. */}
              {queueLine && <p className="task-note">{queueLine}</p>}
              {/* Só você muda a ordem da fila de um funcionário pela tela (arrastando o cartão no quadro); ele sugere, e o gestor que pediu o cartão reordena os dele (ver o Histórico). */}
              {moves && (
                <div className="task-order-box">
                  <p className="small">{orderLine}</p>
                  <p className="muted small">{t('tasks.orderHint', { who: ownerName })}</p>
                </div>
              )}
              {resourceLine && (
                <p className={waitText}>
                  {resourceLine}
                  {slotOwner?.title != null && (
                    <>
                      {' '}
                      <button type="button" className="link small" onClick={() => onOpenTask(slotOwner.id)}>
                        {t('tasks.slotWaitOpen', { id: slotOwner.id })}
                      </button>
                    </>
                  )}
                </p>
              )}
              {heldLine && <p className={waitText}>{heldLine}</p>}
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
      </div>
      <TaskDetailFooter
        plan={foot}
        columns={COLUMNS.map(({ status: s }) => ({ status: s, label: t('tasks.moveOption', { status: LABEL[s] }) }))}
        column={columnOf(task.status)}
        start={{ label: startLabel, title: startTitle, disabledReason: task.staffId ? null : t('tasks.pickOwner') }}
        givingBack={givingBack}
        chatLabel={who ? t('tasks.openChat', { who: who.name }) : null}
        delegate={<ReviewDelegate bare projectId={projectId} task={task} staff={byHierarchy(staff)} onChanged={onChanged} onOpenStaff={onOpenStaff} />}
        delegateLabel={task.review ? t('tasks.reviewDelegateAgain') : t('tasks.reviewDelegate')}
        onStart={onStart}
        onReopen={onReopen}
        onApprove={() => onMove('done')}
        onGoPermission={() => onOpenPermission?.()}
        onGoCard={goTo}
        onGiveBack={onGiveBack}
        onOpenChat={onOpen}
        onUnqueue={onUnqueue}
        onMove={onMove}
        onCancel={onCancel}
        onDelete={onDelete}
      />
    </aside>
  );
}
