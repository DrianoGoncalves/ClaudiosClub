import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionMay, sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { SANDBOX_HOST, SessionTokens, type TokenOwner } from '../server/callers';
import { ConfigPatch, readConfig, updateConfig } from '../server/config';
import { EXTENSION_ORIGIN } from '../server/extension/identity';
import { gate } from '../server/gate';
import { Pairing } from '../server/pairing';
import { PresenceBody, TAB_CHECK_MS, TAB_GRACE_MS, TAB_TTL_MS, TabPresence } from '../server/tabPresence';

// Parar o Club ao fechar a aba (t-cafbf3): a opção no config, a lógica de presença e carência (relógio falso) e a porta de entrada (gate de verdade).

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tabpresence-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('opção stopOnTabClose (config)', () => {
  const fileWith = (name: string, content: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  };

  it('padrão desligada: sem arquivo, com config de antes da opção e com valor estranho', async () => {
    expect((await readConfig(path.join(dir, 'nao-existe.json'))).stopOnTabClose).toBe(false);
    expect((await readConfig(fileWith('antigo.json', { companyName: 'Acme' }))).stopOnTabClose).toBe(false);
    // Editado à mão: o valor estranho volta ao padrão sem derrubar o resto.
    const cfg = await readConfig(fileWith('estranho.json', { stopOnTabClose: 'sim', companyName: 'Acme', maxActiveChats: 3 }));
    expect(cfg).toMatchObject({ stopOnTabClose: false, companyName: 'Acme', maxActiveChats: 3 });
  });

  it('grava e lê pela API de configurações, sem mexer no resto', async () => {
    const file = fileWith('grava.json', { futuro: 1 });
    expect((await updateConfig({ stopOnTabClose: true }, file)).stopOnTabClose).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ futuro: 1, stopOnTabClose: true });
    expect((await readConfig(file)).stopOnTabClose).toBe(true);
    // Outro campo não desliga a opção.
    expect((await updateConfig({ aiTitles: false }, file)).stopOnTabClose).toBe(true);
    expect((await updateConfig({ stopOnTabClose: false }, file)).stopOnTabClose).toBe(false);
  });

  it('o pedido só aceita booleano', () => {
    expect(ConfigPatch.safeParse({ stopOnTabClose: true }).success).toBe(true);
    expect(ConfigPatch.safeParse({ stopOnTabClose: 'sim' }).success).toBe(false);
    expect(ConfigPatch.safeParse({ stopOnTabClose: 1 }).success).toBe(false);
  });
});

describe('sinal de presença (corpo)', () => {
  it('aceita id de aba de 8 a 64 caracteres [A-Za-z0-9_-] e leaving booleano; o resto é recusado', () => {
    expect(PresenceBody.safeParse({ tab: 'abc12345' }).success).toBe(true);
    expect(PresenceBody.safeParse({ tab: 'a'.repeat(64), leaving: true }).success).toBe(true);
    for (const bad of [{}, { tab: 'curto' }, { tab: 'a'.repeat(65) }, { tab: 'abc 12345' }, { tab: 'abc/12345' }, { tab: 12345678 }, { tab: 'abc12345', leaving: 'sim' }, { tab: 'abc12345', extra: 1 }]) {
      expect(PresenceBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('presença e carência (relógio falso)', () => {
  let clock = 0;
  let on = true;
  let stops = 0;
  let reads = 0;
  const make = (over: Partial<ConstructorParameters<typeof TabPresence>[0]> = {}) =>
    new TabPresence({
      enabled: async () => {
        reads += 1;
        return on;
      },
      stop: () => void (stops += 1),
      now: () => clock,
      ...over,
    });
  /** Passa o tempo de conferência em conferência, como o intervalo do servidor; devolve quantas vezes pediu para parar. */
  const advance = async (p: TabPresence, ms: number, beat?: (p: TabPresence) => void) => {
    for (let left = ms; left > 0; left -= TAB_CHECK_MS) {
      clock += Math.min(TAB_CHECK_MS, left);
      beat?.(p);
      await p.tick();
    }
  };

  beforeEach(() => {
    clock = 1_000_000;
    on = true;
    stops = 0;
    reads = 0;
  });

  it('nenhuma aba desde o boot (daemon sem navegador): nunca para, nem lê a configuração', async () => {
    const p = make();
    await advance(p, 6 * 3600_000);
    expect(stops).toBe(0);
    expect(reads).toBe(0);
    expect(p.open()).toBe(0);
  });

  it('desligada (padrão): fechar a aba não para nada, mesmo muito depois; a configuração é lida de tempos em tempos, não a cada conferência', async () => {
    on = false;
    const p = make();
    p.signal('aba-aaaa-1');
    p.signal('aba-aaaa-1', true);
    await advance(p, 3600_000);
    expect(stops).toBe(0);
    // 1 h de conferências de 5 s = 720; lê no máximo a cada 30 s.
    expect(reads).toBeLessThanOrEqual(3600 / 30 + 1);
  });

  it('ligada: sem nenhum sinal, para só depois da validade do último sinal MAIS a carência (uma vez só)', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    await advance(p, TAB_TTL_MS + TAB_GRACE_MS - TAB_CHECK_MS);
    expect(stops).toBe(0);
    await advance(p, TAB_CHECK_MS);
    expect(stops).toBe(1);
    await advance(p, 600_000);
    expect(stops).toBe(1);
  });

  it('com a aba dando sinal a cada 15 s, não para nunca', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    await advance(p, 3600_000, (x) => clock % 15_000 === 0 && x.signal('aba-aaaa-1'));
    expect(stops).toBe(0);
    expect(p.open()).toBe(1);
  });

  it('a aba que avisa que está saindo encurta a espera: para só depois da carência inteira', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    await advance(p, 20_000);
    p.signal('aba-aaaa-1', true);
    expect(p.open()).toBe(0);
    await advance(p, TAB_GRACE_MS - TAB_CHECK_MS);
    expect(stops).toBe(0);
    await advance(p, TAB_CHECK_MS);
    expect(stops).toBe(1);
  });

  it('F5: a aba sai (leaving) e a nova dá sinal dentro da carência: não para, nem depois', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    p.signal('aba-aaaa-1', true);
    // A página recarrega (a mesma aba, ou outra id) em alguns segundos.
    await advance(p, 5_000);
    p.signal('aba-bbbb-2');
    await advance(p, 10 * 60_000, (x) => clock % 15_000 === 0 && x.signal('aba-bbbb-2'));
    expect(stops).toBe(0);
  });

  it('navegação lenta: a aba nova demora quase a carência toda e ainda assim não para', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    p.signal('aba-aaaa-1', true);
    await advance(p, TAB_GRACE_MS - TAB_CHECK_MS);
    p.signal('aba-aaaa-1');
    await advance(p, 5 * 60_000, (x) => clock % 15_000 === 0 && x.signal('aba-aaaa-1'));
    expect(stops).toBe(0);
  });

  it('duas abas: fechar uma não para (nem com a outra escondida, dando sinal só 1×/min); fechar as duas para depois da carência', async () => {
    const p = make();
    let lastB = clock;
    // A aba B está em segundo plano: o navegador só deixa o timer dela rodar de minuto em minuto.
    const beat = (x: TabPresence) => {
      if (clock - lastB >= 60_000) {
        lastB = clock;
        x.signal('aba-bbbb-2');
      }
    };
    p.signal('aba-aaaa-1');
    p.signal('aba-bbbb-2');
    await advance(p, 60_000, (x) => clock % 15_000 === 0 && x.signal('aba-aaaa-1'));
    p.signal('aba-bbbb-2');
    lastB = clock;
    p.signal('aba-aaaa-1', true);
    await advance(p, 10 * 60_000, beat);
    expect(stops).toBe(0);
    expect(p.open()).toBe(1);
    p.signal('aba-bbbb-2', true);
    await advance(p, TAB_GRACE_MS);
    expect(stops).toBe(1);
  });

  it('aviso de saída de uma aba que o servidor nunca viu não conta como aba nem como fechamento', async () => {
    const p = make();
    p.signal('aba-zzzz-9', true);
    await advance(p, 600_000);
    expect(stops).toBe(0);
    expect(p.open()).toBe(0);
  });

  it('sinal que chega enquanto a configuração é lida cancela a parada (o F5 voltou nesse meio-tempo)', async () => {
    let release!: () => void;
    const p = make({ enabled: () => new Promise<boolean>((r) => (release = () => r(true))) });
    p.signal('aba-aaaa-1');
    clock += TAB_TTL_MS + TAB_GRACE_MS;
    const tick = p.tick();
    p.signal('aba-bbbb-2');
    release();
    expect(await tick).toBe(false);
    expect(stops).toBe(0);
  });

  it('máquina que dormiu: o salto do relógio não derruba o servidor, as abas valem de novo por um prazo inteiro', async () => {
    const p = make();
    p.signal('aba-aaaa-1');
    await advance(p, TAB_CHECK_MS);
    // Dormiu por 1 h: a aba (que dormiu junto) não pôde dar sinal, e a primeira conferência ao acordar vem antes dela.
    clock += 3600_000;
    expect(await p.tick()).toBe(false);
    expect(stops).toBe(0);
    // Se a aba voltou, segue; se foi fechada durante o sono, para depois de um prazo e da carência (e não antes).
    await advance(p, TAB_TTL_MS + TAB_GRACE_MS - TAB_CHECK_MS);
    expect(stops).toBe(0);
    await advance(p, TAB_CHECK_MS);
    expect(stops).toBe(1);
  });

  it('erro ao ler a configuração: não para', async () => {
    const p = make({ enabled: async () => Promise.reject(new Error('disco')) });
    p.signal('aba-aaaa-1');
    await advance(p, TAB_TTL_MS + 10 * TAB_GRACE_MS);
    expect(stops).toBe(0);
  });

  it('a lista de abas tem teto (um navegador pareado não a faz crescer sem fim) e o vencido sai', () => {
    const p = make();
    for (let i = 0; i < 500; i++) p.signal(`aba-${String(i).padStart(6, '0')}`);
    expect(p.open()).toBe(64);
    clock += TAB_TTL_MS + 1;
    expect(p.open()).toBe(0);
    p.signal('aba-nova-001');
    expect(p.open()).toBe(1);
  });

  describe('com o intervalo do servidor (timers falsos)', () => {
    beforeEach(() => vi.useFakeTimers({ now: 5_000_000 }));
    afterEach(() => vi.useRealTimers());

    it('start() confere a cada 5 s e pára o servidor uma vez; sem aba nenhuma, nunca', async () => {
      let stopped = 0;
      const p = new TabPresence({ enabled: async () => true, stop: () => void (stopped += 1) });
      p.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(stopped).toBe(0);
      p.signal('aba-aaaa-1');
      await vi.advanceTimersByTimeAsync(TAB_TTL_MS + TAB_GRACE_MS - 1);
      expect(stopped).toBe(0);
      await vi.advanceTimersByTimeAsync(TAB_CHECK_MS);
      expect(stopped).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(stopped).toBe(1);
      p.halt();
    });
  });
});

describe('quem é aba: a porta de entrada de verdade', () => {
  const PATH = '/api/presence';
  const tokens = new SessionTokens();
  const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', 'claudio.localhost']);
  const isLocalOrigin = (o: string | undefined) => !o || LOCAL.has(new URL(o).hostname);
  const servers: http.Server[] = [];
  let pairing: Pairing;
  let presence: TabPresence;
  let local: string;
  let sandbox: string | null = null;

  const listen = (srv: http.Server, host: string) =>
    new Promise<string | null>((resolve) => {
      srv.once('error', () => resolve(null));
      srv.listen(0, host, () => resolve(`http://${host}:${(srv.address() as AddressInfo).port}`));
    });
  const post = (base: string, headers: Record<string, string>, body: unknown = { tab: 'aba-aaaa-1' }) =>
    new Promise<{ status: number; body: { error?: string; ok?: boolean } }>((resolve, reject) => {
      const req = http.request(`${base}${PATH}`, { method: 'POST', headers }, (res) => {
        let text = '';
        res.setEncoding('utf8').on('data', (d: string) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  const who = (over: Partial<TokenOwner> = {}): TokenOwner => ({ staffId: 'roberto', projectId: 'p1', sessionId: 's-roberto', engine: 'claude', ...over });
  const cookie = () => pairing.setCookieHeader().split(';')[0]!;
  const screen = () => ({ 'x-myco': '1', origin: 'http://claudio.localhost:4848', cookie: cookie() });

  beforeAll(async () => {
    pairing = new Pairing(path.join(dir, 'secrets', 'pairing.key'));
    presence = new TabPresence({ enabled: async () => true, stop: () => {} });
    // O mesmo desenho da rota em server/index.ts: só `fromBrowser` (a tela) chega ao sinal.
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const g = gate(req, res, { pairing, tokens, localHostnames: LOCAL, isLocalOrigin, log: () => {} });
      if (!g) return;
      let text = '';
      req.setEncoding('utf8').on('data', (d: string) => (text += d));
      req.on('end', () => {
        const b = PresenceBody.safeParse(JSON.parse(text || '{}'));
        const ok = g.fromBrowser && b.success;
        if (ok) presence.signal(b.data.tab, b.data.leaving);
        res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true } : { error: 'só pelo Claudio’s Club' }));
      });
    };
    const a = http.createServer(handler);
    const b = http.createServer(handler);
    servers.push(a, b);
    local = (await listen(a, '127.0.0.1'))!;
    sandbox = await listen(b, SANDBOX_HOST);
  });
  afterAll(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
  });

  it('a rota não está em nenhuma lista de funcionário, sandbox ou extensão', () => {
    expect(staffMayPost(PATH)).toBe(false);
    expect(sandboxVerdict('POST', PATH, 'p1')?.status).toBe(403);
    expect(extensionMay('POST', PATH)).toBe(false);
    expect(extensionMay('GET', PATH)).toBe(false);
  });

  it('o navegador pareado (Origin local, cookie e x-myco) é aba e entra na lista', async () => {
    const r = await post(local, screen());
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(presence.open()).toBe(1);
  });

  it('sem x-myco, com Origin de fora ou sem o cookie do pareamento: 403, e nada entra na lista', async () => {
    const before = presence.open();
    expect((await post(local, { origin: 'http://claudio.localhost:4848', cookie: cookie() })).status).toBe(403);
    expect((await post(local, { ...screen(), origin: 'https://evil.example' })).status).toBe(403);
    const unpaired = await post(local, { 'x-myco': '1', origin: 'http://claudio.localhost:4848' });
    expect(unpaired.status).toBe(403);
    expect(presence.open()).toBe(before);
  });

  it('funcionário (token) e ferramenta sem token: 400 "só pelo Claudio’s Club", mesmo com o token válido', async () => {
    presence = new TabPresence({ enabled: async () => true, stop: () => {} });
    expect((await post(local, { 'x-myco': '1', 'x-myco-token': tokens.issue(who()) })).status).toBe(400);
    expect((await post(local, { 'x-myco': '1' })).status).toBe(400);
    expect(presence.open()).toBe(0);
  });

  it('a extensão do Chrome (Origin dela, com ou sem token) não alcança a rota: 403', async () => {
    presence = new TabPresence({ enabled: async () => true, stop: () => {} });
    expect((await post(local, { 'x-myco': '1', origin: EXTENSION_ORIGIN, authorization: 'Bearer ' + 'a'.repeat(40) })).status).toBe(403);
    expect((await post(local, { 'x-myco': '1', origin: EXTENSION_ORIGIN })).status).toBe(403);
    expect(presence.open()).toBe(0);
  });

  it.skipIf(process.platform === 'darwin')('a sandbox do Codex (127.0.0.2) não é aba, nem forjando Origin e cookie: 403', async () => {
    if (!sandbox) return; // sem o alias 127.0.0.2, nada a provar aqui
    presence = new TabPresence({ enabled: async () => true, stop: () => {} });
    const codex = tokens.issue(who({ engine: 'codex', sessionId: 's-cris', staffId: 'cris' }));
    expect((await post(sandbox, { 'x-myco': '1', 'x-myco-token': codex })).status).toBe(403);
    expect((await post(sandbox, { ...screen(), 'x-myco-token': codex })).status).toBe(403);
    expect((await post(sandbox, screen())).status).toBe(401);
    expect(presence.open()).toBe(0);
  });
});
