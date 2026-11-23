import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectScopeVerdict, sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { SANDBOX_HOST, SessionTokens, type TokenOwner } from '../server/callers';
import { gate } from '../server/gate';
import { Pairing } from '../server/pairing';
import { removeTempSync } from './support/tmp';

// A porta de entrada da consulta entre projetos (t-ee823d), contra o gate de verdade nos dois endereços: a rota de consulta e o diretório são do projeto de ORIGEM (o do token), só o POST
// de consulta é de funcionário, os vínculos (`/api/consult/links*`) são só da tela, e a conversa de consulta não tem token, então nenhuma rota é dela.

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
  body: { error?: string; fromBrowser?: boolean; caller?: { projectId?: string; staffId?: string } | null };
}
const call = (base: string, method: 'GET' | 'POST', pathname: string, headers: Record<string, string> = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
const listen = (srv: http.Server, host: string) =>
  new Promise<string | null>((resolve) => {
    srv.once('error', () => resolve(null));
    srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`));
  });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-consult-gate-'));
  pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const g = gate(req, res, { pairing, tokens, localHostnames: LOCAL, isLocalOrigin, log: () => {} });
    if (!g) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ fromBrowser: g.fromBrowser, caller: g.caller }));
  };
  const a = http.createServer(handler);
  const b = http.createServer(handler);
  servers.push(a, b);
  local = (await listen(a, '127.0.0.1'))!;
  sandbox = await listen(b, SANDBOX_HOST);
});
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  removeTempSync(dir);
});

const who = (over: Partial<TokenOwner> = {}): TokenOwner => ({ staffId: 'roberto', projectId: 'p1', sessionId: 's-roberto', engine: 'claude', ...over });
const STAFF = { 'x-myco': '1' };
const withToken = (t: string) => ({ ...STAFF, 'x-myco-token': t });
const cookie = () => pairing.setCookieHeader().split(';')[0]!;
const CONSULT = '/api/projects/p1/consult';
const DIRECTORY = '/api/projects/p1/consult/directory';

describe('política das rotas de consulta', () => {
  it('só o POST de consulta é de funcionário; o vínculo e a revogação são só da tela', () => {
    expect(staffMayPost(CONSULT)).toBe(true);
    for (const p of ['/api/consult/links', '/api/consult/links/revoke', '/api/projects/p1/consult/links', '/api/projects/p1/consult/x', `${CONSULT}/`, '/api/consult/records']) expect(staffMayPost(p), p).toBe(false);
  });

  it('a sandbox do Codex alcança a consulta e o diretório só no projeto dela, e nada do vínculo', () => {
    expect(sandboxVerdict('POST', CONSULT, 'p1')).toBeNull();
    expect(sandboxVerdict('GET', DIRECTORY, 'p1')).toBeNull();
    expect(sandboxVerdict('POST', '/api/projects/p2/consult', 'p1')?.status).toBe(403);
    expect(sandboxVerdict('GET', '/api/projects/p2/consult/directory', 'p1')?.status).toBe(403);
    expect(sandboxVerdict('POST', '/api/consult/links', 'p1')?.status).toBe(403);
    expect(sandboxVerdict('POST', '/api/consult/links/revoke', 'p1')?.status).toBe(403);
    expect(sandboxVerdict('GET', '/api/consult/links', 'p1')?.status).toBe(403);
    expect(sandboxVerdict('GET', '/api/consult/records', 'p1')?.status).toBe(403);
  });

  it('o token do projeto só alcança a consulta e o diretório da ORIGEM dele (o que a t-7e85fa fechou segue fechado)', () => {
    expect(projectScopeVerdict('POST', CONSULT, 'p1')).toBeNull();
    expect(projectScopeVerdict('GET', DIRECTORY, 'p1')).toBeNull();
    expect(projectScopeVerdict('POST', '/api/projects/p2/consult', 'p1')?.reason).toBe('outro-projeto');
    expect(projectScopeVerdict('GET', '/api/projects/p2/consult/directory', 'p1')?.reason).toBe('outro-projeto');
    expect(projectScopeVerdict('POST', '/api/consult/links', 'p1')?.reason).toBe('rota-fora-do-projeto');
    expect(projectScopeVerdict('GET', '/api/consult/records', 'p1')?.reason).toBe('rota-fora-do-projeto');
  });
});

describe('o gate de verdade (127.0.0.1)', () => {
  it('a consulta exige o token do projeto de origem: sem token 401, token inválido 401, token de outro projeto 403, o do próprio projeto passa com o dono dele', async () => {
    expect((await call(local, 'POST', CONSULT, STAFF)).status).toBe(401);
    expect((await call(local, 'POST', CONSULT, withToken('f'.repeat(64)))).status).toBe(401);
    expect((await call(local, 'POST', CONSULT, withToken(tokens.issue(who({ projectId: 'p2', staffId: 'bob', sessionId: 's-bob' }))))).status).toBe(403);
    const ok = await call(local, 'POST', CONSULT, withToken(tokens.issue(who())));
    expect(ok.status).toBe(200);
    expect(ok.body.caller).toMatchObject({ projectId: 'p1', staffId: 'roberto' });
  });

  it('o diretório: sem token e sem navegador pareado 401; com o token do projeto passa; token de outro projeto 403; a tela pareada passa (a rota diz que não é funcionário)', async () => {
    expect((await call(local, 'GET', DIRECTORY)).status).toBe(401);
    expect((await call(local, 'GET', DIRECTORY, { 'x-myco-token': 'a'.repeat(64) })).status).toBe(401);
    expect((await call(local, 'GET', DIRECTORY, { 'x-myco-token': tokens.issue(who()) })).status).toBe(200);
    expect((await call(local, 'GET', DIRECTORY, { 'x-myco-token': tokens.issue(who({ projectId: 'p2', staffId: 'bob', sessionId: 's-bob' })) })).status).toBe(403);
    expect((await call(local, 'GET', DIRECTORY, { cookie: cookie() })).status).toBe(200);
  });

  it('o vínculo só se grava pela tela: o funcionário (com token) leva 400 ou 403, e sem token 400 "só pelo Claudio’s Club"', async () => {
    const token = tokens.issue(who());
    for (const p of ['/api/consult/links', '/api/consult/links/revoke']) {
      const withTok = await call(local, 'POST', p, withToken(token));
      expect([400, 403], p).toContain(withTok.status);
      expect((await call(local, 'POST', p, STAFF)).status, p).toBe(400);
    }
    // A tela (Origin local e cookie do pareamento) chega às rotas.
    const screen = await call(local, 'POST', '/api/consult/links', { ...STAFF, origin: 'http://localhost:5173', cookie: cookie() });
    expect(screen).toMatchObject({ status: 200, body: { fromBrowser: true } });
  });

  it('a conversa de consulta não tem token: o token que ela não recebe não existe, e o que alguém inventar é 401', async () => {
    // O ChatManager não emite token para sessão de consulta (ver tests/consultProfile.test.ts); aqui, que nenhum valor inventado vira dono.
    for (const forged of ['0'.repeat(64), 'c-a1b2c3', '']) {
      const r = await call(local, 'POST', CONSULT, forged ? withToken(forged) : STAFF);
      expect(r.status).toBe(401);
    }
  });
});

describe.skipIf(process.platform === 'darwin')('o gate pela sandbox do Codex (127.0.0.2)', () => {
  const codex = (over: Partial<TokenOwner> = {}) => tokens.issue(who({ engine: 'codex', sessionId: 's-cris', staffId: 'cris', ...over }));
  it('consulta e diretório no projeto da própria conversa passam; em outro projeto e as rotas de vínculo, 403', async () => {
    if (!sandbox) return; // sem o alias 127.0.0.2, nada a provar aqui
    expect((await call(sandbox, 'POST', CONSULT, withToken(codex()))).status).toBe(200);
    expect((await call(sandbox, 'GET', DIRECTORY, { 'x-myco-token': codex() })).status).toBe(200);
    expect((await call(sandbox, 'POST', '/api/projects/p2/consult', withToken(codex()))).status).toBe(403);
    expect((await call(sandbox, 'GET', '/api/projects/p2/consult/directory', { 'x-myco-token': codex() })).status).toBe(403);
    expect((await call(sandbox, 'POST', '/api/consult/links', withToken(codex()))).status).toBe(403);
    expect((await call(sandbox, 'POST', CONSULT, STAFF)).status).toBe(401);
  });
});
