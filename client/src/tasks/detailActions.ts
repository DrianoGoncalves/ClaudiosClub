import type { Task } from '../../../shared/model';
import { isClosed } from '../../../shared/model';
import type { MsgKey } from '../i18n';
import { openFollowUps } from './followUp';
import { noCodeOf } from './noCode';
import { canPickReviewer } from './reviewPick';
import type { ReviewPlan } from './reviewRule';

// O painel da tarefa: o que pede você (a faixa do topo) e quais ações ficam no rodapé fixo. Só decide ONDE cada ação fica;
// quando ela existe é a regra de sempre (a mesma dos botões que estavam espalhados pelo painel).

/** Os cartões do painel a que a faixa leva (o `data-card` do wrapper). */
export type AskCard = 'permission' | 'nocode' | 'doubt' | 'followup' | 'review';

export interface OwnerAsk {
  card: AskCard;
  /** Chave de texto do motivo (a frase curta da faixa). */
  reason: MsgKey;
  /** Parâmetros do texto. */
  params?: Record<string, string | number>;
}

interface AskInput {
  task: Task;
  /** Há pedido de permissão esperando você (o texto já montado; null = nenhum). */
  hasPermission: boolean;
  /** A revisão desta tarefa em "revisão" cabe a você (nenhum funcionário revisa). */
  plan: ReviewPlan | null;
}

/**
 * O que é decisão SUA nesta tarefa, na ordem do painel. O pedido de cancelamento de quem pediu a tarefa fica de fora (a decisão é do responsável),
 * como a dúvida e o aviso "sem código" que estão com o gestor.
 */
export function ownerAsks({ task, hasPermission, plan }: AskInput): OwnerAsk[] {
  const asks: OwnerAsk[] = [];
  if (hasPermission) asks.push({ card: 'permission', reason: 'tasks.askPermission' });
  const nc = noCodeOf(task);
  if (nc?.to === 'owner') asks.push({ card: 'nocode', reason: 'tasks.askNoCode' });
  if (task.question?.status === 'escalated') asks.push({ card: 'doubt', reason: 'tasks.askDoubt' });
  const fu = openFollowUps(task).filter((f) => f.to === 'owner').length;
  if (fu) asks.push({ card: 'followup', reason: fu === 1 ? 'tasks.askFollowUpOne' : 'tasks.askFollowUpOther', params: { n: fu } });
  if (task.status === 'review' && plan?.kind === 'owner') asks.push({ card: 'review', reason: 'tasks.askReview' });
  return asks;
}

export type FooterAction =
  | 'start'
  | 'reopen'
  | 'approve'
  | 'goPermission'
  | 'goCard'
  | 'giveBack'
  | 'delegate'
  | 'openChat'
  | 'unqueue'
  | 'move'
  | 'cancel'
  | 'delete';

export interface FooterPlan {
  /** A ação principal do estado (a única em destaque); null quando nada pede você. */
  primary: FooterAction | null;
  /** O card a que "levar ao cartão" rola (só com `primary` ou `secondary` = 'goCard'). */
  goCard: AskCard | null;
  secondary: FooterAction[];
  /** O menu "Mais". */
  more: FooterAction[];
}

interface FooterInput {
  task: Task;
  asks: OwnerAsk[];
  /** Posição na fila do responsável (0 = fora dela). */
  queuePos: number;
  /** Há como abrir o cartão do pedido de permissão no chat. */
  canOpenPermission: boolean;
  /** Há responsável com conversa para abrir. */
  hasChat: boolean;
  /** Plano esperando a sua aprovação (item `plan` da caixa): o plano se aprova na conversa, então a principal é abri-la. */
  planWaiting?: boolean;
}

/**
 * As ações do rodapé por estado. Uma principal, pela ordem do que mais trava a tarefa: sem código (Devolver), permissão (levar ao chat), dúvida e follow-up
 * (levar ao cartão), revisão (Aprovar), cancelada (Reabrir), tarefa que nunca começou (Começar/Enfileirar). Se outra ação principal tem a vez, a Aprovar
 * desce para as secundárias. "Mais" guarda o que muda a tarefa de lugar ou a encerra.
 */
export function footerPlan({ task, asks, queuePos, canOpenPermission, hasChat, planWaiting = false }: FooterInput): FooterPlan {
  const cancelled = task.status === 'cancelled';
  const has = (c: AskCard) => asks.some((a) => a.card === c);
  const canStart = !task.sessionId && queuePos === 0 && !cancelled;
  const canApprove = task.status === 'review';
  let primary: FooterAction | null = null;
  let goCard: AskCard | null = null;
  if (has('nocode')) primary = 'giveBack';
  else if (has('permission') && canOpenPermission) primary = 'goPermission';
  else if (has('doubt')) [primary, goCard] = ['goCard', 'doubt'];
  else if (has('followup')) [primary, goCard] = ['goCard', 'followup'];
  else if (planWaiting && hasChat) primary = 'openChat';
  else if (canApprove) primary = 'approve';
  else if (cancelled) primary = 'reopen';
  else if (canStart) primary = 'start';
  // Sem pendência do dono, a primária é a próxima ação natural: a tarefa em andamento leva à conversa onde ela anda.
  else if (hasChat && !isClosed(task)) primary = 'openChat';

  const secondary: FooterAction[] = [];
  if (canApprove && primary !== 'approve') secondary.push('approve');
  if (canStart && primary !== 'start') secondary.push('start');
  if (canPickReviewer(task)) secondary.push('delegate');
  if (hasChat && primary !== 'openChat') secondary.push('openChat');

  const more: FooterAction[] = [];
  if (!cancelled) more.push('move');
  if (queuePos > 0) more.push('unqueue');
  if (!isClosed(task)) more.push('cancel');
  more.push('delete');
  return { primary, goCard, secondary, more };
}
