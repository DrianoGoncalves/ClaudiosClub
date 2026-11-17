import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitHubClient, GitHubError, GitHubRateLimited, gitBlobSha } from '../server/adapters/github/client';

// Nada de rede: o fetch é falso e a espera, o sorteio do jitter e o relógio são controlados pelo teste.

let root: string;
let counter = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-github-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TREE = 'fedcba9876543210fedcba9876543210fedcba98';
const hex = (s: string) => createHash('sha1').update(s).digest('hex');
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Log {
  calls: Array<{ url: string; init?: RequestInit | undefined }>;
}

/** Um cliente com fetch falso (`handler` responde cada URL), espera sem tempo, jitter zero e relógio `t` (ms). */
function client(handler: (url: string, init?: RequestInit) => Response, extra: { t?: { now: number }; sleeps?: number[] } = {}) {
  const log: Log = { calls: [] };
  const clock = extra.t ?? { now: 1_700_000_000_000 };
  const sleeps = extra.sleeps ?? [];
  counter++;
  const c = createGitHubClient({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      log.calls.push({ url: String(input), init });
      return handler(String(input), init);
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    now: () => clock.now,
    cacheDir: path.join(root, `cache-${counter}`),
  });
  return { c, log, clock, sleeps };
}

/** Respostas do branch padrão e do commit de `main`; o resto é 500 (para o teste notar o pedido inesperado). */
const branchReply = (url: string): Response => {
  if (url.endsWith('/repos/o/r')) return json({ default_branch: 'main' });
  if (url.endsWith('/commits/main')) return new Response(`${COMMIT}\n`, { status: 200 });
  return new Response('', { status: 500 });
};

describe('adaptador do GitHub: ref e árvore', () => {
  it('sem ref usa o branch padrão; o sha vem do endpoint de commit com Accept de sha', async () => {
    const { c, log } = client((url) => branchReply(url) ?? new Response('', { status: 500 }));
    expect(await c.resolveRef('o', 'r', null)).toEqual({ ref: 'main', sha: COMMIT });
    const commit = log.calls.find((x) => x.url.includes('/commits/'));
    expect((commit?.init?.headers as Record<string, string>).accept).toBe('application/vnd.github.sha');
  });

  it('resposta que não é um sha de 40 caracteres é recusada', async () => {
    const { c } = client((url) => (url.includes('/commits/') ? new Response('nao-e-sha', { status: 200 }) : new Response('', { status: 500 })));
    await expect(c.resolveRef('o', 'r', 'main')).rejects.toThrow('commit válido');
  });

  it('o cache (refs.json) segura o sha por 10 min na mesma pasta: depois disso, pergunta de novo', async () => {
    const t = { now: 1_700_000_000_000 };
    const dir = path.join(root, 'cache-ttl');
    let calls = 0;
    const counting = (async (input: string | URL | Request) => {
      calls++;
      return branchReply(String(input)) ?? new Response('', { status: 500 });
    }) as typeof fetch;
    const never = (async () => {
      throw new Error('não devia chamar a rede');
    }) as typeof fetch;
    const mk = (f: typeof fetch) => createGitHubClient({ fetch: f, sleep: async () => undefined, random: () => 0, now: () => t.now, cacheDir: dir });

    await mk(counting).resolveRef('o', 'r', 'main');
    expect(calls).toBe(1);
    // Dentro do TTL: vem do disco (um fetch que explode prova que não há rede).
    expect(await mk(never).resolveRef('o', 'r', 'main')).toEqual({ ref: 'main', sha: COMMIT });
    t.now += 11 * 60_000;
    await mk(counting).resolveRef('o', 'r', 'main');
    expect(calls).toBe(2);
  });

  it('pedidos iguais em voo viram um só', async () => {
    const { c, log } = client(branchReply);
    await Promise.all([c.resolveRef('o', 'r', 'main'), c.resolveRef('o', 'r', 'main')]);
    expect(log.calls.filter((x) => x.url.includes('/commits/'))).toHaveLength(1);
  });

  it('árvore: lista as entradas e devolve truncated (quem chama decide)', async () => {
    const body = {
      sha: TREE,
      truncated: true,
      tree: [
        { path: 'SKILL.md', mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 10 },
        { path: 'pasta', mode: '040000', type: 'tree', sha: 'b'.repeat(40) },
      ],
    };
    const { c } = client(() => json(body));
    const t = await c.tree('o', 'r', COMMIT);
    expect(t.truncated).toBe(true);
    expect(t.sha).toBe(TREE);
    expect(t.entries.map((e) => e.path)).toEqual(['SKILL.md', 'pasta']);
    expect(t.entries[0]?.size).toBe(10);
  });
});

describe('adaptador do GitHub: arquivo (blob)', () => {
  it('confere o sha1 de git e devolve o conteúdo; o caminho vai codificado por segmento', async () => {
    const bytes = Buffer.from('# Skill\n');
    const expected = gitBlobSha(bytes);
    const { c, log } = client(() => new Response(bytes, { status: 200 }));
    const got = await c.blob('o', 'r', COMMIT, 'skills/a b/SKILL.md', expected, 1000);
    expect(got.toString()).toBe('# Skill\n');
    expect(log.calls[0]?.url).toBe(`https://raw.githubusercontent.com/o/r/${COMMIT}/skills/a%20b/SKILL.md`);
    expect(gitBlobSha(Buffer.from('abc'))).toBe(hex('blob 3\0abc'));
  });

  it('sha1 diferente do registrado: erro (não grava no cache)', async () => {
    const { c } = client(() => new Response('conteúdo trocado', { status: 200 }));
    await expect(c.blob('o', 'r', COMMIT, 'SKILL.md', gitBlobSha(Buffer.from('o certo')), 1000)).rejects.toThrow('sha1');
  });

  it('passou do limite no stream (sem cabeçalho de tamanho): aborta', async () => {
    const { c } = client(() => new Response('x'.repeat(100), { status: 200 }));
    await expect(c.blob('o', 'r', COMMIT, 'big.txt', gitBlobSha(Buffer.from('x'.repeat(100))), 10)).rejects.toThrow('maior que o declarado');
  });

  it('content-length maior que o declarado: recusa antes de ler', async () => {
    const { c } = client(() => new Response('abc', { status: 200, headers: { 'content-length': '100000' } }));
    await expect(c.blob('o', 'r', COMMIT, 'big.txt', gitBlobSha(Buffer.from('abc')), 10)).rejects.toThrow('maior que o declarado');
  });
});

describe('adaptador do GitHub: redirecionamento, cabeçalhos e erros', () => {
  it('redirecionamento para outro host é recusado; para o próprio GitHub (rename de repo) é seguido', async () => {
    const other = client(() => new Response(null, { status: 301, headers: { location: 'https://evil.example/x' } }));
    await expect(other.c.resolveRef('o', 'r', 'main')).rejects.toThrow('fora do GitHub');
    expect(other.log.calls).toHaveLength(1);

    const renamed = client((url) => {
      if (url.endsWith('/repos/o/r')) return new Response(null, { status: 301, headers: { location: 'https://api.github.com/repositories/42' } });
      if (url.endsWith('/repositories/42')) return json({ default_branch: 'main' });
      return branchReply(url) ?? new Response('', { status: 500 });
    });
    expect(await renamed.c.resolveRef('o', 'r', null)).toMatchObject({ ref: 'main' });
  });

  it('404 não repete e vem com o status (quem chama tenta o próximo corte do ref)', async () => {
    const { c, log } = client(() => new Response('', { status: 404 }));
    const err = await c.resolveRef('o', 'r', 'nao-existe').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).status).toBe(404);
    expect(log.calls).toHaveLength(1);
  });

  it('5xx repete com espera exponencial (base 1 s, jitter zero aqui) e para na terceira tentativa', async () => {
    let n = 0;
    const { c, sleeps } = client((url) => {
      n++;
      return n <= 2 ? new Response('', { status: 503 }) : branchReply(url) ?? new Response('', { status: 500 });
    });
    expect(await c.resolveRef('o', 'r', 'main')).toEqual({ ref: 'main', sha: COMMIT });
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('limite da API (403 com remaining 0): erro com resetAt e o disjuntor fica aberto até o reset', async () => {
    const t = { now: 1_700_000_000_000 };
    const reset = Math.floor(t.now / 1000) + 3600;
    let fail = true;
    const { c, log } = client(
      (url) => (fail ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }) : branchReply(url) ?? new Response('', { status: 500 })),
      { t },
    );
    const err = await c.resolveRef('o', 'r', 'main').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimited);
    expect((err as GitHubRateLimited).resetAt).toBe(new Date(reset * 1000).toISOString());
    const calls = log.calls.length;
    await expect(c.resolveRef('o', 'r', 'outro')).rejects.toBeInstanceOf(GitHubRateLimited);
    expect(log.calls.length).toBe(calls); // não chamou a API de novo
    fail = false;
    t.now = reset * 1000 + 1000;
    expect(await c.resolveRef('o', 'r', 'main')).toEqual({ ref: 'main', sha: COMMIT });
  });

  it('cinco falhas seguidas (5xx) abrem o disjuntor por 5 min: sem chamar a rede', async () => {
    const t = { now: 1_700_000_000_000 };
    const { c, log } = client(() => new Response('', { status: 500 }), { t });
    for (let i = 0; i < 5; i++) await expect(c.resolveRef('o', 'r', `ref-${i}`)).rejects.toBeInstanceOf(GitHubError);
    const calls = log.calls.length;
    await expect(c.resolveRef('o', 'r', 'mais-um')).rejects.toThrow('falhando');
    expect(log.calls.length).toBe(calls);
    t.now += 5 * 60_000 + 1;
    await expect(c.resolveRef('o', 'r', 'depois')).rejects.toBeInstanceOf(GitHubError);
    expect(log.calls.length).toBeGreaterThan(calls);
  });

  it('nunca manda cookie, token nem autorização; manda o User-Agent do Club', async () => {
    const { c, log } = client(branchReply);
    await c.resolveRef('o', 'r', 'main');
    for (const call of log.calls) {
      const h = (call.init?.headers ?? {}) as Record<string, string>;
      expect(h['user-agent']).toBe('claudios-club');
      const keys = Object.keys(h).map((k) => k.toLowerCase());
      expect(keys).not.toContain('authorization');
      expect(keys).not.toContain('cookie');
    }
  });

  it('repositório ou ref com caractere estranho: recusado antes da rede', async () => {
    const { c, log } = client(branchReply);
    await expect(c.resolveRef('o', '../etc', 'main')).rejects.toThrow('repositório inválido');
    await expect(c.resolveRef('o', 'r', '../main')).rejects.toBeInstanceOf(GitHubError);
    expect(log.calls).toHaveLength(0);
  });
});
