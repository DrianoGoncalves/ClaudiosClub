import { describe, expect, it } from 'vitest';
import type { CalendarRecurrence, Recurrence } from '../shared/model';
import { dayString, describeRecurrence, lastOccurrence, nextOccurrence, normalizeRecurrence, occurrencesIn, recurrenceError, recurrenceKey, recurrenceOf } from '../shared/recurrence';

// Recorrência das rotinas (shared/recurrence.ts): diária, semanal com dias, quinzenal ancorada, mensal (dia 31), uma vez, até e o cron antigo.
// Datas no horário local, como a função usa; 2026-11-18 é quarta-feira.

const at = (y: number, m: number, d: number, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi);
const fmt = (d: Date) => `${dayString(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const days = (rec: Recurrence, from: Date, to: Date) => occurrencesIn(rec, from, to, { limit: 1000 }).items.map((d) => dayString(d));
const cal = (over: Partial<CalendarRecurrence> & Pick<CalendarRecurrence, 'kind' | 'start'>): CalendarRecurrence => ({ interval: 1, time: '09:00', ...over });

describe('recorrência: diária', () => {
  it('todo dia, e a cada N dias contados do início (que ainda não chegou não conta)', () => {
    const daily = cal({ kind: 'daily', start: '2026-11-18' });
    expect(days(daily, at(2026, 11, 16, 0), at(2026, 11, 21, 0))).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    const every3 = cal({ kind: 'daily', start: '2026-11-18', interval: 3 });
    expect(days(every3, at(2026, 11, 1, 0), at(2026, 12, 4, 0))).toEqual(['2026-11-18', '2026-11-21', '2026-11-24', '2026-11-27', '2026-11-30', '2026-12-03']);
  });

  it('o horário do dia é o `time`, e a janela é [from, to): o instante exato de `from` entra, o de `to` não', () => {
    const daily = cal({ kind: 'daily', start: '2026-11-18', time: '14:30' });
    expect(occurrencesIn(daily, at(2026, 11, 18, 14, 30), at(2026, 11, 19, 14, 30)).items.map(fmt)).toEqual(['2026-11-18 14:30']);
    expect(occurrencesIn(daily, at(2026, 11, 18, 14, 31), at(2026, 11, 19, 14, 31)).items.map(fmt)).toEqual(['2026-11-19 14:30']);
  });
});

describe('recorrência: semanal', () => {
  it('com dias da semana (seg e qua); sem `weekdays` vale o dia da semana do início', () => {
    const mw = cal({ kind: 'weekly', start: '2026-11-02', weekdays: [3, 1] });
    expect(days(mw, at(2026, 11, 1, 0), at(2026, 11, 16, 0))).toEqual(['2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']);
    // 2026-11-18 é quarta.
    const sameDay = cal({ kind: 'weekly', start: '2026-11-18' });
    expect(days(sameDay, at(2026, 11, 18, 0), at(2026, 12, 10, 0))).toEqual(['2026-11-18', '2026-11-25', '2026-12-02', '2026-12-09']);
  });

  it('o dia do início da semana de `start` que vem ANTES de `start` não roda (a semana começa no meio)', () => {
    const mw = cal({ kind: 'weekly', start: '2026-11-04', weekdays: [1, 3] }); // quarta; a segunda 11-02 é da mesma semana, mas anterior
    expect(days(mw, at(2026, 11, 1, 0), at(2026, 11, 10, 0))).toEqual(['2026-11-04', '2026-11-09']);
  });

  it('quinzenal ancorada na semana do início: roda nela, pula a seguinte, roda a outra', () => {
    const biweekly = cal({ kind: 'weekly', start: '2026-11-04', interval: 2, weekdays: [1, 3] });
    expect(days(biweekly, at(2026, 11, 1, 0), at(2026, 12, 8, 0))).toEqual(['2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30', '2026-12-02']);
  });

  it('a semana vai de domingo a sábado: domingo e sábado da mesma semana são da mesma quinzena', () => {
    const weekend = cal({ kind: 'weekly', start: '2026-11-01', interval: 2, weekdays: [0, 6] }); // domingo 11-01
    // Semana 11-01..11-07 roda (dom 11-01, sáb 11-07); 11-08..11-14 pula; 11-15..11-21 roda (dom 11-15, sáb 11-21).
    expect(days(weekend, at(2026, 11, 1, 0), at(2026, 11, 29, 0))).toEqual(['2026-11-01', '2026-11-07', '2026-11-15', '2026-11-21']);
  });
});

describe('recorrência: mensal', () => {
  it('dia 31 em mês curto roda no último dia (fevereiro 28, 29 em ano bissexto, abril 30)', () => {
    const m31 = cal({ kind: 'monthly', start: '2027-01-31', monthDay: 31 });
    expect(days(m31, at(2027, 1, 1, 0), at(2027, 6, 1, 0))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
    const leap = cal({ kind: 'monthly', start: '2028-01-31' });
    expect(days(leap, at(2028, 1, 1, 0), at(2028, 4, 1, 0))).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
  });

  it('sem `monthDay` vale o dia do início; a cada 2 meses pula os de intervalo', () => {
    const everyOther = cal({ kind: 'monthly', start: '2026-01-31', interval: 2 });
    expect(days(everyOther, at(2026, 1, 1, 0), at(2026, 8, 1, 0))).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  });

  it('começando depois do dia do mês, o primeiro mês não roda; monthDay maior que o mês do início cai no último dia', () => {
    const late = cal({ kind: 'monthly', start: '2026-11-20', monthDay: 10 });
    expect(days(late, at(2026, 11, 1, 0), at(2027, 1, 20, 0))).toEqual(['2026-12-10', '2027-01-10']);
    const feb = cal({ kind: 'monthly', start: '2026-02-10', monthDay: 31 });
    expect(days(feb, at(2026, 2, 1, 0), at(2026, 4, 5, 0))).toEqual(['2026-02-28', '2026-03-31']);
  });
});

describe('recorrência: uma vez, até e janela', () => {
  it('uma vez roda só no dia e hora do início, mesmo muito à frente', () => {
    const once = cal({ kind: 'once', start: '2030-05-20', time: '08:15' });
    expect(occurrencesIn(once, at(2026, 1, 1), at(2031, 1, 1)).items.map(fmt)).toEqual(['2030-05-20 08:15']);
    expect(fmt(nextOccurrence(once, at(2026, 11, 18))!)).toBe('2030-05-20 08:15');
    expect(nextOccurrence(once, at(2030, 5, 20, 8, 15))).toBeNull();
  });

  it('`until` é inclusivo: o dia dele ainda roda; o seguinte não', () => {
    const daily = cal({ kind: 'daily', start: '2026-11-18', until: '2026-11-20' });
    expect(days(daily, at(2026, 11, 17, 0), at(2026, 11, 25, 0))).toEqual(['2026-11-18', '2026-11-19', '2026-11-20']);
    expect(nextOccurrence(daily, at(2026, 11, 20, 9, 0))).toBeNull();
    expect(lastOccurrence(daily, at(2026, 12, 31), at(2026, 11, 1))).toEqual(at(2026, 11, 20));
  });

  it('o teto `limit` corta e avisa que havia mais', () => {
    const daily = cal({ kind: 'daily', start: '2026-11-01' });
    const r = occurrencesIn(daily, at(2026, 11, 1, 0), at(2026, 12, 1, 0), { limit: 5 });
    expect(r.items).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(occurrencesIn(daily, at(2026, 11, 1, 0), at(2026, 11, 6, 0), { limit: 5 }).truncated).toBe(false);
  });

  it('próxima e última ocorrência: estritamente depois / a mais recente no intervalo (after, atOrBefore]', () => {
    const daily = cal({ kind: 'daily', start: '2026-11-01' });
    expect(fmt(nextOccurrence(daily, at(2026, 11, 18, 9, 0))!)).toBe('2026-11-19 09:00');
    expect(fmt(nextOccurrence(daily, at(2026, 11, 18, 8, 59))!)).toBe('2026-11-18 09:00');
    expect(fmt(lastOccurrence(daily, at(2026, 11, 18, 9, 0), at(2026, 11, 1, 0))!)).toBe('2026-11-18 09:00');
    expect(fmt(lastOccurrence(daily, at(2026, 11, 18, 8, 59), at(2026, 11, 1, 0))!)).toBe('2026-11-17 09:00');
    // `after` é exclusivo: a ocorrência exatamente nele já foi tratada.
    expect(lastOccurrence(daily, at(2026, 11, 18, 9, 30), at(2026, 11, 18, 9, 0))).toBeNull();
  });
});

describe('recorrência: cron (formato antigo)', () => {
  it('ficha antiga só com `schedule` é lida como cron e dá as mesmas ocorrências', () => {
    const rec = recurrenceOf({ schedule: '0 19 * * 1-5' });
    expect(rec).toEqual({ kind: 'cron', expr: '0 19 * * 1-5' });
    // 2026-11-20 sexta, 21 sábado, 22 domingo, 23 segunda.
    expect(days(rec, at(2026, 11, 20, 0), at(2026, 11, 25, 0))).toEqual(['2026-11-20', '2026-11-23', '2026-11-24']);
    expect(fmt(nextOccurrence(rec, at(2026, 11, 20, 19, 0))!)).toBe('2026-11-23 19:00');
  });

  it('várias vezes no dia, em ordem, e a última ocorrência acha a mais recente antes de agora', () => {
    const rec: Recurrence = { kind: 'cron', expr: '*/30 9-10 * * *' };
    expect(occurrencesIn(rec, at(2026, 11, 18, 0), at(2026, 11, 19, 0)).items.map(fmt)).toEqual(['2026-11-18 09:00', '2026-11-18 09:30', '2026-11-18 10:00', '2026-11-18 10:30']);
    expect(fmt(lastOccurrence(rec, at(2026, 11, 18, 10, 20), at(2026, 11, 17, 0))!)).toBe('2026-11-18 10:00');
    expect(fmt(lastOccurrence(rec, at(2026, 11, 18, 8, 0), at(2026, 11, 17, 0))!)).toBe('2026-11-17 10:30');
  });

  it('`recurrence` ganha de `schedule` quando as duas existem', () => {
    const rec = recurrenceOf({ schedule: '0 8 * * *', recurrence: cal({ kind: 'daily', start: '2026-11-18' }) });
    expect(rec.kind).toBe('daily');
  });
});

describe('recorrência: validação e forma normal', () => {
  it('preenche os padrões e tira o que não vale para o tipo', () => {
    const p = normalizeRecurrence({ kind: 'weekly', start: '2026-11-18', time: '09:00', weekdays: [3, 1, 3], monthDay: 5, until: '' });
    expect(p).toEqual({ ok: true, value: { kind: 'weekly', interval: 1, weekdays: [1, 3], time: '09:00', start: '2026-11-18' } });
    expect(normalizeRecurrence({ kind: 'monthly', start: '2026-11-18', time: '09:00' })).toEqual({ ok: true, value: { kind: 'monthly', interval: 1, monthDay: 18, time: '09:00', start: '2026-11-18' } });
    expect(normalizeRecurrence({ kind: 'once', start: '2026-11-18', time: '09:00', interval: 4, until: '2027-01-01' })).toEqual({ ok: true, value: { kind: 'once', interval: 1, time: '09:00', start: '2026-11-18' } });
    expect(normalizeRecurrence({ kind: 'cron', expr: ' 0 8 * * * ' })).toEqual({ ok: true, value: { kind: 'cron', expr: '0 8 * * *' } });
  });

  it('recusa com a explicação em português: data que não existe, hora, intervalo, dias, até antes do início, cron inválido', () => {
    const base = { kind: 'daily', start: '2026-11-18', time: '09:00' };
    const err = (over: Record<string, unknown>) => recurrenceError({ ...base, ...over });
    expect(err({ start: '2026-02-30' })).toMatch(/início/);
    expect(err({ start: '18/11/2026' })).toMatch(/início/);
    expect(err({ time: '24:00' })).toMatch(/HH:MM/);
    expect(err({ time: '9:00' })).toMatch(/HH:MM/);
    expect(err({ interval: 0 })).toMatch(/intervalo/);
    expect(err({ interval: 1.5 })).toMatch(/intervalo/);
    expect(err({ interval: 366 })).toMatch(/1 a 365/);
    expect(err({ kind: 'weekly', interval: 53 })).toMatch(/1 a 52/);
    expect(err({ kind: 'monthly', interval: 13 })).toMatch(/1 a 12/);
    expect(err({ kind: 'weekly', weekdays: [] })).toMatch(/dias da semana/);
    expect(err({ kind: 'weekly', weekdays: [7] })).toMatch(/dias da semana/);
    expect(err({ kind: 'monthly', monthDay: 32 })).toMatch(/dia do mês/);
    expect(err({ until: '2026-11-17' })).toMatch(/antes do início/);
    expect(err({ kind: 'yearly' })).toMatch(/tipo/);
    expect(recurrenceError({ kind: 'cron', expr: '0 25 * * *' })).toMatch(/horário: hora/);
    expect(recurrenceError(null)).toMatch(/inválida/);
    expect(recurrenceError({ ...base })).toBeNull();
  });

  it('a impressão digital muda com o "quando roda" e não com a ordem das chaves', () => {
    const a = recurrenceKey({ kind: 'weekly', interval: 2, weekdays: [1, 3], time: '09:00', start: '2026-11-04' });
    const b = recurrenceKey({ start: '2026-11-04', time: '09:00', weekdays: [3, 1], interval: 2, kind: 'weekly' } as Recurrence);
    expect(a).toBe(b);
    expect(recurrenceKey({ kind: 'weekly', interval: 1, weekdays: [1, 3], time: '09:00', start: '2026-11-04' })).not.toBe(a);
  });
});

describe('recorrência: descrição', () => {
  it('texto curto em português para cada tipo', () => {
    expect(describeRecurrence(cal({ kind: 'daily', start: '2026-11-18' }))).toBe('todo dia às 09:00');
    expect(describeRecurrence(cal({ kind: 'daily', start: '2026-11-18', interval: 3 }))).toBe('a cada 3 dias às 09:00');
    expect(describeRecurrence(cal({ kind: 'weekly', start: '2026-11-18', weekdays: [1, 2, 3, 4, 5] }))).toBe('dias úteis às 09:00');
    expect(describeRecurrence(cal({ kind: 'weekly', start: '2026-11-18', weekdays: [1, 3] }))).toBe('toda semana (seg e qua) às 09:00');
    expect(describeRecurrence(cal({ kind: 'weekly', start: '2026-11-18', interval: 2, weekdays: [1, 3] }))).toBe('quinzenal (seg e qua) às 09:00');
    expect(describeRecurrence(cal({ kind: 'weekly', start: '2026-11-18', interval: 3 }))).toBe('a cada 3 semanas (qua) às 09:00');
    expect(describeRecurrence(cal({ kind: 'monthly', start: '2026-01-31', monthDay: 31 }))).toBe('todo mês, dia 31 (no último dia nos meses mais curtos), às 09:00');
    expect(describeRecurrence(cal({ kind: 'once', start: '2026-12-25', time: '08:00' }))).toBe('uma vez, em 25/12/2026 às 08:00');
    expect(describeRecurrence(cal({ kind: 'daily', start: '2026-11-18', until: '2026-12-31' }))).toBe('todo dia às 09:00 · até 31/12/2026');
    expect(describeRecurrence({ kind: 'cron', expr: '0 8 * * 1-5' })).toBe('dias úteis às 08:00');
  });
});
