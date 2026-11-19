import type { StaffProfile, Task } from '../../../shared/model';

// A regra de quem o dono pode escolher para revisar uma tarefa em revisão. Uma só, usada pelo painel do card (ReviewDelegate) e pelo atalho
// da caixa (inbox/ReviewShortcut): o atalho não pode oferecer outras pessoas, nem aparecer onde o painel não pede revisão.

type Owned = Pick<Task, 'staffId'>;
type Reviewable = Pick<Task, 'status' | 'review'>;

/** Há um pedido de revisão em andamento (sem resposta ainda): o painel não deixa escolher outro revisor enquanto ele corre. */
export const reviewInProgress = (task: Pick<Task, 'review'>): boolean => !!task.review && !task.review.doneAt;

/** O seletor existe só em tarefa em revisão e sem pedido em andamento. */
export const canPickReviewer = (task: Reviewable): boolean => task.status === 'review' && !reviewInProgress(task);

/** Quem pode revisar: os funcionários dados (os do projeto, na ordem da hierarquia), menos o responsável: a revisão é de outro. */
export const reviewersOf = (staff: StaffProfile[], task: Owned): StaffProfile[] => staff.filter((s) => s.id !== task.staffId);

/** O revisor marcado, se ainda está na lista; senão, depois de uma resposta, outro que não o último (pode escolher o mesmo); senão o primeiro. */
export function reviewerChoice(reviewers: StaffProfile[], picked: string, previous: string | undefined): string {
  if (reviewers.some((s) => s.id === picked)) return picked;
  return (reviewers.find((s) => s.id !== previous) ?? reviewers[0])?.id ?? '';
}
