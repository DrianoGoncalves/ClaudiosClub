import type { ConsultLinkView, ConsultRecordView } from '../api';
import type { MsgKey } from '../i18n';

// Lógica pura da consulta entre projetos na tela (a seção do projeto e os rótulos no chat).

/** Frase pelo STATUS da recusa: o texto do servidor vem em pt e não se traduz. */
export function consultErrorKey(status: number | null | undefined): MsgKey {
  if (status === 400) return 'consult.errInvalid';
  if (status === 403) return 'consult.errForbidden';
  if (status === 404) return 'consult.errNotFound';
  return 'consult.errGeneric';
}

export const STATE_KEY: Record<ConsultRecordView['state'], MsgKey> = {
  running: 'consult.stateRunning',
  answered: 'consult.stateAnswered',
  delivered: 'consult.stateDelivered',
  failed: 'consult.stateFailed',
  expired: 'consult.stateExpired',
  cancelled: 'consult.stateCancelled',
  undeliverable: 'consult.stateUndeliverable',
};

/** Os vínculos que saem do projeto (ele pergunta) e os que chegam (ele responde). */
export function splitLinks(links: ConsultLinkView[], projectId: string): { out: ConsultLinkView[]; incoming: ConsultLinkView[] } {
  return { out: links.filter((l) => l.from === projectId), incoming: links.filter((l) => l.to === projectId) };
}

/** Segundos que faltam para o prazo de uma consulta em andamento (0 = venceu). */
export function secondsToDeadline(deadlineAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(deadlineAt) - now) / 1000));
}

/** A lista a gravar ao marcar/desmarcar um funcionário (null = todos): sem repetir, na ordem da equipe. */
export function toggleStaff(current: string[], team: string[], id: string): string[] {
  const set = new Set(current);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return team.filter((s) => set.has(s));
}

export interface ConsultMessage {
  kind: 'answer' | 'question' | 'notice';
  id: string;
  /** Com quem a mensagem fala: quem respondeu, quem perguntou ou quem foi consultado. */
  name: string;
  /** Cargo (só em resposta e pergunta). */
  role: string | null;
  project: string;
}

const ANSWER = /^Resposta da consulta (c-[0-9a-f]{6}): (.+?) \((.*?)\), do projeto “(.+?)”\./;
const QUESTION = /^Consulta (c-[0-9a-f]{6}) de outro projeto, SOMENTE LEITURA\. Quem pergunta: (.+?) \((.*?)\), do projeto “(.+?)”\./;
const NOTICE = /^A consulta (c-[0-9a-f]{6}) a (.+?) \(projeto “(.+?)”\) não deu resposta/;

/**
 * Lê o cabeçalho das mensagens da plataforma sobre consulta entre projetos (server/consult/text.ts), sem o prefixo `[MyCo]`:
 * é só rótulo na tela; quem não bate com o formato fica como aviso comum. Nunca devolve o conteúdo da pergunta ou da resposta.
 */
export function consultMessageOf(text: string): ConsultMessage | null {
  let m = ANSWER.exec(text);
  if (m) return { kind: 'answer', id: m[1]!, name: m[2]!, role: m[3]!, project: m[4]! };
  m = QUESTION.exec(text);
  if (m) return { kind: 'question', id: m[1]!, name: m[2]!, role: m[3]!, project: m[4]! };
  m = NOTICE.exec(text);
  if (m) return { kind: 'notice', id: m[1]!, name: m[2]!, role: null, project: m[3]! };
  return null;
}
