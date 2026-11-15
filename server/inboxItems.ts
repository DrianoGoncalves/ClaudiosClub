import type { ChatItem, InboxItem } from '../shared/model';
import type { NotStartedTask, StuckDependency } from './tasks';

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
/** A frase em pt-BR (a tela monta a dela no idioma da página). Bloqueadora cancelada: "que foi cancelada (motivo)", sem dois-pontos duplos. */
function blockedSummary(s: StuckDependency): string {
  const head = `“${s.task.title}” espera “${s.blocker.title}”`;
  if (s.blocker.status !== 'cancelled') return `${head}: ${s.reason}`;
  const why = /^cancelada: ([\s\S]+)$/.exec(s.reason)?.[1];
  return `${head}, que foi cancelada${why ? ` (${why})` : ''}`;
}

/**
 * Tarefa que espera outra empacada (ver stuckDependencies). Nada é gravado: some quando a bloqueadora anda ou fica pronta. O alvo é a
 * tarefa que espera, no quadro (sem conversa, `sessionId` vazio).
 */
export function blockedInboxItem(s: StuckDependency, w: Place): InboxItem {
  return {
    id: `blocked:${s.task.id}:${s.blocker.id}`,
    kind: 'blocked',
    ...w,
    summary: blockedSummary(s),
    at: s.blocker.updatedAt,
    blocked: { taskId: s.task.id, taskTitle: s.task.title, blockerId: s.blocker.id, blockerTitle: s.blocker.title, blockerStatus: s.blocker.status, reason: s.reason },
  };
}

/**
 * Cartão esquecido (ver notStartedTasks): tarefa em "a fazer" que não começou nem entrou na fila há dias. Nada é gravado: some quando
 * ela começa, é cancelada, editada ou apagada. As ações são as rotas de sempre (começar e cancelar a tarefa, só pela tela). O alvo é a
 * tarefa no quadro (sem conversa, `sessionId` vazio); o item não leva `staffId` (não pinta o cartão do funcionário), o responsável vem em `notStarted`.
 */
export function notStartedInboxItem(n: NotStartedTask, w: Omit<Place, 'staffId'>): InboxItem {
  return {
    id: `notStarted:${n.task.id}`,
    kind: 'notStarted',
    ...w,
    staffId: null,
    summary: `“${n.task.title}” está em A fazer há ${n.days} dias e não começou`,
    at: n.task.updatedAt,
    notStarted: { taskId: n.task.id, taskTitle: n.task.title, days: n.days, staffId: n.task.staffId },
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
