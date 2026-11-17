import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatClosingError } from '../server/chat/manager';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// O POST de tarefa (e o "Começar" da tela) não fica preso na vez do funcionário (t-3ab1e7): com prazo, a resposta vem com a tarefa na fila e o
// começo segue em segundo plano, sem perder a tarefa nem abrir a conversa duas vezes. O tempo de cada etapa vai para o log quando demora.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-startdeadline-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const ana = { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('não chegou lá a tempo');
    await sleep(5);
  }
}

/** Ana com a conversa de cada tarefa abrindo no ritmo do teste: `hold(título)` segura o envio dela até o `release`; `fail`, o erro de cada título. */
async function club(dirName: string, opts: { slowMs?: number } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const state = { busy: false, sends: [] as string[], gates: {} as Record<string, Promise<void>>, fail: {} as Record<string, Error>, lines: [] as string[] };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => (id === 'ana-1' ? ana : null),
    send: async (_p, _s, text) => {
      const title = /\[Tarefa "(.+?)"\]/.exec(text)![1]!;
      state.sends.push(title);
      await state.gates[title];
      if (state.fail[title]) throw state.fail[title];
      return `s-${++n}`;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    log: (line) => state.lines.push(line),
    ...(opts.slowMs !== undefined && { slowMs: opts.slowMs }),
  });
  const hold = (title: string) => {
    let release!: () => void;
    state.gates[title] = new Promise<void>((r) => (release = r));
    return release;
  };
  const make = async (title: string) => (await svc.create('p', { title, staffId: 'ana-1' }))!;
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  /** A tarefa entregou: sai de "fazendo" (não ocupa mais a Ana). */
  const deliver = async (id: string) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    all.forEach((t) => t.id === id && (t.status = 'review'));
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { svc, state, hold, make, get, deliver };
}

describe('começar com prazo: o funcionário ocupado não prende o pedido', () => {
  it('a vez da Ana está presa: responde dentro do prazo com a tarefa na fila, e ela começa depois, uma vez só', async () => {
    const b = await club('busy-1', { slowMs: 0 });
    const releaseA = b.hold('A');
    const a = await b.make('A');
    const startA = b.svc.start('p', a.id); // a conversa de A demora a abrir e segura a vez da Ana
    await until(() => b.state.sends.includes('A'));
    const t = await b.make('B');

    const t0 = Date.now();
    const answer = await b.svc.start('p', t.id, false, { deadlineMs: 80 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(answer).toMatchObject({ id: t.id, status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(answer!.history.at(-1)?.note).toMatch(/passou do prazo/);
    expect(b.state.sends).toEqual(['A']); // B não começou: a vez ainda é de A

    // A abre; a vez chega em B (em segundo plano), mas A ocupa a Ana: B espera na fila.
    releaseA();
    await startA;
    await b.svc.kickStaff('p', 'ana-1'); // entra na mesma fila da vez, depois do começo de B
    expect(b.state.sends).toEqual(['A']);
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });

    // A entrega: B começa pela fila (o começo em segundo plano não perdeu a tarefa) e mais tick nenhum abre outra conversa.
    await b.deliver(a.id);
    await b.svc.tick();
    expect(b.state.sends).toEqual(['A', 'B']);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null });
    await b.svc.tick();
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.state.sends).toEqual(['A', 'B']);
  });

  it('o começo em segundo plano abre a conversa sozinho quando a vez chega e a Ana está livre', async () => {
    const b = await club('busy-2');
    const releaseA = b.hold('A');
    b.state.fail['A'] = new ChatClosingError(); // A não abriu (reiniciando): volta para a fila e não ocupa a Ana
    const a = await b.make('A');
    const startA = b.svc.start('p', a.id);
    await until(() => b.state.sends.includes('A'));
    const t = await b.make('B');

    const answer = await b.svc.start('p', t.id, false, { deadlineMs: 60 });
    expect(answer).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });

    releaseA();
    await startA;
    await b.svc.kickStaff('p', 'ana-1'); // depois do começo de B na mesma vez
    expect(b.state.sends).toEqual(['A', 'B']);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null });
    // A segue na fila, e nenhum tick abre B outra vez.
    await b.svc.tick();
    expect(b.state.sends.filter((s) => s === 'B')).toHaveLength(1);
  });

  it('o começo que falha depois do prazo deixa a tarefa na fila com o motivo e o backoff', async () => {
    const b = await club('busy-3');
    const releaseA = b.hold('A');
    b.state.fail['A'] = new ChatClosingError();
    b.state.fail['B'] = new Error('a worktree dele não abriu');
    const a = await b.make('A');
    const startA = b.svc.start('p', a.id);
    await until(() => b.state.sends.includes('A'));
    const t = await b.make('B');
    const answer = await b.svc.start('p', t.id, false, { deadlineMs: 60 });
    expect(answer).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });

    releaseA();
    await startA;
    // A falha chega depois que a vez de B acaba (o aviso grava a nota em segundo plano): espera aparecer.
    const end = Date.now() + 2_000;
    while (!(await b.get(t.id)).startRetry && Date.now() < end) await sleep(10);
    const after = await b.get(t.id);
    expect(after).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String), startRetry: { attempts: 1, lastError: 'a worktree dele não abriu' } });
    expect(after.history.at(-1)?.note).toBe('não começou: a worktree dele não abriu');
    expect(b.state.lines.some((l) => l.includes('o começo em segundo plano falhou: a worktree dele não abriu'))).toBe(true);
  });

  it('sem prazo, espera o começo inteiro, como sempre', async () => {
    const b = await club('busy-4');
    const release = b.hold('A');
    const a = await b.make('A');
    let done = false;
    const p = b.svc.start('p', a.id).then((r) => {
      done = true;
      return r;
    });
    await until(() => b.state.sends.includes('A'));
    await sleep(80);
    expect(done).toBe(false);
    release();
    expect(await p).toMatchObject({ status: 'doing', sessionId: expect.any(String) });
  });

  it('começa dentro do prazo: a resposta é a tarefa começada, sem nota de prazo', async () => {
    const b = await club('fast-1');
    const a = await b.make('A');
    const started = await b.svc.start('p', a.id, false, { deadlineMs: 5_000 });
    expect(started).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
    expect(started!.history.some((h) => /prazo/.test(h.note ?? ''))).toBe(false);
    expect(b.state.lines).toEqual([]); // rápido: nada no log
  });

  it('dois "Começar" juntos: o segundo, na vez dele, vê a conversa aberta e não a põe na fila nem abre outra', async () => {
    const b = await club('twice-1');
    const release = b.hold('B');
    const t = await b.make('B');
    const first = b.svc.start('p', t.id);
    await until(() => b.state.sends.includes('B'));
    const second = b.svc.start('p', t.id); // passou da checagem de fora (ainda sem conversa) e espera a vez
    await sleep(50); // já está na fila da vez, atrás do primeiro
    b.state.busy = true; // a conversa que abriu já trabalha
    release();
    await first;
    await second;
    expect(b.state.sends).toEqual(['B']);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', queuedAt: null });
    expect((await b.get(t.id)).history.some((h) => /na fila/.test(h.note ?? ''))).toBe(false);
  });
});

describe('começar: o tempo de cada etapa no log', () => {
  it('passou do limite: uma linha com as etapas (projectPath, lock, conversa…)', async () => {
    const b = await club('log-1', { slowMs: 30 });
    const release = b.hold('A');
    const a = await b.make('A');
    const p = b.svc.start('p', a.id);
    await until(() => b.state.sends.includes('A'));
    await sleep(60); // a abertura da conversa demora
    release();
    await p;
    expect(b.state.lines).toHaveLength(1);
    expect(b.state.lines[0]).toMatch(/^\[tarefas\] começar t-[0-9a-f]{6}: \d+ ms \(projectPath \d+ ms, leitura \d+ ms, ficha \d+ ms, lock \d+ ms, fila \d+ ms, plano \d+ ms, conversa \d+ ms, registro \d+ ms, gravar \d+ ms\)$/);
    const conversa = Number(/conversa (\d+) ms/.exec(b.state.lines[0]!)![1]);
    expect(conversa).toBeGreaterThanOrEqual(50);
  });

  it('com o prazo estourado, diz onde parou e o fim do começo diz que seguiu em segundo plano', async () => {
    const b = await club('log-2', { slowMs: 0 });
    const releaseA = b.hold('A');
    const a = await b.make('A');
    const startA = b.svc.start('p', a.id);
    await until(() => b.state.sends.includes('A'));
    const t = await b.make('B');
    await b.svc.start('p', t.id, false, { deadlineMs: 60 });
    expect(b.state.lines.some((l) => /começar t-[0-9a-f]{6}: passou do prazo de 60 ms, parado em "lock" há \d+ ms; responde na fila/.test(l))).toBe(true);
    releaseA();
    await startA;
    await until(() => b.state.lines.some((l) => /lock \d+ ms.*; respondeu na fila, o resto seguiu em segundo plano$/.test(l)));
  });
});
