import type { Task, TaskStatus } from '../../../shared/model';
import { t } from '../i18n';

// Dependências da tarefa ("Bloqueada por"): outras tarefas do mesmo projeto que precisam estar prontas antes.
// O servidor recusa id que não existe e ciclo (a mensagem vem no erro de salvar); aqui só se escolhe numa lista.

/** O mesmo teto do servidor (`BlockedBy` em server/tasks.ts). */
export const MAX_DEPS = 20;

type DepTask = Pick<Task, 'id' | 'title' | 'status'>;

/** As dependências de `task` que ainda seguram ela: existem no projeto e não estão prontas (a regra de `blockers`, no servidor). */
export function openBlockers(task: Pick<Task, 'blockedBy'>, tasks: DepTask[]): DepTask[] {
  return (task.blockedBy ?? []).flatMap((id) => tasks.find((o) => o.id === id && o.status !== 'done') ?? []);
}

/** Mesmas tarefas, em qualquer ordem. */
export const sameDeps = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * O que a lista de dependências oferece: `open` = tarefas abertas (qualquer status menos Pronto) de `tasks`, que já vêm do
 * projeto, sem a própria; `old` = vínculos já gravados em `value` que não entram aí (tarefa pronta, ou id que não está neste
 * projeto: `task` null), para continuarem à vista e poderem ser tirados.
 */
export function depChoices(tasks: DepTask[], selfId: string | null, value: string[]) {
  const open = tasks.filter((o) => o.id !== selfId && o.status !== 'done');
  const old = value.filter((id) => id !== selfId && !open.some((o) => o.id === id)).map((id) => ({ id, task: tasks.find((o) => o.id === id) ?? null }));
  return { open, old };
}

/** Lista para marcar as dependências: só tarefas abertas do projeto; vínculos antigos (pronta ou de fora) ficam numa lista à parte, só para tirar. */
export function BlockedByField({
  tasks,
  selfId,
  value,
  labels,
  onChange,
}: {
  /** As tarefas do projeto (a lista já é dele). */
  tasks: DepTask[];
  /** A tarefa que está sendo editada; na criação, null. */
  selfId: string | null;
  value: string[];
  /** Nome de cada status (o quadro já os tem). */
  labels: Record<TaskStatus, string>;
  onChange: (ids: string[]) => void;
}) {
  const { open, old } = depChoices(tasks, selfId, value);
  const full = value.length >= MAX_DEPS;
  const row = (id: string, title: string | null, meta: string, disabled: boolean) => {
    const checked = value.includes(id);
    return (
      <li key={id}>
        <label className="check" title={disabled ? t('tasks.blockedByMax', { n: MAX_DEPS }) : undefined}>
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, id] : value.filter((d) => d !== id))}
          />
          <span className="task-deps-title">{title ?? id}</span>
          <span className="muted small task-deps-meta">
            {title !== null && <span className="task-id">{id}</span>}
            {title !== null && ' · '}
            {meta}
          </span>
        </label>
      </li>
    );
  };
  return (
    <fieldset className="task-deps">
      <legend>{t('tasks.blockedBy')}</legend>
      {open.length === 0 ? (
        <p className="muted small">{t('tasks.blockedByNone')}</p>
      ) : (
        <>
          <p className="muted small">{t('tasks.blockedByHelp')}</p>
          <ul className="task-deps-list">{open.map((o) => row(o.id, o.title, labels[o.status], !value.includes(o.id) && full))}</ul>
        </>
      )}
      {old.length > 0 && (
        <>
          <p className="muted small">{t('tasks.blockedByOld')}</p>
          <ul className="task-deps-list">{old.map(({ id, task }) => row(id, task?.title ?? null, task ? labels[task.status] : t('tasks.blockedByGone'), false))}</ul>
        </>
      )}
    </fieldset>
  );
}

/** Selo do cartão: "Esperando: A, B". Dois nomes à mostra; o resto vira "+N" (o title traz todos, com o id). */
export function BlockedBadge({ blockers }: { blockers: DepTask[] }) {
  if (!blockers.length) return null;
  const names = blockers.slice(0, 2).map((o) => `“${o.title}”`);
  const more = blockers.length - names.length;
  return (
    <span className="task-queue task-blocked small" title={blockers.map((o) => `${o.title} (${o.id})`).join('\n')}>
      {t('tasks.blockedOn', { names: names.join(', ') + (more > 0 ? ` +${more}` : '') })}
    </span>
  );
}
