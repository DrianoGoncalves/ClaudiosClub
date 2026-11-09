import { useState } from 'react';
import type { StaffProfile, Task } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { t } from '../i18n';
import { ReviewIcon } from '../icons';

// Revisão da entrega pedida a outro funcionário: quem revisa e em que pé está (ReviewStatus) e, em tarefa em
// revisão, o seletor + "Delegar revisão" (ReviewDelegate). Veredito: aprovada vai para Pronto, reprovada volta para quem fez.

interface StatusProps {
  task: Task;
  staff: StaffProfile[];
  onOpenStaff: (staffId: string) => void;
}

/** Quem revisa e se já respondeu (com o veredito, se veio). Nada se não houve pedido. */
export function ReviewStatus({ task, staff, onOpenStaff }: StatusProps) {
  const review = task.review;
  if (!review) return null;
  const name = staff.find((s) => s.id === review.staffId)?.name ?? review.staffId;
  const verdict = review.doneAt ? review.verdict : null;
  return (
    <span className="small">
      {verdict ? t(verdict === 'approved' ? 'tasks.verdictApproved' : 'tasks.verdictRejected', { name }) : `${name} · ${review.doneAt ? t('tasks.replied') : t('tasks.reviewing')}`}
      {' · '}
      <button className="link" onClick={() => onOpenStaff(review.staffId)}>
        {t('tasks.openConversation')}
      </button>
    </span>
  );
}

interface Props extends StatusProps {
  projectId: string;
  /** Algo mudou na tarefa (relê o quadro). */
  onChanged: () => void;
}

export function ReviewDelegate({ projectId, task, staff, onChanged, onOpenStaff }: Props) {
  const reviewers = staff.filter((s) => s.id !== task.staffId);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewing = !!task.review && !task.review.doneAt;
  // Depois de uma resposta o padrão é outro revisor (pode escolher o mesmo).
  const previous = task.review?.staffId;
  const reviewer = reviewers.some((s) => s.id === picked) ? picked : (reviewers.find((s) => s.id !== previous) ?? reviewers[0])?.id ?? '';

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      await withUsageConfirm((force) => api.taskReview(projectId, task.id, reviewer, force));
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-review">
      <div className="task-code-row">
        <b className="small">{t('tasks.reviewLabel')}</b>
        <ReviewStatus task={task} staff={staff} onOpenStaff={onOpenStaff} />
      </div>
      {!reviewing &&
        (reviewers.length ? (
          <>
            <div className="task-code-row">
              <select value={reviewer} onChange={(e) => setPicked(e.target.value)} aria-label={t('tasks.whoReviews')}>
                {reviewers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.role}
                  </option>
                ))}
              </select>
              <button className="btn-secondary btn-with-icon" disabled={busy || !reviewer} onClick={() => void ask()}>
                <ReviewIcon />
                {busy ? t('tasks.reviewDelegating') : task.review ? t('tasks.reviewDelegateAgain') : t('tasks.reviewDelegate')}
              </button>
            </div>
            <p className="muted small">{t('tasks.reviewDelegateHelp')}</p>
          </>
        ) : (
          <span className="muted small">{t('tasks.hireReviewer')}</span>
        ))}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
