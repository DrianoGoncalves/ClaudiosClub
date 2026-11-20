import type { ConsultDeps } from './service';

// A entrega à conversa de quem perguntou (a resposta da consulta, ou o aviso curto de que não houve resposta). Separada do index.ts para testar os três casos: o remetente livre, ocupado em outra
// tarefa (espera a vez, guardada como a resposta a uma dúvida) e a conversa fechada (reabre).

export interface DeliverDeps {
  /** A trava de uso do projeto e do funcionário de QUEM RECEBE (a mensagem acorda a conversa dele): UsageStopError quando barra, e a entrega tenta de novo mais tarde. */
  checkUsage: (projectId: string, staffId: string) => Promise<void>;
  /** TaskService.hold: com o funcionário em outra tarefa (ou o projeto pausado), guarda a mensagem para a vez dele e devolve o motivo; senão, null. Conversa que não é de tarefa: null. */
  hold: (sessionId: string, msg: { text: string; auto: true }) => Promise<string | null>;
  /** ChatManager.sendNotice: mensagem da plataforma; entra no meio do turno se há (`next`), reabre a conversa fechada, não tira tarefa da revisão nem o "continue" agendado. */
  sendNotice: (projectId: string, sessionId: string, staffId: string, text: string) => Promise<unknown>;
}

export function deliverToAsker(d: DeliverDeps): ConsultDeps['deliver'] {
  return async (to, text) => {
    await d.checkUsage(to.projectId, to.staffId);
    if (await d.hold(to.sessionId, { text, auto: true })) return;
    await d.sendNotice(to.projectId, to.sessionId, to.staffId, text);
  };
}
