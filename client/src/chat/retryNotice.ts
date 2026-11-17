import { t, type MsgKey } from '../i18n';
import type { Tr } from '../inbox/secretText';
import { countdown } from '../schedules/scheduleView';
import { clockHM } from './wakeCountdown';

// Avisos da retomada automática (server/chat/turnRetry.ts e turnCap.ts). O aviso do servidor leva o estado em campos: `retry`
// (espera e desfecho: `state`, `attempt`, `max`, `at` em epoch ms, e o motivo em `error`, se vier) e `cap` (desistiu e não retomou
// por ação externa incerta, o `TurnCapHit` que o tipo do aviso já tem). Daí sai a frase no idioma da página, a contagem por
// segundo e a hora no relógio do navegador. O texto em pt-BR do servidor só é lido (`retryFromText`) quando o aviso não traz o campo
// (aviso antigo, servidor anterior); é o único lugar que depende da frase do servidor, e `tests/retryNotice.test.ts` a confere.

export const RETRY_NOTICE_PREFIX = 'n:retry:';

export type RetryNotice =
  /** `at`: o instante em ms (aviso com campo, contagem por segundo); sem ele, só a hora `clock` do texto (contagem por minuto). `label`: o motivo, se o aviso o diz. */
  | { state: 'waiting'; label: string | null; attempt: number; max: number; at: number | null; clock: string | null }
  | { state: 'sent'; attempt: number; max: number }
  | { state: 'cancelled' }
  | { state: 'failed'; error: string | null }
  | { state: 'dropped' }
  | { state: 'exhausted'; label: string; attempts: number }
  | { state: 'cut'; label: string; action: string }
  | { state: 'restart'; action: string };

/** O que a tela lê do item do aviso: `retry` ainda não está no tipo compartilhado (contrato local, ver `retryOfField`); `cap` já está. */
export interface RetryNoticeSource {
  id?: string;
  text: string;
  retry?: unknown;
  cap?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v : null);

/**
 * `retry` do aviso: `{ state: 'waiting'|'sent'|'cancelled'|'failed'|'dropped', attempt?, max?, at? (epoch ms, UTC, só em waiting), error? }`.
 * A espera precisa de tentativa, teto e horário; "retomou", de tentativa e teto; campo incompleto ou estado desconhecido: null (cai no texto).
 */
function retryOfField(field: unknown): RetryNotice | null {
  const r = asRecord(field);
  const error = short(r.error, 300);
  switch (r.state) {
    case 'waiting': {
      const at = r.at;
      if (!count(r.attempt) || !count(r.max) || typeof at !== 'number' || !Number.isFinite(new Date(at).getTime())) return null;
      return { state: 'waiting', label: error, attempt: r.attempt, max: r.max, at, clock: null };
    }
    case 'sent':
      return count(r.attempt) && count(r.max) ? { state: 'sent', attempt: r.attempt, max: r.max } : null;
    case 'cancelled':
      return { state: 'cancelled' };
    case 'failed':
      return { state: 'failed', error };
    case 'dropped':
      return { state: 'dropped' };
    default:
      return null;
  }
}

/** `cap` do aviso (`TurnCapHit`): desistiu depois das tentativas, não retomou por ação cortada, ou o reinício cortou a ação. O teto de ferramentas/minutos não é daqui. */
function retryOfCap(cap: unknown): RetryNotice | null {
  const c = asRecord(cap);
  const action = short(c.action, 2000);
  const error = short(c.error, 300);
  if (c.kind === 'restart') return action ? { state: 'restart', action } : null;
  if (c.kind !== 'retry' || !error) return null;
  if (c.why === 'exhausted') return count(c.attempts) ? { state: 'exhausted', label: error, attempts: c.attempts } : null;
  if (c.why === 'cut') return action ? { state: 'cut', label: error, action } : null;
  return null;
}

const WAITING = /^Falha passageira \((.+)\)\. Tento de novo sozinho às (\d{2}:\d{2})h \(tentativa (\d+) de (\d+)\)\.$/;
const SENT = /^Retomou sozinho \(tentativa (\d+) de (\d+)\)\.$/;
const FAILED = /^Não deu para retomar sozinho \(([\s\S]+)\)\. Mande uma mensagem quando quiser\.$/;
const EXHAUSTED = /^A conversa caiu \((.+)\) e não voltou depois de (\d+) tentativas? automáticas?\. Mande mensagem para seguir$/;
const CUT = /^Não retomada sozinha \((.+)\): a conversa parou no meio de "([\s\S]+)"\. Confira se aconteceu e mande mensagem para seguir$/;
const RESTART = /^Não retomada: a conversa parou no meio de "([\s\S]+)"\. Confira se aconteceu e mande mensagem para seguir$/;

/**
 * FALLBACK: o aviso sem `retry` nem `cap` (aviso antigo): lê a frase em pt-BR do servidor. Os de espera e de desfecho só valem com o id
 * (`n:retry:`); os de "não voltou" e "não retomou" não têm id próprio e são reconhecidos pela frase inteira. Qualquer outro texto: null.
 * A hora vem só em HH:MM, no relógio do servidor: a contagem é por minuto e só vale perto (ver `retryMinutesLeft`).
 */
export function retryFromText(item: { id?: string; text: string }): RetryNotice | null {
  const text = item.text;
  if (item.id?.startsWith(RETRY_NOTICE_PREFIX)) {
    let m = WAITING.exec(text);
    if (m) return { state: 'waiting', label: m[1]!, attempt: Number(m[3]), max: Number(m[4]), at: null, clock: m[2]! };
    m = SENT.exec(text);
    if (m) return { state: 'sent', attempt: Number(m[1]), max: Number(m[2]) };
    m = FAILED.exec(text);
    if (m) return { state: 'failed', error: m[1]! };
    if (text === 'Retomada automática cancelada.') return { state: 'cancelled' };
    if (text === 'Retomada automática desligada: não vou retomar sozinho. Mande uma mensagem quando quiser.') return { state: 'dropped' };
  }
  let m = EXHAUSTED.exec(text);
  if (m) return { state: 'exhausted', label: m[1]!, attempts: Number(m[2]) };
  m = CUT.exec(text);
  if (m) return { state: 'cut', label: m[1]!, action: m[2]! };
  m = RESTART.exec(text);
  if (m) return { state: 'restart', action: m[1]! };
  return null;
}

/** O que o aviso diz, em partes: os campos do servidor primeiro, o texto (`retryFromText`) só quando eles não vêm. Não é da retomada: null. */
export function parseRetryNotice(item: RetryNoticeSource): RetryNotice | null {
  return retryOfField(item.retry) ?? retryOfCap(item.cap) ?? retryFromText(item);
}

const LABELS: Record<string, MsgKey> = {
  'API sobrecarregada': 'chat.retryLabel.overloaded',
  'limite de taxa da API': 'chat.retryLabel.rateLimit',
  'API com muita demanda': 'chat.retryLabel.demand',
  'falha de conexão com a API': 'chat.retryLabel.connection',
  'o processo caiu sem aviso': 'chat.retryLabel.crashed',
};

/** O motivo curto da queda (`labelOf` do servidor, em pt-BR) no idioma da página; um motivo novo no servidor volta como veio. */
export function retryLabelText(label: string, tr: Tr = t): string {
  const key = LABELS[label];
  if (key) return tr(key);
  const status = /^erro (\d{3}) da API$/.exec(label);
  return status ? tr('chat.retryLabel.status', { status: status[1]! }) : label;
}

/**
 * Só no aviso sem horário exato (texto): minutos até a hora `clock` (HH:MM), ou null quando não dá para dizer. A conta é por minuto
 * ("em cerca de N min") e só vale perto: a espera de uma retomada é de no máximo 15 min; mais longe é a linha de parada de consumo
 * que adiou, e aí o aviso mostra só a hora. Passou do horário por até 1 min: 0 (está saindo).
 */
export function retryMinutesLeft(clock: string, now: number): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const target = new Date(now);
  target.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const diff = target.getTime() - now;
  if (diff < -60_000 || diff > 20 * 60_000) return null;
  return Math.max(0, Math.ceil(diff / 60_000));
}

/** De quanto em quanto tempo a contagem do aviso precisa ser refeita: 1 s com o horário exato, 15 s no texto; null = não espera, sem relógio. */
export function retryTickMs(n: RetryNotice | null): number | null {
  if (n?.state !== 'waiting') return null;
  return n.at !== null ? 1000 : 15_000;
}

/** Onde o texto vai: o chat leva a frase a mais de que a caixa "precisa de mim" foi avisada; a própria caixa não. */
export type RetryWhere = 'chat' | 'inbox';

const inParens = (text: string | null): string => (text ? ` (${text})` : '');

/** A frase de um aviso já lido, no idioma da página. */
export function retryNoticeText(n: RetryNotice, now: number, where: RetryWhere = 'chat', tr: Tr = t): string {
  switch (n.state) {
    case 'waiting': {
      const vars = { label: inParens(n.label && retryLabelText(n.label, tr)), n: n.attempt, max: n.max };
      if (n.at !== null) {
        const secs = Math.ceil((n.at - now) / 1000);
        if (secs <= 0) return tr('chat.retryNow', vars);
        return tr('chat.retryWaitingIn', { ...vars, time: clockHM(n.at), in: countdown(new Date(n.at).toISOString(), now, tr) });
      }
      const time = n.clock ?? '';
      const left = retryMinutesLeft(time, now);
      if (left === 0) return tr('chat.retryNow', vars);
      return left === null ? tr('chat.retryWaiting', { ...vars, time }) : tr('chat.retryWaitingIn', { ...vars, time, in: tr('chat.retryIn', { n: left }) });
    }
    case 'sent':
      return tr('chat.retrySent', { n: n.attempt, max: n.max });
    case 'cancelled':
      return tr('chat.retryCancelled');
    case 'failed':
      return tr('chat.retryFailed', { error: inParens(n.error) });
    case 'dropped':
      return tr('chat.retryDropped');
    case 'exhausted': {
      const label = retryLabelText(n.label, tr);
      const base = n.attempts === 1 ? tr('chat.retryExhaustedOne', { label }) : tr('chat.retryExhaustedOther', { label, n: n.attempts });
      return where === 'chat' ? `${base} ${tr('chat.retryInboxNote')}` : base;
    }
    case 'cut': {
      const base = tr('chat.retryCut', { label: retryLabelText(n.label, tr), action: n.action });
      return where === 'chat' ? `${base} ${tr('chat.retryInboxNote')}` : base;
    }
    case 'restart': {
      const base = tr('chat.retryRestart', { action: n.action });
      return where === 'chat' ? `${base} ${tr('chat.retryInboxNote')}` : base;
    }
  }
}
