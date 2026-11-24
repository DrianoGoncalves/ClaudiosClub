import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { queueDots, queueRows } from '../client/src/tasks/queueState';
import { ProjectPauses } from '../server/projectPause';
import { TaskService } from '../server/tasks';
import { UsageStopError } from '../server/usageStop';
import type { StaffProfile, StaffQueue, TestRun, UsageStopHit } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-8315c9: `GET /queues` diz o que cada funcionário faz de fato e em qual coluna cai (`column`), separado de `state` (o que a fila faz): turno de card rodando = Fazendo; revisão com o turno
// rodando = Revisão (também para o revisor, que antes nem aparecia); parado por um motivo = A fazer; conversa sem turno, conversa sem card e entrega do Club (`delivering`) = coluna nenhuma.
// Os estados de antes (`state`, `taskId`, `detail`) não mudam: o campo novo é opcional para quem lê (`client/src/tasks/queueState.ts`).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-queue-cols-'));
});
afterAll(() => removeTemp(root));

const profile = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, reportsTo: [], engine: 'claude', ...extra }) as StaffProfile;
const passed = (command: string): TestRun => ({ command, ok: true, output: '', ms: 1, at: '2026-11-19T12:00:00Z' });
const ISO = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/);

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

/** De quem é a conversa: o id é `<funcionário>-<n>` (`send` e os ids soltos dos testes). */
const staffOf = (session: string) => session.replace(/-\d+$/, '');

/**
 * Ana faz, Gio pede e Rui revisa. As conversas ficam em três conjuntos, como no Claudio’s Club: `working` (turno de trabalho rodando), `background` (conversa parada com algo em segundo plano:
 * `isWorking` conta, `isTurning` não) e `reviewing` (turno de revisão rodando). O que `send` abre entra no conjunto certo.
 */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  // O arquivo que o card "alterou": as provas da entrega (testes relacionados) rodam sobre os arquivos alterados.
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'feature.ts'), 'export const feature = 1;\n');
  const people: Record<string, StaffProfile> = {
    'gio-1': profile('gio-1', 'Gio', { role: 'Orquestrador' }),
    'ana-1': profile('ana-1', 'Ana', { reportsTo: ['gio-1'] }),
    'rui-1': profile('rui-1', 'Rui', { role: 'Revisor' }),
  };
  const h = {
    working: new Set<string>(),
    background: new Set<string>(),
    reviewing: new Set<string>(),
    n: 0,
    gate: null as null | { ok: false; reason: string },
    stop: null as UsageStopHit | null,
    testsGate: null as null | ReturnType<typeof deferred<TestRun>>,
    heavy: null as null | { holder: string },
  };
  const live = (staffId: string, except: string | readonly string[] | undefined, sets: Array<Set<string>>) => {
    const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
    return sets.some((set) => [...set].some((s) => staffOf(s) === staffId && !skip.includes(s)));
  };
  const pauses = new ProjectPauses(path.join(root, `${dirName}-pausas.json`), () => {});
  const svc = new TaskService({
    projectPath: async (id) => (id === 'p' ? dir : null),
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, force, _override, reviewOnly) => {
      // Como o servidor: abrir a conversa confere a trava de consumo, e a partida da fila que não passa fica na fila com a nota.
      if (h.stop && !force && !reviewOnly) throw new UsageStopError(h.stop);
      const session = `${staffId}-${++h.n}`;
      (reviewOnly ? h.reviewing : h.working).add(session);
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => live(staffId, except, [h.working, h.background, h.reviewing]),
    isTurning: (_p, staffId, except) => live(staffId, except, [h.working, h.reviewing]),
    isSessionWorking: (s) => h.working.has(s) || h.background.has(s) || h.reviewing.has(s),
    liveWork: (s) => (h.working.has(s) || h.reviewing.has(s) ? { busy: true, background: [] } : null),
    sendTo: async (_p, session) => session,
    resourceGate: async () => h.gate ?? { ok: true, release: () => {} },
    stopHit: async () => h.stop,
    runTests: async (_cwd, command, _t, _q, onWait) => {
      if (h.heavy) onWait?.({ since: new Date().toISOString(), holder: h.heavy.holder });
      const tests = h.testsGate ? await h.testsGate.promise : passed(command);
      onWait?.(null);
      return tests;
    },
    notify: async () => {},
    lastText: () => 'Entreguei.',
    pauses,
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: () => {},
  });
  const get = async (id: string) => ((await svc.list('p'))!).find((t) => t.id === id)!;
  /** Cria o card e, se `start`, começa (um bloqueado entra na fila). Sem `start`, fica em Aguardar: serve de card esperado. */
  const add = async (title: string, staffId: string, extra: { reviewerId?: string; blockedBy?: string[]; start?: boolean } = {}) => {
    const t = (await svc.create('p', { title, description: 'Faça.', staffId, reviewerId: extra.reviewerId ?? null, ...(extra.blockedBy && { blockedBy: extra.blockedBy }), start: extra.start ?? true }, 'gio-1', 'gio-s'))!;
    if (extra.start !== false) await svc.start('p', t.id);
    const file = path.join(dir, '.myco', 'tasks.json');
    const tasks = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    tasks.find((x) => x.id === t.id)!.changedFiles = ['src/feature.ts'];
    await fs.writeFile(file, JSON.stringify(tasks));
    return { id: t.id, work: (await get(t.id)).sessionId ?? null };
  };
  /** O turno da conversa acaba (a entrega começa, e a fila dele anda). */
  const endTurn = (work: string) => {
    h.working.delete(work);
    return svc.onTurnDone(work);
  };
  const all = async () => (await svc.queueStates('p'))!;
  const of = async (staffId: string) => (await all()).find((q) => q.staffId === staffId);
  return { dir, h, svc, pauses, get, add, endTurn, all, of };
}

describe('column: onde ele está de fato ocupado', () => {
  it('turno de card rodando: column doing com o taskId (o estado de antes continua busy)', async () => {
    const b = await club('doing');
    const { id } = await b.add('Primeira', 'ana-1');
    expect(await b.of('ana-1')).toEqual({ staffId: 'ana-1', state: 'busy', column: 'doing', taskId: id, since: ISO, queued: 0, deliveries: [] });
  });

  it('a conversa do card em fazendo não está rodando: a fila segue segura (busy), mas a coluna fica vazia', async () => {
    const b = await club('doing-parado');
    const { id, work } = await b.add('Primeira', 'ana-1');
    b.h.working.delete(work!);
    expect(await b.of('ana-1')).toMatchObject({ state: 'busy', taskId: id, column: null });
  });

  it('conversa aberta sem turno rodando (só segundo plano) e o card em Revisão: livre, sem ocupado e sem taskId', async () => {
    const b = await club('sem-turno');
    const { id, work } = await b.add('Primeira', 'ana-1');
    await b.endTurn(work!);
    expect((await b.get(id)).status).toBe('review');
    b.h.background.add('ana-1-88');
    const q = await b.of('ana-1');
    expect(q).toEqual({ staffId: 'ana-1', state: 'free', column: null, queued: 0, deliveries: [] });
    expect(q).not.toHaveProperty('taskId');
  });

  it('o segundo plano ainda segura a próxima partida: a fila mostra o motivo, mas ele não aparece ocupado', async () => {
    const b = await club('sem-turno-fila');
    const first = await b.add('Primeira', 'ana-1');
    const second = await b.add('Segunda', 'ana-1');
    b.h.background.add('ana-1-88');
    await b.endTurn(first.work!);
    expect((await b.get(second.id)).status).toBe('todo');
    expect(await b.of('ana-1')).toMatchObject({ state: 'free', column: null, queued: 1, detail: expect.stringContaining('segundo plano') });
  });

  it('conversa livre rodando (turno sem card): busy sem taskId e fora das colunas', async () => {
    const b = await club('conversa-livre');
    const { work } = await b.add('Primeira', 'ana-1');
    await b.endTurn(work!);
    b.h.working.add('ana-1-77');
    const q = await b.of('ana-1');
    expect(q).toMatchObject({ state: 'busy', column: null, detail: 'uma conversa dele está trabalhando' });
    expect(q).not.toHaveProperty('taskId');
  });

  it('card em Revisão: o executor fica sem ocupado, e o revisor com o turno rodando aparece em review com o taskId', async () => {
    const b = await club('revisao');
    const { id, work } = await b.add('Primeira', 'ana-1', { reviewerId: 'rui-1' });
    await b.endTurn(work!);
    const card = await b.get(id);
    expect(card).toMatchObject({ status: 'review', review: { staffId: 'rui-1' } });
    expect(await b.of('ana-1')).toEqual({ staffId: 'ana-1', state: 'free', column: null, queued: 0, deliveries: [] });
    expect(await b.of('rui-1')).toEqual({ staffId: 'rui-1', state: 'free', column: 'review', taskId: id, since: ISO, queued: 0, deliveries: [], reviewing: [{ taskId: id, since: card.review!.at }] });
  });

  it('o revisor que terminou o turno, ou só tem segundo plano na conversa de revisão, não aparece', async () => {
    const b = await club('revisao-parada');
    const { id, work } = await b.add('Primeira', 'ana-1', { reviewerId: 'rui-1' });
    await b.endTurn(work!);
    const session = (await b.get(id)).review!.sessionId;
    expect((await b.all()).map((q) => q.staffId)).toEqual(['ana-1', 'rui-1']);
    b.h.reviewing.delete(session);
    b.h.background.add(session);
    expect((await b.all()).map((q) => q.staffId)).toEqual(['ana-1']);
    b.h.background.delete(session);
    expect((await b.all()).map((q) => q.staffId)).toEqual(['ana-1']);
  });

  it('quem revisa e também executa um card: column doing no card dele, e a revisão em reviewing', async () => {
    const b = await club('revisor-ocupado');
    const review = await b.add('Da Ana', 'ana-1', { reviewerId: 'rui-1' });
    await b.endTurn(review.work!);
    const own = await b.add('Do Rui', 'rui-1');
    const q = await b.of('rui-1');
    expect(q).toMatchObject({ state: 'busy', column: 'doing', taskId: own.id, reviewing: [{ taskId: review.id, since: ISO }] });
  });

  it('entrega do Club (testes rodando, card já em Revisão): delivering não vira doing', async () => {
    const b = await club('entrega-testes');
    b.h.testsGate = deferred<TestRun>();
    const { id, work } = await b.add('Primeira', 'ana-1');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.of('ana-1'))!.phase).toBe('tests'));
    expect((await b.get(id)).status).toBe('review');
    expect(await b.of('ana-1')).toMatchObject({ state: 'delivering', taskId: id, phase: 'tests', column: null });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
  });

  it('entrega do Club (suíte esperando a vez): heavy-wait também fica fora de Fazendo', async () => {
    const b = await club('entrega-heavy');
    b.h.testsGate = deferred<TestRun>();
    b.h.heavy = { holder: 'testes de MyCo' };
    const { id, work } = await b.add('Primeira', 'ana-1');
    const delivering = b.endTurn(work!);
    await vi.waitFor(async () => expect((await b.of('ana-1'))!.state).toBe('heavy-wait'));
    expect(await b.of('ana-1')).toMatchObject({ state: 'heavy-wait', taskId: id, column: null });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
  });

  it('a entrega só anda com ele em outro card: o card novo é doing, e a entrega fica em deliveries', async () => {
    const b = await club('entrega-paralela');
    b.h.testsGate = deferred<TestRun>();
    const first = await b.add('Primeira', 'ana-1');
    const second = await b.add('Segunda', 'ana-1');
    const delivering = b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).status).toBe('doing'));
    await vi.waitFor(async () => expect((await b.of('ana-1'))!.deliveries).toHaveLength(1));
    expect(await b.of('ana-1')).toMatchObject({ state: 'busy', column: 'doing', taskId: second.id, deliveries: [{ taskId: first.id, phase: 'tests' }] });
    b.h.testsGate.resolve(passed('npm test'));
    await delivering;
  });

  it('esperando recurso e limite de consumo: parado em A fazer (column todo), com o motivo de sempre', async () => {
    const b = await club('espera-motivo');
    const first = await b.add('Primeira', 'ana-1');
    const second = await b.add('Segunda', 'ana-1');
    b.h.gate = { ok: false, reason: 'pouca memória livre (1.2 GB de 16 GB)' };
    await b.endTurn(first.work!);
    await vi.waitFor(async () => expect((await b.get(second.id)).resourceWait).toBeTruthy());
    expect(await b.of('ana-1')).toMatchObject({ state: 'resource-wait', column: 'todo', taskId: second.id, detail: 'pouca memória livre (1.2 GB de 16 GB)' });

    const c = await club('espera-consumo');
    const one = await c.add('Primeira', 'ana-1');
    const two = await c.add('Segunda', 'ana-1');
    c.h.stop = { kind: 'five_hour', percentUsed: 93, limit: 90, resetsAt: null };
    await c.endTurn(one.work!);
    await vi.waitFor(async () => expect((await c.get(two.id)).history.at(-1)?.note).toMatch(/não começou/));
    expect(await c.of('ana-1')).toMatchObject({ state: 'usage-limit', column: 'todo', taskId: two.id });
  });

  it('projeto pausado: o estado é o da pausa, e a coluna segue o turno do card', async () => {
    const b = await club('pausado');
    const { id, work } = await b.add('Primeira', 'ana-1');
    await b.pauses.pause('p');
    expect(await b.of('ana-1')).toMatchObject({ state: 'paused', taskId: id, column: 'doing' });
    b.h.working.delete(work!);
    expect(await b.of('ana-1')).toMatchObject({ state: 'paused', taskId: id, column: null });
  });
});

describe('column todo: todos os cards dele em A fazer esperam outro card', () => {
  it('três cards esperando: o primeiro da fila, o card esperado, quem o faz e quantos mais', async () => {
    const b = await club('espera-3');
    const base = await b.add('Base do Rui', 'rui-1', { start: false });
    const first = await b.add('Primeiro', 'ana-1', { blockedBy: [base.id] });
    await b.add('Segundo', 'ana-1', { blockedBy: [base.id] });
    await b.add('Terceiro', 'ana-1', { blockedBy: [base.id] });
    const q = await b.of('ana-1');
    expect(q).toEqual({
      staffId: 'ana-1',
      state: 'free',
      column: 'todo',
      taskId: first.id,
      queued: 3,
      deliveries: [],
      detail: `a fila dele espera o card ${base.id} "Base do Rui" (de Rui); mais 2 cards da fila esperam outros cards`,
      waitingOn: { taskId: base.id, title: 'Base do Rui', staffId: 'rui-1', more: 2 },
    });
  });

  it('um card só: sem "mais"; com dois, o singular', async () => {
    const b = await club('espera-1');
    const base = await b.add('Base', 'rui-1', { start: false });
    await b.add('Único', 'ana-1', { blockedBy: [base.id] });
    expect(await b.of('ana-1')).toMatchObject({ column: 'todo', detail: `a fila dele espera o card ${base.id} "Base" (de Rui)`, waitingOn: { more: 0 } });
    await b.add('Outro', 'ana-1', { blockedBy: [base.id] });
    expect((await b.of('ana-1'))!.detail).toMatch(/; mais 1 card da fila espera outros cards$/);
  });

  it('o primeiro da fila manda: o card esperado é o dele, e os outros só contam em "mais"', async () => {
    const b = await club('espera-ordem');
    const one = await b.add('Base um', 'rui-1', { start: false });
    const two = await b.add('Base dois', 'rui-1', { start: false });
    const first = await b.add('Primeiro', 'ana-1', { blockedBy: [one.id] });
    await b.add('Segundo', 'ana-1', { blockedBy: [two.id] });
    expect(await b.of('ana-1')).toMatchObject({ column: 'todo', taskId: first.id, waitingOn: { taskId: one.id, title: 'Base um', more: 1 } });
  });

  it('título comprido vira uma linha de até 60 caracteres', async () => {
    const b = await club('espera-titulo');
    const base = await b.add(`${'A'.repeat(50)}\n${'B'.repeat(60)}`, 'rui-1', { start: false });
    await b.add('Esperando', 'ana-1', { blockedBy: [base.id] });
    const title = (await b.of('ana-1'))!.waitingOn!.title;
    expect(title).toBe(`${'A'.repeat(50)} ${'B'.repeat(8)}…`);
    expect(title).toHaveLength(60);
  });

  it('o card esperado foi cancelado: o motivo diz que o dono decide', async () => {
    const b = await club('espera-cancelada');
    const base = await b.add('Base', 'rui-1', { start: false });
    await b.add('Esperando', 'ana-1', { blockedBy: [base.id] });
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const tasks = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    tasks.find((t) => t.id === base.id)!.status = 'cancelled';
    await fs.writeFile(file, JSON.stringify(tasks));
    expect(await b.of('ana-1')).toMatchObject({ column: 'todo', detail: `a fila dele espera o card ${base.id} "Base" (de Rui, cancelado: o dono decide)` });
  });

  it('com um turno de card rodando não é espera: ele está em doing, e a fila bloqueada só conta em queued', async () => {
    const b = await club('espera-ocupado');
    const base = await b.add('Base', 'rui-1', { start: false });
    const running = await b.add('Rodando', 'ana-1');
    await b.add('Esperando', 'ana-1', { blockedBy: [base.id] });
    const q = await b.of('ana-1');
    expect(q).toMatchObject({ state: 'busy', column: 'doing', taskId: running.id, queued: 1 });
    expect(q).not.toHaveProperty('waitingOn');
  });

  it('fila vazia ou sem espera por card: nada de waitingOn', async () => {
    const b = await club('espera-nada');
    const { work } = await b.add('Primeira', 'ana-1');
    await b.endTurn(work!);
    const q = await b.of('ana-1');
    expect(q).toMatchObject({ state: 'free', column: null, queued: 0 });
    expect(q).not.toHaveProperty('waitingOn');
  });

  it('o card esperado fica pronto: a espera some', async () => {
    const b = await club('espera-pronta');
    const base = await b.add('Base', 'rui-1', { start: false });
    await b.add('Esperando', 'ana-1', { blockedBy: [base.id] });
    expect((await b.of('ana-1'))!.column).toBe('todo');
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const tasks = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    tasks.find((t) => t.id === base.id)!.status = 'done';
    await fs.writeFile(file, JSON.stringify(tasks));
    expect((await b.of('ana-1'))!.column).not.toBe('todo');
    expect(await b.of('ana-1')).not.toHaveProperty('waitingOn');
  });
});

describe('quem lê hoje (client/src/tasks/queueState.ts) segue igual', () => {
  const names = (id: string) => ({ 'ana-1': 'Ana', 'rui-1': 'Rui' })[id] ?? null;

  it('o que o servidor manda com os campos novos passa por queueRows e queueDots sem mudar o que já dava', async () => {
    const b = await club('compat');
    const base = await b.add('Base', 'rui-1', { start: false });
    await b.add('Esperando', 'ana-1', { blockedBy: [base.id] });
    const waiting = (await b.all()).filter((q) => q.staffId === 'ana-1');
    const rows = queueRows(waiting, names, (id) => id, Date.now());
    expect(rows).toEqual([{ staffId: 'ana-1', tone: 'quiet', text: 'Ana: livre · 1 na fila' }]);
    expect(queueDots(waiting, [], names, (id) => id, Date.now())).toEqual([]);

    const c = await club('compat-revisao');
    const { id, work } = await c.add('Primeira', 'ana-1', { reviewerId: 'rui-1' });
    await c.endTurn(work!);
    const queues: StaffQueue[] = await c.all();
    const dots = queueDots(queues, await c.svc.list('p'), names, (t) => t, Date.now());
    expect(dots).toEqual([expect.objectContaining({ staffId: 'rui-1', column: 'review', tone: 'busy' })]);
    expect(queues.find((q) => q.staffId === 'rui-1')).toMatchObject({ column: 'review', taskId: id });
  });
});
