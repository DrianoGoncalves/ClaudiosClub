import type { StaffProfile, Task } from '../../../shared/model';

// A regra de quem o dono pode escolher para revisar uma tarefa em revisão. Uma só, usada pelo painel do card (ReviewDelegate) e pelo atalho
// da caixa (inbox/ReviewShortcut): o atalho não pode oferecer outras pessoas, nem aparecer onde o painel não pede revisão.

type Owned = Pick<Task, 'staffId'>;
type Reviewable = Pick<Task, 'status' | 'review' | 'delivery'>;

/** Revisão viva, como no servidor (`liveReview` em server/tasks.ts): a substituída e a anterior à última entrega não contam. */
export const liveReview = (task: Pick<Task, 'review' | 'delivery'>): Task['review'] => {
  const r = task.review;
  return r && !r.superseded && !(task.delivery && r.at < task.delivery.at) ? r : undefined;
};

/** Há um pedido de revisão vivo em andamento (sem resposta ainda): o painel não deixa escolher outro revisor enquanto ele corre. */
export const reviewInProgress = (task: Pick<Task, 'review' | 'delivery'>): boolean => {
  const r = liveReview(task);
  return !!r && !r.doneAt;
};

/**
 * Funcionários na ordem da hierarquia: quem reporta a você primeiro, depois os subordinados
 * (pelo primeiro gestor, como no organograma). No mesmo nível, orquestrador antes; depois por nome.
 */
export function byHierarchy(staff: StaffProfile[]): StaffProfile[] {
  const byId = new Map(staff.map((s) => [s.id, s]));
  const depth = (s: StaffProfile) => {
    const seen = new Set([s.id]);
    let d = 0;
    for (let m = byId.get(s.reportsTo[0] ?? ''); m && !seen.has(m.id); m = byId.get(m.reportsTo[0] ?? '')) {
      seen.add(m.id);
      d++;
    }
    return d;
  };
  const orch = (s: StaffProfile) => (/orquestr/i.test(s.role) ? 0 : 1);
  return staff
    .map((s) => ({ s, d: depth(s) }))
    .sort((a, b) => a.d - b.d || orch(a.s) - orch(b.s) || a.s.name.localeCompare(b.s.name, 'pt-BR'))
    .map((x) => x.s);
}

/** O seletor existe só em tarefa em revisão e sem pedido em andamento. */
export const canPickReviewer = (task: Reviewable): boolean => task.status === 'review' && !reviewInProgress(task);

/** Quem pode revisar: os funcionários dados (os do projeto, na ordem da hierarquia), menos o responsável: a revisão é de outro. */
export const reviewersOf = (staff: StaffProfile[], task: Owned): StaffProfile[] => staff.filter((s) => s.id !== task.staffId);

/** O revisor marcado, se ainda está na lista; senão, depois de uma resposta, outro que não o último (pode escolher o mesmo); senão o primeiro. */
export function reviewerChoice(reviewers: StaffProfile[], picked: string, previous: string | undefined): string {
  if (reviewers.some((s) => s.id === picked)) return picked;
  return (reviewers.find((s) => s.id !== previous) ?? reviewers[0])?.id ?? '';
}
