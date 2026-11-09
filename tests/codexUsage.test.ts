import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexUsageReader,
  isOutdated,
  limitsFromRateLimits,
  parseInstalledVersion,
  readRateLimits,
  readRateLimitsOnce,
  upgradeCommandFor,
  type CodexUsageDeps,
  type InstalledCodex,
  type RateLimitsRead,
} from '../server/codexUsage';

// Limites do Codex no formato dos do Claude: conversão da resposta, flag, falhas, versão e o app-server.

/** Resposta real de `account/rateLimits/read` (resumida). */
const REAL = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1794152240 },
    secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1794515920 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitResetCredits: { availableCount: 2 },
};

describe('limitsFromRateLimits', () => {
  it('a resposta real vira five_hour e seven_day, com o reset em ISO', () => {
    expect(limitsFromRateLimits(REAL)).toEqual([
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-11-08T15:37:20.000Z' },
      { kind: 'seven_day', percentUsed: 5, resetsAt: '2026-11-12T20:38:40.000Z' },
    ]);
  });

  it('a janela vem pela duração, não pela posição (plano só com a semanal)', () => {
    const only = { rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1794515920 }, secondary: null } };
    expect(limitsFromRateLimits(only)).toEqual([{ kind: 'seven_day', percentUsed: 40, resetsAt: '2026-11-12T20:38:40.000Z' }]);
  });

  it('sem duração: primária é 5h e secundária é semanal; duração estranha mantém o nome da janela; sem reset vira null', () => {
    const r = { rateLimits: { primary: { usedPercent: 1 }, secondary: { usedPercent: 2, windowDurationMins: 60 } } };
    expect(limitsFromRateLimits(r)).toEqual([
      { kind: 'five_hour', percentUsed: 1, resetsAt: null },
      { kind: 'window_60m', percentUsed: 2, resetsAt: null },
    ]);
  });

  it('percentual fora de 0-100 é cortado; resposta sem rateLimits é inválida', () => {
    const r = { rateLimits: { primary: { usedPercent: 130, windowDurationMins: 300 } } };
    expect(limitsFromRateLimits(r)?.[0]?.percentUsed).toBe(100);
    expect(limitsFromRateLimits({})).toBeNull();
    expect(limitsFromRateLimits(null)).toBeNull();
  });
});

describe('versão e comando de atualização', () => {
  it('upgradeCommand: mise quando o binário está num caminho do mise, senão codex update', () => {
    expect(upgradeCommandFor(['/home/u/.local/share/mise/installs/codex/latest/bin/codex'])).toBe('mise upgrade codex');
    expect(upgradeCommandFor(['/home/u/.local/share/mise/shims/codex'])).toBe('mise upgrade codex');
    // O caminho do PATH é um link comum; o real (depois do link) está no mise.
    expect(upgradeCommandFor(['/usr/local/bin/codex', '/home/u/.local/share/mise/installs/codex/0.167.0/bin/codex'])).toBe('mise upgrade codex');
    expect(upgradeCommandFor(['C:\\Users\\u\\AppData\\Local\\mise\\installs\\codex\\0.167.0\\codex.cmd'])).toBe('mise upgrade codex');
    expect(upgradeCommandFor(['/usr/local/bin/codex'])).toBe('codex update');
    expect(upgradeCommandFor(['/home/u/.npm-global/bin/codex'])).toBe('codex update');
    expect(upgradeCommandFor([])).toBe('codex update');
  });

  it('outdated: só quando a instalada é menor que a última conhecida', () => {
    expect(isOutdated('0.166.9', '0.167.0')).toBe(true);
    expect(isOutdated('0.9.0', '0.10.0')).toBe(true);
    expect(isOutdated('0.167.0', '0.167.0')).toBe(false);
    expect(isOutdated('0.168.0', '0.167.0')).toBe(false);
    expect(isOutdated(null, '0.167.0')).toBe(false);
    expect(isOutdated('0.167.0', null)).toBe(false);
  });

  it('lê a versão da saída de codex --version', () => {
    expect(parseInstalledVersion('codex-cli 0.167.0\n')).toBe('0.167.0');
    expect(parseInstalledVersion('')).toBeNull();
  });
});

const MISE_INSTALL: InstalledCodex = {
  missing: false,
  version: '0.166.0',
  binPaths: ['/home/u/.local/share/mise/installs/codex/latest/bin/codex'],
};

function deps(over: Partial<CodexUsageDeps> = {}) {
  const calls = { check: 0, installed: 0, latest: 0, readLimits: 0 };
  const d: CodexUsageDeps = {
    check: async () => (calls.check++, { available: true, reason: null }),
    installed: async () => (calls.installed++, MISE_INSTALL),
    latest: async () => (calls.latest++, '0.167.0'),
    readLimits: async (): Promise<RateLimitsRead> => (calls.readLimits++, { ok: true, result: REAL }),
    now: () => 1_000_000,
    ...over,
  };
  return { d, calls };
}

describe('CodexUsageReader', () => {
  it('flag desligada: devolve null e não chama nada do Codex', async () => {
    const { d, calls } = deps();
    expect(await new CodexUsageReader(d).read(false)).toBeNull();
    expect(calls).toEqual({ check: 0, installed: 0, latest: 0, readLimits: 0 });
  });

  it('fresh relê o login mesmo com a leitura guardada; forget esquece a leitura', async () => {
    const seen: boolean[] = [];
    const { d } = deps({
      check: async (fresh) => {
        seen.push(!!fresh);
        return fresh ? { available: true, reason: null } : { available: false, reason: 'o Codex CLI está sem login' };
      },
    });
    const reader = new CodexUsageReader(d);
    expect(await reader.read(true)).toMatchObject({ connected: false, reason: 'not_logged_in' });
    expect(await reader.read(true)).toMatchObject({ connected: false, reason: 'not_logged_in' });
    expect(seen).toEqual([false]);
    expect(await reader.read(true, { fresh: true })).toMatchObject({ connected: true });
    expect(seen).toEqual([false, true]);
    reader.forget();
    await reader.read(true);
    expect(seen).toEqual([false, true, false]);
  });

  it('ligada e com tudo certo: connected, limites, versão e comando', async () => {
    const { d } = deps();
    const r = await new CodexUsageReader(d).read(true);
    expect(r).toEqual({
      connected: true,
      reason: null,
      detail: null,
      limits: limitsFromRateLimits(REAL),
      updatedAt: new Date(1_000_000).toISOString(),
      version: { installed: '0.166.0', latest: '0.167.0', outdated: true },
      upgradeCommand: 'mise upgrade codex',
    });
  });

  it('guarda por 3 min; depois lê de novo; desligar e ligar de novo também lê de novo', async () => {
    let t = 1_000_000;
    const { d, calls } = deps({ now: () => t });
    const reader = new CodexUsageReader(d);
    await reader.read(true);
    t += 2 * 60_000;
    await reader.read(true);
    expect(calls.readLimits).toBe(1);
    t += 61_000;
    await reader.read(true);
    expect(calls.readLimits).toBe(2);
    await reader.read(false);
    await reader.read(true);
    expect(calls.readLimits).toBe(3);
  });

  it('chamadas ao mesmo tempo dividem uma leitura só', async () => {
    const { d, calls } = deps();
    const reader = new CodexUsageReader(d);
    await Promise.all([reader.read(true), reader.read(true), reader.read(true)]);
    expect(calls.readLimits).toBe(1);
  });

  it('erro na leitura: connected false com motivo error, sem lançar, e guarda a versão', async () => {
    const { d } = deps({ readLimits: async () => ({ ok: false, error: 'account/rateLimits/read: error sending request' }) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({
      connected: false,
      reason: 'error',
      detail: 'account/rateLimits/read: error sending request',
      limits: [],
      version: { installed: '0.166.0', outdated: true },
      upgradeCommand: 'mise upgrade codex',
    });
  });

  it('exceção inesperada vira connected false (nunca lança)', async () => {
    const { d } = deps({ installed: async () => Promise.reject(new Error('quebrou')) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({ connected: false, reason: 'error', detail: 'quebrou' });
  });

  it('resposta que não é de limites: connected false', async () => {
    const { d } = deps({ readLimits: async () => ({ ok: true, result: { nada: 1 } }) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({ connected: false, reason: 'error' });
  });

  it('timeout do app-server (processo que não responde) vira connected false', async () => {
    const { d } = deps({ readLimits: () => readRateLimits('0.5.0', 30, () => fakeChild(() => {}).child as unknown as ChildProcess, async () => {}) });
    const r = await new CodexUsageReader(d).read(true);
    expect(r).toMatchObject({ connected: false, reason: 'error', detail: 'o Codex não respondeu a tempo' });
  });

  it('sem o CLI: not_installed, sem rodar login nem app-server', async () => {
    const { d, calls } = deps({ installed: async () => ({ missing: true, version: null, binPaths: [] }) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({ connected: false, reason: 'not_installed', version: null, upgradeCommand: null });
    expect(calls.check + calls.readLimits).toBe(0);
  });

  it('sem login: not_logged_in, sem abrir o app-server', async () => {
    const { d, calls } = deps({ check: async () => ({ available: false, reason: 'o Codex CLI está sem login (rode codex login)' }) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({ connected: false, reason: 'not_logged_in', version: { installed: '0.166.0' } });
    expect(calls.readLimits).toBe(0);
  });

  it('o login status dizer que não está instalado também vale not_installed', async () => {
    const { d } = deps({ check: async () => ({ available: false, reason: 'o Codex CLI não está instalado (npm i -g @openai/codex)' }) });
    expect(await new CodexUsageReader(d).read(true)).toMatchObject({ connected: false, reason: 'not_installed' });
  });

  it('leitura lenta: a rota recebe loading no prazo e a leitura termina no fundo', async () => {
    let release!: (r: RateLimitsRead) => void;
    let reads = 0;
    const { d } = deps({ readLimits: () => (reads++, new Promise<RateLimitsRead>((r) => (release = r))) });
    const reader = new CodexUsageReader(d);
    expect(await reader.read(true, { waitMs: 20 })).toMatchObject({ connected: false, reason: 'loading' });
    release({ ok: true, result: REAL });
    await new Promise((r) => setTimeout(r, 10));
    expect(await reader.read(true, { waitMs: 20 })).toMatchObject({ connected: true });
    expect(reads).toBe(1);
  });

  it('falha vale 30 s, não 3 min', async () => {
    let t = 1_000_000;
    let fail = true;
    const { d, calls } = deps({ now: () => t, readLimits: async () => (fail ? { ok: false, error: 'x' } : { ok: true, result: REAL }) });
    const reader = new CodexUsageReader(d);
    expect(await reader.read(true)).toMatchObject({ connected: false });
    fail = false;
    t += 31_000;
    expect(await reader.read(true)).toMatchObject({ connected: true });
    expect(calls.installed).toBe(2);
  });
});

/** Processo falso do app-server: `onLine` recebe cada mensagem enviada pelo app. */
function fakeChild(onLine: (m: { id?: number; method?: string }, reply: (m: unknown) => void) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, kill: vi.fn(() => true) });
  const sent: Array<{ id?: number; method?: string; params?: unknown }> = [];
  const reply = (m: unknown) => stdout.write(JSON.stringify(m) + '\n');
  let buf = '';
  stdin.on('data', (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      sent.push(m);
      onLine(m, reply);
    }
  });
  return { child, sent };
}

describe('readRateLimitsOnce (app-server)', () => {
  it('handshake: initialize, initialized, account/rateLimits/read; devolve o resultado e encerra o processo', async () => {
    const f = fakeChild((m, reply) => {
      if (m.id === 1) reply({ id: 1, result: { userAgent: 'codex' } });
      if (m.id === 2) reply({ id: 2, result: REAL });
    });
    const r = await readRateLimitsOnce('0.5.0', 5_000, () => f.child as unknown as ChildProcess);
    expect(r).toEqual({ ok: true, result: REAL });
    expect(f.sent.map((m) => m.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    expect(f.sent[0]).toMatchObject({ id: 1, params: { clientInfo: { name: 'claudios', version: '0.5.0' } } });
    expect(f.child.kill).toHaveBeenCalled();
  });

  it('o ambiente do processo não leva CLAUDE*, ANTHROPIC* nem MYCO_*', async () => {
    process.env.ANTHROPIC_API_KEY = 'x';
    process.env.CLAUDE_CODE_FOO = 'x';
    process.env.MYCO_TOKEN = 'x';
    let env: NodeJS.ProcessEnv | undefined;
    const f = fakeChild((m, reply) => m.id === 1 && reply({ id: 1, error: { message: 'x' } }));
    await readRateLimitsOnce('0', 5_000, (_c, _a, opts) => ((env = opts.env), f.child as unknown as ChildProcess));
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_FOO;
    delete process.env.MYCO_TOKEN;
    expect(env).toBeDefined();
    expect(Object.keys(env!).filter((k) => /^(ANTHROPIC|CLAUDE|MYCO)_/i.test(k))).toEqual([]);
  });

  it('erro JSON-RPC, processo que fecha sem responder e timeout: ok false e o processo é encerrado', async () => {
    const rpc = fakeChild((m, reply) => {
      if (m.id === 1) reply({ id: 1, result: {} });
      if (m.id === 2) reply({ id: 2, error: { code: -32603, message: 'error sending request' } });
    });
    expect(await readRateLimitsOnce('0', 5_000, () => rpc.child as unknown as ChildProcess)).toEqual({
      ok: false,
      error: 'account/rateLimits/read: error sending request',
    });
    expect(rpc.child.kill).toHaveBeenCalled();

    const closed = fakeChild(() => {});
    const closing = readRateLimitsOnce('0', 5_000, () => closed.child as unknown as ChildProcess);
    closed.child.emit('close', 1);
    expect(await closing).toMatchObject({ ok: false });
    expect(closed.child.kill).toHaveBeenCalled();

    const silent = fakeChild(() => {});
    expect(await readRateLimitsOnce('0', 20, () => silent.child as unknown as ChildProcess)).toEqual({ ok: false, error: 'o Codex não respondeu a tempo' });
    expect(silent.child.kill).toHaveBeenCalled();
  });

  it('sem o binário (ENOENT): erro fatal, sem segunda tentativa', async () => {
    const spawnFn = vi.fn(() => {
      const f = fakeChild(() => {});
      queueMicrotask(() => f.child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })));
      return f.child as unknown as ChildProcess;
    });
    const r = await readRateLimits('0', 5_000, spawnFn, async () => {});
    expect(r).toMatchObject({ ok: false, fatal: true });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });
});

describe('readRateLimits (nova tentativa)', () => {
  it('erro passageiro de rede na primeira: tenta de novo e devolve a segunda', async () => {
    let n = 0;
    const spawnFn = vi.fn(() => {
      const attempt = ++n;
      return fakeChild((m, reply) => {
        if (m.id === 1) reply({ id: 1, result: {} });
        if (m.id === 2) reply(attempt === 1 ? { id: 2, error: { code: -32603, message: 'error sending request' } } : { id: 2, result: REAL });
      }).child as unknown as ChildProcess;
    });
    const sleep = vi.fn(async () => {});
    expect(await readRateLimits('0', 20_000, spawnFn, sleep)).toEqual({ ok: true, result: REAL });
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('falha nas duas: devolve o erro (uma tentativa extra só)', async () => {
    const spawnFn = vi.fn(
      () =>
        fakeChild((m, reply) => {
          if (m.id === 1) reply({ id: 1, result: {} });
          if (m.id === 2) reply({ id: 2, error: { code: -32603, message: 'error sending request' } });
        }).child as unknown as ChildProcess,
    );
    expect(await readRateLimits('0', 20_000, spawnFn, async () => {})).toMatchObject({ ok: false });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});
