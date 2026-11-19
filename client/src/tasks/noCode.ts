import type { Task, TaskNoCode } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from '../inbox/secretText';

// Card = código: o card que termina o turno sem editar nenhum arquivo não vai para revisão. Fica em "fazendo", marcado "sem código" (`Task.noCode`), sem ocupar o funcionário, e quem pediu
// decide: cancelar com motivo (a rota de cancelar da tarefa) ou devolver ao responsável (uma mensagem na conversa de trabalho, que tira a marca). Planejar e perguntar não são cards:
// o plano é uma fase do card, e a pergunta e a análise vão por conversa.

/** A marca "sem código" do card, se ela vale (só em "fazendo": mover o card a desfaz). */
export const noCodeOf = (task: Pick<Task, 'noCode' | 'status'>): TaskNoCode | null => (task.noCode && task.status === 'doing' ? task.noCode : null);

/**
 * O que o `chat/send` respondeu: `held` = a mensagem ficou guardada (o funcionário está ocupado em outra tarefa) e só chega quando ele terminar, então a marca "sem código" ainda não saiu.
 * Sem este aviso o dono não veria nada acontecer e mandaria de novo (duas mensagens ao funcionário). Devolve a frase a mostrar, ou null se a mensagem foi entregue (ou o envio foi cancelado).
 */
export function giveBackHeldNote(sent: { held?: string } | null | undefined, tr: Tr = t): string | null {
  return sent?.held ? tr('tasks.noCodeHeld') : null;
}

/** O corpo do `chat/send` que devolve o card ao responsável: a mensagem na conversa de trabalho, no idioma da tela. Sem conversa (sumiu) não há a quem devolver: null (resta cancelar). */
export function giveBackBody(task: Pick<Task, 'sessionId' | 'staffId'> | null | undefined, tr: Tr = t): { sessionId: string; staffId: string | null; text: string } | null {
  if (!task?.sessionId) return null;
  return { sessionId: task.sessionId, staffId: task.staffId, text: tr('tasks.noCodeGiveBackText') };
}
