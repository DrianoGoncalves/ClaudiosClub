import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stuckReason, TaskService } from '../server/tasks';
import { AUTO_REVIEW_ROUNDS, type StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Pedido do dono (21/11): tarefa parada no limite de revisões automáticas (3/3, reprovada) que troca de revisor (ou é delegada de novo ao mesmo)
// zera as rodadas, grava a nota no histórico e abre a revisão da entrega de agora. Pela tela ("Delegar revisão", POST /review → `requestReview`)
// e pela edição do card (POST /tasks/:id → `update`). Fora do limite nada muda.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-handoff-'));
});
afterAll(() => removeTemp(root));

const CAP = `limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas;`;

async function board(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-2': { id: 'rev-2', name: 'Bia', role: 'Revisora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };
  const h = { sent: [] as Array<{ staffId: string; session: string; text: string }>, said: new Map<string, string>(), n: 0 };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, text });
      return session;
    },
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: (session) => h.said.get(session) ?? null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id)!;
  const to = (staffId: string) => h.sent.filter((s) => s.staffId === staffId);
  return { h, svc, get, to };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana entrega e o revisor reprova `n` vezes; a entrega seguinte já não pede revisão. */
async function reproved(b: Board, id: string, work: string, n: number) {
  for (let i = 0; i < n; i++) {
    const review = (await b.get(id)).review!.sessionId;
    b.h.said.set(review, `REPROVADO\n🔴 a.ts:${i + 1} quebrou`);
    await b.svc.onTurnDone(review);
    await b.svc.onTurnDone(work);
  }
}

/** O card no limite: 3 revisões do Rui, as 3 reprovadas, e a 4ª entrega parada com a nota do limite. */
async function capped(dirName: string) {
  const b = await board(dirName);
  const t = (await b.svc.create('p', { title: 'Relatório', description: 'Exportar', acceptance: 'Sem erro', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work); // rodada 1
  await reproved(b, t.id, work, AUTO_REVIEW_ROUNDS);
  const end = await b.get(t.id);
  expect(end).toMatchObject({ status: 'review', reviewerId: 'rev-1', reviewRounds: AUTO_REVIEW_ROUNDS, review: { staffId: 'rev-1', verdict: 'rejected' } });
  expect(end.history.at(-1)?.note).toContain(CAP);
  expect(stuckReason(end)).toBe('limite de revisões automáticas atingido');
  expect(b.to('rev-1')).toHaveLength(AUTO_REVIEW_ROUNDS);
  return { b, id: t.id, work };
}

describe('revisão delegada a tarefa parada no limite de revisões', () => {
  it('troca pela edição do card: zera as rodadas, grava a nota com os dois nomes, abre a revisão com o novo e o aviso do limite some', async () => {
    const { b, id } = await capped('edicao');
    const out = await b.svc.update('p', id, { reviewerId: 'rev-2' });

    const now = await b.get(id);
    expect(now).toMatchObject({ status: 'review', reviewerId: 'rev-2', reviewRounds: 1, review: { staffId: 'rev-2' } });
    expect(now.review!.doneAt).toBeUndefined();
    expect(now.review!.verdict).toBeUndefined();
    expect(now.review!.sessionId).toBe(b.to('rev-2')[0]!.session); // a revisão foi pedida à Bia, pelo caminho da revisão automática
    expect(b.to('rev-2')[0]!.text).toMatch(/\[Revisão da tarefa "Relatório"\][\s\S]*Exportar[\s\S]*Sem erro[\s\S]*APROVADO ou REPROVADO/);
    expect(now.history.map((h) => h.note)).toContain(`revisor trocado de Rui para Bia; rodadas de revisão zeradas (${AUTO_REVIEW_ROUNDS}/${AUTO_REVIEW_ROUNDS})`);
    expect(stuckReason(now)).toBeNull();
    expect(out).toMatchObject({ reviewRounds: 1, review: { sessionId: now.review!.sessionId } }); // a resposta já traz a revisão aberta
    expect(b.to('rev-1')).toHaveLength(AUTO_REVIEW_ROUNDS); // o Rui não é chamado de novo
  });

  it('o novo revisor tem até AUTO_REVIEW_ROUNDS rodadas; no fim, o limite e o dono de novo', async () => {
    const { b, id, work } = await capped('novas-rodadas');
    await b.svc.update('p', id, { reviewerId: 'rev-2' }); // rodada 1 da Bia
    await reproved(b, id, work, AUTO_REVIEW_ROUNDS);

    const end = await b.get(id);
    expect(b.to('rev-2')).toHaveLength(AUTO_REVIEW_ROUNDS);
    expect(end).toMatchObject({ status: 'review', reviewerId: 'rev-2', reviewRounds: AUTO_REVIEW_ROUNDS, review: { staffId: 'rev-2', verdict: 'rejected' } });
    expect(end.history.at(-1)?.note).toContain(CAP);
    expect(stuckReason(end)).toBe('limite de revisões automáticas atingido');
    expect(b.to('rev-2')).toHaveLength(AUTO_REVIEW_ROUNDS); // a 4ª entrega não pediu revisão
  });

  it('"Delegar revisão" (POST /review) a outro revisor: o mesmo (rodadas zeradas, nota, revisão aberta)', async () => {
    const { b, id } = await capped('tela-outro');
    await b.svc.requestReview('p', id, 'rev-2', false, { assign: true });

    const now = await b.get(id);
    expect(now).toMatchObject({ status: 'review', reviewerId: 'rev-2', reviewRounds: 1, review: { staffId: 'rev-2', sessionId: b.to('rev-2')[0]!.session } });
    expect(now.review!.doneAt).toBeUndefined();
    expect(now.history.map((h) => h.note)).toContain(`revisor trocado de Rui para Bia; rodadas de revisão zeradas (${AUTO_REVIEW_ROUNDS}/${AUTO_REVIEW_ROUNDS})`);
    expect(stuckReason(now)).toBeNull();
  });

  it('delegar de novo ao MESMO revisor que reprovou, no limite, também zera as rodadas e abre a revisão', async () => {
    const { b, id } = await capped('mesmo');
    await b.svc.requestReview('p', id, 'rev-1', false, { assign: true });

    const now = await b.get(id);
    expect(now).toMatchObject({ status: 'review', reviewerId: 'rev-1', reviewRounds: 1, review: { staffId: 'rev-1' } });
    expect(now.review!.doneAt).toBeUndefined();
    expect(b.to('rev-1')).toHaveLength(AUTO_REVIEW_ROUNDS + 1);
    expect(now.review!.sessionId).toBe(b.to('rev-1').at(-1)!.session);
    expect(now.history.map((h) => h.note)).toContain(`revisão delegada de novo a Rui; rodadas de revisão zeradas (${AUTO_REVIEW_ROUNDS}/${AUTO_REVIEW_ROUNDS})`);
    expect(stuckReason(now)).toBeNull();
  });

  it('fora do limite nada muda: as rodadas seguem e a troca não zera nem anota', async () => {
    const b = await board('fora');
    const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    await b.svc.onTurnDone(work); // rodada 1 do Rui, em curso
    const notes = async () => (await b.get(t.id)).history.map((h) => h.note);

    // Revisão em curso (rodada 1/3): trocar o revisor só grava o campo, como antes.
    const during = await notes();
    await b.svc.update('p', t.id, { reviewerId: 'rev-2' });
    expect(await b.get(t.id)).toMatchObject({ reviewerId: 'rev-2', reviewRounds: 1, review: { staffId: 'rev-1' } });
    expect(await notes()).toEqual(during);
    expect(b.to('rev-2')).toEqual([]);
    await b.svc.update('p', t.id, { reviewerId: 'rev-1' });

    // Reprovada 2 vezes (rodada 3/3 em curso): ainda não é o limite.
    await reproved(b, t.id, work, 2);
    expect(await b.get(t.id)).toMatchObject({ status: 'review', reviewRounds: AUTO_REVIEW_ROUNDS });
    expect((await b.get(t.id)).review!.doneAt).toBeUndefined();
    const before = await notes();
    await b.svc.requestReview('p', t.id, 'rev-2', false, { assign: true }); // pedido manual, sem o limite: só a revisão
    expect(await b.get(t.id)).toMatchObject({ reviewerId: 'rev-2', reviewRounds: AUTO_REVIEW_ROUNDS, review: { staffId: 'rev-2' } });
    expect((await notes()).filter((n) => /rodadas de revisão zeradas/.test(n ?? ''))).toEqual([]);
    expect((await notes()).length).toBe(before.length);
  });

  it('no limite, o patch que repete o revisor não é delegação: nada muda (só "Delegar revisão" zera)', async () => {
    const { b, id } = await capped('patch-igual');
    const sent = b.h.sent.length;
    await b.svc.update('p', id, { reviewerId: 'rev-1' });
    expect(await b.get(id)).toMatchObject({ reviewRounds: AUTO_REVIEW_ROUNDS, review: { verdict: 'rejected' } });
    expect(stuckReason(await b.get(id))).toBe('limite de revisões automáticas atingido');
    expect(b.h.sent.length).toBe(sent);
  });

  it('no limite, trocar quem faz a tarefa ou tirar o revisor não delega nada', async () => {
    const { b, id } = await capped('sem-revisor');
    await b.svc.update('p', id, { title: 'Outro título' });
    expect(await b.get(id)).toMatchObject({ reviewRounds: AUTO_REVIEW_ROUNDS });
    await b.svc.update('p', id, { reviewerId: null });
    expect(await b.get(id)).toMatchObject({ reviewerId: null, reviewRounds: AUTO_REVIEW_ROUNDS });
    expect(b.to('rev-2')).toEqual([]);
  });
});
