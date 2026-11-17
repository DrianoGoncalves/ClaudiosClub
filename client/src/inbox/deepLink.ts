import type { InboxItem, InboxKind } from '../../../shared/model';

// O link que a extensão do Chrome abre ao clicar numa notificação (extension/lib/inbox.js, `clubLink`):
//   #abrir?kind=plan&projeto=<id>&funcionario=<id>   a tela de quem espera (igual a clicar no aviso da caixa)
//   #abrir?tela=tarefas&projeto=<id>[&tarefa=<id>]   o quadro de tarefas do projeto, já no card quando vem `tarefa`
// Aviso de tarefa (bloqueada, esquecida, dúvida, parada) é do quadro: com ou sem `tela`, abre o quadro (não há conversa nem funcionário a abrir).
// Vem de fora (outro programa pode montar um link igual): só passa o que tem a forma de um id e um tipo conhecido.

export type OpenLink = { tasks: true; projectId: string; taskId?: string } | { tasks: false; kind: InboxKind; projectId: string; staffId: string | null };

const KINDS: readonly InboxKind[] = ['plan', 'permission', 'secret', 'waiting', 'error', 'routine', 'orphan', 'usage', 'blocked', 'notStarted', 'question', 'stuck'];
/** Os avisos que são de uma tarefa: o destino é o quadro do projeto. */
const TASK_KINDS: readonly InboxKind[] = ['blocked', 'notStarted', 'question', 'stuck'];
const ID = /^[A-Za-z0-9_-]{1,120}$/;

/** O destino do `location.hash`, ou null se não é um link da extensão (ou não diz para onde ir). */
export function parseOpenLink(hash: string): OpenLink | null {
  const match = /^#abrir\?(.*)$/.exec(hash);
  if (!match) return null;
  const q = new URLSearchParams(match[1]);
  const project = q.get('projeto');
  const projectId = project && ID.test(project) ? project : null;
  const kind = KINDS.find((k) => k === q.get('kind'));
  if (q.get('tela') === 'tarefas' || (kind && TASK_KINDS.includes(kind))) {
    if (!projectId) return null;
    const task = q.get('tarefa');
    return { tasks: true, projectId, ...(task && ID.test(task) && { taskId: task }) };
  }
  // Aviso de consumo é da conta, sem projeto; os outros precisam do projeto.
  if (!kind || (!projectId && kind !== 'usage')) return null;
  const staff = q.get('funcionario');
  return { tasks: false, kind, projectId: projectId ?? '', staffId: staff && ID.test(staff) ? staff : null };
}

/** O item que o `openInbox` do App entende (sem conversa: abre o funcionário, ou o projeto quando não há funcionário). */
export function linkItem(link: Extract<OpenLink, { tasks: false }>): InboxItem {
  return {
    id: `link:${link.kind}:${link.projectId}:${link.staffId ?? ''}`,
    kind: link.kind,
    projectId: link.projectId,
    projectName: '',
    sessionId: '',
    staffId: link.staffId,
    name: '',
    summary: '',
    at: null,
  };
}
