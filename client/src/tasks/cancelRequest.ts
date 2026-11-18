import type { CancelRequest, Task, TaskCreateWarning } from '../../../shared/model';
import { t } from '../i18n';
import { cancelledByName } from './cancelDeps';

// Cancelamento de tarefa visto pela tela: quem cancelou (e em que papel), o pedido de cancelamento de quem pediu a tarefa (`Task.cancelRequest`) e o
// aviso de possível duplicata devolvido na criação (`TaskCreateResult.warnings`). Sem React: o selo e o bloco (TaskCancelRequest) só desenham.

/** Quem procura o nome de um funcionário pelo id (null = sem ficha na lista). */
type NameOf = (id: string | null) => string | null;

/**
 * O papel de quem cancelou em relação à tarefa: `requester` = quem a pediu (cancela a que nunca começou), `worker` = quem a fazia (cancela a própria ou aceita
 * o pedido). Você pela tela ('user') não tem papel. Quem pediu e fazia é o mesmo funcionário: sem papel (não dá para dizer qual dos dois foi).
 */
export function cancelledRole(task: Pick<Task, 'cancelledBy' | 'requestedBy' | 'staffId'>): 'requester' | 'worker' | null {
  const by = task.cancelledBy;
  if (!by || by === 'user') return null;
  const requester = by === task.requestedBy;
  const worker = by === task.staffId;
  return requester === worker ? null : requester ? 'requester' : 'worker';
}

/** "Ana (quem pediu a tarefa)": o nome de quem cancelou com o papel; você pela tela sai só "você". */
export function cancelledWho(task: Pick<Task, 'cancelledBy' | 'requestedBy' | 'staffId'>, nameOf: NameOf): string {
  const name = cancelledByName(task.cancelledBy, nameOf, t('tasks.byYou'));
  const role = cancelledRole(task);
  return role ? t(role === 'requester' ? 'tasks.cancelledAsRequester' : 'tasks.cancelledAsWorker', { name }) : name;
}

/** Quem pediu o cancelamento (o nome na ficha, ou o id). */
export const askerName = (cr: Pick<CancelRequest, 'by'>, nameOf: NameOf): string => nameOf(cr.by) ?? cr.by;

/** Quem decidiu o pedido: 'user' (você, ao cancelar pela tela) ou o responsável. */
export const deciderName = (cr: Pick<CancelRequest, 'decidedBy'>, nameOf: NameOf): string => cancelledByName(cr.decidedBy, nameOf, t('tasks.byYou'));

/** O texto do selo do cartão: pedido esperando decisão ou recusado. Aceito (a tarefa está cancelada) e sem efeito (ficou pronta) não têm selo. */
export function cancelBadgeText(cr: CancelRequest | undefined, nameOf: NameOf): string | null {
  if (cr?.status === 'pending') return t('tasks.cancelReqBadgePending', { name: askerName(cr, nameOf) });
  if (cr?.status === 'refused') return t('tasks.cancelReqBadgeRefused');
  return null;
}

/** Onde o pedido está: chegou à conversa do responsável, espera a vez dele (está em outra tarefa), a entrega falhou e será refeita, ou está saindo. */
export type CancelDelivery = 'delivered' | 'waiting' | 'retry' | 'sending';

export function cancelDelivery(cr: Pick<CancelRequest, 'deliveredAt' | 'waiting' | 'retry'>): CancelDelivery {
  if (cr.deliveredAt) return 'delivered';
  if (cr.retry) return 'retry';
  return cr.waiting ? 'waiting' : 'sending';
}

/** Os avisos de possível duplicata da resposta de criar (o único código que existe hoje; código novo, de um servidor mais novo, não vira aviso). */
export function duplicateWarnings(created: { warnings?: TaskCreateWarning[] } | null | undefined): TaskCreateWarning[] {
  return (created?.warnings ?? []).filter((w) => w.code === 'possible-duplicate');
}
