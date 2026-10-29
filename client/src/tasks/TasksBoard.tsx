import { useCallback, useEffect, useState } from 'react';
import { TASK_STATUSES, type CostReport, type StaffProfile, type Task, type TaskStatus, type TaskSummary } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { Markdown } from '../chat/markdown';
import { formatAgo, formatShare } from '../format';
import { t, locale } from '../i18n';
import { BranchIcon } from '../icons';
import { TaskCodePanel } from './TaskCodePanel';

// Quadro de tarefas de um projeto: a fazer → planejando → fazendo → revisão → pronto → no ar.
// Arrastar um cartão muda a coluna; o resto anda sozinho com a conversa da tarefa (ver server/tasks.ts).

const LABEL: Record<TaskStatus, string> = {
  todo: t('tasks.statusTodo'),
  planning: t('tasks.statusPlanning'),
  doing: t('tasks.statusDoing'),
  review: t('tasks.statusReview'),
  done: t('tasks.statusDone'),
  live: t('tasks.statusLive'),
};

const HELP: Record<TaskStatus, string> = {
  todo: t('tasks.helpTodo'),
  planning: t('tasks.helpPlanning'),
  doing: t('tasks.helpDoing'),
  review: t('tasks.helpReview'),
  done: t('tasks.helpDone'),
  live: t('tasks.helpLive'),
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
  /** A última tarefa que foi para "no ar". */
  lastDeploy: TaskSummary['lastDeploy'];
  /** Abre com esta tarefa selecionada (Ctrl+K). */
  initialTaskId?: string | null;
}

export function TasksBoard({ projectId, projectName, staff, costs, onClose, onOpenStaff, onChanged, lastDeploy, initialTaskId = null }: Props) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialTaskId);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
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
  /** A tarefa que ocupa o funcionário agora (planejando ou fazendo). */
  const busyWith = (t: Task) =>
    tasks?.find((o) => o.id !== t.id && o.staffId === t.staffId && o.sessionId && (o.status === 'doing' || o.status === 'planning')) ?? null;
  /** Posição na fila dele (1 = a próxima), na ordem do quadro. */
  const queuePos = (t: Task) => (t.queuedAt ? (tasks ?? []).filter((o) => o.staffId === t.staffId && o.queuedAt && !o.sessionId).indexOf(t) + 1 : 0);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal tasks-modal" role="dialog" aria-label={t('tasks.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('tasks.title', { name: projectName })}</h2>
          {lastDeploy && (
            <span className="muted small tasks-last-deploy" title={t('tasks.lastDeployTitle', { at: new Date(lastDeploy.at).toLocaleString(locale()) })}>
              {t('tasks.lastDeploy', { ago: formatAgo(now - Date.parse(lastDeploy.at)), title: lastDeploy.title })}
              {lastDeploy.by && ` (${t('tasks.byWho', { name: staff.find((s) => s.id === lastDeploy.by)?.name ?? lastDeploy.by })})`}
            </span>
          )}
          <span className="tasks-head-actions">
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
                const t = await api.createTask(projectId, input);
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
            {TASK_STATUSES.map((status) => {
              const col = tasks.filter((t) => t.status === status);
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
                    if (t) void move(t, status);
                    setDragging(null);
                  }}
                >
                  <h3 title={HELP[status]}>
                    {LABEL[status]} <span className="muted">{col.length || ''}</span>
                  </h3>
                  {col.map((task) => (
                    <button
                      key={task.id}
                      className={`task-card ${selected === task.id ? 'is-selected' : ''}`}
                      draggable
                      onDragStart={() => setDragging(task.id)}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => setSelected(task.id)}
                    >
                      <span className="task-title">{task.title}</span>
                      <span className="task-meta muted small">
                        {nameOf(task.staffId) ?? t('tasks.noOwner')}
                        {task.requestedBy && ` · ${t('tasks.requestedBy', { name: nameOf(task.requestedBy) ?? task.requestedBy })}`}
                        {costOf(task) && ` · ${costOf(task)}`} · {formatAgo(now - Date.parse(task.updatedAt))}
                      </span>
                      {task.branch && (
                        <span className="task-branch small">
                          <BranchIcon /> {task.branch}
                        </span>
                      )}
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
                  ))}
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
            onSave={(patch) => act(() => api.updateTask(projectId, current.id, patch))}
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

function TaskForm({
  staff,
  onSave,
  onCancel,
}: {
  staff: StaffProfile[];
  onSave: (input: { title: string; description: string; staffId: string | null }, andStart: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [staffId, setStaffId] = useState<string>(staff[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const submit = async (andStart: boolean) => {
    if (!title.trim()) return;
    setBusy(true);
    await onSave({ title: title.trim(), description: description.trim(), staffId: staffId || null }, andStart);
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
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">{t('tasks.nobodyYet')}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
      </label>
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
  onSave: (patch: Partial<Pick<Task, 'title' | 'description' | 'staffId' | 'pr' | 'branch'>>) => Promise<void>;
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
        <span className="kicker">{LABEL[task.status]}</span>
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
          onChange={(e) => void onSave({ staffId: e.target.value || null })}
        >
          <option value="">{t('tasks.nobody')}</option>
          {byHierarchy(staff).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
      </label>
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
        {task.status === 'done' && (
          <button className="btn-secondary" onClick={() => onMove('live')}>
            {t('tasks.markLive')}
          </button>
        )}
        <select className="task-move" value={task.status} onChange={(e) => onMove(e.target.value as TaskStatus)} aria-label={t('tasks.moveTo')}>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t('tasks.moveOption', { status: LABEL[s] })}
            </option>
          ))}
        </select>
      </p>
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
