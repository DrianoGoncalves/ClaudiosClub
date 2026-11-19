import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// Cada rodada de revisão julga a entrega de agora (t-6270da, caso t-b80e90): a tarefa volta a "revisão" com a revisão da rodada anterior ainda gravada
// (veredito, doneAt, reaskAt) e a conversa velha do revisor ainda viva, enquanto os testes da entrega rodam e o pedido novo não saiu. Nessa janela o
// turno da conversa velha (ou um re-pedido vencido) não pode contar como resposta da rodada nova. Vale para os dois motores do revisor.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-rounds-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);
const REASKED = /exatamente assim, e depois os achados/;

async function board(dirName: string, reviewerEngine: 'claude' | 'codex') {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false, engine: reviewerEngine } as StaffProfile,
  };
  const h = {
    sent: [] as Array<{ staffId: string; session: string; text: string; reviewOnly: boolean | undefined }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    /** A última resposta de cada conversa (o que o revisor disse): sessão → texto. */
    said: new Map<string, string>(),
    /** Enquanto houver, a abertura da conversa de revisão espera (os testes da entrega, ou o processo subindo). */
    gate: null as Promise<void> | null,
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text, _force, _override, reviewOnly) => {
      if (reviewOnly && h.gate) await h.gate;
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, text, reviewOnly });
      return session;
    },
    sendTo: async (_p, session, _staff, text) => {
      h.sentTo.push({ session, text });
      return session;
    },
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
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { h, svc, get, edit };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana começa e entrega; o Rui (revisor do card) recebe o pedido da 1ª rodada. */
async function round1(b: Board) {
  const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work);
  return { id: t.id, work, review: (await b.get(t.id)).review!.sessionId };
}

/** O Rui reprova a 1ª rodada, com a conversa dele ainda aberta, e a Ana volta a trabalhar. */
async function reprovada(b: Board, id: string, review: string) {
  b.h.said.set(review, 'REPROVADO\n🔴 a.ts:1 quebrou');
  await b.svc.onTurnDone(review);
  expect(await b.get(id)).toMatchObject({ status: 'doing', review: { sessionId: review, verdict: 'rejected' } });
}

describe.each(['claude', 'codex'] as const)('rodada nova de revisão, revisor no %s', (engine) => {
  it('a conversa velha, com o veredito da rodada anterior, não conta na rodada nova: o pedido novo chega ao revisor e só o veredito dele decide', async () => {
    const b = await board(`janela-${engine}`, engine);
    const { id, work, review: first } = await round1(b);
    await reprovada(b, id, first);
    // O que sobrou da rodada 1: um re-pedido que já venceu (como o da t-b80e90, marcado enquanto ele ainda revisava).
    await b.edit(id, (t) => (t.review.reaskAt = new Date(Date.now() - 5 * MIN).toISOString()));
    const verdictAt = (await b.get(id)).review!.doneAt;
    const adjustments = () => b.h.sentTo.filter((m) => m.session === work && /reprovou/.test(m.text)).length;
    expect(adjustments()).toBe(1);

    // A Ana entrega de novo; o pedido da rodada 2 demora a sair (testes da entrega, conversa subindo).
    let open!: () => void;
    b.h.gate = new Promise<void>((resolve) => (open = resolve));
    const delivering = b.svc.onTurnDone(work);
    await vi.waitFor(async () => expect(await b.get(id)).toMatchObject({ status: 'review', review: { sessionId: first, superseded: true } }));

    // Nessa janela: o turno da conversa velha lê a última resposta dela (o REPROVADO antigo) e a cobrança vencida roda no tick.
    await b.svc.onTurnDone(first);
    await b.svc.tick(later(15));
    const waiting = await b.get(id);
    expect(waiting.status).toBe('review'); // não reprovou de novo
    expect(waiting.review).toMatchObject({ sessionId: first, verdict: 'rejected', doneAt: verdictAt }); // a revisão velha segue como estava
    expect(waiting.history.filter((h) => h.note === 'revisão respondida')).toHaveLength(1); // e a resposta velha não virou "revisão respondida"
    expect(adjustments()).toBe(1); // nenhum ajuste repetido para a Ana
    expect(b.h.sentTo.filter((m) => m.session === first && REASKED.test(m.text))).toEqual([]); // nem re-pedido à conversa velha

    // O pedido sai: conversa nova, com a entrega de agora.
    open();
    b.h.gate = null;
    await delivering;
    const second = b.h.sent.filter((s) => s.staffId === 'rev-1' && s.reviewOnly).at(-1)!;
    expect(second.session).not.toBe(first);
    expect(second.text).toMatch(/\[Revisão da tarefa "Tela"\][\s\S]*Mostrar o card[\s\S]*Sem erro no console[\s\S]*APROVADO ou REPROVADO/);
    const now = await b.get(id);
    expect(now).toMatchObject({ status: 'review', reviewRounds: 2, review: { staffId: 'rev-1', sessionId: second.session } });
    expect(now.review!.superseded).toBeUndefined();
    expect(now.review!.verdict).toBeUndefined();
    expect(now.review!.doneAt).toBeUndefined();
    expect(now.review!.reaskAt).toBeUndefined();
    expect(now.sessions?.find((s) => s.id === second.session)).toMatchObject({ role: 'review', engine });

    // A conversa velha ainda fala (o REPROVADO antigo): não decide. O veredito da conversa nova decide.
    await b.svc.onTurnDone(first);
    expect((await b.get(id)).status).toBe('review');
    expect((await b.get(id)).review).toMatchObject({ sessionId: second.session });
    b.h.said.set(second.session, 'APROVADO\n🟢 a.ts:2 nome');
    await b.svc.onTurnDone(second.session);
    expect(await b.get(id)).toMatchObject({ status: 'done', review: { verdict: 'approved' } });
  });

  it('só pede de novo quando o revisor respondeu sem veredito ao pedido atual, e uma vez', async () => {
    const b = await board(`reask-${engine}`, engine);
    const { id, work, review: first } = await round1(b);
    const reasks = (session: string) => b.h.sentTo.filter((m) => m.session === session && REASKED.test(m.text)).length;

    // Respondeu sem veredito: marca a hora; antes dela nada sai.
    b.h.said.set(first, 'Vou olhar com calma.');
    await b.svc.onTurnDone(first);
    expect((await b.get(id)).review).toMatchObject({ doneAt: expect.any(String), verdict: null, reaskAt: expect.any(String) });
    await b.svc.tick(later(5));
    expect(reasks(first)).toBe(0);
    await b.svc.tick(later(11));
    expect(reasks(first)).toBe(1);
    await b.svc.tick(later(30));
    expect(reasks(first)).toBe(1); // uma vez só

    // Quem já deu o veredito não é cobrado, mesmo com a hora do re-pedido vencida (aprovada à espera da mescla, ajuste guardado).
    const c = await board(`reask-decidiu-${engine}`, engine);
    const done = await round1(c);
    await c.edit(done.id, (t) => Object.assign(t.review, { doneAt: new Date().toISOString(), verdict: 'rejected', reaskAt: new Date(Date.now() - MIN).toISOString() }));
    await c.svc.tick(later(15));
    expect(c.h.sentTo.filter((m) => REASKED.test(m.text))).toEqual([]);

    // A revisão da rodada anterior, com a hora vencida e sem veredito (a conversa dele morreu), também não é cobrada na rodada nova.
    const d = await board(`reask-velha-${engine}`, engine);
    const old = await round1(d);
    await reprovada(d, old.id, old.review);
    await d.edit(old.id, (t) => Object.assign(t.review, { verdict: null, reaskAt: new Date(Date.now() - MIN).toISOString() }));
    d.h.gate = new Promise<void>(() => {}); // o pedido da rodada 2 não sai nesta janela
    void d.svc.onTurnDone(old.work);
    await vi.waitFor(async () => expect(await d.get(old.id)).toMatchObject({ status: 'review', review: { sessionId: old.review, superseded: true } }));
    await d.svc.tick(later(15));
    expect(d.h.sentTo.filter((m) => REASKED.test(m.text))).toEqual([]);
    void work;
  });

  it('tarefa de antes da marca: a revisão pedida antes da entrega gravada também é de rodada anterior', async () => {
    const b = await board(`legado-${engine}`, engine);
    const { id, work, review: first } = await round1(b);
    await reprovada(b, id, first);
    b.h.gate = new Promise<void>(() => {});
    void b.svc.onTurnDone(work);
    await vi.waitFor(async () => expect(await b.get(id)).toMatchObject({ status: 'review', review: { superseded: true } }));
    // Como estava gravada antes da marca existir: sem `superseded`, só a entrega mais nova que o pedido.
    await b.edit(id, (t) => delete t.review.superseded);
    const before = await b.get(id);
    expect(Date.parse(before.delivery!.at)).toBeGreaterThan(Date.parse(before.review!.at));
    await b.svc.onTurnDone(first);
    await b.svc.tick(later(15));
    const after = await b.get(id);
    expect(after.status).toBe('review');
    expect(after.review).toEqual(before.review);
    expect(b.h.sentTo.filter((m) => REASKED.test(m.text))).toEqual([]);
  });
});
