import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESUME_TEXT } from '../server/chat/items';
import { blockedInboxItem, stuckInboxItem, taskQuestionInboxItem } from '../server/inboxItems';
import { ESCALATE_AFTER_MS, HELD_MAX_FAILS, PermanentError, RETRY_STEPS_MIN, failedRetry, isTransient, nextRetry, retryDue } from '../server/retryPolicy';
import { ownAlerts, readTasks, stuckDependencies, stuckReason, stuckState, TaskConflictError, TaskError, TaskForbiddenError, TaskService } from '../server/tasks';
import { UsageStopError } from '../server/usageStop';
import type { InboxItem, StaffProfile, Task, TaskQuestion } from '../shared/model';
import { removeTemp } from './support/tmp';

// Linha de produção sem gargalo (t-76d427, plano da t-5daa14): retry da dúvida ao gestor e da revisão automática, dúvida escalada na
// caixa e respondível pelo dono, ajuste guardado que não chega, aviso retido e a regra única de "parado" (`stuckState`).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-retry-'));
});
afterAll(() => removeTemp(root));

const MIN = 60_000;
/** Daqui a `min` minutos (o relógio do `tick`; o resto do código marca a hora real). */
const later = (min: number) => new Date(Date.now() + min * MIN);
const limit = () => new UsageStopError({ kind: 'five_hour', percentUsed: 91, limit: 85, resetsAt: null });

const people: Record<string, StaffProfile> = {
  'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'lu-1': { id: 'lu-1', name: 'Luana', role: 'Front-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'manual', worktree: false } as StaffProfile,
};

/** O que o serviço pede ao resto do Club, com ganchos para falhar e para contar. */
async function board(dirName: string, opts: { apiUrl?: string | null } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, '.myco', 'tasks.json');
  const h = {
    /** Toda tentativa de abrir conversa com o gestor ou o revisor (as que falharam também). */
    calls: [] as string[],
    sent: [] as Array<{ staffId: string; text: string; session: string }>,
    delivered: [] as Array<{ sessionId: string; text: string }>,
    sendToCalls: 0,
    notified: [] as Array<{ staffId: string; text: string }>,
    notifyCalls: 0,
    answeredAsks: [] as Array<{ sessionId: string; requestId: string; by: string | undefined }>,
    asks: new Set<string>(),
    texts: {} as Record<string, string>,
    working: new Set<string>(),
    /** O envio ao gestor e ao revisor falha com este erro. */
    failSend: null as null | (() => Error),
    failSendTo: null as null | (() => Error),
    failNotify: false,
    slow: false,
    pathFail: 0,
    afterSend: null as null | (() => void),
    awaitingLimit: null as null | (() => Promise<boolean>),
    n: 0,
  };
  const svc = new TaskService({
    projectPath: async () => {
      if (h.pathFail > 0) {
        h.pathFail--;
        throw new Error('disco ocupado');
      }
      return dir;
    },
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      if (staffId === 'gio-1' || staffId === 'rev-1') {
        h.calls.push(staffId);
        if (h.slow) await new Promise((r) => setTimeout(r, 25));
        if (h.failSend) throw h.failSend();
      }
      const session = `${staffId}-${++h.n}`;
      h.sent.push({ staffId, text, session });
      const after = h.afterSend;
      h.afterSend = null;
      after?.();
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, _s, except) => [...h.working].some((s) => s !== except),
    sendTo: async (_p, sessionId, _s, text) => {
      h.sendToCalls++;
      if (h.failSendTo) throw h.failSendTo();
      h.delivered.push({ sessionId, text });
      return sessionId;
    },
    notify: async (_p, staffId, text) => {
      h.notifyCalls++;
      if (h.failNotify) throw new Error('conversa do gestor não abriu');
      h.notified.push({ staffId, text });
    },
    lastText: (s) => h.texts[s] ?? null,
    hasAsk: (_s, id) => h.asks.has(id),
    answerAsk: (sessionId, requestId, _answers, by) => {
      if (!h.asks.has(requestId)) return false;
      h.asks.delete(requestId);
      h.answeredAsks.push({ sessionId, requestId, by });
      return true;
    },
    awaitingLimit: async () => (h.awaitingLimit ? h.awaitingLimit() : false),
    apiUrl: opts.apiUrl === null ? undefined : 'http://127.0.0.1:4848',
    sandboxApiUrl: opts.apiUrl === null ? undefined : 'http://127.0.0.2:4848',
  });
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Muda o arquivo das tarefas por fora (um fixture que o serviço não produz sozinho). */
  const edit = async (fn: (all: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    fn(all);
    await fs.writeFile(file, JSON.stringify(all));
  };
  const gio = () => h.calls.filter((c) => c === 'gio-1').length;
  return { ...h, h, svc, list, get, edit, gio, dir };
}
type Board = Awaited<ReturnType<typeof board>>;

/** Tarefa da Ana pedida pela Giovana (sem revisor), já começada. */
async function pedida(b: Board) {
  const t = (await b.svc.create('p', { title: 'Relatório', description: 'Exportar CSV', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
  await b.svc.start('p', t.id);
  return (await b.get(t.id)).id;
}

/** A Ana termina o turno com `DÚVIDA:` e a tarefa abre a dúvida escrita. */
async function doubt(b: Board, id: string, text = 'DÚVIDA: posso apagar a tabela antiga?') {
  const work = (await b.get(id)).sessionId!;
  b.h.texts[work] = text;
  await b.svc.onTurnDone(work);
  return work;
}

/** Tarefa da Ana com revisor `rev-1` marcado (sem gestor), entregue: a revisão automática começa (ou falha, se `failSend`). */
async function entregue(b: Board) {
  const t = (await b.svc.create('p', { title: 'Tela', staffId: 'ana-1', reviewerId: 'rev-1' }))!;
  await b.svc.start('p', t.id);
  const work = (await b.get(t.id)).sessionId!;
  await b.svc.onTurnDone(work);
  return { id: t.id, work };
}

const gestor = (t: Task) => ({ staffId: 'gio-1', sessionId: t.question!.managerSession ?? 'gio-s' });

describe('política de retry', () => {
  const base = new Date('2026-11-16T10:00:00Z');
  const minutes = (attempts: number, rand: number) => (Date.parse(nextRetry(attempts, base, () => rand)) - base.getTime()) / MIN;

  it('backoff em passos (1, 2, 4, 8, 15), o último repete, com jitter de 0,8 a 1,2', () => {
    expect(RETRY_STEPS_MIN).toEqual([1, 2, 4, 8, 15]);
    expect([1, 2, 3, 4, 5].map((n) => minutes(n, 0.5))).toEqual([1, 2, 4, 8, 15]);
    expect([6, 9, 40].map((n) => minutes(n, 0.5))).toEqual([15, 15, 15]);
    expect(minutes(3, 0)).toBeCloseTo(4 * 0.8);
    expect(minutes(3, 1)).toBeCloseTo(4 * 1.2);
    expect(minutes(0, 0.5)).toBe(1); // 0 conta como a primeira
  });

  it('failedRetry soma a tentativa, guarda a primeira e corta o erro; retryDue olha a hora marcada', () => {
    const one = failedRetry(undefined, new Error('x'.repeat(500)), base, () => 0.5);
    expect(one).toMatchObject({ attempts: 1, firstAt: base.toISOString() });
    expect(one.lastError).toHaveLength(200);
    const two = failedRetry(one, 'texto solto', new Date(base.getTime() + 5 * MIN), () => 0.5);
    expect(two).toMatchObject({ attempts: 2, firstAt: base.toISOString(), lastError: 'texto solto' });
    expect(retryDue(undefined, Date.now())).toBe(false);
    expect(retryDue({ nextAt: base.toISOString() }, base.getTime())).toBe(true);
    expect(retryDue({ nextAt: base.toISOString() }, base.getTime() - 1)).toBe(false);
  });

  it('transitório: limite de consumo e envio que falhou; permanente: só o que o chamador marca', () => {
    expect(isTransient(limit())).toBe(true);
    expect(isTransient(new Error('sem conversa'))).toBe(true);
    expect(isTransient(new PermanentError('ficha sumiu'))).toBe(false);
  });
});

describe('dúvida ao gestor: retry, escalada e resposta do dono', () => {
  it('1. limite ao enviar: tenta de novo com backoff e chega na 4ª; a contagem sobe uma vez só', async () => {
    const b = await board('r-limite');
    const id = await pedida(b);
    b.h.failSend = limit;
    await doubt(b, id);
    expect(b.gio()).toBe(1);
    expect(await b.get(id)).toMatchObject({ question: { status: 'open', pending: { attempts: 1 } } });
    expect((await b.get(id)).questionCount ?? 0).toBe(0);

    await b.svc.tick(new Date()); // antes da hora: não manda
    expect(b.gio()).toBe(1);
    await b.svc.tick(later(3));
    expect(b.gio()).toBe(2);
    await b.svc.tick(later(8));
    expect(b.gio()).toBe(3);
    expect((await b.get(id)).question!.pending).toMatchObject({ attempts: 3, lastError: expect.stringContaining('consumo') });

    b.h.failSend = null;
    await b.svc.tick(later(20));
    expect(b.gio()).toBe(4);
    const t = await b.get(id);
    expect(t.questionCount).toBe(1);
    expect(t.question).toMatchObject({ status: 'open', managerSession: expect.stringMatching(/^gio-1-/) });
    expect(t.question!.pending).toBeUndefined();
    expect(t.sessions?.filter((s) => s.role === 'question')).toHaveLength(1);
    await b.svc.tick(later(25)); // entregue: o tick não manda mais
    expect(b.gio()).toBe(4);
  });

  it('2. falha permanente (sem API, gestor fora da equipe, 3 dúvidas já levadas): escalada na hora, sem pending', async () => {
    const semApi = await board('r-sem-api', { apiUrl: null });
    const a = await pedida(semApi);
    await doubt(semApi, a);
    expect(await semApi.get(a)).toMatchObject({ question: { status: 'escalated', escalatedAt: expect.any(String) } });
    expect((await semApi.get(a)).question!.pending).toBeUndefined();
    expect(semApi.gio()).toBe(0);

    const permanente = await board('r-permanente');
    const p = await pedida(permanente);
    permanente.h.failSend = () => new PermanentError('o gestor não abre conversa');
    await doubt(permanente, p);
    expect(await permanente.get(p)).toMatchObject({ question: { status: 'escalated', escalatedAt: expect.any(String) } });
    expect((await permanente.get(p)).question!.pending).toBeUndefined();
    await permanente.svc.tick(later(3)); // escalada sem retry marcado: nada é mandado depois
    expect(permanente.gio()).toBe(1);

    const cheia = await board('r-tres');
    const c = await pedida(cheia);
    await cheia.edit((all) => void (all[0]!.questionCount = 3));
    await doubt(cheia, c);
    expect(await cheia.get(c)).toMatchObject({ question: { status: 'escalated' } });
    expect((await cheia.get(c)).question!.pending).toBeUndefined();
    expect(cheia.gio()).toBe(0);
  });

  it('3. 31 min sem chegar ao gestor: escalada com a hora, e o retry ao gestor continua; chegando, quem responder primeiro fecha', async () => {
    const b = await board('r-escalada');
    const id = await pedida(b);
    b.h.failSend = limit;
    await doubt(b, id);
    await b.svc.tick(later(31));
    const t = await b.get(id);
    expect(t.question).toMatchObject({ status: 'escalated', escalatedAt: expect.any(String), pending: { attempts: 2 } });
    expect(t.history.at(-1)?.note).toMatch(/dúvida sem resposta do gestor no prazo|não deu para levar/);
    expect(stuckState(t)).toMatchObject({ humanAction: 'answer', selfHeals: false });

    b.h.failSend = null;
    await b.svc.tick(later(60));
    const sent = await b.get(id);
    expect(sent.question).toMatchObject({ status: 'escalated', managerSession: expect.stringMatching(/^gio-1-/) });
    expect(sent.question!.pending).toBeUndefined();
    expect(sent.questionCount).toBe(1);
    // O gestor responde a dúvida que já estava com o dono: vale (quem responder primeiro fecha).
    const out = await b.svc.answerQuestion('p', id, gestor(sent), { questionId: sent.question!.id, text: 'Pode.' });
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'manager' });
  });

  it('4. o envio chega e a gravação seguinte falha: no máximo um envio a mais, uma contagem só, e a 2ª resposta ao mesmo q.id dá 409', async () => {
    const b = await board('r-reinicio');
    const id = await pedida(b);
    // A gravação logo depois do envio falha uma vez (o servidor caiu entre o envio e o registro).
    b.h.afterSend = () => {
      b.h.pathFail = 1;
    };
    await doubt(b, id);
    expect(b.gio()).toBe(1);
    const aberta = await b.get(id);
    expect(aberta.question).toMatchObject({ status: 'open', pending: { attempts: 1 } });
    expect(aberta.question!.managerSession).toBeUndefined();
    expect(aberta.questionCount ?? 0).toBe(0);

    await b.svc.tick(later(3));
    expect(b.gio()).toBe(2); // um a mais, e só
    const t = await b.get(id);
    expect(t.questionCount).toBe(1);
    expect(t.question).toMatchObject({ managerSession: expect.stringMatching(/^gio-1-/) });
    await b.svc.tick(later(10));
    expect(b.gio()).toBe(2);

    await b.svc.answerQuestion('p', id, gestor(t), { questionId: t.question!.id, text: 'Sim.' });
    await expect(b.svc.answerQuestion('p', id, gestor(t), { questionId: t.question!.id, text: 'Sim de novo.' })).rejects.toBeInstanceOf(TaskConflictError);
    expect(b.h.delivered).toHaveLength(1);
  });

  it('o servidor cai entre gravar a dúvida e mandar: open sem pending e sem gestor, o tick manda depois do tempo de conversa órfã', async () => {
    const b = await board('r-caiu');
    const id = await pedida(b);
    await doubt(b, id);
    await b.edit((all) => {
      const q = all[0]!.question;
      delete q.managerSession;
      all[0]!.questionCount = 0;
    });
    await b.svc.tick(later(1)); // cedo: pode ser o envio em andamento
    expect(b.gio()).toBe(1);
    await b.svc.tick(later(3));
    expect(b.gio()).toBe(2);
    expect((await b.get(id)).question!.managerSession).toBeTruthy();
  });

  it('5. dois tick() juntos com a dúvida vencida: um único envio', async () => {
    const b = await board('r-paralelo');
    const id = await pedida(b);
    b.h.failSend = limit;
    await doubt(b, id);
    b.h.failSend = null;
    b.h.slow = true;
    await Promise.all([b.svc.tick(later(3)), b.svc.tick(later(3))]);
    expect(b.gio()).toBe(2); // a falha de antes e um envio
    expect((await b.get(id)).questionCount).toBe(1);
  });

  it('uma dúvida por gestor por rodada do tick', async () => {
    const b = await board('r-um-por-gestor');
    const now = new Date().toISOString();
    const past = new Date(Date.now() - MIN).toISOString();
    const fixture = (id: string, staffId: string) => ({
      id, title: id, description: '', status: 'doing', staffId, sessionId: `${staffId}-work`, plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [],
      requestedBy: 'gio-1', requestedSession: 'gio-s',
      question: { id: `q-${id}`, source: 'text', text: 'DÚVIDA: a?', status: 'open', askedAt: now, pending: { attempts: 1, nextAt: past, firstAt: past } },
    });
    await fs.mkdir(path.join(b.dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(b.dir, '.myco', 'tasks.json'), JSON.stringify([fixture('t-a', 'ana-1'), fixture('t-b', 'lu-1')]));
    await b.svc.tick(new Date());
    expect(b.gio()).toBe(1);
    await b.svc.tick(new Date());
    expect(b.gio()).toBe(2);
    expect((await b.list()).every((t) => t.question!.managerSession)).toBe(true);
  });

  it('6. cancelar com a dúvida pendente: o tick não manda, e responder dá 409 "cancelada"', async () => {
    const b = await board('r-cancela');
    const id = await pedida(b);
    b.h.failSend = limit;
    await doubt(b, id);
    const q = (await b.get(id)).question!;
    await b.svc.cancel('p', id, { by: 'user' });
    b.h.failSend = null;
    await b.svc.tick(later(3));
    expect(b.gio()).toBe(1);
    const rej = b.svc.answerQuestion('p', id, { staffId: 'gio-1', sessionId: 'gio-s' }, { questionId: q.id, text: 'Sim.' });
    await expect(rej).rejects.toBeInstanceOf(TaskConflictError);
    await expect(rej).rejects.toThrow(/cancelada/);
    await expect(b.svc.answerQuestion('p', id, null, { questionId: q.id, text: 'Sim.' }, true)).rejects.toThrow(/cancelada/);
  });

  it('7. resposta tardia: o dono responde e depois o gestor (e o contrário); o funcionário recebe uma só', async () => {
    const donoPrimeiro = await board('r-tardia-dono');
    const a = await pedida(donoPrimeiro);
    await doubt(donoPrimeiro, a);
    const qa = (await donoPrimeiro.get(a)).question!;
    await donoPrimeiro.svc.answerQuestion('p', a, null, { questionId: qa.id, text: 'Postgres' }, true);
    await expect(donoPrimeiro.svc.answerQuestion('p', a, gestor(await donoPrimeiro.get(a)), { questionId: qa.id, text: 'MySQL' })).rejects.toThrow('o usuário já respondeu: Postgres');
    expect(donoPrimeiro.h.delivered).toEqual([{ sessionId: (await donoPrimeiro.get(a)).sessionId, text: 'Resposta do usuário à sua dúvida: Postgres' }]);

    const gestorPrimeiro = await board('r-tardia-gestor');
    const g = await pedida(gestorPrimeiro);
    await doubt(gestorPrimeiro, g);
    const qg = (await gestorPrimeiro.get(g)).question!;
    await gestorPrimeiro.svc.answerQuestion('p', g, gestor(await gestorPrimeiro.get(g)), { questionId: qg.id, text: 'MySQL' });
    await expect(gestorPrimeiro.svc.answerQuestion('p', g, null, { questionId: qg.id, text: 'Postgres' }, true)).rejects.toBeInstanceOf(TaskConflictError);
    await expect(gestorPrimeiro.svc.answerQuestion('p', g, null, { questionId: qg.id, text: 'Postgres' }, true)).rejects.toThrow('o gestor já respondeu: MySQL');
    expect(gestorPrimeiro.h.delivered).toHaveLength(1);

    const juntos = await board('r-tardia-paralelo');
    const j = await pedida(juntos);
    await doubt(juntos, j);
    const qj = (await juntos.get(j)).question!;
    const t = await juntos.get(j);
    const results = await Promise.allSettled([
      juntos.svc.answerQuestion('p', j, gestor(t), { questionId: qj.id, text: 'do gestor' }),
      juntos.svc.answerQuestion('p', j, null, { questionId: qj.id, text: 'do dono' }, true),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(TaskConflictError);
    expect(juntos.h.delivered).toHaveLength(1);
  });

  it('7b. pergunta por opções: o dono e o gestor juntos mandam uma resposta só à pergunta', async () => {
    const b = await board('r-tardia-ask');
    const id = await pedida(b);
    const work = (await b.get(id)).sessionId!;
    b.h.asks.add('req-1');
    await b.svc.onAsk(work, 'req-1', [{ question: 'Qual?', options: ['a', 'b'] }]);
    const t = await b.get(id);
    const body = { questionId: 'req-1', answers: { 'Qual?': 'a' } };
    const results = await Promise.allSettled([b.svc.answerQuestion('p', id, gestor(t), body), b.svc.answerQuestion('p', id, null, body, true)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(b.h.answeredAsks).toHaveLength(1);
  });

  it('10. autorização da resposta: gestor errado, outra conversa ou sem quem chama dão 403; só o navegador responde como dono (e não escala)', async () => {
    const b = await board('r-autoriza');
    const id = await pedida(b);
    await doubt(b, id);
    const t = await b.get(id);
    const body = { questionId: t.question!.id, text: 'Sim.' };
    await expect(b.svc.answerQuestion('p', id, null, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.answerQuestion('p', id, null, body, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.answerQuestion('p', id, { staffId: 'ana-1', sessionId: t.question!.managerSession! }, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(b.svc.answerQuestion('p', id, { staffId: 'gio-1', sessionId: 'outra' }, body)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(b.h.delivered).toEqual([]);
    // Como dono não há para quem escalar.
    await expect(b.svc.answerQuestion('p', id, null, { questionId: t.question!.id, escalate: true }, true)).rejects.toBeInstanceOf(TaskError);
    expect((await b.get(id)).question!.status).toBe('open');
    // O gestor escala: a dúvida vai para o dono, com a hora.
    const out = await b.svc.answerQuestion('p', id, gestor(t), { questionId: t.question!.id, escalate: true });
    expect(out?.question).toMatchObject({ status: 'escalated', escalatedAt: expect.any(String) });
  });

  it('10b. a rota só trata como dono o que vem do navegador pareado: `fromBrowser`, nunca o corpo do pedido', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const schema = /const TaskAnswerBody = z\.object\(\{([\s\S]*?)\n\}\);/.exec(src)![1]!;
    expect([...schema.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])).toEqual(['questionId', 'answers', 'text', 'escalate']);
    const route = /\/tasks\/\$\{ID\}\/answer\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('caller, fromBrowser }');
    expect(route).toContain('tasks.answerQuestion(id!, taskId!, who, b, fromBrowser)');
    expect(route).not.toMatch(/b\.(by|asUser|user)\b/);
  });

  it('11. navegador pareado responde a dúvida escrita e a de opções: vale como do dono, e answerAsk roda uma vez', async () => {
    const texto = await board('r-dono-texto');
    const a = await pedida(texto);
    const work = await doubt(texto, a);
    const qa = (await texto.get(a)).question!;
    const out = await texto.svc.answerQuestion('p', a, null, { questionId: qa.id, text: 'Pode apagar.' }, true);
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'user', answer: 'Pode apagar.' });
    expect(out?.history.at(-1)?.note).toBe('dúvida respondida por você');
    expect(texto.h.delivered).toEqual([{ sessionId: work, text: 'Resposta do usuário à sua dúvida: Pode apagar.' }]);

    const opcoes = await board('r-dono-ask', { apiUrl: null }); // sem API o gestor nem recebe: a dúvida já nasce com o dono
    const b = await pedida(opcoes);
    const workB = (await opcoes.get(b)).sessionId!;
    opcoes.h.asks.add('req-1');
    await opcoes.svc.onAsk(workB, 'req-1', [{ question: 'Qual banco?', options: ['Postgres', 'MySQL'] }]);
    expect((await opcoes.get(b)).question).toMatchObject({ status: 'escalated', source: 'ask' });
    const done = await opcoes.svc.answerQuestion('p', b, null, { questionId: 'req-1', answers: { 'Qual banco?': 'Postgres' } }, true);
    expect(opcoes.h.answeredAsks).toEqual([{ sessionId: workB, requestId: 'req-1', by: 'user' }]);
    expect(done?.question).toMatchObject({ status: 'answered', answeredBy: 'user', answer: 'Qual banco?: Postgres' });
    await expect(opcoes.svc.answerQuestion('p', b, null, { questionId: 'req-1', answers: { 'Qual banco?': 'MySQL' } }, true)).rejects.toBeInstanceOf(TaskConflictError);
    expect(opcoes.h.answeredAsks).toHaveLength(1);
  });

  it('a dúvida escalada vira item "question" da caixa, com o que o agente perguntou cortado; some quando alguém responde', async () => {
    const b = await board('r-caixa-duvida', { apiUrl: null });
    const id = await pedida(b);
    const work = (await b.get(id)).sessionId!;
    b.h.asks.add('req-1');
    const longo = 'x'.repeat(900);
    const perguntas = Array.from({ length: 12 }, (_, i) => ({ question: `${i}: ${longo}`, options: [longo, 'b'], multiSelect: i === 0 }));
    await b.svc.onAsk(work, 'req-1', perguntas);
    const alerts = ownAlerts(await b.list());
    expect(alerts).toHaveLength(1);
    const item = taskQuestionInboxItem(alerts[0]!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(item).toMatchObject({ kind: 'question', sessionId: '', staffId: 'ana-1', id: `doubt:${id}:req-1` });
    expect(item.question).toMatchObject({ taskId: id, taskTitle: 'Relatório', questionId: 'req-1', source: 'ask', escalatedAt: expect.any(String) });
    expect(item.question!.questions).toHaveLength(10);
    expect(item.question!.questions![0]).toMatchObject({ multiSelect: true });
    expect(item.question!.questions![0]!.question).toHaveLength(500);
    expect(item.question!.questions![0]!.options[0]).toHaveLength(500);
    expect(item.summary.length).toBeLessThan(220);
    expect(item.summary).toContain('“Relatório” tem uma dúvida esperando você');

    await b.svc.answerQuestion('p', id, null, { questionId: 'req-1', answers: { [perguntas[0]!.question]: longo } }, true);
    expect(ownAlerts(await b.list())).toEqual([]);

    const texto = await board('r-caixa-texto', { apiUrl: null });
    const t = await pedida(texto);
    await doubt(texto, t, `DÚVIDA: ${'y'.repeat(5000)}`);
    const it = taskQuestionInboxItem(ownAlerts(await texto.list())[0]!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(it.question).toMatchObject({ source: 'text' });
    expect(it.question!.text!.length).toBeLessThanOrEqual(2000);
  });
});

describe('revisão automática: retry e veredito', () => {
  it('13. a revisão que não começou por limite começa no retry; reviewRounds sobe uma vez só', async () => {
    const b = await board('r-rev-retry');
    b.h.failSend = limit;
    const { id } = await entregue(b);
    let t = await b.get(id);
    expect(t).toMatchObject({ status: 'review', reviewRetry: { attempts: 1, deliveryAt: t.delivery!.at } });
    expect(t.reviewRounds ?? 0).toBe(0);
    expect(t.history.filter((h) => h.note?.startsWith('revisão automática não começou')).length).toBe(1);

    await b.svc.tick(new Date()); // antes da hora
    expect(b.gio() + b.h.calls.filter((c) => c === 'rev-1').length).toBe(1);
    await b.svc.tick(later(3)); // ainda falha: conta, sem nota nova
    t = await b.get(id);
    expect(t.reviewRetry).toMatchObject({ attempts: 2 });
    expect(t.history.filter((h) => h.note?.startsWith('revisão automática não começou')).length).toBe(1);

    b.h.failSend = null;
    await b.svc.tick(later(10));
    t = await b.get(id);
    expect(t.reviewRetry).toBeUndefined();
    expect(t.reviewRounds).toBe(1);
    expect(t.review).toMatchObject({ staffId: 'rev-1', sessionId: expect.stringMatching(/^rev-1-/) });
    await b.svc.tick(later(20));
    expect((await b.get(id)).reviewRounds).toBe(1);
    expect(b.h.sent.filter((s) => s.staffId === 'rev-1')).toHaveLength(1);
  });

  it('13b. entrega trocada no meio: o retry para e perde a marca; a que saiu de revisão também', async () => {
    const b = await board('r-rev-troca');
    b.h.failSend = limit;
    const { id, work } = await entregue(b);
    b.h.failSend = null;
    await b.edit((all) => void (all[0]!.delivery.at = '2020-01-01T00:00:00.000Z')); // outra entrega
    // A marca era da entrega de antes: o tick a limpa e não pede revisão da nova (essa tem o seu próprio fluxo).
    await b.svc.tick(later(3));
    expect((await b.get(id)).reviewRetry).toBeUndefined();
    expect(b.h.sent.filter((s) => s.staffId === 'rev-1')).toHaveLength(0);

    const c = await board('r-rev-saiu');
    c.h.failSend = limit;
    const second = await entregue(c);
    expect((await c.get(second.id)).reviewRetry).toBeDefined();
    await c.svc.onSent(second.work); // você respondeu: volta para fazendo
    expect(await c.get(second.id)).toMatchObject({ status: 'doing' });
    expect((await c.get(second.id)).reviewRetry).toBeUndefined();
    expect(work).toBeTruthy();
  });

  it('13c. passados 30 min a tarefa é sua: nota uma vez, vira "parada" para você (review) com o motivo, e segue tentando devagar', async () => {
    const b = await board('r-rev-prazo');
    b.h.failSend = limit;
    const { id } = await entregue(b);
    await b.svc.tick(later(31));
    const calls = b.h.calls.length;
    await b.svc.tick(later(40));
    await b.svc.tick(later(60));
    const t = await b.get(id);
    expect(b.h.calls.length).toBeGreaterThan(calls); // vencido, mas o motivo pode passar: continua tentando
    expect(t.reviewRetry).toMatchObject({ expired: true });
    expect(t.history.filter((h) => h.note === 'revisão automática não começou em 30 min: a tarefa fica com você')).toHaveLength(1);
    expect(stuckState(t)).toMatchObject({ humanAction: 'review', selfHeals: false, reason: expect.stringMatching(/^a revisão automática não começou: ./) });
    const [alert] = ownAlerts([t]);
    const item = stuckInboxItem(alert!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(item).toMatchObject({ kind: 'stuck', stuck: { taskId: id, humanAction: 'review', selfHeals: false } });
  });

  it('13d. vencida, a revisão abre sozinha quando o motivo passa: sem o dono empurrar, e o aviso da caixa some', async () => {
    const b = await board('r-rev-volta');
    b.h.failSend = limit;
    const { id } = await entregue(b);
    await b.svc.tick(later(31));
    expect(stuckState(await b.get(id))).toMatchObject({ humanAction: 'review' });
    b.h.failSend = null; // o consumo baixou
    await b.svc.tick(later(60));
    const t = await b.get(id);
    expect(b.h.sent.filter((s) => s.staffId === 'rev-1')).toHaveLength(1);
    expect(t.review).toMatchObject({ staffId: 'rev-1' });
    expect(t.reviewRetry).toBeUndefined();
    expect(stuckState(t)).toBeNull();
  });

  it('8. revisão sem veredito: um único re-pedido depois do reaskAt; na 2ª vez vira parada (review) e aparece na caixa', async () => {
    const b = await board('r-sem-veredito');
    const { id } = await entregue(b);
    const review = (await b.get(id)).review!.sessionId;
    b.h.texts[review] = 'Preciso olhar com mais calma.';
    await b.svc.onTurnDone(review);
    let t = await b.get(id);
    expect(t.review).toMatchObject({ doneAt: expect.any(String), verdict: null, reaskAt: expect.any(String) });
    expect(Date.parse(t.review!.reaskAt!) - Date.now()).toBeGreaterThan(9 * MIN);
    expect(stuckState(t)).toBeNull();

    await b.svc.tick(later(5));
    expect(b.h.delivered).toEqual([]);
    await b.svc.tick(later(11));
    expect(b.h.delivered).toEqual([{ sessionId: review, text: expect.stringContaining('APROVADO ou REPROVADO') }]);
    t = await b.get(id);
    expect(t.review).toMatchObject({ reasked: true });
    await b.svc.tick(later(12));
    await b.svc.tick(later(25));
    expect(b.h.delivered).toHaveLength(1); // uma vez só

    // O revisor respondeu de novo sem veredito (a resposta é depois do re-pedido): a tarefa é sua.
    await b.edit((all) => void (all[0]!.review.doneAt = new Date(Date.parse(all[0]!.review.reaskAt) + 1000).toISOString()));
    t = await b.get(id);
    expect(stuckState(t, Date.now())).toMatchObject({ humanAction: 'review', selfHeals: false, reason: 'a revisão automática ficou sem veredito' });
    expect(ownAlerts([t]).map((a) => a.state.humanAction)).toEqual(['review']);
    expect(stuckDependencies([t, { ...t, id: 't-dep', blockedBy: [t.id], status: 'todo' }])[0]).toMatchObject({ humanAction: 'review', selfHeals: false });
  });

  it('9. revisor morto (sem resposta e parado): mesmo fluxo pelo tick; ocupado, não mexe', async () => {
    const ocupado = await board('r-rev-ocupado');
    const o = await entregue(ocupado);
    ocupado.h.working.add('rev-1-conversa');
    await ocupado.svc.tick(later(3));
    expect((await ocupado.get(o.id)).review!.reaskAt).toBeUndefined();

    const b = await board('r-rev-morto');
    const { id } = await entregue(b);
    const review = (await b.get(id)).review!.sessionId;
    await b.svc.tick(new Date()); // acabou de começar: ainda não é órfã
    expect((await b.get(id)).review!.reaskAt).toBeUndefined();
    await b.svc.tick(later(3));
    expect((await b.get(id)).review).toMatchObject({ reaskAt: expect.any(String) });
    expect((await b.get(id)).review!.reasked).toBeUndefined();
    await b.svc.tick(later(14));
    expect(b.h.delivered).toEqual([{ sessionId: review, text: expect.stringContaining('APROVADO ou REPROVADO') }]);
    await b.svc.tick(later(20));
    expect(b.h.delivered).toHaveLength(1);
    expect(stuckState(await b.get(id), Date.now() + 10 * MIN)).toBeNull(); // ainda dentro dos 30 min do re-pedido
    expect(stuckState(await b.get(id), Date.now() + 60 * MIN)).toMatchObject({ humanAction: 'review' });
  });

  it('re-pedido que falha no envio conta como o re-pedido: não repete a cada rodada', async () => {
    const b = await board('r-rev-reask-falha');
    const { id } = await entregue(b);
    await b.svc.tick(later(3));
    b.h.failSendTo = () => new Error('conversa não abre');
    await b.svc.tick(later(14));
    await b.svc.tick(later(15));
    expect(b.h.sendToCalls).toBe(1);
    const t = await b.get(id);
    expect(t.review).toMatchObject({ reasked: true });
    expect(t.history.at(-1)?.note).toContain('não deu para pedir o veredito de novo');
  });
});

describe('ajuste guardado que não chega', () => {
  async function comAjuste(dirName: string) {
    const b = await board(dirName);
    const now = new Date().toISOString();
    const base = { description: '', plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [] as unknown[] };
    await fs.mkdir(path.join(b.dir, '.myco'), { recursive: true });
    await fs.writeFile(
      path.join(b.dir, '.myco', 'tasks.json'),
      JSON.stringify([
        { ...base, id: 't-a', title: 'A', status: 'review', staffId: 'ana-1', sessionId: 'ana-work', held: [{ id: 'h1', at: now, text: 'corrija o botão', reason: 'espera a Ana' }] },
        { ...base, id: 't-b', title: 'B', status: 'todo', staffId: 'ana-1', sessionId: null, queuedAt: now },
      ]),
    );
    return b;
  }
  const heldOf = async (b: Board) => (await b.get('t-a')).held![0]!;
  const retomada = (b: Board) => b.edit((all) => void (all[0]!.held[0].nextAt = new Date(Date.now() - MIN).toISOString()));

  it('12. falha desde o 1º erro conta, a fila segue para a próxima, a nota não se repete e no 5º vira parada (resend)', async () => {
    const b = await comAjuste('r-held');
    b.h.failSendTo = limit;
    await b.svc.kickStaff('p', 'ana-1');
    expect(await heldOf(b)).toMatchObject({ attempts: 1, nextAt: expect.any(String) });
    expect((await b.get('t-b')).status).toBe('doing'); // a fila não esperou o ajuste
    expect(b.h.sendToCalls).toBe(1);

    await b.svc.kickStaff('p', 'ana-1'); // ainda não é a hora (e a Ana está com a B)
    expect(b.h.sendToCalls).toBe(1);

    await b.edit((all) => void (all[1]!.status = 'review'));
    for (const n of [2, 3, 4, 5]) {
      await retomada(b);
      await b.svc.kickStaff('p', 'ana-1');
      expect((await heldOf(b)).attempts).toBe(n);
    }
    const t = await b.get('t-a');
    expect(t.history.filter((h) => h.note?.startsWith('o ajuste guardado não foi'))).toHaveLength(1);
    expect(stuckState(t)).toMatchObject({ humanAction: 'resend', selfHeals: false, reason: 'ajuste guardado não chega ao funcionário' });
    expect(HELD_MAX_FAILS).toBe(5);
    expect(ownAlerts([t]).map((a) => a.state.humanAction)).toEqual(['resend']);

    await retomada(b);
    await b.svc.kickStaff('p', 'ana-1'); // parado: deixa de ir sozinho
    expect(b.h.sendToCalls).toBe(5);
  });

  it('resendHeld zera as falhas e manda já; a tarefa deixa de estar parada', async () => {
    const b = await comAjuste('r-held-reenviar');
    b.h.failSendTo = limit;
    await b.edit((all) => {
      all[0]!.held[0].attempts = 5;
      all[1]!.status = 'review';
    });
    expect(stuckState(await b.get('t-a'))?.humanAction).toBe('resend');
    b.h.failSendTo = null;
    const out = await b.svc.resendHeld('p', 't-a', true);
    expect(b.h.delivered).toEqual([{ sessionId: 'ana-work', text: 'corrija o botão' }]);
    expect(out?.held ?? []).toEqual([]);
    expect(stuckState(await b.get('t-a'))).toBeNull();
    // Já reenviado: nada mais retido (409).
    await expect(b.svc.resendHeld('p', 't-a', true)).rejects.toBeInstanceOf(TaskConflictError);
  });

  it('resendHeld sem o navegador pareado dá 403 e não mexe em nada (nem zera attempts, nem manda)', async () => {
    const b = await comAjuste('r-held-403');
    await b.edit((all) => {
      all[0]!.held[0].attempts = 5;
      all[1]!.status = 'review';
    });
    await expect(b.svc.resendHeld('p', 't-a', false)).rejects.toBeInstanceOf(TaskForbiddenError);
    // A recusa vem antes de qualquer leitura: nem a tarefa que não existe vaza como 404 para quem não é a tela.
    await expect(b.svc.resendHeld('p', 't-nao-existe', false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect((await heldOf(b)).attempts).toBe(5);
    expect(stuckState(await b.get('t-a'))?.humanAction).toBe('resend');
    expect(b.h.delivered).toEqual([]);
  });

  it('resendHeld: tarefa sem ajuste retido ou encerrada dá 409; tarefa que não existe, null (404)', async () => {
    const b = await comAjuste('r-held-409');
    await expect(b.svc.resendHeld('p', 't-b', true)).rejects.toBeInstanceOf(TaskConflictError); // sem `held`
    await expect(b.svc.resendHeld('p', 't-b', true)).rejects.toThrow('não há ajuste guardado');
    expect(await b.svc.resendHeld('p', 't-nao-existe', true)).toBeNull();
    await b.edit((all) => void (all[0]!.status = 'done'));
    await expect(b.svc.resendHeld('p', 't-a', true)).rejects.toThrow('encerrada');
    expect(await heldOf(b)).toMatchObject({ id: 'h1' }); // o ajuste segue guardado
    expect(b.h.delivered).toEqual([]);
  });

  it('resendHeld: a rota não lê o corpo, só `fromBrowser` autoriza, e o 403/409 saem no mapa de erros', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const route = /\/tasks\/\$\{ID\}\/resend-held\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(route).toContain('({ params: [id, taskId], fromBrowser })');
    expect(route).toContain('tasks.resendHeld(id!, taskId!, fromBrowser)');
    expect(route).not.toContain('body');
    expect(src).toMatch(/err instanceof TaskConflictError\) return send\(res, 409/);
    expect(src).toMatch(/err instanceof TaskForbiddenError\) return send\(res, 403/);
  });
});

describe('aviso a quem pediu: retenção e envio que falha', () => {
  /** A (pronta, aviso próprio) e X (outra do mesmo gestor, aberta). */
  async function duas(dirName: string, x: Record<string, unknown>) {
    const b = await board(dirName);
    const a = (await b.svc.create('p', { title: 'A', staffId: 'ana-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
    const other = (await b.svc.create('p', { title: 'X', staffId: 'lu-1', reviewerId: null }, 'gio-1', 'gio-s'))!;
    await b.edit((all) => {
      Object.assign(all.find((t) => t.id === a.id)!, { status: 'done' });
      Object.assign(all.find((t) => t.id === other.id)!, x);
    });
    const settle = async (own = 'AVISO-A') => (b.svc as unknown as { settleRequester: (...a: unknown[]) => Promise<void> }).settleRequester('p', await b.get(a.id), 'aprovada', own);
    return { b, a: a.id, x: other.id, settle };
  }
  const parada = { status: 'doing', sessionId: 'lu-work', question: { id: 'q', source: 'text', text: 'DÚVIDA: a?', status: 'escalated', askedAt: new Date().toISOString(), escalatedAt: new Date().toISOString() } };

  it('14. tarefa parada esperando você não segura o aviso; a saudável segura, e depois de 2 h o tick solta', async () => {
    const livre = await duas('r-aviso-parada', parada);
    await livre.settle();
    expect(livre.b.h.notified).toEqual([{ staffId: 'gio-1', text: expect.stringContaining('AVISO-A') }]);
    expect((await livre.b.get(livre.a)).outcomeHeld).toBeFalsy();

    // "Planejando" segura o aviso como "fazendo", e não é órfã (parada esperando o seu plano é normal).
    const presa = await duas('r-aviso-presa', { status: 'planning', sessionId: 'lu-work' });
    await presa.settle();
    expect(presa.b.h.notified).toEqual([]);
    const held = await presa.b.get(presa.a);
    expect(held).toMatchObject({ outcomeHeld: true, outcomeHeldAt: expect.any(String) });
    await presa.b.svc.tick(later(60)); // ainda dentro das 2 h
    expect(presa.b.h.notified).toEqual([]);
    await presa.b.svc.tick(later(121));
    expect(presa.b.h.notified).toHaveLength(1);
    expect(presa.b.h.notified[0]!.text).toContain(`Tarefa “A” (id ${presa.a})`);
    const after = await presa.b.get(presa.a);
    expect(after.outcomeHeld).toBeFalsy();
    expect(after.outcomeHeldAt).toBeUndefined();
  });

  it('14b. notify com erro mantém as marcas e o tick reenvia com backoff; ao dar certo, limpa', async () => {
    const { b, a, settle } = await duas('r-aviso-falha', parada);
    b.h.failNotify = true;
    await settle();
    let t = await b.get(a);
    expect(t).toMatchObject({ outcomeHeld: true, outcomePending: { attempts: 1, lastError: 'conversa do gestor não abriu' } });
    await b.svc.tick(new Date()); // antes da hora
    expect(b.h.notifyCalls).toBe(1);
    await b.svc.tick(later(3));
    expect(b.h.notifyCalls).toBe(2);
    t = await b.get(a);
    expect(t.outcomePending).toMatchObject({ attempts: 2 });
    b.h.failNotify = false;
    await b.svc.tick(later(10));
    expect(b.h.notified).toHaveLength(1);
    t = await b.get(a);
    expect(t.outcomeHeld).toBeFalsy();
    expect(t.outcomePending).toBeUndefined();
    await b.svc.tick(later(30));
    expect(b.h.notified).toHaveLength(1);
  });
});

describe('órfã e o limite de uso', () => {
  it('15. awaitingLimit que lança: 2 vezes a órfã espera, na 3ª retoma; o sucesso zera a conta', async () => {
    const b = await board('r-orfa');
    const id = await pedida(b);
    const work = (await b.get(id)).sessionId!;
    b.h.awaitingLimit = async () => {
      throw new Error('leitura falhou');
    };
    await b.svc.tick(later(3));
    await b.svc.tick(later(4));
    expect(b.h.delivered).toEqual([]);
    b.h.awaitingLimit = async () => false; // o sucesso zera
    await b.svc.tick(later(5));
    expect(b.h.delivered).toEqual([{ sessionId: work, text: RESUME_TEXT }]); // sem "continue" agendado: retoma como sempre
    expect((await b.get(id)).resumedAt).toBeTruthy();

    const c = await board('r-orfa-conta');
    const cid = await pedida(c);
    c.h.awaitingLimit = async () => {
      throw new Error('leitura falhou');
    };
    await c.svc.tick(later(3));
    await c.svc.tick(later(4));
    c.h.awaitingLimit = async () => true; // sucesso: há "continue" agendado, a órfã espera e a conta zera
    await c.svc.tick(later(5));
    c.h.awaitingLimit = async () => {
      throw new Error('leitura falhou');
    };
    await c.svc.tick(later(6));
    await c.svc.tick(later(7));
    expect(c.h.delivered).toEqual([]);
    await c.svc.tick(later(8));
    expect(c.h.delivered).toEqual([{ sessionId: (await c.get(cid)).sessionId, text: RESUME_TEXT }]);
  });
});

describe('regra única de "parado" (stuckState)', () => {
  const at = '2026-11-16T10:00:00.000Z';
  const now = Date.parse(at);
  const mk = (over: Partial<Task> = {}): Task => ({
    id: 't-1', title: 'Tarefa', description: '', status: 'doing', staffId: 'ana-1', sessionId: 's', plan: null, branch: null, pr: null, createdAt: at, updatedAt: at, history: [], ...over,
  });
  const ask = (over: Partial<TaskQuestion> = {}): TaskQuestion => ({ id: 'q', source: 'text', text: 'DÚVIDA: a?', status: 'open', askedAt: at, ...over });
  const retry = { attempts: 1, nextAt: at, firstAt: at };
  const review = (over: Partial<Task> = {}) => mk({ status: 'review', reviewerId: 'rev-1', review: { staffId: 'rev-1', sessionId: 'r', at }, ...over });

  it('a tabela do plano: dúvida escalada, a caminho, ajuste, revisão, Aguardar', () => {
    expect(stuckState(mk({ question: ask({ status: 'escalated', escalatedAt: '2026-11-16T10:05:00.000Z' }) }), now)).toEqual({
      reason: 'dúvida escalada: espera a sua resposta', selfHeals: false, humanAction: 'answer', since: '2026-11-16T10:05:00.000Z',
    });
    expect(stuckState(mk({ question: ask({ pending: retry }) }), now)).toMatchObject({ selfHeals: true, humanAction: null });
    expect(stuckState(mk({ question: ask({ pending: retry, managerSession: 'g' }) }), now)).toBeNull(); // chegou
    expect(stuckState(mk({ question: ask({ status: 'answered' }) }), now)).toBeNull();
    expect(stuckState(mk({ held: [{ id: 'h', at, text: 'x', reason: 'r', attempts: 4 }] }), now)).toBeNull();
    expect(stuckState(mk({ held: [{ id: 'h', at, text: 'x', reason: 'r', attempts: 5 }] }), now)).toMatchObject({ humanAction: 'resend', selfHeals: false, since: at });
    expect(stuckState(mk({ status: 'waiting', waitReason: 'Cliente' }), now)).toMatchObject({ reason: 'em Aguardar: Cliente', humanAction: 'decide', selfHeals: false });
    expect(stuckState(mk({ status: 'cancelled', cancelReason: 'sem verba' }), now)).toMatchObject({ reason: 'cancelada: sem verba', humanAction: null });
    expect(stuckState(mk({ status: 'done' }), now)).toBeNull();
  });

  it('reviewRetry: dentro do prazo não é parada; vencido (ou marcado) é', () => {
    const fresh = { ...retry, firstAt: '2026-11-16T09:50:00.000Z', deliveryAt: null };
    expect(stuckState(review({ reviewRetry: fresh }), now)).toBeNull();
    expect(stuckState(review({ reviewRetry: { ...fresh, firstAt: '2026-11-16T09:29:00.000Z' } }), now)).toMatchObject({ humanAction: 'review', selfHeals: false });
    expect(stuckState(review({ reviewRetry: { ...fresh, expired: true } }), now)).toMatchObject({ humanAction: 'review' });
  });

  it('revisão sem veredito: só depois do re-pedido, e só com o revisor marcado', () => {
    const r = { staffId: 'rev-1', sessionId: 'r', at, doneAt: at, verdict: null, reaskAt: at };
    expect(stuckState(review({ review: { ...r } }), now + 60 * MIN)).toBeNull(); // ainda não re-pediu
    expect(stuckState(review({ review: { ...r, reasked: true } }), now + 10 * MIN)).toBeNull(); // esperando a resposta ao re-pedido
    expect(stuckState(review({ review: { ...r, reasked: true } }), now + 30 * MIN)).toMatchObject({ humanAction: 'review' });
    expect(stuckState(review({ review: { ...r, reasked: true, doneAt: '2026-11-16T10:02:00.000Z' } }), now + MIN)).toMatchObject({ humanAction: 'review' });
    expect(stuckState(review({ review: { ...r, reasked: true, verdict: 'approved' } }), now + 60 * MIN)).toBeNull();
    expect(stuckState(review({ reviewerId: null, review: { ...r, reasked: true } }), now + 60 * MIN)).toBeNull();
  });

  it('os casos antigos seguem com o mesmo texto; limite e "sem responsável" são decisão sua (sem item próprio na caixa)', () => {
    const cap = review({ reviewRounds: 3, review: { staffId: 'rev-1', sessionId: 'r', at, doneAt: at, verdict: 'rejected' } });
    expect(stuckReason(cap)).toBe('limite de revisões automáticas atingido');
    expect(stuckState(cap, now)).toMatchObject({ humanAction: 'decide', selfHeals: false });
    expect(stuckReason(review({ staffId: null }))).toBe('sem responsável');
    expect(ownAlerts([cap, review({ staffId: null }), mk({ status: 'waiting' })], now)).toEqual([]);
    expect(stuckReason(mk())).toBeNull();
  });

  it('o dependente enxerga o que segura a bloqueadora: dúvida escalada vira "blocked" com a ação do dono', () => {
    const blocker = mk({ id: 't-b', title: 'Base', question: ask({ status: 'escalated', escalatedAt: at }) });
    const dep = mk({ id: 't-d', title: 'Tela', status: 'todo', sessionId: null, blockedBy: ['t-b'] });
    const [row] = stuckDependencies([blocker, dep], now);
    expect(row).toMatchObject({ reason: 'dúvida escalada: espera a sua resposta', selfHeals: false, humanAction: 'answer' });
    const item: InboxItem = blockedInboxItem(row!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(item.blocked).toMatchObject({ blockerId: 't-b', selfHeals: false, humanAction: 'answer' });
    // A que se recupera sozinha também aparece, dizendo isso.
    const retrying = mk({ id: 't-b', title: 'Base', question: ask({ pending: retry }) });
    expect(stuckDependencies([retrying, dep], now)[0]).toMatchObject({ selfHeals: true, humanAction: null });
  });

  it('o prazo de escalada é de 30 min', () => {
    expect(ESCALATE_AFTER_MS).toBe(30 * MIN);
  });
});

describe('ler o arquivo de tarefas de quem não tem os campos novos', () => {
  it('uma tarefa gravada antes desta versão segue sem parar nem mudar', async () => {
    const b = await board('r-legado');
    const t = (await b.svc.create('p', { title: 'Antiga', staffId: 'ana-1' }))!;
    const all = await readTasks(b.dir);
    expect(all).toHaveLength(1);
    expect(stuckState(all[0]!)).toBeNull();
    expect(await b.get(t.id)).toMatchObject({ status: 'todo' });
  });
});
