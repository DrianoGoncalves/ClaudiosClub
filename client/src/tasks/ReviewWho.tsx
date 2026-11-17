import { AUTO_REVIEW_ROUNDS } from '../../../shared/model';
import { t } from '../i18n';
import { fellToOwner, type ReviewPlan } from './reviewRule';

// Quem revisa a tarefa em "revisão", dito na tela. O dono aparece em amarelo ("precisa de mim"): é ele quem aprova ou reprova.

/** Selo do cartão: só quando a regra mandou a revisão para o dono (o responsável do quadro fez a tarefa, ou as rodadas acabaram). */
export function OwnerBadge({ plan }: { plan: ReviewPlan }) {
  if (!fellToOwner(plan)) return null;
  return (
    <span className="task-badge is-waiting small" title={t(plan.why === 'self' ? 'tasks.ownerReviewHintSelf' : 'tasks.ownerReviewHintCap', { n: AUTO_REVIEW_ROUNDS })}>
      {t('tasks.ownerReviewBadge')}
    </span>
  );
}

interface Props {
  plan: ReviewPlan;
  /** Quem fez a tarefa. */
  workerName: string;
  reviewerName: (id: string) => string;
  /** A revisão já foi pedida (o `ReviewDelegate` mostra quem e o veredito): a linha "quem vai revisar" fica de fora. */
  asked: boolean;
}

/** Detalhe, acima do pedido de revisão: com o dono, a caixa amarela; com um funcionário que ainda vai revisar, uma linha. */
export function ReviewWho({ plan, workerName, reviewerName, asked }: Props) {
  if (fellToOwner(plan))
    return (
      <div className="task-owner-box" role="note">
        <p>{t(plan.why === 'self' ? 'tasks.ownerReviewSelf' : 'tasks.ownerReviewCap', { name: workerName, n: AUTO_REVIEW_ROUNDS })}</p>
        <p className="muted small">{t('tasks.ownerReviewHow')}</p>
      </div>
    );
  if (plan.kind === 'staff' && plan.from !== 'asked' && !asked)
    return <p className="muted small">{t(plan.from === 'board' ? 'tasks.reviewWhoBoard' : 'tasks.reviewWhoTask', { name: reviewerName(plan.id) })}</p>;
  return null;
}
