import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Recurrence, StaffProfile } from '../shared/model';
import { normalizeRecurrence, recurrenceOf } from '../shared/recurrence';
import { Routines } from '../client/src/detail/Routines';
import messages from '../client/src/i18n/schedules';
import { cronOfStep, HOUR_STEPS, MINUTE_STEPS, oddStep, parseCronStep, stepFits } from '../client/src/schedules/cronSteps';
import { RoutineForm } from '../client/src/schedules/RoutineForm';
import { checkDraft, draftFromRoutine, FREQS, newDraft, previewRuns, type RoutineDraft } from '../client/src/schedules/routineDraft';
import { describeWhen } from '../client/src/schedules/scheduleView';

// "A cada N minutos" e "a cada N horas" no formulário de rotina: o ida e volta entre o formulário e o cron (`*/N * * * *`, `0 */N * * *`), o aviso do cron
// que não repete de N em N, o "quando roda" nos 3 idiomas e o render do formulário.

const NOW = new Date(2026, 10, 18, 10, 0, 0);
const noop = () => {};
type Lang = 'pt-BR' | 'en' | 'es';
const trIn = (lang: Lang) => (key: string, vars?: Record<string, string | number>) =>
  ((messages[lang] as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''));
const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({ ...newDraft('ana', NOW), name: 'Fila', message: 'Olhe a fila', ...over });
const like = (r: Recurrence) => ({ id: 'r1', name: 'Fila', message: 'Olhe a fila', mode: 'new' as const, enabled: true, recurrence: r });
const cron = (expr: string): Recurrence => ({ kind: 'cron', expr });
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('o passo e o cron', () => {
  it('as opções: só os minutos que dividem a hora; horas de 1 a 12', () => {
    expect(MINUTE_STEPS).toEqual([5, 10, 15, 20, 30]);
    expect(HOUR_STEPS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const n of MINUTE_STEPS) expect(60 % n).toBe(0);
  });

  it('monta e lê as duas formas (espaços a mais não atrapalham)', () => {
    expect(cronOfStep({ unit: 'minutes', n: 15 })).toBe('*/15 * * * *');
    expect(cronOfStep({ unit: 'hours', n: 2 })).toBe('0 */2 * * *');
    expect(parseCronStep('*/15 * * * *')).toEqual({ unit: 'minutes', n: 15 });
    expect(parseCronStep('  0   */2 * * *  ')).toEqual({ unit: 'hours', n: 2 });
  });

  it.each(['0 8 * * 1-5', '*/15 * * * 1', '*/15 8 * * *', '5 */2 * * *', '0 */2 * 3 *', '*/5,*/7 * * * *', '10-30/5 * * * *', '*/x * * * *', 'xx'])('%s não é um passo do formulário', (expr) => {
    expect(parseCronStep(expr)).toBeNull();
    expect(oddStep(expr)).toBeNull();
  });

  it('cabe nas opções só com N da lista', () => {
    expect(stepFits({ unit: 'minutes', n: 30 })).toBe(true);
    expect(stepFits({ unit: 'minutes', n: 45 })).toBe(false);
    expect(stepFits({ unit: 'minutes', n: 2 })).toBe(false); // divide 60, mas o formulário não oferece
    expect(stepFits({ unit: 'hours', n: 12 })).toBe(true);
    expect(stepFits({ unit: 'hours', n: 13 })).toBe(false);
    expect(stepFits({ unit: 'hours', n: 0 })).toBe(false);
  });

  it('"estranho" = o passo que não repete de N em N: minutos que não dividem 60, horas acima de 12; os crons certos fora das opções ficam quietos', () => {
    for (const n of [7, 25, 45, 90, 720]) expect(oddStep(`*/${n} * * * *`)).toEqual({ unit: 'minutes', n });
    for (const n of [13, 18, 24]) expect(oddStep(`0 */${n} * * *`)).toEqual({ unit: 'hours', n });
    for (const n of [1, 2, 3, 4, 6, 12, 60]) expect(oddStep(`*/${n} * * * *`)).toBeNull();
    expect(oddStep('*/5 * * * *')).toBeNull();
    expect(oddStep('*/0 * * * *')).toBeNull();
  });
});

describe('formulário ↔ cron (ida e volta)', () => {
  it.each(MINUTE_STEPS.map((n) => [n]))('a cada %i minutos: grava `*/N * * * *` e abre como "a cada N minutos"', (n) => {
    const out = checkDraft(draft({ freq: 'minutes', minutes: String(n) }));
    expect(out).toMatchObject({ ok: true, routine: { recurrence: { kind: 'cron', expr: `*/${n} * * * *` } } });
    if (!out.ok) return;
    const back = draftFromRoutine('ana', like(out.routine.recurrence), NOW);
    expect(back).toMatchObject({ freq: 'minutes', minutes: String(n) });
    expect(checkDraft(back)).toMatchObject({ ok: true, routine: { recurrence: out.routine.recurrence } });
  });

  it.each(HOUR_STEPS.map((n) => [n]))('a cada %i horas: grava `0 */N * * *` e abre como "a cada N horas"', (n) => {
    const out = checkDraft(draft({ freq: 'hours', hours: String(n) }));
    expect(out).toMatchObject({ ok: true, routine: { recurrence: { kind: 'cron', expr: `0 */${n} * * *` } } });
    if (!out.ok) return;
    const back = draftFromRoutine('ana', like(out.routine.recurrence), NOW);
    expect(back).toMatchObject({ freq: 'hours', hours: String(n) });
    expect(checkDraft(back)).toMatchObject({ ok: true, routine: { recurrence: out.routine.recurrence } });
  });

  it('o cron que o formulário grava vale para o servidor (shared) e não leva hora, início nem fim', () => {
    for (const d of [draft({ freq: 'minutes', minutes: '5' }), draft({ freq: 'hours', hours: '12' })]) {
      const out = checkDraft({ ...d, time: '', start: '', until: '2026-01-01' });
      expect(out.ok).toBe(true);
      if (out.ok) expect(normalizeRecurrence(out.routine.recurrence)).toMatchObject({ ok: true });
    }
  });

  it('rotina antiga da ficha (campo `schedule`, sem recorrência) com `*/30` abre em "a cada 30 minutos"', () => {
    const rec = recurrenceOf({ schedule: '*/30 * * * *' });
    expect(draftFromRoutine('ana', like(rec), NOW)).toMatchObject({ freq: 'minutes', minutes: '30' });
  });

  it('o resto do cron segue no cron avançado, com o texto que estava', () => {
    expect(draftFromRoutine('ana', like(cron('0 8 * * 1-5')), NOW)).toMatchObject({ freq: 'cron', cron: '0 8 * * 1-5' });
    expect(draftFromRoutine('ana', like(cron('*/2 * * * *')), NOW)).toMatchObject({ freq: 'cron', cron: '*/2 * * * *' }); // certo, mas fora das opções
    expect(draftFromRoutine('ana', like(cron('30 */2 * * *')), NOW)).toMatchObject({ freq: 'cron', cron: '30 */2 * * *' });
  });

  it.each(['*/45 * * * *', '*/7 * * * *', '*/90 * * * *', '*/720 * * * *', '0 */13 * * *'])('rotina antiga com N que não cabe (%s) abre no cron avançado, sem trocar o texto, e o aviso se aplica', (expr) => {
    const d = draftFromRoutine('ana', like(cron(expr)), NOW);
    expect(d).toMatchObject({ freq: 'cron', cron: expr });
    expect(oddStep(expr)).not.toBeNull();
    expect(checkDraft(d)).toMatchObject({ ok: true, routine: { recurrence: { kind: 'cron', expr } } }); // salvar sem mexer mantém o que era
  });

  it('N fora das opções no próprio formulário não passa (7 min, 13 h, 0 h, vazio)', () => {
    const err = (over: Partial<RoutineDraft>) => {
      const out = checkDraft(draft(over));
      return out.ok ? null : out.error;
    };
    expect(err({ freq: 'minutes', minutes: '7' })).toBe('Minutos: escolha 5, 10, 15, 20 ou 30.');
    expect(err({ freq: 'minutes', minutes: '' })).toBe('Minutos: escolha 5, 10, 15, 20 ou 30.');
    expect(err({ freq: 'hours', hours: '13' })).toBe('Horas: use um número inteiro de 1 a 12.');
    expect(err({ freq: 'hours', hours: '0' })).toBe('Horas: use um número inteiro de 1 a 12.');
    expect(err({ freq: 'hours', hours: '1.5' })).toBe('Horas: use um número inteiro de 1 a 12.');
    expect(err({ freq: 'minutes', minutes: '15' })).toBeNull();
  });

  it('as próximas execuções seguem o relógio: 15 min = :15, :30, :45; 2 h = 12:00, 14:00, 16:00; 5 h recomeça à meia-noite', () => {
    const at1007 = new Date(2026, 10, 18, 10, 7); // 10:07: não é uma hora de execução, então a lista começa na seguinte
    expect(previewRuns(draft({ freq: 'minutes', minutes: '15' }), at1007).map(hhmm)).toEqual(['10:15', '10:30', '10:45']);
    expect(previewRuns(draft({ freq: 'hours', hours: '2' }), at1007).map(hhmm)).toEqual(['12:00', '14:00', '16:00']);
    expect(previewRuns(draft({ freq: 'hours', hours: '5' }), at1007).map(hhmm)).toEqual(['15:00', '20:00', '00:00']);
  });

  it('as duas opções entram na lista de repetição do formulário', () => {
    expect(FREQS).toContain('minutes');
    expect(FREQS).toContain('hours');
  });
});

describe('"quando roda" nos 3 idiomas', () => {
  it.each<[string, Recurrence, Record<Lang, string>]>([
    ['30 minutos', cron('*/30 * * * *'), { 'pt-BR': 'a cada 30 minutos', en: 'every 30 minutes', es: 'cada 30 minutos' }],
    ['2 horas', cron('0 */2 * * *'), { 'pt-BR': 'a cada 2 horas', en: 'every 2 hours', es: 'cada 2 horas' }],
    ['1 hora', cron('0 */1 * * *'), { 'pt-BR': 'a cada hora', en: 'every hour', es: 'cada hora' }],
  ])('%s', (_n, rec, text) => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) expect(describeWhen(rec, trIn(lang), lang)).toBe(text[lang]);
  });

  it('o passo que não repete de N em N mostra a expressão (o "a cada 45 minutos" do shared/cron.ts seria mentira)', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      expect(describeWhen(cron('*/45 * * * *'), trIn(lang), lang)).toBe('Cron: */45 * * * *');
      expect(describeWhen(cron('0 */13 * * *'), trIn(lang), lang)).toBe('Cron: 0 */13 * * *');
    }
  });

  it('cron que dá para ler segue como era: em pt a leitura do shared, nos outros a expressão', () => {
    expect(describeWhen(cron('*/2 * * * *'), trIn('pt-BR'), 'pt-BR')).toBe('a cada 2 minutos');
    expect(describeWhen(cron('0 8 * * 1-5'), trIn('en'), 'en')).toBe('Cron: 0 8 * * 1-5');
  });
});

describe('formulário (render)', () => {
  const html = (d: RoutineDraft, over: Partial<Parameters<typeof RoutineForm>[0]> = {}) =>
    renderToStaticMarkup(createElement(RoutineForm, { draft: d, busy: false, error: null, now: NOW, onChange: noop, onSubmit: noop, onCancel: noop, ...over }));

  it('as duas opções aparecem na lista de repetição', () => {
    const out = html(draft());
    expect(out).toContain('A cada N minutos');
    expect(out).toContain('A cada N horas');
  });

  it('a cada N minutos: as 5 opções, a dica e nada de hora, início ou fim; mostra o quando roda', () => {
    const out = html(draft({ freq: 'minutes', minutes: '15' }));
    for (const n of MINUTE_STEPS) expect(out).toContain(`value="${n}"`);
    expect(out).toContain('15 minutos');
    expect(out).toContain('Roda sempre nos mesmos minutos de cada hora');
    expect(out).toContain('Roda a cada 15 minutos');
    expect(out).not.toContain('type="time"');
    expect(out).not.toContain('type="date"');
    expect(out).not.toContain('sched-warning');
  });

  it('a cada N horas: de 1 a 12, "1 hora" no singular, a dica e nada de hora, início ou fim', () => {
    const out = html(draft({ freq: 'hours', hours: '2' }));
    expect(out).toContain('>1 hora<');
    expect(out).toContain('>12 horas<');
    expect(out.match(/<option/g)!.length).toBeGreaterThanOrEqual(12);
    expect(out).toContain('Roda no minuto 0');
    expect(out).toContain('Roda a cada 2 horas');
    expect(out).not.toContain('type="time"');
    expect(out).not.toContain('type="date"');
  });

  it('cron avançado com passo que não repete de N em N mostra o aviso curto; passo certo, não', () => {
    expect(html(draft({ freq: 'cron', cron: '*/45 * * * *' }))).toContain('O passo de 45 minutos não divide a hora');
    expect(html(draft({ freq: 'cron', cron: '0 */13 * * *' }))).toContain('O passo de 13 horas passa de 12');
    expect(html(draft({ freq: 'cron', cron: '*/2 * * * *' }))).not.toContain('sched-warning');
    expect(html(draft({ freq: 'cron', cron: '0 8 * * 1-5' }))).not.toContain('sched-warning');
  });

  it('com a pergunta de descartar aberta: texto, os dois botões e sem Salvar; sem ela, o Salvar de sempre', () => {
    const asking = html(draft(), { confirmDiscard: { onDiscard: noop, onKeep: noop } });
    expect(asking).toContain('Descartar o que você mudou neste formulário?');
    expect(asking).toContain('>Sim, descartar<');
    expect(asking).toContain('>Continuar editando<');
    expect(asking).not.toContain('type="submit"');
    const normal = html(draft());
    expect(normal).toContain('Salvar rotina');
    expect(normal).not.toContain('Descartar o que você mudou');
  });
});

describe('rotinas na ficha do funcionário (render)', () => {
  it('cron antigo `0 */2 * * *` aparece como "a cada 2 horas"', () => {
    const staff = { id: 'ana', name: 'Ana', projectId: 'p', routines: [{ id: 'a', name: 'Fila', schedule: '0 */2 * * *', message: 'Olhe a fila', mode: 'task', enabled: true }] } as unknown as StaffProfile;
    const out = renderToStaticMarkup(createElement(Routines, { projectId: 'p', staff }));
    expect(out).toContain('a cada 2 horas');
  });
});
