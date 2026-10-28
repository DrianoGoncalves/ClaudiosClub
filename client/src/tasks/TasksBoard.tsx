import { useCallback, useEffect, useState } from 'react';
import { TASK_STATUSES, type CostReport, type StaffProfile, type Task, type TaskStatus, type TaskSummary } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { Markdown } from '../chat/markdown';
import { formatAgo, formatShare } from '../format';
import { BranchIcon } from '../icons';
import { TaskCodePanel } from './TaskCodePanel';

// Quadro de tarefas de um projeto: a fazer → planejando → fazendo → revisão → pronto → no ar.
// Arrastar um cartão muda a coluna; o resto anda sozinho com a conversa da tarefa (ver server/tasks.ts).

const LABEL: Record<TaskStatus, string> = {
  todo: 'A fazer',
  planning: 'Planejando',
  doing: 'Fazendo',
  review: 'Revisão',
  done: 'Pronto',
  live: 'No ar',
};

const HELP: Record<TaskStatus, string> = {
  todo: 'Ainda não começou. As que estão na fila começam sozinhas, uma por vez, quando o funcionário entrega a atual.',
  planning: 'Ele está montando o plano; você aprova no cartão de plano do chat.',
  doing: 'Trabalhando. Quando o turno terminar, vai para revisão.',
  review: 'Ele terminou um turno: confira a entrega. Responder na conversa traz de volta para "fazendo".',
  done: 'Entregue e conferido.',
  live: 'Publicado (deploy feito).',
};

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
      <div className="modal tasks-modal" role="dialog" aria-label={`Tarefas de ${projectName}`}>
        <header className="tasks-head">
          <h2>Tarefas · {projectName}</h2>
          {lastDeploy && (
            <span className="muted small tasks-last-deploy" title={`Último deploy: ${new Date(lastDeploy.at).toLocaleString('pt-BR')}`}>
              último deploy {formatAgo(now - Date.parse(lastDeploy.at))}: {lastDeploy.title}
              {lastDeploy.by && ` (por ${staff.find((s) => s.id === lastDeploy.by)?.name ?? lastDeploy.by})`}
            </span>
          )}
          <span className="tasks-head-actions">
            <button className="btn-primary" onClick={() => setAdding(true)}>
              Nova tarefa
            </button>
            <button className="btn-secondary" onClick={onClose} aria-label="Fechar">
              Fechar
            </button>
          </span>
        </header>
        {error && <p className="error small">{error}</p>}
        {adding && (
          <TaskForm
            staff={staff}
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
          <p className="muted">Carregando…</p>
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
                  {col.map((t) => (
                    <button
                      key={t.id}
                      className={`task-card ${selected === t.id ? 'is-selected' : ''}`}
                      draggable
                      onDragStart={() => setDragging(t.id)}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => setSelected(t.id)}
                    >
                      <span className="task-title">{t.title}</span>
                      <span className="task-meta muted small">
                        {nameOf(t.staffId) ?? 'sem responsável'}
                        {t.requestedBy && ` · pedida por ${nameOf(t.requestedBy) ?? t.requestedBy}`}
                        {costOf(t) && ` · ${costOf(t)}`} · {formatAgo(now - Date.parse(t.updatedAt))}
                      </span>
                      {t.branch && (
                        <span className="task-branch small">
                          <BranchIcon /> {t.branch}
                        </span>
                      )}
                      {queuePos(t) > 0 && (
                        <span className="task-queue small" title="Começa sozinha quando ele entregar a atual">
                          na fila · {queuePos(t)}ª
                        </span>
                      )}
                      {!!t.held?.length && (
                        <span className="task-queue small" title="Suas mensagens vão quando ele terminar a tarefa em que está">
                          {t.held.length} {t.held.length === 1 ? 'ajuste esperando' : 'ajustes esperando'}
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
              window.confirm(`Apagar a tarefa "${current.title}"? A conversa dela continua no funcionário.`) &&
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
        Título
        <input value={title} maxLength={120} autoFocus placeholder="Botão de exportar CSV no relatório" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        O que precisa ser feito
        <textarea rows={3} value={description} maxLength={8000} placeholder="Contexto, critérios de pronto, links…" onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Quem cuida
        <select value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">ninguém por enquanto</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
      </label>
      <p className="actions">
        <button type="submit" className="btn-primary" disabled={busy || !title.trim() || !staffId} title="Cria e já manda para ele, numa conversa nova (ocupado com outra tarefa, entra na fila dele)">
          Criar e começar
        </button>
        <button type="button" className="btn-secondary" disabled={busy || !title.trim()} onClick={() => void submit(false)}>
          Só criar
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          Cancelar
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
        <button className="btn-secondary" onClick={onClose} aria-label="Fechar detalhes">
          ×
        </button>
      </header>
      <label>
        Título
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Descrição
        <textarea rows={4} value={description} maxLength={8000} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label>
        Quem cuida
        <select
          value={task.staffId ?? ''}
          disabled={!!task.sessionId}
          title={task.sessionId ? 'A tarefa já começou com este funcionário' : undefined}
          onChange={(e) => void onSave({ staffId: e.target.value || null })}
        >
          <option value="">ninguém</option>
          {staff.map((s) => (
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
            Salvar
          </button>
        </p>
      )}
      <p className="muted small">
        {task.branch && (
          <>
            <BranchIcon /> {task.branch} ·{' '}
          </>
        )}
        {cost ? `${cost} do consumo` : 'sem consumo ainda'}
        {task.pr && (
          <>
            {' · '}
            <a href={task.pr} target="_blank" rel="noreferrer">
              abrir o PR
            </a>
          </>
        )}
      </p>
      {queuePos > 0 && (
        <p className="muted small">
          Na fila de {who?.name ?? 'quem cuida'} ({queuePos}ª){busyWith ? `: começa quando ele entregar “${busyWith.title}”.` : ': começa assim que ele ficar livre.'}{' '}
          <button className="link small" onClick={onUnqueue}>
            tirar da fila
          </button>
        </p>
      )}
      {!!task.held?.length && (
        <p className="muted small">
          {task.held.length === 1 ? 'Um ajuste seu está guardado' : `${task.held.length} ajustes seus estão guardados`}: {task.held[0]!.reason}. Vai antes da próxima da fila.
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
                ? 'Escolha quem cuida'
                : busyWith
                  ? `${who?.name} está em “${busyWith.title}”: entra na fila e começa quando ele entregar`
                  : `Manda para ${who?.name}, numa conversa nova`
            }
          >
            {busyWith ? 'Pôr na fila' : 'Começar'}
          </button>
        )}
        {task.sessionId && who && (
          <button className="btn-secondary" onClick={onOpen}>
            Abrir a conversa com {who.name}
          </button>
        )}
        {task.status === 'review' && (
          <button className="btn-primary" onClick={() => onMove('done')}>
            Aprovar entrega
          </button>
        )}
        {task.status === 'done' && (
          <button className="btn-secondary" onClick={() => onMove('live')}>
            Marcar no ar
          </button>
        )}
        <select className="task-move" value={task.status} onChange={(e) => onMove(e.target.value as TaskStatus)} aria-label="Mover para a coluna">
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              mover: {LABEL[s]}
            </option>
          ))}
        </select>
      </p>
      {task.sessionId && (
        <details className="collapse" open={task.status === 'review' || task.status === 'done'}>
          <summary>Código, revisão e deploy</summary>
          <TaskCodePanel projectId={projectId} task={task} staff={staff} onChanged={onChanged} onOpenStaff={onOpenStaff} />
        </details>
      )}
      {task.plan && (
        <details className="collapse">
          <summary>Plano aprovado</summary>
          <div className="task-plan">
            <Markdown text={task.plan} />
          </div>
        </details>
      )}
      <details className="collapse">
        <summary>Histórico</summary>
        <ul className="task-history small">
          {[...task.history].reverse().map((h, i) => (
            <li key={i}>
              {new Date(h.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {LABEL[h.status]}
              {h.by === 'auto' ? ' (automático' : ' (você'}
              {h.note ? `: ${h.note})` : ')'}
            </li>
          ))}
        </ul>
      </details>
      <p className="actions">
        <button className="btn-secondary task-delete" onClick={onDelete}>
          Apagar tarefa
        </button>
      </p>
    </aside>
  );
}
