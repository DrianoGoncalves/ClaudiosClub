import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatClosingError } from '../server/chat/manager';
import type { Reservation } from '../server/resourceGate';
import { TaskService } from '../server/tasks';
import { UsageStopError } from '../server/usageStop';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// A fila não trava por causa de um cartão que não começa (t-23d463): a candidata que falha por motivo dela fica na fila com o motivo e a
// próxima começa no mesmo tick; motivo da fila toda (consumo, reinício, gate de recursos, conversa ocupada) para na primeira, sem varrer.
// A ordem é a de `queuedAt`, e a que falhou volta depois do backoff, na frente das mais novas.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-queueskip-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
const ana = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
const T0 = Date.parse('2026-11-17T10:00:00.000Z');
const at = (min: number) => new Date(T0 + min * MIN).toISOString();

/** Ana com três cartões na fila (A, B, C, nesta ordem), ela ocupada (`state.busy`) até o teste liberar. `state.fail`: o erro de cada título ao abrir a conversa. */
async function club(dirName: string, titles = ['A', 'B', 'C']) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const state = { busy: true, sends: [] as string[], fail: {} as Record<string, Error>, gate: null as null | (() => Reservation), released: 0 };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async (_p, _s, text) => {
      const title = /\[Tarefa "(.+?)"\]/.exec(text)![1]!;
      state.sends.push(title);
      if (state.fail[title]) throw state.fail[title];
      return `s-${++n}`;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    resourceGate: async () => (state.gate ? state.gate() : { ok: true, release: () => void state.released++ }),
  });
  const ids: Record<string, string> = {};
  for (const title of titles) {
    const t = (await svc.create('p', { title, staffId: 'ana-1' }))!;
    await svc.start('p', t.id); // Ana ocupada: entra na fila
    ids[title] = t.id;
  }
  /** Muda o arquivo por fora: a hora em que cada uma entrou na fila, ou a hora da próxima tentativa que passou. */
  const edit = async (fn: (all: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const queueAs = (times: Record<string, number>) => edit((all) => all.forEach((t) => (t.queuedAt = at(times[t.title]!))));
  const get = async (title: string) => (await svc.list('p'))!.find((t) => t.id === ids[title])!;
  const notes = async (title: string) => (await get(title)).history.filter((h) => h.note?.startsWith('não começou')).length;
  /** A hora da próxima tentativa passou. */
  const backoffOver = (title: string) => edit((all) => all.forEach((t) => t.title === title && (t.startRetry.nextAt = at(-1))));
  /** A tarefa entregou: sai de "fazendo" (não ocupa mais a Ana). */
  const deliver = (title: string) => edit((all) => all.forEach((t) => t.title === title && (t.status = 'review')));
  return { svc, state, ids, get, notes, queueAs, backoffOver, deliver };
}

describe('fila: motivo da tarefa não segura as outras', () => {
  it('a primeira falha por motivo dela: fica na fila com o motivo e a segunda começa no mesmo tick', async () => {
    const b = await club('own-1');
    b.state.fail['A'] = new Error('a worktree dela não abriu');
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    const a = await b.get('A');
    expect(a).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String), startRetry: { attempts: 1, nextAt: expect.any(String), lastError: 'a worktree dela não abriu' } });
    expect(a.history.at(-1)?.note).toBe('não começou: a worktree dela não abriu');
    expect(await b.get('B')).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
    expect(await b.get('C')).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    // O backoff vale de verdade: a próxima tentativa é no futuro.
    expect(Date.parse(a.startRetry!.nextAt)).toBeGreaterThan(Date.now());
  });

  it('com a falha dela em backoff, o tick seguinte não a tenta nem repete a nota', async () => {
    const b = await club('own-2', ['A', 'B']);
    b.state.fail['A'] = new Error('branch ocupada');
    await b.queueAs({ A: 1, B: 2 });
    b.state.busy = false;
    await b.svc.tick();
    await b.deliver('B'); // a Ana ficou livre; A segue esperando a hora dela
    await b.svc.tick();
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    expect(await b.notes('A')).toBe(1);
  });

  it('passado o backoff, volta a ser tentada na frente das mais novas (precedência por queuedAt) e a nota não se repete', async () => {
    const b = await club('own-3');
    b.state.fail['A'] = new Error('branch ocupada');
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick(); // A falha, B começa
    await b.deliver('B');
    await b.backoffOver('A');
    await b.svc.tick(); // A de novo, na frente de C: falha outra vez, e C começa
    expect(b.state.sends).toEqual(['A', 'B', 'A', 'C']);
    const a = await b.get('A');
    expect(a.startRetry).toMatchObject({ attempts: 2, lastError: 'branch ocupada' });
    expect(await b.notes('A')).toBe(1); // a mesma nota: não repete
    expect(await b.get('C')).toMatchObject({ status: 'doing' });
    // A falha passou: ela é a primeira da fila quando a Ana liberar, e o motivo sai do cartão.
    delete b.state.fail['A'];
    await b.deliver('C');
    await b.backoffOver('A');
    await b.svc.tick();
    expect(await b.get('A')).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null });
    expect((await b.get('A')).startRetry).toBeUndefined();
  });

  it('a ordem é a de queuedAt, não a do arquivo', async () => {
    const b = await club('order-1');
    await b.queueAs({ A: 30, B: 10, C: 20 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['B']);
    await b.deliver('B');
    await b.svc.tick();
    expect(b.state.sends).toEqual(['B', 'C']);
  });

  it('empate em queuedAt: a ordem do quadro', async () => {
    const b = await club('order-2', ['A', 'B']);
    await b.queueAs({ A: 5, B: 5 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A']);
  });

  it('falhas diferentes em seguida: cada uma é da tarefa, e a terceira começa', async () => {
    const b = await club('own-4');
    b.state.fail['A'] = new Error('ficha de A');
    b.state.fail['B'] = new Error('branch de B');
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B', 'C']);
    expect(await b.get('C')).toMatchObject({ status: 'doing' });
    expect((await b.get('A')).startRetry).toBeDefined();
    expect((await b.get('B')).startRetry).toBeDefined();
  });

  it('a mesma falha em duas seguidas: a causa não é da tarefa, a fila para (a terceira não é tentada nem anotada)', async () => {
    const b = await club('own-5');
    for (const t of ['A', 'B', 'C']) b.state.fail[t] = new Error('o motor dele não abre');
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    const c = await b.get('C');
    expect(c.startRetry).toBeUndefined();
    expect(c.history.some((h) => h.note?.startsWith('não começou'))).toBe(false);
  });

  it('bloqueada continua pulando, e a que falhou não conta como bloqueio', async () => {
    const b = await club('blocked-1');
    b.state.fail['B'] = new Error('worktree');
    await b.svc.update('p', b.ids['A']!, { blockedBy: [b.ids['C']!] });
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['B', 'C']);
  });

  it('começar à mão ignora o backoff e limpa o motivo', async () => {
    const b = await club('manual-1', ['A', 'B']);
    b.state.fail['A'] = new Error('branch ocupada');
    await b.queueAs({ A: 1, B: 2 });
    b.state.busy = false;
    await b.svc.tick();
    await b.deliver('B');
    delete b.state.fail['A'];
    expect((await b.get('A')).startRetry).toBeDefined(); // ainda em backoff
    const started = await b.svc.start('p', b.ids['A']!);
    expect(started).toMatchObject({ status: 'doing', sessionId: expect.any(String) });
    expect((await b.get('A')).startRetry).toBeUndefined();
  });
});

describe('fila: motivo da fila toda não varre', () => {
  it.each([
    ['limite de consumo', () => new UsageStopError({ kind: 'five_hour', percentUsed: 91, limit: 85, resetsAt: null })],
    ['servidor reiniciando', () => new ChatClosingError()],
  ])('%s: só a primeira é tentada e anotada, sem backoff, e o tick seguinte tenta a mesma', async (name, make) => {
    const b = await club(`global-${name.replace(/\s+/g, '-')}`);
    b.state.fail['A'] = make();
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A']);
    const a = await b.get('A');
    expect(a.startRetry).toBeUndefined();
    expect(a.history.at(-1)?.note).toMatch(/^não começou: /);
    for (const t of ['B', 'C']) {
      const other = await b.get(t);
      expect(other.startRetry).toBeUndefined();
      expect(other.history.some((h) => h.note?.startsWith('não começou'))).toBe(false);
    }
    await b.svc.tick(); // segue o mesmo: a mesma primeira, sem nota repetida
    expect(b.state.sends).toEqual(['A', 'A']);
    expect(await b.notes('A')).toBe(1);
  });

  it('A falha por motivo dela, B bate no limite: a fila para em B e C não é tentada', async () => {
    const b = await club('global-2');
    b.state.fail['A'] = new Error('branch ocupada');
    b.state.fail['B'] = new UsageStopError({ kind: 'seven_day', percentUsed: 97, limit: 90, resetsAt: null });
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    expect((await b.get('A')).startRetry).toBeDefined();
    expect((await b.get('B')).startRetry).toBeUndefined();
    expect((await b.get('C')).history.some((h) => h.note?.startsWith('não começou'))).toBe(false);
  });

  it('gate de recursos: só a primeira é segurada e anotada, e nenhuma conversa abre', async () => {
    const b = await club('gate-1');
    let calls = 0;
    b.state.gate = () => {
      calls++;
      return { ok: false, reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)' };
    };
    await b.queueAs({ A: 1, B: 2, C: 3 });
    b.state.busy = false;
    await b.svc.tick();
    expect(calls).toBe(1);
    expect(b.state.sends).toEqual([]);
    expect(await b.get('A')).toMatchObject({ resourceWait: { reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)' } });
    for (const t of ['B', 'C']) expect((await b.get(t)).resourceWait).toBeFalsy();
  });

  it('conversa dele ocupada: ninguém é tentado', async () => {
    const b = await club('busy-1');
    await b.queueAs({ A: 1, B: 2, C: 3 });
    await b.svc.tick(); // Ana segue ocupada
    expect(b.state.sends).toEqual([]);
  });

  it('a reserva do gate volta em cada tentativa, inclusive na que falhou por motivo dela', async () => {
    const b = await club('gate-2', ['A', 'B']);
    b.state.fail['A'] = new Error('branch ocupada');
    await b.queueAs({ A: 1, B: 2 });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    expect(b.state.released).toBe(2);
  });
});
