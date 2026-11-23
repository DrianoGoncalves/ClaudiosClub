import type { InboxItem, StaffProfile, Task } from '../../../shared/model';
import { api, withUsageConfirm } from '../api';
import { byHierarchy, canPickReviewer, reviewersOf } from '../tasks/reviewPick';
import { stuckOf } from './taskAlerts';

// "Delegar revisão" no aviso de tarefa parada (item `stuck` com a ação Revisar): atalho para o seletor que o card já tem, sem abrir o card.
// Mesma rota (`api.taskReview`) e mesma regra do painel (tasks/reviewPick.ts): só a ficha deste projeto, na ordem da hierarquia, menos o responsável.

/** Quem a caixa oferece para revisar o item, ou null quando não há atalho: o item não é a revisão parada, a tarefa ainda não foi lida ou o painel dela não pede revisão agora. */
export function reviewShortcutOf(item: InboxItem, task: Task | null, staff: ReadonlyArray<StaffProfile>): { reviewers: StaffProfile[] } | null {
  const s = stuckOf(item);
  if (!s || s.humanAction !== 'review' || s.noCode || !task || task.id !== s.taskId || !canPickReviewer(task)) return null;
  return { reviewers: reviewersOf(byHierarchy(staff.filter((p) => p.projectId === item.projectId)), task) };
}

export interface AskReviewIo {
  setBusy: (busy: boolean) => void;
  setError: (message: string | null) => void;
  /** A revisão foi pedida a `name`. */
  onAsked: (name: string) => void | Promise<void>;
}

/**
 * Pede a revisão pela rota do painel (`POST tasks/:id/review`, com a trava de consumo). O ocupado sempre volta; o erro do servidor vai para `setError`.
 * Sem resposta (null) o pedido não foi feito, por exemplo porque você recusou a trava de consumo: nada a avisar.
 */
export async function askReview(projectId: string, task: Pick<Task, 'id'>, reviewers: StaffProfile[], reviewerId: string, io: AskReviewIo): Promise<void> {
  io.setBusy(true);
  io.setError(null);
  try {
    const asked = await withUsageConfirm((force) => api.taskReview(projectId, task.id, reviewerId, force));
    if (asked) await io.onAsked(reviewers.find((s) => s.id === reviewerId)?.name ?? reviewerId);
  } catch (e) {
    io.setError((e as Error).message);
  } finally {
    io.setBusy(false);
  }
}
