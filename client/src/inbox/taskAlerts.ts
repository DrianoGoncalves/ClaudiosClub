import type { InboxItem, InboxKind } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from './secretText';

// Itens da caixa "precisa de mim" que vêm de tarefa parada na linha de produção: dúvida escalada (`question`), revisão ou ajuste que
// não anda (`stuck`) e dependente de tarefa parada (`blocked`, que agora diz se há o que fazer). O servidor manda estrutura e o
// `summary` em pt-BR; a frase e a ação saem daqui, no idioma da página.
//
// CONTRATO: plano da t-5daa14 (implementação na t-76d427). Os tipos ainda não estão em shared/model.ts, por isso moram aqui; quando
// entrarem lá, trocar por eles. A tela lê os campos só por este arquivo: um nome diferente no servidor se corrige aqui.

/** O que só você resolve numa tarefa parada. `null` = a fila se recupera sozinha (não vira ação). */
export type HumanAction = 'answer' | 'review' | 'resend' | 'decide';

/** Os tipos de item que a caixa conhece, os novos (`question`, `stuck`) já incluídos. */
export type AlertKind = InboxKind | 'question' | 'stuck';

/** Dúvida escalada (kind 'question'): a pergunta por opções (`questions`) ou escrita (`text`). */
export interface QuestionAlert {
  taskId: string;
  taskTitle?: string;
  questionId: string;
  source: 'ask' | 'text';
  text?: string;
  questions?: Array<{ question: string; options: string[]; multiSelect?: boolean }>;
  escalatedAt: string;
}

/** Tarefa parada (kind 'stuck'): revisão sem veredito ou não iniciada, ajuste que não chega, Aguardar. */
export interface StuckAlert {
  taskId: string;
  taskTitle?: string;
  /** Em pt-BR, vem do servidor (a frase da tela sai de `humanAction`). */
  reason: string;
  selfHeals: boolean;
  humanAction: HumanAction | null;
  since: string;
}

/** Abrir o aviso: o item e, quando a ação é em outro card (a tarefa que segura esta), o id dele. */
export type InboxOpen = (item: InboxItem, opts?: { taskId?: string }) => void;

/** O item só precisa dizer o kind (nos testes, nem isso): sem ele, não é nenhum dos novos. */
export type Kinded = { kind?: InboxKind };

export const alertKind = (item: Kinded): AlertKind | undefined => item.kind;

export function questionOf(item: Kinded): QuestionAlert | null {
  const q = (item as { question?: QuestionAlert }).question;
  return alertKind(item) === 'question' && q ? q : null;
}

export function stuckOf(item: Kinded): StuckAlert | null {
  const s = (item as { stuck?: StuckAlert }).stuck;
  return alertKind(item) === 'stuck' && s ? s : null;
}

/** Item de tarefa que não é conversa esperando: o cartão do funcionário não pode ficar amarelo por ele. */
export const isTaskAlert = (item: Kinded): boolean => {
  const k = alertKind(item);
  return k === 'blocked' || k === 'question' || k === 'stuck';
};

/** O que fazer com o item e o card onde se faz. `taskId` é o que o link abre. */
export interface AlertAction {
  action: HumanAction;
  taskId: string;
  label: string;
  title: string;
}

const LABEL = {
  answer: 'inbox.act.answer',
  review: 'inbox.act.review',
  resend: 'inbox.act.resend',
  decide: 'inbox.act.decide',
} as const;

const TITLE = {
  answer: 'inbox.act.answerTitle',
  review: 'inbox.act.reviewTitle',
  resend: 'inbox.act.resendTitle',
  decide: 'inbox.act.decideTitle',
} as const;

/**
 * A ação do item: dúvida escalada = responder; parada = a `humanAction` dela; dependente = a `humanAction` da que segura (o link abre o
 * card dela, é lá que se age). Dependente de tarefa cancelada tem os seus botões e fica de fora; o que se recupera sozinho, também.
 */
export function alertAction(item: InboxItem, tr: Tr = t): AlertAction | null {
  const q = questionOf(item);
  if (q) return { action: 'answer', taskId: q.taskId, label: tr(LABEL.answer), title: tr(TITLE.answer) };
  const s = stuckOf(item);
  if (s?.humanAction) return { action: s.humanAction, taskId: s.taskId, label: tr(LABEL[s.humanAction]), title: tr(TITLE[s.humanAction]) };
  const b = item.blocked as (NonNullable<InboxItem['blocked']> & { humanAction?: HumanAction | null }) | undefined;
  if (alertKind(item) === 'blocked' && b?.humanAction && b.blockerStatus !== 'cancelled') {
    return { action: b.humanAction, taskId: b.blockerId, label: tr(LABEL[b.humanAction]), title: tr('inbox.act.blockerTitle', { blocker: b.blockerTitle }) };
  }
  return null;
}

/** O card que o item abre ao clicar: o da tarefa do aviso. */
export function taskIdOf(item: Kinded & Pick<InboxItem, 'blocked' | 'notStarted'>): string | undefined {
  return questionOf(item)?.taskId ?? stuckOf(item)?.taskId ?? item.blocked?.taskId ?? item.notStarted?.taskId;
}

/** Primeira linha do que foi perguntado, cortada: o que cabe numa linha da caixa. */
function askedLine(q: QuestionAlert, tr: Tr): string {
  const first = (q.questions?.[0]?.question ?? q.text ?? '').trim().split(/\r?\n/)[0]!.trim();
  const line = first.length > 140 ? `${first.slice(0, 139)}…` : first;
  const more = (q.questions?.length ?? 0) - 1;
  return more > 0 ? tr('inbox.question.more', { question: line, n: more }) : line;
}

/** “Tarefa”: a pergunta, no idioma atual; sem o `question` (ou o título), o `summary`. */
export function questionText(item: Kinded & Pick<InboxItem, 'summary'>, tr: Tr = t): string {
  const q = questionOf(item);
  if (!q?.taskTitle) return item.summary;
  return tr('inbox.question.sentence', { task: q.taskTitle, question: askedLine(q, tr) });
}

/** O que está parado e o que falta de você, pela `humanAction`; sem ela (ou sem título), o `summary`. */
export function stuckText(item: Kinded & Pick<InboxItem, 'summary'>, tr: Tr = t): string {
  const s = stuckOf(item);
  if (!s?.taskTitle || !s.humanAction) return item.summary;
  return tr(`inbox.stuck.${s.humanAction}`, { task: s.taskTitle });
}
