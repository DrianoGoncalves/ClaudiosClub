import type { StaffQueue } from '../../../shared/model';
import { clockHM } from '../chat/wakeCountdown';
import { locale, t, type MsgKey } from '../i18n';
import { slotHolderLabel, type SlotHolder } from './ResourceWait';

/** Quem ocupa a vaga de escrita que o card `taskId` espera (ver `slotHolder`). */
export type SlotOf = (taskId: string) => SlotHolder | null;

// O estado da fila de cada funcionário (`GET /api/projects/:id/queues`, ver `TaskService.queueStates`) em frases de quem vê o quadro: por que a fila de alguém não anda.
// Livre e ocupado são só um aviso discreto; o que trava (recurso, consumo, entrega demorando, suíte esperando a vez) vem em destaque, com desde quando e o que fazer.
// "Projeto pausado" não entra aqui: a faixa do quadro (`PausedBanner`) já diz, para todos de uma vez.

/** A entrega só vira "trava" depois deste tempo em processamento: salvar resumo e commit leva segundos; passando disso, vale o dono saber. */
export const SLOW_DELIVERY_MS = 3 * 60_000;

export interface QueueRow {
  staffId: string;
  /** `stuck`: a fila não anda (destaque); `quiet`: andamento normal (discreto). */
  tone: 'stuck' | 'quiet';
  /** A frase inteira: quem, o quê, quantos esperam e desde quando. */
  text: string;
  /** O porquê em palavras (o motivo do servidor, o que a fila espera): só nas travas. */
  detail?: string;
  /** Fila parada pela vaga de escrita: o card que a ocupa, quando está na lista (o tooltip leva o link "Abrir"). */
  openTaskId?: string;
}

/** Uma bolinha do quadro: quem está ocupado em Fazendo (executando, entregando, ou com a fila travada) ou em Revisão (revisando), e o texto que aparece no hover. */
export interface QueueDot {
  staffId: string;
  column: 'doing' | 'review';
  /** `stuck`: a fila não anda (bolinha de alerta, visível sem hover); `busy`: andamento normal. */
  tone: 'busy' | 'stuck';
  text: string;
  detail?: string;
  openTaskId?: string;
}

/** Só o que as bolinhas leem de um card: a revisão pedida e ainda sem resposta (o turno do revisor não terminou, nem foi substituída por uma entrega nova). */
type ReviewTask = { id: string; status: string; archived?: boolean; review?: { staffId: string; doneAt?: string; verdict?: unknown; superseded?: boolean } | null };

/**
 * As bolinhas de Fazendo e Revisão. Fazendo vem do estado da fila (`queueRows`, as mesmas frases): ocupado, entregando ou fila travada; livre e pausado não têm bolinha, e a fila vazia
 * não esconde quem está ocupado. Revisão vem dos cards em revisão com o pedido ao revisor ainda aberto (`Task.review`); quem revisa por uma conversa sem card na fila não aparece duas vezes.
 */
export function queueDots(
  queues: StaffQueue[] | null | undefined,
  tasks: ReviewTask[] | null | undefined,
  nameOf: (staffId: string) => string | null,
  titleOf: (taskId: string) => string,
  now: number,
  only = '',
  slotOf?: SlotOf,
): QueueDot[] {
  const reviewing = new Map<string, string[]>();
  for (const t of tasks ?? []) {
    const r = t.review;
    if (t.status !== 'review' || t.archived || !r || r.doneAt || r.verdict || r.superseded || (only && r.staffId !== only)) continue;
    reviewing.set(r.staffId, [...(reviewing.get(r.staffId) ?? []), titleOf(t.id)]);
  }
  const state = new Map((queues ?? []).map((q) => [q.staffId, q] as const));
  const dots: QueueDot[] = [];
  for (const r of queueRows(queues, nameOf, titleOf, now, only, true, slotOf)) {
    const q = state.get(r.staffId);
    if (!q || q.state === 'free') continue;
    // Ocupado sem card, com revisão aberta: a conversa dele é a revisão, que já tem a bolinha em Revisão.
    if (q.state === 'busy' && !q.taskId && reviewing.has(r.staffId)) continue;
    dots.push({ staffId: r.staffId, column: 'doing', tone: r.tone === 'stuck' ? 'stuck' : 'busy', text: r.text, ...(r.detail && { detail: r.detail }), ...(r.openTaskId && { openTaskId: r.openTaskId }) });
  }
  for (const [staffId, titles] of reviewing) {
    dots.push({ staffId, column: 'review', tone: 'busy', text: t('tasks.queueReviewing', { name: nameOf(staffId) ?? staffId, task: titles.join(', ') }) });
  }
  return dots;
}

/** "desde 14:32" (hoje) / "desde 17/11, 14:32"; vazio se não há horário que se leia. */
export function queueSince(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return '';
  const today = new Date(now).toDateString() === new Date(at).toDateString();
  const when = today ? clockHM(at) : new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return t('tasks.queueSince', { when });
}

/**
 * Uma linha por funcionário que tem card na fila ("a fazer"), na ordem recebida. Quem não tem card esperando não aparece (não há fila a explicar), nem o estado pausado.
 * `nameOf` e `titleOf` dão o nome dele e o rótulo do card (o título, ou o id se o card não está na lista); `only` mostra só um funcionário (o filtro do quadro).
 */
export function queueRows(
  queues: StaffQueue[] | null | undefined,
  nameOf: (staffId: string) => string | null,
  titleOf: (taskId: string) => string,
  now: number,
  only = '',
  /** Sem card esperando também entra (as bolinhas mostram quem está ocupado mesmo com a fila vazia). */
  empty = false,
  /** Quem ocupa a vaga de escrita que o card esperando (`StaffQueue.taskId`) aguarda; null/ausente: a espera é do gate de recursos. */
  slotOf?: SlotOf,
): QueueRow[] {
  const rows: QueueRow[] = [];
  for (const q of queues ?? []) {
    if ((q.queued < 1 && !empty) || q.state === 'paused' || (only && q.staffId !== only)) continue;
    const since = queueSince(q.since, now);
    const base = { name: nameOf(q.staffId) ?? q.staffId, n: q.queued, task: q.taskId ? titleOf(q.taskId) : '', since: since ? ` · ${since}` : '' };
    const row = (tone: QueueRow['tone'], key: MsgKey, detail?: string, extra: Record<string, string | number> = {}): QueueRow => ({
      staffId: q.staffId,
      tone,
      text: t(key, { ...base, ...extra }),
      ...(detail && { detail }),
    });
    switch (q.state) {
      case 'free':
        rows.push(row('quiet', 'tasks.queueStFree'));
        break;
      case 'busy':
        rows.push(row('quiet', q.taskId ? 'tasks.queueStBusy' : 'tasks.queueBusyChat'));
        break;
      case 'resource-wait': {
        // A fila parada pela vaga de escrita tem texto próprio (o servidor manda o motivo em pt-BR; aqui ele vira frase do idioma da tela, com o card que ocupa).
        const slot = q.taskId ? slotOf?.(q.taskId) : null;
        if (slot) rows.push({ ...row('stuck', 'tasks.queueSlot', t('tasks.slotWaitHint'), { holder: slotHolderLabel(slot) }), ...(slot.title !== null && { openTaskId: slot.id }) });
        else rows.push(row('stuck', 'tasks.queueResource', q.detail));
        break;
      }
      case 'usage-limit':
        rows.push(row('stuck', 'tasks.queueUsage', q.detail));
        break;
      case 'heavy-wait': {
        const holder = q.deliveries.find((d) => d.taskId === q.taskId)?.holder;
        rows.push(row('stuck', holder ? 'tasks.queueHeavyHolder' : 'tasks.queueHeavy', t('tasks.queueHeavyHint'), { holder: holder ?? '' }));
        break;
      }
      case 'delivering': {
        const started = Date.parse(q.since ?? '');
        // Só `saving` segura a fila (resumo e commit, na vez dele): testes, aviso e pedido de revisão seguem em paralelo e não travam ninguém.
        const saving = q.phase === 'saving';
        const slow = saving && Number.isFinite(started) && now - started >= SLOW_DELIVERY_MS;
        rows.push(row(slow ? 'stuck' : 'quiet', saving ? 'tasks.queueDeliverSaving' : 'tasks.queueDeliver', slow ? t('tasks.queueDeliverHint') : undefined));
        break;
      }
    }
  }
  return rows;
}
