import { readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { ACK_CANCELLED_DAYS, AUTO_REVIEW_ROUNDS, isClosed, satisfiesDependency } from '../shared/model';
import { kanbanProgress } from '../shared/kanbanProgress';
import { resolveCaller, SessionTokens } from '../server/callers';
import { blockedInboxItem, notStartedInboxItem } from '../server/inboxItems';
import { blockers, cancelRequest, deleteRequest, NOT_STARTED_AFTER_DAYS, notStartedTasks, readTasks, stuckDependencies, stuckReason, TaskConflictError, TaskError, TaskForbiddenError, TaskService } from '../server/tasks';
import { readRuns } from '../server/taskRuns';

// Tarefa cancelada: fecha sem entrega, guarda o histórico e NÃO libera quem depende dela (só 'done' satisfaz dependência).

// A mescla de verdade precisa de um repositório git: aqui `locateCode` e `mergeCode` podem ser trocados por um teste (ver `merging`).
const merging = vi.hoisted(() => ({
  place: null as null | { where: 'worktree'; path: string; branch: string },
  merge: null as null | (() => Promise<{ sha: string; base: string; branch: string; tests: null }>),
}));
vi.mock('../server/taskCode', async (original) => {
  const actual = await original<typeof import('../server/taskCode')>();
  return {
    ...actual,
    locateCode: ((...args: Parameters<typeof actual.locateCode>) => (merging.place ? Promise.resolve(merging.place) : actual.locateCode(...args))) as typeof actual.locateCode,
    mergeCode: ((...args: Parameters<typeof actual.mergeCode>) => (merging.merge ? merging.merge() : actual.mergeCode(...args))) as typeof actual.mergeCode,
  };
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cancel-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const person = (id: string, name: string, extra: Partial<StaffProfile> = {}) => ({ id, name, autonomy: 'acceptEdits', worktree: false, servers: [], ...extra }) as unknown as StaffProfile;

/** Ana faz as tarefas, Rui revisa, Gio é o gestor que pede. Cada conversa pertence a um funcionário (`working`: sessão → funcionário). */
function board(dirName: string, opts: { ana?: Partial<StaffProfile> } = {}) {
  const dir = path.join(root, dirName);
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = { 'ana-1': person('ana-1', 'Ana', opts.ana), 'rev-1': person('rev-1', 'Rui'), 'gio-1': person('gio-1', 'Gio') };
  const sent: Array<{ staffId: string; text: string; session: string }> = [];
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const notified: Array<{ staffId: string; text: string }> = [];
  const texts = new Map<string, string>();
  const working = new Map<string, string>();
  /** Ordem do que o cancelamento fez com a conversa, e o status da tarefa (lido do disco) no instante em que ele interrompeu o turno. */
  const calls: string[] = [];
  const statusAtInterrupt: string[] = [];
  /** Cartões (plano, permissão) que o cancelamento negou na conversa, e ganchos para o teste mexer no meio de uma operação. */
  const dismissed: Array<{ sessionId: string; message: string }> = [];
  const hooks: { beforeSend?: (staffId: string, text: string) => Promise<void>; onInterrupt?: (sessionId: string) => void } = {};
  /** Perguntas por opções (AskUserQuestion) abertas nas conversas (`sessão:requestId`) e as respostas que chegaram a elas. */
  const openAsks = new Set<string>();
  const askAnswers: Array<{ sessionId: string; requestId: string }> = [];
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId, text) => {
      await hooks.beforeSend?.(staffId, text);
      const session = `s-${++n}`;
      sent.push({ staffId, text, session });
      working.set(session, staffId);
      return session;
    },
    sendTo: async (_p, sessionId, staffId, text) => {
      delivered.push({ sessionId, text });
      working.set(sessionId, staffId);
      return sessionId;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => [...working].some(([s, who]) => who === staffId && s !== except),
    lastText: (sessionId) => texts.get(sessionId) ?? null,
    notify: async (_p, staffId, text) => {
      notified.push({ staffId, text });
    },
    interruptSession: (sessionId) => {
      calls.push(`interrupt:${sessionId}`);
      const all = JSON.parse(readFileSync(file, 'utf8')) as Task[];
      statusAtInterrupt.push(all.find((t) => t.sessionId === sessionId)?.status ?? '?');
      hooks.onInterrupt?.(sessionId);
    },
    dismissPending: (sessionId, message) => {
      dismissed.push({ sessionId, message });
    },
    hasAsk: (sessionId, requestId) => openAsks.has(`${sessionId}:${requestId}`),
    answerAsk: (sessionId, requestId) => {
      askAnswers.push({ sessionId, requestId });
      return openAsks.delete(`${sessionId}:${requestId}`);
    },
    settleLimit: async (sessionId) => {
      calls.push(`settle:${sessionId}`);
    },
    cancelContinue: async (sessionId) => {
      calls.push(`continue:${sessionId}`);
      return null;
    },
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
  });
  /** O turno acabou: o processo avisa (onIdle) e o vigia também (onTurnDone). */
  const finish = async (session: string) => {
    const who = working.get(session) ?? 'ana-1';
    working.delete(session);
    await svc.onIdle(session, 'p', who);
    await svc.onTurnDone(session);
  };
  const make = async (title: string, o: { blockedBy?: string[]; by?: string; reviewerId?: string | null } = {}) =>
    (await svc.create('p', { title, staffId: 'ana-1', ...(o.blockedBy && { blockedBy: o.blockedBy }), ...(o.reviewerId !== undefined && { reviewerId: o.reviewerId }) }, o.by ?? null))!;
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const settle = () => new Promise((r) => setTimeout(r, 25));
  /** Muda o arquivo das tarefas à mão (estado que o fluxo normal não produz, ou que veio de outra versão). */
  const edit = (fn: (tasks: Array<Record<string, any>>) => void) => {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, any>>;
    fn(raw);
    writeFileSync(file, JSON.stringify(raw, null, 2));
  };
  return { svc, dir, file, sent, delivered, notified, texts, working, calls, statusAtInterrupt, dismissed, hooks, openAsks, askAnswers, finish, make, list, get, settle, edit };
}

describe('cancelar: tarefa em andamento', () => {
  it('grava "cancelada" ANTES de interromper; o fim do turno depois não entrega, não revisa e não avisa entrega', async () => {
    const b = board('c-doing');
    const t = await b.make('Exportar CSV', { by: 'gio-1' }); // pedida pelo gestor, que também revisa
    await b.svc.start('p', t.id); // s-1, fazendo
    expect((await b.get(t.id)).runId).toBeTruthy();

    const out = (await b.svc.cancel('p', t.id, { by: 'user', reason: 'o cliente desistiu' }))!;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'user', cancelReason: 'o cliente desistiu', sessionId: 's-1', runId: null, queuedAt: null });
    expect(out.cancelledAt).toBeTruthy();
    // Ordem: status gravado -> turno interrompido -> limite assentado -> "continue" e despertador tirados.
    expect(b.statusAtInterrupt).toEqual(['cancelled']);
    expect(b.calls).toEqual(['interrupt:s-1', 'settle:s-1', 'continue:s-1']);

    // O turno interrompido termina depois (processo e vigia): nada de revisão, entrega ou nova conversa.
    b.texts.set('s-1', 'fiz metade');
    await b.finish('s-1');
    const after = await b.get(t.id);
    expect(after.status).toBe('cancelled');
    expect(after.delivery).toBeUndefined();
    expect(after.review).toBeUndefined();
    expect(after.history.map((h) => h.status)).toEqual(['todo', 'doing', 'cancelled']);
    expect(after.history.at(-1)).toMatchObject({ status: 'cancelled', by: 'you', note: 'cancelada: o cliente desistiu' });
    expect(b.sent).toHaveLength(1); // nenhuma conversa de revisão
    // A tentativa fecha como cancelada (e não como entregue).
    const runs = await readRuns(b.dir, t.id);
    expect(runs.map((r) => (r.ev === 'end' ? r.outcome : r.ev))).toEqual(['start', 'cancelled']);
    // Quem pediu fica sabendo do cancelamento, e não de uma entrega.
    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]).toMatchObject({ staffId: 'gio-1', text: expect.stringContaining('foi cancelada pelo usuário: o cliente desistiu') });
    expect(b.notified[0]!.text).not.toContain('entregou');
  });

  it('a rede de segurança (órfã) e o vigia não retomam nem mandam para revisão a conversa de uma cancelada', async () => {
    const b = board('c-orfa');
    const t = await b.make('Relatório');
    await b.svc.start('p', t.id); // s-1
    await b.svc.cancel('p', t.id, { by: 'user' });
    b.working.delete('s-1'); // a conversa parou
    await b.svc.tick(new Date(Date.now() + 10 * 60_000));
    await b.svc.tick(new Date(Date.now() + 20 * 60_000));
    expect(b.delivered).toHaveLength(0); // nenhuma retomada ("continue")
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled' });
    expect((await b.get(t.id)).history.map((h) => h.status)).toEqual(['todo', 'doing', 'cancelled']);
  });

  it('cancelar a que está fazendo anda a fila: a próxima começa; a cancelada que estava na fila não é pega', async () => {
    const b = board('c-fila');
    const t1 = await b.make('Primeira');
    const t2 = await b.make('Segunda');
    const t3 = await b.make('Terceira');
    await b.svc.start('p', t1.id); // s-1
    await b.svc.start('p', t2.id); // na fila
    await b.svc.start('p', t3.id); // na fila
    expect(await b.get(t2.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });
    await b.svc.cancel('p', t2.id, { by: 'user' });
    expect(await b.get(t2.id)).toMatchObject({ status: 'cancelled', queuedAt: null });
    await b.svc.cancel('p', t1.id, { by: 'user' });
    await b.finish('s-1'); // o turno interrompido acaba: Ana fica livre
    await vi.waitFor(async () => expect(await b.get(t3.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String) }));
    expect(b.sent.map((s) => s.text.split('\n')[0])).toEqual(['[Tarefa "Primeira"]', '[Tarefa "Terceira"]']);
    expect(await b.get(t2.id)).toMatchObject({ status: 'cancelled', sessionId: null });
  });

  it('sem conversa (a fazer, Aguardar): não interrompe nada; já pronta ou já cancelada, 409; tarefa que não existe, null', async () => {
    const b = board('c-sem-conversa');
    const a = await b.make('A');
    const w = (await b.svc.create('p', { title: 'W', staffId: 'ana-1', start: false }))!; // Aguardar
    await b.svc.update('p', w.id, { waitReason: 'espera o cliente' });
    expect(await b.svc.cancel('p', a.id, { by: 'user' })).toMatchObject({ status: 'cancelled', cancelReason: null });
    expect(await b.svc.cancel('p', w.id, { by: 'user', reason: '  vários\n   espaços  ' })).toMatchObject({ status: 'cancelled', cancelReason: 'vários espaços', waitReason: null });
    expect(b.calls).toEqual([]);
    await expect(b.svc.cancel('p', a.id, { by: 'user' })).rejects.toThrow(TaskConflictError);
    const d = await b.make('D');
    await b.svc.update('p', d.id, { status: 'done' });
    await expect(b.svc.cancel('p', d.id, { by: 'user' })).rejects.toThrow(/já está pronta/);
    expect(await b.svc.cancel('p', 't-nao-existe', { by: 'user' })).toBeNull();
    expect((await b.get(d.id)).status).toBe('done');
  });

  it('o motivo passa de 300 caracteres: corta', async () => {
    const b = board('c-motivo');
    const t = await b.make('A');
    const out = (await b.svc.cancel('p', t.id, { by: 'user', reason: 'x'.repeat(500) }))!;
    expect(out.cancelReason).toHaveLength(300);
  });
});

describe('cancelada bloqueia: dependentes', () => {
  async function pair(name: string, reason?: string) {
    const b = board(name);
    const base = await b.make('Base');
    const x = await b.make('Tela', { blockedBy: [base.id], by: 'gio-1' });
    await b.svc.start('p', x.id); // na fila, bloqueada
    await b.svc.cancel('p', base.id, { by: 'user', ...(reason && { reason }) });
    return { b, base, x };
  }

  it('cancelada continua bloqueando (a fila e o tick não começam a dependente); só pronta satisfaz', async () => {
    const { b, base, x } = await pair('d-bloqueia', 'mudou o escopo');
    const tasks = await b.list();
    expect(blockers(tasks.find((t) => t.id === x.id)!, tasks)).toEqual([base.id]);
    await b.svc.tick();
    await b.svc.kickStaff('p', 'ana-1');
    await b.settle();
    expect(b.sent).toHaveLength(0);
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', sessionId: null, queuedAt: expect.any(String) });
    expect(satisfiesDependency({ status: 'cancelled' })).toBe(false);
    expect(satisfiesDependency({ status: 'done' })).toBe(true);
    expect(isClosed({ status: 'cancelled' })).toBe(true);
    expect(isClosed({ status: 'done' })).toBe(true);
    expect(isClosed({ status: 'review' })).toBe(false);
  });

  it('aparece em stuckDependencies com o motivo ("cancelada" e "cancelada: motivo") e vira item "blocked" da caixa; o gestor da dependente é avisado', async () => {
    const { b, base, x } = await pair('d-caixa', 'mudou o escopo');
    const stuck = stuckDependencies(await b.list());
    expect(stuck.map((s) => [s.task.title, s.blocker.title, s.reason])).toEqual([['Tela', 'Base', 'cancelada: mudou o escopo']]);
    const item = blockedInboxItem(stuck[0]!, { projectId: 'p', projectName: 'P', sessionId: '', staffId: 'ana-1', name: 'Ana' });
    expect(item).toMatchObject({
      kind: 'blocked',
      id: `blocked:${x.id}:${base.id}`,
      blocked: { taskId: x.id, blockerId: base.id, blockerStatus: 'cancelled', reason: 'cancelada: mudou o escopo' },
    });
    await vi.waitFor(() => expect(b.notified.filter((n) => n.staffId === 'gio-1')).toHaveLength(1));
    expect(b.notified[0]!.text).toContain('parou: cancelada: mudou o escopo');
    // Sem motivo: só "cancelada".
    const sem = await b.make('Sem motivo');
    await b.svc.cancel('p', sem.id, { by: 'user' });
    expect(stuckReason(await b.get(sem.id))).toBe('cancelada');
  });

  it('liberar: tira a cancelada do blockedBy da dependente e, na fila e livre, ela começa pelo fluxo normal', async () => {
    const { b, base, x } = await pair('d-liberar');
    const out = (await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'release'))!;
    expect(out.blockedBy).toBeUndefined();
    expect(out.history.at(-1)?.note).toBe('liberada da espera por “Base” (cancelada)');
    await vi.waitFor(async () => expect(await b.get(x.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null }));
    expect(b.sent.at(-1)!.text).toContain('[Tarefa "Tela"]');
    expect(stuckDependencies(await b.list())).toEqual([]);
  });

  it('liberar com outra espera ainda aberta: tira só a cancelada e a dependente segue bloqueada', async () => {
    const b = board('d-liberar-outra');
    const a = await b.make('A');
    const c = await b.make('C');
    const x = await b.make('X', { blockedBy: [a.id, c.id] });
    await b.svc.start('p', x.id);
    await b.svc.cancel('p', a.id, { by: 'user' });
    const out = (await b.svc.resolveCancelledBlocker('p', x.id, a.id, 'release'))!;
    expect(out.blockedBy).toEqual([c.id]);
    await b.settle();
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect(b.sent).toHaveLength(0);
  });

  it('cancelar junto: a dependente é cancelada com o motivo "a tarefa X foi cancelada" e sai da caixa', async () => {
    const { b, base, x } = await pair('d-junto');
    const out = (await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'cancel'))!;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'user', cancelReason: 'a tarefa “Base” foi cancelada', queuedAt: null });
    expect(stuckDependencies(await b.list())).toEqual([]); // dependente encerrada não espera ninguém
    expect(b.sent).toHaveLength(0);
  });

  it('continuar esperando: o par some da caixa até a bloqueadora ser reaberta; reabrir limpa a marca, e cancelar de novo traz o item de volta', async () => {
    const { b, base, x } = await pair('d-esperar');
    const out = (await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'wait'))!;
    expect(out.ackCancelled).toEqual([{ id: base.id, at: expect.any(String) }]);
    expect(out.blockedBy).toEqual([base.id]); // continua bloqueada
    expect(stuckDependencies(await b.list())).toEqual([]);
    await b.settle();
    expect(b.sent).toHaveLength(0);
    // Repetir não duplica.
    expect((await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'wait'))!.ackCancelled).toEqual([{ id: base.id, at: expect.any(String) }]);
    await b.svc.reopen('p', base.id);
    expect((await b.get(x.id)).ackCancelled).toBeUndefined();
    await b.svc.cancel('p', base.id, { by: 'user', reason: 'de novo' });
    expect(stuckDependencies(await b.list()).map((s) => s.reason)).toEqual(['cancelada: de novo']);
  });

  it('continuar esperando vale ACK_CANCELLED_DAYS (7) dias: depois o par volta à caixa; repetir renova o prazo, com uma entrada só', async () => {
    expect(ACK_CANCELLED_DAYS).toBe(7);
    const { b, base, x } = await pair('d-esperar-prazo');
    const week = ACK_CANCELLED_DAYS * 24 * 60 * 60 * 1000;
    const out = (await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'wait'))!;
    const at = Date.parse(out.ackCancelled![0]!.at);
    expect(Math.abs(at - Date.now())).toBeLessThan(5000);
    const all = await b.list();
    expect(stuckDependencies(all, at + week - 1000)).toEqual([]); // ainda escondido
    expect(stuckDependencies(all, at + 1000)).toEqual([]);
    expect(stuckDependencies(all, at + week + 1000).map((s) => [s.task.title, s.blocker.title])).toEqual([['Tela', 'Base']]); // vencido: volta
    // Uma marca com data ilegível não esconde nada (o item aparece em vez de sumir para sempre).
    b.edit((tasks) => {
      tasks.find((t) => t.id === x.id)!.ackCancelled = [{ id: base.id, at: 'ontem' }];
    });
    expect(stuckDependencies(await b.list())).toHaveLength(1);
    // Continuar esperando de novo (a pessoa viu o item voltar): troca a entrada, não acumula.
    b.edit((tasks) => {
      tasks.find((t) => t.id === x.id)!.ackCancelled = [{ id: base.id, at: new Date(Date.now() - week - 60_000).toISOString() }];
    });
    expect(stuckDependencies(await b.list())).toHaveLength(1);
    const again = (await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'wait'))!;
    expect(again.ackCancelled).toHaveLength(1);
    expect(Date.parse(again.ackCancelled![0]!.at)).toBeGreaterThan(Date.now() - 5000);
    expect(stuckDependencies(await b.list())).toEqual([]);
  });

  it('as ações recusam o que já mudou (409): bloqueadora não cancelada, dependente que não espera mais ou encerrada', async () => {
    const { b, base, x } = await pair('d-recusa');
    const live = await b.make('Viva');
    await expect(b.svc.resolveCancelledBlocker('p', x.id, live.id, 'release')).rejects.toThrow(TaskConflictError);
    await expect(b.svc.resolveCancelledBlocker('p', live.id, base.id, 'wait')).rejects.toThrow(TaskConflictError);
    await b.svc.resolveCancelledBlocker('p', x.id, base.id, 'release');
    await expect(b.svc.resolveCancelledBlocker('p', x.id, base.id, 'release')).rejects.toThrow(TaskConflictError);
    expect(await b.svc.resolveCancelledBlocker('p', 't-nao-existe', base.id, 'wait')).toBeNull();
  });

  it('apagar: dependente cancelada não barra; dependente aberta ainda barra (e a cancelada continua bloqueando até o dono decidir)', async () => {
    const b = board('d-apagar');
    const a = await b.make('Base');
    const c = await b.make('Cancelada que dependia', { blockedBy: [a.id] });
    const o = await b.make('Aberta que depende', { blockedBy: [a.id] });
    await b.svc.cancel('p', c.id, { by: 'user' });
    await expect(b.svc.remove('p', a.id)).rejects.toThrow(/“Aberta que depende”/);
    expect((await b.svc.cancel('p', o.id, { by: 'user' }))!.status).toBe('cancelled');
    expect(await b.svc.remove('p', a.id)).toBe(true);
    expect((await b.list()).map((t) => [t.title, t.blockedBy])).toEqual([
      ['Cancelada que dependia', []],
      ['Aberta que depende', []],
    ]);
  });
});

describe('cancelada: veredito tardio, reabrir e travas', () => {
  it('revisão pedida antes de cancelar: o APROVADO que chega depois é ignorado (não vira pronto, não libera dependente)', async () => {
    const b = board('v-aprovado');
    const t = await b.make('Parecer', { reviewerId: 'rev-1' });
    const dep = await b.make('Anexo', { blockedBy: [t.id] });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // entregou: o Rui revisa (s-2)
    expect(await b.get(t.id)).toMatchObject({ status: 'review', review: { sessionId: 's-2' } });
    await b.svc.cancel('p', t.id, { by: 'user' });
    b.texts.set('s-2', 'APROVADO\n\ntudo certo');
    await b.finish('s-2');
    const after = await b.get(t.id);
    expect(after.status).toBe('cancelled');
    expect(after.history.map((h) => h.status)).not.toContain('done');
    const all = await b.list();
    expect(blockers(all.find((x) => x.id === dep.id)!, all)).toEqual([t.id]);
  });

  it('o REPROVADO que chega depois também é ignorado: nenhum ajuste vai para a conversa da cancelada', async () => {
    const b = board('v-reprovado');
    const t = await b.make('Parecer', { reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // revisão em s-2
    await b.svc.cancel('p', t.id, { by: 'user' });
    b.texts.set('s-2', 'REPROVADO\n\n🔴 falta teste');
    await b.finish('s-2');
    expect(b.delivered).toHaveLength(0);
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled' });
  });

  it('dúvida aberta ao gestor fecha ao cancelar, e a resposta que vier depois leva 409', async () => {
    const b = board('v-duvida');
    const t = await b.make('Dúvida', { by: 'gio-1' });
    await b.svc.start('p', t.id);
    await b.svc.update('p', t.id, { title: 'Dúvida' });
    // Dúvida aberta gravada à mão (o fluxo completo é testado em tasks.test.ts).
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    raw[0]!.question = { id: 'q-1', source: 'text', text: 'DÚVIDA: x?', status: 'open', askedAt: new Date().toISOString(), managerSession: 's-gio' };
    await fs.writeFile(file, JSON.stringify(raw));
    const out = (await b.svc.cancel('p', t.id, { by: 'user' }))!;
    expect(out.question).toMatchObject({ status: 'answered', answeredBy: 'user', answer: 'tarefa cancelada' });
    await expect(b.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: 's-gio' }, { questionId: 'q-1', text: 'sim' })).rejects.toThrow(TaskConflictError);
  });

  it('reabrir: volta para "a fazer" sem começar sozinha, sem os campos do cancelamento e sem a conversa antiga; o Começar abre uma nova', async () => {
    const b = board('r-reabrir');
    const t = await b.make('Exportar');
    await b.svc.start('p', t.id); // s-1
    await b.svc.cancel('p', t.id, { by: 'user', reason: 'engano' });
    const out = (await b.svc.reopen('p', t.id))!;
    expect(out).toMatchObject({ status: 'todo', sessionId: null, runId: null, queuedAt: null });
    expect(out.cancelledAt).toBeUndefined();
    expect(out.cancelReason).toBeUndefined();
    expect(out.cancelledBy).toBeUndefined();
    expect(out.history.map((h) => h.status)).toEqual(['todo', 'doing', 'cancelled', 'todo']);
    expect(out.history.at(-1)).toMatchObject({ by: 'you', note: 'reaberta' });
    expect(out.sessions?.map((s) => s.id)).toEqual(['s-1']); // a conversa antiga continua na lista da tarefa
    // O fim do turno da conversa antiga não mexe na tarefa, e nada começa sozinho.
    await b.finish('s-1');
    await b.svc.tick();
    await b.settle();
    expect(b.sent).toHaveLength(1);
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect((await b.svc.start('p', t.id))!).toMatchObject({ status: 'doing', sessionId: 's-2' });
    await expect(b.svc.reopen('p', t.id)).rejects.toThrow(/só tarefa cancelada/);
    expect(await b.svc.reopen('p', 't-nao-existe')).toBeNull();
  });

  it('cancelada não anda por outro caminho: coluna, começar, mesclar e pedir revisão são recusados (409); campos comuns ainda editam', async () => {
    const b = board('t-travas');
    const t = await b.make('Parada');
    await b.svc.cancel('p', t.id, { by: 'user' });
    await expect(b.svc.update('p', t.id, { status: 'done' })).rejects.toThrow(TaskConflictError);
    await expect(b.svc.update('p', t.id, { status: 'todo' })).rejects.toThrow(/reabra/);
    await expect(b.svc.start('p', t.id)).rejects.toThrow(TaskConflictError);
    await expect(b.svc.merge('p', t.id)).rejects.toThrow(TaskConflictError);
    await expect(b.svc.requestReview('p', t.id, 'rev-1')).rejects.toThrow(TaskConflictError);
    await expect(b.svc.requestDeploy('p', t.id, 'rev-1')).rejects.toThrow(TaskConflictError);
    expect(b.sent).toHaveLength(0);
    // Cancelar pela mudança de coluna não existe: é a ação própria.
    const live = await b.make('Viva');
    await expect(b.svc.update('p', live.id, { status: 'cancelled' })).rejects.toThrow(TaskError);
    expect((await b.svc.update('p', t.id, { title: 'Parada (renomeada)' }))!).toMatchObject({ status: 'cancelled', title: 'Parada (renomeada)' });
    expect((await b.get(live.id)).status).toBe('todo');
  });

  it('não conta como aberta nem como entregue: resumo, barra de progresso e rotina', async () => {
    const b = board('t-contagem');
    const a = await b.make('Cancelada');
    await b.svc.cancel('p', a.id, { by: 'user' });
    expect(await b.svc.summary()).toEqual({}); // só cancelada: nada em aberto
    const open = await b.make('Aberta');
    expect(await b.svc.summary()).toMatchObject({ p: { open: 1, review: 0, progress: { points: 1, max: 7 } } });
    expect(kanbanProgress(await b.list())).toEqual({ points: 1, max: 7 });
    // Rotina: a tarefa anterior da mesma rotina está cancelada, então a do próximo minuto é criada (não "ainda aberta").
    const first = await b.svc.createFromRoutine('p', 'ana-1', { id: 'r1', name: 'Faxina', message: 'limpar' }, '2026-11-14T10:00');
    expect(first.kind).toBe('created');
    expect((await b.svc.createFromRoutine('p', 'ana-1', { id: 'r1', name: 'Faxina', message: 'limpar' }, '2026-11-14T11:00')).kind).toBe('open');
    await b.svc.cancel('p', first.task.id, { by: 'user' });
    expect((await b.svc.createFromRoutine('p', 'ana-1', { id: 'r1', name: 'Faxina', message: 'limpar' }, '2026-11-14T12:00')).kind).toBe('created');
    expect(open.status).toBe('todo');
  });

  it('mensagem do usuário na conversa de uma cancelada não fica guardada esperando a vez de ninguém', async () => {
    const b = board('t-hold');
    const t1 = await b.make('Primeira');
    const t2 = await b.make('Segunda');
    await b.svc.start('p', t1.id); // s-1
    await b.finish('s-1'); // review: libera Ana
    await b.svc.start('p', t2.id); // s-2, Ana ocupada
    expect(await b.svc.hold('s-1', { text: 'ajuste' })).toMatch(/espera Ana/);
    expect((await b.get(t1.id)).held).toHaveLength(1);
    await b.svc.cancel('p', t1.id, { by: 'user' });
    expect((await b.get(t1.id)).held).toEqual([]); // o que estava guardado sai com o cancelamento
    expect(await b.svc.hold('s-1', { text: 'outro ajuste' })).toBeNull(); // vai direto
  });
});

describe('cancelar pela API: o token tem de ser o da conversa atual da tarefa', () => {
  const callerOf = (tokens: SessionTokens, token: string | undefined, sandbox = false) => {
    const r = resolveCaller(sandbox, token, tokens);
    return r.ok ? r.caller : null;
  };

  it('recusa sem token, token de outra conversa, de outro funcionário, do revisor e de outro projeto; aceita o da própria conversa', async () => {
    const b = board('api-token');
    const t = await b.make('Exportar', { by: 'gio-1', reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1 (Ana)
    const tokens = new SessionTokens();
    const own = tokens.issue({ staffId: 'ana-1', projectId: 'p', sessionId: 's-1', engine: 'claude' });
    const outra = tokens.issue({ staffId: 'ana-1', projectId: 'p', sessionId: 's-9', engine: 'claude' });
    const gestor = tokens.issue({ staffId: 'gio-1', projectId: 'p', sessionId: 's-gio', engine: 'claude' });
    const outroProjeto = tokens.issue({ staffId: 'ana-1', projectId: 'q', sessionId: 's-q', engine: 'claude' });
    const semFicha = tokens.issue({ staffId: null, projectId: 'p', sessionId: 's-nf', engine: 'claude' });

    for (const token of [undefined, 'inventado', outra, gestor, outroProjeto, semFicha]) {
      await expect(b.svc.cancelFrom('p', t.id, callerOf(tokens, token), 'x')).rejects.toBeInstanceOf(TaskForbiddenError);
    }
    expect((await b.get(t.id)).status).toBe('doing');
    expect(b.calls).toEqual([]);

    const out = (await b.svc.cancelFrom('p', t.id, callerOf(tokens, own), 'o usuário pediu no chat'))!;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'ana-1', cancelReason: 'o usuário pediu no chat' });
    expect(out.history.at(-1)).toMatchObject({ status: 'cancelled', by: 'auto' });
    expect(b.calls).toEqual(['interrupt:s-1', 'settle:s-1', 'continue:s-1']);
    expect(b.notified.at(-1)).toMatchObject({ staffId: 'gio-1', text: expect.stringContaining('foi cancelada por Ana: o usuário pediu no chat') });
    // Tarefa que não existe: null (404).
    expect(await b.svc.cancelFrom('p', 't-nao-existe', callerOf(tokens, own))).toBeNull();
  });

  it('a conversa de revisão (role review) não cancela a tarefa que revisa; o token do Codex (sandbox) da conversa da própria tarefa, sim', async () => {
    const b = board('api-codex', { ana: { engine: 'codex' } as Partial<StaffProfile> });
    const t = await b.make('Parecer', { reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1 (Ana, Codex)
    await b.finish('s-1'); // revisão em s-2 (Rui)
    const tokens = new SessionTokens();
    const revisor = tokens.issue({ staffId: 'rev-1', projectId: 'p', sessionId: 's-2', engine: 'codex' });
    const codex = tokens.issue({ staffId: 'ana-1', projectId: 'p', sessionId: 's-1', engine: 'codex' });
    await expect(b.svc.cancelFrom('p', t.id, callerOf(tokens, revisor, true))).rejects.toBeInstanceOf(TaskForbiddenError);
    const out = (await b.svc.cancelFrom('p', t.id, callerOf(tokens, codex, true), 'desistiu'))!;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'ana-1' });
  });

  it('já cancelada: 409 mesmo com o token certo', async () => {
    const b = board('api-dupla');
    const t = await b.make('Exportar');
    await b.svc.start('p', t.id);
    const tokens = new SessionTokens();
    const own = tokens.issue({ staffId: 'ana-1', projectId: 'p', sessionId: 's-1', engine: 'claude' });
    await b.svc.cancelFrom('p', t.id, callerOf(tokens, own));
    await expect(b.svc.cancelFrom('p', t.id, callerOf(tokens, own))).rejects.toBeInstanceOf(TaskConflictError);
  });
});

describe('instrução ao funcionário: como cancelar a própria tarefa', () => {
  it('o texto de partida traz o id real da tarefa, o curl da rota, e as regras (só se pedir sem dúvida; na dúvida, perguntar; nunca "pronta" nem apagar)', async () => {
    const b = board('i-claude');
    const t = await b.make('Exportar CSV');
    await b.svc.start('p', t.id);
    const text = b.sent[0]!.text;
    expect(text).toContain(`id \`${t.id}\``);
    expect(text).toContain('curl -s -X POST');
    expect(text).toContain('-H "x-myco: 1"');
    expect(text).toContain('-H "x-myco-token: $MYCO_TOKEN"');
    expect(text).toContain(`"reason"`);
    expect(text).toContain(`http://127.0.0.1:4848/api/projects/p/tasks/${t.id}/cancel`);
    expect(text).toContain('sem dúvida');
    expect(text).toContain('pergunte antes');
    expect(text).toContain('Nunca marque a tarefa como pronta nem a apague');
    expect(text.indexOf('Cancelar esta tarefa')).toBeLessThan(text.indexOf('Quando terminar, responda'));
  });

  it('no Codex o endereço é o da sandbox (127.0.0.2)', async () => {
    const b = board('i-codex', { ana: { engine: 'codex' } as Partial<StaffProfile> });
    const t = await b.make('Exportar CSV');
    await b.svc.start('p', t.id);
    expect(b.sent[0]!.text).toContain(`http://127.0.0.2:4848/api/projects/p/tasks/${t.id}/cancel`);
    expect(b.sent[0]!.text).not.toContain('127.0.0.1');
  });

  it('a cancelada, reaberta e começada de novo, traz a instrução na conversa nova', async () => {
    const b = board('i-reaberta');
    const t = await b.make('Exportar CSV');
    await b.svc.start('p', t.id);
    await b.svc.cancel('p', t.id, { by: 'user' });
    await b.svc.reopen('p', t.id);
    await b.finish('s-1'); // o turno interrompido acabou: Ana está livre
    await b.svc.start('p', t.id);
    expect(b.sent[1]!.text).toContain(`/tasks/${t.id}/cancel`);
    const saved = await readTasks(b.dir);
    expect(saved.find((x) => x.id === t.id)!.sessions?.map((s) => s.id)).toEqual(['s-1', 's-2']);
  });
});

describe('cartão esquecido: "a fazer" parado há mais de 2 dias vira item da caixa', () => {
  const DAY = 86_400_000;
  /** Envelhece o cartão: updatedAt e o histórico passam a `days` dias atrás (o relógio do servidor é o de verdade). */
  async function age(dir: string, id: string, days: number) {
    const file = path.join(dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
    const at = new Date(Date.now() - days * DAY).toISOString();
    for (const t of all) if (t.id === id) Object.assign(t, { updatedAt: at, history: t.history.map((h) => ({ ...h, at })) });
    await fs.writeFile(file, JSON.stringify(all));
  }
  /** Tarefa criada em "a fazer" (o padrão do `create`): fora da fila e sem conversa até alguém mandar começar. */
  const draft = async (b: ReturnType<typeof board>, title: string, o: { blockedBy?: string[]; staffId?: string | null } = {}) =>
    (await b.svc.create('p', { title, staffId: o.staffId === undefined ? 'ana-1' : o.staffId, ...(o.blockedBy && { blockedBy: o.blockedBy }) }))!;
  const forgotten = async (b: ReturnType<typeof board>) => notStartedTasks(await b.list()).map((n) => n.task.title);

  it('o prazo é uma constante nomeada de 2 dias; no limite não aparece, passando dele aparece com os dias inteiros', async () => {
    expect(NOT_STARTED_AFTER_DAYS).toBe(2);
    const b = board('e-prazo');
    const t = await draft(b, 'Esquecida');
    expect(await forgotten(b)).toEqual([]); // recém criada
    await age(b.dir, t.id, 1.9);
    expect(await forgotten(b)).toEqual([]);
    await age(b.dir, t.id, 2.1);
    expect(notStartedTasks(await b.list())).toEqual([{ task: expect.objectContaining({ id: t.id }), days: 2 }]);
    await age(b.dir, t.id, 5.5);
    expect(notStartedTasks(await b.list())[0]!.days).toBe(5);
  });

  it('vira item "notStarted" com o texto, o responsável e as ações pelas rotas de sempre (sem staffId no topo, para não pintar o cartão dele)', async () => {
    const b = board('e-item');
    const t = await draft(b, 'Revisar contrato');
    await age(b.dir, t.id, 3);
    const [n] = notStartedTasks(await b.list());
    const item = notStartedInboxItem(n!, { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' });
    expect(item).toMatchObject({
      id: `notStarted:${t.id}`,
      kind: 'notStarted',
      projectId: 'p',
      sessionId: '',
      staffId: null,
      name: 'Ana',
      summary: '“Revisar contrato” está em A fazer há 3 dias e não começou',
      notStarted: { taskId: t.id, taskTitle: 'Revisar contrato', days: 3, staffId: 'ana-1' },
    });
  });

  it('não aparece: na fila, bloqueada (aberta ou cancelada), recente, com conversa, fora de "a fazer" ou encerrada', async () => {
    const b = board('e-nao');
    const naFila = await b.make('Na fila'); // Ana começa esta; a próxima entra na fila
    await b.svc.start('p', naFila.id); // s-1, fazendo
    const fila2 = await b.make('Fila 2');
    await b.svc.start('p', fila2.id); // na fila (queuedAt)
    const base = await draft(b, 'Base');
    const bloq = await draft(b, 'Bloqueada por aberta', { blockedBy: [base.id] });
    const cancBase = await draft(b, 'Base cancelada');
    const bloqCanc = await draft(b, 'Bloqueada por cancelada', { blockedBy: [cancBase.id] });
    await b.svc.cancel('p', cancBase.id, { by: 'user' });
    const recente = await draft(b, 'Recente');
    const espera = (await b.svc.create('p', { title: 'Aguardar', staffId: 'ana-1', start: false }))!;
    expect(espera.status).toBe('waiting'); // `start: false` cria em Aguardar
    const pronta = await draft(b, 'Pronta');
    await b.svc.update('p', pronta.id, { status: 'done' });
    const cancelada = await draft(b, 'Cancelada');
    await b.svc.cancel('p', cancelada.id, { by: 'user' });
    for (const id of [naFila.id, fila2.id, base.id, bloq.id, cancBase.id, bloqCanc.id, espera.id, pronta.id, cancelada.id]) await age(b.dir, id, 10);
    // Só "Base" (a aberta que bloqueia a outra) está esquecida de verdade; "Recente" é de agora.
    expect(await forgotten(b)).toEqual(['Base']);
    expect(recente.status).toBe('todo');
    // A bloqueada por cancelada tem o aviso próprio ('blocked'), não este.
    expect(stuckDependencies(await b.list()).map((s) => s.task.title)).toEqual(['Bloqueada por cancelada']);
  });

  it('some ao começar, cancelar, editar e apagar', async () => {
    const b = board('e-some');
    const a = await draft(b, 'A');
    const c = await draft(b, 'C');
    const e = await draft(b, 'E');
    const d = await draft(b, 'D');
    for (const t of [a, c, e, d]) await age(b.dir, t.id, 4);
    expect((await forgotten(b)).sort()).toEqual(['A', 'C', 'D', 'E']);
    await b.svc.start('p', a.id);
    await b.svc.cancel('p', c.id, { by: 'user' });
    await b.svc.update('p', e.id, { title: 'E (editada)' });
    expect(await b.svc.remove('p', d.id)).toBe(true);
    expect(await forgotten(b)).toEqual([]);
  });

  it('começar com o funcionário ocupado entra na fila e também some; sem responsável aparece (o dono precisa escolher um)', async () => {
    const b = board('e-fila-sem-dono');
    const ocupa = await b.make('Ocupa');
    await b.svc.start('p', ocupa.id);
    const t = await draft(b, 'Vai para a fila');
    const orfa = await draft(b, 'Sem dono', { staffId: null });
    await age(b.dir, t.id, 3);
    await age(b.dir, orfa.id, 3);
    expect((await forgotten(b)).sort()).toEqual(['Sem dono', 'Vai para a fila']);
    await b.svc.start('p', t.id);
    expect(await b.get(t.id)).toMatchObject({ status: 'todo', queuedAt: expect.any(String) });
    expect(await forgotten(b)).toEqual(['Sem dono']);
    expect(notStartedInboxItem(notStartedTasks(await b.list())[0]!, { projectId: 'p', projectName: 'P', sessionId: '', name: '' }).notStarted).toMatchObject({ staffId: null });
  });
});

describe('cancelar com a escolha sobre quem espera (dependents)', () => {
  /** A <- B <- C: B espera A, C espera B. As duas entram na fila (bloqueadas). */
  async function chain(name: string) {
    const b = board(name);
    const a = await b.make('A');
    const x = await b.make('B', { blockedBy: [a.id], by: 'gio-1' });
    const c = await b.make('C', { blockedBy: [x.id], by: 'gio-1' });
    await b.svc.start('p', x.id);
    await b.svc.start('p', c.id);
    return { b, a, x, c };
  }
  const parou = (b: ReturnType<typeof board>) => b.notified.filter((n) => n.text.includes('parou'));

  it('release: a direta sai da espera e começa (fluxo normal); a indireta segue esperando a direta, e ninguém é avisado de "parou"', async () => {
    const { b, a, x, c } = await chain('dp-release');
    const out = (await b.svc.cancel('p', a.id, { by: 'user', dependents: { [x.id]: 'release' } }))!;
    expect(out.status).toBe('cancelled');
    expect((await b.get(x.id)).blockedBy).toBeUndefined();
    await vi.waitFor(async () => expect(await b.get(x.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null }));
    expect((await b.get(x.id)).history.some((h) => h.note === 'liberada da espera por “A” (cancelada)')).toBe(true);
    expect(await b.get(c.id)).toMatchObject({ status: 'todo', blockedBy: [x.id] }); // espera B, que está fazendo
    expect(stuckDependencies(await b.list())).toEqual([]);
    await b.settle();
    expect(parou(b)).toEqual([]);
  });

  it('cancel em cascata: a direta é cancelada ("a tarefa A foi cancelada"), a indireta que também tem "cancel" também ("a tarefa B..."); quem não tem escolha fica esperando e aparece na caixa', async () => {
    const { b, a, x, c } = await chain('dp-cascata');
    const d = await b.make('D', { blockedBy: [c.id] }); // espera C, sem entrada no mapa
    const out = (await b.svc.cancel('p', a.id, { by: 'user', reason: 'mudou o escopo', dependents: { [x.id]: 'cancel', [c.id]: 'cancel' } }))!;
    expect(out).toMatchObject({ status: 'cancelled', cancelReason: 'mudou o escopo' });
    expect(await b.get(x.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'user', cancelReason: 'a tarefa “A” foi cancelada', queuedAt: null });
    expect(await b.get(c.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'user', cancelReason: 'a tarefa “B” foi cancelada', queuedAt: null });
    expect(await b.get(d.id)).toMatchObject({ status: 'todo', blockedBy: [c.id] });
    expect((await b.get(d.id)).ackCancelled).toBeUndefined();
    expect(stuckDependencies(await b.list()).map((s) => [s.task.title, s.blocker.title, s.reason])).toEqual([['D', 'C', 'cancelada: a tarefa “B” foi cancelada']]);
    expect(b.sent).toHaveLength(0);
  });

  it('wait: a direta fica esperando sem aparecer na caixa (ackCancelled); a indireta, cuja bloqueadora não foi cancelada, é ignorada mesmo com entrada', async () => {
    const { b, a, x, c } = await chain('dp-wait');
    const outra = await b.make('Outra', { blockedBy: [a.id], by: 'gio-1' }); // sem entrada: fica na caixa
    await b.svc.cancel('p', a.id, { by: 'user', dependents: { [x.id]: 'wait', [c.id]: 'cancel' } });
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', blockedBy: [a.id], ackCancelled: [{ id: a.id, at: expect.any(String) }] });
    expect(await b.get(c.id)).toMatchObject({ status: 'todo', blockedBy: [x.id] }); // B não foi cancelada: o "cancel" de C não vale
    expect((await b.get(outra.id)).ackCancelled).toBeUndefined();
    expect(stuckDependencies(await b.list()).map((s) => [s.task.title, s.blocker.title])).toEqual([['Outra', 'A']]);
    await b.settle();
    // O gestor só é avisado de quem ficou sem decisão.
    expect(parou(b)).toHaveLength(1);
    expect(parou(b)[0]!.text).toContain('“Outra”');
    expect(parou(b)[0]!.text).not.toContain('“B”');
  });

  it('quem espera por duas dependentes (C espera B e D): B = esperar, D = cancelar junto, e a escolha de C vale (cancelar ou liberar de D)', async () => {
    for (const choice of ['cancel', 'release'] as const) {
      const b = board(`dp-compartilhada-${choice}`);
      const r = await b.make('R');
      const bb = await b.make('B', { blockedBy: [r.id] });
      const d = await b.make('D', { blockedBy: [r.id] });
      const c = await b.make('C', { blockedBy: [bb.id, d.id] });
      await b.svc.cancel('p', r.id, { by: 'user', dependents: { [bb.id]: 'wait', [d.id]: 'cancel', [c.id]: choice } });
      expect(await b.get(bb.id)).toMatchObject({ status: 'todo', blockedBy: [r.id], ackCancelled: [{ id: r.id, at: expect.any(String) }] });
      expect(await b.get(d.id)).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “R” foi cancelada' });
      if (choice === 'cancel') expect(await b.get(c.id)).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “D” foi cancelada' });
      else {
        // Libera só de D: continua esperando B (aberta), então nada começa.
        expect(await b.get(c.id)).toMatchObject({ status: 'todo', blockedBy: [bb.id] });
        expect((await b.get(c.id)).history.some((h) => h.note === 'liberada da espera por “D” (cancelada)')).toBe(true);
      }
    }
  });

  it('o mesmo, ao APAGAR: B liberada, D cancelada junto e a escolha de C (que espera B e D) é aplicada', async () => {
    const b = board('dp-compartilhada-apagar');
    const r = await b.make('R');
    const bb = await b.make('B', { blockedBy: [r.id] });
    const d = await b.make('D', { blockedBy: [r.id] });
    const c = await b.make('C', { blockedBy: [bb.id, d.id] });
    expect(await b.svc.remove('p', r.id, { dependents: { [bb.id]: 'release', [d.id]: 'cancel', [c.id]: 'cancel' } })).toBe(true);
    expect(await b.get(d.id)).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “R” foi apagada' });
    expect(await b.get(c.id)).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “D” foi cancelada' });
    expect((await b.get(bb.id)).blockedBy).toBeUndefined(); // B foi liberada de R
  });

  it('sem "dependents" (ou mapa vazio): como antes, as diretas ficam esperando e aparecem na caixa', async () => {
    const { b, a, x } = await chain('dp-sem');
    await b.svc.cancel('p', a.id, { by: 'user' });
    await b.svc.cancel('p', (await b.make('Z')).id, { by: 'user', dependents: {} });
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', blockedBy: [a.id] });
    expect(stuckDependencies(await b.list()).map((s) => s.task.title)).toEqual(['B']);
  });

  it('ids estranhos no mapa são ignorados: inexistente, tarefa que não depende, a própria cancelada, encerrada e chave herdada do protótipo', async () => {
    const { b, a, x } = await chain('dp-estranhos');
    const viva = await b.make('Viva');
    const pronta = await b.make('Pronta');
    await b.svc.update('p', pronta.id, { status: 'done' });
    const map = { 't-nao-existe': 'cancel', [viva.id]: 'cancel', [a.id]: 'release', [pronta.id]: 'cancel', constructor: 'cancel', [x.id]: 'wait' } as Record<string, 'release' | 'cancel' | 'wait'>;
    await b.svc.cancel('p', a.id, { by: 'user', dependents: map });
    expect(await b.get(a.id)).toMatchObject({ status: 'cancelled' });
    expect(await b.get(viva.id)).toMatchObject({ status: 'todo' });
    expect(await b.get(pronta.id)).toMatchObject({ status: 'done' });
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', blockedBy: [a.id], ackCancelled: [{ id: a.id, at: expect.any(String) }] });
  });

  it('ciclo (arquivo editado à mão): cancelar com "cancel" nas duas pontas termina e cada uma é cancelada uma vez', async () => {
    const b = board('dp-ciclo');
    const a = await b.make('A');
    const x = await b.make('B', { blockedBy: [a.id] });
    const file = path.join(b.dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Task[];
    await fs.writeFile(file, JSON.stringify(all.map((t) => (t.id === a.id ? { ...t, blockedBy: [x.id] } : t))));
    const out = (await b.svc.cancel('p', a.id, { by: 'user', dependents: { [x.id]: 'cancel', [a.id]: 'cancel' } }))!;
    expect(out.status).toBe('cancelled');
    expect(await b.get(x.id)).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “A” foi cancelada' });
    expect((await b.get(a.id)).history.filter((h) => h.status === 'cancelled')).toHaveLength(1);
    expect((await b.get(x.id)).history.filter((h) => h.status === 'cancelled')).toHaveLength(1);
  });

  it('dependente de duas canceladas da mesma cascata: "cancel" cancela uma vez só; "release" tira as duas e a deixa livre', async () => {
    for (const choice of ['cancel', 'release'] as const) {
      const b = board(`dp-losango-${choice}`);
      const a = await b.make('A');
      const x = await b.make('B', { blockedBy: [a.id] });
      const c = await b.make('C', { blockedBy: [a.id] });
      const d = await b.make('D', { blockedBy: [x.id, c.id] });
      await b.svc.start('p', d.id); // na fila, bloqueada
      await b.svc.cancel('p', a.id, { by: 'user', dependents: { [x.id]: 'cancel', [c.id]: 'cancel', [d.id]: choice } });
      expect(await b.get(x.id)).toMatchObject({ status: 'cancelled' });
      expect(await b.get(c.id)).toMatchObject({ status: 'cancelled' });
      if (choice === 'cancel') {
        const got = await b.get(d.id);
        expect(got).toMatchObject({ status: 'cancelled', cancelReason: 'a tarefa “B” foi cancelada' });
        expect(got.history.filter((h) => h.status === 'cancelled')).toHaveLength(1);
      } else {
        expect((await b.get(d.id)).blockedBy).toBeUndefined(); // as duas saíram, uma a cada vez
        await vi.waitFor(async () => expect(await b.get(d.id)).toMatchObject({ status: 'doing', queuedAt: null })); // e só agora ela começa
      }
      expect(stuckDependencies(await b.list())).toEqual([]);
    }
  });

  it('o mesmo "release" numa dependente de duas: só começa depois de sair das duas esperas (a outra ainda aberta segura)', async () => {
    const b = board('dp-duas');
    const a = await b.make('A');
    const v = await b.make('Viva');
    const d = await b.make('D', { blockedBy: [a.id, v.id] });
    await b.svc.start('p', d.id);
    await b.svc.cancel('p', a.id, { by: 'user', dependents: { [d.id]: 'release' } });
    expect((await b.get(d.id)).blockedBy).toEqual([v.id]);
    await b.settle();
    expect(await b.get(d.id)).toMatchObject({ status: 'todo', sessionId: null });
  });
});

describe('apagar com a escolha sobre quem espera (dependents)', () => {
  it('mapa completo: "release" libera e acorda, "cancel" cancela ("a tarefa X foi apagada") e as dela seguem o mapa (wait vale); depois apaga', async () => {
    const b = board('rm-completo');
    const a = await b.make('Base');
    const lib = await b.make('Libera', { blockedBy: [a.id], by: 'gio-1' });
    const can = await b.make('Cancela', { blockedBy: [a.id], by: 'gio-1' });
    const ind = await b.make('Indireta espera', { blockedBy: [can.id], by: 'gio-1' });
    const solta = await b.make('Indireta sem escolha', { blockedBy: [can.id], by: 'gio-1' });
    await b.svc.start('p', lib.id);
    await b.svc.start('p', ind.id);
    expect(await b.svc.remove('p', a.id, { dependents: { [lib.id]: 'release', [can.id]: 'cancel', [ind.id]: 'wait', 't-nao-existe': 'cancel' } })).toBe(true);
    const tasks = await b.list();
    expect(tasks.find((t) => t.id === a.id)).toBeUndefined();
    expect(await b.get(lib.id)).toMatchObject({ queuedAt: expect.any(String) }); // ainda aqui; começa abaixo
    expect((await b.get(lib.id)).blockedBy).toBeUndefined();
    expect((await b.get(lib.id)).history.some((h) => h.note === 'liberada da espera por “Base” (apagada)')).toBe(true);
    await vi.waitFor(async () => expect(await b.get(lib.id)).toMatchObject({ status: 'doing', sessionId: expect.any(String), queuedAt: null }));
    expect(await b.get(can.id)).toMatchObject({ status: 'cancelled', cancelledBy: 'user', cancelReason: 'a tarefa “Base” foi apagada', blockedBy: [] });
    expect(await b.get(ind.id)).toMatchObject({ status: 'todo', blockedBy: [can.id], ackCancelled: [{ id: can.id, at: expect.any(String) }] });
    expect(await b.get(solta.id)).toMatchObject({ status: 'todo', blockedBy: [can.id] });
    expect(stuckDependencies(await b.list()).map((s) => [s.task.title, s.blocker.title, s.reason])).toEqual([['Indireta sem escolha', 'Cancela', 'cancelada: a tarefa “Base” foi apagada']]);
  });

  it('mapa incompleto, vazio ou com "wait" numa direta: recusa (409) listando quem depende, e nada é aplicado nem apagado', async () => {
    const b = board('rm-incompleto');
    const a = await b.make('Base');
    const x = await b.make('Um', { blockedBy: [a.id] });
    const y = await b.make('Dois', { blockedBy: [a.id] });
    for (const dependents of [{ [x.id]: 'release' }, {}, { [x.id]: 'cancel', [y.id]: 'wait' }, { [y.id]: 'cancel', 't-outro': 'release' }] as Array<Record<string, 'release' | 'cancel' | 'wait'>>) {
      const err = await b.svc.remove('p', a.id, { dependents }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TaskConflictError);
      expect((err as Error).message).toMatch(/“Um”.*“Dois”|“Dois”.*“Um”/);
    }
    expect((await b.list()).map((t) => [t.title, t.status, t.blockedBy])).toEqual([
      ['Base', 'todo', undefined],
      ['Um', 'todo', [a.id]],
      ['Dois', 'todo', [a.id]],
    ]);
    // Sem mapa: como sempre.
    await expect(b.svc.remove('p', a.id)).rejects.toThrow(TaskConflictError);
  });

  it('mapa sem dependentes abertas (ou só com encerradas) apaga normalmente; tarefa que não existe: false', async () => {
    const b = board('rm-sem-abertas');
    const a = await b.make('Base');
    const c = await b.make('Cancelada', { blockedBy: [a.id] });
    await b.svc.cancel('p', c.id, { by: 'user' });
    expect(await b.svc.remove('p', a.id, { dependents: { 'qualquer-id': 'cancel' } })).toBe(true);
    expect((await b.get(c.id)).blockedBy).toEqual([]);
    expect(await b.svc.remove('p', 't-nao-existe', { dependents: {} })).toBe(false);
  });
});

describe('o corpo das rotas cancel e delete', () => {
  const dependents = { 't-1': 'release', 't-2': 'cancel', 't-3': 'wait' };

  it('cancelRequest: da tela leva reason e dependents', () => {
    expect(cancelRequest({ reason: 'x', dependents }, true)).toEqual({ reason: 'x', dependents });
    expect(cancelRequest(undefined, true)).toEqual({});
    expect(cancelRequest({}, true)).toEqual({});
  });

  it('cancelRequest: pelo token do funcionário o dependents é ignorado (até o inválido), e o reason segue valendo', () => {
    expect(cancelRequest({ reason: 'x', dependents }, false)).toEqual({ reason: 'x' });
    expect(cancelRequest({ dependents: 'lixo' }, false)).toEqual({});
    expect(cancelRequest(null, false)).toEqual({});
  });

  it('cancelRequest e deleteRequest: valor desconhecido, id inválido, tipo errado e mapa grande demais são recusados (TaskError)', () => {
    const bad: unknown[] = [{ dependents: { 't-1': 'apagar' } }, { dependents: { 'T 1!': 'cancel' } }, { dependents: ['cancel'] }, { dependents: 'cancel' }, { dependents: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`t-${i}`, 'wait'])) }];
    for (const body of bad) {
      expect(() => cancelRequest(body, true)).toThrow(TaskError);
      expect(() => deleteRequest(body)).toThrow(TaskError);
    }
    expect(() => cancelRequest({ reason: 'x'.repeat(2001) }, true)).toThrow(TaskError);
  });

  it('deleteRequest: sem corpo é o pedido de sempre; com mapa devolve o mapa', () => {
    expect(deleteRequest(undefined)).toEqual({});
    expect(deleteRequest({})).toEqual({});
    expect(deleteRequest({ dependents })).toEqual({ dependents });
  });

  it('o funcionário que cancela a própria tarefa pelo token não decide sobre as dos outros: o corpo com dependents não muda nada nelas', async () => {
    const b = board('rota-token');
    const a = await b.make('Base');
    const x = await b.make('Tela', { blockedBy: [a.id], by: 'gio-1' });
    await b.svc.start('p', a.id); // s-1 (Ana)
    const tokens = new SessionTokens();
    const own = tokens.issue({ staffId: 'ana-1', projectId: 'p', sessionId: 's-1', engine: 'claude' });
    const r = resolveCaller(false, own, tokens);
    const body = { reason: 'o usuário pediu', dependents: { [x.id]: 'cancel' } };
    // O que a rota faz: o corpo passa por cancelRequest(…, false) e só o motivo segue para cancelFrom.
    const req = cancelRequest(body, false);
    await b.svc.cancelFrom('p', a.id, r.ok ? r.caller : null, req.reason);
    expect(await b.get(a.id)).toMatchObject({ status: 'cancelled', cancelReason: 'o usuário pediu' });
    expect(await b.get(x.id)).toMatchObject({ status: 'todo', blockedBy: [a.id] });
    expect(stuckDependencies(await b.list()).map((s) => s.task.title)).toEqual(['Tela']);
  });
});

describe('limite de revisões automáticas', () => {
  it('são 3 (a constante vem do shared, e a tela mostra n/3): a 3ª reprovação é a última, e a tarefa fica com o dono', async () => {
    expect(AUTO_REVIEW_ROUNDS).toBe(3);
    const b = board('rev-limite');
    const t = await b.make('Relatório', { reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1
    await b.svc.onTurnDone('s-1'); // rodada 1 (s-2)
    const reviews = () => b.sent.filter((m) => m.staffId === 'rev-1').length;
    for (const round of [1, 2, 3]) {
      expect(reviews()).toBe(round);
      b.texts.set(`s-${round + 1}`, `REPROVADO\n\najuste ${round}`);
      await b.svc.onTurnDone(`s-${round + 1}`); // reprovou
      await b.svc.onTurnDone('s-1'); // ajustou e terminou: pede a rodada seguinte, se ainda cabe
    }
    expect(reviews()).toBe(3); // a 4ª não foi pedida
    const end = await b.get(t.id);
    expect(end).toMatchObject({ status: 'review', reviewRounds: 3 });
    expect(end.history.at(-1)?.note).toContain('limite de 3 revisões automáticas');
    expect(stuckReason(end)).toBe('limite de revisões automáticas atingido');
  });
});

describe('cancelar no meio de outra operação: a cancelada não volta a andar', () => {
  it('revisão automática: cancelada enquanto a conversa do revisor abria, ela continua cancelada, a conversa é interrompida, um APROVADO depois não a leva a pronto e o gestor não recebe "entregou"', async () => {
    const b = board('corrida-revisao');
    const t = await b.make('Parecer', { reviewerId: 'gio-1', by: 'gio-1' }); // quem pediu é quem revisa
    const dep = await b.make('Anexo', { blockedBy: [t.id] });
    await b.svc.start('p', t.id); // s-1
    // O usuário cancela justo quando a conversa do revisor está sendo aberta (o `send` ainda não voltou).
    b.hooks.beforeSend = async (staffId) => {
      if (staffId === 'gio-1') await b.svc.cancel('p', t.id, { by: 'user', reason: 'desistiu' });
    };
    b.texts.set('s-1', 'terminei');
    await b.finish('s-1'); // entrega: pede a revisão (s-2) e perde a corrida
    expect(b.sent.map((m) => m.staffId)).toEqual(['ana-1', 'gio-1']);
    const after = await b.get(t.id);
    expect(after).toMatchObject({ status: 'cancelled', cancelReason: 'desistiu' });
    expect(after.review).toBeUndefined(); // a revisão não foi gravada na tarefa
    expect(after.history.at(-1)).toMatchObject({ status: 'cancelled' }); // nem voltou para "revisão", nem ganhou nota
    expect(after.history.map((h) => h.status)).toEqual(['todo', 'doing', 'review', 'cancelled']);
    expect(b.calls).toContain('interrupt:s-2'); // a conversa do revisor que abriu à toa é interrompida
    // Quem pediu soube do cancelamento, e só dele ("entregou" seria falso).
    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]!.text).toContain('foi cancelada pelo usuário');
    expect(b.notified.some((n) => n.text.includes('entregou'))).toBe(false);
    // O APROVADO que chegar da conversa interrompida não decide nada.
    b.texts.set('s-2', 'APROVADO\n\ntudo certo');
    await b.finish('s-2');
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled' });
    expect((await b.get(t.id)).history.map((h) => h.status)).not.toContain('done');
    const all = await b.list();
    expect(blockers(all.find((x) => x.id === dep.id)!, all)).toEqual([t.id]);
  });

  it('mesclar: cancelada durante a mescla, a tarefa NÃO vira pronta nem libera dependente; o 409 diz que o código já entrou, e o histórico guarda isso', async () => {
    const b = board('corrida-mescla');
    const t = await b.make('Entrega', { by: 'gio-1' });
    const dep = await b.make('Depois', { blockedBy: [t.id] });
    await b.svc.start('p', t.id);
    await b.finish('s-1'); // revisão
    merging.place = { where: 'worktree', path: '/tmp/wt', branch: 'myco/ana' };
    merging.merge = async () => {
      // A mescla demora: o usuário cancela nesse intervalo.
      await b.svc.cancel('p', t.id, { by: 'user' });
      return { sha: 'abc1234', base: 'main', branch: 'myco/ana', tests: null };
    };
    try {
      await expect(b.svc.merge('p', t.id, true)).rejects.toThrow(/cancelada durante a mescla.*main \(abc1234\)/);
    } finally {
      merging.place = null;
      merging.merge = null;
    }
    const after = await b.get(t.id);
    expect(after.status).toBe('cancelled');
    expect(after.merged).toBeUndefined();
    expect(after.history.map((h) => h.status)).not.toContain('done');
    expect(after.history.at(-1)?.note).toBe('mesclado em main (abc1234) depois de cancelada: a tarefa continua cancelada');
    const all = await b.list();
    expect(blockers(all.find((x) => x.id === dep.id)!, all)).toEqual([t.id]); // continua bloqueada
    expect(b.notified.some((n) => n.text.includes('foi para pronto'))).toBe(false);
  });

  /** A operação que segura a vez da Ana (um "Começar" parado dentro do `send`) enquanto o resto se enfileira atrás dela. */
  async function holdAna(b: ReturnType<typeof board>) {
    const other = await b.make('Outra');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.hooks.beforeSend = async (staffId, text) => {
      if (staffId === 'ana-1' && text.includes('Outra')) await gate;
    };
    const started = b.svc.start('p', other.id);
    await b.settle();
    return { release: () => release(), started };
  }

  it('reprovar: o REPROVADO que chega com a tarefa ainda em revisão, mas cancelada na fila da vez dele, não manda ajuste nem guarda nada', async () => {
    const b = board('corrida-reprova');
    const t = await b.make('Parecer', { reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // revisão em s-2; a Ana está livre
    const hold = await holdAna(b);
    const cancelling = b.svc.cancel('p', t.id, { by: 'user' }); // espera a vez da Ana, atrás do "Começar"
    await b.settle();
    b.texts.set('s-2', 'REPROVADO\n\n🔴 falta teste');
    const verdict = b.svc.onTurnDone('s-2'); // vê "revisão" e entra na fila da vez, atrás do cancelamento
    await b.settle();
    hold.release();
    await Promise.all([hold.started, cancelling, verdict]);
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled' });
    expect((await b.get(t.id)).held ?? []).toEqual([]);
    expect(b.delivered).toHaveLength(0); // nada foi para a conversa da cancelada
    expect((await b.get(t.id)).history.filter((h) => h.status === 'doing')).toHaveLength(1); // só a ida original: o ajuste não a levou de volta a "fazendo"
  });

  it('responder a dúvida: cancelada na fila da vez dele, a resposta do gestor leva 409 e não vai para a conversa da cancelada', async () => {
    const b = board('corrida-duvida');
    const t = await b.make('Dúvida', { by: 'gio-1' });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // revisão: a Ana está livre
    b.edit((all) => {
      all[0]!.question = { id: 'q-1', source: 'text', text: 'DÚVIDA: x?', status: 'open', askedAt: new Date().toISOString(), managerSession: 's-gio' };
    });
    const hold = await holdAna(b);
    const cancelling = b.svc.cancel('p', t.id, { by: 'user' });
    await b.settle();
    const answering = b.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: 's-gio' }, { questionId: 'q-1', text: 'sim' }).catch((e: unknown) => e);
    await b.settle();
    hold.release();
    const [, , err] = await Promise.all([hold.started, cancelling, answering]);
    expect(err).toBeInstanceOf(TaskConflictError);
    expect(b.delivered).toHaveLength(0);
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled' });
    expect((await b.get(t.id)).held ?? []).toEqual([]);
  });

  it('cancelar interrompe também a conversa de revisão e a de deploy em andamento (e nega o que elas esperavam de você)', async () => {
    const b = board('cancela-tudo');
    const t = await b.make('Entrega', { reviewerId: 'rev-1' });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // revisão em andamento: s-2
    b.edit((all) => {
      all[0]!.deploy = { staffId: 'rev-1', sessionId: 's-9', at: new Date().toISOString() };
    });
    await b.svc.cancel('p', t.id, { by: 'user' });
    expect(b.calls).toEqual(['interrupt:s-1', 'settle:s-1', 'continue:s-1', 'interrupt:s-2', 'settle:s-2', 'continue:s-2', 'interrupt:s-9', 'settle:s-9', 'continue:s-9']);
    expect(b.dismissed.map((d) => d.sessionId)).toEqual(['s-1', 's-2', 's-9']);
    expect(b.dismissed[0]!.message).toMatch(/cancelada/);
    // Os vereditos e respostas que chegarem das três não mexem na tarefa.
    b.texts.set('s-2', 'APROVADO');
    await b.finish('s-2');
    expect((await b.get(t.id)).status).toBe('cancelled');
  });

  it('planejando: cancelada, o cartão do plano é negado e aprovar (ou recusar) o plano depois não grava plano nem muda nada na tarefa', async () => {
    const b = board('cancela-plano', { ana: { autonomy: 'plan' } });
    const t = await b.make('Planejar');
    expect((await b.svc.start('p', t.id))!).toMatchObject({ status: 'planning', sessionId: 's-1' });
    await b.svc.cancel('p', t.id, { by: 'user' });
    expect(b.dismissed.map((d) => d.sessionId)).toEqual(['s-1']);
    const before = await b.get(t.id);
    await b.svc.onPlanApproved('s-1', '# Plano\n1. fazer');
    await b.svc.onPlanRejected('s-1');
    const after = await b.get(t.id);
    expect(after).toEqual(before); // nem o plano, nem o histórico, nem o updatedAt
    expect(after).toMatchObject({ status: 'cancelled', plan: null });
    expect(b.delivered).toHaveLength(0);
  });
});

describe('apagar com mapa: tudo ou nada', () => {
  it('dependente nova que aparece depois de o mapa ser lido não deixa parte cancelada com a tarefa de pé: o pedido grava de uma vez', async () => {
    const b = board('rm-atomico');
    const a = await b.make('Base');
    const x = await b.make('Cancela', { blockedBy: [a.id] });
    b.edit((all) => {
      all.find((t) => t.id === x.id)!.sessionId = 's-x'; // tem conversa: cancelar chama `interruptSession`
    });
    // No instante em que o cancelamento interrompe a conversa, alguém cria outra dependente da Base à mão.
    b.hooks.onInterrupt = () =>
      b.edit((all) => {
        all.push({ ...all.find((t) => t.id === a.id)!, id: 't-tardia', title: 'Tardia', status: 'todo', sessionId: null, blockedBy: [a.id] });
      });
    const result = await b.svc.remove('p', a.id, { dependents: { [x.id]: 'cancel' } }).then(
      (ok) => ok,
      (e: unknown) => e,
    );
    const all = await b.list();
    const base = all.find((t) => t.id === a.id);
    const cancel = all.find((t) => t.id === x.id)!;
    // Ou apagou e cancelou, ou não fez nada: nunca "cancelou e a Base continua aí".
    if (result === true) {
      expect(base).toBeUndefined();
      expect(cancel.status).toBe('cancelled');
    } else {
      expect(base).toBeDefined();
      expect(cancel.status).not.toBe('cancelled');
    }
    expect(result).toBe(true); // com a gravação única, o que veio depois da leitura não derruba o pedido
    expect(b.calls.filter((c) => c.startsWith('interrupt:'))).toEqual(['interrupt:s-x']); // o resto do cancelamento rodou depois de gravar
  });

  it('dependente aberta fora do mapa, na hora da gravação: 409 e NADA é cancelado, liberado nem apagado (nem a conversa é interrompida)', async () => {
    const b = board('rm-recusa');
    const a = await b.make('Base');
    const x = await b.make('Cancela', { blockedBy: [a.id] });
    const lib = await b.make('Libera', { blockedBy: [a.id] });
    const y = await b.make('Fora do mapa', { blockedBy: [a.id] });
    b.edit((all) => {
      all.find((t) => t.id === x.id)!.sessionId = 's-x';
    });
    await expect(b.svc.remove('p', a.id, { dependents: { [x.id]: 'cancel', [lib.id]: 'release' } })).rejects.toThrow(/“Fora do mapa”/);
    expect((await b.list()).map((t) => [t.title, t.status, t.blockedBy])).toEqual([
      ['Base', 'todo', undefined],
      ['Cancela', 'todo', [a.id]],
      ['Libera', 'todo', [a.id]],
      ['Fora do mapa', 'todo', [a.id]],
    ]);
    expect(b.calls).toEqual([]);
    expect(y.id).toBeTruthy();
  });
});

describe('o aviso ao gestor diz o que o dono decidiu sobre quem esperava', () => {
  it('sem mapa: "seguem esperando, e a decisão é do usuário" com os nomes; com mapa: o que foi decidido; sem dependentes: nenhuma frase sobre eles', async () => {
    const b = board('aviso-mapa');
    const base = await b.make('Base', { by: 'gio-1' });
    const lib = await b.make('Libera', { blockedBy: [base.id] });
    const can = await b.make('Cancela', { blockedBy: [base.id] });
    const esp = await b.make('Espera', { blockedBy: [base.id] });
    const solta = await b.make('Sem escolha', { blockedBy: [base.id] });
    await b.svc.cancel('p', base.id, { by: 'user', dependents: { [lib.id]: 'release', [can.id]: 'cancel', [esp.id]: 'wait' } });
    const text = b.notified.at(-1)!.text;
    expect(text).toContain(`O usuário liberou da espera por ela: “Libera” (id ${lib.id}).`);
    expect(text).toContain(`O usuário cancelou junto: “Cancela” (id ${can.id}).`);
    expect(text).toContain(`O usuário decidiu que seguem esperando por ela: “Espera” (id ${esp.id}).`);
    expect(text).toContain(`Seguem esperando por ela, e a decisão é do usuário: “Sem escolha” (id ${solta.id}).`);
    expect(text).not.toContain('Quem depende dela segue esperando');

    const b2 = board('aviso-sem-mapa');
    const x = await b2.make('Base', { by: 'gio-1' });
    const w = await b2.make('Espera', { blockedBy: [x.id] });
    await b2.svc.cancel('p', x.id, { by: 'user' });
    expect(b2.notified.at(-1)!.text).toContain(`Seguem esperando por ela, e a decisão é do usuário: “Espera” (id ${w.id}).`);

    const b3 = board('aviso-sozinha');
    const y = await b3.make('Sozinha', { by: 'gio-1' });
    await b3.svc.cancel('p', y.id, { by: 'user' });
    expect(b3.notified.at(-1)!.text).toMatch(/continua na branch e na worktree\.$/);
  });
});

describe('limite de revisões automáticas: tarefa parada no limite antigo (2) segue com o dono', () => {
  const OLD_NOTE = 'limite de 2 revisões automáticas; o que sobrou fica com você: aceitar como trade-off (anotar em "Decisões" no SPEC.md) ou pedir ajuste';

  /**
   * Uma tarefa como as que ficaram paradas com o limite antigo: 2 rodadas pedidas, a última respondida e reprovada, a 3ª entrega sem revisar e
   * a nota do limite por último. O fluxo novo chega a 3 rodadas; aqui o arquivo volta ao que o servidor antigo teria gravado.
   */
  async function stuckAtOldLimit(name: string) {
    const b = board(name);
    const t = await b.make('Relatório', { reviewerId: 'rev-1' });
    const dep = await b.make('Depois', { blockedBy: [t.id], by: 'gio-1' });
    await b.svc.start('p', t.id); // s-1
    await b.svc.onTurnDone('s-1'); // rodada 1 (s-2)
    for (const round of [1, 2, 3]) {
      b.texts.set(`s-${round + 1}`, `REPROVADO\n\najuste ${round}`);
      await b.svc.onTurnDone(`s-${round + 1}`); // reprovou
      await b.svc.onTurnDone('s-1'); // ajustou e entregou: pede a rodada seguinte, ou fica com o dono no limite
    }
    b.edit((all) => {
      const task = all.find((x) => x.id === t.id)!;
      task.reviewRounds = 2;
      task.history = task.history.map((h: { note?: string }, i: number, list: unknown[]) => (i === list.length - 1 ? { ...h, note: OLD_NOTE } : h));
    });
    return { b, t, dep };
  }

  it('o tick NÃO pede a 3ª revisão sozinho (gastaria cota sem o dono pedir): a tarefa segue na caixa como "limite atingido" e some quando muda', async () => {
    const { b, t, dep } = await stuckAtOldLimit('legado-caixa');
    const reviews = () => b.sent.filter((m) => m.staffId === 'rev-1').length;
    const asked = reviews();
    const stuck = await b.get(t.id);
    expect(stuck).toMatchObject({ status: 'review', reviewRounds: 2, review: { verdict: 'rejected' } });
    expect(stuck.review?.doneAt).toBeTruthy();
    expect(stuck.history.at(-1)?.note).toBe(OLD_NOTE);
    expect(stuckReason(stuck)).toBe('limite de revisões automáticas atingido');
    expect(stuckDependencies(await b.list()).map((s) => [s.task.id, s.blocker.id, s.reason])).toEqual([[dep.id, t.id, 'limite de revisões automáticas atingido']]);

    // Subida e ticks: nada é pedido nem gravado.
    await b.svc.tick();
    await b.svc.tick();
    await b.settle();
    expect(reviews()).toBe(asked);
    const still = await b.get(t.id);
    expect({ status: still.status, reviewRounds: still.reviewRounds, review: still.review, history: still.history }).toEqual({ status: stuck.status, reviewRounds: stuck.reviewRounds, review: stuck.review, history: stuck.history });
    expect(stuckDependencies(await b.list())).toHaveLength(1);

    // O dono decide pelos botões de sempre: pedir revisão (manual) tira a tarefa do limite e, com ela, o item da caixa.
    await b.svc.requestReview('p', t.id, 'rev-1', false, { assign: true });
    expect(reviews()).toBe(asked + 1);
    expect(stuckReason(await b.get(t.id))).toBeNull();
    expect(stuckDependencies(await b.list())).toEqual([]);
  });

  it('reconhece a nota de qualquer N, e só com tudo junto: aprovada, sem revisor, fora de revisão, sem resposta ou com outra linha por último, não', async () => {
    const { b, t } = await stuckAtOldLimit('legado-condicao');
    const base = await b.get(t.id);
    const but = (patch: Partial<Task>) => ({ ...base, ...patch }) as Task;
    const note = (n: string) => but({ history: [...base.history.slice(0, -1), { ...base.history.at(-1)!, note: n }] });
    expect(stuckReason(base)).toBe('limite de revisões automáticas atingido');
    expect(stuckReason(note('limite de 5 revisões automáticas; o que sobrou fica com você'))).toBe('limite de revisões automáticas atingido');
    expect(stuckReason(note('limite do dia'))).toBeNull();
    expect(stuckReason(but({ review: { ...base.review!, verdict: 'approved' } }))).toBeNull();
    expect(stuckReason(but({ reviewerId: null }))).toBeNull();
    expect(stuckReason(but({ status: 'doing' }))).toBeNull();
    expect(stuckReason(but({ review: { ...base.review!, doneAt: undefined } }))).toBeNull();
    expect(stuckReason(but({ history: [...base.history, { at: base.updatedAt, status: 'review', by: 'auto', note: 'revisão automática não começou: x' }] }))).toBeNull();
  });

  it('uma entrega nova da tarefa legada usa o limite de agora (3): a revisão é pedida normalmente', async () => {
    const { b, t } = await stuckAtOldLimit('legado-nova-entrega');
    const asked = b.sent.filter((m) => m.staffId === 'rev-1').length;
    await b.svc.update('p', t.id, { status: 'doing' }); // o dono pediu ajuste
    await b.svc.onTurnDone('s-1'); // a Ana entrega de novo
    expect(b.sent.filter((m) => m.staffId === 'rev-1')).toHaveLength(asked + 1);
    expect(await b.get(t.id)).toMatchObject({ status: 'review', reviewRounds: 3 });
    expect(stuckReason(await b.get(t.id))).toBeNull(); // a revisão está em curso
  });
});

describe('revisão automática: o que muda no meio do caminho não recebe revisão, nota nem aviso', () => {
  /** Uma tarefa entregue e em revisão, com o `Task` como o `workDone` o entregaria à revisão automática. */
  async function delivered(name: string, by: string | null) {
    const b = board(name);
    const t = await b.make('Parecer', { by: by ?? undefined, reviewerId: null });
    await b.svc.start('p', t.id); // s-1
    b.texts.set('s-1', 'terminei');
    await b.finish('s-1'); // entrega sem revisor marcado: vai para "revisão" com `delivery` gravada, sem revisão automática
    // O revisor é marcado depois: a revisão automática só é pedida pelo `workDone`, e o teste a chama à mão com a entrega recém-gravada.
    b.edit((all) => (all[0]!.reviewerId = 'gio-1'));
    return { b, t };
  }
  const privately = (b: ReturnType<typeof board>) => b.svc as unknown as { autoReview: (projectId: string, task: Task) => Promise<void>; change: (...args: unknown[]) => Promise<unknown> };

  it('aprovada à mão (ou com entrega nova) enquanto a conversa do revisor abria: conflito, a conversa é silenciada e nada é gravado nem avisado ("entregou" seria falso)', async () => {
    for (const how of ['approved', 'new-delivery'] as const) {
      const { b, t } = await delivered(`auto-velha-${how}`, 'gio-1'); // quem pediu é quem revisa
      const snap = await b.get(t.id);
      expect(snap).toMatchObject({ status: 'review', reviewerId: 'gio-1' });
      const noticed = b.notified.length;
      b.hooks.beforeSend = async (staffId) => {
        if (staffId !== 'gio-1') return;
        if (how === 'approved') await b.svc.update('p', t.id, { status: 'done' });
        else b.edit((all) => (all[0]!.delivery.at = '2030-01-01T00:00:00.000Z'));
      };
      await privately(b).autoReview('p', snap);
      const after = await b.get(t.id);
      expect(b.sent.map((m) => m.staffId)).toEqual(['ana-1', 'gio-1']);
      expect(b.calls).toContain('interrupt:s-2'); // a conversa do revisor que abriu à toa é interrompida
      expect(after.review).toBeUndefined();
      expect(after.reviewRounds ?? 0).toBe(0);
      expect(after.history.some((h) => h.note?.includes('revisão automática não começou'))).toBe(false);
      expect(after.history.some((h) => h.note?.includes('revisão pedida'))).toBe(false);
      expect(b.notified.slice(noticed).some((n) => n.text.includes('entregou'))).toBe(false);
      expect(after.status).toBe(how === 'approved' ? 'done' : 'review');
    }
  });

  it('a entrega que motivou o pedido continua a mesma: a revisão é pedida e a rodada conta (o caminho normal não muda)', async () => {
    const { b, t } = await delivered('auto-igual', null);
    await privately(b).autoReview('p', await b.get(t.id));
    expect(await b.get(t.id)).toMatchObject({ status: 'review', reviewRounds: 1, review: { staffId: 'gio-1' } });
  });

  it('o pedido MANUAL da tela não exige a marca da entrega: segue como antes', async () => {
    const { b, t } = await delivered('manual-sem-marca', null);
    b.edit((all) => (all[0]!.delivery.at = '2030-01-01T00:00:00.000Z'));
    const out = await b.svc.requestReview('p', t.id, 'gio-1');
    expect(out).toMatchObject({ status: 'review', review: { staffId: 'gio-1' } });
  });

  it('no limite: cancelada (ou aprovada) depois da entrega, a nota do limite não é gravada e ninguém é avisado', async () => {
    for (const how of ['cancelled', 'approved'] as const) {
      const { b, t } = await delivered(`limite-corrida-${how}`, 'gio-1');
      b.edit((all) => (all[0]!.reviewRounds = AUTO_REVIEW_ROUNDS));
      const snap = await b.get(t.id);
      if (how === 'cancelled') await b.svc.cancel('p', t.id, { by: 'user' });
      else await b.svc.update('p', t.id, { status: 'done' });
      await b.settle();
      const history = (await b.get(t.id)).history.length;
      const noticed = b.notified.length;
      await privately(b).autoReview('p', snap);
      await b.settle();
      const after = await b.get(t.id);
      expect(after.history).toHaveLength(history);
      expect(after.history.some((h) => h.note?.includes('limite de'))).toBe(false);
      expect(b.notified).toHaveLength(noticed);
    }
  });

  it('no limite, sem corrida: a nota é gravada e quem pediu (e revisa) é avisado', async () => {
    const { b, t } = await delivered('limite-sem-corrida', 'gio-1');
    b.edit((all) => (all[0]!.reviewRounds = AUTO_REVIEW_ROUNDS));
    const noticed = b.notified.length;
    await privately(b).autoReview('p', await b.get(t.id));
    expect((await b.get(t.id)).history.at(-1)?.note).toContain(`limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas`);
    expect(b.notified.slice(noticed).map((n) => n.text)).toEqual([expect.stringContaining('o limite de 3 revisões automáticas foi atingido')]);
  });

  it('a revisão abriu mas a contagem da rodada falhou: o gestor não recebe "entregou" nem a nota de "não começou" (a revisão segue e avisa no desfecho)', async () => {
    const { b, t } = await delivered('auto-contagem-falha', 'gio-1');
    const svc = privately(b);
    const real = svc.change.bind(svc);
    // Só a gravação que sobe `reviewRounds` falha (o resto, inclusive a que anexa a revisão, é a de verdade).
    vi.spyOn(svc, 'change').mockImplementation(async (...args: unknown[]) => {
      const fn = args[2] as (t: Task, all: Task[]) => Task;
      let probe: Task | null = null;
      try {
        probe = fn({ history: [], reviewRounds: 41 } as unknown as Task, []);
      } catch {
        // outra gravação, que não aceita uma tarefa de mentira
      }
      if (probe?.reviewRounds === 42) throw new Error('disco cheio');
      return real(...args);
    });
    const noticed = b.notified.length;
    await privately(b).autoReview('p', await b.get(t.id));
    vi.restoreAllMocks();
    const after = await b.get(t.id);
    expect(after.review).toMatchObject({ staffId: 'gio-1', sessionId: 's-2' }); // a revisão abriu
    expect(after.history.some((h) => h.note?.includes('revisão automática não começou'))).toBe(false);
    expect(b.notified.slice(noticed).some((n) => n.text.includes('entregou'))).toBe(false);
  });

  it('a revisão falha de verdade (sem vaga no revisor): anota o motivo e quem pediu fica sabendo da entrega, como antes', async () => {
    const { b, t } = await delivered('auto-falha-real', 'gio-1');
    b.hooks.beforeSend = async () => {
      throw new Error('sem vaga no revisor');
    };
    const noticed = b.notified.length;
    await privately(b).autoReview('p', await b.get(t.id));
    expect((await b.get(t.id)).history.at(-1)?.note).toBe('revisão automática não começou: sem vaga no revisor');
    expect(b.notified.slice(noticed).map((n) => n.text)).toEqual([expect.stringContaining('entregou a tarefa')]);
  });

  it('responder pergunta por opções: cancelada na fila da vez dele, a resposta leva 409 e NÃO chega à pergunta da cancelada', async () => {
    const b = board('corrida-ask');
    const t = await b.make('Pergunta', { by: 'gio-1', reviewerId: null });
    await b.svc.start('p', t.id); // s-1
    await b.finish('s-1'); // a Ana fica livre (a tarefa vai para revisão, e a pergunta continua aberta na conversa dela)
    b.edit((all) => {
      all[0]!.question = { id: 'q-1', source: 'ask', questions: [{ question: 'Qual?', options: ['a', 'b'] }], status: 'open', askedAt: new Date().toISOString(), managerSession: 's-gio' };
    });
    b.openAsks.add('s-1:q-1');
    // A Ana fica ocupada com outra tarefa; o cancelamento entra na fila da vez dela, e a resposta atrás dele.
    const other = await b.make('Outra');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.hooks.beforeSend = async (staffId, text) => {
      if (staffId === 'ana-1' && text.includes('Outra')) await gate;
    };
    const started = b.svc.start('p', other.id);
    await b.settle();
    const cancelling = b.svc.cancel('p', t.id, { by: 'user' });
    await b.settle();
    const answering = b.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: 's-gio' }, { questionId: 'q-1', answers: { 'Qual?': 'a' } }).catch((e: unknown) => e);
    await b.settle();
    release();
    const [, , err] = await Promise.all([started, cancelling, answering]);
    expect(err).toBeInstanceOf(TaskConflictError);
    expect((err as Error).message).toMatch(/cancelada/);
    expect(b.askAnswers).toEqual([]); // a resposta não chegou à conversa
  });

  it('responder pergunta por opções, sem corrida: chega à conversa e fecha a dúvida', async () => {
    const b = board('ask-normal');
    const t = await b.make('Pergunta', { by: 'gio-1' });
    await b.svc.start('p', t.id); // s-1
    b.edit((all) => {
      all[0]!.question = { id: 'q-1', source: 'ask', questions: [{ question: 'Qual?', options: ['a', 'b'] }], status: 'open', askedAt: new Date().toISOString(), managerSession: 's-gio' };
    });
    b.openAsks.add('s-1:q-1');
    const out = await b.svc.answerQuestion('p', t.id, { staffId: 'gio-1', sessionId: 's-gio' }, { questionId: 'q-1', answers: { 'Qual?': 'a' } });
    expect(b.askAnswers).toEqual([{ sessionId: 's-1', requestId: 'q-1' }]);
    expect(out?.question).toMatchObject({ status: 'answered', answeredBy: 'manager' });
  });
});
