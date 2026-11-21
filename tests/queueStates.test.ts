import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectPauses } from '../server/projectPause';
import { TaskService } from '../server/tasks';
import { UsageStopError } from '../server/usageStop';
import type { StaffProfile, StaffQueue, TestRun, UsageStopHit } from '../shared/model';

// t-3f52ea: o estado da fila de cada funcionário (`GET /api/projects/:id/queues`), para o dono ver por que ela não anda: livre, ocupado com o card X, esperando recurso, limite de consumo,
// projeto pausado, entrega em processamento (por fase) e a suíte de testes esperando a vez da fila de validação pesada. Só leitura: o que já existe não muda.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-queues-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], engine: 'claude', ...extra }) as StaffProfile;
const passed = (command: string): TestRun => ({ command, ok: true, output: '', ms: 1, at: '2026-11-19T12:00:00Z' });
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** Ana faz, Gio pediu e `rui-1` revisa (só nos testes de fase: `reviewer`). `h` guarda o que cada teste liga: gate de recursos, trava de consumo, e o que pendura a entrega. */
async function club(dirName: string, opts: { reviewer?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador' }),
    'ana-1': profile('ana-1', 'Ana', { reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { role: 'Revisor' }),
  };
  const h = {
    working: new Set<string>(),
    /** Uma conversa dele trabalha por fora de qualquer card. */
    outside: false,
    n: 0,
    gate: null as null | { ok: false; reason: string },
    stop: null as UsageStopHit | null,
    testsGate: null as null | ReturnType<typeof deferred<TestRun>>,
    heavy: null as null | { holder: string },
    onWait: null as null | ((w: { since: string; holder: string } | null) => void),
    notifyGate: null as null | ReturnType<typeof deferred<void>>,
    reviewGate: null as null | ReturnType<typeof deferred<void>>,
  };
  const pauses = new ProjectPauses(path.join(root, `${dirName}-pausas.json`), () => {});
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, force, _override, reviewOnly) => {
      // Como o servidor: abrir a conversa confere a trava de consumo (`staff.checkUsage`), e a partida da fila que não passa fica na fila com a nota.
      if (h.stop && !force && !reviewOnly) throw new UsageStopError(h.stop);
      if (reviewOnly) await h.reviewGate?.promise;
      const session = `${staffId}-${++h.n}`;
      if (!reviewOnly) h.working.add(session);
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return h.outside || [...h.working].some((s) => !skip.includes(s));
    },
    sendTo: async (_p, session) => session,
    resourceGate: async () => h.gate ?? { ok: true, release: () => {} },
    stopHit: async () => h.stop,
    runTests: async (_cwd, command, _t, _q, onWait) => {
      h.onWait = onWait ?? null;
      if (h.heavy) onWait?.({ since: new Date().toISOString(), holder: h.heavy.holder });
      const tests = h.testsGate ? await h.testsGate.promise : passed(command);
      onWait?.(null);
      return tests;
    },
    notify: async () => {
      await h.notifyGate?.promise;
    },
    lastText: () => 'Entreguei.',
    pauses,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: () => {},
  });
  const get = async (id: string) => ((await svc.list('p'))!).find((t) => t.id === id)!;
  const begin = async (title: string) => {
    const t = (await svc.create('p', { title, description: 'Faça.', staffId: 'ana-1', reviewerId: opts.reviewer ? 'rui-1' : null }, 'gio-1', 'gio-s'))!;
    await svc.start('p', t.id);
    return { id: t.id, work: (await get(t.id)).sessionId ?? null };
  };
  /** O turno da conversa acaba (a entrega começa, e a fila dele anda). */
  const endTurn = (work: string) => {
    h.working.delete(work);
    return svc.onTurnDone(work);
  };
  /** A fila de Ana (a única do projeto). */
  const ana = async (): Promise<StaffQueue> => {
    const all = (await svc.queueStates('p'))!;
    expect(all.map((q) => q.staffId)).toEqual(['ana-1']);
    return all[0]!;
  };
  return { dir, h, svc, pauses, get, begin, endTurn, ana };
}

describe('GET /queues: o estado da fila de cada funcionário', () => {
  it('projeto que não existe: null (a rota responde 404); sem card aberto nem entrega, o funcionário não aparece', async () => {
    const b = await club('vazio');
    expect(await b.svc.queueStates('nao-existe')).toBeNull();
    expect(await b.svc.queueStates('p')).toEqual([]);
  });

  it('livre: o card dele está em revisão e nada o segura', async () => {
    const b = await club('livre');
    const { id, work } = await b.begin('Primeira');
    await b.endTurn(work!);
    expect((await b.get(id)).status).toBe('review');
    expect(await b.ana()).toEqual({ staffId: 'ana-1', state: 'free', queued: 0, deliveries: [] });
  });

  it('ocupado com o card X (planejando ou fazendo): o id e desde quando; a fila dele conta os cards que esperam', async () => {
    const b = await club('ocupado');
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    expect(await b.ana()).toEqual({ staffId: 'ana-1', state: 'busy', taskId: first.id, since: ISO, queued: 1, deliveries: [] });
    expect((await b.get(second.id)).status).toBe('todo');
  });

  it('ocupado numa conversa que não é de card: sem taskId, com o motivo', async () => {
    const b = await club('ocupado-conversa');
    const { work } = await b.begin('Primeira');
    await b.endTurn(work!); // o card vai para revisão
    b.h.outside = true;
    expect(await b.ana()).toMatchObject({ state: 'busy', detail: 'uma conversa dele está trabalhando', deliveries: [] });
    expect((await b.ana()).taskId).toBeUndefined();
  });

  it('esperando recurso: o gate de recursos segurou a partida do próximo card (motivo e desde quando)', async () => {
    const b = await club('recurso');
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    b.h.gate = { ok: false, reason: 'pouca memória livre (1.2 GB de 16 GB)' };
    await b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).resourceWait).toBeTruthy());
    expect(await b.ana()).toMatchObject({ state: 'resource-wait', taskId: second.id, since: ISO, detail: 'pouca memória livre (1.2 GB de 16 GB)', queued: 1 });
  });

  it('limite de consumo: a trava barra o motor dele e o próximo card espera (a linha de parada)', async () => {
    const b = await club('consumo');
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    b.h.stop = { kind: 'five_hour', percentUsed: 93, limit: 90, resetsAt: null };
    await b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).history.at(-1)?.note).toMatch(/não começou/));
    const q = await b.ana();
    expect(q).toMatchObject({ state: 'usage-limit', taskId: second.id, queued: 1 });
    expect(q.detail).toContain('93%');
    expect(q.detail).toContain('90%');
  });

  it('limite de consumo: o card que você pôs na fila "forçando" passa por cima e não aparece como barrado', async () => {
    const b = await club('consumo-forcado');
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    b.h.stop = { kind: 'five_hour', percentUsed: 93, limit: 90, resetsAt: null };
    await b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).history.at(-1)?.note).toMatch(/não começou/));
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all.find((t) => t.id === second.id)!.queuedForce = true;
    await fs.writeFile(file, JSON.stringify(all));
    expect((await b.ana()).state).not.toBe('usage-limit');
  });

  it('projeto pausado: o estado é o da pausa (desde quando), com o card que ele ainda termina', async () => {
    const b = await club('pausado');
    const first = await b.begin('Primeira');
    const pause = await b.pauses.pause('p');
    expect(await b.ana()).toMatchObject({ state: 'paused', since: pause.at, taskId: first.id });
    await b.pauses.resume('p');
    expect((await b.ana()).state).toBe('busy');
  });
});

describe('entrega em processamento (a fila dele já anda: ver `deliveries`)', () => {
  it('testes rodando: delivering na fase tests, desde quando a entrega começou; depois da entrega, some', async () => {
    const b = await club('fase-testes');
    b.h.testsGate = deferred<TestRun>();
    const { id, work } = await b.begin('Primeira');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.ana()).phase).toBe('tests'));
    const q = await b.ana();
    expect(q).toMatchObject({ state: 'delivering', taskId: id, since: ISO, phase: 'tests', queued: 0, deliveries: [{ taskId: id, phase: 'tests', since: ISO, startedAt: ISO }] });
    expect(q.deliveries[0]!.holder).toBeUndefined();
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
    expect(await b.ana()).toEqual({ staffId: 'ana-1', state: 'free', queued: 0, deliveries: [] });
  });

  it('a suíte espera a vez da fila de validação pesada: heavy-wait com quem segura e desde quando; quando a vez chega, volta a tests', async () => {
    const b = await club('fase-heavy');
    b.h.testsGate = deferred<TestRun>();
    b.h.heavy = { holder: 'testes de MyCo' };
    const { id, work } = await b.begin('Primeira');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.ana()).state).toBe('heavy-wait'));
    const q = await b.ana();
    expect(q).toMatchObject({ state: 'heavy-wait', taskId: id, since: ISO, phase: 'heavy-wait', detail: 'outra validação pesada roda: testes de MyCo', deliveries: [{ taskId: id, phase: 'heavy-wait', holder: 'testes de MyCo' }] });
    // A vez chegou (a suíte começa a rodar): a espera acaba.
    b.h.onWait!(null);
    expect(await b.ana()).toMatchObject({ state: 'delivering', phase: 'tests' });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
    expect((await b.ana()).state).toBe('free');
  });

  it('aviso ao gestor: delivering na fase notice', async () => {
    const b = await club('fase-aviso');
    b.h.notifyGate = deferred();
    const { id, work } = await b.begin('Primeira');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.ana()).phase).toBe('notice'));
    expect(await b.ana()).toMatchObject({ state: 'delivering', taskId: id, phase: 'notice' });
    b.h.notifyGate.resolve();
    await delivering;
  });

  it('pedido da revisão: delivering na fase review', async () => {
    const b = await club('fase-revisao', { reviewer: true });
    b.h.reviewGate = deferred();
    const { id, work } = await b.begin('Primeira');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.ana()).phase).toBe('review'));
    expect(await b.ana()).toMatchObject({ state: 'delivering', taskId: id, phase: 'review' });
    b.h.reviewGate.resolve();
    await delivering;
    expect((await b.ana()).deliveries).toEqual([]);
  });

  it('gravando (resumo e commit, na vez dele): é a única fase que segura a fila, e vale antes de tests e heavy-wait', async () => {
    const b = await club('fase-gravando');
    const { id, work } = await b.begin('Primeira');
    await b.endTurn(work!); // o card em revisão, para Ana aparecer na lista
    const phases = (b.svc as any).deliveries as Map<string, { staffId: string; phase: string; since: string; startedAt: string }>;
    const at = '2026-11-19T12:00:00.000Z';
    // A fase `saving` dura o commit e o resumo (milissegundos): o que a vê é o mapa que `deliver` preenche, lido aqui sem o relógio.
    phases.set(`p:${id}`, { staffId: 'ana-1', phase: 'saving', since: at, startedAt: at });
    phases.set('p:t-outra', { staffId: 'ana-1', phase: 'heavy-wait', since: '2026-11-19T12:05:00.000Z', startedAt: '2026-11-19T12:04:00.000Z' });
    expect(await b.ana()).toMatchObject({ state: 'delivering', taskId: id, since: at, phase: 'saving' });
    phases.delete(`p:${id}`);
    expect(await b.ana()).toMatchObject({ state: 'heavy-wait', taskId: 't-outra', since: '2026-11-19T12:05:00.000Z' });
  });

  it('já pegou o próximo card: o estado é busy, e a entrega que roda em paralelo aparece em deliveries', async () => {
    const b = await club('paralelo');
    b.h.testsGate = deferred<TestRun>();
    const first = await b.begin('Primeira');
    const second = await b.begin('Segunda');
    const delivering = b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).status).toBe('doing'));
    await vi.waitFor(async () => expect((await b.ana()).deliveries).toHaveLength(1));
    expect(await b.ana()).toMatchObject({ state: 'busy', taskId: second.id, deliveries: [{ taskId: first.id, phase: 'tests' }] });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
  });
});

describe('a rota', () => {
  it('GET /api/projects/:id/queues devolve `queueStates` e fica ao lado de /pause, sem rota nova de escrita', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).toMatch(/\['GET', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/queues\$`\), \(\{ params: \[id\] \}\) => tasks\.queueStates\(id!\)\]/);
    expect(index).not.toMatch(/\['(POST|PUT|PATCH|DELETE)', new RegExp\(`\^\/api\/projects\/\$\{ID\}\/queues/);
  });
});
