import { Fragment, useCallback, useEffect, useState } from 'react';
import { type CostReport, type StaffProfile, type Task as TaskModel, type TaskHandoff, type TaskStatus } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { Markdown } from '../chat/markdown';
import { formatAgo, formatShare } from '../format';
import { t, locale } from '../i18n';
import { BranchIcon, ClockIcon, ReviewIcon } from '../icons';
import { TaskFallbackBadge } from '../staff/FallbackBadge';
import { ReviewDelegate } from './ReviewDelegate';
import { TaskCodePanel } from './TaskCodePanel';

// Quadro de tarefas de um projeto: aguardar → a fazer → fazendo → revisão → pronto.
// Os status são 6 (ver server/tasks.ts); na tela, "planejando" vai em Fazendo.
// Arrastar um cartão muda a coluna; o resto anda sozinho com a conversa da tarefa.

/**
 * Revisão automática (contrato com o servidor): `reviewerId` preenchido = ligada; `reviewRounds` = rodadas já
 * feitas (até REVIEW_ROUNDS_MAX); o veredito vem em `review.verdict`.
 */
type Task = TaskModel & {
  reviewerId?: string | null;
  reviewRounds?: number;
  review?: (TaskHandoff & { verdict?: 'approved' | 'rejected' | null }) | null;
};
type TaskPatch = Parameters<typeof api.updateTask>[2];
const REVIEW_ROUNDS_MAX = 3;

/** Colunas do quadro: o status de quem é soltado nela e os que ela mostra. */
const COLUMNS: { status: TaskStatus; shows: TaskStatus[] }[] = [
  { status: 'waiting', shows: ['waiting'] },
  { status: 'todo', shows: ['todo'] },
  { status: 'doing', shows: ['planning', 'doing'] },
  { status: 'review', shows: ['review'] },
  { status: 'done', shows: ['done'] },
];
/** A coluna em que o status aparece. */
const columnOf = (s: TaskStatus) => COLUMNS.find((c) => c.shows.includes(s))!.status;

/**
 * Ordem dentro da coluna: a última atualização no topo. Plano para aprovar (planejando) vai antes de tudo,
 * porque é o que espera por você; empate de data mantém a ordem que veio do servidor.
 */
export function byRecent<T extends Pick<TaskModel, 'status' | 'updatedAt'>>(tasks: T[]): T[] {
  const at = (t: T) => Date.parse(t.updatedAt) || 0;
  return [...tasks].sort((a, b) => Number(b.status === 'planning') - Number(a.status === 'planning') || at(b) - at(a));
}

/**
 * Ordem de A fazer: a fila primeiro, na ordem em que o servidor começa (a 1ª de cada funcionário antes das 2ªs, em
 * empate a mais antiga), então a próxima a ser feita fica no topo; as fora da fila vêm depois, pela última atualização.
 */
export function byQueue<T extends Pick<TaskModel, 'status' | 'updatedAt' | 'staffId' | 'queuedAt' | 'sessionId'>>(tasks: T[]): T[] {
  const taken = new Map<string | null, number>();
  const rank = new Map<T, number>();
  for (const t of tasks) {
    if (!t.queuedAt || t.sessionId) continue;
    const n = taken.get(t.staffId) ?? 0;
    rank.set(t, n);
    taken.set(t.staffId, n + 1);
  }
  const queued = tasks.filter((t) => rank.has(t)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...queued, ...byRecent(tasks.filter((t) => !rank.has(t)))];
}

const LABEL: Record<TaskStatus, string> = {
  waiting: t('tasks.statusWaiting'),
  todo: t('tasks.statusTodo'),
  planning: t('tasks.statusPlanning'),
  doing: t('tasks.statusDoing'),
  review: t('tasks.statusReview'),
  done: t('tasks.statusDone'),
};

const HELP: Record<TaskStatus, string> = {
  waiting: t('tasks.helpWaiting'),
  todo: t('tasks.helpTodo'),
  planning: t('tasks.helpPlanning'),
  doing: t('tasks.helpDoing'),
  review: t('tasks.helpReview'),
  done: t('tasks.helpDone'),
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
}

export function TasksBoard({ projectId, projectName, staff, costs, onClose, onOpenStaff, onChanged, initialTaskId = null, onOpenSchedules }: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const now = Date.now();

  const load = useCallback(() => {
    api.tasks(projectId).then((t) => setTasks(t ?? []), (e: Error) => setError(e.message));
  }, [projectId]);

  // As tarefas andam sozinhas (plano aprovado, turno terminado): relê de tempos em tempos.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && (selected ? setSelected(null) : onClose());
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, selected]);

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
  const start = (t: Task) => act(() => withUsageConfirm((force) => api.startTask(projectId, t.id, force)));
  const nameOf = (id: string | null) => staff.find((s) => s.id === id)?.name ?? null;
  const costOf = (t: Task) => {
    const usd = t.sessionId ? costs?.projects[projectId]?.sessions[t.sessionId] : undefined;
    return usd !== undefined && costs?.total.usd ? formatShare(usd, costs.total.usd) : null;
  };
  const current = tasks?.find((t) => t.id === selected) ?? null;
  /** O projeto publica? (tem funcionário com servidor ou já teve pedido de deploy): só aí "não publicado" faz sentido. */
  const hasDeploy = staff.some((s) => s.servers.length > 0) || !!tasks?.some((t) => t.deploy);
  /** A tarefa que ocupa o funcionário agora (planejando ou fazendo). */
  const busyWith = (t: Task) =>
    tasks?.find((o) => o.id !== t.id && o.staffId === t.staffId && o.sessionId && (o.status === 'doing' || o.status === 'planning')) ?? null;
  /** Posição na fila dele (1 = a próxima), na ordem do quadro. */
  const queuePos = (t: Task) => (t.queuedAt ? (tasks ?? []).filter((o) => o.staffId === t.staffId && o.queuedAt && !o.sessionId).indexOf(t) + 1 : 0);
  /** Pronto parado há mais de 7 dias (o servidor marca): fora do quadro, atrás do "Ver arquivadas". */
  const archived = (tasks ?? []).filter((t) => t.archived);

  const card = (task: Task) => (
    <Fragment key={task.id}>
      <button
        className={`task-card ${selected === task.id ? 'is-selected' : ''} ${task.archived ? 'is-archived' : ''} ${task.status === 'planning' ? 'is-waiting' : ''}`}
        draggable
        onDragStart={() => setDragging(task.id)}
        onDragEnd={() => setDragging(null)}
        onClick={() => setSelected(task.id)}
      >
        <span className="task-title">{task.title}</span>
        <StatusBadge task={task} hasDeploy={hasDeploy} />
        <VerdictBadge task={task} nameOf={nameOf} />
        <span className="task-meta muted small">
          <span className="task-id" title={t('tasks.idHint')}>
            {task.id}
          </span>{' '}
          · {nameOf(task.staffId) ?? t('tasks.noOwner')}
          {task.requestedBy && ` · ${t('tasks.requestedBy', { name: nameOf(task.requestedBy) ?? task.requestedBy })}`}
          {costOf(task) && ` · ${costOf(task)}`} · {formatAgo(now - Date.parse(task.updatedAt))}
        </span>
        {task.branch && (
          <span className="task-branch small">
            <BranchIcon /> {task.branch}
          </span>
        )}
        {task.reviewerId && (
          <span className="task-reviewer small" title={t('tasks.autoReviewHint', { name: nameOf(task.reviewerId) ?? task.reviewerId })}>
            <ReviewIcon /> {nameOf(task.reviewerId) ?? task.reviewerId}
            {!!task.reviewRounds && ` · ${t('tasks.reviewRounds', { n: task.reviewRounds, max: REVIEW_ROUNDS_MAX })}`}
          </span>
        )}
        {task.fallback && <TaskFallbackBadge fallback={task.fallback} />}
        {queuePos(task) > 0 && (
          <span className="task-queue small" title={t('tasks.queuedHint')}>
            {t('tasks.queuePos', { pos: queuePos(task) })}
          </span>
        )}
        {!!task.held?.length && (
          <span className="task-queue small" title={t('tasks.heldHint')}>
            {t(task.held.length === 1 ? 'tasks.heldOne' : 'tasks.heldOther', { n: task.held.length })}
          </span>
        )}
      </button>
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
          <h2>{t('tasks.title', { name: projectName })}</h2>
          <span className="tasks-head-actions">
            {onOpenSchedules && (
              <button className="btn-secondary btn-with-icon" onClick={onOpenSchedules} title={t('schedules.openTitle')}>
                <ClockIcon /> {t('schedules.open')}
              </button>
            )}
            <button className="btn-primary" onClick={() => setAdding(true)}>
              {t('tasks.newTask')}
            </button>
            <button className="drawer-close in-head" onClick={onClose} aria-label={t('tasks.close')}>
              ×
            </button>
          </span>
        </header>
        {error && <p className="error small">{error}</p>}
        {adding && (
          <TaskForm
            staff={byHierarchy(staff)}
            onCancel={() => setAdding(false)}
            onSave={async (input, andStart) => {
              await act(async () => {
                // Só criar (start false): a tarefa fica em Aguardar.
                const t = await api.createTask(projectId, { ...input, start: andStart });
                if (andStart && t?.staffId) await withUsageConfirm((force) => api.startTask(projectId, t.id, force));
              });
              setAdding(false);
            }}
          />
        )}
        {!tasks ? (
          <p className="muted">{t('tasks.loading')}</p>
        ) : (
          <div className="tasks-columns">
            {COLUMNS.map(({ status, shows }) => {
              const col = (status === 'todo' ? byQueue : byRecent)(tasks.filter((t) => !t.archived && shows.includes(t.status)));
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
                    if (t && columnOf(t.status) !== status) void move(t, status);
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
            cost={costOf(current)}
            onClose={() => setSelected(null)}
            onSave={(patch) => act(() => api.updateTask(projectId, current.id, patch as TaskPatch))}
            onMove={(s) => void move(current, s)}
            onStart={() => void start(current)}
            busyWith={busyWith(current)}
            queuePos={queuePos(current)}
            onUnqueue={() => void act(() => api.updateTask(projectId, current.id, { queued: false }))}
            onOpen={() => current.staffId && onOpenStaff(current.staffId)}
            onDelete={() =>
              window.confirm(t('tasks.confirmDelete', { title: current.title })) &&
              void act(async () => {
                await api.deleteTask(projectId, current.id);
                setSelected(null);
              })
            }
          />
        )}
      </div>
    </div>
  );
}

/** Selo do cartão: plano esperando você (Fazendo) e, em Pronto, se ainda falta o deploy (projeto que publica). */
function StatusBadge({ task, hasDeploy }: { task: Task; hasDeploy: boolean }) {
  if (task.status === 'planning')
    return (
      <span className="task-badge is-waiting" title={HELP.planning}>
        {t('tasks.badgePlan')}
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

/** Veredito da revisão (aprovada/reprovada por quem revisou), quando houver. */
function VerdictBadge({ task, nameOf }: { task: Task; nameOf: (id: string | null) => string | null }) {
  const verdict = task.review?.verdict;
  if (!verdict) return null;
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
      <label className="check" title={options.length ? t('tasks.autoReviewHelp') : t('tasks.autoReviewNobody')}>
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

function TaskForm({
  staff,
  onSave,
  onCancel,
}: {
  staff: StaffProfile[];
  onSave: (input: { title: string; description: string; staffId: string | null; reviewerId: string | null }, andStart: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [staffId, setStaffId] = useState<string>(staff[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (andStart: boolean) => {
    if (!title.trim()) return;
    setBusy(true);
    await onSave({ title: title.trim(), description: description.trim(), staffId: staffId || null, reviewerId }, andStart);
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
  cost,
  onClose,
  onSave,
  onMove,
  onStart,
  busyWith,
  queuePos,
  onUnqueue,
  onOpen,
  onDelete,
  onChanged,
  onOpenStaff,
}: {
  projectId: string;
  task: Task;
  staff: StaffProfile[];
  cost: string | null;
  onChanged: () => void;
  onOpenStaff: (staffId: string) => void;
  onClose: () => void;
  onSave: (patch: Partial<Pick<Task, 'title' | 'description' | 'staffId' | 'pr' | 'branch' | 'reviewerId'>>) => Promise<void>;
  onMove: (s: TaskStatus) => void;
  onStart: () => void;
  /** A tarefa em que o responsável está agora (aí "Começar" põe na fila). */
  busyWith: Task | null;
  queuePos: number;
  onUnqueue: () => void;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [pr, setPr] = useState(task.pr ?? '');
  const dirty = title !== task.title || description !== task.description || pr !== (task.pr ?? '');
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
      <label>
        {t('tasks.fieldTitle')}
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('tasks.description')}
        <textarea rows={4} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} />
      </label>
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
          <button className="btn-primary" onClick={() => void onSave({ title, description, pr: pr || null })}>
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
      {task.fallback && (
        <p className="small">
          <TaskFallbackBadge fallback={task.fallback} />
        </p>
      )}
      {queuePos > 0 && (
        <p className="muted small">
          {busyWith
            ? t('tasks.queueBusy', { who: who?.name ?? t('tasks.ownerFallback'), pos: queuePos, title: busyWith.title })
            : t('tasks.queueFree', { who: who?.name ?? t('tasks.ownerFallback'), pos: queuePos })}{' '}
          <button className="link small" onClick={onUnqueue}>
            {t('tasks.unqueue')}
          </button>
        </p>
      )}
      {!!task.held?.length && (
        <p className="muted small">
          {task.held.length === 1 ? t('tasks.heldMineOne') : t('tasks.heldMineOther', { n: task.held.length })}: {task.held[0]!.reason}.{' '}
          {t('tasks.heldNext')}
        </p>
      )}
      <p className="actions">
        {!task.sessionId && queuePos === 0 && (
          <button
            className="btn-primary"
            disabled={!task.staffId}
            onClick={onStart}
            title={
              !task.staffId
                ? t('tasks.pickOwner')
                : busyWith
                  ? t('tasks.startBusyHint', { who: who?.name ?? '', title: busyWith.title })
                  : t('tasks.startHint', { who: who?.name ?? '' })
            }
          >
            {busyWith ? t('tasks.enqueue') : t('tasks.start')}
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
        <select className="task-move" value={columnOf(task.status)} onChange={(e) => onMove(e.target.value as TaskStatus)} aria-label={t('tasks.moveTo')}>
          {COLUMNS.map(({ status: s }) => (
            <option key={s} value={s}>
              {t('tasks.moveOption', { status: LABEL[s] })}
            </option>
          ))}
        </select>
      </p>
      {task.status === 'review' && <ReviewDelegate projectId={projectId} task={task} staff={byHierarchy(staff)} onChanged={onChanged} onOpenStaff={onOpenStaff} />}
      {task.sessionId && (
        <details className="collapse" open={task.status === 'review' || task.status === 'done'}>
          <summary>{t('tasks.sectionCode')}</summary>
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
          {[...task.history].reverse().map((h, i) => (
            <li key={i}>
              {new Date(h.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {LABEL[h.status]}
              {' ('}
              {h.by === 'auto' ? t('tasks.byAuto') : t('tasks.byYou')}
              {h.note ? `: ${h.note})` : ')'}
            </li>
          ))}
        </ul>
      </details>
      <p className="actions">
        <button className="btn-secondary task-delete" onClick={onDelete}>
          {t('tasks.deleteTask')}
        </button>
      </p>
    </aside>
  );
}
