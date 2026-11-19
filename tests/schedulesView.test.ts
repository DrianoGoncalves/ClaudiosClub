import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CalendarRecurrence, Recurrence, RoutineSchedule, SchedulesResponse, StaffProfile } from '../shared/model';
import { normalizeRecurrence } from '../shared/recurrence';
import messages from '../client/src/i18n/schedules';
import { calendarEntries, groupByDay, monthGrid, monthStart, shiftMonth, weekdayNames } from '../client/src/schedules/calendar';
import { Routines } from '../client/src/detail/Routines';
import { RoutineForm } from '../client/src/schedules/RoutineForm';
import { RoutineHistory, RoutineItem } from '../client/src/schedules/RoutineList';
import { buildRecurrence, checkDraft, draftFromRoutine, newDraft, previewRuns, toRoutine, type RoutineDraft } from '../client/src/schedules/routineDraft';
import { ScheduleCalendar } from '../client/src/schedules/ScheduleCalendar';
import { normalizeSchedules } from '../client/src/schedules/scheduleFlows';
import { SchedulesBoardSeeded } from '../client/src/schedules/SchedulesBoard';
import { describeWhen, sortRoutines, stateLabel } from '../client/src/schedules/scheduleView';

// Tela de Agendamentos (rotinas + calendário): rascunho ↔ rotina, erros do formulário, grade do mês, texto do "quando roda" nos 3 idiomas e o
// render do formulário, da lista, do calendário e do modal inteiro (SSR com dados prontos; o efeito que lê do servidor não roda).

const NOW = new Date(2026, 10, 18, 10, 0, 0); // quarta, 18/11/2026
const at = (d: number, h = 9, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const noop = () => {};

const weekly: CalendarRecurrence = { kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5], time: '09:00', start: '2026-11-02' };
const routine = (over: Partial<RoutineSchedule> = {}): RoutineSchedule => ({
  projectId: 'p',
  staffId: 'ana',
  staffName: 'Ana',
  routineId: 'r1',
  name: 'Revisar PRs',
  message: 'Revise os PRs abertos',
  mode: 'continue',
  enabled: true,
  recurrence: weekly,
  description: '',
  invalid: null,
  catchUpHours: 0,
  next: at(19),
  armedAt: null,
  inFlight: null,
  last: null,
  history: [],
  ...over,
});
const like = (r: Recurrence, over: Partial<{ catchUpHours: number; enabled: boolean }> = {}) => ({ id: 'r1', name: 'Nome', message: 'Msg', mode: 'new' as const, enabled: true, recurrence: r, ...over });

/** `t()` num idioma fixo (o da tela é o do navegador): troca {var} pelo valor. */
const trIn = (lang: 'pt-BR' | 'en' | 'es') => (key: string, vars?: Record<string, string | number>) =>
  ((messages[lang] as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''));

const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({ ...newDraft('ana', NOW), name: 'Revisar', message: 'Revise', ...over });

describe('rascunho ↔ rotina', () => {
  it('rotina nova: todo dia, 08:00, hoje, sem atraso', () => {
    const d = newDraft('ana', NOW);
    expect(d).toMatchObject({ id: null, staffId: 'ana', freq: 'daily', time: '08:00', start: '2026-11-18', until: '', catchUp: false, enabled: true, weekdays: [3], monthDay: '18' });
  });

  it.each<[string, Recurrence, string, string]>([
    ['única', { kind: 'once', interval: 1, time: '10:00', start: '2026-11-20' }, 'once', 'daily'],
    ['diária', { kind: 'daily', interval: 1, time: '08:00', start: '2026-11-18' }, 'daily', 'daily'],
    ['a cada 3 dias', { kind: 'daily', interval: 3, time: '08:00', start: '2026-11-18' }, 'every', 'daily'],
    ['semanal', weekly, 'weekly', 'weekly'],
    ['quinzenal', { ...weekly, interval: 2 }, 'biweekly', 'weekly'],
    ['a cada 3 semanas', { ...weekly, interval: 3 }, 'every', 'weekly'],
    ['mensal', { kind: 'monthly', interval: 1, monthDay: 31, time: '09:00', start: '2026-01-31' }, 'monthly', 'monthly'],
    ['a cada 2 meses', { kind: 'monthly', interval: 2, monthDay: 5, time: '09:00', start: '2026-01-05' }, 'every', 'monthly'],
    ['cron', { kind: 'cron', expr: '0 8 * * 1-5' }, 'cron', 'daily'],
    ['cron a cada 30 minutos (as opções "a cada N" do formulário)', { kind: 'cron', expr: '*/30 * * * *' }, 'minutes', 'daily'],
  ])('%s: abre no formulário e volta à mesma recorrência', (_n, rec, freq, unit) => {
    const d = draftFromRoutine('ana', like(rec), NOW);
    expect(d.freq).toBe(freq);
    expect(d.unit).toBe(unit);
    const out = checkDraft(d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.routine.recurrence).toEqual((normalizeRecurrence(rec) as { value: Recurrence }).value);
    expect(out.routine.id).toBe('r1');
  });

  it('o limite de atraso vai junto; desligado vale 0', () => {
    const on = draftFromRoutine('ana', like(weekly, { catchUpHours: 6 }), NOW);
    expect(on).toMatchObject({ catchUp: true, catchUpHours: '6' });
    expect((checkDraft(on) as { routine: { catchUpHours: number } }).routine.catchUpHours).toBe(6);
    const off = draftFromRoutine('ana', like(weekly), NOW);
    expect(off.catchUp).toBe(false);
    expect((checkDraft(off) as { routine: { catchUpHours: number } }).routine.catchUpHours).toBe(0);
  });

  it('rotina nova não leva id; fim vazio não vai; "uma vez" não leva fim nem intervalo', () => {
    const out = checkDraft(draft({ freq: 'once', until: '2026-12-01', start: '2026-11-20' }));
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect('id' in out.routine).toBe(false);
    expect(out.routine.recurrence).toEqual({ kind: 'once', interval: 1, time: '08:00', start: '2026-11-20' });
    expect(buildRecurrence(draft({ freq: 'daily', until: '' }))).not.toHaveProperty('until');
  });

  it('quinzenal vira semanal de 2 em 2 com os dias escolhidos em ordem', () => {
    expect(buildRecurrence(draft({ freq: 'biweekly', weekdays: [5, 1] }))).toMatchObject({ kind: 'weekly', interval: 2, weekdays: [1, 5] });
  });

  it('toRoutine: cron também em schedule; calendário com schedule vazio; atraso 0 some', () => {
    const cron = toRoutine({ name: 'x', recurrence: { kind: 'cron', expr: '0 8 * * 1-5' }, catchUpHours: 0, message: 'm', mode: 'continue', enabled: true }, 'r-1');
    expect(cron).toMatchObject({ id: 'r-1', schedule: '0 8 * * 1-5' });
    expect('catchUpHours' in cron).toBe(false);
    const cal = toRoutine({ name: 'x', recurrence: weekly, catchUpHours: 4, message: 'm', mode: 'task', enabled: false }, 'r-2');
    expect(cal).toMatchObject({ schedule: '', recurrence: weekly, catchUpHours: 4, enabled: false });
  });
});

describe('erros do formulário (checkDraft)', () => {
  const err = (over: Partial<RoutineDraft>) => {
    const out = checkDraft(draft(over));
    return out.ok ? null : out.error;
  };

  it('nome e mensagem em branco', () => {
    expect(err({ name: '   ' })).toBe('Dê um nome à rotina.');
    expect(err({ message: '' })).toBe('Escreva a mensagem da rotina.');
  });

  it('hora, início e fim', () => {
    expect(err({ time: '' })).toBe('Hora inválida: use HH:MM.');
    expect(err({ time: '25:00' })).toBe('Hora inválida: use HH:MM.');
    expect(err({ start: '2026-02-30' })).toBe('Data de início inválida.');
    expect(err({ start: '2026-11-18', until: '2026-11-17' })).toBe('O fim não pode ser antes do início.');
    expect(err({ until: '18/12/2026' })).toBe('Data final inválida.');
    expect(err({ start: '2026-11-18', until: '2026-11-18' })).toBeNull();
  });

  it('semanal sem nenhum dia', () => {
    expect(err({ freq: 'weekly', weekdays: [] })).toBe('Escolha pelo menos um dia da semana.');
    expect(err({ freq: 'biweekly', weekdays: [] })).toBe('Escolha pelo menos um dia da semana.');
    expect(err({ freq: 'every', unit: 'weekly', interval: '2', weekdays: [] })).toBe('Escolha pelo menos um dia da semana.');
    expect(err({ freq: 'daily', weekdays: [] })).toBeNull();
  });

  it('a cada N: inteiro de 1 até o máximo da unidade', () => {
    expect(err({ freq: 'every', unit: 'daily', interval: '0' })).toBe('Intervalo: use um número inteiro de 1 a 365.');
    expect(err({ freq: 'every', unit: 'daily', interval: '366' })).toBe('Intervalo: use um número inteiro de 1 a 365.');
    expect(err({ freq: 'every', unit: 'weekly', interval: '53', weekdays: [1] })).toBe('Intervalo: use um número inteiro de 1 a 52.');
    expect(err({ freq: 'every', unit: 'monthly', interval: '1.5' })).toBe('Intervalo: use um número inteiro de 1 a 12.');
    expect(err({ freq: 'every', unit: 'monthly', interval: '12' })).toBeNull();
  });

  it('mensal: dia do mês de 1 a 31', () => {
    expect(err({ freq: 'monthly', monthDay: '32' })).toBe('Dia do mês: use de 1 a 31.');
    expect(err({ freq: 'monthly', monthDay: '' })).toBe('Dia do mês: use de 1 a 31.');
    expect(err({ freq: 'monthly', monthDay: '31' })).toBeNull();
  });

  it('atraso: horas inteiras de 1 a 168 (só vale com a opção ligada)', () => {
    for (const bad of ['0', '169', '2.5', '', 'abc']) expect(err({ catchUp: true, catchUpHours: bad })).toBe('Limite de atraso: use horas inteiras de 1 a 168.');
    expect(err({ catchUp: true, catchUpHours: '168' })).toBeNull();
    expect(err({ catchUp: true, catchUpHours: '1' })).toBeNull();
    expect(err({ catchUp: false, catchUpHours: '999' })).toBeNull();
  });

  it('cron: vazio ou torto volta o motivo do shared; válido passa sem hora nem início', () => {
    expect(err({ freq: 'cron', cron: '' })).toMatch(/horário/);
    expect(err({ freq: 'cron', cron: '99 * * * *' })).toMatch(/horário/);
    expect(err({ freq: 'cron', cron: '0 8 * * 1-5', time: '', start: '' })).toBeNull();
  });
});

describe('prévia das próximas execuções', () => {
  it('diária: as próximas 3, depois de agora', () => {
    const runs = previewRuns(draft({ freq: 'daily', time: '08:00', start: '2026-11-01' }), NOW);
    expect(runs.map((r) => r.getDate())).toEqual([19, 20, 21]);
    expect(runs.every((r) => r > NOW)).toBe(true);
  });

  it('"uma vez" no passado e recorrência inválida não têm próxima', () => {
    expect(previewRuns(draft({ freq: 'once', start: '2026-11-01' }), NOW)).toEqual([]);
    expect(previewRuns(draft({ freq: 'cron', cron: 'xx' }), NOW)).toEqual([]);
  });
});

describe('calendário do mês', () => {
  it('novembro/2026 (dia 1 num domingo): 5 semanas, de 1/11 a 5/12', () => {
    const g = monthGrid(new Date(2026, 10, 18));
    expect(g.days).toHaveLength(35);
    expect(g.from).toEqual(new Date(2026, 10, 1));
    expect(g.to).toEqual(new Date(2026, 11, 6));
    expect(g.days[0]!.getDay()).toBe(0);
  });

  it('dezembro/2026 começa em 29/11; fevereiro/2026 cabe em 4 semanas; agosto/2026 precisa de 6', () => {
    expect(monthGrid(new Date(2026, 11, 1)).from).toEqual(new Date(2026, 10, 29));
    expect(monthGrid(new Date(2026, 1, 1)).days).toHaveLength(28);
    expect(monthGrid(new Date(2026, 7, 1)).days).toHaveLength(42);
  });

  it('a janela de qualquer mês cabe no limite de 62 dias do servidor', () => {
    for (let m = 0; m < 24; m++) {
      const g = monthGrid(new Date(2026, m, 1));
      expect((g.to.getTime() - g.from.getTime()) / 86_400_000).toBeLessThanOrEqual(42);
    }
  });

  it('monthStart e shiftMonth atravessam o ano', () => {
    expect(monthStart(new Date(2026, 11, 31))).toEqual(new Date(2026, 11, 1));
    expect(shiftMonth(new Date(2026, 11, 1), 1)).toEqual(new Date(2027, 0, 1));
    expect(shiftMonth(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 1));
  });

  it('nomes dos dias começam no domingo', () => {
    expect(weekdayNames('pt-BR')[0]).toMatch(/^dom\.?$/);
    expect(weekdayNames('pt-BR', 'long')[6]).toBe('sábado');
    expect(weekdayNames('en')[1]).toBe('Mon');
  });

  it('agrupa por dia local, em ordem de horário, juntando rotinas e despertadores', () => {
    const entries = calendarEntries({
      occurrences: [
        { staffId: 'ana', routineId: 'r1', at: at(19, 14), state: 'upcoming' },
        { staffId: 'ana', routineId: 'r1', at: at(19, 9), state: 'upcoming' },
        { staffId: 'ana', routineId: 'r1', at: at(17, 9), state: 'ran' },
      ],
      items: [{ kind: 'wake', sessionId: 's1', staffId: null, at: at(19, 11), text: 'ver o deploy' }],
    });
    const by = groupByDay(entries);
    expect([...by.keys()]).toEqual(['2026-11-17', '2026-11-19']);
    expect(by.get('2026-11-19')!.map((e) => `${e.kind}:${new Date(e.at).getHours()}`)).toEqual(['routine:9', 'wake:11', 'routine:14']);
    expect(by.get('2026-11-19')![1]).toMatchObject({ staffId: null, state: 'upcoming', text: 'ver o deploy' });
  });
});

describe('o "quando roda" por extenso', () => {
  const cases: Array<[string, Recurrence, string]> = [
    ['única', { kind: 'once', interval: 1, time: '10:00', start: '2026-11-20' }, 'uma vez, em 20/11/2026 às 10:00'],
    ['diária', { kind: 'daily', interval: 1, time: '08:00', start: '2026-11-18' }, 'todo dia às 08:00'],
    ['a cada 3 dias', { kind: 'daily', interval: 3, time: '08:00', start: '2026-11-18' }, 'a cada 3 dias às 08:00'],
    ['dias úteis', weekly, 'dias úteis às 09:00'],
    ['semanal', { ...weekly, weekdays: [1, 3] }, 'toda semana (seg e qua) às 09:00'],
    ['quinzenal', { ...weekly, interval: 2, weekdays: [1, 3] }, 'quinzenal (seg e qua) às 09:00'],
    ['a cada 3 semanas', { ...weekly, interval: 3, weekdays: [5] }, 'a cada 3 semanas (sex) às 09:00'],
    ['mensal', { kind: 'monthly', interval: 1, monthDay: 10, time: '09:00', start: '2026-01-10' }, 'todo mês, dia 10, às 09:00'],
    ['mensal dia 31', { kind: 'monthly', interval: 1, monthDay: 31, time: '09:00', start: '2026-01-31' }, 'todo mês, dia 31, às 09:00 (no último dia nos meses mais curtos)'],
    ['a cada 2 meses', { kind: 'monthly', interval: 2, monthDay: 5, time: '09:00', start: '2026-01-05' }, 'a cada 2 meses, dia 5, às 09:00'],
    ['com fim', { kind: 'daily', interval: 1, time: '08:00', start: '2026-11-18', until: '2026-12-31' }, 'todo dia às 08:00 · até 31/12/2026'],
    ['cron simples', { kind: 'cron', expr: '0 8 * * 1-5' }, 'dias úteis às 08:00'],
  ];
  it.each(cases)('pt-BR: %s', (_n, rec, text) => {
    // O Intl do português abrevia com ponto ("seg."): tirado só para comparar.
    expect(describeWhen(rec, trIn('pt-BR'), 'pt-BR').replace(/\./g, '')).toBe(text);
  });

  it('en e es: mesmas formas, no idioma', () => {
    expect(describeWhen({ ...weekly, interval: 2, weekdays: [1, 3] }, trIn('en'), 'en')).toBe('every other week (Mon and Wed) at 09:00');
    expect(describeWhen({ kind: 'daily', interval: 1, time: '08:00', start: '2026-11-18' }, trIn('en'), 'en')).toBe('every day at 08:00');
    expect(describeWhen({ kind: 'monthly', interval: 2, monthDay: 5, time: '09:00', start: '2026-01-05' }, trIn('es'), 'es')).toBe('cada 2 meses, día 5, a las 09:00');
    expect(describeWhen({ ...weekly, interval: 2, weekdays: [1, 3] }, trIn('es'), 'es')).toMatch(/^quincenal \(lun\.? y mié\.?\) a las 09:00$/);
  });

  it('cron fora do português mostra a expressão (a leitura em palavras é só em português), menos "a cada N minutos/horas"', () => {
    expect(describeWhen({ kind: 'cron', expr: '0 8 * * 1-5' }, trIn('en'), 'en')).toBe('Cron: 0 8 * * 1-5');
    expect(describeWhen({ kind: 'cron', expr: '*/30 * * * *' }, trIn('pt-BR'), 'pt-BR')).toBe('a cada 30 minutos');
    expect(describeWhen({ kind: 'cron', expr: '*/30 * * * *' }, trIn('en'), 'en')).toBe('every 30 minutes');
  });

  it('en e es têm todas as chaves do pt-BR', () => {
    const keys = Object.keys(messages['pt-BR']).sort();
    expect(Object.keys(messages.en).sort()).toEqual(keys);
    expect(Object.keys(messages.es).sort()).toEqual(keys);
  });
});

describe('ordem e estados', () => {
  it('ligadas com próxima primeiro (a mais próxima antes); desligadas, inválidas e sem próxima depois, por nome', () => {
    const list = [
      routine({ routineId: 'a', name: 'Zeta', enabled: false, next: null }),
      routine({ routineId: 'b', name: 'Tarde', next: at(25) }),
      routine({ routineId: 'c', name: 'Cedo', next: at(19) }),
      routine({ routineId: 'd', name: 'Alfa', invalid: 'x', next: null }),
    ];
    expect(sortRoutines(list).map((r) => r.name)).toEqual(['Cedo', 'Tarde', 'Alfa', 'Zeta']);
    expect(list[0]!.name).toBe('Zeta'); // não muda a lista original
  });

  it('rótulo de cada estado', () => {
    const tr = trIn('pt-BR');
    expect((['upcoming', 'ran', 'failed', 'discarded', 'uncertain', 'unknown'] as const).map((s) => stateLabel(s, tr))).toEqual(['prevista', 'rodou', 'falhou', 'descartada', 'incerta', 'sem registro']);
  });
});

describe('formulário (render)', () => {
  const html = (d: RoutineDraft, over: Partial<Parameters<typeof RoutineForm>[0]> = {}) =>
    renderToStaticMarkup(createElement(RoutineForm, { draft: d, busy: false, error: null, now: NOW, onChange: noop, onSubmit: noop, onCancel: noop, ...over }));

  it('opções de repetição, atraso desligado por padrão e explicação do que acontece', () => {
    const out = html(draft());
    for (const label of ['Uma vez', 'Todo dia', 'Toda semana', 'Quinzenal (a cada 2 semanas)', 'Todo mês', 'A cada N dias, semanas ou meses', 'Cron (avançado)']) expect(out).toContain(label);
    expect(out).toContain('Rodar com atraso');
    expect(out).not.toContain('Limite de atraso');
    expect(out).toContain('Desligado: só roda no minuto marcado');
    expect(out).toContain('Roda todo dia às 08:00');
    expect(out).toContain('Próximas:');
  });

  it('atraso ligado mostra o limite e diz que passando dele descarta', () => {
    const out = html(draft({ catchUp: true, catchUpHours: '12' }));
    expect(out).toContain('Limite de atraso (horas, de 1 a 168)');
    expect(out).toContain('no máximo 12 h');
    expect(out).toContain('descarta');
    expect(out).not.toContain('Desligado: só roda');
  });

  it('semanal mostra os 7 dias como botões marcáveis; diária não', () => {
    const out = html(draft({ freq: 'weekly', weekdays: [1, 3] }));
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(out.match(/aria-pressed="false"/g)).toHaveLength(5);
    expect(out).toContain('Dias da semana');
    expect(html(draft({ freq: 'daily' }))).not.toContain('Dias da semana');
  });

  it('cron: campo da expressão, ajuda e sem hora nem datas', () => {
    const out = html(draft({ freq: 'cron', cron: '0 8 * * 1-5' }));
    expect(out).toContain('value="0 8 * * 1-5"');
    expect(out).toContain('5 campos: minuto hora');
    expect(out).not.toContain('type="time"');
    expect(out).not.toContain('type="date"');
  });

  it('"a cada N": número e unidade; mensal: dia do mês; única: sem "termina em"', () => {
    expect(html(draft({ freq: 'every', unit: 'weeks' as never }))).toContain('Unidade');
    expect(html(draft({ freq: 'monthly' }))).toContain('Dia do mês');
    const once = html(draft({ freq: 'once' }));
    expect(once).toContain('>Data<');
    expect(once).not.toContain('Termina em');
  });

  it('escolher funcionário: o que já tem o máximo fica desligado; ao editar o campo trava', () => {
    const staff = [
      { id: 'ana', name: 'Ana', full: false },
      { id: 'bia', name: 'Bia', full: true },
    ];
    const out = html(draft(), { staff });
    expect(out).toContain('Bia (já tem o máximo de rotinas)');
    expect(out).toMatch(/<option value="bia" disabled="">/);
    expect(html(draft({ id: 'r1', staffId: 'bia' }), { staff, lockStaff: true })).toMatch(/<select[^>]*disabled=""[^>]*>\s*<option value="ana"/);
    expect(html(draft())).not.toContain('Funcionário');
  });

  it('erro aparece como alerta e salvar trava com busy', () => {
    const out = html(draft(), { error: 'Dê um nome à rotina.', busy: true });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Dê um nome à rotina.');
    expect(out).toMatch(/<button type="submit" class="btn-primary" disabled="">/);
  });
});

describe('rotina na lista (render)', () => {
  const props = { now: NOW.getTime(), confirming: null, busy: false, onToggle: noop, onEdit: noop, onAsk: noop, onDelete: noop, onRun: noop };
  const html = (r: RoutineSchedule, over: Partial<Parameters<typeof RoutineItem>[0]> = {}) => renderToStaticMarkup(createElement(RoutineItem, { ...props, r, ...over }));

  it('mostra nome, funcionário, quando roda, próxima, última e as 3 ações', () => {
    const out = html(routine({ last: { at: at(18, 9), ok: true, text: 'enviada' }, catchUpHours: 6 }));
    expect(out).toContain('Revisar PRs');
    expect(out).toContain('Ana · na última conversa');
    expect(out).toContain('dias úteis às 09:00');
    expect(out).toContain('Próxima:');
    expect(out).toContain('Roda com atraso: até 6 h depois do horário.');
    expect(out).toContain('Última: há 1h00 · enviada');
    for (const b of ['>Editar<', '>Rodar agora<', '>Apagar<']) expect(out).toContain(b);
    expect(out).toMatch(/aria-pressed="true"[^>]*>Ligada</);
  });

  it('desligada, inválida, sem próxima e nunca rodou', () => {
    expect(html(routine({ enabled: false, next: null }))).toContain('Desligada: não roda.');
    expect(html(routine({ invalid: 'horário: expressão cron precisa de 5 campos', next: null }))).toContain('Recorrência inválida, a rotina não roda: horário: expressão cron precisa de 5 campos');
    expect(html(routine({ next: null }))).toContain('Sem próxima execução.');
    expect(html(routine())).toContain('Ainda não rodou.');
    expect(html(routine({ inFlight: at(18, 9) }))).toContain('Rodando agora');
  });

  it('última que falhou aparece como "não rodou" e sem o prefixo pulada', () => {
    const out = html(routine({ last: { at: at(18, 9), ok: false, text: 'pulada: consumo no limite' } }));
    expect(out).toContain('não rodou (consumo no limite)');
    expect(out).toContain('is-fail');
  });

  it('pede confirmação na própria linha antes de apagar ou rodar', () => {
    const del = html(routine(), { confirming: 'delete' });
    expect(del).toContain('Apagar a rotina “Revisar PRs”?');
    expect(del).toContain('Sim, apagar');
    expect(del).toContain('Voltar');
    expect(del).not.toContain('>Editar<');
    const run = html(routine(), { confirming: 'run' });
    expect(run).toContain('A mensagem vai para Ana já');
    expect(run).toContain('Sim, rodar');
  });

  it('mensagem e motivos são texto puro (HTML escapado)', () => {
    const out = html(routine({ message: '<img src=x onerror=alert(1)>', history: [{ state: 'failed', due: at(17, 9), at: at(17, 9), text: '<b>x</b>' }] }));
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('erro e resultado do "rodar agora" aparecem na linha', () => {
    const out = html(routine(), { error: 'Não deu certo: x', result: '"Revisar PRs": enviada' });
    expect(out).toContain('Não deu certo: x');
    expect(out).toContain('role="status"');
  });
});

describe('histórico da rotina (render)', () => {
  it('vazio', () => {
    expect(renderToStaticMarkup(createElement(RoutineHistory, { history: [] }))).toContain('Nada no histórico ainda.');
  });

  it('os 4 estados com o motivo, atraso, execução manual e descarte em lote', () => {
    const out = renderToStaticMarkup(
      createElement(RoutineHistory, {
        history: [
          { state: 'ran', due: at(17, 9), at: at(17, 11), text: 'enviada na conversa', lateMin: 120 },
          { state: 'failed', due: at(16, 9), at: at(16, 9), text: 'pulada: consumo no limite' },
          { state: 'discarded', due: at(15, 9), from: at(13, 9), at: at(18, 8), text: 'passou do limite de 6 h', count: 3 },
          { state: 'uncertain', due: at(12, 9), at: at(12, 9), text: 'o servidor caiu' },
          { state: 'ran', due: at(11, 15), at: at(11, 15), text: 'ok', manual: true },
        ],
      }),
    );
    for (const s of ['rodou', 'falhou', 'descartada', 'incerta']) expect(out).toContain(`${s}</span>`);
    expect(out).toContain('enviada na conversa');
    expect(out).toContain('rodou 120 min depois do horário');
    expect(out).toContain('pulada: consumo no limite');
    expect(out).toContain('passou do limite de 6 h');
    expect(out).toContain('3 execuções');
    expect(out).toContain('→');
    expect(out).toContain('>Rodar agora<');
  });
});

describe('calendário (render)', () => {
  const entries = calendarEntries({
    occurrences: [
      { staffId: 'ana', routineId: 'r1', at: at(17, 9), state: 'ran' },
      { staffId: 'ana', routineId: 'r1', at: at(19, 9), state: 'upcoming' },
      { staffId: 'ana', routineId: 'r1', at: at(19, 14), state: 'failed' },
    ],
    items: [],
  });
  const html = (selected: string, es = entries) =>
    renderToStaticMarkup(
      createElement(ScheduleCalendar, {
        anchor: new Date(2026, 10, 1),
        today: NOW,
        entries: es,
        selected,
        nameOf: (id: string | null) => (id === null ? 'Freela' : 'Ana'),
        titleOf: () => 'Revisar PRs',
        messageOf: () => 'Revise os PRs',
        onPrev: noop,
        onNext: noop,
        onToday: noop,
        onSelect: noop,
        onEdit: noop,
      }),
    );

  it('título do mês, 7 cabeçalhos, uma célula por dia e navegação', () => {
    const out = html('2026-11-18');
    expect(out).toContain('novembro de 2026');
    expect(out.match(/<th /g)).toHaveLength(7);
    expect(out.match(/class="sched-day[ "]/g)).toHaveLength(35);
    expect(out).toContain('aria-label="Mês anterior"');
    expect(out).toContain('aria-label="Próximo mês"');
    expect(out).toContain('>Hoje<');
  });

  it('o dia escolhido fica marcado e hoje também; a célula diz quantas execuções tem', () => {
    const out = html('2026-11-19');
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(out).toMatch(/is-today[^>]*aria-pressed="false"/);
    expect(out).toContain('quinta-feira, 19 de novembro: 2 execuções');
    expect(out).toContain('terça-feira, 17 de novembro: 1 execução"');
    expect(out).toContain('segunda-feira, 16 de novembro: nenhuma execução');
  });

  it('o dia escolhido lista o que roda: hora, rotina, funcionário, estado, mensagem e Editar', () => {
    const out = html('2026-11-19');
    expect(out).toContain('quinta-feira, 19 de novembro');
    expect(out).toContain('>09:00<');
    expect(out).toContain('>14:00<');
    expect(out).toContain('Revisar PRs');
    expect(out).toContain('Ana');
    expect(out).toContain('prevista');
    expect(out).toContain('falhou');
    expect(out).toContain('Revise os PRs');
    expect(out.match(/>Editar</g)).toHaveLength(2);
  });

  it('dia sem execução; despertador não tem Editar', () => {
    expect(html('2026-11-20')).toContain('Nada roda neste dia.');
    const wake = calendarEntries({ occurrences: [], items: [{ kind: 'wake', sessionId: 's', staffId: null, at: at(20, 10), text: 'olhar o deploy' }] });
    const out = html('2026-11-20', wake);
    expect(out).toContain('Freela');
    expect(out).not.toContain('>Editar<');
  });

  it('legenda com os 6 estados (símbolo + texto)', () => {
    const out = html('2026-11-18');
    for (const s of ['prevista', 'rodou', 'falhou', 'descartada', 'incerta', 'sem registro']) expect(out).toContain(`${s}</li>`);
    for (const g of ['○', '✓', '✕', '–', '?', '·']) expect(out).toContain(g);
  });
});

describe('tela inteira (render)', () => {
  const staff = [{ id: 'ana', name: 'Ana', projectId: 'p' }, { id: 'bia', name: 'Bia', projectId: 'p' }] as unknown as StaffProfile[];
  const data: SchedulesResponse = {
    items: [{ kind: 'wake', sessionId: 's1', staffId: 'bia', at: at(19, 16), text: 'olhar o deploy' }],
    routines: [routine(), routine({ routineId: 'r2', name: 'Faxina', enabled: false, next: null, staffId: 'bia', staffName: 'Bia' })],
    occurrences: [{ staffId: 'ana', routineId: 'r1', at: at(19, 9), state: 'upcoming' }],
    window: { from: at(1), to: at(31), truncated: false },
    stateWarning: null,
  };
  // A tela de produção (`SchedulesBoard`) não tem props de teste; o render no servidor não roda o efeito que lê, então os dados entram pelo wrapper.
  const html = (over: Partial<Parameters<typeof SchedulesBoardSeeded>[0]> = {}) =>
    renderToStaticMarkup(createElement(SchedulesBoardSeeded, { projectId: 'p', projectName: 'Meu site', staff, onClose: noop, onOpenConversation: noop, seed: { data, now: NOW.getTime() }, ...over }));

  it('modal em tela cheia com as duas colunas e as duas abas', () => {
    const out = html();
    expect(out).toContain('modal-backdrop sched-backdrop');
    expect(out).toContain('modal sched-modal');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('Agendamentos · Meu site');
    expect(out).toContain('sched-list-col');
    expect(out).toContain('sched-cal-col');
    expect(out).toContain('>Lista<');
    expect(out).toContain('>Calendário<');
    expect(out).toContain('data-pane="list"');
  });

  it('coluna da esquerda: rotinas (ordem, contagem), botão Nova rotina e despertadores; direita: o mês', () => {
    const out = html();
    expect(out).toContain('Rotinas (2)');
    expect(out.indexOf('Revisar PRs')).toBeLessThan(out.indexOf('Faxina'));
    expect(out).toContain('+ Nova rotina');
    expect(out).toContain('Despertadores e “continue” (1)');
    expect(out).toContain('olhar o deploy');
    expect(out).toContain('novembro de 2026');
  });

  it('sem funcionário: Nova rotina desligada e o aviso; sem rotina: estado vazio', () => {
    const out = html({ staff: [], seed: { data: { ...data, routines: [], items: [] }, now: NOW.getTime() } });
    expect(out).toContain('Nenhum funcionário neste projeto');
    expect(out).toContain('Nenhuma rotina ainda.');
    expect(out).toMatch(/<button type="button" class="btn-primary" disabled=""/);
  });

  it('aviso do servidor e calendário incompleto aparecem', () => {
    const out = html({ seed: { data: { ...data, stateWarning: 'o arquivo de estado estava corrompido', window: { ...data.window, truncated: true } }, now: NOW.getTime() } });
    expect(out).toContain('Aviso: o arquivo de estado estava corrompido');
    expect(out).toContain('o calendário ficou incompleto neste mês');
  });

  it('servidor velho (só items) não quebra', () => {
    expect(normalizeSchedules({ items: [] })).toEqual({ items: [], routines: [], occurrences: [], window: { from: '', to: '', truncated: false }, stateWarning: null });
    expect(normalizeSchedules({})).toMatchObject({ items: [], routines: [] });
  });
});

describe('rotinas na ficha do funcionário (render)', () => {
  const staffWith = (routines: unknown[]) => ({ id: 'ana', name: 'Ana', projectId: 'p', routines }) as unknown as StaffProfile;
  const html = (routines: unknown[]) => renderToStaticMarkup(createElement(Routines, { projectId: 'p', staff: staffWith(routines) }));

  it('lista rotina de calendário e cron antigo, com o quando roda, o atraso e as 3 ações', () => {
    const out = html([
      { id: 'a', name: 'Revisar PRs', schedule: '', recurrence: weekly, catchUpHours: 6, message: 'Revise os PRs', mode: 'continue', enabled: true },
      { id: 'b', name: 'Cron velho', schedule: '*/30 * * * *', message: 'Olhe a fila', mode: 'task', enabled: false },
    ]);
    expect(out).toContain('dias úteis às 09:00');
    expect(out).toContain('a cada 30 minutos');
    expect(out).toContain('Roda com atraso: até 6 h depois do horário.');
    expect(out).toContain('Nova rotina');
    expect(out.match(/>Rodar agora</g)).toHaveLength(2);
    expect(out.match(/>Editar</g)).toHaveLength(2);
    expect(out.match(/>Apagar</g)).toHaveLength(2);
  });

  it('recorrência que não dá para ler (ficha editada à mão) não derruba a lista', () => {
    const out = html([{ id: 'x', name: 'Torta', schedule: 'xx', message: 'm', mode: 'new', enabled: true }]);
    expect(out).toContain('Torta');
    expect(out).toContain('desligada');
  });

  it('sem rotina: dica de exemplo e o botão de criar', () => {
    const out = html([]);
    expect(out).toContain('Nenhuma rotina.');
    expect(out).toContain('Nova rotina');
  });
});