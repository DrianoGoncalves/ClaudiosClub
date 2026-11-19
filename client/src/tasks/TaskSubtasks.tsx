import type { HTMLAttributes, ReactNode } from 'react';
import { isClosed, type Task, type TaskStatus, type TaskSubtaskRef } from '../../../shared/model';
import { t } from '../i18n';

// Subtarefas: o card que delegou pela conversa dele (`Task.subtasks`, derivado no servidor) e o vínculo de volta (`Task.parentTaskId`).
// Enquanto alguma está aberta, o card não vai para revisão e não prende o funcionário (`Task.awaitingSubtasks`, só existe nesse caso).
// O cartão do quadro é um botão: o selo de dentro é só texto; os links ficam numa bandeja colada embaixo dele (fora do botão, mas na mesma pilha, ligada
// ao cartão por uma linha em árvore) e no detalhe.

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

/** Selo dentro do cartão (texto, sem link): aguardando subtarefas. O vínculo de volta (subtarefa de um card) fica na bandeja, não aqui, para não repetir o título. */
export function SubtaskBadges({ task, nameOf }: { task: Task; nameOf: (id: string | null) => string | null }) {
  const open = awaitsSubtasks(task) ? openSubtasks(task).length : 0;
  if (!open) return null;
  return (
    <span className="task-queue task-subs small" title={t('tasks.subsAwaitHint', { name: nameOf(task.staffId) ?? t('tasks.pauseStaffFallback') })}>
      {awaitText(open)}
    </span>
  );
}

/** Um link para a tarefa e o status dela num selo (o texto do link é o título, ou o que o chamador passar). */
function Link({ id, text, status, labels, onOpen }: { id: string; text: string; status: TaskStatus | null; labels: Labels; onOpen: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="link small" onClick={() => onOpen(id)}>
        {text}
      </button>
      <span className="task-badge task-subs-status">{status ? labels[status] : t('tasks.subOfGoneStatus')}</span>
    </li>
  );
}

/**
 * A bandeja do cartão, colada embaixo dele e fora do botão: o card de origem na subtarefa e cada subtarefa aberta no card que aguarda (título e status),
 * ligados ao cartão por uma linha em árvore. Só existe quando há o que mostrar (`awaitsSubtasks` / `parentTaskId`).
 */
export function SubtaskRow({ task, tasks, labels, onOpen }: { task: Task; tasks: ParentTask[]; labels: Labels; onOpen: (id: string) => void }) {
  const open = awaitsSubtasks(task) ? openSubtasks(task) : [];
  const parent = parentOf(task, tasks);
  if (!open.length && !parent) return null;
  return (
    <ul className="task-subs-row task-subs-tray">
      {parent && <Link id={parent.id} text={parentText(parent)} status={parent.task?.status ?? null} labels={labels} onOpen={onOpen} />}
      {open.map((s) => (
        <Link key={s.id} id={s.id} text={s.title} status={s.status} labels={labels} onOpen={onOpen} />
      ))}
    </ul>
  );
}

type StackDrag = Pick<HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;

/**
 * O cartão e a bandeja dele numa pilha só: é a pilha que carrega o contorno de selecionado e de destino do arrasto, e que recebe o arrasto (a bandeja conta
 * como parte do cartão). O elemento em volta do cartão é SEMPRE o mesmo `div` (só a classe muda: `task-stack` com bandeja): se ele sumisse ou trocasse de
 * tipo quando a bandeja aparece ou some (o quadro relê a cada 5 s), o React desmontaria o cartão e o foco do teclado se perderia.
 */
export function SubtaskStack({
  task,
  tasks,
  labels,
  onOpen,
  children,
  ...drag
}: { task: Task; tasks: ParentTask[]; labels: Labels; onOpen: (id: string) => void; children: ReactNode } & StackDrag) {
  const tray = awaitsSubtasks(task) || !!parentOf(task, tasks);
  return (
    <div className={tray ? 'task-stack' : 'task-slot'} {...drag}>
      {children}
      <SubtaskRow task={task} tasks={tasks} labels={labels} onOpen={onOpen} />
    </div>
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
              <Link key={s.id} id={s.id} text={s.title} status={s.status} labels={labels} onOpen={onOpen} />
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
            <Link id={parent.id} text={parent.task?.title ?? parent.id} status={parent.task?.status ?? null} labels={labels} onOpen={onOpen} />
          </ul>
          {parent.task && <p className="muted small">{t('tasks.subOfHint', { title: parent.task.title })}</p>}
        </>
      )}
    </div>
  );
}
