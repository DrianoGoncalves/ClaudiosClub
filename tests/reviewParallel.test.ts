import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// A revisão roda em paralelo (t-d74d52): o revisor do card (que vale mais que o do quadro) abre a conversa de revisão sem esperar a tarefa de trabalho
// dele, e a conversa não conta como trabalho para a fila dele. Ela abre sem edição de arquivo (`reviewOnly`).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-parallel-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);

const people: Record<string, StaffProfile> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'dav-1': { id: 'dav-1', name: 'Davi', role: 'Revisor do quadro', autonomy: 'manual', worktree: false } as StaffProfile,
};

async function board(dirName: string) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  // O revisor automático do quadro é o Davi; o card pode apontar outro.
  await fs.writeFile(path.join(dir, '.myco', 'board.json'), JSON.stringify({ autoReview: true, reviewerId: 'dav-1' }));
  const file = path.join(dir, '.myco', 'tasks.json');
  const h = {
    sent: [] as Array<{ staffId: string; session: string; reviewOnly: boolean | undefined }>,
    sentTo: [] as Array<{ session: string; text: string }>,
    /** Conversas trabalhando agora: sessão → funcionário. */
    working: new Map<string, string>(),
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, _text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, reviewOnly });
      return session;
    },
    sendTo: async (_p, session, _staff, text) => {
      h.sentTo.push({ session, text });
      return session;
    },
    branchFor: async () => null,
    // Como o manager: alguma conversa do funcionário trabalhando, fora as dispensadas.
    isWorking: (_p, staffId, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some(([session, who]) => who === staffId && !skip.includes(session));
    },
    isSessionWorking: (session) => h.working.has(session),
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const edit = async (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    await fs.writeFile(file, JSON.stringify(all));
  };
  return { h, svc, get, edit };
}
type Board = Awaited<ReturnType<typeof board>>;

/** A Ana começa e entrega a tarefa. `reviewerId`: o do card (sem ele, vale o do quadro). */
async function entregue(b: Board, reviewerId: string | null = null) {
  const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1', reviewerId }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work);
  return { id: t.id, work };
}

describe('revisão em paralelo e sem edição', () => {
  it('a conversa de revisão abre com `reviewOnly`; a de trabalho, não', async () => {
    const b = await board('so-leitura');
    await entregue(b);
    expect(b.h.sent.map((s) => [s.staffId, s.reviewOnly])).toEqual([
      ['ana-1', undefined],
      ['dav-1', true],
    ]);
  });

  it('o revisor do card vale mais que o do quadro e abre na hora, mesmo trabalhando em outra tarefa', async () => {
    const b = await board('paralelo-abre');
    // O Rui está no meio do trabalho dele (uma conversa trabalhando).
    const mine = (await b.svc.create('p', { title: 'Tarefa do Rui', staffId: 'rev-1' }))!;
    await b.svc.start('p', mine.id);
    const ruiWork = (await b.get(mine.id)).sessionId!;
    b.h.working.set(ruiWork, 'rev-1');
    const { id } = await entregue(b, 'rev-1');
    const t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', reviewerId: 'rev-1', review: { staffId: 'rev-1' } });
    const review = b.h.sent.find((s) => s.staffId === 'rev-1' && s.reviewOnly);
    expect(review).toBeDefined();
    expect(t.review!.sessionId).toBe(review!.session);
    expect(b.h.sent.some((s) => s.staffId === 'dav-1')).toBe(false); // o do quadro não revisa este card
    expect(t.reviewRetry).toBeUndefined();
    // A tarefa de trabalho dele segue como estava.
    expect(await b.get(mine.id)).toMatchObject({ status: 'doing', sessionId: ruiWork });
  });

  it('a revisão que o revisor está fazendo não segura a fila de trabalho dele; o trabalho dele, sim', async () => {
    const b = await board('paralelo-fila');
    const { id } = await entregue(b, 'rev-1');
    const review = (await b.get(id)).review!.sessionId;
    b.h.working.set(review, 'rev-1'); // ele está revisando agora
    const next = (await b.svc.create('p', { title: 'Do Rui', staffId: 'rev-1' }))!;
    await b.svc.start('p', next.id);
    // Começou na hora: a conversa de revisão não conta como trabalho.
    expect(await b.get(next.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String) });

    // Controle: com uma conversa de trabalho dele trabalhando, a próxima espera.
    const work = (await b.get(next.id)).sessionId!;
    b.h.working.set(work, 'rev-1');
    const queued = (await b.svc.create('p', { title: 'Outra do Rui', staffId: 'rev-1' }))!;
    await b.svc.start('p', queued.id);
    expect(await b.get(queued.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String), sessionId: null });
  });

  it('o ajuste de uma reprovação não espera o executor terminar uma revisão que ele faz em outro card', async () => {
    const b = await board('paralelo-ajuste');
    const first = await entregue(b, 'rev-1'); // card da Ana, revisado pelo Rui
    // A Ana também revisa (o card do Rui) e está nessa conversa agora.
    const rui = (await b.svc.create('p', { title: 'Do Rui', staffId: 'rev-1', reviewerId: 'ana-1' }))!;
    await b.svc.start('p', rui.id);
    await b.svc.onTurnDone((await b.get(rui.id)).sessionId!);
    const anaReviewing = (await b.get(rui.id)).review!.sessionId;
    b.h.working.set(anaReviewing, 'ana-1');
    // O Rui reprova o card da Ana: o ajuste chega à conversa dela sem esperar a revisão em andamento.
    const review = (await b.get(first.id)).review!.sessionId;
    (b.svc as unknown as { deps: { lastText: () => string | null } }).deps.lastText = () => 'REPROVADO\n🔴 a.ts:1 quebrou';
    await b.svc.onTurnDone(review);
    expect(b.h.sentTo.some((m) => m.session === first.work && m.text.includes('reprovou'))).toBe(true);
    expect(await b.get(first.id)).toMatchObject({ status: 'doing' });
    expect((await b.get(first.id)).held ?? []).toEqual([]);
  });

  it('a conversa de revisão parada e sem resposta é cobrada mesmo com o revisor trabalhando em outra', async () => {
    const b = await board('paralelo-cobra');
    const { id } = await entregue(b, 'rev-1');
    const review = (await b.get(id)).review!.sessionId;
    b.h.working.set('rev-1-outra', 'rev-1'); // ele segue ocupado com outra conversa; a de revisão morreu
    await b.svc.tick(later(5)); // passado o tempo da conversa órfã
    expect((await b.get(id)).review).toMatchObject({ sessionId: review, reaskAt: expect.any(String) });
    // Controle: com a conversa de revisão trabalhando de verdade, não há o que cobrar.
    const c = await board('paralelo-cobra-viva');
    const second = await entregue(c, 'rev-1');
    const live = (await c.get(second.id)).review!.sessionId;
    c.h.working.set(live, 'rev-1');
    await c.svc.tick(later(5));
    expect((await c.get(second.id)).review?.reaskAt).toBeUndefined();
  });
});

