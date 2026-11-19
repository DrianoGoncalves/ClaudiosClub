// O formulário de rotina (rascunho) e a rotina que o servidor grava. Puro: a conta do "quando roda" é de shared/recurrence.ts
// (a tela só monta a recorrência, confere e mostra as próximas execuções).
import { CATCH_UP_MAX_HOURS, type CalendarRecurrence, type Recurrence, type Routine } from '../../../shared/model';
import { INTERVAL_MAX, dayString, normalizeRecurrence, occurrencesIn, parseDay } from '../../../shared/recurrence';
import { t } from '../i18n';
import { cronOfStep, parseCronStep, stepFits } from './cronSteps';

/** Quantas rotinas cabem numa ficha (RoutinesSchema, server/staff/store.ts). */
export const ROUTINES_PER_STAFF_MAX = 10;
/** O limite de atraso que aparece ao ligar "rodar com atraso". */
export const DEFAULT_CATCH_UP_HOURS = 6;

/**
 * Como o formulário apresenta a repetição: `biweekly` = semanal de 2 em 2; `every` = "a cada N" dias, semanas ou meses; `minutes` e `hours` = "a cada N"
 * minutos ou horas, que o servidor guarda como cron (cronSteps.ts).
 */
export type Freq = 'once' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'every' | 'minutes' | 'hours' | 'cron';
export type Unit = 'daily' | 'weekly' | 'monthly';

export const FREQS: readonly Freq[] = ['once', 'daily', 'weekly', 'biweekly', 'monthly', 'every', 'minutes', 'hours', 'cron'];
export const UNITS: readonly Unit[] = ['daily', 'weekly', 'monthly'];

/** Só o calendário tem data de início, fim e hora marcada; cron e "a cada N minutos/horas" rodam pelo relógio. */
export const isCalendarFreq = (f: Freq): boolean => f !== 'cron' && f !== 'minutes' && f !== 'hours';

export interface RoutineDraft {
  /** null = rotina nova (o servidor dá o id). */
  id: string | null;
  staffId: string;
  name: string;
  message: string;
  mode: Routine['mode'];
  enabled: boolean;
  freq: Freq;
  /** Só em `every`. */
  unit: Unit;
  interval: string;
  /** Só em `minutes` e em `hours`: o N. */
  minutes: string;
  hours: string;
  weekdays: number[];
  monthDay: string;
  time: string;
  start: string;
  until: string;
  cron: string;
  catchUp: boolean;
  catchUpHours: string;
}

/** O que a tela manda ao servidor (uma rotina). `schedule` só quando for cron e a ficha antiga precisar dele. */
export interface RoutineInput {
  id?: string;
  name: string;
  schedule?: string;
  recurrence: Recurrence;
  catchUpHours: number;
  message: string;
  mode: Routine['mode'];
  enabled: boolean;
}

/** O que o rascunho precisa de uma rotina existente (`Routine` com a recorrência já resolvida, ou `RoutineSchedule`). */
export interface RoutineLike {
  id: string;
  name: string;
  message: string;
  mode: Routine['mode'];
  enabled: boolean;
  recurrence: Recurrence;
  catchUpHours?: number;
}

const weekdayOfDay = (day: string): number => {
  const d = parseDay(day);
  return d ? new Date(d.y, d.m - 1, d.d).getDay() : 1;
};

export function newDraft(staffId: string, today: Date = new Date()): RoutineDraft {
  const day = dayString(today);
  return {
    id: null,
    staffId,
    name: '',
    message: '',
    mode: 'continue',
    enabled: true,
    freq: 'daily',
    unit: 'daily',
    interval: '2',
    minutes: '30',
    hours: '2',
    weekdays: [today.getDay()],
    monthDay: String(today.getDate()),
    time: '08:00',
    start: day,
    until: '',
    cron: '',
    catchUp: false,
    catchUpHours: String(DEFAULT_CATCH_UP_HOURS),
  };
}

/**
 * Abre uma rotina existente no formulário. Cron fica em "Cron (avançado)", menos as duas formas que o formulário mesmo grava ("a cada N minutos" e
 * "a cada N horas", com N dentro das opções): essas voltam como eram. O resto não é trocado por outra forma sem o usuário pedir.
 */
export function draftFromRoutine(staffId: string, r: RoutineLike, today: Date = new Date()): RoutineDraft {
  const base: RoutineDraft = {
    ...newDraft(staffId, today),
    id: r.id,
    name: r.name,
    message: r.message,
    mode: r.mode,
    enabled: r.enabled,
    catchUp: (r.catchUpHours ?? 0) > 0,
    catchUpHours: String(r.catchUpHours || DEFAULT_CATCH_UP_HOURS),
  };
  const rec = r.recurrence;
  if (rec.kind === 'cron') {
    const step = parseCronStep(rec.expr);
    if (step && stepFits(step)) return step.unit === 'minutes' ? { ...base, freq: 'minutes', minutes: String(step.n) } : { ...base, freq: 'hours', hours: String(step.n) };
    return { ...base, freq: 'cron', cron: rec.expr };
  }
  const n = rec.interval;
  const freq: Freq =
    rec.kind === 'once'
      ? 'once'
      : rec.kind === 'daily'
        ? n === 1 ? 'daily' : 'every'
        : rec.kind === 'weekly'
          ? n === 1 ? 'weekly' : n === 2 ? 'biweekly' : 'every'
          : n === 1 ? 'monthly' : 'every';
  return {
    ...base,
    freq,
    unit: rec.kind === 'once' ? 'daily' : rec.kind,
    interval: String(n),
    weekdays: rec.weekdays?.length ? [...rec.weekdays] : [weekdayOfDay(rec.start)],
    monthDay: String(rec.monthDay ?? parseDay(rec.start)?.d ?? 1),
    time: rec.time,
    start: rec.start,
    until: rec.until ?? '',
  };
}

/** A recorrência que o formulário descreve, sem conferir (quem confere é `normalizeRecurrence`). */
export function buildRecurrence(d: RoutineDraft): Recurrence {
  if (d.freq === 'cron') return { kind: 'cron', expr: d.cron.trim() };
  if (d.freq === 'minutes' || d.freq === 'hours') return { kind: 'cron', expr: cronOfStep({ unit: d.freq, n: Number(d.freq === 'minutes' ? d.minutes : d.hours) }) };
  const kind: CalendarRecurrence['kind'] =
    d.freq === 'once' ? 'once' : d.freq === 'weekly' || d.freq === 'biweekly' ? 'weekly' : d.freq === 'every' ? d.unit : d.freq;
  const rec: CalendarRecurrence = { kind, interval: d.freq === 'biweekly' ? 2 : d.freq === 'every' ? Number(d.interval) : 1, time: d.time, start: d.start };
  if (kind === 'weekly') rec.weekdays = [...d.weekdays].sort((a, b) => a - b);
  if (kind === 'monthly') rec.monthDay = Number(d.monthDay);
  if (kind !== 'once' && d.until) rec.until = d.until;
  return rec;
}

export type DraftCheck = { ok: true; routine: RoutineInput } | { ok: false; error: string };

/** Confere o rascunho e monta o corpo para o servidor. Erro já no idioma da tela; o que o servidor sabe e a tela não (ex.: cron torto) vem do `shared`. */
export function checkDraft(d: RoutineDraft): DraftCheck {
  const fail = (error: string): DraftCheck => ({ ok: false, error });
  if (!d.name.trim()) return fail(t('schedules.errName'));
  if (!d.message.trim()) return fail(t('schedules.errMessage'));
  if (d.freq === 'minutes' && !stepFits({ unit: 'minutes', n: Number(d.minutes) })) return fail(t('schedules.errMinutes'));
  if (d.freq === 'hours' && !stepFits({ unit: 'hours', n: Number(d.hours) })) return fail(t('schedules.errHours'));
  if (isCalendarFreq(d.freq)) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time)) return fail(t('schedules.errTime'));
    if (!parseDay(d.start)) return fail(t('schedules.errStart'));
    if (d.freq === 'every') {
      const max = INTERVAL_MAX[d.unit];
      const n = Number(d.interval);
      if (!Number.isInteger(n) || n < 1 || n > max) return fail(t('schedules.errInterval', { max }));
    }
    if ((d.freq === 'weekly' || d.freq === 'biweekly' || (d.freq === 'every' && d.unit === 'weekly')) && d.weekdays.length === 0) return fail(t('schedules.errWeekdays'));
    if ((d.freq === 'monthly' || (d.freq === 'every' && d.unit === 'monthly')) && !(Number(d.monthDay) >= 1 && Number(d.monthDay) <= 31)) return fail(t('schedules.errMonthDay'));
    if (d.freq !== 'once' && d.until) {
      if (!parseDay(d.until)) return fail(t('schedules.errUntilFormat'));
      if (d.until < d.start) return fail(t('schedules.errUntil'));
    }
  }
  const recurrence = normalizeRecurrence(buildRecurrence(d));
  if (!recurrence.ok) return fail(recurrence.error);
  let catchUpHours = 0;
  if (d.catchUp) {
    catchUpHours = Number(d.catchUpHours);
    if (!Number.isInteger(catchUpHours) || catchUpHours < 1 || catchUpHours > CATCH_UP_MAX_HOURS) return fail(t('schedules.errCatchUp', { max: CATCH_UP_MAX_HOURS }));
  }
  return {
    ok: true,
    routine: { ...(d.id && { id: d.id }), name: d.name.trim(), recurrence: recurrence.value, catchUpHours, message: d.message.trim(), mode: d.mode, enabled: d.enabled },
  };
}

/** A rotina no formato da ficha (`Routine`): cron também em `schedule`, como nas fichas antigas; calendário com `schedule` vazio. */
export function toRoutine(input: RoutineInput, id: string): Routine {
  return {
    id,
    name: input.name,
    schedule: input.recurrence.kind === 'cron' ? input.recurrence.expr : '',
    recurrence: input.recurrence,
    ...(input.catchUpHours > 0 && { catchUpHours: input.catchUpHours }),
    message: input.message,
    mode: input.mode,
    enabled: input.enabled,
  };
}

/** O rascunho mudou desde que o formulário abriu (campo a campo; os dias da semana pelo conteúdo). */
export function draftChanged(now: RoutineDraft, opened: RoutineDraft): boolean {
  return (Object.keys(now) as (keyof RoutineDraft)[]).some((k) => (k === 'weekdays' ? now.weekdays.join() !== opened.weekdays.join() : now[k] !== opened[k]));
}

/** As próximas execuções da recorrência do rascunho (para mostrar antes de salvar); vazio se ela não vale ou não tem mais nenhuma. */
export function previewRuns(d: RoutineDraft, now: Date, count = 3): Date[] {
  const rec = normalizeRecurrence(buildRecurrence(d));
  if (!rec.ok) return [];
  try {
    return occurrencesIn(rec.value, now, new Date(now.getTime() + 400 * 86_400_000), { limit: count }).items;
  } catch {
    return [];
  }
}
