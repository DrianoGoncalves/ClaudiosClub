import { readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile, Task, TaskCreateResult } from '../shared/model';
import { resolveCaller, SessionTokens, type Engine } from '../server/callers';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import { TaskConflictError, TaskError, TaskForbiddenError, TaskService, reasonRequest, type TaskServiceDeps } from '../server/tasks';

// Solicitante cancela a tarefa que nunca começou; a que já começou ele pede ao responsável, que decide; criar com chave de idempotência
// (retry não duplica) e a resposta do POST que gravou mas não conseguiu começar.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cancelreq-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) =>
  ({ id, name, role: id.startsWith('gio') ? 'Orquestrador' : 'Back-end', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], ...over }) as unknown as StaffProfile;

/** Gio é o gestor; Ana e Bia reportam a ele; Rui é revisor e Dev é de fora. `workerEngine`: o motor de Ana. */
function board(dirName: string, o: { workerEngine?: Engine } = {}) {
  const dir = path.join(root, dirName);
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'gio-1': person('gio-1', 'Gio'),
    'ana-1': person('ana-1', 'Ana', { reportsTo: ['gio-1'], engine: o.workerEngine ?? 'claude' }),
    'bia-1': person('bia-1', 'Bia', { reportsTo: ['gio-1'] }),
    'dev-1': person('dev-1', 'Dev'),
    'rev-1': person('rev-1', 'Rui'),
  };
  const sent: Array<{ staffId: string; text: string; session: string }> = [];
  const notices: Array<{ session: string; staffId: string; text: string }> = [];
  const notified: Array<{ staffId: string; text: string; session: string | null }> = [];
  const working = new Map<string, string>();
  const hooks: { beforeSend?: (staffId: string, text: string) => Promise<void>; noticeFails?: boolean; notifyFails?: boolean } = {};
  let n = 0;
  const deps: TaskServiceDeps = {
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
    sendTo: async (_p, sessionId, staffId) => {
      working.set(sessionId, staffId);
      return sessionId;
    },
    sendNotice: async (_p, session, staffId, text) => {
      if (hooks.noticeFails) throw new Error('conversa fechando');
      notices.push({ session, staffId, text });
      return session;
    },
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => {
      const skip = new Set(Array.isArray(except) ? except : except ? [except] : []);
      return [...working].some(([s, who]) => who === staffId && !skip.has(s));
    },
    lastText: () => null,
    notify: async (_p, staffId, text, session) => {
      if (hooks.notifyFails) throw new Error('conversa dele não abriu');
      notified.push({ staffId, text, session: session ?? null });
    },
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: () => {},
  };
  const svc = new TaskService(deps);
  const finish = async (session: string) => {
    const who = working.get(session) ?? 'ana-1';
    working.delete(session);
    await svc.onIdle(session, 'p', who);
    await svc.onTurnDone(session);
  };
  /** Cria sem começar (Aguardar), pedida por Gio (conversa `c-gio-1`); `by: null` = pela tela. Sem revisor automático. */
  const make = async (title: string, o: { staff?: string; by?: string | null; key?: string; start?: boolean } = {}) =>
    (await svc.create(
      'p',
      { title, staffId: o.staff ?? 'ana-1', start: o.start ?? false, description: `desc de ${title}`, acceptance: `critério de ${title}`, reviewerId: null, ...(o.key && { idempotencyKey: o.key }) },
      o.by === undefined ? 'gio-1' : o.by,
      'c-gio-1',
    ))!;
  /** Cria e começa (Ana livre: vai direto para fazendo, com conversa). */
  const started = async (title: string, o: { staff?: string } = {}) => {
    const t = await make(title, o);
    await svc.start('p', t.id);
    return get(t.id);
  };
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const settle = () => new Promise((r) => setTimeout(r, 25));
  const raw = () => readFileSync(file, 'utf8');
  /** Muda o arquivo à mão: o que outro caminho (a tela, o tempo) faria no meio. */
  const edit = (fn: (tasks: Array<Record<string, any>>) => void) => {
    const all = JSON.parse(raw()) as Array<Record<string, any>>;
    fn(all);
    writeFileSync(file, JSON.stringify(all, null, 2));
  };
  const tokens = new SessionTokens();
  /** Quem chama, pelo token da conversa dele (`session`: a conversa; o responsável fala pela da tarefa). */
  const as = (staffId: string | null, o: { project?: string; session?: string; engine?: Engine; sandbox?: boolean } = {}) => {
    const token = tokens.issue({ staffId, projectId: o.project ?? 'p', sessionId: o.session ?? `c-${staffId}-${o.project ?? 'p'}`, engine: o.engine ?? 'claude' });
    const r = resolveCaller(!!o.sandbox, token, tokens);
    return r.ok ? r.caller : null;
  };
  const worker = (t: Task) => as('ana-1', { session: t.sessionId! });
  const attempt = <T>(p: Promise<T>) => p.then((v) => v as T | unknown, (e: unknown) => e);
  return { svc, deps, dir, file, sent, notices, notified, working, hooks, finish, make, started, list, get, settle, raw, edit, as, worker, attempt, people };
}

describe('idempotência na criação', () => {
  it('mesma chave e mesmo conteúdo devolvem a tarefa de antes, sem criar nem começar de novo', async () => {
    const b = board('idem-replay');
    const body = { title: 'Exportar CSV', description: 'o pedido', acceptance: 'abre no Excel', staffId: 'ana-1', start: true, idempotencyKey: 'exportar-csv-a1b2' };
    const first = await b.svc.createAndStart('p', body, 'gio-1', 'c-gio-1', { start: true });
    expect(first).toMatchObject({ title: 'Exportar CSV', status: 'doing', requestedBy: 'gio-1' });
    expect(first?.idempotentReplay).toBeUndefined();
    expect(b.sent).toHaveLength(1);

    const retry = await b.svc.createAndStart('p', body, 'gio-1', 'c-gio-1', { start: true });
    expect(retry).toMatchObject({ id: first!.id, idempotentReplay: true, status: 'doing' });
    expect(await b.list()).toHaveLength(1);
    expect(b.sent).toHaveLength(1); // não abriu outra conversa
    // Espaço e quebra de linha a mais no texto são o mesmo conteúdo (o servidor normaliza antes da impressão).
    const spaced = await b.svc.create('p', { ...body, title: '  Exportar CSV  ' }, 'gio-1');
    expect(spaced).toMatchObject({ id: first!.id, idempotentReplay: true });
  });

  it('o retry de uma tarefa já cancelada também devolve a mesma (não a ressuscita)', async () => {
    const b = board('idem-cancelada');
    const t = await b.make('Exportar CSV', { key: 'exportar-csv-a1b2' });
    await b.svc.cancelFrom('p', t.id, b.as('gio-1'), 'engano');
    const retry = await b.make('Exportar CSV', { key: 'exportar-csv-a1b2' });
    expect(retry).toMatchObject({ id: t.id, idempotentReplay: true, status: 'cancelled' });
    expect(await b.list()).toHaveLength(1);
  });

  it('mesma chave com conteúdo diferente = 409 e nada é criado', async () => {
    const b = board('idem-409');
    const dep = await b.make('Antes');
    const base = { title: 'Exportar CSV', description: 'o pedido', acceptance: 'abre no Excel', goal: 'o financeiro pediu', staffId: 'ana-1', reviewerId: null, blockedBy: [] as string[], start: false, idempotencyKey: 'exportar-csv-a1b2' };
    const t = (await b.svc.create('p', base, 'gio-1'))!;
    const before = b.raw();
    // Cada campo do conteúdo, sozinho, já é outro pedido (rascunho também não é o mesmo pedido que "começar").
    const variants: Array<Partial<typeof base>> = [
      { title: 'Exportar XLSX' },
      { description: 'outro texto' },
      { acceptance: 'abre no Numbers' },
      { goal: 'outro porquê' },
      { staffId: 'bia-1' },
      { reviewerId: 'rev-1' as unknown as null },
      { blockedBy: [dep.id] },
      { start: true },
    ];
    for (const v of variants) {
      const err = await b.attempt(b.svc.create('p', { ...base, ...v }, 'gio-1'));
      expect(err, JSON.stringify(v)).toBeInstanceOf(TaskConflictError);
      expect((err as Error).message).toContain(t.id);
    }
    expect(b.raw()).toBe(before);
    // O mesmo pedido com espaço a mais no título segue sendo o mesmo (a impressão é do conteúdo já normalizado).
    expect(await b.svc.create('p', { ...base, title: ' Exportar CSV ' }, 'gio-1')).toMatchObject({ id: t.id, idempotentReplay: true });
  });

  it('a chave vale por solicitante: outro gestor (ou a tela) com a mesma chave cria a sua', async () => {
    const b = board('idem-escopo');
    const a = await b.make('Exportar CSV', { key: 'exportar-csv-a1b2' });
    const da_tela = await b.make('Exportar CSV', { key: 'exportar-csv-a1b2', by: null });
    expect(da_tela.id).not.toBe(a.id);
    expect(da_tela.idempotentReplay).toBeUndefined();
    expect(await b.list()).toHaveLength(2);
    // E a da tela se repete para ela mesma.
    expect(await b.make('Exportar CSV', { key: 'exportar-csv-a1b2', by: null })).toMatchObject({ id: da_tela.id, idempotentReplay: true });
  });

  it('dois pedidos juntos com a mesma chave criam uma tarefa só', async () => {
    const b = board('idem-juntos');
    const [x, y] = await Promise.all([b.make('Exportar CSV', { key: 'exportar-csv-a1b2' }), b.make('Exportar CSV', { key: 'exportar-csv-a1b2' })]);
    expect(x.id).toBe(y.id);
    expect([x.idempotentReplay, y.idempotentReplay].filter(Boolean)).toHaveLength(1);
    expect(await b.list()).toHaveLength(1);
  });

  it('chave fora do formato é 400; sem chave, tudo como antes (cada pedido cria uma tarefa)', async () => {
    const b = board('idem-formato');
    for (const key of ['curta', 'com espaço aqui', 'a'.repeat(101), 'acento-ção-aqui']) {
      const err = await b.attempt(b.svc.create('p', { title: 'X', staffId: 'ana-1', start: false, idempotencyKey: key }, 'gio-1'));
      expect(err, key).toBeInstanceOf(TaskError);
      expect(err, key).not.toBeInstanceOf(TaskConflictError);
    }
    await b.make('Mesmo pedido');
    await b.make('Mesmo pedido');
    expect(await b.list()).toHaveLength(2);
  });

  it('o retry não depende do que mudou depois: a ficha do responsável sumiu e a chave ainda devolve a tarefa', async () => {
    const b = board('idem-ficha');
    const t = await b.make('Exportar CSV', { key: 'exportar-csv-a1b2' });
    delete b.people['ana-1'];
    expect(await b.make('Exportar CSV', { key: 'exportar-csv-a1b2' })).toMatchObject({ id: t.id, idempotentReplay: true });
    // Sem chave, o mesmo pedido agora falha (o responsável não existe).
    expect(await b.attempt(b.make('Exportar CSV'))).toBeInstanceOf(TaskError);
  });
});

describe('aviso de possível duplicata', () => {
  it('título parecido do mesmo solicitante ao mesmo responsável há pouco: avisa e cria mesmo assim (retry com outra chave, por exemplo)', async () => {
    const b = board('dup-aviso');
    const first = await b.make('Exportar relatório de vendas em CSV', { key: 'exportar-vendas-a1' });
    const second = await b.make('Exportar relatório de vendas em CSV!', { key: 'exportar-vendas-b2' });
    expect(second.id).not.toBe(first.id);
    expect(second.idempotentReplay).toBeUndefined();
    expect(second.warnings).toHaveLength(1);
    expect(second.warnings![0]).toMatchObject({ code: 'possible-duplicate', taskId: first.id, title: first.title, status: 'waiting' });
    expect(second.warnings![0]!.message).toContain('idempotencyKey');
    expect(await b.list()).toHaveLength(2); // só aviso: a segunda existe
    expect(b.raw()).not.toContain('"warnings"'); // derivado, não gravado
    // O mesmo título com acréscimo (as palavras do menor estão no maior) também é parecido.
    const third = await b.make('Exportar relatório de vendas em XLSX e CSV');
    expect(third.warnings?.map((w) => w.taskId).sort()).toEqual([first.id, second.id].sort());
  });

  it('sem aviso: título diferente, outro responsável, outro solicitante, a tela, ou fora da janela de minutos', async () => {
    const b = board('dup-sem');
    const first = await b.make('Exportar relatório de vendas em CSV');
    expect((await b.make('Corrigir o login do admin')).warnings).toBeUndefined();
    expect((await b.make('Exportar relatório de vendas em CSV', { staff: 'bia-1' })).warnings).toBeUndefined();
    expect((await b.make('Exportar relatório de vendas em CSV', { by: null })).warnings).toBeUndefined();
    // Passou da janela (11 min): já não é "há pouco".
    b.edit((all) => {
      all.find((t) => t.id === first.id)!.createdAt = new Date(Date.now() - 11 * 60_000).toISOString();
    });
    expect((await b.make('Exportar relatório de vendas em CSV')).warnings).toBeUndefined();
  });

  it('o POST (createAndStart) leva o aviso na resposta, mesmo depois de começar', async () => {
    const b = board('dup-post');
    await b.make('Exportar relatório de vendas em CSV');
    const out = await b.svc.createAndStart('p', { title: 'Exportar relatório de vendas em CSV', staffId: 'ana-1', start: true, description: 'x' }, 'gio-1', 'c-gio-1', { start: true });
    expect(out).toMatchObject({ status: 'doing' });
    expect(out!.warnings).toHaveLength(1);
  });
});

describe('POST que grava e falha ao começar', () => {
  it('devolve a tarefa gravada com startError (não a falha); o retry com a mesma chave devolve a mesma, sem começar', async () => {
    const b = board('post-falha');
    let calls = 0;
    b.hooks.beforeSend = async () => {
      calls++;
      throw new Error('worktree quebrada');
    };
    const body = { title: 'Exportar CSV', description: 'o pedido', staffId: 'ana-1', start: true, idempotencyKey: 'exportar-csv-a1b2' };
    const out = (await b.svc.createAndStart('p', body, 'gio-1', 'c-gio-1', { start: true })) as TaskCreateResult;
    expect(out).toMatchObject({ title: 'Exportar CSV', status: 'todo', sessionId: null, startError: 'worktree quebrada', requestedBy: 'gio-1' });
    expect(out.id).toMatch(/^t-/);
    const all = await b.list();
    expect(all).toHaveLength(1); // gravou: não é "tarefa que não existe"
    expect(all[0]!.id).toBe(out.id);
    expect(b.raw()).not.toContain('startError');
    expect(calls).toBe(1);

    const retry = await b.svc.createAndStart('p', body, 'gio-1', 'c-gio-1', { start: true });
    expect(retry).toMatchObject({ id: out.id, idempotentReplay: true });
    expect(retry?.startError).toBeUndefined();
    expect(calls).toBe(1); // não tentou começar de novo
    expect(await b.list()).toHaveLength(1);
  });

  it('falha antes de gravar (ficha do responsável inexistente) continua sendo erro: nada foi gravado', async () => {
    const b = board('post-antes');
    const err = await b.attempt(b.svc.createAndStart('p', { title: 'X', staffId: 'nao-existe', start: true }, 'gio-1', 'c-gio-1', { start: true }));
    expect(err).toBeInstanceOf(TaskError);
    expect(await b.list()).toHaveLength(0);
  });

  it('sem start (rascunho) ou com sucesso, a resposta é a tarefa de sempre, sem startError', async () => {
    const b = board('post-ok');
    const draft = await b.svc.createAndStart('p', { title: 'Rascunho', staffId: 'ana-1', start: false }, 'gio-1', 'c-gio-1', { start: false });
    expect(draft).toMatchObject({ status: 'waiting' });
    expect(draft?.startError).toBeUndefined();
    const run = await b.svc.createAndStart('p', { title: 'Vai', staffId: 'ana-1', start: true }, 'gio-1', 'c-gio-1', { start: true });
    expect(run).toMatchObject({ status: 'doing' });
    expect(run?.startError).toBeUndefined();
  });
});

describe('quem pediu cancela a tarefa que nunca começou', () => {
  it('cancela em Aguardar e em A fazer (na fila), com o dono do token e o motivo; quem pediu não recebe aviso do próprio cancelamento', async () => {
    const b = board('nunca-comecou');
    const draft = await b.make('Rascunho');
    const out = (await b.svc.cancelFrom('p', draft.id, b.as('gio-1'), 'não é mais preciso')) as Task;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'gio-1', cancelReason: 'não é mais preciso' });
    expect(out.history.at(-1)).toMatchObject({ status: 'cancelled', by: 'auto', note: 'cancelada: não é mais preciso' });

    // Na fila de Ana (ocupada com outra): continua "nunca começou".
    await b.started('Ocupa a Ana');
    const queued = await b.make('Na fila');
    await b.svc.start('p', queued.id);
    expect(await b.get(queued.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect(await b.get(queued.id)).toHaveProperty('queuedAt');
    expect(await b.svc.cancelFrom('p', queued.id, b.as('gio-1'), 'vou refazer o pedido')).toMatchObject({ status: 'cancelled' });
    expect((await b.get(queued.id)).queuedAt ?? null).toBeNull();
    expect(b.notified).toHaveLength(0); // ele sabe: a resposta do pedido dele diz
    expect(b.notices).toHaveLength(0); // ninguém foi acordado
  });

  it('a identidade é o token: o `requestedBy` do corpo não vale, e responsável sem conversa, par, revisor, de fora, sem token ou token de outro projeto levam 403', async () => {
    const b = board('identidade');
    const t = await b.make('Rascunho');
    const before = b.raw();
    const cases: Array<[string, ReturnType<typeof b.as>]> = [
      ['o responsável (sem conversa ainda)', b.as('ana-1')],
      ['um par', b.as('bia-1')],
      ['o revisor', b.as('rev-1')],
      ['um de fora', b.as('dev-1')],
      ['sem token', null],
      ['conversa sem ficha', b.as(null)],
      ['token de outro projeto', b.as('gio-1', { project: 'q' })],
    ];
    for (const [quem, caller] of cases) {
      const err = await b.attempt(b.svc.cancelFrom('p', t.id, caller, 'quero cancelar'));
      expect(err, quem).toBeInstanceOf(TaskForbiddenError);
    }
    expect(b.raw()).toBe(before);
    // Pelo Codex (sandbox) vale como qualquer outro: o dono do token.
    expect(await b.attempt(b.svc.cancelFrom('p', t.id, b.as('dev-1', { engine: 'codex', sandbox: true }), 'x'))).toBeInstanceOf(TaskForbiddenError);
    expect(await b.svc.cancelFrom('p', t.id, b.as('gio-1', { engine: 'codex', sandbox: true }), 'x')).toMatchObject({ status: 'cancelled' });
  });

  it('o motivo é obrigatório (400, sem gravar)', async () => {
    const b = board('motivo');
    const t = await b.make('Rascunho');
    const before = b.raw();
    for (const reason of [undefined, null, '', '   \n ']) {
      const err = await b.attempt(b.svc.cancelFrom('p', t.id, b.as('gio-1'), reason as string | undefined));
      expect(err, String(reason)).toBeInstanceOf(TaskError);
      expect(err, String(reason)).not.toBeInstanceOf(TaskForbiddenError);
      expect(err, String(reason)).not.toBeInstanceOf(TaskConflictError);
    }
    expect(b.raw()).toBe(before);
    expect(() => reasonRequest({}, 'do pedido')).toThrow(TaskError);
    expect(() => reasonRequest({ reason: '  ' }, 'do pedido')).toThrow(TaskError);
    expect(reasonRequest({ reason: '  por   quê\nsim ' }, 'do pedido')).toBe('por quê sim');
  });

  it('recusa (409) se já começou: com conversa, Aguardar com conversa (parada no limite), A fazer reaberta; e se já está encerrada', async () => {
    const b = board('ja-comecou');
    const doing = await b.started('Fazendo');
    expect(doing.sessionId).toBeTruthy();
    const err = (await b.attempt(b.svc.cancelFrom('p', doing.id, b.as('gio-1'), 'desisti'))) as Error;
    expect(err).toBeInstanceOf(TaskConflictError);
    expect(err.message).toContain(`/tasks/${doing.id}/cancel-request`); // diz o caminho certo
    expect(await b.get(doing.id)).toMatchObject({ status: 'doing' });

    // Aguardar não quer dizer "nunca começou": parada no limite, a tarefa guarda a conversa.
    const parked = await b.started('Parada', { staff: 'bia-1' });
    b.edit((all) => {
      all.find((t) => t.id === parked.id)!.status = 'waiting';
    });
    expect(await b.attempt(b.svc.cancelFrom('p', parked.id, b.as('gio-1'), 'desisti'))).toBeInstanceOf(TaskConflictError);

    // Sem a conversa agora, mas com o histórico de que trabalhou (cancelada pela tela e reaberta): também começou.
    const reopened = await b.started('Reaberta', { staff: 'dev-1' });
    expect(reopened.sessionId).toBeTruthy();
    await b.svc.cancel('p', reopened.id, { by: 'user' });
    await b.svc.reopen('p', reopened.id);
    expect(await b.get(reopened.id)).toMatchObject({ status: 'todo', sessionId: null });
    expect(await b.attempt(b.svc.cancelFrom('p', reopened.id, b.as('gio-1'), 'desisti'))).toBeInstanceOf(TaskConflictError);

    // Sem conversa nem sessão, mas o histórico lembra: só o histórico basta.
    const trace = await b.make('Só o histórico');
    b.edit((all) => {
      const x = all.find((t) => t.id === trace.id)!;
      x.history.push({ at: new Date().toISOString(), status: 'doing', by: 'auto', note: 'com Ana' });
    });
    expect(await b.attempt(b.svc.cancelFrom('p', trace.id, b.as('gio-1'), 'desisti'))).toBeInstanceOf(TaskConflictError);

    // Encerrada: 409 também (a que já foi cancelada).
    const done = await b.make('Já cancelada');
    await b.svc.cancelFrom('p', done.id, b.as('gio-1'), 'primeira vez');
    expect(await b.attempt(b.svc.cancelFrom('p', done.id, b.as('gio-1'), 'de novo'))).toBeInstanceOf(TaskConflictError);
  });

  it('o cancelamento do responsável pelo cancelFrom segue como era (só pela conversa atual da tarefa)', async () => {
    const b = board('responsavel');
    const t = await b.started('Fazendo');
    expect(await b.attempt(b.svc.cancelFrom('p', t.id, b.as('ana-1', { session: 'outra-conversa' }), 'x'))).toBeInstanceOf(TaskForbiddenError);
    expect(await b.attempt(b.svc.cancelFrom('p', t.id, b.as('rev-1', { session: t.sessionId! }), 'x'))).toBeInstanceOf(TaskForbiddenError);
    const out = (await b.svc.cancelFrom('p', t.id, b.worker(t), undefined)) as Task; // o responsável continua podendo cancelar sem motivo
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'ana-1' });
    expect(b.notified.at(-1)).toMatchObject({ staffId: 'gio-1' });
    expect(b.notified.at(-1)!.text).toContain('foi cancelada por Ana');
  });

  it('sem corrida com a partida: quem começa antes vence (o cancelamento vê a tarefa começada), quem cancela antes vence (a partida não abre conversa)', async () => {
    const b = board('corrida');
    const first = await b.make('Primeira');
    const second = await b.make('Segunda');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.hooks.beforeSend = () => gate;

    const starting = b.svc.start('p', first.id); // pega a vez de Ana e fica abrindo a conversa
    await b.settle();
    const cancelSecond = b.attempt(b.svc.cancelFrom('p', second.id, b.as('gio-1'), 'não precisa'));
    await b.settle();
    const startSecond = b.attempt(b.svc.start('p', second.id)); // entra na vez DEPOIS do cancelamento
    await b.settle();
    const cancelFirst = b.attempt(b.svc.cancelFrom('p', first.id, b.as('gio-1'), 'não precisa'));
    await b.settle();
    expect(b.sent).toHaveLength(0); // ninguém passou da vez ainda
    release();

    await starting;
    expect(await cancelSecond).toMatchObject({ status: 'cancelled', id: second.id });
    expect(await startSecond).toBeInstanceOf(TaskConflictError);
    expect(await cancelFirst).toBeInstanceOf(TaskConflictError); // a primeira já tinha conversa quando o cancelamento chegou na vez dele
    expect(b.sent).toHaveLength(1);
    expect(await b.get(first.id)).toMatchObject({ status: 'doing' });
    expect(await b.get(second.id)).toMatchObject({ status: 'cancelled', sessionId: null });
  });
});

describe('pedido de cancelamento da tarefa que já começou', () => {
  it('chega na conversa do responsável (com o motivo e os dois caminhos), fica na tarefa e no histórico, e a coluna não muda', async () => {
    const b = board('pedido');
    const t = await b.started('Exportar CSV');
    const out = (await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário mudou de ideia')) as Task;
    expect(out.status).toBe('doing');
    expect(out.cancelRequest).toMatchObject({ by: 'gio-1', reason: 'o usuário mudou de ideia', status: 'pending', deliveredSession: t.sessionId });
    expect(out.cancelRequest!.at).toBeTruthy();
    expect(out.cancelRequest!.deliveredAt).toBeTruthy();
    expect(out.history.at(-1)).toMatchObject({ note: 'pedido de cancelamento de Gio: o usuário mudou de ideia' });

    expect(b.notices).toHaveLength(1);
    const notice = b.notices[0]!;
    expect(notice).toMatchObject({ session: t.sessionId, staffId: 'ana-1' });
    expect(notice.text).toContain('Pedido de cancelamento');
    expect(notice.text).toContain(`“Exportar CSV” (id \`${t.id}\`)`);
    expect(notice.text).toContain('Gio (Orquestrador)');
    expect(notice.text).toContain('“o usuário mudou de ideia”');
    expect(notice.text).toContain(`http://127.0.0.1:4848/api/projects/p/tasks/${t.id}/cancel`);
    expect(notice.text).toContain(`http://127.0.0.1:4848/api/projects/p/tasks/${t.id}/cancel-request/refuse`);
    expect(notice.text).toContain('$MYCO_TOKEN');
    expect(b.sent).toHaveLength(1); // nenhuma conversa nova: foi na que já existia
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', cancelRequest: { status: 'pending' } });
  });

  it('o pedido feito enquanto a partida abre a conversa espera a vez dela: vê a tarefa já começada e vira pedido (não "nunca começou")', async () => {
    const b = board('pedido-corrida');
    const t = await b.make('Exportar CSV');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    b.hooks.beforeSend = () => gate;
    const starting = b.svc.start('p', t.id); // a conversa está abrindo
    await b.settle();
    const asking = b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa mais'));
    await b.settle();
    expect(b.notices).toHaveLength(0);
    release();
    await starting;
    const out = (await asking) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'pending', deliveredSession: 's-1' });
    expect(b.notices).toHaveLength(1);
  });

  it('o Codex recebe as rotas pelo endereço da sandbox', async () => {
    const b = board('pedido-codex', { workerEngine: 'codex' });
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa mais');
    expect(b.notices[0]!.text).toContain(`http://127.0.0.2:4848/api/projects/p/tasks/${t.id}/cancel`);
    expect(b.notices[0]!.text).not.toContain('127.0.0.1');
  });

  it('só quem pediu a tarefa, com o token, e com motivo; 409 se nunca começou, se já há um pedido aberto ou se está encerrada', async () => {
    const b = board('pedido-regras');
    const t = await b.started('Exportar CSV');
    const before = b.raw();
    const forbidden: Array<[string, ReturnType<typeof b.as>]> = [
      ['o responsável', b.worker(t)],
      ['um par', b.as('bia-1')],
      ['o revisor', b.as('rev-1')],
      ['um de fora', b.as('dev-1')],
      ['sem token', null],
      ['conversa sem ficha', b.as(null)],
      ['token de outro projeto', b.as('gio-1', { project: 'q' })],
    ];
    for (const [quem, caller] of forbidden) expect(await b.attempt(b.svc.requestCancel('p', t.id, caller, 'quero')), quem).toBeInstanceOf(TaskForbiddenError);
    expect(b.raw()).toBe(before);
    expect(await b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), '  '))).toBeInstanceOf(TaskError);
    expect(await b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), undefined))).not.toBeInstanceOf(TaskForbiddenError);
    expect(b.raw()).toBe(before);
    expect(await b.svc.requestCancel('p', 't-nao-existe', b.as('gio-1'), 'x')).toBeNull();

    // Tarefa que ele não pediu (da tela): 403 mesmo para o gestor.
    const daTela = await b.started('Da tela', { staff: 'bia-1' });
    b.edit((all) => {
      delete all.find((x) => x.id === daTela.id)!.requestedBy;
    });
    expect(await b.attempt(b.svc.requestCancel('p', daTela.id, b.as('gio-1'), 'x'))).toBeInstanceOf(TaskForbiddenError);

    // Nunca começou: o caminho é cancelar direto.
    const draft = await b.make('Rascunho');
    const never = (await b.attempt(b.svc.requestCancel('p', draft.id, b.as('gio-1'), 'x'))) as Error;
    expect(never).toBeInstanceOf(TaskConflictError);
    expect(never.message).toContain(`/tasks/${draft.id}/cancel`);

    // Um pedido aberto por vez.
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'primeiro');
    expect(await b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), 'segundo'))).toBeInstanceOf(TaskConflictError);
    expect((await b.get(t.id)).cancelRequest!.reason).toBe('primeiro');

    // Encerrada.
    await b.svc.cancelFrom('p', t.id, b.worker(t), 'aceito');
    expect(await b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), 'de novo'))).toBeInstanceOf(TaskConflictError);
  });

  it('o responsável em outra tarefa não é acordado: o pedido espera a vez dele (`waiting`) e chega quando ele fica livre', async () => {
    const b = board('pedido-ocupado');
    const old = await b.started('Antiga');
    // A antiga parou (Aguardar, com conversa) e Ana pegou a Atual.
    b.edit((all) => {
      all.find((t) => t.id === old.id)!.status = 'waiting';
    });
    b.working.delete(old.sessionId!);
    const current = await b.started('Atual');
    expect(current.status).toBe('doing');

    const out = (await b.svc.requestCancel('p', old.id, b.as('gio-1'), 'não vale mais')) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'pending' });
    expect(out.cancelRequest!.deliveredAt).toBeUndefined();
    expect(out.cancelRequest!.waiting).toContain('Ana está em “Atual”');
    expect(out.cancelRequest!.retry).toBeUndefined(); // esperar a vez não é falha
    expect(b.notices).toHaveLength(0);

    await b.finish(current.sessionId!); // Ana termina a Atual (vai para revisão)
    await b.svc.tick();
    expect(b.notices).toHaveLength(1);
    expect(b.notices[0]).toMatchObject({ session: old.sessionId, staffId: 'ana-1' });
    const after = (await b.get(old.id)).cancelRequest!;
    expect(after.deliveredSession).toBe(old.sessionId);
    expect(after.waiting).toBeUndefined();
  });

  it('o envio que falha fica pendente com backoff e o tick entrega quando a hora chega (sem repetir antes)', async () => {
    const b = board('pedido-falha');
    const t = await b.started('Exportar CSV');
    b.hooks.noticeFails = true;
    const out = (await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa')) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'pending', retry: { attempts: 1, lastError: 'conversa fechando' } });
    expect(out.cancelRequest!.deliveredAt).toBeUndefined();

    // Antes da hora: o tick não tenta de novo.
    b.hooks.noticeFails = false;
    await b.svc.tick();
    expect(b.notices).toHaveLength(0);
    // Chegada a hora, entrega e limpa a pendência.
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.cancelRequest.retry.nextAt = new Date(Date.now() - 1000).toISOString();
    });
    await b.svc.tick();
    expect(b.notices).toHaveLength(1);
    const after = (await b.get(t.id)).cancelRequest!;
    expect(after).toMatchObject({ status: 'pending', deliveredSession: t.sessionId });
    expect(after.retry).toBeUndefined();
    // Entregue, não repete a cada tick.
    await b.svc.tick();
    expect(b.notices).toHaveLength(1);
  });

  it('a tarefa trocou de conversa (troca de motor): o pedido ainda aberto vai de novo, na conversa nova', async () => {
    const b = board('pedido-troca');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa');
    expect(b.notices).toHaveLength(1);
    b.working.clear(); // a conversa antiga foi parada na troca
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.sessionId = 's-nova';
    });
    await b.svc.tick();
    expect(b.notices).toHaveLength(2);
    expect(b.notices[1]).toMatchObject({ session: 's-nova', staffId: 'ana-1' });
    expect((await b.get(t.id)).cancelRequest).toMatchObject({ deliveredSession: 's-nova', status: 'pending' });
  });

  it('o servidor reiniciou com o pedido aberto: o processo novo entrega de novo, uma vez', async () => {
    const b = board('pedido-reinicio');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa');
    expect(b.notices).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15)); // o novo processo sobe depois da entrega
    const rebooted = new TaskService(b.deps);
    await rebooted.tick();
    expect(b.notices).toHaveLength(2);
    expect(b.notices[1]).toMatchObject({ session: t.sessionId });
    await rebooted.tick();
    expect(b.notices).toHaveLength(2);
    // Decidido, o reinício não repete.
    await b.svc.refuseCancel('p', t.id, b.worker(t), 'falta pouco');
    const again = new TaskService(b.deps);
    await again.tick();
    expect(b.notices).toHaveLength(2);
  });

  it('sem conversa agora (a tarefa já começou antes): o pedido fica registrado e é entregue quando a conversa existir', async () => {
    const b = board('pedido-sem-conversa');
    const t = await b.started('Reaberta');
    await b.svc.cancel('p', t.id, { by: 'user' });
    await b.svc.reopen('p', t.id);
    const out = (await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'não precisa mais')) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'pending' });
    expect(out.cancelRequest!.deliveredAt).toBeUndefined();
    expect(b.notices).toHaveLength(0);
    // A conversa volta (a fila retomou): o tick entrega nela.
    b.working.clear(); // a conversa antiga morreu: Ana não está em nenhuma
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.sessionId = 's-volta';
    });
    await b.svc.tick();
    expect(b.notices.at(-1)).toMatchObject({ session: 's-volta' });
  });
});

describe('a decisão do responsável', () => {
  it('recusa com o porquê: fica na tarefa (decisão, quem, quando, motivo) e no histórico, a tarefa segue, e quem pediu é avisado na conversa em que pediu', async () => {
    const b = board('recusa');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário mudou de ideia');
    const out = (await b.svc.refuseCancel('p', t.id, b.worker(t), 'já está 90% pronto e o usuário confirmou ontem')) as Task;
    expect(out.status).toBe('doing');
    expect(out.cancelRequest).toMatchObject({ by: 'gio-1', reason: 'o usuário mudou de ideia', status: 'refused', decidedBy: 'ana-1', answer: 'já está 90% pronto e o usuário confirmou ontem' });
    expect(out.cancelRequest!.decidedAt).toBeTruthy();
    expect(out.cancelRequest!.notifyRetry).toBeUndefined(); // o aviso saiu
    expect(out.history.at(-1)!.note).toBe('pedido de cancelamento de Gio recusado por Ana: já está 90% pronto e o usuário confirmou ontem');

    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]).toMatchObject({ staffId: 'gio-1', session: 'c-gio-1' });
    expect(b.notified[0]!.text).toContain('Ana recusou o seu pedido de cancelar');
    expect(b.notified[0]!.text).toContain('já está 90% pronto');
    // A recusa não foi "você respondeu": o pedido de Gio e a decisão de Ana não mexeram na coluna.
    expect(await b.get(t.id)).toMatchObject({ status: 'doing' });
  });

  it('depois da recusa não dá para insistir logo (409); passados 10 min, um novo pedido substitui o decidido', async () => {
    const b = board('recusa-de-novo');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'primeiro motivo');
    await b.svc.refuseCancel('p', t.id, b.worker(t), 'segue');
    const logo = await b.attempt(b.svc.requestCancel('p', t.id, b.as('gio-1'), 'insisto'));
    expect(logo).toBeInstanceOf(TaskConflictError);
    expect((logo as Error).message).toContain('recusou o pedido de cancelamento há pouco');
    expect((await b.get(t.id)).cancelRequest).toMatchObject({ status: 'refused', reason: 'primeiro motivo' });
    expect(b.notices).toHaveLength(1); // a conversa dele não foi incomodada de novo
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.cancelRequest.decidedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    });
    const again = (await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário confirmou agora')) as Task;
    expect(again.cancelRequest).toMatchObject({ status: 'pending', reason: 'o usuário confirmou agora' });
    expect(again.cancelRequest!.answer).toBeUndefined();
    expect(b.notices).toHaveLength(2);
  });

  it('a recusa exige o motivo e a conversa atual do responsável; sem pedido aberto ou encerrada é 409', async () => {
    const b = board('recusa-regras');
    const t = await b.started('Exportar CSV');
    // Sem pedido esperando decisão.
    expect(await b.attempt(b.svc.refuseCancel('p', t.id, b.worker(t), 'não tem pedido'))).toBeInstanceOf(TaskConflictError);
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'quero cancelar');
    const before = b.raw();
    const forbidden: Array<[string, ReturnType<typeof b.as>]> = [
      ['quem pediu', b.as('gio-1')],
      ['o responsável por outra conversa', b.as('ana-1', { session: 'outra-conversa' })],
      ['um par', b.as('bia-1', { session: t.sessionId! })],
      ['o revisor', b.as('rev-1', { session: t.sessionId! })],
      ['sem token', null],
      ['token de outro projeto', b.as('ana-1', { project: 'q', session: t.sessionId! })],
    ];
    for (const [quem, caller] of forbidden) expect(await b.attempt(b.svc.refuseCancel('p', t.id, caller, 'recuso')), quem).toBeInstanceOf(TaskForbiddenError);
    for (const reason of [undefined, '', '   ']) expect(await b.attempt(b.svc.refuseCancel('p', t.id, b.worker(t), reason)), String(reason)).toBeInstanceOf(TaskError);
    expect(b.raw()).toBe(before);
    expect(await b.svc.refuseCancel('p', 't-nao-existe', b.worker(t), 'x')).toBeNull();

    await b.svc.refuseCancel('p', t.id, b.worker(t), 'segue');
    expect(await b.attempt(b.svc.refuseCancel('p', t.id, b.worker(t), 'de novo'))).toBeInstanceOf(TaskConflictError); // já decidido
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.cancelRequest.decidedAt = new Date(Date.now() - 11 * 60_000).toISOString(); // passou o tempo de não insistir
    });
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'outro pedido');
    await b.svc.cancelFrom('p', t.id, b.worker(t), 'aceito');
    expect(await b.attempt(b.svc.refuseCancel('p', t.id, b.worker(t), 'tarde demais'))).toBeInstanceOf(TaskConflictError); // encerrada: nada a recusar
    expect((await b.get(t.id)).cancelRequest!.status).toBe('accepted');
  });

  it('o aviso da recusa que falha não se perde: fica com `notifyRetry` e o tick reenvia com backoff', async () => {
    const b = board('recusa-aviso');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'quero cancelar');
    b.hooks.notifyFails = true;
    const out = (await b.svc.refuseCancel('p', t.id, b.worker(t), 'segue')) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'refused', notifyRetry: { attempts: 1, lastError: 'conversa dele não abriu' } }); // a decisão ficou gravada
    expect(b.notified).toHaveLength(0);

    b.hooks.notifyFails = false;
    await b.svc.tick(); // antes da hora: nada
    expect(b.notified).toHaveLength(0);
    b.edit((all) => {
      all.find((x) => x.id === t.id)!.cancelRequest.notifyRetry.nextAt = new Date(Date.now() - 1000).toISOString();
    });
    await b.svc.tick();
    expect(b.notified).toHaveLength(1);
    expect(b.notified[0]).toMatchObject({ staffId: 'gio-1', session: 'c-gio-1' });
    expect((await b.get(t.id)).cancelRequest!.notifyRetry).toBeUndefined();
    await b.svc.tick();
    expect(b.notified).toHaveLength(1);
  });

  it('aceita cancelando (cancelFrom do responsável): o pedido vira `accepted`, com quem e quando, e quem pediu recebe o aviso de cancelamento', async () => {
    const b = board('aceite');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário mudou de ideia');
    const out = (await b.svc.cancelFrom('p', t.id, b.worker(t), 'aceito o pedido do Gio')) as Task;
    expect(out).toMatchObject({ status: 'cancelled', cancelledBy: 'ana-1', cancelReason: 'aceito o pedido do Gio' });
    expect(out.cancelRequest).toMatchObject({ status: 'accepted', decidedBy: 'ana-1', reason: 'o usuário mudou de ideia' });
    expect(out.cancelRequest!.decidedAt).toBeTruthy();
    expect(out.history.at(-1)!.note).toBe('cancelada: aceito o pedido do Gio (pedido de cancelamento aceito)');
    expect(b.notified.at(-1)).toMatchObject({ staffId: 'gio-1', session: 'c-gio-1' });
    expect(b.notified.at(-1)!.text).toContain('foi cancelada por Ana: “aceito o pedido do Gio”');
    // Cancelar não desfaz arquivos: a conversa e a branch ficam como estavam.
    expect(out.sessionId).toBe(t.sessionId);
  });

  it('o usuário cancela pela tela com o pedido aberto: conta como aceito, por `user`; reabrir limpa o pedido', async () => {
    const b = board('aceite-usuario');
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'o usuário mudou de ideia');
    const out = (await b.svc.cancel('p', t.id, { by: 'user', reason: 'cancelei pela tela' })) as Task;
    expect(out.cancelRequest).toMatchObject({ status: 'accepted', decidedBy: 'user' });
    const reopened = (await b.svc.reopen('p', t.id)) as Task;
    expect(reopened.cancelRequest).toBeUndefined();
  });

  it('a tarefa ficou pronta sem decisão: o pedido vira `moot` e para de ser entregue', async () => {
    const b = board('moot');
    const t = await b.started('Exportar CSV');
    b.hooks.noticeFails = true;
    await b.svc.requestCancel('p', t.id, b.as('gio-1'), 'quero cancelar'); // pendente, ainda sem entregar
    b.hooks.noticeFails = false;
    const done = (await b.svc.update('p', t.id, { status: 'done' })) as Task;
    expect(done.cancelRequest).toMatchObject({ status: 'moot' });
    expect(done.cancelRequest!.retry).toBeUndefined();
    await b.svc.tick();
    expect(b.notices).toHaveLength(0);
  });
});

describe('as rotas e a ficha', () => {
  it('as rotas: o pedido e a recusa só do funcionário pela API (a tela recebe 400) e a criação passa por createAndStart', async () => {
    const src = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const request = /\/tasks\/\$\{ID\}\/cancel-request\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(request).toContain("if (fromBrowser) throw new BadRequest(");
    expect(request).toContain("return tasks.requestCancel(id!, taskId!, caller, reasonRequest(body, 'do pedido de cancelamento'));");
    const refuse = /\/tasks\/\$\{ID\}\/cancel-request\/refuse\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(refuse).toContain("if (fromBrowser) throw new BadRequest(");
    expect(refuse).toContain("return tasks.refuseCancel(id!, taskId!, caller, reasonRequest(body, 'da recusa'));");
    // O cancelar de sempre: a tela como antes, o funcionário pelo cancelFrom (que agora também serve a quem pediu a tarefa que nunca começou).
    const cancel = /\/tasks\/\$\{ID\}\/cancel\$`\),([\s\S]*?)\n  \],/.exec(src)![1]!;
    expect(cancel).toContain("if (fromBrowser) return tasks.cancel(id!, taskId!, { by: 'user', reason: b.reason, dependents: b.dependents, deadline: true });");
    expect(cancel).toContain('return tasks.cancelFrom(id!, taskId!, caller, b.reason);');
    // O POST do gestor: grava e começa pelo serviço, que devolve a tarefa gravada mesmo se o começo falhar.
    const post = /\/tasks\$`\),\n    async \(\{ params: \[id\], body, fromBrowser, caller \}\) => \{([\s\S]*?)\n    \},\n  \],/.exec(src)![1]!;
    expect(post).toContain('tasks.createAndStart(id!, body, requestedBy, requesterSessionOf(caller, requestedBy), { start: b.start, deadlineMs: START_DEADLINE_MS');
    expect(post).not.toContain('tasks.start(');
    expect(src).toContain('sendNotice: (projectId, sessionId, staffId, text) => chats.sendNotice(projectId, sessionId, staffId, text),');
  });

  const profile = (over: Partial<StaffProfile> = {}) =>
    ({
      id: 'gio-1',
      projectId: 'proj-x',
      name: 'Gio',
      role: 'Orquestrador',
      portrait: null,
      reportsTo: [],
      mission: 'Passar o trabalho',
      firstTask: 'Leia o quadro',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      doneWhen: 'Quadro em dia',
      model: 'opus',
      effort: 'high',
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      browser: false,
      sessions: [],
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      ...over,
    }) as StaffProfile;
  const ctx = (mycoUrl: string): FichaContext => ({
    company: 'Acme',
    projectName: 'painel',
    projectPath: 'C:\\www\\painel',
    managerNames: [],
    fichaPath: '.myco\\staff\\gio-1.md',
    memoryPath: '.myco\\staff\\gio-1.memory.md',
    mycoUrl,
    team: [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }],
  });

  it('a ficha do gestor ensina a chave de idempotência, a resposta do POST e o cancelamento/pedido, igual no Claude e no Codex', () => {
    for (const [motor, url] of [
      ['claude', 'http://127.0.0.1:4848'],
      ['codex', 'http://127.0.0.2:4848'],
    ] as const) {
      const md = renderFicha(profile({ engine: motor }), ctx(url));
      expect(md, motor).toContain('idempotencyKey (uma chave única por tarefa');
      expect(md, motor).toContain('REPITA o mesmo pedido com a MESMA chave');
      expect(md, motor).toContain('a mesma chave com outro conteúdo é 409');
      expect(md, motor).toContain('"idempotentReplay": true');
      expect(md, motor).toContain('"startError"');
      expect(md, motor).toContain('NÃO crie outra');
      expect(md, motor).toContain('"warnings" é só aviso de possível duplicata');
      expect(md, motor).toContain(`POST ${url}/api/projects/proj-x/tasks/<id da tarefa>/cancel com {"reason"`);
      expect(md, motor).toContain(`POST ${url}/api/projects/proj-x/tasks/<id da tarefa>/cancel-request com {"reason"`);
      expect(md, motor).toContain('quem só revisa não cancela');
      expect(md, motor).toContain('Cancelar não desfaz arquivos');
    }
    // Sem equipe, sem a seção.
    expect(renderFicha(profile(), { ...ctx('http://127.0.0.1:4848'), team: [] })).not.toContain('cancel-request');
  });
});
