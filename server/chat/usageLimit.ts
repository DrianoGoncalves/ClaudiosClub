// Limite de uso da assinatura estourado no meio de uma conversa: como reconhecer no stream do claude
// e quando ele volta. Só funções puras (sem processo), para testar cada formato.

export type LimitWindow = 'five_hour' | 'seven_day';

/** O que o stream disse sobre o limite estourado. */
export interface LimitHit {
  /** Quando o limite volta (ms desde 1970), se o claude disse. */
  resetsAt: number | null;
  /** Qual janela estourou, quando dá para saber. */
  window: LimitWindow | null;
}

/** Folga depois do reset, para o limite já estar de volta quando a mensagem for. */
export const SLACK_MS = 60_000;
/** Sem nenhuma hora conhecida: tenta de novo daqui a tanto. */
export const RETRY_MS = 30 * 60_000;
/** Estouros seguidos na mesma conversa (sem um turno normal no meio): neste, o "continue" sozinho desiste. */
export const MAX_LIMIT_HITS = 5;

/** Época em segundos (como o claude manda) ou em milissegundos, número ou texto → ms; null se não for hora. */
function epochMs(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n < 1e11 ? n * 1000 : n);
}

/** Nome da janela do claude (`five_hour`, `seven_day`, `seven_day_opus`…) → janela que o Claudio’s Club conhece. */
export function windowOf(kind: string): LimitWindow | null {
  if (kind === 'five_hour') return 'five_hour';
  if (kind.startsWith('seven_day')) return 'seven_day';
  return null;
}

/**
 * `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":<segundos>,"rateLimitType":"five_hour"}}`.
 * Só `rejected` conta: `allowed` e `allowed_warning` são só o consumo andando.
 */
export function limitFromRateLimitEvent(ev: unknown): LimitHit | null {
  const e = ev as { type?: unknown; rate_limit_info?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown } } | null;
  if (e?.type !== 'rate_limit_event' || e.rate_limit_info?.status !== 'rejected') return null;
  const kind = e.rate_limit_info.rateLimitType;
  return { resetsAt: epochMs(e.rate_limit_info.resetsAt), window: typeof kind === 'string' ? windowOf(kind) : null };
}

const LIMIT_TEXT = /usage limit|limit reached|hit your limit/i;
// "Context limit reached ∙ /compact or /clear to continue" é a janela de contexto da conversa, não a assinatura.
const NOT_THE_PLAN = /context|output token|token limit|\/compact|\/clear/i;
const EPOCH_AFTER_BAR = /\|\s*(\d{9,13})\b/;
const WEEKLY = /weekly|7[- ]day|seven[ _-]day|week/i;
const SESSION = /5[- ]hour|five[ _-]hour|session/i;
/** Uma mensagem de erro é curta; texto longo que cita "limit reached" é conversa, não o aviso do claude. */
const MAX_TEXT = 400;

/**
 * Texto de erro de limite: "Claude AI usage limit reached|<época>", "5-hour limit reached ∙ resets 3pm",
 * "You've hit your limit · resets 3pm (America/Sao_Paulo)", "Session limit reached", "Weekly limit reached".
 * A hora só sai quando vem a época depois da barra; o "resets 3pm" não é lido (sem data nem fuso confiável).
 */
export function limitFromText(text: unknown): LimitHit | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || t.length > MAX_TEXT || !LIMIT_TEXT.test(t) || NOT_THE_PLAN.test(t)) return null;
  const epoch = EPOCH_AFTER_BAR.exec(t);
  return { resetsAt: epoch ? epochMs(epoch[1]) : null, window: WEEKLY.test(t) ? 'seven_day' : SESSION.test(t) ? 'five_hour' : null };
}

/** Junta dois avisos do mesmo turno (o evento e o texto): fica com a hora e a janela que um deles souber. */
export function mergeHits(a: LimitHit | null, b: LimitHit): LimitHit {
  return { resetsAt: a?.resetsAt ?? b.resetsAt, window: a?.window ?? b.window };
}

export interface ResumePlan {
  /** Quando o limite volta. */
  resetsAt: number;
  /** Quando mandar o "continue" (a volta mais a folga). */
  at: number;
  source: 'reported' | 'window' | 'fallback';
}

/**
 * Hora de voltar: a que o claude disse (se ainda está no futuro); senão o reset mais próximo no futuro das
 * janelas conhecidas (da que estourou, se der para saber); senão daqui a 30 min. Reset já passado não serve:
 * mandaria na hora e voltaria a bater no limite.
 */
export function resumePlan(
  hit: Pick<LimitHit, 'resetsAt' | 'window'>,
  known: ReadonlyArray<{ kind: string; resetsAt: string | null }>,
  now: number,
): ResumePlan {
  if (hit.resetsAt !== null && hit.resetsAt > now) return { resetsAt: hit.resetsAt, at: hit.resetsAt + SLACK_MS, source: 'reported' };
  const future = known
    .map((l) => ({ window: windowOf(l.kind), t: l.resetsAt ? Date.parse(l.resetsAt) : NaN }))
    .filter((l) => l.t > now);
  const same = hit.window ? future.filter((l) => l.window === hit.window) : [];
  const pool = same.length ? same : future;
  if (pool.length) {
    const t = Math.min(...pool.map((l) => l.t));
    return { resetsAt: t, at: t + SLACK_MS, source: 'window' };
  }
  return { resetsAt: now + RETRY_MS, at: now + RETRY_MS, source: 'fallback' };
}

// ---- textos do aviso na conversa ----

const two = (n: number) => String(n).padStart(2, '0');

/** "às 15:00" (hoje) ou "dia 08/11 às 15:00", na hora desta máquina. */
export function clockText(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? `às ${hm}` : `dia ${two(d.getDate())}/${two(d.getMonth() + 1)} às ${hm}`;
}

export const limitNotice = {
  /** Com a opção ligada: vai continuar sozinha (o aviso leva o botão Cancelar). */
  waiting: (resetsAt: number, now: number) => `Limite de uso atingido. Continua sozinha ${clockText(resetsAt, now)}.`,
  /** Cancelada ou com a opção desligada: só conta quando o limite volta. */
  back: (resetsAt: number, now: number) => `Limite de uso atingido. Volta ${clockText(resetsAt, now)}.`,
  continued: (now: number) => `Continuou sozinha ${clockText(now, now)}.`,
  failed: (error: string) => `Limite de uso atingido. Não deu para continuar sozinha (${error}). Mande "continue" quando quiser.`,
  /** Estourou `MAX_LIMIT_HITS` vezes seguidas: desistiu (sem botão). */
  gaveUp: 'Não deu para continuar sozinha depois de várias tentativas; mande uma mensagem quando quiser.',
};
