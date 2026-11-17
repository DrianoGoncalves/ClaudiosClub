import type { HumanAction, InboxItem, InboxKind } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from './secretText';

// Itens da caixa "precisa de mim" que vêm de tarefa parada na linha de produção: dúvida escalada (`question`), revisão ou ajuste que
// não anda (`stuck`) e dependente de tarefa parada (`blocked`, que diz se há o que fazer). O servidor manda estrutura e o `summary`
// em pt-BR (server/inboxItems.ts); a frase e a ação saem daqui, no idioma da página. Os tipos são os de shared/model.ts.

type QuestionAlert = NonNullable<InboxItem['question']>;
type StuckAlert = NonNullable<InboxItem['stuck']>;

/** Abrir o aviso: o item e, quando a ação é em outro card (a tarefa que segura esta), o id dele. */
export type InboxOpen = (item: InboxItem, opts?: { taskId?: string }) => void;

/** O item só precisa dizer o kind (nos testes, nem isso): sem ele, não é nenhum dos de tarefa. */
export type Kinded = { kind?: InboxKind };

export function questionOf(item: Kinded): QuestionAlert | null {
  const q = (item as Pick<InboxItem, 'question'>).question;
  return item.kind === 'question' && q ? q : null;
}

export function stuckOf(item: Kinded): StuckAlert | null {
  const s = (item as Pick<InboxItem, 'stuck'>).stuck;
  return item.kind === 'stuck' && s ? s : null;
}

/** Item de tarefa que não é conversa esperando: o cartão do funcionário não pode ficar amarelo por ele (o servidor leva o `staffId` do responsável). */
export const isTaskAlert = (item: Kinded): boolean => item.kind === 'blocked' || item.kind === 'question' || item.kind === 'stuck';

/** O que fazer com o item e o card onde se faz. `taskId` é o que o link abre. */
export interface AlertAction {
  action: HumanAction;
  taskId: string;
  label: string;
  title: string;
  /** A ação roda na própria caixa (reenviar o ajuste guardado), sem abrir o card. */
  direct?: true;
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
 * Ajuste guardado que não chegou (`resend`, item `stuck`): não abre card, o botão reenvia pela rota da tarefa (`direct`); no dependente
 * (item `blocked`) o reenvio é no item da bloqueadora, e o link só leva ao card dela.
 */
export function alertAction(item: InboxItem, tr: Tr = t): AlertAction | null {
  const q = questionOf(item);
  if (q) return { action: 'answer', taskId: q.taskId, label: tr(LABEL.answer), title: tr(TITLE.answer) };
  const s = stuckOf(item);
  if (s?.humanAction) return { action: s.humanAction, taskId: s.taskId, label: tr(LABEL[s.humanAction]), title: tr(TITLE[s.humanAction]), ...(s.humanAction === 'resend' && { direct: true as const }) };
  const b = item.blocked;
  if (item.kind === 'blocked' && b?.humanAction && b.blockerStatus !== 'cancelled') {
    return { action: b.humanAction, taskId: b.blockerId, label: tr(b.humanAction === 'resend' ? 'inbox.act.resendView' : LABEL[b.humanAction]), title: tr('inbox.act.blockerTitle', { blocker: b.blockerTitle }) };
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

/** “Tarefa”: a pergunta, no idioma atual; sem o `question`, o `summary`. */
export function questionText(item: Kinded & Pick<InboxItem, 'summary'>, tr: Tr = t): string {
  const q = questionOf(item);
  if (!q) return item.summary;
  return tr('inbox.question.sentence', { task: q.taskTitle, question: askedLine(q, tr) });
}

/**
 * Item `stuck` sem `humanAction` = a tarefa espera o limite do motor da ficha voltar, porque a troca para o secundário não serve agora
 * (`Task.fallbackBlocked`; id `stuck:<tarefa>:fallback`). Some sozinho quando o limite baixa: não há o que fazer.
 */
export function isFallbackWait(item: Kinded & { id?: string }): boolean {
  const s = stuckOf(item);
  return !!s && s.humanAction === null && item.id?.endsWith(':fallback') === true;
}

/** O que está parado e o que falta de você, pela `humanAction`; sem ela, a espera da troca de motor ou o `summary`. */
export function stuckText(item: Kinded & Pick<InboxItem, 'summary'> & { id?: string }, tr: Tr = t): string {
  const s = stuckOf(item);
  if (s && isFallbackWait(item)) return tr('inbox.stuck.fallback', { task: s.taskTitle });
  if (!s?.humanAction) return item.summary;
  return tr(`inbox.stuck.${s.humanAction}`, { task: s.taskTitle });
}
