import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTO_REVIEW_ROUNDS, TAREFA_MCP_NAME, type StaffProfile, type Task } from '../shared/model';
import { resolveCaller, SessionTokens, type Engine } from '../server/callers';
import { CODEX_RESERVED_MCP_NAMES } from '../server/chat/codexArgs';
import { buildClaudeArgs, renderFicha, type FichaContext } from '../server/staff/ficha';
import { prepareCodexRun, prepareRun, tarefaLaunchOf, type LaunchContext } from '../server/staff/launch';
import { TAREFA_TOOLS, TOOLS, createTarefaMcp, runTarefaMcpStdio, tarefaMcpServer } from '../server/staff/tarefaMcp';
import { cancelWith, tarefaMcpOn, tarefaToolName } from '../server/staff/tarefaText';
import { TaskBusyError, TaskConflictError, TaskError, TaskForbiddenError, TaskService, cancelRequest, reasonRequest, type TaskServiceDeps } from '../server/tasks';
import { removeTemp } from './support/tmp';

// O MCP `myco-tarefa` (t-17ebd0): cancelar, pedir cancelamento e recusar pedido, pelas MESMAS rotas HTTP do curl e com o token da conversa. O servidor segue decidindo (quem é dono da
// tarefa, pedido pending, coluna): o teste sobe um servidor HTTP que liga as três rotas ao TaskService real (cancelFrom, requestCancel, refuseCancel, com o mesmo corpo e o mesmo
// mapa de erro de server/index.ts) e fala com ele pelo MCP, com o fetch de verdade.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-tarefamcp-'));
});
afterAll(() => removeTemp(root));

const person = (id: string, name: string, over: Partial<StaffProfile> = {}) =>
  ({ id, name, role: id.startsWith('gio') ? 'Orquestrador' : 'Back-end', autonomy: 'acceptEdits', worktree: false, servers: [], reportsTo: [], projectId: 'p', ...over }) as unknown as StaffProfile;

/** Gio é o gestor; Ana e Bia reportam a ele; Rui é revisor e Dev é de fora. `workerEngine`: o motor de Ana. */
function board(dirName: string, o: { workerEngine?: Engine; managerEngine?: Engine } = {}) {
  const dir = path.join(root, dirName);
  const file = path.join(dir, '.myco', 'tasks.json');
  const people: Record<string, StaffProfile> = {
    'gio-1': person('gio-1', 'Gio', { engine: o.managerEngine ?? 'claude' }),
    'ana-1': person('ana-1', 'Ana', { reportsTo: ['gio-1'], engine: o.workerEngine ?? 'claude' }),
    'bia-1': person('bia-1', 'Bia', { reportsTo: ['gio-1'] }),
    'dev-1': person('dev-1', 'Dev'),
    'rev-1': person('rev-1', 'Rui'),
  };
  const notices: Array<{ session: string; staffId: string; text: string }> = [];
  const notified: Array<{ staffId: string; text: string; session: string | null }> = [];
  const working = new Map<string, string>();
  let n = 0;
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async (_p, staffId) => {
      const session = `s-${++n}`;
      working.set(session, staffId);
      return session;
    },
    sendTo: async (_p, sessionId, staffId) => {
      working.set(sessionId, staffId);
      return sessionId;
    },
    sendNotice: async (_p, session, staffId, text) => (notices.push({ session, staffId, text }), session),
    branchFor: async () => null,
    isWorking: (_p, staffId, except) => {
      const skip = new Set(Array.isArray(except) ? except : except ? [except] : []);
      return [...working].some(([s, who]) => who === staffId && !skip.has(s));
    },
    lastText: () => null,
    notify: async (_p, staffId, text, session) => void notified.push({ staffId, text, session: session ?? null }),
    apiUrl: 'http://127.0.0.1:4848',
    sandboxApiUrl: 'http://127.0.0.2:4848',
    log: () => {},
  } as TaskServiceDeps);
  const make = async (title: string, o2: { start?: boolean } = {}) =>
    (await svc.create('p', { title, staffId: 'ana-1', start: o2.start ?? false, description: `desc de ${title}`, acceptance: `critério de ${title}`, reviewerId: null }, 'gio-1', 'c-gio-1'))!;
  const started = async (title: string) => {
    const t = await make(title);
    await svc.start('p', t.id);
    return get(t.id);
  };
  const list = async () => (await svc.list('p'))!;
  const get = async (id: string) => (await list()).find((t) => t.id === id)!;
  const tokens = new SessionTokens();
  /** O MYCO_TOKEN da conversa de `staffId` (`session`: a conversa; o responsável fala pela da tarefa). */
  const tokenOf = (staffId: string | null, o2: { session?: string; engine?: Engine } = {}) =>
    tokens.issue({ staffId, projectId: 'p', sessionId: o2.session ?? `c-${staffId}`, engine: o2.engine ?? 'claude' });
  const workerToken = (t: Task) => tokenOf('ana-1', { session: t.sessionId! });
  const raw = () => readFileSync(file, 'utf8');
  return { svc, dir, notices, notified, make, started, get, tokens, tokenOf, workerToken, raw, people };
}
type Board = ReturnType<typeof board>;

/** O servidor HTTP no lugar do index.ts: as três rotas ligadas ao TaskService, com o gate do x-myco e o token resolvido por `resolveCaller`, e o mapa de erro de lá. */
async function serve(b: Board) {
  const calls: Array<{ url: string; headers: http.IncomingHttpHeaders; body: unknown }> = [];
  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) : null;
    calls.push({ url: req.url ?? '', headers: req.headers, body });
    try {
      if (req.method !== 'POST' || req.headers['x-myco'] !== '1') return send(400, { error: 'tarefas só pelo Claudio’s Club' });
      const who = resolveCaller(false, req.headers['x-myco-token'], b.tokens);
      if (!who.ok) return send(who.status, { error: who.error });
      const m = /^\/api\/projects\/([A-Za-z0-9-]+)\/tasks\/([A-Za-z0-9-]+)\/(cancel|cancel-request|cancel-request\/refuse|review-limit)$/.exec(req.url ?? '');
      if (!m) return send(404, { error: 'não encontrado' });
      const [, p, id, route] = m as unknown as [string, string, string, string];
      let out: Task | null;
      if (route === 'review-limit') out = await b.svc.decideCap(p, id, who.caller, false, body);
      else if (route === 'cancel') out = await b.svc.cancelFrom(p, id, who.caller, cancelRequest(body, false).reason);
      else if (route === 'cancel-request') out = await b.svc.requestCancel(p, id, who.caller, reasonRequest(body, 'do pedido de cancelamento'));
      else out = await b.svc.refuseCancel(p, id, who.caller, reasonRequest(body, 'da recusa'));
      if (out === null) return send(404, { error: 'não encontrado' });
      send(200, out);
    } catch (err) {
      if (err instanceof TaskConflictError) return send(409, { error: err.message });
      if (err instanceof TaskForbiddenError) return send(403, { error: err.message });
      if (err instanceof TaskBusyError) return send(503, { error: err.message });
      if (err instanceof TaskError) return send(400, { error: err.message });
      send(500, { error: 'falha' });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { api, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** O MCP de uma conversa (a de `token`) falando com o servidor acima. Devolve o texto e se foi erro. */
function mcpOf(api: string, token: string | undefined) {
  const mcp = createTarefaMcp({ api, projectId: 'p', token: () => token, busyWaitMs: 0 });
  return (tool: (typeof TAREFA_TOOLS)[number], args: Record<string, unknown>) =>
    mcp.callTool(tool, args).then((r) => ({ text: r.content[0]!.text, isError: r.isError === true }));
}

describe('o MCP chama as mesmas rotas, com o token da conversa', () => {
  it('o responsável cancela a dele (com pedido pending, o pedido fica accepted) e a tarefa vira cancelled', async () => {
    const b = board('resp-cancela');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'o usuário mudou de ideia');
    const cancelar = mcpOf(srv.api, b.workerToken(t));
    const r = await cancelar('tarefa_cancelar', { tarefa: t.id, motivo: 'aceito o pedido' });
    expect(r).toMatchObject({ isError: false });
    expect(r.text).toBe(`cancelada: ${t.id} (status cancelled; pedido de cancelamento accepted)`);
    expect(await b.get(t.id)).toMatchObject({ status: 'cancelled', cancelRequest: { status: 'accepted', decidedBy: 'ana-1' } });
    // O pedido foi para a rota certa, com o token da conversa e só o motivo no corpo.
    const call = srv.calls.at(-1)!;
    expect(call.url).toBe(`/api/projects/p/tasks/${t.id}/cancel`);
    expect(call.headers['x-myco']).toBe('1');
    expect(call.headers['x-myco-token']).toBe(b.workerToken(t));
    expect(call.body).toEqual({ reason: 'aceito o pedido' });
    await srv.close();
  });

  it('o responsável cancela a tarefa sem pedido (o usuário pediu na conversa): cancelled', async () => {
    const b = board('resp-cancela-livre');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    const r = await mcpOf(srv.api, b.workerToken(t))('tarefa_cancelar', { tarefa: t.id, motivo: 'o usuário pediu' });
    expect(r.text).toBe(`cancelada: ${t.id} (status cancelled)`);
    expect((await b.get(t.id)).status).toBe('cancelled');
    await srv.close();
  });

  it('o responsável recusa o pedido: a recusa é gravada com o porquê e quem pediu é avisado (a tarefa segue)', async () => {
    const b = board('resp-recusa');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'o usuário mudou de ideia');
    const r = await mcpOf(srv.api, b.workerToken(t))('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'falta pouco e o usuário confirmou ontem' });
    expect(r.text).toBe(`recusa gravada: ${t.id} (status doing; pedido de cancelamento refused)`);
    expect(await b.get(t.id)).toMatchObject({ status: 'doing', cancelRequest: { status: 'refused', answer: 'falta pouco e o usuário confirmou ontem', decidedBy: 'ana-1' } });
    await new Promise((r2) => setTimeout(r2, 25));
    expect(b.notified.some((x) => x.staffId === 'gio-1' && x.text.includes('falta pouco e o usuário confirmou ontem'))).toBe(true);
    await srv.close();
  });

  it('quem pediu: cancelar funciona na que nunca começou e devolve o 409 da rota na que já começou; pedir cancelamento funciona na que começou', async () => {
    const b = board('pediu');
    const srv = await serve(b);
    const gio = mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }));
    const never = await b.make('Nunca começou');
    expect(await gio('tarefa_cancelar', { tarefa: never.id, motivo: 'engano' })).toMatchObject({ isError: false, text: `cancelada: ${never.id} (status cancelled)` });
    expect((await b.get(never.id)).status).toBe('cancelled');

    const doing = await b.started('Já começou');
    const before = b.raw();
    const refused = await gio('tarefa_cancelar', { tarefa: doing.id, motivo: 'não precisa' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^409: a tarefa já começou \(ou já teve conversa\): quem a faz decide\. Mande um pedido de cancelamento/);
    expect(b.raw()).toBe(before);

    const asked = await gio('tarefa_pedir_cancelamento', { tarefa: doing.id, motivo: 'não precisa mais' });
    expect(asked).toMatchObject({ isError: false, text: `pedido de cancelamento enviado: ${doing.id} (status doing; pedido de cancelamento pending)` });
    expect(await b.get(doing.id)).toMatchObject({ status: 'doing', cancelRequest: { status: 'pending', by: 'gio-1' } });
    expect(b.notices.at(-1)).toMatchObject({ staffId: 'ana-1', session: doing.sessionId });

    // Pedir cancelamento da que nunca começou é 409 (o caminho é cancelar direto); outro pedido com um aberto, também.
    const draft = await b.make('Rascunho');
    expect((await gio('tarefa_pedir_cancelamento', { tarefa: draft.id, motivo: 'x' })).text).toMatch(/^409: a tarefa nunca começou: cancele direto/);
    expect((await gio('tarefa_pedir_cancelamento', { tarefa: doing.id, motivo: 'de novo' })).text).toMatch(/^409: já há um pedido de cancelamento/);
    await srv.close();
  });

  it('quem não é dono da tarefa leva o mesmo 403/409 da rota, sem mudar nada', async () => {
    const b = board('nao-dono');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'quero cancelar');
    const before = b.raw();
    const strangers: Array<[string, string]> = [
      ['outro funcionário (Bia)', b.tokenOf('bia-1')],
      ['funcionário de fora (Dev)', b.tokenOf('dev-1')],
      ['revisor (Rui)', b.tokenOf('rev-1')],
      ['Ana em OUTRA conversa (não a da tarefa)', b.tokenOf('ana-1', { session: 'c-ana-outra' })],
    ];
    for (const [quem, token] of strangers) {
      const call = mcpOf(srv.api, token);
      for (const tool of TAREFA_TOOLS) {
        const r = await call(tool, tool === 'tarefa_decidir_limite' ? { tarefa: t.id, decisao: 'aceitar', texto: 'tento' } : { tarefa: t.id, motivo: 'tento' });
        expect(r.isError, `${quem} ${tool}`).toBe(true);
        expect(r.text, `${quem} ${tool}`).toMatch(/^403: /);
      }
    }
    // Quem pediu a tarefa não recusa o próprio pedido (403), nem o responsável pede o cancelamento dela (403).
    expect((await mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }))('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'x' })).text).toMatch(/^403: /);
    expect((await mcpOf(srv.api, b.workerToken(t))('tarefa_pedir_cancelamento', { tarefa: t.id, motivo: 'x' })).text).toMatch(/^403: só quem pediu a tarefa pede/);
    expect(b.raw()).toBe(before);

    // Tarefa que não existe é 404 (a rota devolve null).
    expect((await mcpOf(srv.api, b.workerToken(t))('tarefa_cancelar', { tarefa: 't-000000', motivo: 'x' })).text).toMatch(/^404: /);
    await srv.close();
  });

  it('o responsável recusar sem pedido esperando decisão: 409 da rota, sem mudar nada (e o pedido já decidido não se recusa de novo)', async () => {
    const b = board('recusa-sem-pedido');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    const before = b.raw();
    const ana = mcpOf(srv.api, b.workerToken(t));
    expect(await ana('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'x' })).toMatchObject({ isError: true });
    expect((await ana('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'x' })).text).toMatch(/^409: não há pedido de cancelamento esperando decisão/);
    expect(b.raw()).toBe(before);
    await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'quero cancelar');
    expect((await ana('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'segue' })).isError).toBe(false);
    expect((await ana('tarefa_recusar_cancelamento', { tarefa: t.id, motivo: 'de novo' })).text).toMatch(/^409: não há pedido de cancelamento esperando decisão/); // já decidido
    await srv.close();
  });

  it('token vencido ou inventado: o 401 da rota volta como está; sem MYCO_TOKEN no ambiente, nada é enviado', async () => {
    const b = board('token');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    const bogus = await mcpOf(srv.api, 'a'.repeat(64))('tarefa_cancelar', { tarefa: t.id, motivo: 'x' });
    expect(bogus.isError).toBe(true);
    expect(bogus.text).toMatch(/^401: x-myco-token inválido ou vencido/);
    const calls = srv.calls.length;
    const none = await mcpOf(srv.api, undefined)('tarefa_cancelar', { tarefa: t.id, motivo: 'x' });
    expect(none).toMatchObject({ isError: true });
    expect(none.text).toContain('MYCO_TOKEN');
    expect(srv.calls).toHaveLength(calls);
    expect((await b.get(t.id)).status).toBe('doing');
    await srv.close();
  });
});

/** A tarefa no limite de revisões esperando a decisão (o que `autoReview` grava, ver `Task.capWait`): em revisão, 3 rodadas usadas e o pedido a quem pediu (Gio). */
function capIt(b: Board, id: string, to: 'manager' | 'owner' = 'manager') {
  const file = path.join(b.dir, '.myco', 'tasks.json');
  const all = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, any>>;
  const t = all.find((x) => x.id === id)!;
  t.status = 'review';
  t.reviewRounds = 3;
  t.capWait = { since: new Date().toISOString(), deliveryAt: null, sha: null, to, items: [{ id: 'R1', where: 'a.ts:1', problem: 'quebrou' }] };
  writeFileSync(file, JSON.stringify(all, null, 2));
}

describe('a decisão do limite de revisões: tarefa_decidir_limite chama a mesma rota, com o token da conversa', () => {
  it('quem pediu aceita com trade-off: a rota recebe a justificativa, o card grava os 🔴, a justificativa e vai a pronto (sem worktree)', async () => {
    const b = board('limite-aceita');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    capIt(b, t.id);
    const gio = mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }));
    const r = await gio('tarefa_decidir_limite', { tarefa: t.id, decisao: 'aceitar', texto: 'o que sobrou é estilo' });
    expect(r).toMatchObject({ isError: false, text: `limite de revisões: aceita com trade-off: ${t.id} (status done)` });
    const call = srv.calls.at(-1)!;
    expect(call.url).toBe(`/api/projects/p/tasks/${t.id}/review-limit`);
    expect(call.headers['x-myco-token']).toBe(b.tokenOf('gio-1', { session: 'c-gio-1' }));
    expect(call.body).toEqual({ decision: 'accept', justification: 'o que sobrou é estilo' });
    expect(await b.get(t.id)).toMatchObject({
      status: 'done',
      capAccepted: { by: 'Gio', justification: 'o que sobrou é estilo', sha: null, items: [{ id: 'R1', where: 'a.ts:1', problem: 'quebrou' }] },
    });
    expect((await b.get(t.id)).capWait).toBeUndefined();
    await srv.close();
  });

  it('reabrir leva a instrução ao responsável e dá UMA rodada a mais (contada); cancelar cancela com o motivo', async () => {
    const b = board('limite-reabre');
    const srv = await serve(b);
    const gio = mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }));
    const a = await b.started('Exportar CSV');
    capIt(b, a.id);
    const r = await gio('tarefa_decidir_limite', { tarefa: a.id, decisao: 'reabrir', texto: 'cubra o caso vazio' });
    expect(r).toMatchObject({ isError: false, text: `limite de revisões: reaberta com a sua instrução: ${a.id} (status doing)` });
    expect(srv.calls.at(-1)!.body).toEqual({ decision: 'reopen', instruction: 'cubra o caso vazio' });
    expect(await b.get(a.id)).toMatchObject({ status: 'doing', reviewRounds: AUTO_REVIEW_ROUNDS - 1, capReopens: 1 });
    expect((await b.get(a.id)).history.at(-1)?.note).toContain('reabriu com instrução nova (cubra o caso vazio); uma rodada de revisão a mais (reabertura 1/3)');

    const c = await b.make('Outra');
    capIt(b, c.id);
    const out = await gio('tarefa_decidir_limite', { tarefa: c.id, decisao: 'cancelar', texto: 'não vale mais' });
    expect(out).toMatchObject({ isError: false, text: `limite de revisões: cancelada: ${c.id} (status cancelled)` });
    expect(await b.get(c.id)).toMatchObject({ status: 'cancelled' });
    await srv.close();
  });

  it('o responsável, o revisor e outro funcionário levam 403 e nada muda; sem o limite esperando decisão, 409; id inexistente, 404', async () => {
    const b = board('limite-403');
    const srv = await serve(b);
    const t = await b.started('Exportar CSV');
    const before = b.raw();
    // Sem o limite (a tarefa está em Fazendo): quem pediu leva 409, e os de fora 403 antes (quem pode vem antes do estado).
    expect((await mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }))('tarefa_decidir_limite', { tarefa: t.id, decisao: 'aceitar', texto: 'x' })).text).toMatch(/^409: a tarefa não está esperando decisão de limite de revisões/);
    capIt(b, t.id);
    const capped = b.raw();
    for (const [quem, token] of [
      ['responsável (Ana)', b.workerToken(t)],
      ['revisor (Rui)', b.tokenOf('rev-1')],
      ['outro funcionário (Bia)', b.tokenOf('bia-1')],
      ['de fora (Dev)', b.tokenOf('dev-1')],
    ] as const) {
      const r = await mcpOf(srv.api, token)('tarefa_decidir_limite', { tarefa: t.id, decisao: 'aceitar', texto: 'tento' });
      expect(r.isError, quem).toBe(true);
      expect(r.text, quem).toMatch(/^403: /);
    }
    expect(b.raw()).toBe(capped);
    expect(before).not.toBe(capped);
    expect((await mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }))('tarefa_decidir_limite', { tarefa: 't-000000', decisao: 'aceitar', texto: 'x' })).text).toMatch(/^404: /);
    // O pedido já passou ao usuário (`to: 'owner'`): o gestor leva 403 e só o usuário decide.
    capIt(b, t.id, 'owner');
    expect((await mcpOf(srv.api, b.tokenOf('gio-1', { session: 'c-gio-1' }))('tarefa_decidir_limite', { tarefa: t.id, decisao: 'aceitar', texto: 'x' })).text).toMatch(/^403: o pedido passou ao usuário/);
    await srv.close();
  });

  it('decisão fora do formato ou texto vazio, longo ou com controle: recusados antes de chamar a rota', async () => {
    const never: typeof fetch = () => Promise.reject(new Error('não devia chamar'));
    const mcp = createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => 'a'.repeat(64), fetchImpl: never });
    const call = (args: Record<string, unknown>) => mcp.callTool('tarefa_decidir_limite', args).then((r) => ({ text: r.content[0]!.text, isError: r.isError === true }));
    for (const decisao of ['approve', 'constructor', '__proto__', '', undefined, 5]) {
      const r = await call({ tarefa: 't-1a2b3c', decisao, texto: 'x' });
      expect(r.isError, String(decisao)).toBe(true);
      expect(r.text, String(decisao)).toContain('`decisao`');
    }
    for (const texto of ['', '   ', undefined, 7, 'a\u0000b', 'x'.repeat(2001)]) {
      const r = await call({ tarefa: 't-1a2b3c', decisao: 'aceitar', texto });
      expect(r.isError, String(texto)).toBe(true);
    }
    expect((await call({ tarefa: '../x', decisao: 'aceitar', texto: 'x' })).text).toContain('id da tarefa');
  });
});

describe('a entrada: só uma rota, só loopback, nada fora do formato', () => {
  const never: typeof fetch = () => Promise.reject(new Error('não devia chamar'));
  const call = (args: Record<string, unknown>, o: { token?: string } = {}) =>
    createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => ('token' in o ? o.token : 'a'.repeat(64)), fetchImpl: never }).callTool('tarefa_cancelar', args);

  it('id de tarefa fora do formato (caminho, barra, ponto) e motivo vazio ou com controle: recusados antes de chamar', async () => {
    for (const tarefa of ['../x', 't-1/cancel', 't-1?x=1', 'a b', '', 7, undefined, 't-' + '1'.repeat(60)]) {
      const r = await call({ tarefa, motivo: 'x' });
      expect(r.isError, String(tarefa)).toBe(true);
      expect(r.content[0]!.text).toContain('id da tarefa');
    }
    for (const motivo of ['', '   ', undefined, 5, 'a\u0000b', 'x'.repeat(2001)]) {
      const r = await call({ tarefa: 't-1a2b3c', motivo });
      expect(r.isError, String(motivo)).toBe(true);
      expect(r.content[0]!.text).toContain('motivo');
    }
  });

  it('o endereço do Club tem de ser http em loopback (o token não sai da máquina) e o projeto, um id simples', () => {
    for (const api of ['https://127.0.0.1:4848', 'http://example.com:4848', 'http://127.0.0.1.evil.com', 'http://user:pw@127.0.0.1:4848', 'nada', '']) {
      expect(() => createTarefaMcp({ api, projectId: 'p' }), api).toThrow();
    }
    expect(() => createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: '../p' })).toThrow();
    expect(() => createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'C--Users-didog-www-MyCo' })).not.toThrow();
    expect(() => createTarefaMcp({ api: 'http://localhost:4848', projectId: 'p' })).not.toThrow();
  });

  it('503 (a vez do responsável ocupada, nada gravado) repete até 2 vezes; depois do limite, o 503 volta', async () => {
    let hits = 0;
    const flaky: typeof fetch = async () => {
      hits++;
      return hits < 3 ? new Response(JSON.stringify({ error: 'ocupado' }), { status: 503 }) : new Response(JSON.stringify({ id: 't-1', status: 'cancelled' }), { status: 200 });
    };
    const mcp = createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => 'a'.repeat(64), fetchImpl: flaky, busyWaitMs: 0 });
    expect((await mcp.callTool('tarefa_cancelar', { tarefa: 't-1', motivo: 'x' })).content[0]!.text).toBe('cancelada: t-1 (status cancelled)');
    expect(hits).toBe(3);
    hits = -10;
    const r = await mcp.callTool('tarefa_cancelar', { tarefa: 't-1', motivo: 'x' });
    expect(r).toMatchObject({ isError: true, content: [{ text: '503: ocupado' }] });
    expect(hits).toBe(-7); // 3 tentativas (1 + 2 repetições)
  });

  it('sem resposta a tempo não repete (pode ter gravado) e manda conferir; servidor fora do ar diz que nada foi enviado', async () => {
    const slow: typeof fetch = (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
    const timed = createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => 'a'.repeat(64), fetchImpl: slow, timeoutMs: 20 });
    const r = await timed.callTool('tarefa_cancelar', { tarefa: 't-1', motivo: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('pode ter sido gravado');
    const down = createTarefaMcp({ api: 'http://127.0.0.1:1', projectId: 'p', token: () => 'a'.repeat(64) });
    const d = await down.callTool('tarefa_cancelar', { tarefa: 't-1', motivo: 'x' });
    expect(d.isError).toBe(true);
    expect(d.content[0]!.text).toContain('nada foi enviado');
  });

  it('o erro nunca leva o token', async () => {
    const token = 'b'.repeat(64);
    const echo: typeof fetch = async () => new Response(JSON.stringify({ error: 'recusado' }), { status: 403 });
    const mcp = createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => token, fetchImpl: echo });
    expect(JSON.stringify(await mcp.callTool('tarefa_cancelar', { tarefa: 't-1', motivo: 'x' }))).not.toContain(token);
    expect(JSON.stringify(TOOLS)).not.toContain('MYCO_TOKEN');
  });
});

describe('JSON-RPC: initialize, tools/list e tools/call', () => {
  const server = createTarefaMcp({ api: 'http://127.0.0.1:4848', projectId: 'p', token: () => undefined });

  it('initialize, ping e a lista com as 4 ferramentas (e só elas): as de cancelamento com tarefa e motivo, a do limite com tarefa, decisão e texto', async () => {
    const init = (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(init.result.serverInfo.name).toBe(TAREFA_MCP_NAME);
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(await server.handle({ jsonrpc: '2.0', id: 2, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    const list = (await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, { enum?: string[] }> } }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['tarefa_cancelar', 'tarefa_pedir_cancelamento', 'tarefa_recusar_cancelamento', 'tarefa_decidir_limite']);
    for (const t of list.result.tools) expect(t.inputSchema.required).toEqual(t.name === 'tarefa_decidir_limite' ? ['tarefa', 'decisao', 'texto'] : ['tarefa', 'motivo']);
    expect(list.result.tools[3]!.inputSchema.properties.decisao!.enum).toEqual(['aceitar', 'reabrir', 'cancelar']);
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });

  it('ferramenta ou método desconhecido, e argumentos que não são objeto: erro, sem chamar nada', async () => {
    expect(await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tarefa_apagar', arguments: {} } })).toMatchObject({ error: { code: -32602 } });
    expect(await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'tarefa_cancelar', arguments: [] } })).toMatchObject({ result: { isError: true } });
    expect(await server.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await server.handle(null)).toMatchObject({ error: { code: -32600 } });
  });

  it('pelo stdio: uma mensagem por linha, na ordem, e o sem-token vira erro de ferramenta', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (c: Buffer) => lines.push(...c.toString('utf8').split('\n').filter(Boolean)));
    const prev = process.env.MYCO_TOKEN;
    delete process.env.MYCO_TOKEN;
    try {
      const done = runTarefaMcpStdio(['--api', 'http://127.0.0.1:4848', '--project', 'p'], input, output);
      input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      input.write('lixo\n');
      input.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tarefa_cancelar","arguments":{"tarefa":"t-1a2b3c","motivo":"x"}}}\n');
      input.end();
      await done;
    } finally {
      if (prev !== undefined) process.env.MYCO_TOKEN = prev;
    }
    const out = lines.map((l) => JSON.parse(l) as { id: unknown; error?: { code: number }; result?: { isError?: boolean; content?: Array<{ text: string }> } });
    expect(out.map((o) => o.id)).toEqual([1, null, 2]);
    expect(out[1]!.error!.code).toBe(-32700);
    expect(out[2]!.result).toMatchObject({ isError: true });
    expect(out[2]!.result!.content![0]!.text).toContain('MYCO_TOKEN');
    await expect(runTarefaMcpStdio([], input, output)).rejects.toThrow('uso:');
  });
});

// ---- como a conversa sobe o MCP e o libera ----

const profile = (over: Partial<StaffProfile> = {}): StaffProfile =>
  ({
    id: 'ana-1',
    name: 'Ana',
    role: 'Back-end',
    mission: 'Servidor.',
    knowledge: [],
    rules: [],
    autonomy: 'acceptEdits',
    engine: 'claude',
    projectId: 'proj-x',
    worktree: false,
    servers: [],
    skills: [],
    agents: [],
    mcps: null,
    sessions: [],
    temporary: false,
    reportsTo: [],
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

const launch = (projectPath: string, home: string): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath,
  managerNames: [],
  mycoUrl: 'http://127.0.0.1:4848',
  runDir: path.join(home, 'run'),
  claudeConfigFile: path.join(projectPath, 'claude.json'),
  userAgentsDir: path.join(home, 'agents'),
});

describe('tarefaLaunchOf: só no Claude, fora da revisão e com o acesso ligado', () => {
  const ctx = { mycoUrl: 'http://127.0.0.1:4848' };

  it('Claude: o servidor leva só o endereço do Club e o projeto (nunca o token)', () => {
    const r = tarefaLaunchOf(profile(), ctx);
    expect(r.info).toEqual({ mcp: true });
    expect(r.server!.args.slice(-4)).toEqual(['--api', 'http://127.0.0.1:4848', '--project', 'proj-x']);
    expect(JSON.stringify(r)).not.toMatch(/token/i);
    expect(tarefaMcpServer({ api: 'http://127.0.0.1:4848', projectId: 'proj-x' }, false).args.slice(-4)).toEqual(['--api', 'http://127.0.0.1:4848', '--project', 'proj-x']);
  });

  it('Codex: sem o MCP e sem texto (segue o curl); revisão: sem o MCP, e a ficha diz', () => {
    expect(tarefaLaunchOf(profile({ engine: 'codex' }), ctx)).toEqual({ server: null });
    expect(tarefaLaunchOf(profile(), ctx, true)).toEqual({ info: { mcp: false }, server: null });
  });

  it('acesso desligado (off), só leitura ou pergunta (sem lista de leitura), ou sem endereço do Club: fora', () => {
    for (const level of ['off', 'readonly', 'ask'] as const) expect(tarefaLaunchOf(profile({ mcpAccess: { [TAREFA_MCP_NAME]: level } }), ctx)).toEqual({ info: { mcp: false }, server: null });
    expect(tarefaLaunchOf(profile(), { mycoUrl: '' })).toEqual({ info: { mcp: false }, server: null });
  });

  it('o nome é reservado no Codex (um MCP da ficha não o sobrescreve)', () => {
    expect(CODEX_RESERVED_MCP_NAMES.has(TAREFA_MCP_NAME)).toBe(true);
  });
});

describe('Claude: mcp.json, --allowedTools e a conversa de revisão', () => {
  const claude = (over: Partial<StaffProfile> = {}) => profile(over);
  const allowed = (args: string[]) => (args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1]!.split(',') : []);
  const denied = (args: string[]) => args[args.indexOf('--disallowedTools') + 1]!.split(',');
  const base = { sessionId: 's', resume: false, firstPrompt: null };
  let proj: string;
  let home: string;
  beforeAll(async () => {
    proj = path.join(root, 'launch-proj');
    home = path.join(root, 'launch-home');
    await fs.mkdir(path.join(proj, '.myco', 'staff'), { recursive: true });
    await fs.mkdir(home, { recursive: true });
  });

  it('entra no mcp.json e em --allowedTools em toda autonomia (o classificador do modo auto não vê, e não pede ao dono)', async () => {
    for (const autonomy of ['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      const p = claude({ autonomy });
      const run = await prepareRun(p, launch(proj, home), `sess-${autonomy}`, proj);
      expect(run.tarefaMcp, autonomy).toBe(true);
      const cfg = JSON.parse(await fs.readFile(run.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { type: string; args: string[]; env?: unknown }> };
      expect(cfg.mcpServers[TAREFA_MCP_NAME]!.type).toBe('stdio');
      expect(cfg.mcpServers[TAREFA_MCP_NAME]!.args.slice(-4)).toEqual(['--api', 'http://127.0.0.1:4848', '--project', 'proj-x']);
      // O token não passa pelo arquivo: o MCP o lê do ambiente da conversa.
      expect(cfg.mcpServers[TAREFA_MCP_NAME]!.env).toBeUndefined();
      expect(JSON.stringify(cfg)).not.toMatch(/x-myco-token/i);
      const args = buildClaudeArgs(p, { ...run, ...base });
      expect(allowed(args), autonomy).toContain(`mcp__${TAREFA_MCP_NAME}`);
      expect(denied(args), autonomy).not.toContain(`mcp__${TAREFA_MCP_NAME}`);
    }
  });

  it('na conversa de revisão NÃO entra: nem no mcp.json, nem em --allowedTools (mesmo com a flag ligada), e a regra de negar cobre o nome', async () => {
    const p = claude({ autonomy: 'auto' });
    const run = await prepareRun(p, launch(proj, home), 'sess-review', proj, true);
    expect(run.tarefaMcp).toBe(false);
    const cfg = run.mcpConfigPath ? (JSON.parse(await fs.readFile(run.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> }) : { mcpServers: {} };
    expect(cfg.mcpServers[TAREFA_MCP_NAME]).toBeUndefined();
    const review = buildClaudeArgs(p, { ...run, ...base, readOnly: true });
    expect(allowed(review)).not.toContain(`mcp__${TAREFA_MCP_NAME}`);
    expect(denied(review)).toContain(`mcp__${TAREFA_MCP_NAME}`);
    const forced = buildClaudeArgs(p, { ...run, ...base, tarefaMcp: true, readOnly: true });
    expect(allowed(forced)).not.toContain(`mcp__${TAREFA_MCP_NAME}`);
    // Fora da revisão a mesma flag libera.
    expect(allowed(buildClaudeArgs(p, { ...run, ...base, tarefaMcp: true }))).toContain(`mcp__${TAREFA_MCP_NAME}`);
  });

  it('acesso desligado na ficha: sem servidor, sem --allowedTools, e o --disallowedTools nega o MCP', async () => {
    const p = claude({ mcpAccess: { [TAREFA_MCP_NAME]: 'off' } });
    const run = await prepareRun(p, launch(proj, home), 'sess-off', proj);
    expect(run.tarefaMcp).toBe(false);
    const args = buildClaudeArgs(p, { ...run, ...base });
    expect(allowed(args)).not.toContain(`mcp__${TAREFA_MCP_NAME}`);
    expect(denied(args)).toContain(`mcp__${TAREFA_MCP_NAME}`);
  });

  it('Codex: o lançamento não leva o MCP (segue o curl)', async () => {
    const run = await prepareCodexRun(profile({ engine: 'codex' }), launch(proj, home), 'sess-codex', proj);
    // (a pasta de teste se chama myco-tarefamcp-…: procura o servidor, não o prefixo.)
    const s = JSON.stringify(run);
    expect(s).not.toContain('mcp__myco-tarefa');
    expect(s).not.toContain('tarefa-mcp');
    expect(s).not.toContain('"--api"');
    expect(Object.keys(run).filter((k) => /tarefa/i.test(k))).toEqual([]);
  });
});

// ---- os textos que mandam cancelar ----

describe('textos de cancelamento: o Claude aponta a ferramenta (com o curl de alternativa); o Codex segue o curl', () => {
  const TOOL = (t: (typeof TAREFA_TOOLS)[number]) => `\`mcp__${TAREFA_MCP_NAME}__${t}\``;
  const CURL = 'curl -s -X POST -H "x-myco: 1" -H "x-myco-token: $MYCO_TOKEN"';

  it('os helpers: a ferramenta só no Claude com o acesso ligado; o curl sempre presente', () => {
    expect(tarefaToolName('tarefa_cancelar')).toBe('mcp__myco-tarefa__tarefa_cancelar');
    expect(tarefaMcpOn(profile())).toBe(true);
    expect(tarefaMcpOn(profile({ engine: undefined }))).toBe(true);
    expect(tarefaMcpOn(profile({ engine: 'codex' }))).toBe(false);
    expect(tarefaMcpOn(profile({ mcpAccess: { [TAREFA_MCP_NAME]: 'off' } }))).toBe(false);
    expect(tarefaMcpOn(null)).toBe(false);
    expect(cancelWith(false, 'tarefa_cancelar', 't-1', '<m>', 'curl X')).toBe('com `curl X`');
    expect(cancelWith(true, 'tarefa_cancelar', 't-1', '<m>', 'curl X', '(nota)')).toBe(`com a ferramenta ${TOOL('tarefa_cancelar')} (\`tarefa\`: \`t-1\`, \`motivo\`: <m>); se ela faltar ou falhar, use o curl \`curl X\` (nota)`);
  });

  it('o aviso do pedido de cancelamento: no Claude, aceitar e recusar pelas ferramentas (curl de alternativa); no Codex, só o curl, como antes', async () => {
    const texts: Record<string, string> = {};
    for (const engine of ['claude', 'codex'] as const) {
      const b = board(`aviso-${engine}`, { workerEngine: engine });
      const t = await b.started('Exportar CSV');
      await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'o usuário mudou de ideia');
      texts[engine] = b.notices[0]!.text;
    }
    const api = (e: string) => (e === 'codex' ? 'http://127.0.0.2:4848' : 'http://127.0.0.1:4848');
    for (const engine of ['claude', 'codex']) {
      const text = texts[engine]!;
      // O curl com o endereço do motor está nos dois (no Claude como alternativa), e o resto do aviso é o mesmo.
      expect(text, engine).toContain(`${CURL} -H "content-type: application/json" -d '{"reason": "<o motivo, em uma frase>"}' ${api(engine)}/api/projects/p/tasks/`);
      expect(text, engine).toContain('/cancel-request/refuse');
      expect(text, engine).toContain('(o token da sua conversa já está em $MYCO_TOKEN; escreva o motivo sem aspas simples) e pare por aí, sem mais nada.');
      expect(text, engine).toContain('Cancelar não desfaz o que já foi feito');
    }
    expect(texts.claude).toContain(`- Aceitar: cancele com a ferramenta ${TOOL('tarefa_cancelar')}`);
    expect(texts.claude).toContain(`diga por quê com a ferramenta ${TOOL('tarefa_recusar_cancelamento')}`);
    expect(texts.claude).toContain('se ela faltar ou falhar, use o curl');
    expect(texts.codex).not.toContain('mcp__myco-tarefa');
    expect(texts.codex).toContain('- Aceitar: cancele pela API do Claudio’s Club com `curl');
    expect(texts.codex).toContain('diga por quê com `curl');
  });

  it('Claude com o acesso ao MCP desligado na ficha: o aviso é o do curl', async () => {
    const b = board('aviso-off');
    b.people['ana-1']!.mcpAccess = { [TAREFA_MCP_NAME]: 'off' };
    const t = await b.started('Exportar CSV');
    await b.svc.requestCancel('p', t.id, { staffId: 'gio-1', projectId: 'p', sessionId: 'c-gio-1', engine: 'claude', sandbox: false }, 'x');
    expect(b.notices[0]!.text).not.toContain('mcp__myco-tarefa');
    expect(b.notices[0]!.text).toContain('- Aceitar: cancele pela API do Claudio’s Club com `curl');
  });

  it('o aviso de "sem código" e o de tarefa parada pelo erro do motor (para o gestor): ferramenta no Claude, curl no Codex', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const b = board(`gestor-${engine}`, { managerEngine: engine });
      const t = await b.started('Exportar CSV');
      const priv = b.svc as unknown as {
        noCodeText(p: string, t: Task, s: string | undefined, w: StaffProfile | null, m: StaffProfile): string;
        engineStopText(p: string, t: Task, s: Record<string, unknown>, w: StaffProfile | null, m: StaffProfile): string;
      };
      const noCode = priv.noCodeText('p', t, undefined, b.people['ana-1']!, b.people['gio-1']!);
      const stop = priv.engineStopText('p', t, { engine: 'claude', error: 'falhou', why: 'other', since: 'x' }, b.people['ana-1']!, b.people['gio-1']!);
      if (engine === 'claude') {
        expect(noCode).toContain(`cancele, com o motivo, com a ferramenta ${TOOL('tarefa_cancelar')}`);
        expect(noCode).toContain(`${CURL} -H "content-type: application/json" -d '{"reason": "<por que, em uma frase>"}' http://127.0.0.1:4848/api/projects/p/tasks/${t.id}/cancel`);
        expect(stop).toContain(`peça o cancelamento, com o motivo, com a ferramenta ${TOOL('tarefa_pedir_cancelamento')}`);
        expect(stop).toContain(`/tasks/${t.id}/cancel-request`);
      } else {
        expect(noCode).not.toContain('mcp__myco-tarefa');
        expect(noCode).toContain(`cancele, com o motivo: \`${CURL}`);
        expect(noCode).toContain(`http://127.0.0.2:4848/api/projects/p/tasks/${t.id}/cancel`);
        expect(stop).not.toContain('mcp__myco-tarefa');
        expect(stop).toContain(`ou peça o cancelamento, com o motivo: \`${CURL}`);
      }
      // O resto dos dois avisos (revisar mesmo assim, retomar) não muda de motor.
      expect(noCode).toContain('/review-anyway');
      expect(stop).toContain('retome com uma mensagem na conversa da tarefa');
    }
  });

  it('o aviso de possível duplicata (para quem pediu): ferramenta no Claude, a rota no Codex', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const b = board(`dup-${engine}`, { managerEngine: engine });
      const body = (key: string) => ({ title: 'Exportar o relatório mensal em CSV', description: 'd', acceptance: 'a', staffId: 'ana-1', start: false, idempotencyKey: key });
      await b.svc.createAndStart('p', body('relatorio-a1'), 'gio-1', 'c-gio-1', { start: false });
      const second = (await b.svc.createAndStart('p', body('relatorio-b2'), 'gio-1', 'c-gio-1', { start: false }))!;
      const message = second.warnings![0]!.message;
      expect(message, engine).toContain(`POST .../tasks/${second.id}/cancel com o motivo`);
      if (engine === 'claude') expect(message).toContain(`cancele a nova (id ${second.id}) com a ferramenta ${TOOL('tarefa_cancelar')}`);
      else expect(message).toContain(`cancele a nova (id ${second.id}, POST .../tasks/${second.id}/cancel com o motivo)`);
      expect(message, engine).toContain('repita a mesma idempotencyKey');
    }
  });

  it('a linha de cancelar da tarefa (o responsável) fala a ferramenta no Claude e o curl no Codex; o fim é o mesmo', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const b = board(`linha-${engine}`, { workerEngine: engine });
      const priv = b.svc as unknown as { cancelLine(p: string, t: Task, e: Engine, prof: StaffProfile | null): string };
      const t = await b.make('Exportar CSV');
      const line = priv.cancelLine('p', t, engine, b.people['ana-1']!);
      expect(line).toContain('se o usuário pedir, sem dúvida, para cancelar esta tarefa, cancele ');
      expect(line).toContain('e pare por aí, sem mais nada.');
      expect(line).toContain('Nunca marque a tarefa como pronta nem a apague para "cancelar".');
      if (engine === 'claude') expect(line).toContain(`com a ferramenta ${TOOL('tarefa_cancelar')} (\`tarefa\`: \`${t.id}\``);
      else expect(line).not.toContain('mcp__myco-tarefa');
      expect(line).toContain(`${engine === 'codex' ? 'http://127.0.0.2:4848' : 'http://127.0.0.1:4848'}/api/projects/p/tasks/${t.id}/cancel`);
    }
  });

  it('a ficha de quem pede tarefas: ferramenta no Claude com o MCP na conversa; curl no Codex, na revisão e sem o MCP', () => {
    const ctx = (over: Partial<FichaContext> = {}): FichaContext => ({
      company: 'Acme',
      projectName: 'painel',
      projectPath: 'C:\\www\\painel',
      managerNames: [],
      fichaPath: '.myco\\staff\\gio-1.md',
      memoryPath: '.myco\\staff\\gio-1.memory.md',
      mycoUrl: 'http://127.0.0.1:4848',
      team: [{ id: 'ana-1', name: 'Ana', role: 'Back-end', mission: 'Servidor.' }],
      ...over,
    });
    const gio = (over: Partial<StaffProfile> = {}) => profile({ id: 'gio-1', name: 'Gio', role: 'Orquestrador', ...over });
    const claude = renderFicha(gio(), ctx({ tarefa: { mcp: true } }));
    expect(claude).toContain(`${TOOL('tarefa_cancelar')} (\`tarefa\`: o id; \`motivo\`: o porquê, em uma frase) cancela na hora`);
    expect(claude).toContain(`mande um pedido com ${TOOL('tarefa_pedir_cancelamento')}`);
    expect(claude).toContain('Se a ferramenta faltar ou falhar, a API: POST http://127.0.0.1:4848/api/projects/proj-x/tasks/<id da tarefa>/cancel com {"reason"');
    expect(claude).toContain('quem só revisa não cancela');
    // Sem o MCP na conversa (revisão, acesso desligado, sem informação) e no Codex: o texto de sempre.
    for (const md of [renderFicha(gio(), ctx({ tarefa: { mcp: false } })), renderFicha(gio(), ctx()), renderFicha(gio({ engine: 'codex' }), ctx({ mycoUrl: 'http://127.0.0.2:4848', tarefa: { mcp: true } }))]) {
      expect(md).not.toContain('mcp__myco-tarefa');
      expect(md).toMatch(/POST http:\/\/127\.0\.0\.\d:4848\/api\/projects\/proj-x\/tasks\/<id da tarefa>\/cancel com \{"reason": "<por quê, em uma frase>"\} \(mesmos cabeçalhos\) cancela na hora/);
      expect(md).toContain('/cancel-request com {"reason"');
    }
  });
});
