import type { Task, TaskStatus } from '../../../shared/model';
import { t } from '../i18n';

// Dependências da tarefa ("Bloqueada por"): outras tarefas do mesmo projeto que precisam estar prontas antes.
// O servidor recusa id que não existe e ciclo (a mensagem vem no erro de salvar); aqui só se escolhe numa lista.

/** O mesmo teto do servidor (`BlockedBy` em server/tasks.ts). */
export const MAX_DEPS = 20;

type DepTask = Pick<Task, 'id' | 'title' | 'status'> & { archived?: boolean };

/** As dependências de `task` que ainda seguram ela: existem no projeto e não estão prontas (a regra de `blockers`, no servidor). */
export function openBlockers(task: Pick<Task, 'blockedBy'>, tasks: DepTask[]): DepTask[] {
  return (task.blockedBy ?? []).flatMap((id) => tasks.find((o) => o.id === id && o.status !== 'done') ?? []);
}

/** Mesmas tarefas, em qualquer ordem. */
export const sameDeps = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * Lista para marcar as dependências. Não entram a própria tarefa nem as arquivadas (prontas há mais de 7 dias), a menos
 * que já estejam marcadas; as não prontas vêm antes, na ordem em que a lista chegou.
 */
export function BlockedByField({
  tasks,
  selfId,
  value,
  labels,
  onChange,
}: {
  tasks: DepTask[];
  /** A tarefa que está sendo editada; na criação, null. */
  selfId: string | null;
  value: string[];
  /** Nome de cada status (o quadro já os tem). */
  labels: Record<TaskStatus, string>;
  onChange: (ids: string[]) => void;
}) {
  const options = tasks.filter((o) => o.id !== selfId && (!o.archived || value.includes(o.id)));
  const sorted = [...options.filter((o) => o.status !== 'done'), ...options.filter((o) => o.status === 'done')];
  const full = value.length >= MAX_DEPS;
  return (
    <fieldset className="task-deps">
      <legend>{t('tasks.blockedBy')}</legend>
      {sorted.length === 0 ? (
        <p className="muted small">{t('tasks.blockedByNone')}</p>
      ) : (
        <>
          <p className="muted small">{t('tasks.blockedByHelp')}</p>
          <ul className="task-deps-list">
            {sorted.map((o) => {
              const checked = value.includes(o.id);
              return (
                <li key={o.id}>
                  <label className="check" title={!checked && full ? t('tasks.blockedByMax', { n: MAX_DEPS }) : undefined}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((id) => id !== o.id))}
                    />
                    <span className="task-deps-title">{o.title}</span>
                    <span className="muted small task-deps-meta">
                      <span className="task-id">{o.id}</span> · {labels[o.status]}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
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
