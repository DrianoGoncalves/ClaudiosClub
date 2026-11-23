import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile, TurnCapHit, UsageStopHit } from '../shared/model';
import { removeTemp } from './support/tmp';

// O dono leva para "A fazer", pela tela, o card parado em Aguardar por ação cortada (t-093bb6, resposta à revisão da t-f89dcd): vale como ciência do corte,
// a vez do card retoma a MESMA conversa sem a checagem e o card vai para fazendo. Pela API ou pela varredura, a checagem segue valendo.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cutack-'));
});
afterAll(() => removeTemp(root));

const profiles: Record<string, StaffProfile> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'cris-1': { id: 'cris-1', name: 'Cris', role: 'Back-end', autonomy: 'acceptEdits', worktree: false, engine: 'codex' } as StaffProfile,
};

/** O servidor com um funcionário por motor (Ana = Claude, Cris = Codex). `state.cap`/`state.cut`: o corte guardado e o que o transcript mostra agora. */
async function club(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const state = {
    busy: false,
    stop: null as UsageStopHit | null,
    cap: null as TurnCapHit | null,
    cut: null as TurnCapHit | null,
    capAsked: 0,
    cutAsked: [] as string[],
    sentTo: [] as Array<{ session: string; text: string }>,
  };
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => profiles[id] ?? null,
    send: async () => `s-${++n}`,
    sendTo: async (_p, session, _s, text) => {
      state.sentTo.push({ session, text });
      state.cap = null; // como o `ChatManager.send`: mensagem na conversa zera o aviso guardado do corte (caixa e tarefa)
      return session;
    },
    branchFor: async () => null,
    isWorking: () => state.busy,
    isSessionWorking: () => false,
    turnCap: () => {
      state.capAsked++;
      return state.cap;
    },
    restartCut: async (_p, session) => {
      state.cutAsked.push(session);
      return state.cut;
    },
    resourceGate: async () => ({ ok: true, release: () => {} }),
    stopHit: async () => state.stop,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** O card como a t-f89dcd o deixa: começou (conversa s-N), a conversa morreu no meio de `git push`, a vez dele o levou para Aguardar. */
  const parked = async (title: string, staffId = 'ana-1', extra: Record<string, unknown> = {}) => {
    const t = (await svc.create('p', { title, staffId, description: 'Revise a tela.', ...extra }))!;
    await svc.start('p', t.id); // abre a conversa
    const file = path.join(dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    const x = all.find((y) => y.id === t.id)!;
    x.status = 'todo';
    x.queuedAt = null;
    await fs.writeFile(file, JSON.stringify(all));
    state.cut = push;
    await svc.tick(); // a checagem pega o corte: Aguardar
    expect(await get(t.id)).toMatchObject({ status: 'waiting' });
    state.cut = null;
    state.cap = push; // o corte fica guardado (holdCut): é o que `turnCapOf` devolve
    state.cutAsked.length = 0;
    state.capAsked = 0;
    return t.id;
  };
  return { svc, state, get, parked };
}

const push: TurnCapHit = { kind: 'restart', action: 'git push origin main' };

describe.each([
  ['Claude', 'ana-1'],
  ['Codex', 'cris-1'],
])('o dono move para A fazer pela tela (%s)', (_engine, staffId) => {
  it('a vez dele retoma a mesma conversa, sem conferir o corte, e o card vai para fazendo (sem voltar para Aguardar)', async () => {
    const b = await club(`dono-${staffId}`);
    const id = await b.parked('Corte', staffId);
    const out = await b.svc.update('p', id, { status: 'todo' }, true);
    expect(out).toMatchObject({ status: 'todo', sessionId: 's-1', cutAck: true, waitReason: null });
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(b.state.sentTo[0]).toMatchObject({ session: 's-1', text: expect.stringContaining('retome-a nesta conversa') });
    expect(b.state.capAsked).toBe(0); // nem o corte guardado nem o transcript foram conferidos
    expect(b.state.cutAsked).toEqual([]);
    expect(b.state.cap).toBeNull(); // e o aviso guardado saiu com a mensagem da retomada
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'doing', sessionId: 's-1', queuedAt: null });
    expect(t.cutAck).toBeUndefined();
    await b.svc.tick(); // e segue em fazendo
    expect(b.state.sentTo).toHaveLength(1);
    expect((await b.get(id)).status).toBe('doing');
  });

  it('o histórico diz que o dono confirmou, no movimento e na retomada', async () => {
    const b = await club(`hist-${staffId}`);
    const id = await b.parked('Corte', staffId);
    await b.svc.update('p', id, { status: 'todo' }, true);
    expect((await b.get(id)).history.at(-1)).toMatchObject({ status: 'todo', by: 'you', note: expect.stringContaining('você confirmou a retomada') });
    await b.svc.tick();
    expect((await b.get(id)).history.at(-1)).toMatchObject({ status: 'doing', by: 'auto', note: expect.stringContaining('você tinha confirmado a retomada') });
  });
});

describe('sem o dono pela tela, a checagem segue valendo', () => {
  it('movimento sem a marca do dono (API, serviço interno): vai para a fila, a vez confere o corte e volta para Aguardar; nada é mandado', async () => {
    const b = await club('api');
    const id = await b.parked('Corte');
    const out = await b.svc.update('p', id, { status: 'todo' }); // sem `byOwner`: é o que um chamador de dentro (ou a API) faz
    expect(out).toMatchObject({ status: 'todo' });
    expect(out!.cutAck).toBeUndefined();
    await b.svc.tick();
    expect(b.state.capAsked).toBeGreaterThan(0);
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'waiting', waitReason: expect.stringContaining('git push origin main') });
  });

  it('o corpo não carrega a marca: `cutAck` no pedido é ignorado', async () => {
    const b = await club('corpo');
    const id = await b.parked('Corte');
    const out = await b.svc.update('p', id, { status: 'todo', cutAck: true } as never);
    expect(out!.cutAck).toBeUndefined();
    await b.svc.tick();
    expect(await b.get(id)).toMatchObject({ status: 'waiting' });
  });

  it('a varredura (card em a fazer com conversa, sem passar pelo dono): confere e vai para Aguardar', async () => {
    const b = await club('varredura');
    const id = await b.parked('Corte');
    // Entra em "a fazer" fora do `update` do dono (o arquivo, como a t-2f3ff3 deixou): a marca não existe.
    const file = path.join(root, 'varredura', '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((t) => t.id === id)!, { status: 'todo', waitReason: null });
    await fs.writeFile(file, JSON.stringify(all));
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'waiting' });
  });

  it('o dono leva um card SEM conversa para a fazer: não há corte a confirmar, nada é marcado', async () => {
    const b = await club('sem-conversa');
    const t = (await b.svc.create('p', { title: 'Nova', staffId: 'ana-1', start: false }))!;
    await b.svc.update('p', t.id, { status: 'waiting' }, true);
    const out = await b.svc.update('p', t.id, { status: 'todo' }, true);
    expect(out!.cutAck).toBeUndefined();
  });
});

describe('o que a ciência do dono não muda', () => {
  it('o limite de consumo segue valendo: a retomada espera, e a marca fica até ela sair', async () => {
    const b = await club('consumo');
    const id = await b.parked('Corte');
    await b.svc.update('p', id, { status: 'todo' }, true);
    b.state.stop = { kind: 'five_hour', percentUsed: 97, limit: 95, resetsAt: null };
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', cutAck: true, queuedForce: false });
    b.state.stop = null;
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
    expect(b.state.cutAsked).toEqual([]); // com o limite batido e depois livre, a checagem do corte nunca voltou
  });

  it('a fila serial segue: o responsável em outra conversa não é interrompido; livre, o card retoma', async () => {
    const b = await club('serial');
    const id = await b.parked('Corte');
    b.state.busy = true;
    await b.svc.update('p', id, { status: 'todo' }, true);
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String), cutAck: true });
    b.state.busy = false;
    await b.svc.tick();
    expect(b.state.sentTo).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('a dependência pendente segue: a retomada espera quem bloqueia', async () => {
    const b = await club('bloqueio');
    const base = (await b.svc.create('p', { title: 'Base', staffId: 'cris-1', start: false }))!;
    const id = await b.parked('Corte');
    await b.svc.update('p', id, { blockedBy: [base.id] }, true);
    await b.svc.update('p', id, { status: 'todo' }, true);
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'todo', cutAck: true, queuedAt: null });
  });

  it('o dono leva o card para outra coluna: a ciência cai, e quem o devolver sem ser o dono não a herda', async () => {
    const b = await club('outra-coluna');
    const id = await b.parked('Corte');
    await b.svc.update('p', id, { status: 'todo' }, true);
    expect(await b.get(id)).toMatchObject({ cutAck: true });
    await b.svc.update('p', id, { status: 'waiting' }, true);
    expect((await b.get(id)).cutAck).toBeUndefined();
    await b.svc.update('p', id, { status: 'todo' }); // sem o dono
    await b.svc.tick();
    expect(b.state.sentTo).toEqual([]);
    expect(await b.get(id)).toMatchObject({ status: 'waiting' });
  });
});

describe('a rota', () => {
  it('só a tela passa `true` ao `update`; o funcionário vai pelo `editFrom`, que não muda de coluna', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/tasks\/\$\{ID\}\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('if (fromBrowser) return tasks.update(id!, taskId!, body, true);');
    expect(route).toContain('return tasks.editFrom(id!, taskId!, caller, body);');
    // Nenhum outro chamador do `update` na raiz do servidor passa o dono (o `parkTask` só muda o motivo de Aguardar).
    expect([...src.matchAll(/tasks\.update\([^)]*\)/g)].map((m) => m[0]).filter((c) => c.endsWith(', true)'))).toHaveLength(1);
    const tasksSrc = await fs.readFile(path.join(__dirname, '..', 'server', 'tasks.ts'), 'utf8');
    expect(tasksSrc).toContain('async update(projectId: string, taskId: string, body: unknown, byOwner = false)');
  });
});
