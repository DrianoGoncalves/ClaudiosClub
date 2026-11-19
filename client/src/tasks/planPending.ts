import type { InboxItem, Task } from '../../../shared/model';

// "Plano para aprovar" só quando o dono tem um plano esperando de verdade. O status `planning` da tarefa não prova isso: ele dura
// até o cartão de plano do chat ser aprovado, e uma ficha Codex (sem esse cartão) ou a resposta do gestor a uma dúvida o deixam
// parado para sempre. Quem prova é o item `plan` da caixa, que o servidor só põe enquanto o cartão está sem resposta.

/** As conversas que têm um plano esperando aprovação (item `plan` da caixa). */
export function planSessions(items: readonly InboxItem[]): ReadonlySet<string> {
  return new Set(items.filter((i) => i.kind === 'plan' && i.sessionId).map((i) => i.sessionId));
}

/** A tarefa está planejando e a conversa de trabalho dela tem plano esperando você (selo, destaque e topo da coluna). */
export function planPending(task: Pick<Task, 'status' | 'sessionId'>, sessions: ReadonlySet<string>): boolean {
  return task.status === 'planning' && !!task.sessionId && sessions.has(task.sessionId);
}
