import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CiSummary } from '../client/src/tasks/CiBadge';
import { createGitHubClient, GitHubError, GitHubRateLimited, type GitHubCiClient } from '../server/adapters/github/client';
import { CiService, PENDING_TTL_MS } from '../server/ciStatus';
import { parsePrUrl, summarizeChecks, type CiStatus } from '../shared/ci';
import { tempDirs } from './support/tmp';

// Status do CI do GitHub: o resumo das checagens, o serviço com cache (nada de consultar a cada leitura da tela) e o adaptador (token só na API).

const tmp = tempDirs();
const SHA = 'a'.repeat(40);
const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, url: `https://github.com/d/r/runs/${name}` });

describe('resumo das checagens', () => {
  it('falha vence, depois rodando; neutra e pulada não reprovam; sem checagem é "sem CI"; a mesma checagem repetida vale a última', () => {
    expect(summarizeChecks([]).state).toBe('none');
    expect(summarizeChecks([run('test', 'completed', 'success'), run('lint', 'completed', 'skipped')]).state).toBe('success');
    expect(summarizeChecks([run('test', 'in_progress', null), run('lint', 'completed', 'success')]).state).toBe('pending');
    expect(summarizeChecks([run('test', 'in_progress', null), run('lint', 'completed', 'timed_out')]).state).toBe('failure');
    expect(summarizeChecks([run('test', 'completed', 'failure'), run('test', 'completed', 'success')]).state).toBe('success');
    // Link de fora do GitHub não vira link.
    expect(summarizeChecks([{ name: 'x', status: 'completed', conclusion: 'success', url: 'javascript:alert(1)' }]).checks[0]!.url).toBeNull();
  });

  it('link de PR: só https://github.com/dono/repo/pull/N', () => {
    expect(parsePrUrl('https://github.com/Dono/club/pull/12')).toEqual({ owner: 'Dono', repo: 'club', number: 12 });
    expect(parsePrUrl('https://gitlab.com/d/r/pull/1')).toBeNull();
    expect(parsePrUrl('https://github.com/d/r/issues/1')).toBeNull();
    expect(parsePrUrl(null)).toBeNull();
  });
});

function service(opts: { runs?: () => ReturnType<GitHubCiClient['checkRuns']>; pull?: GitHubCiClient['pull']; repo?: boolean; token?: string | null } = {}) {
  const h = { checks: 0, pulls: 0, tokens: 0, now: 1_000_000, tokenSeen: [] as Array<string | null> };
  const client: GitHubCiClient = {
    checkRuns: async (_o, _r, _sha, token) => {
      h.checks++;
      h.tokenSeen.push(token);
      return opts.runs ? opts.runs() : [run('test', 'completed', 'success')];
    },
    pull: opts.pull ?? (async () => (h.pulls++, { state: 'closed' as const, merged: true, headSha: 'b'.repeat(40), mergeSha: 'c'.repeat(40) })),
  };
  const svc = new CiService({
    client,
    repoOf: async () => (opts.repo === false ? null : { owner: 'd', repo: 'r' }),
    token: async () => (h.tokens++, opts.token === undefined ? 'ghp_' + 'x'.repeat(36) : opts.token),
    now: () => h.now,
  });
  return { svc, h };
}

describe('CiService', () => {
  it('verde fica guardado para sempre (o commit não muda): a segunda leitura não vai ao GitHub', async () => {
    const { svc, h } = service();
    expect((await svc.commit('p', SHA)).state).toBe('success');
    h.now += 24 * 60 * 60_000;
    expect((await svc.commit('p', SHA)).state).toBe('success');
    expect(h.checks).toBe(1);
  });

  it('rodando: no máximo uma consulta por minuto por commit, por mais que a tela peça', async () => {
    let state = 'in_progress';
    const { svc, h } = service({ runs: async () => [run('test', state, state === 'completed' ? 'success' : null)] });
    expect((await svc.commit('p', SHA)).state).toBe('pending');
    await svc.commit('p', SHA);
    h.now += PENDING_TTL_MS - 1;
    await svc.commit('p', SHA);
    expect(h.checks).toBe(1);
    state = 'completed';
    h.now += 1;
    expect((await svc.commit('p', SHA)).state).toBe('success');
    expect(h.checks).toBe(2);
  });

  it('sem GitHub, sem acesso, limite da API ou sem rede: "indisponível" com o motivo, nunca erro; e tenta de novo depois de um minuto', async () => {
    const none = service({ repo: false });
    expect(await none.svc.commit('p', SHA)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/não é um repositório do GitHub/) });
    const denied = service({ runs: async () => Promise.reject(new GitHubError('x', 404)) });
    expect(await denied.svc.commit('p', SHA)).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/gh está logado/) });
    const limited = service({ runs: async () => Promise.reject(new GitHubRateLimited(new Date(0).toISOString())) });
    expect((await limited.svc.commit('p', SHA)).reason).toMatch(/limite de consultas/);
    const net = service({ runs: async () => Promise.reject(new Error('ECONNRESET')) });
    await net.svc.commit('p', SHA);
    await net.svc.commit('p', SHA);
    expect(net.h.checks).toBe(1);
    net.h.now += PENDING_TTL_MS;
    await net.svc.commit('p', SHA);
    expect(net.h.checks).toBe(2);
    expect((await service().svc.commit('p', 'nao-e-sha')).state).toBe('unavailable');
  });

  it('o token do gh é pedido uma vez a cada 10 min e vai ao cliente; sem login, a consulta vai sem token', async () => {
    const { svc, h } = service();
    await svc.commit('p', SHA);
    await svc.commit('p', 'd'.repeat(40));
    expect(h.tokens).toBe(1);
    expect(h.tokenSeen[0]).toMatch(/^ghp_/);
    const anon = service({ token: null });
    await anon.svc.commit('p', SHA);
    expect(anon.h.tokenSeen).toEqual([null]);
  });

  it('PR mesclado: o estado do PR, o CI do último commit e o do commit da mescla; fechado fica guardado', async () => {
    const { svc, h } = service();
    const pr = await svc.pull('p', 9);
    expect(pr).toMatchObject({ pr: { number: 9, state: 'merged', mergeSha: 'c'.repeat(40) }, head: { state: 'success', sha: 'b'.repeat(40) }, merge: { state: 'success', sha: 'c'.repeat(40) } });
    h.now += 10 * 60_000;
    await svc.pull('p', 9);
    expect(h.pulls).toBe(1);
  });
});

describe('o adaptador do GitHub (check runs)', () => {
  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it('o token vai só no cabeçalho do pedido à API; sem token, sem cabeçalho; resposta lida em check runs', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const client = createGitHubClient({
      cacheDir: await tmp('myco-gh-ci-'),
      sleep: async () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        seen.push({ url, auth: (init?.headers as Record<string, string>).authorization ?? null });
        return reply({ total_count: 1, check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/d/r/runs/1' }] });
      }) as typeof fetch,
    });
    expect(await client.checkRuns('d', 'r', SHA, 'tok_' + 'y'.repeat(30))).toEqual([{ name: 'test', status: 'completed', conclusion: 'success', url: 'https://github.com/d/r/runs/1' }]);
    await client.checkRuns('d', 'r', 'e'.repeat(40), null);
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(['api.github.com', 'api.github.com']);
    expect(seen[0]!.auth).toBe(`Bearer tok_${'y'.repeat(30)}`);
    expect(seen[1]!.auth).toBeNull();
  });

  it('PR: estado, último commit e commit da mescla (só se mesclado); 404 vira GitHubError', async () => {
    let status = 200;
    const client = createGitHubClient({
      cacheDir: await tmp('myco-gh-pr-'),
      sleep: async () => {},
      fetch: (async () =>
        status === 200 ? reply({ state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40), head: { sha: 'b'.repeat(40) } }) : reply({ message: 'Not Found' }, 404)) as unknown as typeof fetch,
    });
    expect(await client.pull('d', 'r', 3, null)).toEqual({ state: 'closed', merged: true, headSha: 'b'.repeat(40), mergeSha: 'c'.repeat(40) });
    status = 404;
    await expect(client.pull('d', 'r', 4, null)).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('a tela do CI', () => {
  const s = (state: CiStatus['state'], extra: Partial<CiStatus> = {}): CiStatus => ({ state, sha: SHA, checks: [], checkedAt: '', ...extra });
  it('PR com o CI do PR e o da mescla, com as checagens; indisponível diz isso; sem PR não mostra nada', () => {
    const html = renderToStaticMarkup(
      createElement(CiSummary, { data: { pr: { number: 1, state: 'merged', mergeSha: SHA }, head: s('success', { checks: [{ name: 'test', state: 'success', url: 'https://github.com/d/r/runs/1' }] }), merge: s('pending') } }),
    );
    expect(html).toContain('CI do PR: <b>verde</b>');
    expect(html).toContain('CI da mescla: <b>rodando</b>');
    expect(html).toContain('Checagens (1)');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(renderToStaticMarkup(createElement(CiSummary, { data: s('unavailable', { reason: 'sem rede' }) }))).toContain('status do CI indisponível');
    expect(renderToStaticMarkup(createElement(CiSummary, { data: null }))).toContain('status do CI indisponível');
    expect(renderToStaticMarkup(createElement(CiSummary, { data: { pr: null, head: null, merge: null } }))).toBe('');
  });
});
