// Recorrência das rotinas (ver `Recurrence` em shared/model.ts): validação, ocorrências numa janela, próxima, última e descrição.
// Funções puras, no horário desta máquina; o servidor (agendador e rotas) e a tela usam as mesmas. Sem lib de cron/RRULE: o cron de
// 5 campos é o de shared/cron.ts e o calendário (único, diário, semanal, mensal) é conta de dia.
//
// Horário que não existe (a hora pulada na virada do horário de verão) cai na hora seguinte, como no `Date` do JavaScript; hora repetida
// vale a primeira. A conta de dias usa UTC só para contar dias inteiros, então a virada não desloca a semana nem o mês.

import { cronDayMatches, cronError, describeCron, parseCron } from './cron';
import type { CalendarRecurrence, Recurrence, Routine } from './model';

/** Domingo: a semana do calendário vai de domingo a sábado, e a de `start` é a primeira (ancora o quinzenal). */
export const WEEK_STARTS_ON = 0;
/** Maior `interval` por tipo (em dias, semanas e meses). */
export const INTERVAL_MAX = { daily: 365, weekly: 52, monthly: 12 } as const;

const DAY_MS = 86_400_000;
/** Teto de dias que uma busca anda (10 anos): defesa contra janela absurda. */
const MAX_SCAN_DAYS = 3700;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, '0');

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayNum = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
const weekdayOf = (dn: number) => new Date(dn * DAY_MS).getUTCDay();

/** 'YYYY-MM-DD' de um dia que existe (1970 a 2200); senão null. */
export function parseDay(value: unknown): Ymd | null {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

/** O dia local de uma data, como 'YYYY-MM-DD'. */
export function dayString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export type RecurrenceParse = { ok: true; value: Recurrence } | { ok: false; error: string };
const fail = (error: string): RecurrenceParse => ({ ok: false, error });

/**
 * Confere a recorrência e devolve a forma normal (chaves na mesma ordem, o que não vale para o tipo some, padrões preenchidos: `interval` 1,
 * `weekdays` = dia de `start`, `monthDay` = dia de `start`). Erro com a explicação em português.
 */
export function normalizeRecurrence(input: unknown): RecurrenceParse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('recorrência inválida');
  const r = input as Record<string, unknown>;
  if (r.kind === 'cron') {
    if (typeof r.expr !== 'string') return fail('horário: informe a expressão cron');
    const expr = r.expr.trim();
    if (expr.length > 100) return fail('horário: expressão longa demais');
    const err = cronError(expr);
    return err ? fail(`horário: ${err}`) : { ok: true, value: { kind: 'cron', expr } };
  }
  const kind = r.kind;
  if (kind !== 'once' && kind !== 'daily' && kind !== 'weekly' && kind !== 'monthly') return fail('tipo de recorrência inválido: use cron, once, daily, weekly ou monthly');
  if (typeof r.time !== 'string' || !TIME.test(r.time)) return fail('horário: use HH:MM (de 00:00 a 23:59)');
  const start = parseDay(r.start);
  if (!start) return fail('início: use uma data que exista, no formato AAAA-MM-DD');
  const startStr = r.start as string;
  const value: CalendarRecurrence = { kind, interval: 1, time: r.time, start: startStr };
  if (kind !== 'once') {
    const max = INTERVAL_MAX[kind];
    const interval = r.interval === undefined || r.interval === null ? 1 : r.interval;
    if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > max) return fail(`intervalo: use um número inteiro de 1 a ${max}`);
    value.interval = interval;
  }
  if (kind === 'weekly') {
    const days = r.weekdays === undefined || r.weekdays === null ? [weekdayOf(dayNum(start.y, start.m, start.d))] : r.weekdays;
    if (!Array.isArray(days) || days.length < 1 || days.length > 7 || !days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
      return fail('dias da semana: use de 0 (domingo) a 6 (sábado), pelo menos um');
    }
    value.weekdays = [...new Set(days as number[])].sort((a, b) => a - b);
  }
  if (kind === 'monthly') {
    const day = r.monthDay === undefined || r.monthDay === null ? start.d : r.monthDay;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) return fail('dia do mês: use de 1 a 31');
    value.monthDay = day;
  }
  if (kind !== 'once' && r.until !== undefined && r.until !== null && r.until !== '') {
    if (!parseDay(r.until)) return fail('"até": use uma data que exista, no formato AAAA-MM-DD');
    if ((r.until as string) < startStr) return fail('"até" não pode ser antes do início');
    value.until = r.until as string;
  }
  // Ordem fixa das chaves: a forma normal serve de impressão digital (ver `recurrenceKey`).
  const { kind: k, interval, weekdays, monthDay, time, start: s, until } = value;
  return { ok: true, value: { kind: k, interval, ...(weekdays && { weekdays }), ...(monthDay !== undefined && { monthDay }), time, start: s, ...(until && { until }) } };
}

/** Mensagem de erro, ou null se a recorrência é válida. */
export function recurrenceError(rec: unknown): string | null {
  const p = normalizeRecurrence(rec);
  return p.ok ? null : p.error;
}

/** A recorrência de uma rotina: `recurrence` se houver; senão o `schedule` cron (ficha antiga). Sem validar. */
export function recurrenceOf(r: Pick<Routine, 'schedule' | 'recurrence'>): Recurrence {
  return r.recurrence ?? { kind: 'cron', expr: r.schedule };
}

/** Impressão digital da recorrência: muda quando o "quando roda" muda (e só então). Inválida: o JSON como veio. */
export function recurrenceKey(rec: Recurrence): string {
  const p = normalizeRecurrence(rec);
  return JSON.stringify(p.ok ? p.value : rec);
}

// ---- ocorrências ----

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dateAt = (day: Date, hh: number, mm: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);

interface Compiled {
  /** As ocorrências do dia local (meia-noite de `day`), em ordem. */
  times: (day: Date) => Date[];
  /** Primeiro e último dia em que pode haver ocorrência (calendário); null = sem limite (cron). */
  first: Date | null;
  last: Date | null;
}

function compile(rec: Recurrence): Compiled {
  if (rec.kind === 'cron') {
    const spec = parseCron(rec.expr);
    const hours = [...spec.hour].sort((a, b) => a - b);
    const minutes = [...spec.minute].sort((a, b) => a - b);
    return {
      times: (day) => (cronDayMatches(spec, day) ? hours.flatMap((h) => minutes.map((m) => dateAt(day, h, m))) : []),
      first: null,
      last: null,
    };
  }
  const s = parseDay(rec.start);
  if (!s || !TIME.test(rec.time)) throw new Error('recorrência inválida');
  const [hh, mm] = rec.time.split(':').map(Number) as [number, number];
  const sn = dayNum(s.y, s.m, s.d);
  const u = rec.until ? parseDay(rec.until) : null;
  const un = u ? dayNum(u.y, u.m, u.d) : Infinity;
  const interval = Math.max(1, rec.interval | 0);
  const days = rec.weekdays?.length ? rec.weekdays : [weekdayOf(sn)];
  const weekZero = sn - ((weekdayOf(sn) - WEEK_STARTS_ON + 7) % 7);
  const monthDay = rec.monthDay ?? s.d;
  const matches = (y: number, m: number, d: number): boolean => {
    const dn = dayNum(y, m, d);
    if (dn < sn || dn > un) return false;
    if (rec.kind === 'once') return dn === sn;
    if (rec.kind === 'daily') return (dn - sn) % interval === 0;
    if (rec.kind === 'weekly') return days.includes(weekdayOf(dn)) && Math.floor((dn - weekZero) / 7) % interval === 0;
    const months = (y - s.y) * 12 + (m - s.m);
    return months >= 0 && months % interval === 0 && d === Math.min(monthDay, daysInMonth(y, m));
  };
  return {
    times: (day) => (matches(day.getFullYear(), day.getMonth() + 1, day.getDate()) ? [dateAt(day, hh, mm)] : []),
    first: new Date(s.y, s.m - 1, s.d),
    last: u ? new Date(u.y, u.m - 1, u.d) : null,
  };
}

/**
 * As ocorrências com `from <= t < to`, em ordem (no máximo `limit`, 500 se omitido; `truncated` diz que havia mais).
 * Recorrência inválida lança erro (confira com `recurrenceError`).
 */
export function occurrencesIn(rec: Recurrence, from: Date, to: Date, opts: { limit?: number } = {}): { items: Date[]; truncated: boolean } {
  const c = compile(rec);
  const limit = opts.limit ?? 500;
  const items: Date[] = [];
  let day = startOfDay(from);
  if (c.first && c.first > day) day = c.first;
  for (let i = 0; i < MAX_SCAN_DAYS && day.getTime() < to.getTime(); i++, day = addDays(day, 1)) {
    if (c.last && day > c.last) break;
    for (const t of c.times(day)) {
      if (t < from || t >= to) continue;
      if (items.length >= limit) return { items, truncated: true };
      items.push(t);
    }
  }
  return { items, truncated: false };
}

/** A ocorrência mais recente com `after < t <= atOrBefore`; null se não houver. */
export function lastOccurrence(rec: Recurrence, atOrBefore: Date, after: Date): Date | null {
  const c = compile(rec);
  const floor = startOfDay(after);
  let day = startOfDay(atOrBefore);
  if (c.last && c.last < day) day = c.last;
  for (let i = 0; i < MAX_SCAN_DAYS && day >= floor; i++, day = addDays(day, -1)) {
    if (c.first && day < c.first) break;
    const times = c.times(day);
    for (let j = times.length - 1; j >= 0; j--) {
      const t = times[j]!;
      if (t > atOrBefore) continue;
      return t > after ? t : null;
    }
  }
  return null;
}

/** A primeira ocorrência depois de `after`, procurando até `horizonDays` dias (contados do primeiro dia em que ela pode existir); null se não houver. */
export function nextOccurrence(rec: Recurrence, after: Date, horizonDays = 400): Date | null {
  const c = compile(rec);
  let day = startOfDay(after);
  if (c.first && c.first > day) day = c.first;
  for (let i = 0; i < horizonDays; i++, day = addDays(day, 1)) {
    if (c.last && day > c.last) return null;
    const t = c.times(day).find((x) => x > after);
    if (t) return t;
  }
  return null;
}

// ---- texto ----

const SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const LONG = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function listDays(days: number[]): string {
  const names = days.map((d) => SHORT[d]!);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : (names[0] ?? '');
}

function brDate(day: string): string {
  const d = parseDay(day);
  return d ? `${pad(d.d)}/${pad(d.m)}/${d.y}` : day;
}

/** "todo dia às 08:00", "quinzenal (seg e qua) às 09:00", "todo mês, dia 31 (no último dia nos meses mais curtos), às 09:00"… */
export function describeRecurrence(rec: Recurrence): string {
  if (rec.kind === 'cron') return describeCron(rec.expr);
  const at = `às ${rec.time}`;
  const n = rec.interval;
  let text: string;
  if (rec.kind === 'once') {
    text = `uma vez, em ${brDate(rec.start)} ${at}`;
  } else if (rec.kind === 'daily') {
    text = n === 1 ? `todo dia ${at}` : `a cada ${n} dias ${at}`;
  } else if (rec.kind === 'weekly') {
    const s = parseDay(rec.start);
    const days = rec.weekdays?.length ? rec.weekdays : s ? [weekdayOf(dayNum(s.y, s.m, s.d))] : [];
    const list = listDays(days);
    const workdays = days.length === 5 && days.every((d, i) => d === i + 1);
    if (n === 1) {
      const one = days.length === 1 ? LONG[days[0]!]! : null;
      text = workdays ? `dias úteis ${at}` : one ? `${one === 'sábado' || one === 'domingo' ? 'todo' : 'toda'} ${one} ${at}` : `toda semana (${list}) ${at}`;
    } else {
      text = `${n === 2 ? 'quinzenal' : `a cada ${n} semanas`} (${list}) ${at}`;
    }
  } else {
    const s = parseDay(rec.start);
    const day = rec.monthDay ?? s?.d ?? 1;
    const short = day > 28 ? ' (no último dia nos meses mais curtos)' : '';
    text = `${n === 1 ? 'todo mês' : `a cada ${n} meses`}, dia ${day}${short}, ${at}`;
  }
  return rec.until ? `${text} · até ${brDate(rec.until)}` : text;
}
