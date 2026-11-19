import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SchedulesResponse } from '../shared/model';
import { ApiError } from '../client/src/api';
import messages from '../client/src/i18n/schedules';
import { dayAfterMonthChange, monthGrid, monthStart, shiftMonth } from '../client/src/schedules/calendar';
import { draftChanged, newDraft, type RoutineDraft } from '../client/src/schedules/routineDraft';
import {
  cancelSchedule,
  enableRoutine,
  escapeStep,
  failureReason,
  type FlowApi,
  readSchedules,
  removeRoutine,
  runRoutineNow,
  saveDraft,
} from '../client/src/schedules/scheduleFlows';
import type { Schedule } from '../client/src/schedules/scheduleView';

// As ações da tela de Agendamentos e da ficha (salvar, ligar/desligar, apagar, rodar agora, cancelar despertador, ler o mês) e o Esc: funções puras com a
// API injetada. Cada fluxo tem um caminho feliz e um de erro; o erro sem mensagem roda nos 3 idiomas.

const NOW = new Date(2026, 10, 18, 10, 0, 0);
type Lang = 'pt-BR' | 'en' | 'es';
const trIn = (lang: Lang) => (key: string, vars?: Record<string, string | number>) =>
  ((messages[lang] as Record<string, string>)[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''));

/** A API falsa: o que o teste não pede devolve vazio. */
const fakeApi = (over: Record<string, unknown> = {}): FlowApi =>
  ({
    schedules: vi.fn(async () => ({ items: [] })),
    saveRoutine: vi.fn(async () => ({ routine: { routineId: 'r-novo', next: '2026-11-19T11:00:00.000Z' } })),
    setRoutineEnabled: vi.fn(async () => ({ routine: {} })),
    deleteRoutine: vi.fn(async () => ({ ok: true })),
    runRoutine: vi.fn(async () => ({ ok: true, text: 'mensagem enviada' })),
    chatCancelWake: vi.fn(async () => ({ ok: true })),
    chatCancelAutoContinue: vi.fn(async () => ({ ok: true })),
    ...over,
  }) as unknown as FlowApi;

const rejecting = (e: unknown) => vi.fn(async () => Promise.reject(e));
const ref = { staffId: 'ana', routineId: 'r1' };
const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({ ...newDraft('ana', NOW), name: 'Revisar', message: 'Revise os PRs', ...over });
const wake: Schedule = { kind: 'wake', sessionId: 's1', staffId: 'ana', at: '2026-11-19T12:00:00.000Z', text: 'olhar o deploy' };
const cont: Schedule = { kind: 'continue', sessionId: 's2', staffId: 'ana', at: '2026-11-19T13:00:00.000Z', text: '' };
const listWith = (items: Schedule[]): SchedulesResponse => ({ items, routines: [], occurrences: [], window: { from: '', to: '', truncated: false }, stateWarning: null });
const noPairing = new ApiError('', 'needs-pairing', null, {}, 403);

/** Cada idioma, o texto padrão do erro sem mensagem e o da recusa por pareamento. */
const DEFAULTS: [Lang, string, string][] = [
  ['pt-BR', 'o servidor não explicou o motivo', 'este navegador não está autorizado a fazer alterações'],
  ['en', 'the server did not say why', 'this browser is not authorized to make changes'],
  ['es', 'el servidor no explicó el motivo', 'este navegador no tiene permiso para hacer cambios'],
];

describe('o motivo da falha', () => {
  it('usa o que o servidor disse', () => {
    expect(failureReason(new Error('Rotina não encontrada'), trIn('pt-BR'))).toBe('Rotina não encontrada');
  });

  it.each(DEFAULTS)('%s: erro sem mensagem e recusa por pareamento ganham texto padrão', (lang, unknown, pairing) => {
    expect(failureReason(new Error(''), trIn(lang))).toBe(unknown);
    expect(failureReason(new Error('   '), trIn(lang))).toBe(unknown);
    expect(failureReason('texto solto', trIn(lang))).toBe(unknown);
    expect(failureReason(noPairing, trIn(lang))).toContain(pairing);
  });

  it('en e es têm as chaves novas do pt-BR', () => {
    const keys = Object.keys(messages['pt-BR']).sort();
    expect(Object.keys(messages.en).sort()).toEqual(keys);
    expect(Object.keys(messages.es).sort()).toEqual(keys);
  });
});

describe('ler o mês', () => {
  const anchor = monthStart(NOW);

  it('pede a janela da grade do mês mostrado, e a da troca de mês é a do mês novo', async () => {
    const api = fakeApi();
    await readSchedules(api, 'p', anchor);
    await readSchedules(api, 'p', shiftMonth(anchor, 1)); // dezembro/2026: o dia 1 cai numa terça, a grade começa em 29/11
    await readSchedules(api, 'p', shiftMonth(anchor, -1)); // outubro/2026: o dia 1 cai numa quinta, a grade começa em 27/09
    const calls = (api.schedules as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(['p', { from: new Date(2026, 10, 1), to: new Date(2026, 11, 6) }]);
    expect(calls[1]).toEqual(['p', { from: new Date(2026, 10, 29), to: new Date(2027, 0, 3) }]);
    expect(calls[2]).toEqual(['p', { from: new Date(2026, 8, 27), to: new Date(2026, 10, 1) }]);
    for (const m of [anchor, shiftMonth(anchor, 1), shiftMonth(anchor, -1)]) expect(monthGrid(m).to.getTime() - monthGrid(m).from.getTime()).toBeLessThanOrEqual(42 * 86_400_000);
  });

  it('caminho feliz: devolve a resposta; servidor velho (só items) vem completo', async () => {
    const out = await readSchedules(fakeApi({ schedules: vi.fn(async () => ({ items: [wake] })) }), 'p', anchor);
    expect(out).toMatchObject({ ok: true, value: { items: [wake], routines: [], occurrences: [], stateWarning: null } });
  });

  it('erro: o motivo do servidor; sem mensagem, o texto padrão', async () => {
    expect(await readSchedules(fakeApi({ schedules: rejecting(new ApiError('Servidor offline', 'offline', null)) }), 'p', anchor)).toEqual({ ok: false, error: 'Servidor offline' });
    expect(await readSchedules(fakeApi({ schedules: rejecting(new Error('')) }), 'p', anchor, trIn('en'))).toEqual({ ok: false, error: 'the server did not say why' });
  });

  it('ao trocar de mês fica escolhido hoje (se o mês é o de hoje) ou o dia 1', () => {
    expect(dayAfterMonthChange(anchor, NOW)).toBe('2026-11-18');
    expect(dayAfterMonthChange(shiftMonth(anchor, 1), NOW)).toBe('2026-12-01');
    expect(dayAfterMonthChange(shiftMonth(anchor, -1), NOW)).toBe('2026-10-01');
  });
});

describe('salvar (criar e editar)', () => {
  it('cria: manda a rotina sem id ao funcionário certo e devolve id, próxima execução e "criada"', async () => {
    const api = fakeApi();
    const out = await saveDraft(api, 'p', draft());
    expect(api.saveRoutine).toHaveBeenCalledTimes(1);
    const [pid, sid, sent] = (api.saveRoutine as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([pid, sid]).toEqual(['p', 'ana']);
    expect(sent).toMatchObject({ name: 'Revisar', message: 'Revise os PRs', mode: 'continue', enabled: true });
    expect('id' in sent).toBe(false);
    expect(out).toMatchObject({ ok: true, value: { routineId: 'r-novo', created: true, next: '2026-11-19T11:00:00.000Z' } });
  });

  it('edita: leva o id e devolve "criada: false"; sem próxima execução devolve null', async () => {
    const api = fakeApi({ saveRoutine: vi.fn(async () => ({ routine: { routineId: 'r1', next: null } })) });
    const out = await saveDraft(api, 'p', draft({ id: 'r1' }));
    expect((api.saveRoutine as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ id: 'r1' });
    expect(out).toMatchObject({ ok: true, value: { routineId: 'r1', created: false, next: null } });
  });

  it('rascunho torto: volta o erro do formulário e não chama o servidor', async () => {
    const api = fakeApi();
    expect(await saveDraft(api, 'p', draft({ name: '  ' }))).toEqual({ ok: false, error: 'Dê um nome à rotina.' });
    expect(api.saveRoutine).not.toHaveBeenCalled();
  });

  it('o servidor recusa: o motivo dele, na frase da tela', async () => {
    const api = fakeApi({ saveRoutine: rejecting(new ApiError('já existem 10 rotinas neste funcionário', null, null, {}, 400)) });
    expect(await saveDraft(api, 'p', draft(), trIn('pt-BR'))).toEqual({ ok: false, error: 'Não deu certo: já existem 10 rotinas neste funcionário' });
  });

  it('a rede cai: erro de rede também aparece', async () => {
    const api = fakeApi({ saveRoutine: rejecting(new ApiError('Não consegui falar com o servidor', 'offline', null)) });
    expect(await saveDraft(api, 'p', draft(), trIn('pt-BR'))).toEqual({ ok: false, error: 'Não deu certo: Não consegui falar com o servidor' });
  });

  it.each(DEFAULTS)('%s: erro sem mensagem mostra o texto padrão (nunca deixa o formulário sem aviso)', async (lang, unknown, pairing) => {
    const none = await saveDraft(fakeApi({ saveRoutine: rejecting(new Error('')) }), 'p', draft(), trIn(lang));
    expect(none.ok).toBe(false);
    expect(!none.ok && none.error).toContain(unknown);
    const paired = await saveDraft(fakeApi({ saveRoutine: rejecting(noPairing) }), 'p', draft(), trIn(lang));
    expect(!paired.ok && paired.error).toContain(pairing);
  });

  it('"a cada 15 minutos" e "a cada 2 horas" vão ao servidor como cron', async () => {
    const api = fakeApi();
    await saveDraft(api, 'p', draft({ freq: 'minutes', minutes: '15' }));
    await saveDraft(api, 'p', draft({ freq: 'hours', hours: '2' }));
    const calls = (api.saveRoutine as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![2].recurrence).toEqual({ kind: 'cron', expr: '*/15 * * * *' });
    expect(calls[1]![2].recurrence).toEqual({ kind: 'cron', expr: '0 */2 * * *' });
  });
});

describe('ligar e desligar', () => {
  it('caminho feliz: manda o estado novo para a rotina certa', async () => {
    const api = fakeApi();
    expect(await enableRoutine(api, 'p', ref, false)).toEqual({ ok: true, value: false });
    expect(api.setRoutineEnabled).toHaveBeenCalledWith('p', 'ana', 'r1', false);
  });

  it('erro: o motivo na frase da tela; sem mensagem, o texto padrão', async () => {
    expect(await enableRoutine(fakeApi({ setRoutineEnabled: rejecting(new Error('Rotina não encontrada')) }), 'p', ref, true, trIn('pt-BR'))).toEqual({ ok: false, error: 'Não deu certo: Rotina não encontrada' });
    expect(await enableRoutine(fakeApi({ setRoutineEnabled: rejecting(new Error('')) }), 'p', ref, true, trIn('es'))).toEqual({ ok: false, error: 'No funcionó: el servidor no explicó el motivo' });
  });
});

describe('apagar', () => {
  it('caminho feliz: apaga a rotina certa', async () => {
    const api = fakeApi();
    expect(await removeRoutine(api, 'p', ref)).toEqual({ ok: true, value: null });
    expect(api.deleteRoutine).toHaveBeenCalledWith('p', 'ana', 'r1');
  });

  it('erro: a rotina fica (o desfecho é erro) com o motivo; sem mensagem, o texto padrão', async () => {
    expect(await removeRoutine(fakeApi({ deleteRoutine: rejecting(new Error('sem permissão')) }), 'p', ref, trIn('en'))).toEqual({ ok: false, error: 'That did not work: sem permissão' });
    expect(await removeRoutine(fakeApi({ deleteRoutine: rejecting(new Error('')) }), 'p', ref, trIn('en'))).toEqual({ ok: false, error: 'That did not work: the server did not say why' });
  });
});

describe('rodar agora', () => {
  it('caminho feliz: a frase do resultado, com o nome da rotina', async () => {
    const api = fakeApi();
    expect(await runRoutineNow(api, 'p', ref, 'Revisar PRs')).toEqual({ ok: true, value: '"Revisar PRs": mensagem enviada' });
    expect(api.runRoutine).toHaveBeenCalledWith('p', 'ana', 'r1');
  });

  it('pulada, e rotina que sumiu', async () => {
    const skipped = fakeApi({ runRoutine: vi.fn(async () => ({ ok: false, text: 'pulada: o funcionário está ocupado' })) });
    expect(await runRoutineNow(skipped, 'p', ref, 'Revisar PRs')).toEqual({ ok: true, value: '"Revisar PRs": não rodou (o funcionário está ocupado)' });
    const gone = fakeApi({ runRoutine: vi.fn(async () => null) });
    expect(await runRoutineNow(gone, 'p', ref, 'Revisar PRs')).toEqual({ ok: true, value: 'Rotina não encontrada.' });
  });

  it('erro: o motivo na frase da tela; sem mensagem, o texto padrão', async () => {
    expect(await runRoutineNow(fakeApi({ runRoutine: rejecting(new Error('limite de uso')) }), 'p', ref, 'X', trIn('pt-BR'))).toEqual({ ok: false, error: 'Não deu certo: limite de uso' });
    expect(await runRoutineNow(fakeApi({ runRoutine: rejecting(new Error('')) }), 'p', ref, 'X', trIn('pt-BR'))).toEqual({ ok: false, error: 'Não deu certo: o servidor não explicou o motivo' });
  });
});

describe('cancelar despertador e "continue"', () => {
  const reload = (r: SchedulesResponse | null) => vi.fn(async () => r);

  it('caminho feliz: despertador e "continue" chamam a rota de cada um', async () => {
    const api = fakeApi();
    expect(await cancelSchedule(api, 'p', wake, reload(null))).toEqual({ kind: 'cancelled' });
    expect(api.chatCancelWake).toHaveBeenCalledWith('p', 's1');
    expect(api.chatCancelAutoContinue).not.toHaveBeenCalled();
    expect(await cancelSchedule(api, 'p', cont, reload(null))).toEqual({ kind: 'cancelled' });
    expect(api.chatCancelAutoContinue).toHaveBeenCalledWith('p', 's2');
  });

  it('o servidor diz que já não havia: "já não existe"', async () => {
    const api = fakeApi({ chatCancelWake: vi.fn(async () => ({ ok: false })) });
    expect(await cancelSchedule(api, 'p', wake, reload(null))).toEqual({ kind: 'gone' });
  });

  it('erro, mas a lista relida já não tem o agendamento: "já não existe" (404 e rede caída chegam iguais)', async () => {
    const again = reload(listWith([cont]));
    expect(await cancelSchedule(fakeApi({ chatCancelWake: rejecting(new Error('404')) }), 'p', wake, again)).toEqual({ kind: 'gone' });
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('erro e o agendamento continua lá: o motivo na linha', async () => {
    const api = fakeApi({ chatCancelWake: rejecting(new Error('Não consegui falar com o servidor')) });
    expect(await cancelSchedule(api, 'p', wake, reload(listWith([wake])), trIn('pt-BR'))).toEqual({ kind: 'failed', error: 'Não deu para cancelar: Não consegui falar com o servidor' });
  });

  it.each(DEFAULTS)('%s: erro sem mensagem (e a releitura falhou) mostra o texto padrão', async (lang, unknown) => {
    const out = await cancelSchedule(fakeApi({ chatCancelWake: rejecting(new Error('')) }), 'p', wake, reload(null), trIn(lang));
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toContain(unknown);
  });
});

describe('o Esc', () => {
  const form = (dirty: boolean, asking = false) => ({ dirty, asking });

  it.each<[string, Parameters<typeof escapeStep>[0], ReturnType<typeof escapeStep>]>([
    ['sem nada aberto: fecha a tela', { confirming: false, form: null }, 'close-screen'],
    ['pergunta aberta (cancelar/apagar/rodar): fecha só ela, mesmo com formulário', { confirming: true, form: form(true) }, 'close-confirm'],
    ['formulário sem mudança: fecha direto', { confirming: false, form: form(false) }, 'close-form'],
    ['formulário mudado: pergunta antes de descartar', { confirming: false, form: form(true) }, 'ask-discard'],
    ['perguntando: Esc de novo volta a editar (não descarta)', { confirming: false, form: form(true, true) }, 'keep-editing'],
  ])('%s', (_n, state, step) => {
    expect(escapeStep(state)).toBe(step);
  });

  it('o rascunho "mudou" só se algum campo mudou (dias da semana pelo conteúdo)', () => {
    const opened = draft({ weekdays: [1, 3] });
    expect(draftChanged({ ...opened, weekdays: [1, 3] }, opened)).toBe(false);
    expect(draftChanged({ ...opened, name: 'Outro' }, opened)).toBe(true);
    expect(draftChanged({ ...opened, weekdays: [1, 4] }, opened)).toBe(true);
    expect(draftChanged({ ...opened, freq: 'minutes' }, opened)).toBe(true);
    expect(draftChanged({ ...opened, catchUp: true }, opened)).toBe(true);
  });
});

describe('a tela de produção não carrega props de teste', () => {
  it('SchedulesBoard não aceita initialData nem initialNow (só o wrapper de teste leva `seed`)', () => {
    const src = readFileSync('client/src/schedules/SchedulesBoard.tsx', 'utf8');
    expect(src).not.toMatch(/initialData|initialNow/);
    const props = /interface Props \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(props).not.toMatch(/seed|initial/);
    expect(src).toMatch(/export function SchedulesBoardSeeded/);
  });
});
