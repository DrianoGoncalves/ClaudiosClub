import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { actingStaff, isSandboxAddress, requesterSessionOf, resolveCaller, SANDBOX_HOST, SessionTokens, type TokenOwner } from '../server/callers';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { CodexProcess } from '../server/chat/codexProcess';
import { gate } from '../server/gate';
import { PAIR_COOKIE, Pairing } from '../server/pairing';

// Quem chama a API: o socket (127.0.0.2 = sandbox do Codex) e o token da conversa valem mais do que o pedido declara (Origin, cookie,
// requestedBy, reportsTo). Os testes de HTTP abrem a porta de entrada de verdade (server/gate.ts) nos dois endereços.

const owner = (over: Partial<TokenOwner> = {}): TokenOwner => ({ staffId: 'cris', projectId: 'p1', sessionId: 's-codex', engine: 'codex', ...over });

describe('socket: 127.0.0.2 é a sandbox do Codex', () => {
  it('só o endereço da sandbox conta, também na forma IPv4 mapeada em IPv6', () => {
    expect(SANDBOX_HOST).toBe('127.0.0.2');
    for (const a of ['127.0.0.2', '::ffff:127.0.0.2', '::FFFF:127.0.0.2']) expect(isSandboxAddress(a), a).toBe(true);
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.20', '127.0.0.22', '10.0.0.2', '0.0.0.0', '', undefined, null]) expect(isSandboxAddress(a), String(a)).toBe(false);
  });
});

describe('SessionTokens', () => {
  it('32 bytes aleatórios (64 hex), um por conversa, o mesmo enquanto ela existir', () => {
    const t = new SessionTokens();
    const a = t.issue(owner());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(t.issue(owner())).toBe(a); // outra execução da mesma conversa do Codex: o mesmo token
    const b = t.issue(owner({ sessionId: 's2', staffId: 'bia', engine: 'claude' }));
    expect(b).not.toBe(a);
    expect(t.lookup(a)).toEqual(owner());
    expect(t.lookup(b)).toEqual(owner({ sessionId: 's2', staffId: 'bia', engine: 'claude' }));
    expect(t.size).toBe(2);
  });

  it('o que não é um token da conversa não acha ninguém: vazio, curto, maiúsculas, de outro servidor', () => {
    const t = new SessionTokens();
    const a = t.issue(owner());
    for (const bad of [undefined, null, '', 'abc', a.slice(1), a.toUpperCase(), `${a} `, 'x'.repeat(64), '0'.repeat(64), new SessionTokens().issue(owner())]) {
      expect(t.lookup(bad), String(bad)).toBeNull();
    }
  });

  it('revogado, deixa de valer; a conversa que volta ganha outro; servidor novo começa vazio', () => {
    const t = new SessionTokens();
    const a = t.issue(owner());
    t.revoke('s-codex');
    expect(t.lookup(a)).toBeNull();
    const again = t.issue(owner());
    expect(again).not.toBe(a);
    expect(t.lookup(again)).toEqual(owner());
    t.revoke('nao-existe'); // sem efeito
    expect(new SessionTokens().lookup(again)).toBeNull();
  });
});

describe('resolveCaller', () => {
  const tokens = new SessionTokens();
  const codex = tokens.issue(owner());
  const claude = tokens.issue(owner({ sessionId: 's-claude', staffId: 'ana', engine: 'claude' }));

  it('pela sandbox: sem token é 401 com a mensagem do que fazer; token inventado também', () => {
    const none = resolveCaller(true, undefined, tokens);
    expect(none).toMatchObject({ ok: false, status: 401 });
    expect((none as { error: string }).error).toContain('x-myco-token');
    expect((none as { error: string }).error).toContain('$MYCO_TOKEN');
    expect(resolveCaller(true, '', tokens)).toMatchObject({ ok: false, status: 401 });
    const forged = resolveCaller(true, 'a'.repeat(64), tokens);
    expect(forged).toMatchObject({ ok: false, status: 401 });
    expect((forged as { error: string }).error).toContain('inválido');
  });

  it('pela sandbox: token de conversa do Claude não vale (só o de uma conversa do Codex)', () => {
    expect(resolveCaller(true, claude, tokens)).toMatchObject({ ok: false, status: 401 });
  });

  it('pela sandbox: quem chama é o dono do token', () => {
    expect(resolveCaller(true, codex, tokens)).toEqual({ ok: true, caller: { ...owner(), sandbox: true } });
    expect(resolveCaller(true, [codex], tokens)).toMatchObject({ ok: true }); // cabeçalho repetido: vale o primeiro
  });

  it('em 127.0.0.1 o token é opcional: ausente ou inválido segue sem dono; válido, o dono do token chama (Claude e Codex)', () => {
    expect(resolveCaller(false, undefined, tokens)).toEqual({ ok: true, caller: null });
    expect(resolveCaller(false, 'lixo', tokens)).toEqual({ ok: true, caller: null });
    expect(resolveCaller(false, 'a'.repeat(64), tokens)).toEqual({ ok: true, caller: null });
    expect(resolveCaller(false, claude, tokens)).toEqual({ ok: true, caller: { ...owner({ sessionId: 's-claude', staffId: 'ana', engine: 'claude' }), sandbox: false } });
    expect(resolveCaller(false, codex, tokens)).toEqual({ ok: true, caller: { ...owner(), sandbox: false } });
  });
});

describe('requestedBy: o token corrige o que o pedido declara', () => {
  const claude = { ...owner({ sessionId: 's-claude', staffId: 'ana', engine: 'claude' }), sandbox: false };

  it('com token vale quem chama, mesmo declarando outro; sem token (127.0.0.1) vale o declarado', () => {
    expect(actingStaff(claude, 'bia')).toEqual({ staffId: 'ana' });
    expect(actingStaff(claude, undefined)).toEqual({ staffId: 'ana' });
    expect(actingStaff({ ...claude, sandbox: true, staffId: 'cris', engine: 'codex' }, 'ana')).toEqual({ staffId: 'cris' });
    expect(actingStaff(null, 'bia')).toEqual({ staffId: 'bia' });
    expect(actingStaff(null, undefined)).toEqual({ staffId: undefined });
  });

  it('conversa sem ficha com token não é ninguém: não declara quem pede', () => {
    expect(actingStaff({ ...claude, staffId: null }, 'bia')).toMatchObject({ staffId: undefined, error: expect.stringContaining('com ficha') });
  });

  it('a conversa que pede a tarefa é a do token, quando o token é do próprio gestor', () => {
    expect(requesterSessionOf(claude, 'ana')).toBe('s-claude');
    expect(requesterSessionOf(claude, 'bia')).toBeUndefined();
    expect(requesterSessionOf(null, 'ana')).toBeUndefined();
    expect(requesterSessionOf({ ...claude, staffId: null }, undefined)).toBeUndefined();
  });
});

describe('rotas da sandbox do Codex', () => {
  const ask = (method: string, p: string) => sandboxVerdict(method, p, 'p1');

  it('libera só o que a ficha manda usar, no projeto da própria conversa', () => {
    for (const [m, p] of [
      ['GET', '/api/health'],
      ['GET', '/api/projects/p1/tasks'],
      ['POST', '/api/projects/p1/tasks'],
      ['POST', '/api/projects/p1/staff'],
      ['POST', '/api/projects/p1/chat/send'],
      ['POST', '/api/projects/p1/chat/abc-123/wake'],
      ['POST', '/api/projects/p1/chat/abc-123/wake/cancel'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/done'],
    ] as const) {
      expect(ask(m, p), `${m} ${p}`).toBeNull();
    }
  });

  it('o resto é 403: config, ficha, projetos, arquivos, git, terminal, importar, anexos, conversas, quadro, busca, fichas de outros projetos', () => {
    for (const [m, p] of [
      ['POST', '/api/config'],
      ['POST', '/api/projects/p1/staff/ana-1a2b'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/delete'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/restore'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/managers'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/keep'],
      ['POST', '/api/projects/p1/staff/ana-1a2b/routines'],
      ['POST', '/api/projects/p1/staff/copy'],
      ['POST', '/api/staff-link'],
      ['POST', '/api/projects/p1/tasks/t1/start'],
      ['POST', '/api/projects/p1/tasks/t1/merge'],
      ['POST', '/api/projects/p1/files/write'],
      ['POST', '/api/projects/p1/files/delete'],
      ['POST', '/api/projects/p1/attachments'],
      ['POST', '/api/projects/p1/connections'],
      ['POST', '/api/projects/p1/connections/list'],
      ['POST', '/api/new-project'],
      ['POST', '/api/import-projects'],
      ['POST', '/api/projects/p1/workspace'],
      ['POST', '/api/chat/s1/permission'],
      ['POST', '/api/chat/s1/stop'],
      ['POST', '/api/server/stop'],
      ['POST', '/api/server/restart'],
      ['POST', '/api/update'],
      ['POST', '/api/archive'],
      ['POST', '/api/pair/rotate'],
      ['POST', '/api/projects/p1/chat/s1/wake/user-cancel'],
      ['POST', '/api/projects/p1/chat/s1/merge'],
      ['GET', '/api/config'],
      ['GET', '/api/board'],
      ['GET', '/api/staff-directory'],
      ['GET', '/api/projects'],
      ['GET', '/api/projects/p1'],
      ['GET', '/api/projects/p1/files/read'],
      ['GET', '/api/projects/p1/files/tree'],
      ['GET', '/api/projects/p1/attachments/file'],
      ['GET', '/api/projects/p1/mcp'],
      ['GET', '/api/projects/p1/servers'],
      ['GET', '/api/projects/p1/chat/s1'],
      ['GET', '/api/projects/p1/staff/ana-1a2b/server-log'],
      ['GET', '/api/chat/s1/stream'],
      ['GET', '/api/search'],
      ['GET', '/api/inbox'],
      ['GET', '/api/account/rules'],
      ['GET', '/api/git'],
      ['GET', '/api/pair'],
      ['GET', '/'],
      ['GET', '/index.html'],
      ['GET', '/api/projects/p1/tasks/'],
      ['GET', '/api/projects/p1/tasks/t1/code'],
      ['POST', '/api/projects/p1/tasks/'],
      ['POST', '/api/projects/p1/chat/s1/compact'],
    ] as const) {
      expect(ask(m, p), `${m} ${p}`).toMatchObject({ status: 403 });
    }
  });

  it('outro projeto é 403, mesmo numa rota liberada', () => {
    for (const [m, p] of [
      ['GET', '/api/projects/outro/tasks'],
      ['POST', '/api/projects/outro/tasks'],
      ['POST', '/api/projects/outro/staff'],
      ['POST', '/api/projects/outro/chat/send'],
      ['POST', '/api/projects/outro/chat/s1/wake'],
      ['POST', '/api/projects/outro/staff/ana/done'],
    ] as const) {
      expect(ask(m, p), `${m} ${p}`).toMatchObject({ status: 403, error: expect.stringContaining('projeto') });
    }
  });

  it('os POSTs liberados são os mesmos da lista dos funcionários (a sandbox não ganha rota que eles não têm)', () => {
    for (const p of ['/api/projects/p1/tasks', '/api/projects/p1/staff', '/api/projects/p1/chat/send', '/api/projects/p1/chat/s/wake', '/api/projects/p1/chat/s/wake/cancel', '/api/projects/p1/staff/x/done']) {
      expect(staffMayPost(p)).toBe(true);
      expect(ask('POST', p)).toBeNull();
    }
    expect(ask('PUT', '/api/projects/p1/tasks')).toMatchObject({ status: 403 });
    expect(ask('DELETE', '/api/projects/p1/tasks')).toMatchObject({ status: 403 });
  });
});

// ---- a porta de entrada de verdade, nos dois endereços ----

let dir: string;
let pairing: Pairing;
const tokens = new SessionTokens();
const servers: http.Server[] = [];
let local: string;
let sandbox: string | null = null;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);
const isLocalOrigin = (o: string | undefined) => !o || LOCAL.has(new URL(o).hostname);

interface Reply {
  status: number;
  body: { error?: string; code?: string; sandbox?: boolean; fromBrowser?: boolean; caller?: Record<string, unknown> | null };
}

function call(base: string, method: 'GET' | 'POST', pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const listen = (srv: http.Server, host: string) =>
  new Promise<string | null>((resolve) => {
    srv.once('error', () => resolve(null));
    srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`));
  });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-callers-'));
  pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const g = gate(req, res, { pairing, tokens, localHostnames: LOCAL, isLocalOrigin, log: () => {} });
    if (!g) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sandbox: g.sandbox, fromBrowser: g.fromBrowser, caller: g.caller }));
  };
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  servers.push(a, b);
  local = (await listen(a, '127.0.0.1'))!;
  sandbox = await listen(b, SANDBOX_HOST); // sem o alias do 127.0.0.2 (macOS), os testes que dependem dele são pulados
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const STAFF = { 'x-myco': '1' };
const FORGED = { 'x-myco': '1', origin: 'http://localhost:4848' };
const codexToken = () => tokens.issue(owner());
const claudeToken = () => tokens.issue(owner({ sessionId: 's-claude', staffId: 'ana', engine: 'claude' }));
/** O cookie de um navegador pareado (o que a tela manda). */
const cookie = () => pairing.setCookieHeader().split(';')[0]!;

describe('porta de entrada: classificação pelo socket', () => {
  it('pelo 127.0.0.1 tudo segue como antes: tela com cookie, Origin forjado sem cookie recusado, ferramenta sem token passa', async () => {
    expect(PAIR_COOKIE.length).toBeGreaterThan(0);
    const tela = await call(local, 'POST', '/api/projects/p1/tasks', { ...FORGED, cookie: cookie() });
    expect(tela).toMatchObject({ status: 200, body: { sandbox: false, fromBrowser: true, caller: null } });
    const forjado = await call(local, 'POST', '/api/projects/p1/tasks', FORGED);
    expect(forjado.status).toBe(403);
    expect(forjado.body.code).toBe('needs-pairing');
    const ferramenta = await call(local, 'POST', '/api/projects/p1/tasks', STAFF);
    expect(ferramenta).toMatchObject({ status: 200, body: { sandbox: false, fromBrowser: false, caller: null } });
    // POST de funcionário fora da lista segue 400 (só pela tela), como antes.
    expect((await call(local, 'POST', '/api/config', STAFF)).status).toBe(400);
    // Sem x-myco: 403.
    expect((await call(local, 'POST', '/api/projects/p1/tasks', {})).status).toBe(403);
  });

  it('pelo 127.0.0.1, o token válido diz quem chama (Claude ou Codex); inválido segue sem dono; a tela não ganha dono', async () => {
    const claude = await call(local, 'POST', '/api/projects/p1/tasks', { ...STAFF, 'x-myco-token': claudeToken() });
    expect(claude.body).toMatchObject({ sandbox: false, fromBrowser: false, caller: { staffId: 'ana', engine: 'claude', sandbox: false } });
    const codex = await call(local, 'POST', '/api/projects/p1/tasks', { ...STAFF, 'x-myco-token': codexToken() });
    expect(codex.body).toMatchObject({ caller: { staffId: 'cris', engine: 'codex', sandbox: false } });
    const velho = await call(local, 'POST', '/api/projects/p1/tasks', { ...STAFF, 'x-myco-token': 'f'.repeat(64) });
    expect(velho).toMatchObject({ status: 200, body: { caller: null } });
    const tela = await call(local, 'POST', '/api/projects/p1/tasks', { ...FORGED, cookie: cookie(), 'x-myco-token': claudeToken() });
    expect(tela.body).toMatchObject({ fromBrowser: true, caller: null });
  });

  it('pelo 127.0.0.2 nunca é tela: Origin forjado, com ou sem cookie do navegador pareado, não conta; precisa do token (401)', async (ctx) => {
    if (!sandbox) return ctx.skip();
    for (const headers of [STAFF, FORGED, { ...FORGED, cookie: cookie() }, { ...STAFF, cookie: cookie() }]) {
      const r = await call(sandbox, 'POST', '/api/projects/p1/tasks', headers);
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body.error).toContain('x-myco-token');
      expect(r.body.code).toBeUndefined(); // não é o "needs-pairing" da tela
    }
    // GET também: sem token, nada.
    expect((await call(sandbox, 'GET', '/api/health')).status).toBe(401);
    expect((await call(sandbox, 'GET', '/api/projects/p1/tasks', { origin: 'http://localhost:4848', cookie: cookie() })).status).toBe(401);
  });

  it('pelo 127.0.0.2 com o token do Codex: quem chama é o dono; Origin e cookie forjados não viram tela', async (ctx) => {
    if (!sandbox) return ctx.skip();
    const token = codexToken();
    const ok = await call(sandbox, 'POST', '/api/projects/p1/tasks', { ...STAFF, 'x-myco-token': token });
    expect(ok).toMatchObject({ status: 200, body: { sandbox: true, fromBrowser: false, caller: { staffId: 'cris', projectId: 'p1', sessionId: 's-codex', engine: 'codex', sandbox: true } } });
    const extras: Array<Record<string, string>> = [{ origin: 'http://localhost:4848' }, { origin: 'http://claudio.localhost:4848', cookie: cookie() }];
    for (const extra of extras) {
      const forged = await call(sandbox, 'POST', '/api/projects/p1/tasks', { ...STAFF, ...extra, 'x-myco-token': token });
      expect(forged.body, JSON.stringify(extra)).toMatchObject({ sandbox: true, fromBrowser: false, caller: { staffId: 'cris' } });
    }
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': token })).status).toBe(200);
    expect((await call(sandbox, 'GET', '/api/projects/p1/tasks', { 'x-myco-token': token })).status).toBe(200);
  });

  it('pelo 127.0.0.2: token inventado, vazio ou de uma conversa do Claude é 401 (inválido)', async (ctx) => {
    if (!sandbox) return ctx.skip();
    for (const t of ['f'.repeat(64), 'curto', claudeToken()]) {
      const r = await call(sandbox, 'POST', '/api/projects/p1/tasks', { ...STAFF, 'x-myco-token': t });
      expect(r.status, t).toBe(401);
      expect(r.body.error).toContain('inválido');
    }
    // Conversa fechada: o token revogado deixa de valer.
    const t = tokens.issue(owner({ sessionId: 's-fecha' }));
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': t })).status).toBe(200);
    tokens.revoke('s-fecha');
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': t })).status).toBe(401);
  });

  it('pelo 127.0.0.2 com token válido: as rotas fora da lista são 403 (mesmo com Origin e cookie), e outro projeto também', async (ctx) => {
    if (!sandbox) return ctx.skip();
    const h: Record<string, string> = { ...FORGED, cookie: cookie(), 'x-myco-token': codexToken() };
    for (const [m, p] of [
      ['POST', '/api/config'],
      ['POST', '/api/projects/p1/staff/ana/routines'],
      ['POST', '/api/projects/p1/files/write'],
      ['POST', '/api/server/stop'],
      ['POST', '/api/pair/rotate'],
      ['POST', '/api/pair/approve'],
      ['GET', '/api/pair'],
      ['GET', '/api/config'],
      ['GET', '/api/board'],
      ['GET', '/api/staff-directory'],
      ['GET', '/api/projects/p1/files/read'],
      ['GET', '/api/projects/outro/tasks'],
      ['POST', '/api/projects/outro/tasks'],
      ['GET', '/'],
    ] as const) {
      const r = await call(sandbox, m, p, m === 'POST' ? h : { 'x-myco-token': h['x-myco-token']!, origin: h.origin!, cookie: h.cookie! });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });

  it('Host: pelo 127.0.0.2 só o próprio 127.0.0.2 e os de sempre; Host de fora (DNS rebinding) é 403 nos dois', async (ctx) => {
    if (!sandbox) return ctx.skip();
    const token = codexToken();
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': token, host: `${SANDBOX_HOST}:1` })).status).toBe(200);
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': token, host: 'evil.example:80' })).status).toBe(403);
    expect((await call(local, 'GET', '/api/health', { host: 'evil.example:80' })).status).toBe(403);
    // O Host 127.0.0.2 só vale no socket da sandbox: em 127.0.0.1 continua fora da lista.
    expect((await call(local, 'GET', '/api/health', { host: `${SANDBOX_HOST}:1` })).status).toBe(403);
  });
});

describe('o servidor (server/index.ts) usa tudo isso', () => {
  it('escuta também em 127.0.0.2 na mesma porta; a ficha do Codex e as conversas usam esse endereço e o token; as rotas usam quem chama', async () => {
    const index = await fs.promises.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(index).toContain('sandboxServer.listen(PORT, SANDBOX_HOST');
    expect(index).toContain('server.listen(PORT, HOST');
    expect(index).toContain("const HOST = '127.0.0.1';");
    expect(index).toContain('codexUrl: SANDBOX_URL');
    expect(index).toContain('tokens: sessionTokens');
    // Mensagem e despertador (agendar e desfazer) conferem a sandbox; contratar, tarefa e encerrar usam o dono do token.
    expect(index.match(/await checkReach\(caller, /g)).toHaveLength(3);
    expect(index.match(/tasks\.mayAskRequester\(pid!, caller, target\)/g)).toHaveLength(2);
    expect(index).toContain('requesterAskLimiter.check');
    expect(index).toContain('sandboxApiUrl: SANDBOX_URL');
    expect(index).toContain('staff.hire(id!, body, fromBrowser, caller)');
    expect(index.match(/actorOf\(caller, b\.requestedBy\)/g)).toHaveLength(2);
    // Sem o 127.0.0.2 de pé, o Codex roda sem rede (e a conversa avisa), em vez de rodar com a rede aberta.
    expect(index).toContain('sandboxListener.up = true');
    expect(index).toContain('withAppAddress(await codexEnv.status(), sandboxListener');
  });
});

// ---- o token chega ao ambiente de cada conversa ----

function fakeProc() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  return proc;
}

describe('MYCO_TOKEN no ambiente da conversa', () => {
  it('Claude: MYCO_TOKEN ao lado do MYCO_SESSION_ID; sem token, a variável nem existe', () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const spawnImpl = (_c: string, _a: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => (envs.push(o.env), fakeProc() as never);
    new ChatProcess({ sessionId: 'abc', cwd: '.', args: [], spawnImpl, mycoToken: 'a'.repeat(64) }).start();
    new ChatProcess({ sessionId: 'def', cwd: '.', args: [], spawnImpl }).start();
    expect(envs[0]).toMatchObject({ MYCO_SESSION_ID: 'abc', MYCO_TOKEN: 'a'.repeat(64) });
    expect(envs[1]!.MYCO_SESSION_ID).toBe('def');
    expect(envs[1]).not.toHaveProperty('MYCO_TOKEN');
  });

  it('Codex: o mesmo token e a URL do 127.0.0.2 em toda execução da conversa (uma por mensagem)', async () => {
    const envs: NodeJS.ProcessEnv[] = [];
    const spawnImpl = (_c: string, _a: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => {
      envs.push(o.env);
      const proc = fakeProc();
      setImmediate(() => proc.emit('close', 0));
      return proc as never;
    };
    const chat = new CodexProcess({
      sessionId: 'sess-1',
      cwd: dir,
      permissionMode: 'acceptEdits',
      secrets: { mycoHome: path.join(dir, 'sem-myco'), home: path.join(dir, 'sem-home'), projectPath: dir },
      mycoToken: 'b'.repeat(64),
      mycoUrl: 'http://127.0.0.2:4848',
      spawnImpl,
    });
    chat.start();
    chat.send('um');
    await new Promise((r) => setTimeout(r, 30));
    chat.send('dois');
    await new Promise((r) => setTimeout(r, 30));
    expect(envs).toHaveLength(2);
    for (const env of envs) expect(env).toMatchObject({ MYCO_SESSION_ID: 'sess-1', MYCO_TOKEN: 'b'.repeat(64), MYCO_URL: 'http://127.0.0.2:4848' });
  });

  it('ChatManager: cada conversa abre com o seu token (Claude e Codex), o mesmo se ela reabre, e o dono é quem a abriu', async () => {
    const reg = new SessionTokens();
    const envs: Record<string, NodeJS.ProcessEnv> = {};
    const manager = new ChatManager({
      transcriptsDir: dir,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      tokens: reg,
      resolve: async (_p, sid, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sid ?? 'sess-codex',
              cwd: dir,
              args: [],
              engine: 'codex' as const,
              codex: {
                autonomy: 'acceptEdits' as const,
                model: null,
                effort: null,
                instructions: 'Ficha',
                writableRoots: [],
                readOnlyPaths: [],
                secrets: { projectPath: dir, home: path.join(dir, 'sem-home'), mycoHome: path.join(dir, 'sem-myco') },
                threadId: null,
                threadFile: path.join(dir, 'codex-thread.json'),
                mycoUrl: 'http://127.0.0.2:4848',
              },
            }
          : { sessionId: sid ?? 'sess-claude', cwd: dir, args: ['--resume', 'x'] },
      spawnImpl: (cmd, _a, o) => {
        const proc = fakeProc();
        envs[cmd] = o.env;
        proc.stdin.on('finish', () => proc.emit('exit', 0));
        if (cmd === 'codex') setImmediate(() => proc.emit('close', 0));
        return proc as never;
      },
      log: () => {},
    });
    await manager.send('p1', null, 'cris', 'oi');
    await manager.send('p1', null, 'ana', 'oi');
    await new Promise((r) => setTimeout(r, 30));
    const tc = envs.codex!.MYCO_TOKEN!;
    const tl = envs.claude!.MYCO_TOKEN!;
    expect(tc).toMatch(/^[0-9a-f]{64}$/);
    expect(tl).toMatch(/^[0-9a-f]{64}$/);
    expect(tc).not.toBe(tl);
    expect(envs.codex!.MYCO_URL).toBe('http://127.0.0.2:4848');
    expect(envs.claude).not.toHaveProperty('MYCO_URL');
    expect(reg.lookup(tc)).toEqual({ staffId: 'cris', projectId: 'p1', sessionId: 'sess-codex', engine: 'codex' });
    expect(reg.lookup(tl)).toEqual({ staffId: 'ana', projectId: 'p1', sessionId: 'sess-claude', engine: 'claude' });
    // Reabre a mesma conversa (a ficha mudou, o processo fechou): o mesmo token.
    manager.stop('sess-claude');
    await new Promise((r) => setTimeout(r, 30));
    await manager.send('p1', 'sess-claude', 'ana', 'de novo');
    expect(envs.claude!.MYCO_TOKEN).toBe(tl);
  });
});
