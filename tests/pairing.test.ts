import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  admit,
  cookieValues,
  NEEDS_PAIRING,
  PAIR_CODE_TTL_MS,
  PAIR_COOKIE,
  PAIR_KEY_FILE,
  PAIR_REQUEST_TTL_MS,
  pairCode,
  pairUrl,
  Pairing,
  readOrCreatePairKey,
} from '../server/pairing';
import { DEFAULT_SECRETS_DIR } from '../server/secretVault';
import { secretDenyRules } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';

let dir: string;
let keyFile: string;
let clock = Date.now();
let pairing: Pairing;
let server: http.Server;
let base: string;
const logs: string[] = [];
/** Códigos que o servidor mandou o terminal de aprovação mostrar. */
const terminals: string[] = [];

/** Origin local, como o servidor de verdade (index.ts). */
const isLocalOrigin = (o: string | undefined) => !o || ['localhost', '127.0.0.1', 'claudio.localhost'].includes(new URL(o).hostname);

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const replies: Reply[] = [];

function call(method: 'GET' | 'POST', pathname: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (d: string) => (body += d));
      res.on('end', () => {
        const r = { status: res.statusCode ?? 0, headers: res.headers, body };
        replies.push(r);
        resolve(r);
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

/** O par de cabeçalhos de um curl "de navegador" forjado, e o de um funcionário de verdade (sem Origin). */
const FORGED = { 'x-myco': '1', origin: 'http://claudio.localhost:4848' };
const STAFF = { 'x-myco': '1' };

/** O cookie que o servidor gravou (só nome=valor). */
const cookieFrom = (r: Reply) => (r.headers['set-cookie']?.[0] ?? '').split(';')[0]!;

async function pairedCookie(): Promise<string> {
  const link = new URL(pairUrl(base, pairCode(readOrCreatePairKey(keyFile), clock)));
  const r = await call('GET', link.pathname + link.search);
  expect(r.status).toBe(303);
  return cookieFrom(r);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pair-'));
  keyFile = path.join(dir, 'secrets', 'pairing.key');
  pairing = new Pairing(keyFile, () => clock);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const openApproval = (code: string) => (terminals.push(code), true);
    const a = admit(req, res, url, pairing, { isLocalOrigin, openApproval, log: (l) => logs.push(l) });
    if (a.done) return;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Rota "só pelo Claudio’s Club" (ex.: /api/server/restart) e rota de funcionário (ex.: criar tarefa pela API).
    if (url.pathname === '/api/browser-only') return a.fromBrowser ? json(200, { ok: true }) : json(400, { error: 'só pelo Claudio’s Club' });
    if (url.pathname === '/api/staff-route') return json(200, { ok: true, fromBrowser: a.fromBrowser });
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(200, []);
    // Como GET /api/server (index.ts): `paired` vem só do cookie, só informa a tela.
    if (url.pathname === '/api/server' && req.method === 'GET') return json(200, { paired: pairing.isPaired(req.headers.cookie) });
    json(404, { error: 'rota desconhecida' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('chave do pareamento', () => {
  it('fica no cofre (~/.myco/secrets), que as regras das sessões bloqueiam', () => {
    expect(path.dirname(PAIR_KEY_FILE)).toBe(DEFAULT_SECRETS_DIR);
    const deny = secretDenyRules({ servers: [] } as unknown as StaffProfile);
    for (const tool of ['Read', 'Edit', 'Write']) expect(deny).toContain(`${tool}(~/.myco/secrets/**)`);
  });

  it('é criada uma vez (32 bytes, 0600 fora do Windows) e relida igual', () => {
    const k = readOrCreatePairKey(keyFile);
    expect(k).toHaveLength(32);
    expect(readOrCreatePairKey(keyFile).equals(k)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('arquivo corrompido: troca por uma chave nova', () => {
    const f = path.join(dir, 'outra', 'pairing.key');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'lixo');
    expect(readOrCreatePairKey(f)).toHaveLength(32);
    expect(fs.readFileSync(f, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('código de pareamento', () => {
  it('vale uma vez só, dentro de 2 min; adulterado ou de outra chave não vale', () => {
    const p = new Pairing(path.join(dir, 'c1.key'), () => clock);
    const key = readOrCreatePairKey(path.join(dir, 'c1.key'));
    const code = pairCode(key, clock);
    expect(p.checkCode(code)).toBe('ok');
    expect(p.checkCode(code)).toBe('used');
    expect(p.checkCode(pairCode(key, clock - PAIR_CODE_TTL_MS - 1))).toBe('expired');
    expect(p.checkCode(pairCode(key, clock + 60_000))).toBe('expired');
    const other = pairCode(readOrCreatePairKey(path.join(dir, 'c2.key')), clock);
    expect(p.checkCode(other)).toBe('invalid');
    const fresh = pairCode(key, clock);
    expect(p.checkCode(`${fresh.slice(0, -1)}${fresh.endsWith('A') ? 'B' : 'A'}`)).toBe('invalid');
    // Prazo mudado à mão: o HMAC cobre o carimbo.
    const [, nonce, sig] = fresh.split('.');
    expect(p.checkCode(`${(clock + 1).toString(36)}.${nonce}.${sig}`)).toBe('invalid');
    for (const bad of [undefined, null, '', 'x'.repeat(5000), 42]) expect(p.checkCode(bad)).toBe('invalid');
  });

  it('o cookie é derivado da chave, nunca ela; lê o cabeçalho Cookie com outros cookies', () => {
    const p = new Pairing(path.join(dir, 'c3.key'), () => clock);
    const key = readOrCreatePairKey(path.join(dir, 'c3.key'));
    expect(p.cookieValue()).not.toContain(key.toString('hex'));
    expect(p.cookieValue()).not.toContain(key.toString('base64url'));
    expect(p.isPaired(`a=1; ${PAIR_COOKIE}=${p.cookieValue()}; b=2`)).toBe(true);
    expect(p.isPaired(`${PAIR_COOKIE}=v1.falso`)).toBe(false);
    expect(p.isPaired(undefined)).toBe(false);
    expect(cookieValues(`x=1; ${PAIR_COOKIE}=a; ${PAIR_COOKIE}=b`, PAIR_COOKIE)).toEqual(['a', 'b']);
    expect(p.setCookieHeader()).toMatch(/; Max-Age=31536000; Path=\/; HttpOnly; SameSite=Strict$/);
  });
});

describe('pedidos (curl e navegador)', () => {
  it('curl com Origin forjado e sem cookie: 403 needs-pairing, em rota de navegador ou não', async () => {
    for (const route of ['/api/browser-only', '/api/staff-route']) {
      const r = await call('POST', route, FORGED);
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body)).toMatchObject({ code: NEEDS_PAIRING, error: expect.stringContaining('Parear este navegador') });
    }
    // Sem x-myco ou com Origin de fora: como antes.
    expect((await call('POST', '/api/browser-only', { origin: 'http://claudio.localhost:4848' })).status).toBe(403);
    expect(JSON.parse((await call('POST', '/api/browser-only', { 'x-myco': '1', origin: 'https://evil.example' })).body)).toEqual({ error: 'origem não permitida' });
  });

  it('GET sem Origin: paired segue só o cookie válido (informação da tela, não autoriza)', async () => {
    const cookie = await pairedCookie();
    expect(JSON.parse((await call('GET', '/api/server', { cookie })).body)).toEqual({ paired: true });
    expect(JSON.parse((await call('GET', '/api/server')).body)).toEqual({ paired: false });
    expect(JSON.parse((await call('GET', '/api/server', { cookie: `${PAIR_COOKIE}=v1.falso` })).body)).toEqual({ paired: false });
  });

  it('funcionário pela API (x-myco, sem Origin): as rotas dele seguem; as de navegador recusam como antes', async () => {
    expect(JSON.parse((await call('POST', '/api/staff-route', STAFF)).body)).toEqual({ ok: true, fromBrowser: false });
    expect((await call('GET', '/api/tasks')).status).toBe(200);
    const r = await call('POST', '/api/browser-only', STAFF);
    expect(r.status).toBe(400);
    // Até com o cookie roubado, sem Origin não vira navegador.
    const cookie = await pairedCookie();
    expect(JSON.parse((await call('POST', '/api/staff-route', { ...STAFF, cookie })).body)).toEqual({ ok: true, fromBrowser: false });
  });

  it('pareia pelo link: cookie HttpOnly/Strict, volta para / sem o código, e as ações de navegador passam', async () => {
    const code = pairCode(readOrCreatePairKey(keyFile), clock);
    const r = await call('GET', `/api/pair?code=${encodeURIComponent(code)}`);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe('/');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['set-cookie']?.[0]).toMatch(new RegExp(`^${PAIR_COOKIE}=v1\\.[A-Za-z0-9_-]{43}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict$`));
    const cookie = cookieFrom(r);
    expect(JSON.parse((await call('POST', '/api/browser-only', { ...FORGED, cookie })).body)).toEqual({ ok: true });

    // Reuso: página simples, sem cookie novo. Já pareado, só entra.
    const again = await call('GET', `/api/pair?code=${encodeURIComponent(code)}`);
    expect(again.status).toBe(403);
    expect(again.headers['set-cookie']).toBeUndefined();
    expect(again.headers['content-type']).toContain('text/html');
    expect(again.body).toContain('Parear este navegador');
    expect((await call('GET', `/api/pair?code=${encodeURIComponent(code)}`, { cookie })).status).toBe(303);
  });

  it('"Parear este navegador": pedido com código; só a prova da chave aprova; a aba que pediu recebe o cookie uma vez', async () => {
    // Funcionário sem Origin, página de fora e POST sem x-myco: não criam pedido.
    expect((await call('POST', '/api/pair/request', STAFF)).status).toBe(400);
    expect((await call('POST', '/api/pair/request', { 'x-myco': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', '/api/pair/request', { origin: 'http://claudio.localhost:4848' })).status).toBe(403);

    // Navegador sem cookie: passa da checagem do cookie e recebe id + código, sem cookie ainda.
    const r = await call('POST', '/api/pair/request', FORGED);
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    const { id, code, terminal } = JSON.parse(r.body) as { id: string; code: string; terminal: boolean };
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // O terminal de aprovação abre com o código da tela (nunca com o id); outro pedido logo depois não abre outro.
    expect(terminal).toBe(true);
    expect(terminals).toEqual([code]);
    expect(JSON.parse((await call('POST', '/api/pair/request', FORGED)).body).terminal).toBe(false);
    expect(terminals).toHaveLength(1);
    const claim = (reqId: string) => call('POST', '/api/pair/claim', { ...FORGED, 'x-pair-request': reqId });
    expect(JSON.parse((await claim(id)).body)).toEqual({ paired: false });

    // Aprovar sem a prova da chave (um curl qualquer, com ou sem Origin): recusado, e o pedido segue esperando.
    const approve = (c: string, proof: string, h: Record<string, string> = STAFF) => call('POST', '/api/pair/approve', { ...h, 'x-pair-code': c, 'x-pair-proof': proof });
    expect((await approve(code, 'falso')).status).toBe(403);
    expect((await approve(code, 'falso', FORGED)).status).toBe(403);
    expect(JSON.parse((await claim(id)).body)).toEqual({ paired: false });

    // Com a prova (o que o npm run pair faz): código errado não acha pedido; o certo aprova, em minúsculas e sem hífen.
    const key = readOrCreatePairKey(keyFile);
    expect((await approve('ZZZZ-ZZZZ', pairCode(key, clock))).status).toBe(404);
    expect((await approve(code.replace('-', '').toLowerCase(), pairCode(key, clock))).status).toBe(200);
    // A prova é de uso único.
    const proof = pairCode(key, clock);
    await approve(code, proof);
    expect((await approve(code, proof)).status).toBe(403);

    // Id de outro não serve; o certo recebe o cookie, que vale nas ações, e o pedido acaba.
    expect((await claim('outro-id')).status).toBe(410);
    const ok = await claim(id);
    expect(JSON.parse(ok.body)).toEqual({ paired: true });
    const cookie = cookieFrom(ok);
    expect(JSON.parse((await call('POST', '/api/browser-only', { ...FORGED, cookie })).body)).toEqual({ ok: true });
    expect((await claim(id)).status).toBe(410);
    // Nem o id nem o código vão para o log.
    expect(logs.join('\n')).not.toContain(id);
    expect(logs.join('\n')).not.toContain(code);

    // Já pareado: não cria pedido. Pedido não aprovado expira em 10 min.
    expect(JSON.parse((await call('POST', '/api/pair/request', { ...FORGED, cookie })).body)).toEqual({ paired: true });
    const late = JSON.parse((await call('POST', '/api/pair/request', FORGED)).body) as { id: string };
    clock += PAIR_REQUEST_TTL_MS + 1;
    expect((await claim(late.id)).status).toBe(410);
  });

  it('código expirado não pareia', async () => {
    const old = pairCode(readOrCreatePairKey(keyFile), clock - PAIR_CODE_TTL_MS - 1000);
    const r = await call('GET', `/api/pair?code=${encodeURIComponent(old)}`);
    expect(r.status).toBe(403);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('cookie adulterado falha; trocar a chave desfaz os pareamentos (quem trocou recebe o cookie novo)', async () => {
    const cookie = await pairedCookie();
    const tampered = `${cookie.slice(0, -2)}${cookie.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await call('POST', '/api/browser-only', { ...FORGED, cookie: tampered })).status).toBe(403);
    const other = await pairedCookie();

    // Só o navegador pareado troca: funcionário (sem Origin) recebe 400; Origin forjado sem cookie, 403.
    expect((await call('POST', '/api/pair/rotate', STAFF)).status).toBe(400);
    expect((await call('POST', '/api/pair/rotate', FORGED)).status).toBe(403);
    const before = fs.readFileSync(keyFile, 'utf8');
    const rotated = await call('POST', '/api/pair/rotate', { ...FORGED, cookie });
    expect(rotated.status).toBe(200);
    expect(fs.readFileSync(keyFile, 'utf8')).not.toBe(before);
    const fresh = cookieFrom(rotated);
    expect(fresh).not.toBe(cookie);

    const r = await call('POST', '/api/browser-only', { ...FORGED, cookie: other });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).code).toBe(NEEDS_PAIRING);
    expect((await call('POST', '/api/browser-only', { ...FORGED, cookie: fresh })).status).toBe(200);
    // Código feito com a chave antiga também não vale mais.
    const stale = pairCode(Buffer.from(before.trim(), 'hex'), clock);
    expect((await call('GET', `/api/pair?code=${encodeURIComponent(stale)}`)).status).toBe(403);
  });

  it('a chave não aparece em resposta nem no log (nem o código ou o cookie no log)', async () => {
    const spy = vi.spyOn(console, 'log');
    const code = pairCode(readOrCreatePairKey(keyFile), clock);
    await call('GET', `/api/pair?code=${encodeURIComponent(code)}`);
    const key = readOrCreatePairKey(keyFile);
    const forms = [key.toString('hex'), key.toString('base64'), key.toString('base64url')];
    for (const r of replies) {
      const all = `${r.body}\n${JSON.stringify(r.headers)}`;
      for (const f of forms) expect(all).not.toContain(f);
    }
    const everything = [...logs, ...spy.mock.calls.flat().map(String)].join('\n');
    for (const f of forms) expect(everything).not.toContain(f);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain(pairing.cookieValue());
    expect(logs.some((l) => l.includes('navegador pareado'))).toBe(true);
    spy.mockRestore();
  });
});
