import type { ChatItem, InboxItem } from '../shared/model';
import type { StuckDependency } from './tasks';

// Avisos da caixa "precisa de mim" que vêm de uma conversa do Claudio’s Club e levam ao ponto dela que
// os causou (`itemId`, `quote`): ao clicar, a conversa rola até lá.

type Place = Pick<InboxItem, 'projectId' | 'projectName' | 'sessionId' | 'staffId' | 'name'>;

/** Pedido de permissão (ou plano, ou pergunta com opções) sem resposta: o alvo é o cartão dele na lista. */
export function permissionInboxItem(p: Extract<ChatItem, { kind: 'permission' }>, w: Place): InboxItem {
  const plan = p.plan !== undefined;
  return {
    id: `perm:${p.id}`,
    kind: plan ? 'plan' : 'permission',
    ...w,
    summary: plan ? 'plano pronto para aprovar' : p.questions ? `pergunta para você: ${p.summary}` : `${p.tool} ${p.summary}`,
    at: p.at,
    itemId: p.id,
  };
}

/** Turno que acabou perguntando: o alvo é o balão da resposta, e a pergunta serve para achar o trecho nele. */
/**
 * Tarefa que espera outra empacada (ver stuckDependencies). Nada é gravado: some quando a bloqueadora anda ou fica pronta. O alvo é a
 * tarefa que espera, no quadro (sem conversa, `sessionId` vazio).
 */
export function blockedInboxItem(s: StuckDependency, w: Place): InboxItem {
  return {
    id: `blocked:${s.task.id}:${s.blocker.id}`,
    kind: 'blocked',
    ...w,
    summary: `“${s.task.title}” espera “${s.blocker.title}”: ${s.reason}`,
    at: s.blocker.updatedAt,
    blocked: { taskId: s.task.id, taskTitle: s.task.title, blockerId: s.blocker.id, blockerTitle: s.blocker.title, blockerStatus: s.blocker.status, reason: s.reason },
  };
}

export function questionInboxItem(q: { sessionId: string; text: string; at: string; itemId?: string }, w: Place): InboxItem {
  return {
    id: `question:${q.sessionId}:${q.at}`,
    kind: 'waiting',
    ...w,
    summary: `perguntou: ${q.text}`,
    at: q.at,
    ...(q.itemId && { itemId: q.itemId }),
    quote: q.text,
  };
}
