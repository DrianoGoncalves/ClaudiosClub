import { readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { resolveCaller, SessionTokens, type Engine } from '../server/callers';
import { TaskBusyError, TaskService, type TaskServiceDeps } from '../server/tasks';

// As rotas que esperam a vez do funcionário (`TaskService.locked`) respondem no prazo (`lockedWithDeadline`): estourou, 503 (TaskBusyError) e NADA gravado, nem quando a vez chegar
// depois; gravou, responde sucesso. E o log da vez presa diz quem a segura, em que operação e há quanto tempo, só com ids.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-lockdl-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) => ({ id, name, role: 'Back-end', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], ...over }) as unknown as StaffProfile;

const SECRET_TITLE = 'Titulo-confidencial-XPTO';
const SECRET_REASON = 'motivo-confidencial-XPTO';
const AT = '2026-11-19T10:00:00.000Z';

/** Gio é o gestor; Ana e Bia reportam a ele. `deadline`: o prazo das rotas (curto, para o teste não esperar). */
function board(dirName: string, deadline = 80) {
  const dir = path.join(root, dirName);
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'gio-1': person('gio-1', 'Gio', { role: 'Orquestrador' }),
    'ana-1': person('ana-1', 'Ana', { reportsTo: ['gio-1'] }),
    'bia-1': person('bia-1', 'Bia', { reportsTo: ['gio-1'] }),
  };
  const logs: string[] = [];
  const sentTo: Array<{ session: string; text: string }> = [];
  const notices: string[] = [];
  const answered: string[] = [];
  const working = new Map<string, string>();
  const hooks: { notice?: Promise<void>; sendTo?: Promise<void> } = {};
  let n = 0;
  const deps: TaskServiceDeps = {
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => {
      const session = `s-${++n}`;
      working.set(session, staffId);
      return session;
    },
    sendTo: async (_p, session, staffId, text) => {
      await hooks.sendTo;
      sentTo.push({ session, text });
      working.set(session, staffId);
      return session;
    },
    sendNotice: async (_p, session, _s, text) => {
      await hooks.notice;
      notices.push(text);
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => {
      const skip = new Set(Array.isArray(except) ? except : except ? [except] : []);
      return [...working].some(([s, who]) => who === staffId && !skip.has(s));
    },
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => true,
    answerAsk: (_s, requestId) => {
      answered.push(requestId);
      return true;
    },
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: (line) => void logs.push(line),
    lockDeadlineMs: deadline,
  };
  const svc = new TaskService(deps);
  /** Cria sem começar (Aguardar), pedida por Gio; `by: null` = pela tela. Sem revisor automático. */
  const make = async (title: string, o: { staff?: string; by?: string | null; blockedBy?: string[] } = {}) =>
    (await svc.create(
      'p',
      { title, staffId: o.staff ?? 'ana-1', start: false, description: `desc de ${title}`, acceptance: `critério de ${title}`, reviewerId: null, ...(o.blockedBy && { blockedBy: o.blockedBy }) },
      o.by === undefined ? 'gio-1' : o.by,
      'c-gio-1',
    ))!;
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  /** Cria e começa (Ana livre: vai direto para fazendo, com conversa). */
  const started = async (title: string) => {
    const t = await make(title);
    await svc.start('p', t.id);
    return get(t.id);
  };
  const raw = () => readFileSync(file, 'utf8');
  /** Muda o arquivo à mão: o que o fluxo do funcionário gravaria (um ajuste guardado, uma dúvida aberta). */
  const edit = (id: string, fn: (t: Record<string, any>) => void) => {
    const all = JSON.parse(raw()) as Array<Record<string, any>>;
    fn(all.find((t) => t.id === id)!);
    writeFileSync(file, JSON.stringify(all, null, 2));
  };
  const tokens = new SessionTokens();
  /** Quem chama, pelo token da conversa dele. */
  const as = (staffId: string, o: { session?: string; engine?: Engine } = {}) => {
    const token = tokens.issue({ staffId, projectId: 'p', sessionId: o.session ?? `c-${staffId}`, engine: o.engine ?? 'claude' });
    const r = resolveCaller(false, token, tokens);
    return r.ok ? r.caller : null;
  };
  const worker = (t: Task) => as('ana-1', { session: t.sessionId! });
  /** Segura a vez do funcionário (como quem abre uma conversa ou entrega) até `release()`. */
  const hold = async (staffId = 'ana-1', op = 'entrega t-seguro') => {
    let release!: () => void;
    const job = (svc as unknown as { locked: (p: string, s: string, op: string, fn: () => Promise<void>) => Promise<void> }).locked('p', staffId, op, () => new Promise<void>((r) => (release = r)));
    await new Promise((r) => setTimeout(r, 5));
    return () => {
      release();
      return job;
    };
  };
  const attempt = <T>(p: Promise<T>) => p.then((v) => v as T | unknown, (e: unknown) => e);
  const lockState = () => (svc as unknown as { lockState: Map<string, unknown> }).lockState;
  /** Espera o que ficou na fila da vez (um `kick` que sobrou) terminar, para o teste não deixar escrita em segundo plano na pasta. */
  const settle = async () => {
    for (let i = 0; i < 100 && lockState().size; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 40));
  };
  return { svc, dir, logs, sentTo, notices, answered, hooks, make, started, get, raw, edit, as, worker, hold, attempt, settle, lockState };
}
type Board = ReturnType<typeof board>;

/** Cada rota que espera a vez: prepara o cenário (com a vez livre) e devolve a chamada, e o id de operação que o log mostra. */
const SCENARIOS: Array<{ name: string; prepare: (b: Board) => Promise<{ id: string; op: string; call: () => Promise<unknown> }> }> = [
  {
    name: 'cancelar por quem pediu, tarefa que nunca começou (cancelFrom)',
    prepare: async (b) => {
      const t = await b.make(SECRET_TITLE);
      return { id: t.id, op: `cancelar ${t.id}`, call: () => b.svc.cancelFrom('p', t.id, b.as('gio-1'), SECRET_REASON) };
    },
  },
  {
    name: 'cancelar pelo responsável, com a conversa da tarefa (cancelFrom)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      return { id: t.id, op: `cancelar ${t.id}`, call: () => b.svc.cancelFrom('p', t.id, b.worker(t), SECRET_REASON) };
    },
  },
  {
    name: 'cancelar pela tela (cancel com deadline)',
    prepare: async (b) => {
      const t = await b.make(SECRET_TITLE);
      return { id: t.id, op: `cancelar ${t.id}`, call: () => b.svc.cancel('p', t.id, { by: 'user', reason: SECRET_REASON, deadline: true }) };
    },
  },
  {
    name: 'cancelar a dependente de uma cancelada, pela tela (resolveCancelledBlocker "cancel")',
    prepare: async (b) => {
      const blocker = await b.make('Bloqueadora', { by: null, staff: 'bia-1' });
      const dep = await b.make(SECRET_TITLE, { blockedBy: [blocker.id] });
      await b.svc.cancel('p', blocker.id, { by: 'user' });
      return { id: dep.id, op: `cancelar ${dep.id}`, call: () => b.svc.resolveCancelledBlocker('p', dep.id, blocker.id, 'cancel', undefined, { deadline: true }) };
    },
  },
  {
    name: 'pedir o cancelamento (requestCancel)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      return { id: t.id, op: `pedir-cancelamento ${t.id}`, call: () => b.svc.requestCancel('p', t.id, b.as('gio-1'), SECRET_REASON) };
    },
  },
  {
    name: 'recusar o pedido de cancelamento (refuseCancel)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'pedido de antes');
      expect((await b.get(t.id)).cancelRequest?.status).toBe('pending');
      return { id: t.id, op: `recusar-cancelamento ${t.id}`, call: () => b.svc.refuseCancel('p', t.id, b.worker(t), SECRET_REASON) };
    },
  },
  {
    name: 'excluir o ajuste guardado (discardHeld)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      b.edit(t.id, (x) => (x.held = [{ id: 'h1', at: AT, text: 'ajuste', reason: 'espera a Ana' }]));
      return { id: t.id, op: `excluir-ajuste ${t.id}`, call: () => b.svc.discardHeld('p', t.id, 'h1', true) };
    },
  },
  {
    name: 'responder a dúvida escrita (answerQuestion)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      b.edit(t.id, (x) => (x.question = { id: 'q1', source: 'text', status: 'open', askedAt: AT, text: 'posso apagar?' }));
      return { id: t.id, op: `responder-duvida ${t.id}`, call: () => b.svc.answerQuestion('p', t.id, null, { questionId: 'q1', text: 'pode apagar' }, true) };
    },
  },
  {
    name: 'responder a pergunta por opções (answerQuestion)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      b.edit(t.id, (x) => (x.question = { id: 'q1', source: 'ask', status: 'open', askedAt: AT, questions: [{ question: 'Qual banco?', options: ['Postgres', 'MySQL'] }] }));
      return { id: t.id, op: `responder-duvida ${t.id}`, call: () => b.svc.answerQuestion('p', t.id, null, { questionId: 'q1', answers: { 'Qual banco?': 'Postgres' } }, true) };
    },
  },
  {
    name: 'mandar revisar o card sem código (reviewAnyway)',
    prepare: async (b) => {
      const t = await b.started(SECRET_TITLE);
      b.edit(t.id, (x) => (x.noCode = { since: AT, to: 'manager', summary: 'Li o código: não há o que editar.' }));
      return { id: t.id, op: `entrega ${t.id}`, call: () => b.svc.reviewAnyway('p', t.id, null, true) };
    },
  },
];

describe('rota que espera a vez: vez presa responde 503 no prazo e não grava (nem depois)', () => {
  it.each(SCENARIOS)('$name', async ({ name, prepare }) => {
    const b = board(`presa-${name.replace(/\W+/g, '-').slice(0, 40)}`);
    const { id, op, call } = await prepare(b);
    await b.settle(); // o que o preparo deixou em segundo plano (o aviso a quem esperava a cancelada) termina antes da foto do arquivo
    const before = b.raw();
    const sentBefore = b.sentTo.length;
    const noticesBefore = b.notices.length;
    const release = await b.hold();
    const at = Date.now();
    const err = await b.attempt(call());
    expect(err).toBeInstanceOf(TaskBusyError);
    expect((err as Error).message).toContain('NÃO foi');
    expect(Date.now() - at).toBeLessThan(1500);
    expect(b.raw()).toBe(before);

    // A vez que chega depois do 503 desiste: não grava, não manda à conversa, não avisa ninguém.
    await release();
    await b.settle();
    expect(b.raw()).toBe(before);
    expect(b.sentTo).toHaveLength(sentBefore);
    expect(b.notices).toHaveLength(noticesBefore);
    expect(b.answered).toEqual([]);

    // Uma linha no log, com quem segura a vez, a operação e há quanto tempo.
    const stuck = b.logs.filter((l) => l.includes('não chegou em'));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toContain(`[tarefas] ${op}: a vez de ana-1 (projeto p) não chegou em 80 ms`);
    expect(stuck[0]).toMatch(/quem segura: entrega t-seguro há \d+ ms, 1 na fila; recusada sem gravar/);
    expect(id).toMatch(/^t-/);
  });

  it('livre a vez, a mesma chamada passa (o 503 não deixou marca)', async () => {
    const b = board('presa-depois');
    const t = await b.make(SECRET_TITLE);
    const release = await b.hold();
    expect(await b.attempt(b.svc.cancelFrom('p', t.id, b.as('gio-1'), SECRET_REASON))).toBeInstanceOf(TaskBusyError);
    await release();
    const out = (await b.svc.cancelFrom('p', t.id, b.as('gio-1'), SECRET_REASON)) as Task;
    expect(out).toMatchObject({ status: 'cancelled', cancelReason: SECRET_REASON });
    expect(b.logs.filter((l) => l.includes('não chegou em'))).toHaveLength(1);
  });
});

describe('o log da vez presa: só ids', () => {
  it('nem o título, nem o motivo, nem o texto da tarefa aparecem; a vez livre não escreve nada', async () => {
    const b = board('log-ids');
    const t = await b.make(SECRET_TITLE);
    const release = await b.hold();
    await b.attempt(b.svc.cancelFrom('p', t.id, b.as('gio-1'), SECRET_REASON));
    const text = b.logs.join('\n');
    expect(text).toContain(t.id);
    expect(text).not.toContain('XPTO');
    await release();
    const quiet = board('log-livre');
    const free = await quiet.make('Outra');
    await quiet.svc.cancelFrom('p', free.id, quiet.as('gio-1'), 'não precisa mais');
    expect(quiet.logs).toEqual([]);
  });

  it('com a vez livre mas a operação demorando (a fila do arquivo), diz que ninguém a segura', async () => {
    const b = board('log-ninguem', 40);
    const t = await b.make(SECRET_TITLE);
    const rename = fs.rename.bind(fs);
    const slow = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await new Promise((r) => setTimeout(r, 200));
      return rename(...args);
    });
    try {
      // O cancelamento já decidiu gravar (ponto sem volta): responde sucesso mesmo com o arquivo lento.
      const out = (await b.svc.cancelFrom('p', t.id, b.as('gio-1'), 'não precisa mais')) as Task;
      expect(out.status).toBe('cancelled');
    } finally {
      slow.mockRestore();
    }
    expect(b.logs).toEqual([]);
  });

  it('a vez volta a ficar livre: nada de estado sobrando por funcionário', async () => {
    const b = board('log-limpa');
    const release = await b.hold();
    expect(b.lockState().size).toBe(1);
    await release();
    await b.settle();
    expect(b.lockState().size).toBe(0);
  });
});

describe('o que gravou responde sucesso, mesmo passado o prazo', () => {
  it('o cancelamento decidiu gravar e o arquivo demora além do prazo: 200 com a tarefa cancelada, e nada foi recusado', async () => {
    const b = board('gravando', 60);
    const t = await b.make(SECRET_TITLE);
    const rename = fs.rename.bind(fs);
    const slow = vi.spyOn(fs, 'rename').mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
      await new Promise((r) => setTimeout(r, 250));
      return rename(...args);
    });
    try {
      const out = await b.attempt(b.svc.cancelFrom('p', t.id, b.as('gio-1'), 'não precisa mais'));
      expect(out).toMatchObject({ status: 'cancelled' });
    } finally {
      slow.mockRestore();
    }
    expect((await b.get(t.id)).status).toBe('cancelled');
    expect(b.logs.filter((l) => l.includes('não chegou em'))).toEqual([]);
  });

  it('a resposta à dúvida já começou a ser enviada quando o prazo passa: não vira 503, chega uma vez só e fecha a dúvida', async () => {
    const b = board('resposta-enviando', 60);
    const t = await b.started(SECRET_TITLE);
    b.edit(t.id, (x) => (x.question = { id: 'q1', source: 'text', status: 'open', askedAt: AT, text: 'posso apagar?' }));
    let release!: () => void;
    b.hooks.sendTo = new Promise<void>((r) => (release = r));
    const answering = b.attempt(b.svc.answerQuestion('p', t.id, null, { questionId: 'q1', text: 'pode apagar' }, true));
    await new Promise((r) => setTimeout(r, 200)); // passou o prazo (60 ms) com o envio na mão
    release();
    expect(await answering).toMatchObject({ question: { id: 'q1', status: 'answered' } });
    expect(b.sentTo).toHaveLength(1);
    expect(b.sentTo[0]!.text).toContain('pode apagar');
    expect(b.logs.filter((l) => l.includes('não chegou em'))).toEqual([]);
  });
});

describe('quem chama por dentro não ganha prazo', () => {
  it('cancel sem `deadline` (a cascata, o caminho interno) espera a vez de sempre e grava quando ela chega', async () => {
    const b = board('interno', 40);
    const t = await b.make(SECRET_TITLE);
    const release = await b.hold();
    let done = false;
    const cancelling = b.svc.cancel('p', t.id, { by: 'user' }).then((x) => ((done = true), x));
    await new Promise((r) => setTimeout(r, 200)); // bem além do prazo de 40 ms
    expect(done).toBe(false);
    expect((await b.get(t.id)).status).toBe('waiting');
    await release();
    expect(await cancelling).toMatchObject({ status: 'cancelled' });
    expect(b.logs.filter((l) => l.includes('não chegou em'))).toEqual([]);
  });
});

describe('depois de gravar, a resposta também não espera a vez presa', () => {
  it('requestCancel: o pedido grava e a entrega à conversa dele está presa; a resposta sai no prazo com o pedido pendente, e a entrega termina depois', async () => {
    const b = board('pedido-entrega-presa', 150);
    const t = await b.started(SECRET_TITLE);
    let release!: () => void;
    b.hooks.notice = new Promise<void>((r) => (release = r));
    const at = Date.now();
    const out = (await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário mudou de ideia')) as Task;
    expect(Date.now() - at).toBeLessThan(1500);
    expect(out.cancelRequest).toMatchObject({ status: 'pending', by: 'gio-1' });
    expect(out.cancelRequest?.deliveredAt).toBeUndefined();
    release();
    await b.settle();
    expect((await b.get(t.id)).cancelRequest?.deliveredAt).toBeTruthy();
    expect(b.notices).toHaveLength(1);
  });

  it('resendHeld: a vez presa não deixa a tela sem resposta; o ajuste já está liberado para tentar de novo', async () => {
    const b = board('reenviar-presa', 100);
    const t = await b.started(SECRET_TITLE);
    b.edit(t.id, (x) => (x.held = [{ id: 'h1', at: AT, text: 'ajuste', reason: 'espera a Ana', attempts: 2, nextAt: '2099-01-01T00:00:00.000Z' }]));
    const release = await b.hold();
    const at = Date.now();
    const out = (await b.svc.resendHeld('p', t.id, true)) as Task;
    expect(Date.now() - at).toBeLessThan(1500);
    expect(out.held?.[0]?.attempts).toBeUndefined();
    expect(out.held?.[0]?.nextAt).toBeUndefined();
    await release();
    await b.settle();
  });
});
