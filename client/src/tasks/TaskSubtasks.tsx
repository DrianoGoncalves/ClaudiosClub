import { isClosed, type Task, type TaskStatus, type TaskSubtaskRef } from '../../../shared/model';
import { t } from '../i18n';

// Subtarefas: o card que delegou pela conversa dele (`Task.subtasks`, derivado no servidor) e o vínculo de volta (`Task.parentTaskId`).
// Enquanto alguma está aberta, o card não vai para revisão e não prende o funcionário (`Task.awaitingSubtasks`, só existe nesse caso).
// O cartão do quadro é um botão: o selo de dentro é só texto; os links ficam numa linha fora dele (como a ordem da fila) e no detalhe.

type Labels = Record<TaskStatus, string>;
type ParentTask = Pick<Task, 'id' | 'title' | 'status'>;

/** As subtarefas do card que seguem abertas (nem prontas nem canceladas, a mesma conta do servidor). */
export const openSubtasks = (task: Pick<Task, 'subtasks'>): TaskSubtaskRef[] => (task.subtasks ?? []).filter((s) => !isClosed(s));

/** O card aguarda subtarefa? Só em Fazendo e com alguma aberta (o servidor já tira a marca quando todas fecham; aqui só se confere). */
export const awaitsSubtasks = (task: Pick<Task, 'awaitingSubtasks' | 'subtasks' | 'status'>): boolean =>
  !!task.awaitingSubtasks && task.status === 'doing' && openSubtasks(task).length > 0;

/** O card de que a tarefa é subtarefa: id sempre; título e status só se ele ainda está no quadro (apagado: `task` null). Sem vínculo: null. */
export function parentOf(task: Pick<Task, 'parentTaskId'>, tasks: ParentTask[]): { id: string; task: ParentTask | null } | null {
  if (!task.parentTaskId) return null;
  return { id: task.parentTaskId, task: tasks.find((o) => o.id === task.parentTaskId) ?? null };
}

/** "Aguardando 2 subtarefas": o texto do selo (n = abertas). */
export const awaitText = (open: number): string => t(open === 1 ? 'tasks.subsAwaitOne' : 'tasks.subsAwaitOther', { n: open });

/** "Subtarefa de “Título”": o texto do selo; o card que saiu do quadro vira o id. */
export const parentText = (parent: { id: string; task: ParentTask | null }): string =>
  parent.task ? t('tasks.subOf', { title: parent.task.title }) : t('tasks.subOfGone', { id: parent.id });

/** Selo dentro do cartão (texto, sem link): aguardando subtarefas ou subtarefa de um card. Os dois podem valer juntos (subtarefa que também delegou). */
export function SubtaskBadges({ task, tasks, nameOf }: { task: Task; tasks: ParentTask[]; nameOf: (id: string | null) => string | null }) {
  const open = awaitsSubtasks(task) ? openSubtasks(task).length : 0;
  const parent = parentOf(task, tasks);
  if (!open && !parent) return null;
  return (
    <>
      {open > 0 && (
        <span className="task-queue task-subs small" title={t('tasks.subsAwaitHint', { name: nameOf(task.staffId) ?? t('tasks.pauseStaffFallback') })}>
          {awaitText(open)}
        </span>
      )}
      {parent && (
        <span className="task-queue task-subs small" title={parent.task ? t('tasks.subOfHint', { title: parent.task.title }) : undefined}>
          {parentText(parent)}
        </span>
      )}
    </>
  );
}

/** Um link para a tarefa: título e status entre parênteses curtos. */
function Link({ id, title, status, labels, onOpen }: { id: string; title: string | null; status: TaskStatus | null; labels: Labels; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="link small" onClick={() => onOpen(id)}>
        {title ?? id}
      </button>
      <span className="muted small task-subs-status">{status ? labels[status] : t('tasks.subOfGoneStatus')}</span>
    </li>
  );
}

/**
 * Os links do cartão, fora do botão dele: cada subtarefa aberta (título e status) no card que aguarda, e o card de origem na subtarefa. Só aparece
 * quando o selo de dentro aparece (`awaitsSubtasks` / `parentTaskId`).
 */
export function SubtaskRow({ task, tasks, labels, onOpen }: { task: Task; tasks: ParentTask[]; labels: Labels; onOpen: (id: string) => void }) {
  const open = awaitsSubtasks(task) ? openSubtasks(task) : [];
  const parent = parentOf(task, tasks);
  if (!open.length && !parent) return null;
  return (
    <ul className="task-subs-row">
      {open.map((s) => (
        <Link key={s.id} id={s.id} title={s.title} status={s.status} labels={labels} onOpen={onOpen} />
      ))}
      {parent && <Link id={parent.id} title={parent.task?.title ?? null} status={parent.task?.status ?? null} labels={labels} onOpen={onOpen} />}
    </ul>
  );
}

/**
 * Bloco do detalhe: no card, a lista de TODAS as subtarefas (as fechadas também) com a regra que segura o card; na subtarefa, de qual card ela é. Sem nada
 * disso, nada.
 */
export function SubtaskBlock({
  task,
  tasks,
  labels,
  staffName,
  onOpen,
}: {
  task: Task;
  tasks: ParentTask[];
  labels: Labels;
  staffName: string | null;
  onOpen: (id: string) => void;
}) {
  const subs = task.subtasks ?? [];
  const open = openSubtasks(task).length;
  const parent = parentOf(task, tasks);
  if (!subs.length && !parent) return null;
  return (
    <div className="task-subs-box">
      {subs.length > 0 && (
        <>
          <p className="small">
            <b>{awaitsSubtasks(task) ? awaitText(open) : t('tasks.subsTitle')}</b>
            {' · '}
            {t('tasks.subsOpenOf', { open, total: subs.length })}
          </p>
          {awaitsSubtasks(task) && <p className="muted small">{t('tasks.subsAwaitHint', { name: staffName ?? t('tasks.pauseStaffFallback') })}</p>}
          <ul className="task-subs-row">
            {subs.map((s) => (
              <Link key={s.id} id={s.id} title={s.title} status={s.status} labels={labels} onOpen={onOpen} />
            ))}
          </ul>
        </>
      )}
      {parent && (
        <>
          <p className="small">
            <b>{t('tasks.subOfTitle')}</b>
          </p>
          <ul className="task-subs-row">
            <Link id={parent.id} title={parent.task?.title ?? null} status={parent.task?.status ?? null} labels={labels} onOpen={onOpen} />
          </ul>
          {parent.task && <p className="muted small">{t('tasks.subOfHint', { title: parent.task.title })}</p>}
        </>
      )}
    </div>
  );
}
