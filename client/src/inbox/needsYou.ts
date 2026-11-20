import type { InboxItem, Task } from '../../../shared/model';
import type { Tr } from './secretText';
import { t } from '../i18n';
import { INBOX_TONE } from './alertTone';
import { pendingOf } from './resolved';
import { isFallbackWait, stuckNoCodeOf } from './taskAlerts';

// O selo "precisa de você" dos cartões (tarefa, funcionário, projeto). A fonte é a caixa "precisa de mim", sem regra própria: o que espera
// o dono é o pendente cujo tom é `action` (INBOX_TONE: plano, permissão, resposta, dúvida, tarefa parada, follow-up). Fica de fora a espera
// da troca de motor (`stuck` sem `humanAction`): some sozinha e não há o que decidir.

/** O motivo de um item, na ordem em que aparece no rótulo. `noCode` é o `stuck` do card que terminou sem código. */
export type NeedReason = 'plan' | 'permission' | 'waiting' | 'question' | 'noCode' | 'stuck' | 'followUp' | 'review' | 'resend' | 'blocked';

const ORDER: NeedReason[] = ['plan', 'permission', 'waiting', 'question', 'noCode', 'stuck', 'followUp', 'review', 'resend', 'blocked'];

export interface NeedsYou {
  /** Quantos itens esperam o dono. */
  count: number;
  /** Os motivos distintos (um por tipo de item), na ordem de `ORDER`. */
  reasons: NeedReason[];
}

/** Os itens da caixa que esperam uma decisão do dono. */
export const needsYouItems = (items: ReadonlyArray<InboxItem>): InboxItem[] =>
  pendingOf(items).filter((i) => INBOX_TONE[i.kind] === 'action' && !isFallbackWait(i));

const reasonOf = (item: InboxItem): NeedReason => (stuckNoCodeOf(item) ? 'noCode' : (item.kind as NeedReason));

function summarize(items: InboxItem[]): NeedsYou | null {
  if (!items.length) return null;
  const seen = new Set(items.map(reasonOf));
  return { count: items.length, reasons: ORDER.filter((r) => seen.has(r)) };
}

/** Card do quadro: o que o servidor marcou em `Task.inboxWait` (sem recalcular). Só a ação do dono vira selo; a do gestor não é sua. */
export function taskWaitNeeds(task: Pick<Task, 'inboxWait'>): NeedsYou | null {
  const w = task.inboxWait;
  return w && w.by === 'owner' ? { count: 1, reasons: [w.kind] } : null;
}

/** Funcionário: os itens dele (`staffId`) ou das conversas dele; o fantasma (sem ficha) só pelas conversas. */
export function staffNeeds(items: ReadonlyArray<InboxItem>, projectId: string, staffId: string | null, sessionIds: ReadonlyArray<string>): NeedsYou | null {
  const sessions = new Set(sessionIds);
  return summarize(needsYouItems(items).filter((i) => i.projectId === projectId && ((staffId !== null && i.staffId === staffId) || (i.sessionId !== '' && sessions.has(i.sessionId)))));
}

/** Projeto: tudo da sala que espera o dono. */
export const projectNeeds = (items: ReadonlyArray<InboxItem>, projectId: string): NeedsYou | null =>
  summarize(needsYouItems(items).filter((i) => i.projectId === projectId));

/** O texto do selo e o rótulo acessível (o motivo, e a contagem quando passa de um). */
export function needsYouText(needs: NeedsYou, tr: Tr = t): { text: string; label: string } {
  const why = needs.reasons.map((r) => tr(`needs.reason.${r}`)).join(', ');
  const text = needs.count > 1 ? tr('needs.badgeMany', { n: needs.count }) : tr('needs.badge');
  return { text, label: tr('needs.label', { text, why }) };
}
