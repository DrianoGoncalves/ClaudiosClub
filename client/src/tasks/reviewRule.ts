import { AUTO_REVIEW_ROUNDS, type BoardConfig, type Task } from '../../../shared/model';

// Quem revisa a tarefa que está em "revisão" (a regra do quadro, ver `BoardConfig` em shared/model.ts): o revisor apontado na tarefa;
// senão o responsável do quadro (com a revisão automática ligada), a não ser que ele tenha feito a tarefa; sem ninguém, ou quando as
// rodadas acabam, é o dono. Só descreve na tela: quem decide é o servidor.

export type ReviewPlan =
  /** Um funcionário revisa: `asked` = o pedido já está feito, `task` = apontado na tarefa, `board` = responsável do quadro. */
  | { kind: 'staff'; id: string; from: 'asked' | 'task' | 'board' }
  /** O dono aprova ou reprova: `off` = ninguém revisa sozinho, `self` = o responsável fez a tarefa, `cap` = o limite de rodadas acabou. */
  | { kind: 'owner'; why: 'off' | 'self' | 'cap' };

export function reviewPlan(task: Pick<Task, 'staffId' | 'reviewerId' | 'reviewRounds' | 'review'>, board: BoardConfig | null): ReviewPlan {
  if (task.review && !task.review.doneAt) return { kind: 'staff', id: task.review.staffId, from: 'asked' };
  const pointed = task.reviewerId ?? null;
  const id = pointed ?? (board?.autoReview ? board.reviewerId : null);
  if (!id) return { kind: 'owner', why: 'off' };
  if (id === task.staffId) return { kind: 'owner', why: 'self' };
  const answered = !!task.review?.doneAt && task.review.verdict !== 'approved';
  if (answered && (task.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS) return { kind: 'owner', why: 'cap' };
  return { kind: 'staff', id, from: pointed ? 'task' : 'board' };
}

/** O cartão em revisão cai para o dono por causa da regra (não por não haver revisão automática): é onde a tela avisa. */
export const fellToOwner = (plan: ReviewPlan): plan is { kind: 'owner'; why: 'self' | 'cap' } => plan.kind === 'owner' && plan.why !== 'off';
