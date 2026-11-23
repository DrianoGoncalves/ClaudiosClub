import { isClosed, type ChatItem, type InboxItem, type InboxWait, type InboxWaitKind, type Task } from '../shared/model';
import { blockedInboxItem, permissionInboxItem, stuckInboxItem, taskQuestionInboxItem, type Place } from './inboxItems';
import { ownAlerts, planToManager, stuckDependencies } from './tasks';

// `Task.inboxWait` (só leitura, nada gravado): quais cards estão parados esperando alguém agir num item da caixa de entrada. Parte dos itens que a caixa já monta (server/inboxItems.ts) e decide,
// por tipo, se o item TRAVA o card ou só avisa. A caixa (`getInbox`) e a listagem usam as mesmas regras de parada (`ownAlerts`, `stuckDependencies`), então o selo some junto com o item.

/** As conversas com pedido pendente, como `ChatManager.attention()` as dá. */
export type PendingChats = Array<{ sessionId: string; pending: Array<Extract<ChatItem, { kind: 'permission' }>> }>;

type Verdict = Pick<InboxWait, 'kind' | 'by' | 'blockerId'>;

/**
 * O item da caixa prende o card `task`? Devolve o tipo e de quem é a ação, ou null quando é só aviso. Exaustivo de propósito: tipo novo de item da caixa não compila sem esta decisão.
 * Prende: o que para o card até alguém agir (plano, permissão, dúvida, revisão ou ajuste que não anda, card sem código, dependência empacada). Não prende: o que o card não espera
 * (follow-up é melhoria posterior à entrega; ação barrada o agente contorna; erro de commit é depois de pronto) e o que se resolve sozinho (`selfHeals`, espera do limite do motor).
 */
function verdictOf(item: InboxItem, task: Task): Verdict | null {
  switch (item.kind) {
    case 'plan':
      return { kind: 'plan', by: 'owner' };
    case 'permission': {
      // O cartão pendente da dúvida por opções (`Task.question`, origem 'ask'): com o gestor até escalar, com você depois. Sem dúvida na tarefa, é permissão de ferramenta, sua.
      const q = task.question;
      if (q?.source === 'ask' && q.status !== 'answered') return { kind: 'question', by: q.status === 'open' ? 'manager' : 'owner' };
      return { kind: 'permission', by: 'owner' };
    }
    case 'question':
      return { kind: 'question', by: 'owner' };
    case 'stuck': {
      const s = item.stuck;
      if (s?.humanAction === 'review') return { kind: 'review', by: 'owner' };
      if (s?.humanAction === 'resend') return { kind: 'resend', by: 'owner' };
      if (s?.humanAction === 'decide' && s.noCode) return { kind: 'noCode', by: 'owner' };
      // O plano que o card entregou e o usuário decide (card pedido por ele, ou o aviso ao gestor se perdeu): é o `planWait` do item de parada. O do gestor não chega aqui (sem item).
      if (s?.humanAction === 'decide' && s.planWait) return { kind: 'plan', by: 'owner' };
      return null; // `humanAction` null: espera do limite da ficha, que baixa sozinho
    }
    case 'blocked': {
      const b = item.blocked;
      return b && b.selfHeals === false ? { kind: 'blocked', by: 'owner', blockerId: b.blockerId } : null;
    }
    case 'notStarted':
    case 'followUp':
    case 'denied':
    case 'error':
    case 'secret':
    case 'waiting':
    case 'orphan':
    case 'routine':
    case 'usage':
      return null;
    default: {
      const unreachable: never = item.kind;
      return unreachable;
    }
  }
}

/** Prioridade quando mais de um item prende o card: o que para a própria conversa vem antes das paradas, e a dependência por último. */
const RANK: Record<InboxWaitKind, number> = { plan: 0, question: 1, permission: 2, review: 3, resend: 4, noCode: 5, blocked: 6 };

const earlier = (a: string, b: string): boolean => (Date.parse(a) || 0) < (Date.parse(b) || 0);

/**
 * O card que o item da caixa prende: pelo `taskId` dos itens de tarefa, ou pela conversa nos de plano e permissão. A conversa de trabalho só vale com o card em "fazendo" ou "planejando" e
 * que não seja automático (a conversa é sua, você está nela: a mesma regra de `Task.permissionWait`); a da revisão, com o card em "revisão".
 */
function taskOf(item: InboxItem, byId: Map<string, Task>, bySession: Map<string, Task>): Task | undefined {
  switch (item.kind) {
    case 'plan':
    case 'permission':
      return item.sessionId ? bySession.get(item.sessionId) : undefined;
    case 'question':
      return byId.get(item.question?.taskId ?? '');
    case 'stuck':
      return byId.get(item.stuck?.taskId ?? '');
    case 'blocked':
      return byId.get(item.blocked?.taskId ?? '');
    default:
      return undefined;
  }
}

/** Os itens da caixa que prendem cada card aberto, um por card (o de maior prioridade; empate, o mais antigo). Item `resolvedAt` (problema que já passou) não conta. */
export function inboxWaits(items: InboxItem[], tasks: Task[]): Map<string, InboxWait> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const bySession = new Map<string, Task>();
  for (const t of tasks) {
    if (t.sessionId && !t.autoCreated && (t.status === 'doing' || t.status === 'planning')) bySession.set(t.sessionId, t);
    if (t.review?.sessionId && t.status === 'review') bySession.set(t.review.sessionId, t);
  }
  const out = new Map<string, InboxWait>();
  for (const item of items) {
    if (item.resolvedAt) continue;
    const task = taskOf(item, byId, bySession);
    if (!task || isClosed(task)) continue;
    const v = verdictOf(item, task);
    if (!v) continue;
    const wait: InboxWait = { kind: v.kind, by: v.by, itemId: item.id, since: item.at ?? task.updatedAt, ...(v.blockerId && { blockerId: v.blockerId }) };
    const cur = out.get(task.id);
    if (!cur || RANK[wait.kind] < RANK[cur.kind] || (RANK[wait.kind] === RANK[cur.kind] && earlier(wait.since, cur.since))) out.set(task.id, wait);
  }
  return out;
}

/**
 * Os ids dos itens `plan` da caixa (um por cartão ExitPlanMode pendente, ver `permissionInboxItem`) que são decisão do gestor que pediu o card (`planToManager`): ficam fora da caixa do dono e do selo
 * `Task.inboxWait`. O cartão segue na conversa, e o dono ainda pode decidir por ele. Plano do dono, ou do gestor que não recebeu (escalado), mantém o item.
 */
export function managerPlanItemIds(tasks: Task[]): Set<string> {
  return new Set(tasks.filter(planToManager).map((t) => `perm:p:${t.planWait!.card}`));
}

/**
 * Os itens da caixa que se referem a cards de `tasks` (o mesmo que `getInbox` monta para esses tipos: dúvida escalada ou parada própria, dependência empacada, plano e permissão pendentes
 * na conversa). Sem nome de projeto nem de funcionário: só o que `inboxWaits` lê. `tasks` precisa vir da listagem (com `permissionWait`, que entra na regra de parada).
 */
export function taskInboxItems(tasks: Task[], pending: PendingChats, projectId: string, now = Date.now()): InboxItem[] {
  const w: Place = { projectId, projectName: '', sessionId: '', staffId: null, name: '' };
  const out: InboxItem[] = [];
  for (const a of ownAlerts(tasks, now)) out.push(a.state.humanAction === 'answer' ? taskQuestionInboxItem(a, w) : stuckInboxItem(a, w));
  for (const s of stuckDependencies(tasks, now)) out.push(blockedInboxItem(s, w));
  const toManager = managerPlanItemIds(tasks);
  for (const { sessionId, pending: cards } of pending) for (const p of cards) if (!toManager.has(`perm:${p.id}`)) out.push(permissionInboxItem(p, { ...w, sessionId }));
  return out;
}

/**
 * A listagem de tarefas com `Task.inboxWait`. Erro ao calcular: a lista sai como estava (o selo é um complemento, nunca derruba o quadro). `null` (projeto desconhecido) passa direto.
 */
export function withInboxWait(tasks: Task[] | null, projectId: string, pending: PendingChats, now = Date.now()): Task[] | null {
  if (!tasks) return tasks;
  try {
    const waits = inboxWaits(taskInboxItems(tasks, pending, projectId, now), tasks);
    return waits.size ? tasks.map((t) => (waits.has(t.id) ? { ...t, inboxWait: waits.get(t.id)! } : t)) : tasks;
  } catch {
    return tasks;
  }
}
