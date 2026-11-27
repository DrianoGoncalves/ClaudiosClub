import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Routine, StaffProfile, Task, TurnCapHit } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { ChatManager } from '../server/chat/manager';
import { ResumeFile, resumeAfterRestart, type ResumeEntry } from '../server/chat/resume';
import { readConfig } from '../server/config';
import { sweepFreelas } from '../server/freelaSweep';
import { assertProjectRoute, installOwnership, NotOwnerError, ownsProject, OWNER_SUBDIR, ProjectOwnership } from '../server/projectOwner';
import { RoutineScheduler, ownedRoutineStaff } from '../server/routines';
import { StaffService } from '../server/staff/service';
import { listProjectStaff, readProfile, saveProfile } from '../server/staff/store';
import { TaskService } from '../server/tasks';

// Instância sem a posse só lê (t-f50944). O núcleo da trava está em projectOwner.test.ts; aqui, cada ponto que grava ou age: a fila, a recuperação de reinício
// (o incidente do t-963b58), as varreduras, a abertura de conversas, a retomada do boot, as rotinas e as rotas de escrita. Cada teste tem o CONTROLE: o mesmo
// cenário com a posse faz a coisa, para provar que o "não fez nada" da instância de teste não é só um cenário que nunca faria.

// O que lê MYCO_HOME (config, cargos) usa uma pasta temporária, não o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-gates-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-gates-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

const alive = new Set<number>();
let pids = 5000;
/** O servidor principal e a instância de teste (MYCO_HOME=/tmp/myco-leo do incidente): casas diferentes, os dois vivos. */
let MAIN: ProjectOwnership;
let TESTE: ProjectOwnership;
const instances: ProjectOwnership[] = [];
function club(name: string): ProjectOwnership {
  const pid = ++pids;
  alive.add(pid);
  const o = new ProjectOwnership({ home: path.join(root, 'homes', name), defaultHome: path.join(root, 'homes', 'main'), pid, isAlive: (p) => alive.has(p), log: () => {} });
  o.open();
  instances.push(o);
  return o;
}
beforeEach(() => {
  MAIN = club('main');
  TESTE = club('teste');
});
afterEach(() => {
  installOwnership(null);
  for (const o of instances.splice(0)) o.releaseSync();
});

let n = 0;
const read = (f: string) => fs.readFile(f, 'utf8');
const HOUR = 3_600_000;
const longAgo = () => new Date(Date.now() - HOUR).toISOString();
const ana = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile;

/** Um projeto cujo dono registrado é o principal, com as tarefas gravadas à mão, e um TaskService com ganchos que anotam o que acontece. */
async function world(tasks: Array<Partial<Task> & { id: string }>, profile: Partial<StaffProfile> = {}, register = true) {
  const dir = path.join(root, `proj-${n++}`);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const t0 = longAgo();
  const full = tasks.map((t) => ({ title: t.id, description: '', status: 'todo', staffId: 'ana-1', sessionId: null, plan: null, branch: null, pr: null, createdAt: t0, updatedAt: t0, history: [], ...t }));
  const file = path.join(dir, '.myco', 'tasks.json');
  await fs.writeFile(file, JSON.stringify(full, null, 2) + '\n');
  if (register) expect((await MAIN.claim(dir)).owner).toBe(true); // o principal já registrou (é o que a subida dele faz)
  const state = {
    opened: 0,
    sentTo: [] as Array<{ session: string; text: string }>,
    cutAsked: [] as string[],
    cut: null as TurnCapHit | null,
    overrides: [] as string[],
  };
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ({ ...ana, ...profile } as StaffProfile) : null),
    send: async () => `s-novo-${++state.opened}`,
    sendTo: async (_p, session, _s, text) => {
      state.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => false, // a conversa dele NÃO é conhecida por quem está perguntando (o caso da instância de teste do t-963b58)
    isSessionWorking: () => false,
    restartCut: async (_p, session) => {
      state.cutAsked.push(session);
      return state.cut;
    },
    setOverride: (session) => void state.overrides.push(session),
    resourceGate: async () => ({ ok: true, release: () => {} }),
    stopHit: async () => null,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const tasksNow = async () => JSON.parse(await read(file)) as Task[];
  const get = async (id: string) => (await tasksNow()).find((t) => t.id === id)!;
  return { dir, file, svc, state, tasksNow, get };
}

describe('item 1: instância sem a posse não grava card, não roda fila nem recuperação de reinício', () => {
  it('o incidente do t-963b58: card em "fazendo" com a conversa viva em outro servidor — a de teste não o manda para Aguardar nem pergunta o corte', async () => {
    const w = await world([{ id: 'x', status: 'doing', sessionId: 's-1' }]);
    w.state.cut = { kind: 'restart', action: 'browser_navigate claudio.localhost:5173' }; // o que a de teste leu: tool_use sem resultado, barrada pelo hook
    const before = await read(w.file);

    installOwnership(TESTE);
    await w.svc.tick();
    await w.svc.tick();
    expect(w.state.cutAsked).toEqual([]);
    expect(w.state.sentTo).toEqual([]);
    expect(await read(w.file)).toBe(before); // nem um byte
    expect(await w.get('x')).toMatchObject({ status: 'doing' });

    // controle: o dono, no mesmo cenário, faz exatamente isso (e é por isso que a de teste não pode)
    installOwnership(MAIN);
    await w.svc.tick();
    expect(w.state.cutAsked).toEqual(['s-1']);
    expect(await w.get('x')).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('browser_navigate') });
  });

  it('R1: projeto que o principal ainda não registrou — a de teste que sobe antes não o toma (nada criado, fila parada) e o principal, depois, assume e anda a fila', async () => {
    const w = await world([{ id: 'q', status: 'todo' }], {}, false);
    const before = await read(w.file);
    installOwnership(TESTE);
    await w.svc.tick();
    await w.svc.tick();
    await expect(w.svc.update('p', 'q', { title: 'Outro' })).rejects.toBeInstanceOf(NotOwnerError);
    expect(w.state.opened).toBe(0);
    expect(w.state.sentTo).toEqual([]);
    expect(await read(w.file)).toBe(before);
    await expect(fs.stat(path.join(w.dir, OWNER_SUBDIR))).rejects.toMatchObject({ code: 'ENOENT' });
    // o principal sobe depois: registra, e a fila e a recuperação rodam (nada de foreign-home)
    installOwnership(MAIN);
    await w.svc.tick();
    expect((await MAIN.claim(w.dir)).owner).toBe(true);
    expect(w.state.opened).toBe(1);
    expect(await w.get('q')).toMatchObject({ status: 'doing' });
  });

  it('órfã sem corte: a de teste não manda "retome" na conversa; o dono manda', async () => {
    const w = await world([{ id: 'x', status: 'doing', sessionId: 's-1' }]);
    const before = await read(w.file);
    installOwnership(TESTE);
    await w.svc.tick();
    expect(w.state.sentTo).toEqual([]);
    expect(await read(w.file)).toBe(before);
    installOwnership(MAIN);
    await w.svc.tick();
    expect(w.state.sentTo).toHaveLength(1);
    expect(w.state.sentTo[0]).toMatchObject({ session: 's-1' });
    expect((await w.get('x')).history.at(-1)).toMatchObject({ note: expect.stringContaining('retomada') });
  });

  it('a fila não anda: o card "a fazer" de quem está livre não começa (nenhuma conversa aberta); no dono começa', async () => {
    const w = await world([{ id: 'q', status: 'todo' }]);
    const before = await read(w.file);
    installOwnership(TESTE);
    await w.svc.tick();
    await w.svc.kickStaff('p', 'ana-1');
    expect(w.state.opened).toBe(0);
    expect(await read(w.file)).toBe(before);
    installOwnership(MAIN);
    await w.svc.tick();
    expect(w.state.opened).toBe(1);
    expect(await w.get('q')).toMatchObject({ status: 'doing', sessionId: 's-novo-1' });
  });

  it('os avisos que mexem na tarefa (plano recusado, conversa fechada) são do dono: a instância de teste ignora', async () => {
    const w = await world([
      { id: 'plano', status: 'planning', sessionId: 's-plano' },
      { id: 'faz', status: 'doing', sessionId: 's-faz' },
    ]);
    const before = await read(w.file);
    installOwnership(TESTE);
    await w.svc.onPlanRejected('s-plano');
    expect(await w.svc.parkClosed('s-faz')).toBeNull();
    expect(await read(w.file)).toBe(before);
    installOwnership(MAIN);
    await w.svc.onPlanRejected('s-plano');
    expect(await w.get('plano')).toMatchObject({ status: 'waiting' });
    expect(await w.svc.parkClosed('s-faz')).toMatchObject({ id: 'faz', status: 'waiting' });
  });

  it('a gravação em si recusa: criar, editar e começar card lançam NotOwnerError e o arquivo não muda; a leitura segue', async () => {
    const w = await world([{ id: 'x', status: 'todo' }]);
    const before = await read(w.file);
    installOwnership(TESTE);
    await expect(w.svc.create('p', { title: 'Novo', staffId: 'ana-1', description: 'Faça.' })).rejects.toBeInstanceOf(NotOwnerError);
    await expect(w.svc.update('p', 'x', { title: 'Outro' })).rejects.toBeInstanceOf(NotOwnerError);
    await expect(w.svc.start('p', 'x')).rejects.toBeInstanceOf(NotOwnerError);
    expect(await read(w.file)).toBe(before);
    expect(((await w.svc.list('p')) ?? []).map((t) => t.id)).toEqual(['x']); // só lê
    installOwnership(MAIN);
    expect(await w.svc.update('p', 'x', { title: 'Outro' })).toMatchObject({ title: 'Outro' });
  });

  it('listar não grava: a dúvida de antes do reinício só é reescrita pelo dono', async () => {
    const asked = new Date(Date.now() - 24 * HOUR).toISOString();
    const w = await world([{ id: 'x', status: 'doing', sessionId: 's-1', question: { id: 'q1', source: 'ask', status: 'open', askedAt: asked } as never }]);
    const before = await read(w.file);
    installOwnership(TESTE);
    expect((await w.svc.list('p'))![0]!.question).toMatchObject({ source: 'ask' });
    expect(await read(w.file)).toBe(before);
    installOwnership(MAIN);
    await w.svc.list('p');
    expect((await w.get('x')).question).toMatchObject({ source: 'text' });
  });

  it('a restauração do motor secundário no boot é só do dono', async () => {
    const troca = { engine: 'codex', model: 'gpt-5', from: 'claude', at: Date.now(), fromSession: 's-0', reason: 'limit-mid' } as const;
    const w = await world([{ id: 'x', status: 'doing', sessionId: 's-1', fallback: troca }], { fallback: { engine: 'codex', model: 'gpt-5' } });
    installOwnership(TESTE);
    expect(await w.svc.restoreFallbacks()).toBe(0);
    expect(w.state.overrides).toEqual([]);
    installOwnership(MAIN);
    expect(await w.svc.restoreFallbacks()).toBe(1);
    expect(w.state.overrides).toEqual(['s-1']);
  });

  it('a recuperação do quadro na leitura (v1.6.1) também grava: a instância de teste não guarda o estragado ao lado nem "conserta" o arquivo do dono', async () => {
    const w = await world([{ id: 'x', status: 'todo' }]);
    await fs.writeFile(w.file, '{ quebrado');
    const names = async () => (await fs.readdir(path.join(w.dir, '.myco'))).sort();
    installOwnership(TESTE);
    await w.svc.list('p');
    await w.svc.list('p');
    expect(await read(w.file)).toBe('{ quebrado');
    expect((await names()).filter((f) => f.includes('corrompido'))).toEqual([]);
    // controle: o dono guarda o estragado ao lado (é a recuperação rodando)
    installOwnership(MAIN);
    await w.svc.list('p');
    expect((await names()).filter((f) => f.startsWith('tasks.json.corrompido-'))).toHaveLength(1);
  });

  it('o registro de execuções (task-runs.jsonl) também é gravação no projeto', async () => {
    const w = await world([]);
    const { appendRun } = await import('../server/taskRuns');
    installOwnership(TESTE);
    await expect(appendRun(w.dir, { ev: 'start', runId: 'r-1', taskId: 'x', at: new Date().toISOString() } as never)).rejects.toBeInstanceOf(NotOwnerError);
    await expect(fs.stat(path.join(w.dir, '.myco', 'task-runs.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    installOwnership(MAIN);
    await appendRun(w.dir, { ev: 'start', runId: 'r-1', taskId: 'x', at: new Date().toISOString() } as never);
    expect(await read(path.join(w.dir, '.myco', 'task-runs.jsonl'))).toContain('r-1');
  });
});

describe('item 1: nem a equipe é gravada, nem a varredura de temporários arquiva', () => {
  const project = (dir: string): Project => ({ id: 'proj-id', path: dir, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
  const ficha = (over: Partial<StaffProfile> = {}) =>
    ({ id: 'temp-1', projectId: 'proj-id', name: 'Temp', role: 'Dev', portrait: null, reportsTo: [], mission: 'x', firstTask: '', autonomy: 'plan', agents: [], skills: [], mcps: null, knowledge: [], rules: [], doneWhen: '', model: 'opus', effort: 'high', canHire: false, playbook: null, worktree: false, servers: [], browser: false, sessions: [], temporary: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over }) as StaffProfile;

  it('saveProfile recusa sem a posse (nada vai para o disco) e grava com ela', async () => {
    const dir = path.join(root, `staff-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    installOwnership(TESTE);
    await expect(saveProfile(dir, ficha())).rejects.toBeInstanceOf(NotOwnerError);
    expect(await readProfile(dir, 'temp-1')).toBeNull();
    installOwnership(MAIN);
    await saveProfile(dir, ficha());
    expect(await readProfile(dir, 'temp-1')).toMatchObject({ id: 'temp-1' });
  });

  it('sweepTemporaries: o temporário parado há dias não é arquivado pela instância de teste; o dono arquiva', async () => {
    const dir = path.join(root, `staff-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    installOwnership(MAIN);
    await saveProfile(dir, ficha());
    const archived = new Set<string>();
    const adapter = { listProjects: async () => [project(dir)], getProjectSessions: async () => [] } as unknown as ToolAdapter;
    const svc = new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: path.join(root, '.claude.json'),
      mycoUrl: 'http://127.0.0.1:4848',
      archive: { has: async (k) => archived.has(k), set: async (k, v) => void (v ? archived.add(k) : archived.delete(k)) },
    });
    const later = new Date(Date.now() + 10 * 86_400_000);

    installOwnership(TESTE);
    expect(await svc.sweepTemporaries(later)).toEqual([]);
    expect(archived.size).toBe(0);
    expect((await listProjectStaff(dir, 'proj-id'))[0]!.ended ?? null).toBeNull();

    installOwnership(MAIN);
    const ended = await svc.sweepTemporaries(later);
    expect(ended.map((s) => s.id)).toEqual(['temp-1']);
    expect(archived.has('staff:temp-1')).toBe(true);
  });
});

describe('item 1: nem varredura de freelas, nem conversa nova, nem retomada do boot, nem rotina', () => {
  it('sweepFreelas: a conversa sem ficha parada de um projeto de outro servidor não é arquivada na config desta instância', async () => {
    const dir = path.join(root, `freela-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    const configFile = path.join(root, `cfg-${n++}`, 'config.json');
    const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const deps = {
      configFile,
      adapter: {
        listProjects: async () => [{ id: 'p1', path: dir, name: 'p1', exists: true } as Project],
        getProjectSessions: async () => [{ id: 'sess-velha', updatedAt: stale, live: null } as never],
        listLiveSessions: async () => [],
      },
      staff: { listAll: async () => [] },
    };
    installOwnership(TESTE);
    expect(await sweepFreelas(deps)).toEqual([]);
    expect((await readConfig(configFile)).archived.sessions).toEqual([]);
    installOwnership(MAIN);
    expect(await sweepFreelas(deps)).toEqual(['sess-velha']);
    expect((await readConfig(configFile)).archived.sessions).toEqual(['sess-velha']);
  });

  it('abrir conversa: o ChatManager recusa antes de resolver a ficha ou abrir processo (nova, retomada ou "continue")', async () => {
    const dir = path.join(root, `chat-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    const resolved: string[] = [];
    const spawned: number[] = [];
    const build = (who: ProjectOwnership) =>
      new ChatManager({
        transcriptsDir: root,
        usageFile: path.join(root, `usage-${n++}.json`),
        runDir: path.join(root, 'run'),
        listLive: async () => [],
        assertOwner: (projectId) => who.assert(projectId === 'p' ? dir : path.join(root, 'outro')),
        resolve: async (_p, sid) => (resolved.push(sid ?? 'nova'), { sessionId: sid ?? 'nova', cwd: '.', args: [] }),
        spawnImpl: () => {
          spawned.push(1);
          const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, kill: () => proc.emit('exit', 0) });
          return proc as never;
        },
        log: () => {},
      });
    const teste = build(TESTE);
    await expect(teste.send('p', null, 'ana-1', 'oi')).rejects.toBeInstanceOf(NotOwnerError);
    await expect(teste.send('p', 'sess-viva-no-principal', 'ana-1', 'oi')).rejects.toBeInstanceOf(NotOwnerError);
    await expect(teste.continueChat('p', 'sess-viva-no-principal', 'ana-1')).rejects.toBeInstanceOf(NotOwnerError);
    await expect(teste.resumeChat({ projectId: 'p', sessionId: 'sess-viva-no-principal', staffId: 'ana-1', engine: 'claude', cwd: '.', hadPending: false })).rejects.toBeInstanceOf(NotOwnerError);
    expect(resolved).toEqual([]);
    expect(spawned).toEqual([]);
    // controle: o dono abre
    const main = build(MAIN);
    await main.send('p', 'sess-do-dono', 'ana-1', 'oi');
    expect(spawned).toHaveLength(1);
    expect(resolved).toEqual(['sess-do-dono']);
  });

  it('retomada do boot: a conversa de projeto de outro servidor, ou sem dono que esta instância possa registrar, não é retomada nem segurada; no principal, as duas são', async () => {
    const mine = path.join(root, `boot-${n++}`);
    const theirs = path.join(root, `boot-${n++}`);
    for (const d of [mine, theirs]) await fs.mkdir(d, { recursive: true });
    await MAIN.claim(theirs); // o do principal; o "mine" ninguém registrou ainda
    const entry = (projectId: string, sessionId: string, over: Partial<ResumeEntry> = {}): ResumeEntry => ({ projectId, sessionId, staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false, ...over });
    const file = path.join(root, `resume-${n++}.json`);
    const now = Date.now();
    const save = () => new ResumeFile(file).save([entry('theirs', 'sess-dele'), entry('theirs', 'sess-cortada', { cut: 'git push' }), entry('mine', 'sess-minha')], now);
    const run = async () => {
      const sent: string[] = [];
      const held: string[] = [];
      const logs: string[] = [];
      await save();
      await resumeAfterRestart({
        file,
        now: () => now + 1000,
        log: (l) => logs.push(l),
        stopHit: async () => null,
        send: async (e) => void sent.push(e.sessionId),
        hold: (e) => void held.push(e.sessionId),
        owns: async (projectId) => ownsProject(projectId === 'theirs' ? theirs : mine),
      });
      return { sent, held, refused: logs.filter((l) => l.includes('não manda no projeto')).length };
    };
    installOwnership(TESTE);
    expect(await run()).toEqual({ sent: [], held: [], refused: 3 });
    await expect(fs.stat(path.join(mine, OWNER_SUBDIR))).rejects.toMatchObject({ code: 'ENOENT' }); // nem registrou o "mine"
    // controle: o principal retoma a dele e a registra
    installOwnership(MAIN);
    expect(await run()).toEqual({ sent: ['sess-dele', 'sess-minha'], held: ['sess-cortada'], refused: 0 });
  });

  it('rotinas: a de projeto de outro servidor nem chega ao agendador (não dispara, não grava estado); a do dono dispara', async () => {
    const dir = path.join(root, `rotina-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    const routine: Routine = { id: 'r1', name: 'Revisar PRs', schedule: '0 19 * * 1-5', message: 'Revise.', mode: 'continue', enabled: true };
    const profile = { id: 'ana-1', projectId: 'p', name: 'Ana', sessions: [], routines: [routine] } as unknown as StaffProfile;
    const semRotina = { id: 'bia-1', projectId: 'p', name: 'Bia', sessions: [] } as unknown as StaffProfile;
    const run = async (who: ProjectOwnership) => {
      installOwnership(who);
      const state = path.join(root, `routines-${n++}.json`);
      const calls: string[] = [];
      const s = new RoutineScheduler({
        file: state,
        listStaff: () => ownedRoutineStaff([profile, semRotina], async () => ownsProject(dir)),
        run: async (_p, r) => (calls.push(r.id), { ok: true, text: 'mandada' }),
        log: () => {},
      });
      await s.tick(new Date(2026, 9, 26, 18, 59, 50)); // arma
      await s.tick(new Date(2026, 9, 26, 19, 0, 10)); // segunda, 19h: a hora da rotina
      return { calls, stateWritten: await fs.stat(state).then(() => true, () => false) };
    };
    expect(await run(TESTE)).toEqual({ calls: [], stateWritten: false });
    expect(await run(MAIN)).toMatchObject({ calls: ['r1'], stateWritten: true });
  });
});

describe('item 1: as rotas de escrita de um projeto que a instância não possui respondem 423 (NotOwnerError)', () => {
  it('POST em /api/projects/:id/... é recusado; a leitura de conexão, a config e as rotas fora de projeto seguem; o dono passa', async () => {
    const dir = path.join(root, `rota-${n++}`);
    await fs.mkdir(dir, { recursive: true });
    await MAIN.claim(dir);
    const dirOf = async (id: string) => (id === 'p' ? dir : null);
    installOwnership(TESTE);
    for (const route of ['/api/projects/p/tasks', '/api/projects/p/tasks/t-1/start', '/api/projects/p/chat/send', '/api/projects/p/staff', '/api/projects/p/files/write', '/api/projects/p/connections']) {
      await expect(assertProjectRoute(route, dirOf), route).rejects.toBeInstanceOf(NotOwnerError);
    }
    for (const route of ['/api/projects/p/connections/list', '/api/projects/p/connections/prod/test', '/api/config', '/api/chat/abc/stop', '/api/projects/outro/tasks']) {
      await expect(assertProjectRoute(route, dirOf), route).resolves.toBeUndefined();
    }
    installOwnership(MAIN);
    await expect(assertProjectRoute('/api/projects/p/tasks', dirOf)).resolves.toBeUndefined();
    // a recusa diz por que (a mensagem vai para quem usa a tela da instância de teste)
    installOwnership(TESTE);
    await expect(assertProjectRoute('/api/projects/p/tasks', dirOf)).rejects.toMatchObject({ code: 'not-owner', message: expect.stringContaining('só lê este projeto') });
  });

  it('a pasta da trava só tem o que é da trava (e o .gitignore dela): nada espalhado no projeto', async () => {
    const w = await world([]);
    expect((await fs.readdir(path.join(w.dir, '.myco'))).sort()).toEqual(['owner', 'tasks.json']);
    expect((await fs.readdir(path.join(w.dir, OWNER_SUBDIR))).sort()).toEqual(['.gitignore', '1.json']);
  });
});
