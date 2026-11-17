import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stuckState, TaskError, TaskService } from '../server/tasks';
import type { StaffProfile, TestRun } from '../shared/model';

// Revisão automática perdida num reinício (t-686f25): o card chegou em "revisão" (fim do turno), o servidor caiu antes do `autoReview` (os
// testes da entrega levam minutos) e nada retomava. O `tick` pede a revisão, uma vez, só do que se perdeu assim.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-resume-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);

const people: Record<string, StaffProfile> = {
  'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'manual', worktree: false } as StaffProfile,
};

async function board(dirName: string, opts: { runTests?: (cwd: string, command: string) => Promise<TestRun>; withTests?: boolean } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  if (opts.withTests) await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  const file = path.join(dir, '.myco', 'tasks.json');
  const h = { sent: [] as Array<{ staffId: string; text: string; session: string }>, failSend: null as null | (() => Error), n: 0 };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      if (h.failSend && staffId !== 'ana-1') throw h.failSend();
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, text, session });
      return session;
    },
    branchFor: async () => null,
    isWorking: () => false,
    sendTo: async (_p, sessionId) => sessionId,
    notify: async () => {},
    lastText: () => null,
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    ...(opts.runTests && { runTests: opts.runTests }),
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Muda o arquivo das tarefas por fora: o estado em que o reinício deixou o card. */
  const edit = async (fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all[0]!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const toReviewer = (staffId = 'rev-1') => h.sent.filter((s) => s.staffId === staffId);
  /** Pedidos a quem revisa (a conversa de trabalho da Ana não conta). */
  const asked = () => h.sent.filter((s) => s.staffId !== 'ana-1');
  return { h, svc, get, edit, toReviewer, asked };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana entrega a tarefa (com `rev-1` marcado, ou sem revisor); o pedido de revisão sai junto. */
async function entregue(b: Board, reviewerId: string | null = 'rev-1') {
  const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1', reviewerId }))!;
  await b.svc.start('p', t.id);
  await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
  return t.id;
}

/** O card como o reinício o deixa: em revisão, com a entrega, sem a revisão que o servidor ia pedir. */
const lost = (t: Record<string, any>) => {
  delete t.review;
  delete t.reviewRounds;
  t.sessions = (t.sessions ?? []).filter((s: { role: string }) => s.role !== 'review');
};

describe('revisão automática perdida em reinício', () => {
  it('em revisão, com entrega e sem revisão pedida: o próximo tick pede, uma vez', async () => {
    const b = await board('r-perdida');
    const id = await entregue(b);
    expect(b.toReviewer()).toHaveLength(1);
    await b.edit(lost);
    expect((await b.get(id)).review).toBeUndefined();

    await b.svc.tick(new Date());
    const t = await b.get(id);
    expect(b.toReviewer()).toHaveLength(2);
    expect(t.reviewRounds).toBe(1);
    expect(t.review).toMatchObject({ staffId: 'rev-1', sessionId: b.toReviewer()[1]!.session });
    expect(t.delivery).toBeDefined();
    expect(t.review!.at >= t.delivery!.at).toBe(true);

    await b.svc.tick(later(1));
    await b.svc.tick(later(20));
    expect(b.toReviewer()).toHaveLength(2);
    expect((await b.get(id)).reviewRounds).toBe(1);
  });

  it('dois ticks juntos pedem uma revisão só', async () => {
    const b = await board('r-dois-ticks');
    const id = await entregue(b);
    await b.edit(lost);
    await Promise.all([b.svc.tick(new Date()), b.svc.tick(new Date())]);
    expect(b.toReviewer()).toHaveLength(2);
    expect((await b.get(id)).reviewRounds).toBe(1);
  });

  it('o revisor é o do quadro quando a tarefa não tem: a precedência de `reviewerOf` segue valendo', async () => {
    const b = await board('r-quadro');
    await fs.mkdir(path.join(root, 'r-quadro', '.myco'), { recursive: true });
    await fs.writeFile(path.join(root, 'r-quadro', '.myco', 'board.json'), JSON.stringify({ autoReview: true, reviewerId: 'rev-1' }));
    const id = await entregue(b, null);
    expect(b.toReviewer()).toHaveLength(1); // já pediu pelo quadro na entrega
    await b.edit((t) => {
      lost(t);
      t.reviewerId = null; // a marca do quadro é gravada quando o pedido sai: o que se perdeu não a gravou
    });
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(2);
    expect(await b.get(id)).toMatchObject({ reviewerId: 'rev-1', reviewRounds: 1 });
  });

  it('não retoma sem revisor: o card espera o dono', async () => {
    const b = await board('r-sem-revisor');
    const id = await entregue(b, null);
    await b.svc.tick(new Date());
    await b.svc.tick(later(5));
    expect(b.asked()).toHaveLength(0);
    expect(await b.get(id)).toMatchObject({ status: 'review' });
    expect((await b.get(id)).review).toBeUndefined();
  });

  it('não retoma com a revisão já pedida (aberta ou respondida)', async () => {
    const b = await board('r-aberta');
    const id = await entregue(b);
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(1);

    await b.edit((t) => (t.review = { ...t.review, doneAt: new Date().toISOString(), verdict: 'rejected' })); // respondida, ainda em revisão
    await b.svc.tick(later(5));
    expect(b.toReviewer()).toHaveLength(1);
    expect((await b.get(id)).review).toMatchObject({ verdict: 'rejected' });
  });

  it('a revisão de uma rodada anterior não conta: a entrega nova sem pedido é retomada', async () => {
    const b = await board('r-rodada-velha');
    const id = await entregue(b);
    await b.edit((t) => {
      // A entrega é depois do pedido: o `review` que sobrou é da rodada que reprovou.
      t.review.at = new Date(Date.parse(t.delivery.at) - 1000).toISOString();
      t.reviewRounds = 1;
    });
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(2);
    expect(await b.get(id)).toMatchObject({ reviewRounds: 2 });
  });

  it('não retoma com reviewRetry (o retry tem a hora dele)', async () => {
    const b = await board('r-retry');
    b.h.failSend = () => new Error('limite de uso');
    const id = await entregue(b);
    expect((await b.get(id)).reviewRetry).toBeDefined();
    b.h.failSend = null;
    await b.svc.tick(new Date()); // antes da hora do retry
    expect(b.asked()).toHaveLength(0);
    expect((await b.get(id)).reviewRetry).toBeDefined();
  });

  it('o pedido que falhou de vez avisa já (nota e caixa, com o motivo) e a nota não se repete a cada tentativa', async () => {
    const b = await board('r-falhou');
    b.h.failSend = () => new TaskError('ficha do revisor inválida');
    const id = await entregue(b);
    const notes = () => b.get(id).then((t) => t.history.filter((h) => h.note?.startsWith('revisão automática não começou')));
    expect(await notes()).toHaveLength(1);
    expect(stuckState(await b.get(id))).toMatchObject({ humanAction: 'review', selfHeals: false, reason: 'a revisão automática não começou: ficha do revisor inválida' });
    await b.svc.tick(new Date());
    await b.svc.tick(later(5)); // a causa segue: tenta de novo, em silêncio
    await b.svc.tick(later(25));
    expect(b.asked()).toHaveLength(0);
    expect(await notes()).toHaveLength(1);
    expect((await b.get(id)).reviewRetry).toMatchObject({ expired: true });
  });

  it('o pedido que falhou de vez abre quando o dono corrige a causa, sem empurrar o card', async () => {
    const b = await board('r-corrigiu');
    b.h.failSend = () => new TaskError('ficha do revisor inválida');
    const id = await entregue(b);
    b.h.failSend = null; // o dono arrumou a ficha
    await b.svc.tick(later(5));
    const t = await b.get(id);
    expect(b.asked()).toHaveLength(1);
    expect(t.review).toMatchObject({ staffId: 'rev-1' });
    expect(t.reviewRetry).toBeUndefined();
    expect(stuckState(t)).toBeNull();
  });

  it('não retoma depois do limite de rodadas, nem anota o limite de novo', async () => {
    const b = await board('r-limite');
    const id = await entregue(b);
    await b.edit((t) => {
      lost(t);
      t.reviewRounds = 3;
    });
    const before = (await b.get(id)).history.length;
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(1);
    expect((await b.get(id)).history).toHaveLength(before);
  });

  it('não retoma a que parou pela metade (órfã) nem a que você arrastou para revisão', async () => {
    const b = await board('r-orfa');
    const id = await entregue(b);
    const entry = (t: Record<string, any>) => t.history.find((h: { note?: string }) => h.note === 'turno terminou');
    await b.edit((t) => {
      lost(t);
      entry(t).note = 'conversa parou sem terminar';
    });
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(1);

    const c = await board('r-arrastada');
    await entregue(c);
    await c.edit((t) => {
      lost(t);
      const moved = entry(t);
      moved.by = 'you';
      delete moved.note;
    });
    await c.svc.tick(new Date());
    expect(c.toReviewer()).toHaveLength(1);
    expect(id).toBeTruthy();
  });

  it('não retoma tarefa fora de revisão', async () => {
    const b = await board('r-fora');
    const id = await entregue(b);
    await b.edit((t) => {
      lost(t);
      t.status = 'doing';
    });
    await b.svc.tick(new Date());
    expect(b.toReviewer()).toHaveLength(1);
    expect(await b.get(id)).toMatchObject({ status: 'doing' });
  });

  it('entrega com os testes ainda rodando não é entrega perdida: o tick espera e o pedido sai uma vez', async () => {
    let release!: (run: TestRun) => void;
    const running = new Promise<TestRun>((resolve) => (release = resolve));
    const b = await board('r-testes', { withTests: true, runTests: () => running });
    const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1' }, 'gio-1', 'gio-s'))!; // pedida pela Giovana: ela é a revisora
    await b.svc.start('p', t.id);
    const delivered = b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    await new Promise((r) => setTimeout(r, 100)); // já em revisão, dentro dos testes
    expect(await b.get(t.id)).toMatchObject({ status: 'review' });
    expect((await b.get(t.id)).review).toBeUndefined();

    await b.svc.tick(new Date());
    expect(b.h.sent.filter((s) => s.staffId === 'gio-1')).toHaveLength(0);

    release({ command: 'npm test', ok: true, output: '', ms: 1, at: new Date().toISOString() });
    await delivered;
    expect(b.h.sent.filter((s) => s.staffId === 'gio-1')).toHaveLength(1);
    expect((await b.get(t.id)).reviewRounds).toBe(1);
    await b.svc.tick(later(1));
    expect(b.h.sent.filter((s) => s.staffId === 'gio-1')).toHaveLength(1);
  });

  it('os testes guardados de uma entrega anterior não vão ao revisor como se fossem desta', async () => {
    const b = await board('r-testes-velhos');
    const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1' }, 'gio-1', 'gio-s'))!;
    await b.svc.start('p', t.id);
    await b.svc.onTurnDone((await b.get(t.id)).sessionId!);
    await b.edit((x) => {
      lost(x);
      x.tests = { command: 'npm test', ok: true, output: '', ms: 1000, at: '2020-01-01T00:00:00.000Z' };
    });
    const before = b.h.sent.length;
    await b.svc.tick(new Date());
    const asked = b.h.sent.slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).not.toContain('Testes (');
    expect((await b.get(t.id)).tests).toBeUndefined();
  });
});

