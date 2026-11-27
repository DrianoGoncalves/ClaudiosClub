import type { FollowUp, InboxItem, Task } from '../../../shared/model';
import { ApiError } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { offlineMessageKey } from '../serverStatus';
import type { Tr } from '../inbox/secretText';

// Follow-up de revisão (`Task.followUps`): a melhoria que o revisor achou DEPOIS de aprovar. Não vira card sozinha: o gestor que pediu a tarefa (ou
// você, pela tela) cria o card pelo fluxo de sempre e marca "virou card", ou descarta. Falha que invalida a aprovação não é follow-up: é reprovação.
// Os textos saem dos campos do servidor (não de `note`/mensagens em pt-BR), então seguem o idioma da tela; só o `text` do autor e o `note` vão como vieram.

type NameOf = (id: string | null) => string | null;

/** Quanto do texto do autor a caixa mostra sem abrir (o resto fica em "ver o texto"). */
export const FOLLOWUP_LINE = 140;

/** O corpo de `POST .../followup/:id/resolve`: `cardId` só com 'card'; `reason` só com 'discarded' (uma linha, opcional). */
export type FollowUpDecision = { resolution: 'card'; cardId?: string } | { resolution: 'discarded'; reason?: string };

/** O corpo do POST de cada saída: o card só vai com "virou card" (e só se indicado), o motivo só com "descartar" (aparado, e só se escrito). O servidor recusa `cardId` num descarte. */
export function decisionOf(mode: 'card', cardId: string): FollowUpDecision;
export function decisionOf(mode: 'discard', reason: string): FollowUpDecision;
export function decisionOf(mode: 'card' | 'discard', value: string): FollowUpDecision {
  const v = value.trim();
  if (mode === 'card') return { resolution: 'card', ...(v && { cardId: v }) };
  return { resolution: 'discarded', ...(v && { reason: v }) };
}

export const followUpsOf = (task: Pick<Task, 'followUps'>): FollowUp[] => task.followUps ?? [];

/** Os que esperam decisão (a conta do selo do cartão). */
export const openFollowUps = (task: Pick<Task, 'followUps'>): FollowUp[] => followUpsOf(task).filter((f) => f.status === 'open');

/** "1 follow-up aberto" / "2 follow-ups abertos": o texto do selo do cartão. */
export const followUpBadgeText = (open: number, tr: Tr = t): string => tr(open === 1 ? 'tasks.fuBadgeOne' : 'tasks.fuBadgeOther', { n: open });

/** O autor como a tela o chama: o nome da ficha, ou "revisão" se ela saiu do projeto (nunca o id). O mesmo critério do cartão e da caixa, que é o do servidor (`followUpInboxItem`). */
export const authorName = (name: string | null | undefined, tr: Tr = t): string => name || tr('inbox.followUp.byFallback');

/** Quem registrou, pelo nome da ficha no quadro. */
export const followUpAuthor = (f: Pick<FollowUp, 'by'>, nameOf: NameOf, tr: Tr = t): string => authorName(nameOf(f.by), tr);

/** Quem decidiu: 'you' é o usuário (pela tela); senão o gestor, pelo nome da ficha. Sem ficha (saiu do projeto) ou sem registro, "alguém": nunca o id, como no autor. */
export function followUpDecider(f: Pick<FollowUp, 'resolvedBy'>, nameOf: NameOf, tr: Tr = t): string {
  if (f.resolvedBy === 'you') return tr('tasks.fuYou');
  return (f.resolvedBy && nameOf(f.resolvedBy)) || tr('tasks.fuSomeone');
}

export interface FollowUpState {
  kind: 'open' | 'card' | 'discarded';
  /** O selo curto ao lado do autor. */
  badge: string;
  /** O contexto, uma frase por linha: com quem está, ou quem decidiu e o porquê do descarte. */
  lines: string[];
}

/**
 * Em que pé está o follow-up. Aberto com o gestor: avisado (há quanto tempo) ou ainda tentando avisar (se o aviso se perde, passa para você).
 * Aberto com você: pedido por você ou o aviso ao gestor não chegou. Resolvido: virou card ou foi descartado, quem decidiu e quando.
 */
export function followUpState(f: FollowUp, ctx: { requestedBy?: string | null; nameOf: NameOf; now: number }, tr: Tr = t): FollowUpState {
  if (f.status === 'open') {
    if (f.to === 'owner') return { kind: 'open', badge: tr('tasks.fuOpen'), lines: [tr(f.escalatedAt ? 'tasks.fuWaitOwnerEscalated' : 'tasks.fuWaitOwner')] };
    const name = (ctx.requestedBy && ctx.nameOf(ctx.requestedBy)) || tr('tasks.fuManagerFallback');
    const line = f.notifyRetry
      ? tr('tasks.fuManagerRetry', { name })
      : f.deliveredAt
        ? tr('tasks.fuManagerAgo', { name, ago: formatAgo(ctx.now - Date.parse(f.deliveredAt)) })
        : tr('tasks.fuWaitManager', { name });
    return { kind: 'open', badge: tr('tasks.fuOpen'), lines: [line] };
  }
  const who = followUpDecider(f, ctx.nameOf, tr);
  const decided = tr('tasks.fuDecided', { who, ago: f.resolvedAt ? formatAgo(ctx.now - Date.parse(f.resolvedAt)) : '' }).trim();
  if (f.resolution === 'card') return { kind: 'card', badge: tr('tasks.fuCard'), lines: [decided] };
  return { kind: 'discarded', badge: tr('tasks.fuDiscarded'), lines: [decided, ...(f.note ? [tr('tasks.fuNote', { note: f.note })] : [])] };
}

/** Espaços e quebras colapsados em um só espaço, e aparado: como a linha da caixa mostra o texto. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** O texto do follow-up na caixa: a primeira linha do achado, cortada; o inteiro (até 600) abre em "ver o texto". */
export function followUpLine(text: string): string {
  const line = squash(text.split('\n').find((l) => l.trim()) ?? '');
  return line.length > FOLLOWUP_LINE ? `${line.slice(0, FOLLOWUP_LINE - 1)}…` : line;
}

/** O achado vai além da linha mostrada (mais linhas ou cortado)? Só então a caixa oferece "ver o texto". Compara com a mesma normalização da linha: espaço duplo não conta. */
export const followUpHasMore = (text: string): boolean => squash(text) !== followUpLine(text);

/** "“Tarefa” tem um follow-up de <quem> esperando você: <título>" no idioma atual (sem título, a primeira linha do achado); sem o `followUp` (servidor antigo), o `summary`. */
export function followUpText(item: Pick<InboxItem, 'summary' | 'followUp'>, tr: Tr = t): string {
  const f = item.followUp;
  if (!f) return item.summary;
  return tr('inbox.followUp.sentence', { task: f.taskTitle, by: authorName(f.byName, tr), line: f.title?.trim() ? squash(f.title) : followUpLine(f.text) });
}

/**
 * O que a tela diz quando decidir falha. Os casos que se conhecem saem do idioma da tela (o texto do servidor vem em pt-BR): 409 = já decidido por outro caminho; servidor fora do
 * ar (`code: 'offline'`, sem resposta). O resto segue com o texto do servidor; recusa por pareamento vem sem texto (o aviso do App já explica) e não mostra nada.
 */
export function decisionErrorText(err: unknown, tr: Tr = t): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return tr('tasks.fuErrDecided');
    if (err.code === 'offline') return tr(offlineMessageKey());
  }
  return err instanceof Error ? err.message : String(err);
}
