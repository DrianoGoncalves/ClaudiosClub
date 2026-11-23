import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARCHIVE_AFTER_MS, TaskService } from '../server/tasks';
import type { HeldMessage, StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Ajuste guardado em tarefa encerrada (t-c9fa29): a tarefa pronta ou cancelada nunca recebe ajuste guardado. O envio a pula e o que ficou sai com nota; fechar a tarefa (tela, aprovação,
// cancelamento) limpa o que estava guardado; o veredito que chega depois do fechamento não reprova nem guarda nada; e o ajuste de uma tarefa aberta nunca espera atrás do de uma fechada.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-held-closed-'));
});
afterAll(() => removeTemp(root));

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const people: Record<string, StaffProfile> = {
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
};

const held = (id: string, at: string, text = `ajuste ${id}`): HeldMessage => ({ id, at, text, reason: 'espera a Ana terminar a outra tarefa' });
const NOTE_DONE = 'ajuste guardado descartado: a tarefa já está pronta';
const NOTE_CANCELLED = 'ajuste guardado descartado: a tarefa foi cancelada';

type Seed = Partial<Task> & { id: string; status: Task['status'] };

/** As tarefas da Ana direto no `tasks.json` (um card pode nascer já com o ajuste que ficou guardado antes da correção). */
async function board(dirName: string, seeds: Seed[]) {
  const dir = path.join(root, dirName);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const now = new Date().toISOString();
  const base = { description: '', plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [] as unknown[], staffId: 'ana-1' };
  await fs.writeFile(file, JSON.stringify(seeds.map((s) => ({ ...base, title: s.id, ...s }))));
  const h = {
    sentTo: [] as Array<{ sessionId: string; text: string }>,
    sent: [] as Array<{ staffId: string; session: string; text: string; reviewOnly: boolean | undefined }>,
    said: new Map<string, string>(),
    /** Conversas trabalhando agora: com alguma, a Ana está ocupada e o ajuste (da revisão, do dono) fica guardado. */
    working: new Set<string>(),
    /** Chamado uma vez na leitura da pausa (que o `hold` faz no meio da reprovação): deixa a tarefa mudar entre a conferência e a gravação. */
    onPauseRead: null as null | (() => Promise<unknown>),
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text, _force, _override, reviewOnly) => {
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, session, text, reviewOnly });
      return session;
    },
    sendTo: async (_p, sessionId, _s, text) => {
      h.sentTo.push({ sessionId, text });
      return sessionId;
    },
    branchFor: async () => null,
    isWorking: (_p, _s, except) => {
      const skip = typeof except === 'string' ? [except] : [...(except ?? [])];
      return [...h.working].some((s) => !skip.includes(s));
    },
    isSessionWorking: () => false,
    lastText: (session) => h.said.get(session) ?? null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    pauses: {
      get: async () => null,
      all: async () => ({}),
      isPaused: async () => {
        const hook = h.onPauseRead;
        h.onPauseRead = null;
        await hook?.();
        return false;
      },
    } as never,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const get = async (id: string) => (await svc.list('p'))!.find((t) => t.id === id) as Task;
  const raw = async () => JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
  const edit = async (id: string, fn: (t: Task) => Task) => fs.writeFile(file, JSON.stringify((await raw()).map((t) => (t.id === id ? fn(t) : t))));
  return { ...h, h, svc, get, raw, edit };
}
type Board = Awaited<ReturnType<typeof board>>;

const notes = (t: Task) => t.history.map((x) => x.note);

describe('o envio pula a tarefa encerrada', () => {
  it('(a) pronta com ajuste guardado: nada é enviado e o ajuste some, com nota no histórico', async () => {
    const b = await board('envio-pronta', [{ id: 't-done', status: 'done', sessionId: 'ana-old', held: [held('h1', ago(2 * HOUR))] }]);
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.sentTo).toEqual([]);
    const t = await b.get('t-done');
    expect(t.held ?? []).toEqual([]);
    expect(t.status).toBe('done');
    expect(notes(t)).toContain(NOTE_DONE);
  });

  it('(a) cancelada com ajuste guardado: o mesmo, com a nota de cancelada', async () => {
    const b = await board('envio-cancelada', [{ id: 't-can', status: 'cancelled', sessionId: 'ana-old', held: [held('h1', ago(2 * HOUR)), held('h2', ago(HOUR))] }]);
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.sentTo).toEqual([]);
    const t = await b.get('t-can');
    expect(t.held ?? []).toEqual([]);
    expect(notes(t)).toContain('2 ajustes guardados descartados: a tarefa foi cancelada');
  });

  it('(d) o ajuste mais antigo é de tarefa pronta e o mais novo de uma em revisão: vai o da que está em revisão', async () => {
    const b = await board('envio-ordem', [
      { id: 't-done', status: 'done', sessionId: 'ana-old', held: [held('h-velho', ago(3 * HOUR), 'ajuste da tarefa pronta')] },
      { id: 't-rev', status: 'review', sessionId: 'ana-work', held: [held('h-novo', ago(HOUR), 'ajuste da tarefa em revisão')] },
    ]);
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.sentTo).toEqual([{ sessionId: 'ana-work', text: 'ajuste da tarefa em revisão' }]);
    expect((await b.get('t-rev')).held ?? []).toEqual([]);
    expect(notes(await b.get('t-rev'))).toContain('ajuste guardado enviado');
    const old = await b.get('t-done');
    expect(old.held ?? []).toEqual([]);
    expect(notes(old)).toContain(NOTE_DONE);
  });

  it('(d) com o ajuste da tarefa aberta ainda esperando (a Ana ocupada), o da fechada também não passa nem fica', async () => {
    const b = await board('envio-ordem-ocupada', [
      { id: 't-done', status: 'done', sessionId: 'ana-old', held: [held('h-velho', ago(3 * HOUR))] },
      { id: 't-rev', status: 'review', sessionId: 'ana-work', held: [held('h-novo', ago(HOUR))] },
    ]);
    b.working.add('ana-outra'); // outra conversa dela trabalha: ninguém é enviado
    await b.svc.kickStaff('p', 'ana-1');
    expect(b.sentTo).toEqual([]);
    expect((await b.get('t-rev')).held?.map((m) => m.id)).toEqual(['h-novo']); // o da aberta espera a vez
    expect((await b.get('t-done')).held ?? []).toEqual([]);
  });

  it('o tick limpa o ajuste guardado da tarefa encerrada (na subida e de tempos em tempos) e não acorda a Ana por ele', async () => {
    const b = await board('tick-saneamento', [
      { id: 't-done', status: 'done', sessionId: 'ana-old', held: [held('h1', ago(2 * HOUR))] },
      { id: 't-can', status: 'cancelled', sessionId: 'ana-old2', held: [held('h2', ago(HOUR))] },
    ]);
    await b.svc.tick(new Date(), 'p');
    expect(b.sentTo).toEqual([]);
    for (const [id, note] of [['t-done', NOTE_DONE], ['t-can', NOTE_CANCELLED]] as const) {
      const t = await b.get(id);
      expect(t.held ?? []).toEqual([]);
      expect(notes(t)).toContain(note);
    }
  });

  it('o saneamento não muda `updatedAt`: a pronta que já ia para o arquivo não volta ao quadro', async () => {
    const old = ago(ARCHIVE_AFTER_MS + 2 * 86_400_000);
    const b = await board('tick-arquivada', [{ id: 't-done', status: 'done', sessionId: 'ana-old', updatedAt: old, held: [held('h1', old)] }]);
    expect((await b.get('t-done')).archived).toBe(true);
    await b.svc.tick(new Date(), 'p');
    const t = await b.get('t-done');
    expect(t.held ?? []).toEqual([]);
    expect(t.updatedAt).toBe(old);
    expect(t.archived).toBe(true);
  });

  it('o saneamento roda uma vez: sem ajuste em tarefa encerrada, nada é regravado nem anotado', async () => {
    const b = await board('tick-limpo', [{ id: 't-done', status: 'done', sessionId: 'ana-old', held: [held('h1', ago(HOUR))] }]);
    await b.svc.tick(new Date(), 'p');
    const after = JSON.stringify(await b.raw());
    await b.svc.tick(new Date(), 'p');
    expect(JSON.stringify(await b.raw())).toBe(after);
    expect(notes(await b.get('t-done')).filter((n) => n === NOTE_DONE)).toHaveLength(1);
  });
});

describe('fechar a tarefa limpa o ajuste guardado', () => {
  it('(b) o dono finaliza (pronta pela tela): o ajuste sai com nota, e a resposta já vem sem ele', async () => {
    const b = await board('fecha-dono', [{ id: 't-a', status: 'review', sessionId: 'ana-work', held: [held('h1', ago(HOUR))] }]);
    const out = await b.svc.update('p', 't-a', { status: 'done' }, true);
    expect(out?.status).toBe('done');
    expect(out?.held ?? []).toEqual([]);
    const t = await b.get('t-a');
    expect(t.held ?? []).toEqual([]);
    expect(t.history.at(-2)).toMatchObject({ status: 'done', by: 'you' }); // o fechamento, depois a nota do descarte
    expect(t.history.at(-1)).toMatchObject({ status: 'done', by: 'auto', note: NOTE_DONE });
    expect(b.sentTo).toEqual([]);
  });

  it('(b) o dono cancela: o ajuste sai com nota', async () => {
    const b = await board('fecha-cancela', [{ id: 't-a', status: 'review', sessionId: 'ana-work', held: [held('h1', ago(HOUR)), held('h2', ago(HOUR / 2))] }]);
    const out = await b.svc.cancel('p', 't-a', { by: 'user', reason: 'não vale mais' });
    expect(out?.status).toBe('cancelled');
    expect(out?.held ?? []).toEqual([]);
    const t = await b.get('t-a');
    expect(t.held ?? []).toEqual([]);
    expect(notes(t)).toContain('2 ajustes guardados descartados: a tarefa foi cancelada');
    expect(b.sentTo).toEqual([]);
  });

  it('(b) a resposta a uma dúvida guardada também sai: a tarefa fechada não espera por ela', async () => {
    const doubt: HeldMessage = { ...held('h-d', ago(HOUR)), doubt: true, ask: { requestId: 'q1', answers: { a: 'sim' }, by: 'user' } };
    const b = await board('fecha-duvida', [{ id: 't-a', status: 'review', sessionId: 'ana-work', held: [doubt] }]);
    await b.svc.update('p', 't-a', { status: 'done' }, true);
    expect((await b.get('t-a')).held ?? []).toEqual([]);
  });

  it('(b) a tarefa aberta de outro card da Ana mantém o ajuste dela (só a encerrada perde)', async () => {
    const b = await board('fecha-so-ela', [
      { id: 't-a', status: 'review', sessionId: 'ana-a', held: [held('h-a', ago(HOUR))] },
      { id: 't-b', status: 'review', sessionId: 'ana-b', held: [held('h-b', ago(HOUR))] },
    ]);
    b.working.add('ana-outra');
    await b.svc.update('p', 't-a', { status: 'done' }, true);
    expect((await b.get('t-a')).held ?? []).toEqual([]);
    expect((await b.get('t-b')).held?.map((m) => m.id)).toEqual(['h-b']);
  });

  it('guardar uma mensagem na conversa de tarefa pronta ou cancelada: não fica guardada, vai direto (a vez de ninguém)', async () => {
    const b = await board('hold-fechada', [
      { id: 't-done', status: 'done', sessionId: 'ana-done' },
      { id: 't-can', status: 'cancelled', sessionId: 'ana-can' },
      { id: 't-doing', status: 'doing', sessionId: 'ana-doing' },
    ]);
    expect(await b.svc.hold('ana-done', { text: 'pode apagar', byOwner: true })).toBeNull();
    expect(await b.svc.hold('ana-can', { text: 'pode apagar', byOwner: true })).toBeNull();
    expect((await b.get('t-done')).held ?? []).toEqual([]);
    expect((await b.get('t-can')).held ?? []).toEqual([]);
    // O controle: com a Ana fazendo a t-doing, a mensagem de uma tarefa ABERTA dela continua esperando a vez.
    await b.edit('t-done', (t) => ({ ...t, status: 'review' }));
    expect(await b.svc.hold('ana-done', { text: 'e o menu', byOwner: true })).toContain('espera Ana terminar');
    expect((await b.get('t-done')).held).toHaveLength(1);
  });
});

describe('veredito que chega depois do fechamento', () => {
  const REJECT = ['REPROVADO', '', '🔴 a.ts:1 quebra com lista vazia', '', '[BLOQUEADORES]', 'R1 | a.ts:1 | quebra com lista vazia | rodar tests/a.test.ts e ficar verde', '[/BLOQUEADORES]'].join('\n');

  /** A tarefa entregue e em revisão, com o Rui revisando (a conversa dele em `review`). */
  async function inReview(b: Board) {
    const t = (await b.svc.create('p', { title: 'Tela', description: 'Mostrar o card', acceptance: 'Sem erro no console', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
    await b.svc.start('p', t.id);
    const work = (await b.get(t.id)).sessionId!;
    b.said.set(work, 'Fiz a tela.');
    await b.svc.onTurnDone(work);
    const now = await b.get(t.id);
    expect(now.status).toBe('review');
    return { id: t.id, work, review: now.review!.sessionId! };
  }
  const answer = async (b: Board, review: string, text: string) => {
    b.said.set(review, text);
    await b.svc.onTurnDone(review);
  };

  it('(c) reprovação depois de pronta (a Ana ocupada): não gera reprovação, não guarda ajuste e não manda nada', async () => {
    const b = await board('veredito-pronta', []);
    const { id, review } = await inReview(b);
    b.working.add('ana-outra'); // aberta, a reprovação ficaria guardada esperando a Ana
    await b.svc.update('p', id, { status: 'done' }, true);
    await answer(b, review, REJECT);
    const t = await b.get(id);
    expect(t.status).toBe('done');
    expect(t.held ?? []).toEqual([]);
    expect(t.rejections ?? []).toEqual([]);
    expect(b.sentTo).toEqual([]);
    expect(notes(t).some((n) => /reprovada/.test(n ?? ''))).toBe(false);
  });

  it('(c) reprovação depois de cancelada: o mesmo', async () => {
    const b = await board('veredito-cancelada', []);
    const { id, review } = await inReview(b);
    b.working.add('ana-outra');
    await b.svc.cancel('p', id, { by: 'user', reason: 'não vale mais' });
    await answer(b, review, REJECT);
    const t = await b.get(id);
    expect(t.status).toBe('cancelled');
    expect(t.held ?? []).toEqual([]);
    expect(t.rejections ?? []).toEqual([]);
    expect(b.sentTo).toEqual([]);
  });

  it('(c) controle: com a tarefa ainda em revisão e a Ana ocupada, a mesma reprovação fica guardada (o teste enxerga o que deveria faltar)', async () => {
    const b = await board('veredito-controle', []);
    const { id, review } = await inReview(b);
    b.working.add('ana-outra');
    await answer(b, review, REJECT);
    const t = await b.get(id);
    expect(t.status).toBe('review');
    expect(t.held).toHaveLength(1);
    expect(t.rejections).toHaveLength(1);
  });

  it('(c) a tarefa fecha entre a conferência da reprovação e a gravação: nada é mandado à conversa da tarefa fechada', async () => {
    const b = await board('veredito-corrida', []);
    const { id, review } = await inReview(b);
    // Livre a Ana, a reprovação iria direto para a conversa dela: o dono finaliza no meio (a leitura da pausa é o que o `hold` faz depois da conferência).
    b.h.onPauseRead = () => b.svc.update('p', id, { status: 'done' }, true);
    await answer(b, review, REJECT);
    const t = await b.get(id);
    expect(t.status).toBe('done');
    expect(t.rejections ?? []).toEqual([]);
    expect(b.sentTo).toEqual([]);
  });

  it('(c) a tarefa fecha no meio com a Ana ocupada (a reprovação seria guardada): o ajuste some junto, sem sobra', async () => {
    const b = await board('veredito-corrida-ocupada', []);
    const { id, review } = await inReview(b);
    b.working.add('ana-outra');
    b.h.onPauseRead = () => b.svc.update('p', id, { status: 'done' }, true);
    await answer(b, review, REJECT);
    const t = await b.get(id);
    expect(t.status).toBe('done');
    expect(t.held ?? []).toEqual([]);
    expect(b.sentTo).toEqual([]);
  });

  it('(c) aprovação que fecha a tarefa com ajuste guardado: a tarefa fica pronta e o ajuste sai com nota', async () => {
    const b = await board('veredito-aprovada', []);
    const { id, review } = await inReview(b);
    await b.edit(id, (t) => ({ ...t, held: [held('h1', ago(HOUR))] }));
    await answer(b, review, 'APROVADO\n\nTudo certo.');
    const t = await b.get(id);
    expect(t.status).toBe('done');
    expect(t.held ?? []).toEqual([]);
    expect(notes(t)).toContain(NOTE_DONE);
  });
});

