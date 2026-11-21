import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATCH_UP_MAX_HOURS, SCHEDULE_WINDOW_MAX_DAYS, type AccountUsage, type CalendarRecurrence, type Project, type Routine, type StaffProfile } from '../shared/model';
import { recurrenceOf } from '../shared/recurrence';
import { RoutineScheduler } from '../server/routines';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { admit, PAIR_COOKIE, Pairing } from '../server/pairing';
import type { ToolAdapter } from '../server/adapters/types';
import { buildSchedules, occurrenceState, ScheduleWindowError, scheduleWindow, type RoutineSnapshot } from '../server/scheduleView';
import { StaffError, StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile, RoutinesSchema } from '../server/staff/store';
import { buildTeamExport, planTeamImport } from '../server/staff/teamExport';
import { removeTemp } from './support/tmp';

// A tela central de agendamentos: o que o GET /schedules monta (rotinas, ocorrências da janela), a gravação de UMA rotina pelo caminho da ficha
// (criar, editar, ligar/desligar, apagar), o schema do "quando roda" e as rotas só do navegador. 2026-11-18 é quarta-feira.

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-schedules-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(() => removeTemp(root));

const project = (): Project => ({ id: 'proj-id', path: projectPath, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });
const hire = async (name: string) => (await service().hire('proj-id', { name, role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false }, true))!.profile;

const at = (day: number, h = 0, mi = 0) => new Date(2026, 10, day, h, mi);
const weekly: CalendarRecurrence = { kind: 'weekly', interval: 2, weekdays: [1, 3], time: '09:00', start: '2026-11-04' };
const input = (over: Record<string, unknown> = {}) => ({ name: 'Quinzenal', message: 'Faça o relatório', mode: 'new', enabled: true, recurrence: weekly, ...over });

describe('schema da rotina: cron antigo ou recorrência', () => {
  it('ficha antiga (só `schedule` cron) segue válida e é lida como cron', () => {
    const parsed = RoutinesSchema.parse([{ id: 'r1', name: 'Velha', schedule: '0 19 * * 1-5', message: 'x', mode: 'continue', enabled: true }]);
    expect(parsed[0]).toEqual({ id: 'r1', name: 'Velha', schedule: '0 19 * * 1-5', message: 'x', mode: 'continue', enabled: true });
    expect(recurrenceOf(parsed[0]!)).toEqual({ kind: 'cron', expr: '0 19 * * 1-5' });
  });

  it('calendário grava `recurrence` e deixa `schedule` vazio; cron em `recurrence` volta para o formato antigo (só `schedule`)', () => {
    const [cal, cron] = RoutinesSchema.parse([
      { id: 'a', name: 'A', message: 'x', recurrence: { kind: 'weekly', start: '2026-11-04', time: '09:00', interval: 2, weekdays: [3, 1] }, catchUpHours: 12 },
      { id: 'b', name: 'B', message: 'x', recurrence: { kind: 'cron', expr: '0 8 * * *' } },
    ]);
    expect(cal).toMatchObject({ schedule: '', recurrence: { kind: 'weekly', interval: 2, weekdays: [1, 3] }, catchUpHours: 12 });
    expect(cron).toMatchObject({ schedule: '0 8 * * *' });
    expect(cron!.recurrence).toBeUndefined();
    expect(cron!.catchUpHours).toBeUndefined();
  });

  it('recusa com o motivo: sem "quando roda", recorrência inválida, atraso fora de 0 a 168 h ou fracionado', () => {
    const msg = (r: Record<string, unknown>) => {
      const p = RoutinesSchema.safeParse([{ id: 'r', name: 'R', message: 'x', ...r }]);
      return p.success ? null : p.error.issues[0]!.message;
    };
    expect(msg({})).toMatch(/horário/);
    expect(msg({ schedule: '0 25 * * *' })).toMatch(/horário: hora/);
    expect(msg({ recurrence: { kind: 'daily', start: '2026-02-30', time: '09:00' } })).toMatch(/início/);
    expect(msg({ recurrence: { kind: 'daily', start: '2026-11-18', time: '09:00' }, catchUpHours: CATCH_UP_MAX_HOURS })).toBeNull();
    expect(msg({ recurrence: { kind: 'daily', start: '2026-11-18', time: '09:00' }, catchUpHours: CATCH_UP_MAX_HOURS + 1 })).toMatch(/0 a 168/);
    expect(msg({ schedule: '0 8 * * *', catchUpHours: -1 })).toMatch(/0 a 168/);
    expect(msg({ schedule: '0 8 * * *', catchUpHours: 1.5 })).toMatch(/horas inteiras/);
  });

  it('a equipe em arquivo leva a recorrência e o atraso (ida e volta, desligadas) e ainda lê o formato antigo', async () => {
    const staff = {
      id: 'ana-1',
      projectId: 'proj',
      name: 'Ana',
      role: 'Dev',
      mission: 'Fazer',
      rules: [],
      doneWhen: '',
      autonomy: 'manual',
      engine: 'claude',
      model: null,
      effort: null,
      personality: null,
      playbook: null,
      worktree: false,
      agents: [],
      skills: [],
      mcps: null,
      reportsTo: [],
      sessions: [],
      routines: [
        { id: 'q', name: 'Quinzenal', schedule: '', recurrence: weekly, catchUpHours: 8, message: 'Relatório', mode: 'new', enabled: true },
        { id: 'c', name: 'Cron', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue', enabled: true },
      ],
    } as unknown as StaffProfile;
    const file = await buildTeamExport([staff]);
    expect(file.staff[0]!.routines).toEqual([
      { id: 'q', name: 'Quinzenal', schedule: '', recurrence: weekly, catchUpHours: 8, message: 'Relatório', mode: 'new' },
      { id: 'c', name: 'Cron', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue' },
    ]);
    const plan = await planTeamImport(JSON.parse(JSON.stringify(file)), { localMcps: [] });
    expect(plan.staff[0]!.routines).toEqual([
      { id: 'q', name: 'Quinzenal', schedule: '', recurrence: weekly, catchUpHours: 8, message: 'Relatório', mode: 'new', enabled: false },
      { id: 'c', name: 'Cron', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue', enabled: false },
    ]);
  });
});

describe('janela do calendário', () => {
  const now = at(18, 10, 30);

  it('sem from/to: do começo de hoje até 31 dias; só um dos dois: o outro sai 31 dias dele', () => {
    expect(scheduleWindow(null, null, now)).toEqual({ from: at(18, 0), to: new Date(at(18, 0).getTime() + 31 * 86_400_000) });
    const from = scheduleWindow('2026-11-01T00:00:00Z', null, now);
    expect(from.to.getTime() - from.from.getTime()).toBe(31 * 86_400_000);
    const to = scheduleWindow(null, '2026-12-01T00:00:00Z', now);
    expect(to.to.getTime() - to.from.getTime()).toBe(31 * 86_400_000);
  });

  it(`passa até ${SCHEDULE_WINDOW_MAX_DAYS} dias; além disso, data inválida ou to antes de from, é erro`, () => {
    expect(() => scheduleWindow('2026-11-01T00:00:00Z', '2027-01-02T00:00:00Z', now)).not.toThrow(); // 62 dias
    expect(() => scheduleWindow('2026-11-01T00:00:00Z', '2027-01-02T00:00:01Z', now)).toThrow(ScheduleWindowError);
    expect(() => scheduleWindow('2026-11-01T00:00:00Z', '2026-10-01T00:00:00Z', now)).toThrow(/depois de from/);
    expect(() => scheduleWindow('ontem', '2026-11-30T00:00:00Z', now)).toThrow(/from/);
    expect(() => scheduleWindow('2026-11-01T00:00:00Z', '1', now)).toThrow(/to/);
  });
});

describe('o que a tela recebe: rotinas e ocorrências', () => {
  const profile = (routines: Routine[]): StaffProfile => ({ id: 'ana-1', projectId: 'proj', name: 'Ana', sessions: [], routines }) as unknown as StaffProfile;
  const base = { message: 'x', mode: 'continue' as const, enabled: true };
  const none = async () => null;

  it('devolve todas as rotinas (ligadas ou não) com a recorrência resolvida, descrição e próxima; ocorrências só das ligadas na janela', async () => {
    const staff = profile([
      { id: 'velha', name: 'Cron antigo', schedule: '0 19 * * 1-5', ...base },
      { id: 'quinz', name: 'Quinzenal', schedule: '', recurrence: weekly, catchUpHours: 4, ...base },
      { id: 'off', name: 'Desligada', schedule: '0 8 * * *', ...base, enabled: false },
      { id: 'ruim', name: 'Editada à mão', schedule: '99 * * * *', ...base },
    ]);
    const now = at(18, 10, 30);
    const out = await buildSchedules([staff], none, { from: at(18, 0), to: at(25, 0) }, now);
    expect(out.routines.map((r) => r.routineId)).toEqual(['velha', 'quinz', 'off', 'ruim']);
    expect(out.routines[0]).toMatchObject({ recurrence: { kind: 'cron', expr: '0 19 * * 1-5' }, description: 'dias úteis às 19:00', next: at(18, 19).toISOString(), invalid: null, catchUpHours: 0, staffName: 'Ana' });
    expect(out.routines[1]).toMatchObject({ recurrence: weekly, description: 'quinzenal (seg e qua) às 09:00', next: at(30, 9).toISOString(), catchUpHours: 4 });
    expect(out.routines[2]).toMatchObject({ enabled: false, next: null });
    expect(out.routines[3]).toMatchObject({ next: null, description: '' });
    expect(out.routines[3]!.invalid).toMatch(/horário/);
    // 18 (qua) 19h, 19, 20 (qui, sex) 19h, 23, 24 (seg, ter) 19h; a quinzenal já passou o 18 às 9h (antes de agora, sem estado conhecido).
    expect(out.occurrences.filter((o) => o.routineId === 'velha').map((o) => o.at)).toEqual([at(18, 19), at(19, 19), at(20, 19), at(23, 19), at(24, 19)].map((d) => d.toISOString()));
    expect(out.occurrences.filter((o) => o.routineId === 'quinz').map((o) => [o.at, o.state])).toEqual([[at(18, 9).toISOString(), 'unknown']]);
    expect(out.occurrences.some((o) => o.routineId === 'off' || o.routineId === 'ruim')).toBe(false);
    expect(out.truncated).toBe(false);
    expect(out.occurrences.map((o) => o.at)).toEqual([...out.occurrences.map((o) => o.at)].sort());
  });

  it('o estado de cada ocorrência: por vir, o que o histórico lembra, descartada em lote, desconhecida; antes do marco não existe', async () => {
    const snap: RoutineSnapshot = {
      last: { at: at(18, 9).toISOString(), ok: true, text: 'mandada' },
      history: [
        { state: 'ran', due: at(18, 9).toISOString(), at: at(18, 9).toISOString(), text: 'mandada' },
        { state: 'discarded', due: at(17, 9).toISOString(), from: at(15, 9).toISOString(), count: 3, at: at(17, 12).toISOString(), text: 'perdida' },
        { state: 'uncertain', due: at(14, 9).toISOString(), at: at(14, 9).toISOString(), text: 'caiu' },
      ],
      armedAt: at(12, 9).toISOString(),
      inFlight: null,
      cursor: at(18, 9).getTime(),
    };
    const now = at(18, 10);
    const daily: CalendarRecurrence = { kind: 'daily', interval: 1, time: '09:00', start: '2026-11-01' };
    const staff = profile([{ id: 'd', name: 'Diária', schedule: '', recurrence: daily, ...base }]);
    const out = await buildSchedules([staff], async () => snap, { from: at(10, 0), to: at(20, 0) }, now);
    const states = Object.fromEntries(out.occurrences.map((o) => [new Date(o.at).getDate(), o.state]));
    expect(states).toEqual({ 12: 'unknown', 13: 'unknown', 14: 'uncertain', 15: 'discarded', 16: 'discarded', 17: 'discarded', 18: 'ran', 19: 'upcoming' });
    expect(out.routines[0]).toMatchObject({ armedAt: snap.armedAt, last: snap.last, inFlight: null });
    expect(out.routines[0]!.history).toHaveLength(3);
    // As do dia 10 e 11 são de antes do marco (9h de 12/11): a rotina não existia.
    expect(out.occurrences.some((o) => new Date(o.at).getDate() < 12)).toBe(false);
  });

  it('o que passou do cursor e ainda não foi tratado (ou está em andamento) é "por vir", não desconhecido', () => {
    const snap: RoutineSnapshot = { last: null, history: [], armedAt: null, inFlight: at(18, 9).toISOString(), cursor: at(18, 9).getTime() };
    expect(occurrenceState(at(18, 9), at(18, 9, 5), snap)).toBe('upcoming');
    expect(occurrenceState(at(18, 9, 30), at(18, 9, 40), { ...snap, inFlight: null })).toBe('upcoming');
    expect(occurrenceState(at(18, 8), at(18, 9, 40), { ...snap, inFlight: null })).toBe('unknown');
  });

  it('com o agendador de verdade: a rotina ligada pela tela aparece com próxima ocorrência e o histórico depois de rodar', async () => {
    const file = path.join(root, 'view-estado.json');
    const rs: Routine[] = [{ id: 'r1', name: 'Revisar', schedule: '', recurrence: { kind: 'daily', interval: 1, time: '09:00', start: '2026-11-01' }, catchUpHours: 6, ...base }];
    const sched = new RoutineScheduler({ file, listStaff: async () => [profile(rs)], run: async () => ({ ok: true, text: 'mandada' }), log: () => {} });
    await sched.sync(profile(rs), at(18, 8));
    await sched.tick(at(18, 12)); // o 9h ficou para trás: roda atrasado
    const out = await buildSchedules([profile(rs)], (key) => sched.snapshot(key), { from: at(17, 0), to: at(20, 0) }, at(18, 12));
    expect(out.routines[0]).toMatchObject({ next: at(19, 9).toISOString(), last: { ok: true, text: 'mandada' } });
    expect(out.routines[0]!.history[0]).toMatchObject({ state: 'ran', due: at(18, 9).toISOString(), lateMin: 180 });
    expect(out.occurrences.map((o) => [new Date(o.at).getDate(), o.state])).toEqual([
      [18, 'ran'],
      [19, 'upcoming'],
    ]);
  });
});

describe('gravar UMA rotina pelo caminho da ficha', () => {
  it('cria com id do servidor, edita no mesmo lugar, liga e desliga, apaga; ficha ou rotina que não existe devolve null', async () => {
    const svc = service();
    const ana = await hire('Ana Rotinas');
    const created = (await svc.saveRoutine('proj-id', ana.id, input()))!;
    expect(created.routineId).toMatch(/^r-[0-9a-f]{6}$/);
    const second = (await svc.saveRoutine('proj-id', ana.id, input({ name: 'Segunda', recurrence: { kind: 'daily', start: '2026-11-18', time: '07:00' } })))!;
    expect(second.profile.routines!.map((r) => r.name)).toEqual(['Quinzenal', 'Segunda']);
    // O que ficou no disco: calendário em `recurrence`, `schedule` vazio.
    expect((await readProfile(projectPath, ana.id))!.routines![0]).toMatchObject({ id: created.routineId, schedule: '', recurrence: weekly, mode: 'new', enabled: true });

    const edited = (await svc.saveRoutine('proj-id', ana.id, input({ id: created.routineId, name: 'Quinzenal v2', catchUpHours: 12 })))!;
    expect(edited.routineId).toBe(created.routineId);
    expect(edited.profile.routines!.map((r) => r.name)).toEqual(['Quinzenal v2', 'Segunda']);
    expect(edited.profile.routines![0]!.catchUpHours).toBe(12);

    const off = (await svc.setRoutineEnabled('proj-id', ana.id, created.routineId, false))!;
    expect(off.routines!.find((r) => r.id === created.routineId)!.enabled).toBe(false);
    expect((await readProfile(projectPath, ana.id))!.routines!.find((r) => r.id === created.routineId)!.enabled).toBe(false);

    const gone = (await svc.deleteRoutine('proj-id', ana.id, created.routineId))!;
    expect(gone.routines!.map((r) => r.name)).toEqual(['Segunda']);

    expect(await svc.setRoutineEnabled('proj-id', ana.id, 'nao-existe', true)).toBeNull();
    expect(await svc.deleteRoutine('proj-id', ana.id, 'nao-existe')).toBeNull();
    expect(await svc.saveRoutine('proj-id', 'ninguem', input())).toBeNull();
    expect(await svc.saveRoutine('outro-projeto', ana.id, input())).toBeNull();
  });

  it('entrada inválida volta como erro do servidor (400) e nada é gravado; teto de 10 por ficha vale', async () => {
    const svc = service();
    const bia = await hire('Bia Rotinas');
    await expect(svc.saveRoutine('proj-id', bia.id, input({ recurrence: { kind: 'weekly', start: '2026-11-04', time: '25:00' } }))).rejects.toThrow(StaffError);
    await expect(svc.saveRoutine('proj-id', bia.id, input({ catchUpHours: 200 }))).rejects.toThrow(/0 a 168/);
    await expect(svc.saveRoutine('proj-id', bia.id, 'texto')).rejects.toThrow(/rotina inválida/);
    await expect(svc.saveRoutine('proj-id', bia.id, input({ id: 'Id Inválido!' }))).rejects.toThrow(/id de rotina/);
    expect((await readProfile(projectPath, bia.id))!.routines ?? []).toEqual([]);
    for (let i = 0; i < 10; i++) await svc.saveRoutine('proj-id', bia.id, input({ name: `R${i}` }));
    await expect(svc.saveRoutine('proj-id', bia.id, input({ name: 'R10' }))).rejects.toThrow(/no máximo 10/);
  });

  it('duas gravações ao mesmo tempo não perdem uma à outra (na vez da ficha)', async () => {
    const svc = service();
    const cris = await hire('Cris Rotinas');
    await Promise.all([1, 2, 3, 4].map((i) => svc.saveRoutine('proj-id', cris.id, input({ name: `Paralela ${i}` }))));
    expect((await readProfile(projectPath, cris.id))!.routines!.map((r) => r.name).sort()).toEqual(['Paralela 1', 'Paralela 2', 'Paralela 3', 'Paralela 4']);
  });

  it('ficha antiga com `schedule` cron no disco segue sendo lida e editável (liga/desliga) sem virar outra coisa', async () => {
    const svc = service();
    const dan = await hire('Dan Rotinas');
    const file = path.join(projectPath, '.myco', 'staff', `${dan.id}.json`);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.routines = [{ id: 'velha', name: 'Velha', schedule: '0 19 * * 1-5', message: 'x', mode: 'continue', enabled: true }];
    await fs.writeFile(file, JSON.stringify(raw));
    const read = (await readProfile(projectPath, dan.id))!.routines![0]!;
    expect(recurrenceOf(read)).toEqual({ kind: 'cron', expr: '0 19 * * 1-5' });
    const off = (await svc.setRoutineEnabled('proj-id', dan.id, 'velha', false))!;
    expect(off.routines![0]).toEqual({ id: 'velha', name: 'Velha', schedule: '0 19 * * 1-5', message: 'x', mode: 'continue', enabled: false });
  });
});

describe('rotas: só pelo Claudio’s Club', () => {
  let index: string;
  beforeAll(async () => {
    index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
  });
  const block = (marker: string) => {
    const at = index.indexOf(marker);
    expect(at, marker).toBeGreaterThan(0);
    return index.slice(at, at + 520);
  };

  it('GET /schedules (cookie do pareamento) e as rotas de rotina (POST da tela) recusam quem não é a tela, e nenhuma está na lista do funcionário nem liberada à sandbox', () => {
    expect(block('new RegExp(`^/api/projects/${ID}/schedules$`)')).toMatch(/if \(!paired\) throw new BadRequest\(/);
    for (const marker of [
      'new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/save$`)',
      'new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/enabled$`)',
      'new RegExp(`^/api/projects/${ID}/staff/${ID}/routines/${ID}/delete$`)',
    ]) {
      expect(block(marker), marker).toMatch(/if \(!fromBrowser\) throw new BadRequest\(/);
    }
    for (const p of ['/api/projects/p1/schedules', '/api/projects/p1/staff/ana/routines', '/api/projects/p1/staff/ana/routines/save', '/api/projects/p1/staff/ana/routines/r1/enabled', '/api/projects/p1/staff/ana/routines/r1/delete']) {
      expect(staffMayPost(p), p).toBe(false);
      expect(sandboxVerdict(p.endsWith('schedules') ? 'GET' : 'POST', p, 'p1'), p).not.toBeNull();
    }
  });

  it('causa do erro do botão: o GET da página não leva Origin, então `fromBrowser` é falso mesmo pareado; o cookie (`paired`) vale', async () => {
    const pairing = new Pairing(path.join(root, 'pair', 'pairing.key'));
    const server = http.createServer((req, res) => {
      const a = admit(req, res, new URL(req.url ?? '/', 'http://localhost'), pairing, { isLocalOrigin: () => true, log: () => {} });
      if (a.done) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ fromBrowser: a.fromBrowser, paired: pairing.isPaired(req.headers.cookie) }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const get = async (headers: Record<string, string>) => {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/p/schedules`, { headers });
      return res.json();
    };
    try {
      const cookie = `${PAIR_COOKIE}=${pairing.cookieValue()}`;
      // O que o navegador manda num fetch do mesmo site (medido num Chrome de verdade: GET sem Origin, POST com Origin).
      expect(await get({ cookie })).toEqual({ fromBrowser: false, paired: true });
      expect(await get({ cookie, origin: 'http://claudio.localhost:4848' })).toEqual({ fromBrowser: true, paired: true });
      expect(await get({})).toEqual({ fromBrowser: false, paired: false });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('toda gravação de rotina arma o agendador na hora (a antiga e as três novas)', () => {
    const save = block('new RegExp(`^/api/projects/${ID}/staff/${ID}/routines$`)');
    expect(save).toContain('routinesSaved(profile)');
    for (const marker of ['routines/save$`)', 'routines/${ID}/enabled$`)', 'routines/${ID}/delete$`)']) expect(block(marker)).toContain('routinesSaved(');
  });
});
