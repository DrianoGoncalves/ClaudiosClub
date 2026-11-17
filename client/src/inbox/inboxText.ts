import type { InboxItem } from '../../../shared/model';
import { parseRetryNotice, retryNoticeText } from '../chat/retryNotice';
import { t } from '../i18n';
import { secretText, type Tr } from './secretText';
import { questionOf, questionText, stuckOf, stuckText, type Kinded } from './taskAlerts';

// Frase de cada item da caixa "precisa de mim" no idioma da página. O servidor manda o `summary` em pt-BR (fallback) e,
// nos itens que têm estrutura (segredo, tarefa bloqueada, cartão esquecido, dúvida escalada, tarefa parada), os campos de onde a frase sai aqui.

/** O motivo da bloqueadora vem do servidor em pt-BR (`stuckReason` em server/tasks.ts); os conhecidos saem no idioma da tela, o resto como veio. */
function reasonText(reason: string, tr: Tr): string {
  if (reason === 'em Aguardar') return tr('inbox.blocked.onHold');
  const why = /^em Aguardar: ([\s\S]+)$/.exec(reason);
  if (why) return tr('inbox.blocked.onHoldWhy', { why: why[1]! });
  if (reason === 'limite de revisões automáticas atingido') return tr('inbox.blocked.reviewLimit');
  if (reason === 'sem responsável') return tr('inbox.blocked.noOwner');
  return reason;
}

/** Bloqueadora cancelada: o motivo vem como 'cancelada' ou 'cancelada: <motivo>' (texto livre de quem cancelou, vai como veio); o resto, null. */
function cancelledWhy(reason: string): { why: string | null } | null {
  if (reason === 'cancelada') return { why: null };
  const m = /^cancelada: ([\s\S]+)$/.exec(reason);
  return m ? { why: m[1]! } : null;
}

/** "“A” espera “B”: motivo" no idioma atual; sem o `blocked` (servidor antigo), o `summary`. */
export function blockedText(item: Pick<InboxItem, 'summary' | 'blocked'>, tr: Tr = t): string {
  const b = item.blocked;
  if (!b) return item.summary;
  // Cancelada vira outra frase ("espera “B”, que foi cancelada (motivo)"): "espera “B”: cancelada: motivo" tinha dois-pontos duplos.
  const cancelled = cancelledWhy(b.reason);
  if (cancelled) return cancelled.why === null ? tr('inbox.blocked.sentenceCancelled', { task: b.taskTitle, blocker: b.blockerTitle }) : tr('inbox.blocked.sentenceCancelledWhy', { task: b.taskTitle, blocker: b.blockerTitle, why: cancelled.why });
  return tr('inbox.blocked.sentence', { task: b.taskTitle, blocker: b.blockerTitle, reason: reasonText(b.reason, tr) });
}

/** "“A” está em A fazer há N dias e não começou" no idioma atual; sem o `notStarted` (servidor antigo), o `summary`. */
export function notStartedText(item: Pick<InboxItem, 'summary' | 'notStarted'>, tr: Tr = t): string {
  const n = item.notStarted;
  if (!n) return item.summary;
  return tr('inbox.notStarted.sentence', { task: n.taskTitle, days: n.days });
}

/** O texto do item na lista e na notificação. */
export function inboxText(item: Pick<InboxItem, 'summary' | 'secret' | 'blocked' | 'notStarted'> & Kinded, tr: Tr = t): string {
  if (questionOf(item)) return questionText(item, tr);
  if (stuckOf(item)) return stuckText(item, tr);
  if (item.blocked) return blockedText(item, tr);
  if (item.notStarted) return notStartedText(item, tr);
  // A conversa que desistiu de voltar sozinha, ou não voltou por uma ação com efeito fora do projeto: o servidor só manda a frase em pt-BR.
  const retry = item.kind === 'error' ? parseRetryNotice({ text: item.summary }) : null;
  if (retry) return retryNoticeText(retry, Date.now(), 'inbox', tr);
  return secretText(item, tr);
}

/** Quem é o item na lista: o funcionário e, sem ficha (tarefa sem responsável), o próprio projeto. */
export const inboxWho = (item: Pick<InboxItem, 'name' | 'projectName'>): string => item.name || item.projectName;
