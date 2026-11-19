import type { FollowUp, InboxItem, StaffProfile, Task } from '../../../shared/model';
import { t } from '../i18n';
import type { Tr } from '../inbox/secretText';
import { decisionOf, followUpBadgeText, followUpLine, openFollowUps, type FollowUpDecision } from './followUp';

// O follow-up como balão na conversa de trabalho da tarefa (chat/FollowUpNotice.tsx), no selo do cartão e na caixa. Regras puras: quais itens são desta conversa e em que ordem
// (o "vale fazer" antes), o texto do selo, o rascunho do card que nasce dele, os motivos prontos de descarte e o "Finalizado" (a tarefa de origem já fechou).

/** Os campos estruturados do follow-up (o do `FollowUp` e o do item da caixa têm os mesmos). */
export type FollowUpFields = Pick<FollowUp, 'recommendation' | 'title' | 'impact' | 'size' | 'staffId'>;

/** Quem faria é da equipe: o que o select de responsável precisa. */
export type TeamMember = Pick<StaffProfile, 'id' | 'name'>;

/** O follow-up traz os campos que o revisor preenche? Os antigos (e os de quem não os mandou) não: a tela cai no texto, como antes. */
export const hasFields = (f: FollowUpFields): boolean => !!(f.recommendation || f.title || f.impact || f.size || f.staffId);

/** Vale fazer (0), opcional (1), sem recomendação (2). */
export const followUpRank = (f: Pick<FollowUp, 'recommendation'>): number => (f.recommendation === 'worth' ? 0 : f.recommendation === 'optional' ? 1 : 2);

/** O "vale fazer" antes; dentro do mesmo grau, o mais antigo primeiro. */
export function byWorth<T extends Pick<FollowUp, 'recommendation' | 'at'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => followUpRank(a) - followUpRank(b) || Date.parse(a.at) - Date.parse(b.at));
}

/** O item da caixa (kind 'followUp') com a mesma ordem: o `FollowUp` dele fica em `item.followUp`. */
export const byWorthItems = (items: readonly InboxItem[]): InboxItem[] =>
  [...items].sort((a, b) => followUpRank(a.followUp ?? {}) - followUpRank(b.followUp ?? {}) || (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0));

/** Os follow-ups da caixa que são desta conversa (o `sessionId` do item é a conversa de trabalho da tarefa), sem repetir id e com o "vale fazer" primeiro. Sem conversa, nenhum. */
export function followUpNoticesFor(inbox: readonly InboxItem[] | undefined, sessionId: string | null): InboxItem[] {
  if (!inbox || !sessionId) return [];
  const byId = new Map<string, InboxItem>();
  for (const item of inbox) if (item.kind === 'followUp' && item.followUp && item.sessionId === sessionId && !byId.has(item.id)) byId.set(item.id, item);
  return byWorthItems([...byId.values()]);
}

/** O item da caixa que leva à conversa de um follow-up aberto desta tarefa (o "vale fazer" primeiro): é para onde "Abrir conversa" vai. Sem ele, o card é o alvo. */
export function conversationItemFor(taskId: string, inbox: readonly InboxItem[] | undefined, projectId?: string): InboxItem | null {
  const mine = (inbox ?? []).filter((i) => i.kind === 'followUp' && !!i.sessionId && i.followUp?.taskId === taskId && (!projectId || i.projectId === projectId));
  return byWorthItems(mine)[0] ?? null;
}

/** Os ids dos follow-ups abertos desta tarefa que esperam na conversa de trabalho (há item da caixa com a conversa): o detalhe do card aponta para lá em vez de decidir. */
export function chatFollowUpIds(taskId: string, inbox: readonly InboxItem[] | undefined, projectId?: string): Set<string> {
  const ids = new Set<string>();
  for (const i of inbox ?? []) if (i.kind === 'followUp' && !!i.sessionId && i.followUp?.taskId === taskId && (!projectId || i.projectId === projectId)) ids.add(i.followUp.followUpId);
  return ids;
}

/**
 * O item com o funcionário da tarefa: o item do follow-up não leva `staffId` (não é conversa esperando) e o `followUp.staffId` é o de quem faria o ajuste, não o dono da conversa.
 * Quem abre a conversa precisa do dono dela, que está na tarefa; sem a tarefa, ou se a conversa dela não é a do item, null (abre-se o card).
 */
export function withTaskStaff(item: InboxItem, task: Pick<Task, 'sessionId' | 'staffId'> | null | undefined): InboxItem | null {
  if (!task?.sessionId || task.sessionId !== item.sessionId) return null;
  return { ...item, staffId: task.staffId };
}

/** A tarefa de origem já está Finalizada (a aprovação costuma fechá-la): o follow-up pede "Concluir" ou "Revisar", não "Criar card" ou "Descartar". */
export const taskFinished = (task: Pick<Task, 'status'> | null | undefined): boolean => task?.status === 'done';

/** O texto do follow-up inteiro: o da tarefa (o da caixa vem cortado em 600), senão o que o item traz. */
export function fullText(task: Pick<Task, 'followUps'> | null | undefined, followUpId: string, fallback: string): string {
  return task?.followUps?.find((f) => f.id === followUpId)?.text ?? fallback;
}

/** O selo do cartão: "2 follow-ups, 1 vale fazer"; sem nenhum "vale fazer", o de sempre ("2 follow-ups abertos"). */
export function followUpSummary(open: readonly Pick<FollowUp, 'recommendation'>[], tr: Tr = t): string {
  const worth = open.filter((f) => f.recommendation === 'worth').length;
  if (!worth) return followUpBadgeText(open.length, tr);
  return tr(open.length === 1 ? 'tasks.fuSumWorthOne' : 'tasks.fuSumWorthOther', { n: open.length, w: worth });
}

/**
 * O selo "Aprovada" do cartão vale só sem follow-up aberto: com ele, a tarefa não está toda resolvida e o selo de follow-ups pendentes ocupa o lugar. Decididos todos, volta.
 * A reprovação sempre aparece.
 */
export function verdictShown(task: Pick<Task, 'review' | 'followUps'>): boolean {
  const verdict = task.review?.verdict;
  if (!verdict) return false;
  return verdict !== 'approved' || openFollowUps(task).length === 0;
}

const SIZE_KEY = { small: 'tasks.fuSizeSmall', medium: 'tasks.fuSizeMedium', large: 'tasks.fuSizeLarge' } as const;

/** "pequeno" / "médio" / "grande" no idioma da tela; tamanho que a tela não conhece vira nada (não se mostra). */
export const sizeText = (size: FollowUpFields['size'], tr: Tr = t): string | null => (size && size in SIZE_KEY ? tr(SIZE_KEY[size]) : null);

/** O que o revisor escreveu para quem decide: o título leigo, ou (follow-up antigo) a primeira linha do achado. */
export const followUpTitle = (f: Pick<FollowUp, 'title' | 'text'>): string => f.title?.trim() || followUpLine(f.text);

/** Quem faria: o nome da ficha (o item da caixa já traz `staffName`), senão o da equipe; ficha que saiu do projeto, nada. */
export function whoWouldDo(f: Pick<FollowUp, 'staffId'> & { staffName?: string }, team: readonly TeamMember[]): string | null {
  if (!f.staffId) return null;
  return f.staffName || team.find((s) => s.id === f.staffId)?.name || null;
}

/** O que se edita antes de criar o card: responsável, título e descrição (a descrição é o achado inteiro). */
export interface CardDraft {
  staffId: string;
  title: string;
  description: string;
}

const TITLE_MAX = 120;

/**
 * O rascunho do card: título do follow-up (ou a primeira linha do achado, até 120), descrição = o achado, responsável = quem o revisor sugeriu. Com a tarefa Finalizada ("Revisar"),
 * o responsável é o da tarefa, que é quem ajusta o que entregou. Só vale quem está na equipe; senão "sem responsável" (o select mostra, o dono escolhe).
 */
export function cardDraft(f: Pick<FollowUp, 'title' | 'text' | 'staffId'>, ctx: { taskStaffId: string | null; finished: boolean; team: readonly TeamMember[] }): CardDraft {
  const prefer = ctx.finished ? [ctx.taskStaffId, f.staffId] : [f.staffId, ctx.taskStaffId];
  const staffId = prefer.find((id): id is string => !!id && ctx.team.some((s) => s.id === id)) ?? '';
  const title = followUpTitle(f);
  return { staffId, title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title, description: f.text };
}

/** O corpo de `POST .../followup/:id/card`: o responsável sempre; título e descrição só se o dono mexeu (sem eles o servidor usa o título e o achado inteiro do follow-up). */
export interface CardBody {
  staffId: string | null;
  title?: string;
  description?: string;
}

export function cardBody(draft: CardDraft, initial: CardDraft): CardBody {
  const title = draft.title.trim();
  const description = draft.description.trim();
  return {
    staffId: draft.staffId || null,
    ...(title && title !== initial.title.trim() && { title }),
    ...(description && description !== initial.description.trim() && { description }),
  };
}

/** Os motivos prontos de descarte, na ordem da tela; o último é o texto livre. */
export const DISCARD_REASONS = ['cost', 'done', 'scope', 'other'] as const;
export type DiscardReason = (typeof DISCARD_REASONS)[number];

const REASON_KEY = {
  cost: 'tasks.fuReasonCost',
  done: 'tasks.fuReasonDone',
  scope: 'tasks.fuReasonScope',
  other: 'tasks.fuReasonOther',
} as const;

export const discardReasonLabel = (reason: DiscardReason, tr: Tr = t): string => tr(REASON_KEY[reason]);

/** O motivo que vai no descarte: o pronto, no idioma da tela, ou o que o dono escreveu; "outro" sem texto não vale (null). */
export function discardReasonText(reason: DiscardReason | null, other: string, tr: Tr = t): string | null {
  if (!reason) return null;
  if (reason !== 'other') return discardReasonLabel(reason, tr);
  return other.trim() || null;
}

/** O motivo de "Concluir" (rota de descarte): o follow-up não pede ajuste. */
export const concludedReason = (tr: Tr = t): string => tr('tasks.fuConcluded');

/** "Descartar": o corpo da rota `resolve` com o motivo escolhido; sem motivo válido (nenhum marcado, ou "outro" sem texto), null: o botão fica desligado. */
export function discardDecision(reason: DiscardReason | null, other: string, tr: Tr = t): FollowUpDecision | null {
  const text = discardReasonText(reason, other, tr);
  return text ? decisionOf('discard', text) : null;
}

/** "Concluir": a mesma rota de descarte, com o motivo "concluído sem ajuste". O follow-up da tarefa Finalizada some da caixa sem virar card. */
export const concludeDecision = (tr: Tr = t): FollowUpDecision => decisionOf('discard', concludedReason(tr));
