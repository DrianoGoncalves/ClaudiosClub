import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectScopeVerdict, sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { resolveCaller, SANDBOX_HOST, SessionTokens, type TokenOwner } from '../server/callers';
import { isProjectDir } from '../server/adapters/claude/paths';
import { ChatManager, findTranscript, type ChatManagerOptions } from '../server/chat/manager';
import { gate, refusalLine } from '../server/gate';
import { Pairing } from '../server/pairing';
import { sessionAllowed, sessionInProject, type SessionScopeDeps } from '../server/sessionScope';
import { TaskService } from '../server/tasks';
import type { StaffProfile } from '../shared/model';

// Isolamento entre projetos (t-7e85fa): o token de uma conversa só alcança o projeto dela, em POST e em GET; o token inválido é 401 (nunca leitura
// anônima); a conversa de outro projeto não se lê nem recebe mensagem pelo id; a tela e a sandbox do Codex seguem como estavam.

const who = (over: Partial<TokenOwner> = {}): TokenOwner => ({ staffId: 'ana', projectId: 'p1', sessionId: 's-ana', engine: 'claude', ...over });

// ---- a porta de entrada de verdade ----

let dir: string;
let pairing: Pairing;
const tokens = new SessionTokens();
const logs: string[] = [];
const servers: http.Server[] = [];
let local: string;
let sandbox: string | null = null;
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);
const isLocalOrigin = (o: string | undefined) => !o || LOCAL.has(new URL(o).hostname);

interface Reply {
  status: number;
  body: { error?: string; code?: string; fromBrowser?: boolean; sandbox?: boolean; caller?: Record<string, unknown> | null };
}

function call(base: string, method: 'GET' | 'POST', pathname: string, headers: Record<string, string> = {}, body = '{}'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? body : undefined);
  });
}

const listen = (srv: http.Server, host: string) =>
  new Promise<string | null>((resolve) => {
    srv.once('error', () => resolve(null));
    srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`));
  });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-isolation-'));
  pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const g = gate(req, res, { pairing, tokens, localHostnames: LOCAL, isLocalOrigin, log: (line) => logs.push(line) });
    if (!g) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sandbox: g.sandbox, fromBrowser: g.fromBrowser, caller: g.caller }));
  };
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  servers.push(a, b);
  local = (await listen(a, '127.0.0.1'))!;
  sandbox = await listen(b, SANDBOX_HOST); // sem o alias do 127.0.0.2 (macOS), os testes da sandbox são pulados
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

const STAFF = { 'x-myco': '1' };
const cookie = () => pairing.setCookieHeader().split(';')[0]!;
const ana = () => tokens.issue(who()); // Claude, projeto p1
const bob = () => tokens.issue(who({ staffId: 'bob', projectId: 'p2', sessionId: 's-bob' })); // Claude, projeto p2
const cris = () => tokens.issue(who({ staffId: 'cris', sessionId: 's-cris', engine: 'codex' })); // Codex, projeto p1
const withToken = (t: string) => ({ ...STAFF, 'x-myco-token': t });

/** Todas as rotas POST de funcionário (apiPolicy.ts `staffMayPost`), no projeto p1. */
const STAFF_ROUTES = [
  '/api/projects/p1/tasks',
  '/api/projects/p1/tasks/t1',
  '/api/projects/p1/staff',
  '/api/projects/p1/chat/send',
  '/api/projects/p1/chat/s1/wake',
  '/api/projects/p1/chat/s1/wake/cancel',
  '/api/projects/p1/staff/x/done',
  '/api/projects/p1/tasks/t1/answer',
  '/api/projects/p1/tasks/t1/cancel',
  '/api/projects/p1/tasks/t1/cancel-request',
  '/api/projects/p1/tasks/t1/cancel-request/refuse',
  '/api/projects/p1/tasks/t1/order',
  '/api/projects/p1/tasks/t1/followup',
  '/api/projects/p1/tasks/t1/followup/f1/resolve',
  '/api/projects/p1/tasks/t1/followup/f1/card',
  '/api/projects/p1/tasks/t1/review-anyway',
];

describe('POST de funcionário: o token é do projeto da URL', () => {
  it('a lista de teste cobre todas as rotas de funcionário', () => {
    for (const p of STAFF_ROUTES) expect(staffMayPost(p), p).toBe(true);
    expect(STAFF_ROUTES).toHaveLength(16);
  });

  it('token de OUTRO projeto é 403 em toda rota de funcionário, com o que fazer; o do mesmo projeto passa como antes', async () => {
    for (const p of STAFF_ROUTES) {
      const outro = await call(local, 'POST', p, withToken(bob()));
      expect(outro.status, p).toBe(403);
      expect(outro.body.error, p).toContain('outro projeto');
      expect(outro.body.error, p).toContain('peça ao usuário');
      const mesmo = await call(local, 'POST', p, withToken(ana()));
      expect(mesmo, p).toMatchObject({ status: 200, body: { fromBrowser: false, caller: { staffId: 'ana', projectId: 'p1' } } });
    }
    // Codex fora da sandbox (127.0.0.1) segue a mesma regra.
    expect((await call(local, 'POST', '/api/projects/p2/chat/send', withToken(cris()))).status).toBe(403);
    expect((await call(local, 'POST', '/api/projects/p1/chat/send', withToken(cris()))).status).toBe(200);
  });

  it('sem token é 401 (decisão: o servidor não sabe de que projeto o pedido é); token inventado, de conversa fechada ou de antes de um reinício também', async () => {
    for (const p of STAFF_ROUTES) {
      const sem = await call(local, 'POST', p, STAFF);
      expect(sem.status, p).toBe(401);
      expect(sem.body.error, p).toContain('$MYCO_TOKEN');
    }
    const velho = tokens.issue(who({ sessionId: 's-fechada' }));
    tokens.revoke('s-fechada');
    for (const t of ['f'.repeat(64), 'curto', velho, new SessionTokens().issue(who())]) {
      const r = await call(local, 'POST', '/api/projects/p1/chat/send', withToken(t));
      expect(r.status, t).toBe(401);
      expect(r.body.error, t).toContain('Reabra a conversa');
    }
    // Rota que não é de funcionário segue "só pelo Claudio’s Club" (400), sem token.
    expect((await call(local, 'POST', '/api/config', STAFF)).status).toBe(400);
    expect((await call(local, 'POST', '/api/projects/p1/files/write', STAFF)).status).toBe(400);
  });

  it('a tela (Origin local e cookie) segue como estava: passa sem token, e o token que vier, de outro projeto ou inválido, é ignorado', async () => {
    const tela = { ...STAFF, origin: 'http://localhost:4848', cookie: cookie() };
    for (const extra of [{}, { 'x-myco-token': bob() }, { 'x-myco-token': 'f'.repeat(64) }] as Array<Record<string, string>>) {
      const r = await call(local, 'POST', '/api/projects/p1/chat/send', { ...tela, ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ status: 200, body: { fromBrowser: true, caller: null } });
    }
    // Origin forjado sem o cookie: recusado antes de tudo, como antes.
    expect((await call(local, 'POST', '/api/projects/p1/chat/send', { ...STAFF, origin: 'http://localhost:4848' })).status).toBe(403);
  });
});

describe('GET com token: só o próprio projeto', () => {
  const OWN_GETS = ['/api/projects/p1/tasks', '/api/projects/p1/chat/s1', '/api/projects/p1/chat/s1/changes', '/api/projects/p1/chat/s1/mcp', '/api/projects/p1', '/api/projects/p1/tasks/t1/code', '/api/projects/p1/staff/x/server-log'];

  it('token de outro projeto é 403 nos GETs de conversa e tarefa; no próprio projeto e no health passa', async () => {
    for (const p of OWN_GETS) {
      const outro = await call(local, 'GET', p, { 'x-myco-token': bob() });
      expect(outro.status, p).toBe(403);
      expect(outro.body.error, p).toContain('outro projeto');
      expect((await call(local, 'GET', p, { 'x-myco-token': ana() })).status, p).toBe(200);
    }
    expect((await call(local, 'GET', '/api/health', { 'x-myco-token': bob() })).status).toBe(200);
  });

  it('o que não é de projeto (quadro, busca, caixa, custos, stream de conversa, orquestração…) é 403 para quem tem token, até o do próprio projeto', async () => {
    for (const p of [
      '/api/board',
      '/api/search',
      '/api/inbox',
      '/api/live',
      '/api/turns',
      '/api/costs',
      '/api/task-costs',
      '/api/tasks/summary',
      '/api/staff-directory',
      '/api/projects',
      '/api/git',
      '/api/config',
      '/api/people/x/memory',
      '/api/mcp-servers',
      '/api/sessions/s1/orchestration',
      '/api/chat/s1/stream',
    ]) {
      for (const t of [bob(), ana()]) {
        const r = await call(local, 'GET', p, { 'x-myco-token': t });
        expect(r.status, p).toBe(403);
        expect(r.body.error, p).toContain('/api/health');
      }
    }
  });

  it('token inválido é 401 em GET (nunca leitura anônima), até no health', async () => {
    for (const p of ['/api/health', '/api/projects/p1/tasks', '/api/projects/p1/chat/s1', '/api/chat/s1/stream', '/api/board']) {
      const r = await call(local, 'GET', p, { 'x-myco-token': 'f'.repeat(64) });
      expect(r.status, p).toBe(401);
      expect(r.body.error, p).toContain('Reabra a conversa');
    }
  });
});

// GET sem token e sem cookie (t-2d101e): era o que sobrava aberto. O GET da tela não manda Origin, então só o cookie do pareamento a distingue de um curl.
describe('GET sem token e sem cookie: a leitura é da tela pareada ou do token do projeto', () => {
  /** O que um funcionário que NÃO manda o x-myco-token lia, de qualquer projeto: quadro, busca, caixa, tarefas, conversa (viva ou fechada), stream e retratos. */
  const READS = [
    '/api/board',
    '/api/search',
    '/api/inbox',
    '/api/projects/p2/tasks',
    '/api/projects/p2/chat/s1',
    '/api/projects/p2/chat/s1/changes',
    '/api/chat/s1/stream',
    '/api/projects/p2/staff/x/portrait',
    '/api/server',
    '/api/config',
    '/api/projects',
  ];

  it('sem cookie e sem token é 401 needs-pairing, com o que fazer, em toda leitura; só o health abre', async () => {
    for (const p of READS) {
      const r = await call(local, 'GET', p);
      expect(r.status, p).toBe(401);
      expect(r.body.code, p).toBe('needs-pairing');
      expect(r.body.error, p).toContain('Parear este navegador');
      expect(r.body.error, p).toContain('x-myco-token');
    }
    expect((await call(local, 'GET', '/api/health')).status).toBe(200);
  });

  it('a tela pareada lê tudo (200): com o cookie e sem Origin (o GET da página), ou com Origin local', async () => {
    for (const h of [{ cookie: cookie() }, { cookie: cookie(), origin: 'http://localhost:4848' }, { cookie: cookie(), origin: 'http://claudio.localhost:5173' }] as Array<Record<string, string>>) {
      for (const p of READS) expect((await call(local, 'GET', p, h)).status, `${p} ${JSON.stringify(Object.keys(h))}`).toBe(200);
    }
  });

  it('cookie que não vale continua 401: valor falso, outro nome, ou um Origin de fora (a página de outro site não vira tela)', async () => {
    const valor = cookie().split('=')[1]!;
    for (const h of [{ cookie: 'myco_pair=v1.falso' }, { cookie: `outro=${valor}` }, { cookie: cookie(), origin: 'https://evil.example' }] as Array<Record<string, string>>) {
      for (const p of ['/api/board', '/api/projects/p2/chat/s1', '/api/chat/s1/stream']) {
        const r = await call(local, 'GET', p, h);
        expect(r.status, `${p} ${JSON.stringify(h)}`).toBe(401);
        expect(r.body.code).toBe('needs-pairing');
      }
    }
  });

  it('o token do mesmo projeto lê o projeto dele (200); o de outro projeto é 403; fora de projeto, 403 até para ele', async () => {
    expect((await call(local, 'GET', '/api/projects/p1/tasks', { 'x-myco-token': ana() })).status).toBe(200);
    expect((await call(local, 'GET', '/api/projects/p1/chat/s1', { 'x-myco-token': ana() })).status).toBe(200);
    for (const p of ['/api/projects/p1/tasks', '/api/projects/p1/chat/s1']) expect((await call(local, 'GET', p, { 'x-myco-token': bob() })).status, p).toBe(403);
    expect((await call(local, 'GET', '/api/projects/p2/tasks', { 'x-myco-token': ana() })).status).toBe(403);
    expect((await call(local, 'GET', '/api/board', { 'x-myco-token': ana() })).status).toBe(403);
  });

  it('a página (/, assets) abre sem cookie: é ela que mostra o aviso de parear', async () => {
    for (const p of ['/', '/index.html', '/assets/index-abc.js', '/start.html']) expect((await call(local, 'GET', p)).status, p).toBe(200);
  });

  it('a recusa vai para o log (motivo sem-cookie, rota e projeto) sem token nem cookie', async () => {
    logs.length = 0;
    await call(local, 'GET', '/api/projects/p2/chat/s1', { cookie: 'myco_pair=v1.SEGREDO-FALSO' });
    expect(logs.join('\n')).toContain('recusado 401 (sem-cookie): GET /api/projects/p2/chat/s1 projeto=p2 chamador=sem token');
    expect(logs.join('\n')).not.toContain('SEGREDO-FALSO');
  });
});

describe('cookie e token juntos: a regra mais estreita vence', () => {
  it('GET da tela (sem Origin, com cookie): sem token é a tela; com token válido restringe ao projeto dele; inválido é 401', async () => {
    expect((await call(local, 'GET', '/api/board', { cookie: cookie() })).status).toBe(200);
    expect((await call(local, 'GET', '/api/projects/p1/tasks', { cookie: cookie(), 'x-myco-token': ana() })).status).toBe(200);
    expect((await call(local, 'GET', '/api/projects/p1/tasks', { cookie: cookie(), 'x-myco-token': bob() })).status).toBe(403);
    expect((await call(local, 'GET', '/api/board', { cookie: cookie(), 'x-myco-token': ana() })).status).toBe(403);
    expect((await call(local, 'GET', '/api/projects/p1/tasks', { cookie: cookie(), 'x-myco-token': 'f'.repeat(64) })).status).toBe(401);
  });

  it('POST da tela (Origin local e cookie) ignora o token, e sem Origin o cookie sozinho não faz da ferramenta a tela', async () => {
    const tela = { ...STAFF, origin: 'http://localhost:4848', cookie: cookie() };
    expect((await call(local, 'POST', '/api/projects/p1/chat/send', { ...tela, 'x-myco-token': bob() })).body).toMatchObject({ fromBrowser: true, caller: null });
    // Funcionário que só tem o cookie (sem Origin): continua precisando do token na rota de funcionário.
    expect((await call(local, 'POST', '/api/projects/p1/chat/send', { ...STAFF, cookie: cookie() })).status).toBe(401);
    expect((await call(local, 'POST', '/api/projects/p1/chat/send', { ...STAFF, cookie: cookie(), 'x-myco-token': bob() })).status).toBe(403);
  });
});

describe('log da recusa: motivo, rota, projeto e quem chamou; nunca token, cookie nem conteúdo', () => {
  it('cada recusa por token ou projeto deixa uma linha, sem segredo', async () => {
    logs.length = 0;
    const tb = bob();
    const velho = 'e'.repeat(64);
    await call(local, 'POST', '/api/projects/p1/chat/send', { ...withToken(tb), cookie: cookie() }, '{"text":"SEGREDO-NO-CORPO"}');
    await call(local, 'POST', '/api/projects/p1/chat/send', STAFF, '{"text":"SEGREDO-NO-CORPO"}');
    await call(local, 'GET', '/api/projects/p1/tasks', { 'x-myco-token': velho });
    await call(local, 'GET', '/api/board', { 'x-myco-token': tb });
    const text = logs.join('\n');
    expect(text).toContain('recusado 403 (outro-projeto): POST /api/projects/p1/chat/send projeto=p1 chamador=bob (claude, conversa s-bob, token do projeto p2)');
    expect(text).toContain('recusado 401 (sem-token): POST /api/projects/p1/chat/send projeto=p1 chamador=sem token');
    expect(text).toContain('recusado 401 (token-invalido): GET /api/projects/p1/tasks projeto=p1 chamador=sem token');
    expect(text).toContain('recusado 403 (rota-fora-do-projeto): GET /api/board projeto=- chamador=bob');
    for (const secret of [tb, velho, cookie().split('=')[1]!, 'SEGREDO-NO-CORPO']) expect(text).not.toContain(secret);
  });

  it('a linha só leva caracteres imprimíveis e o caminho cortado', () => {
    const line = refusalLine({ status: 403, reason: 'x', method: 'GET', pathname: `/api/a\nb${'z'.repeat(500)}`, caller: null });
    expect(line).not.toMatch(/[\r\n]/);
    expect(line.length).toBeLessThan(400);
  });
});

describe('sandbox do Codex: inalterada, e a regra nova não amplia o que ela barra', () => {
  it('pelo 127.0.0.2, o veredito da sandbox vem primeiro (mensagem dela) e só tarefas do próprio projeto passam no GET', async (ctx) => {
    if (!sandbox) return ctx.skip();
    const h = { 'x-myco-token': cris() };
    expect((await call(sandbox, 'GET', '/api/projects/p1/tasks', h)).status).toBe(200);
    for (const p of ['/api/projects/p1/chat/s1', '/api/projects/p1/chat/s1/changes', '/api/projects/p1/files/read', '/api/projects/p1/mcp', '/api/board', '/api/chat/s1/stream']) {
      const r = await call(sandbox, 'GET', p, h);
      expect(r.status, p).toBe(403);
      expect(r.body.error, p).toContain('sandbox do Codex');
    }
    const outro = await call(sandbox, 'GET', '/api/projects/p2/tasks', h);
    expect(outro.status).toBe(403);
    expect(outro.body.error).toContain('sandbox do Codex só fala com o projeto da própria conversa');
    // Token do Claude pela sandbox segue 401; POST de outro projeto, 403 da sandbox.
    expect((await call(sandbox, 'GET', '/api/health', { 'x-myco-token': ana() })).status).toBe(401);
    expect((await call(sandbox, 'POST', '/api/projects/p2/tasks', { ...STAFF, ...h })).status).toBe(403);
  });

  it('todo GET que a regra do token libera no projeto e a sandbox barra continua barrado para ela', () => {
    const own = ['/api/projects/p1', '/api/projects/p1/chat/s1', '/api/projects/p1/chat/s1/changes', '/api/projects/p1/files/read', '/api/projects/p1/mcp', '/api/projects/p1/staff/x/server-log', '/api/projects/p1/tasks/t1/code'];
    for (const p of own) {
      expect(projectScopeVerdict('GET', p, 'p1'), p).toBeNull();
      expect(sandboxVerdict('GET', p, 'p1'), p).toMatchObject({ status: 403 });
    }
    // O único GET de projeto da sandbox é o das tarefas, e os de fora do projeto não são dela.
    expect(sandboxVerdict('GET', '/api/projects/p1/tasks', 'p1')).toBeNull();
    expect(sandboxVerdict('GET', '/api/health', 'p1')).toBeNull();
    expect(sandboxVerdict('GET', '/api/chat/s1/stream', 'p1')).toMatchObject({ status: 403 });
  });
});

// ---- de quem é a conversa do URL (id vem do pedido, não é prova) ----

function deps(over: Partial<SessionScopeDeps> = {}): SessionScopeDeps {
  return { live: () => null, transcriptIn: async () => false, taskProject: async () => null, staffOwns: async () => false, ...over };
}

describe('sessionInProject / sessionAllowed', () => {
  it('conversa aberta: vale o projeto com que abriu; a de outro projeto nunca, nem para a tela', async () => {
    const d = deps({ live: (s) => (s === 's-b' ? 'p2' : null) });
    expect(await sessionInProject(d, 'p1', 's-b')).toBe(false);
    expect(await sessionInProject(d, 'p2', 's-b')).toBe(true);
    expect(await sessionAllowed(d, true, 'p1', 's-b')).toBe(false); // funcionário
    expect(await sessionAllowed(d, false, 'p1', 's-b')).toBe(false); // a tela também
    expect(await sessionAllowed(d, false, 'p2', 's-b')).toBe(true);
  });

  it('conversa ENCERRADA: o transcript na pasta do projeto, a tarefa ou a ficha provam; a de outro projeto não passa (Claude e Codex)', async () => {
    // Claude: o transcript fica na pasta do projeto dono.
    const claude = deps({ transcriptIn: async (p, s) => p === 'p2' && s === 'fechada-claude' });
    expect(await sessionAllowed(claude, true, 'p1', 'fechada-claude')).toBe(false);
    expect(await sessionAllowed(claude, true, 'p2', 'fechada-claude')).toBe(true);
    // Codex: sem transcript do Claude, só a ficha (ou a tarefa) diz de quem é.
    const codex = deps({ staffOwns: async (p, s) => p === 'p2' && s === 'fechada-codex' });
    expect(await sessionAllowed(codex, true, 'p1', 'fechada-codex')).toBe(false);
    expect(await sessionAllowed(codex, true, 'p2', 'fechada-codex')).toBe(true);
    // Conversa de tarefa de outro projeto (trabalho, revisão ou deploy).
    const task = deps({ taskProject: async (s) => (s === 'rev-b' ? 'p2' : null) });
    expect(await sessionAllowed(task, true, 'p1', 'rev-b')).toBe(false);
    expect(await sessionAllowed(task, true, 'p2', 'rev-b')).toBe(true);
  });

  it('worktree do MESMO projeto continua valendo: o transcript fica em outra pasta, mas a ficha do projeto lista a conversa', async () => {
    const d = deps({ staffOwns: async (p, s) => p === 'p1' && s === 'na-worktree' });
    expect(await sessionAllowed(d, true, 'p1', 'na-worktree')).toBe(true);
    expect(await sessionAllowed(d, true, 'p2', 'na-worktree')).toBe(false);
  });

  it('conversa que ninguém reconhece não é do projeto para o funcionário; a tela (sem token) não passa pela prova da fechada', async () => {
    expect(await sessionAllowed(deps(), true, 'p1', 'nao-existe')).toBe(false);
    expect(await sessionAllowed(deps(), false, 'p1', 'qualquer')).toBe(true);
  });
});

describe('ChatManager: a conversa aberta de outro projeto não recebe mensagem, mesmo com o id certo', () => {
  function fakeProc() {
    const stdin = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout: new PassThrough(), stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
    return proc;
  }

  function manager(transcripts: string, written: string[], reg = new SessionTokens(), extra: Partial<ChatManagerOptions> = {}) {
    return new ChatManager({
      ...extra,
      transcriptsDir: transcripts,
      usageFile: path.join(dir, 'usage.json'),
      listLive: async () => [],
      tokens: reg,
      resolve: async (_p, sid) => ({ sessionId: sid ?? `sess-${written.length}`, cwd: dir, args: [] }),
      spawnImpl: () => {
        const proc = fakeProc();
        proc.stdin.on('data', (d) => written.push(String(d)));
        return proc as never;
      },
      log: () => {},
    });
  }

  it('liveProject diz o projeto; ensure recusa o id da conversa de B pelo projeto A, e nada chega a B', async () => {
    const written: string[] = [];
    const m = manager(path.join(dir, 'tr-live'), written);
    const sid = await m.send('p2', null, 'bob', 'mensagem legítima');
    expect(m.liveProject(sid)).toBe('p2');
    expect(m.liveProject('nao-aberta')).toBeNull();
    const before = written.length;
    await expect(m.send('p1', sid, 'bob', 'intruso')).rejects.toThrow('outro projeto');
    expect(written).toHaveLength(before);
    expect(written.join('')).not.toContain('intruso');
    // O mesmo id pelo projeto certo segue entregando.
    await m.send('p2', sid, 'bob', 'de novo');
    expect(written.join('')).toContain('de novo');
    m.stop(sid);
  });

  it('hasOwnTranscript: só o transcript na pasta do próprio projeto conta (o de outra pasta, como a worktree, é a ficha que prova)', async () => {
    const root = path.join(dir, 'tr-own');
    fs.mkdirSync(path.join(root, 'p1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'p1-worktree'), { recursive: true });
    fs.writeFileSync(path.join(root, 'p1', 'abc.jsonl'), '');
    fs.writeFileSync(path.join(root, 'p1-worktree', 'wt.jsonl'), '');
    const m = manager(root, []);
    expect(await m.hasOwnTranscript('p1', 'abc')).toBe(true);
    expect(await m.hasOwnTranscript('p2', 'abc')).toBe(false);
    expect(await m.hasOwnTranscript('p1', 'wt')).toBe(false);
    expect(await m.hasOwnTranscript('p1', '../p1/abc')).toBe(false);
  });

  const userLine = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-19T10:00:00Z', message: { content: text } });

  it('isProjectDir e findTranscript: só a pasta do projeto e as das worktrees dele; o id de uma conversa de outro projeto não acha o transcript', async () => {
    expect(isProjectDir('p1', 'p1')).toBe(true);
    expect(isProjectDir('p1', 'p1--claude-worktrees-myco-ana')).toBe(true);
    for (const outra of ['p2', 'p10', 'p1-irmao', 'p1--claude-worktree', 'x-p1']) expect(isProjectDir('p1', outra), outra).toBe(false);

    const root = path.join(dir, 'tr-scope');
    for (const [pasta, sid] of [['p1', 'a'], ['p2', 'b'], ['p1--claude-worktrees-myco-ana', 'wt'], ['p10', 'c'], ['p1-irmao', 'd']] as const) {
      fs.mkdirSync(path.join(root, pasta), { recursive: true });
      fs.writeFileSync(path.join(root, pasta, `${sid}.jsonl`), '');
    }
    expect(await findTranscript(root, 'p1', 'a')).toBe(path.join(root, 'p1', 'a.jsonl'));
    // A worktree do próprio projeto continua achada.
    expect(await findTranscript(root, 'p1', 'wt')).toBe(path.join(root, 'p1--claude-worktrees-myco-ana', 'wt.jsonl'));
    // De outro projeto (ou de pasta que só começa igual): o caminho direto, que não existe.
    for (const [projeto, sid] of [['p1', 'b'], ['p1', 'c'], ['p1', 'd'], ['p2', 'wt'], ['p2', 'a']] as const) {
      const got = await findTranscript(root, projeto, sid);
      expect(got, `${projeto} ${sid}`).toBe(path.join(root, projeto, `${sid}.jsonl`));
      expect(fs.existsSync(got), `${projeto} ${sid}`).toBe(false);
    }
  });

  it('snapshot: o histórico do Claude de outro projeto não sai pelo id (vem vazio); o do próprio projeto e o da worktree dele saem', async () => {
    const root = path.join(dir, 'tr-snap');
    for (const [pasta, sid] of [['p1', 'meu'], ['p2', 'dele'], ['p1--claude-worktrees-myco-ana', 'wt']] as const) {
      fs.mkdirSync(path.join(root, pasta), { recursive: true });
      fs.writeFileSync(path.join(root, pasta, `${sid}.jsonl`), `${userLine(`texto de ${sid}`)}\n`);
    }
    const m = manager(root, []);
    const texts = async (projeto: string, sid: string) => (await m.snapshot(projeto, sid)).history.map((i) => (i.kind === 'user' ? i.text : i.kind));
    expect(await texts('p1', 'meu')).toEqual(['texto de meu']);
    expect(await texts('p1', 'wt')).toEqual(['texto de wt']);
    expect(await texts('p2', 'dele')).toEqual(['texto de dele']);
    expect(await texts('p1', 'dele')).toEqual([]);
    expect(await texts('p2', 'meu')).toEqual([]);
  });

  it('snapshot: o histórico do Codex (rollout por sessão, sem projeto) só sai da conversa que o servidor prova ser do projeto', async () => {
    const THREAD = '019f0000-0000-7000-8000-0000000000bb';
    const codexHome = path.join(dir, 'codex-home');
    const runDir = path.join(dir, 'codex-run');
    const day = path.join(codexHome, 'sessions', '2026', '11', '19');
    fs.mkdirSync(day, { recursive: true });
    fs.mkdirSync(path.join(runDir, 'cdx-b'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'cdx-b', 'codex-thread.json'), `${JSON.stringify({ threadId: THREAD, savedAt: '2026-11-19T10:00:00.000Z' })}\n`);
    const row = { timestamp: '2026-11-19T10:00:00.000Z', ordinal: 1, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'm1', content: [{ type: 'text', text: 'segredo do projeto B' }] } } };
    fs.writeFileSync(path.join(day, `rollout-2026-11-19T10-00-00-${THREAD}.jsonl`), `${JSON.stringify(row)}\n`);
    const was = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      // O servidor reconhece a conversa como do projeto B (ficha ou tarefa), nunca do A.
      const m = manager(path.join(dir, 'tr-sem'), [], new SessionTokens(), { runDir, sessionInProject: async (p, s) => p === 'B' && s === 'cdx-b' });
      const said = async (projeto: string) => (await m.snapshot(projeto, 'cdx-b')).history.map((i) => (i.kind === 'user' ? i.text : i.kind));
      expect(await said('B')).toEqual(['segredo do projeto B']);
      expect(await said('A')).toEqual([]);
      // Sem a prova na montagem (só os testes), o comportamento antigo: lê pelo id.
      const aberto = manager(path.join(dir, 'tr-sem'), [], new SessionTokens(), { runDir });
      expect((await aberto.snapshot('A', 'cdx-b')).history).toHaveLength(1);
    } finally {
      if (was === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = was;
    }
  });
});

describe('o caso do hold: nada é gravado na tarefa de outro projeto', () => {
  async function board() {
    const pdir = path.join(dir, 'hold-proj');
    fs.mkdirSync(path.join(pdir, '.myco'), { recursive: true });
    const now = new Date().toISOString();
    const base = { description: '', plan: null, branch: null, pr: null, createdAt: now, updatedAt: now, history: [] as unknown[] };
    fs.writeFileSync(
      path.join(pdir, '.myco', 'tasks.json'),
      JSON.stringify([
        { ...base, id: 't-a', title: 'A', status: 'review', staffId: 'ana-1', sessionId: 'ana-work' },
        { ...base, id: 't-b', title: 'B', status: 'doing', staffId: 'ana-1', sessionId: 'ana-b' },
      ]),
    );
    const people: Record<string, StaffProfile> = { 'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile };
    const svc = new TaskService({
      projectPath: async () => pdir,
      projectIds: async () => ['dono'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, staffId) => `${staffId}-novo`,
      branchFor: async () => null,
      isWorking: () => false,
      sendTo: async (_p, sessionId) => sessionId,
      notify: async () => {},
      lastText: () => null,
      apiUrl: 'http://127.0.0.1:4848',
    });
    return { svc, held: async () => ((await svc.list('dono')) ?? []).find((t) => t.id === 't-a')?.held ?? [] };
  }

  it('a conversa de tarefa do projeto dono não é do projeto de quem chama: o servidor a reconhece pela tarefa, antes de qualquer hold', async () => {
    const b = await board();
    expect(await b.svc.projectOfSession('ana-work')).toBe('dono');
    expect(await b.svc.projectOfSession('desconhecida')).toBeNull();
    const d = deps({ taskProject: (s) => b.svc.projectOfSession(s) });
    // O funcionário do projeto A (token de A, URL de A) com o id da conversa da tarefa do projeto dono.
    expect(await sessionAllowed(d, true, 'a', 'ana-work')).toBe(false);
    expect(await sessionAllowed(d, true, 'dono', 'ana-work')).toBe(true);
    // Sem a checagem, o hold acharia a tarefa só pelo sessionId e gravaria no projeto dela (é o que o servidor impede antes de chamá-lo).
    expect(await b.held()).toEqual([]);
    expect(await b.svc.hold('ana-work', { text: 'intruso', auto: true })).toContain('espera Ana terminar');
    expect(await b.held()).toHaveLength(1);
  });

  it('a rota de envio prova a conversa e o funcionário ANTES de contar, guardar ou enviar (ordem no código)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    const start = src.indexOf("new RegExp(`^/api/projects/${ID}/chat/send$`)");
    const route = src.slice(start, src.indexOf('// Aviso de limite de uso na conversa', start));
    const at = (s: string) => {
      const i = route.indexOf(s);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const proof = at('await assertSessionOf(caller, \'POST\', url, pid!, b.sessionId)');
    const staffCheck = at("throw new BadRequest('esse funcionário não é deste projeto')");
    for (const later of ['tasks.mayAskRequester(', 'requesterAskLimiter.check', 'checkReach(caller', 'staffSendRate.count', 'tasks.hold(', 'chats.send(', 'chats.sendFromUser(']) {
      expect(proof, later).toBeLessThan(at(later));
      expect(staffCheck, later).toBeLessThan(at(later));
    }
  });

  it('os GETs de conversa por id (histórico e mensagens guardadas, mudanças, MCP) provam a conversa antes de ler; o SSE fica atrás do gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    for (const [route, read] of [
      ['^/api/projects/${ID}/chat/${ID}$`', 'chats.snapshot('],
      ['^/api/projects/${ID}/chat/${ID}/changes$`', 'chatPlace('],
      ['^/api/projects/${ID}/chat/${ID}/mcp$`', 'chats.mcp('],
    ] as const) {
      const from = src.indexOf(route);
      expect(from, route).toBeGreaterThan(-1);
      const body = src.slice(from, from + 700);
      expect(body.indexOf("assertSessionOf(caller, 'GET', url, pid!, sid!)"), route).toBeGreaterThan(-1);
      expect(body.indexOf('assertSessionOf'), route).toBeLessThan(body.indexOf(read));
    }
    expect(projectScopeVerdict('GET', '/api/chat/s1/stream', 'p1')).toMatchObject({ status: 403, reason: 'rota-fora-do-projeto' });
  });

  it('o index.ts liga a prova da conversa ao snapshot e só serve o stream (SSE) e as rotas depois do gate', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(src).toContain('sessionInProject: (projectId, sessionId) => sessionInProject(sessionScope, projectId, sessionId)');
    const onRequest = src.indexOf('async function onRequest');
    const gateAt = src.indexOf('const admitted = gate(', onRequest);
    expect(gateAt).toBeGreaterThan(onRequest);
    for (const later of ['STREAM_ROUTE.exec(url.pathname)', 'for (const [method, pattern, handler] of routes)', 'serveStatic(url.pathname, res)']) {
      expect(src.indexOf(later, onRequest), later).toBeGreaterThan(gateAt);
    }
  });
});

describe('conversa retomada depois de um reinício recebe token válido (Claude e Codex)', () => {
  function fakeProc() {
    const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 4243, kill: () => proc.emit('exit', 0) });
    return proc;
  }

  it('servidor novo (registro vazio): o token velho deixa de valer, e a conversa retomada abre com um novo que o gate aceita', async () => {
    const before = new SessionTokens();
    const oldClaude = before.issue(who({ sessionId: 'sess-claude' }));
    const oldCodex = before.issue(who({ staffId: 'cris', sessionId: 'sess-codex', engine: 'codex' }));
    const after = new SessionTokens(); // o servidor reiniciou: o mapa token → dono só vive em memória
    expect(after.lookup(oldClaude)).toBeNull();
    // Quem ainda tem o token velho no ambiente (processo órfão) leva a mensagem que manda reabrir a conversa.
    for (const t of [oldClaude, oldCodex]) expect(resolveCaller(false, t, after)).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('Reabra a conversa') });

    const envs: Record<string, NodeJS.ProcessEnv> = {};
    const m = new ChatManager({
      transcriptsDir: path.join(dir, 'tr-resume'),
      usageFile: path.join(dir, 'usage-resume.json'),
      listLive: async () => [],
      tokens: after,
      resolve: async (_p, sid, staffId) =>
        staffId === 'cris'
          ? {
              sessionId: sid!,
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
                agents: [],
                secrets: { projectPath: dir, home: path.join(dir, 'sem-home'), mycoHome: path.join(dir, 'sem-myco') },
                threadId: null,
                threadFile: path.join(dir, 'codex-thread-resume.json'),
                mycoUrl: 'http://127.0.0.2:4848',
              },
            }
          : { sessionId: sid!, cwd: dir, args: ['--resume', sid!] },
      spawnImpl: (cmd, _a, o) => {
        const proc = fakeProc();
        envs[cmd] = o.env;
        proc.stdin.on('finish', () => proc.emit('exit', 0));
        if (cmd === 'codex') setImmediate(() => proc.emit('close', 0));
        return proc as never;
      },
      log: () => {},
    });
    await m.send('p1', 'sess-claude', 'ana', 'retomando');
    await m.send('p1', 'sess-codex', 'cris', 'retomando');
    await new Promise((r) => setTimeout(r, 30));
    const claudeToken = envs.claude!.MYCO_TOKEN!;
    const codexToken = envs.codex!.MYCO_TOKEN!;
    expect(claudeToken).not.toBe(oldClaude);
    expect(codexToken).not.toBe(oldCodex);
    expect(resolveCaller(false, claudeToken, after)).toMatchObject({ ok: true, caller: { staffId: 'ana', projectId: 'p1', sessionId: 'sess-claude', engine: 'claude' } });
    expect(resolveCaller(true, codexToken, after)).toMatchObject({ ok: true, caller: { staffId: 'cris', projectId: 'p1', sessionId: 'sess-codex', engine: 'codex', sandbox: true } });
    m.stop('sess-claude');
    m.stop('sess-codex');
  });
});
