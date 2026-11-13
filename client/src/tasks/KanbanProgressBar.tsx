import { progressPercent, progressTotal } from '../../../shared/kanbanProgress';
import type { TaskProgress } from '../../../shared/model';
import { t } from '../i18n';

/** Barra fina do progresso do kanban (o servidor manda `progress` no summary de tarefas); sem progresso não desenha nada. */
export function KanbanProgressBar({ progress, open }: { progress: TaskProgress | null | undefined; open: number }) {
  if (!progress) return null;
  const percent = progressPercent(progress);
  const text = t(open === 1 ? 'board.progressOne' : 'board.progressOther', { percent, open, total: progressTotal(progress) });
  return (
    <div
      className="bn-progress"
      role="progressbar"
      aria-label={t('board.progressLabel')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={text}
      title={text}
    >
      <span className="bn-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
