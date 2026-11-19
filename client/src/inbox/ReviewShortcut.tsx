import { useState } from 'react';
import type { StaffProfile, Task } from '../../../shared/model';
import { t } from '../i18n';
import { ReviewIcon } from '../icons';
import { reviewerChoice } from '../tasks/reviewPick';
import { askReview } from './delegateReview';

// O seletor do atalho "Delegar revisão" da caixa: o do painel do card (tasks/ReviewDelegate), no espaço do item.

interface Props {
  projectId: string;
  task: Task;
  /** Quem pode ser escolhido (ver `reviewShortcutOf`). */
  reviewers: StaffProfile[];
  /** A revisão foi pedida a `name`: quem chama relê a caixa e o quadro. */
  onAsked: (name: string) => void | Promise<void>;
}

export function ReviewShortcutForm({ projectId, task, reviewers, onAsked }: Props) {
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewer = reviewerChoice(reviewers, picked, task.review?.staffId);

  if (!reviewers.length) return <p className="muted small inbox-review-pick">{t('tasks.hireReviewer')}</p>;
  return (
    <div className="inbox-review-pick">
      <div className="inbox-review-row">
        <select value={reviewer} onChange={(e) => setPicked(e.target.value)} aria-label={t('tasks.whoReviews')}>
          {reviewers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.role}
            </option>
          ))}
        </select>
        <button className="btn-secondary btn-with-icon" disabled={busy || !reviewer} onClick={() => void askReview(projectId, task, reviewers, reviewer, { setBusy, setError, onAsked })}>
          <ReviewIcon />
          {busy ? t('tasks.reviewDelegating') : task.review ? t('tasks.reviewDelegateAgain') : t('tasks.reviewDelegate')}
        </button>
      </div>
      <p className="muted small">{t('tasks.reviewDelegateHelp')}</p>
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
