import { CHANGED_FILES_MAX, type Task } from '../../../shared/model';
import { t } from '../i18n';

// Card criado sozinho pelo Claudio’s Club (`Task.autoCreated`): uma conversa alterou código do projeto sem tarefa. O cartão leva um selo
// discreto, e o detalhe, a lista dos arquivos que a conversa alterou (`Task.changedFiles`).

/** Selo do cartão. Nada em tarefa comum. */
export function AutoBadge({ task }: { task: Pick<Task, 'autoCreated'> }) {
  if (!task.autoCreated) return null;
  return (
    <span className="task-queue task-auto small" title={t('tasks.autoBadgeHint')}>
      {t('tasks.autoBadge')}
    </span>
  );
}

/** Detalhe: de onde o card veio e os arquivos alterados. `open`: lista aberta (quando é hora de decidir). */
export function AutoInfo({ task, open }: { task: Pick<Task, 'autoCreated' | 'changedFiles'>; open: boolean }) {
  if (!task.autoCreated) return null;
  const files = task.changedFiles ?? [];
  return (
    <>
      <p className="muted small">{t('tasks.autoNote')}</p>
      <details className="collapse" open={open}>
        <summary>{t('tasks.changedFiles', { n: files.length })}</summary>
        {files.length ? (
          <ul className="task-files task-auto-files small">
            {files.map((f) => (
              <li key={f}>
                <span className="mono">{f}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{t('tasks.changedFilesNone')}</p>
        )}
        {files.length >= CHANGED_FILES_MAX && <p className="muted small">{t('tasks.changedFilesCut', { max: CHANGED_FILES_MAX })}</p>}
      </details>
    </>
  );
}
