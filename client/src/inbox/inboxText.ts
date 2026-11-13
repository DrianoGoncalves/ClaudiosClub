import type { InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import { secretText, type Tr } from './secretText';

// Frase de cada item da caixa "precisa de mim" no idioma da página. O servidor manda o `summary` em pt-BR (fallback) e,
// nos itens que têm estrutura (segredo, tarefa bloqueada), os campos de onde a frase sai aqui.

/** O motivo da bloqueadora vem do servidor em pt-BR (`stuckReason` em server/tasks.ts); os conhecidos saem no idioma da tela, o resto como veio. */
function reasonText(reason: string, tr: Tr): string {
  if (reason === 'em Aguardar') return tr('inbox.blocked.onHold');
  const why = /^em Aguardar: ([\s\S]+)$/.exec(reason);
  if (why) return tr('inbox.blocked.onHoldWhy', { why: why[1]! });
  if (reason === 'limite de revisões automáticas atingido') return tr('inbox.blocked.reviewLimit');
  if (reason === 'sem responsável') return tr('inbox.blocked.noOwner');
  return reason;
}

/** "“A” espera “B”: motivo" no idioma atual; sem o `blocked` (servidor antigo), o `summary`. */
export function blockedText(item: Pick<InboxItem, 'summary' | 'blocked'>, tr: Tr = t): string {
  const b = item.blocked;
  if (!b) return item.summary;
  return tr('inbox.blocked.sentence', { task: b.taskTitle, blocker: b.blockerTitle, reason: reasonText(b.reason, tr) });
}

/** O texto do item na lista e na notificação. */
export function inboxText(item: Pick<InboxItem, 'summary' | 'secret' | 'blocked'>, tr: Tr = t): string {
  return item.blocked ? blockedText(item, tr) : secretText(item, tr);
}

/** Quem é o item na lista: o funcionário e, sem ficha (tarefa sem responsável), o próprio projeto. */
export const inboxWho = (item: Pick<InboxItem, 'name' | 'projectName'>): string => item.name || item.projectName;
