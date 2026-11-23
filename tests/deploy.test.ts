import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeployPanel } from '../client/src/tasks/DeployPanel';
import { createGitHubClient, GitHubError, type GitHubActionsClient, type WorkflowRun } from '../server/adapters/github/client';
import { CHECK_MS, DeployService, type DeployDeps } from '../server/deploy';
import type { Task } from '../shared/model';
import { tempDirs } from './support/tmp';

// Deploy como código (docs/deploy.md): o Club dispara o deploy.yml do projeto pelo adaptador do GitHub e acompanha a execução só enquanto ela roda.

const tmp = tempDirs();
const FULL = 'a'.repeat(40);

async function setup(opts: { workflow?: boolean; token?: string | null; tags?: string[]; onGitHub?: boolean; dispatchFails?: Error } = {}) {
  const dir = await tmp('myco-deploy-proj-');
  if (opts.workflow !== false) {
    await fs.mkdir(path.join(dir, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github', 'workflows', 'deploy.yml'), 'name: Deploy\n');
  }
  const stateDir = await tmp('myco-deploys-');
  const h = {
    now: Date.parse('2026-11-23T12:00:00.000Z'),
    dispatched: [] as Array<{ gitRef: string; inputs: Record<string, string> }>,
    runs: [] as WorkflowRun[],
    calls: 0,
    notices: [] as string[],
    tasks: [{ id: 't-aaaa01', title: 'A', status: 'done', merged: { at: '', sha: 'abc1234', branch: 'myco/x', base: 'main' } } as unknown as Task, { id: 't-none02', title: 'B', status: 'review' } as unknown as Task],
  };
  const client: GitHubActionsClient = {
    dispatchWorkflow: async (_o, _r, _w, gitRef, inputs) => {
      if (opts.dispatchFails) throw opts.dispatchFails;
      h.dispatched.push({ gitRef, inputs });
    },
    workflowRuns: async () => (h.calls++, h.runs),
    workflowRun: async (_o, _r, id) => (h.calls++, h.runs.find((r) => r.id === id)!),
    commitExists: async () => opts.onGitHub !== false,
  };
  const deps: DeployDeps = {
    stateDir,
    projectPath: async (id) => (id === 'p' ? dir : null),
    repoOf: async () => ({ owner: 'dono', repo: 'club' }),
    defaultBranch: async () => 'main',
    resolveCommit: async (_p, sha) => (sha === 'abc1234' ? FULL : null),
    tags: async () => opts.tags ?? ['v1.5.2', 'v1.5.1'],
    readTasks: async () => h.tasks,
    token: async () => (opts.token === undefined ? 'ghp_' + 'x'.repeat(36) : opts.token),
    client,
    notify: async (_p, text) => void h.notices.push(text),
    log: () => {},
    now: () => h.now,
  };
  return { svc: new DeployService(deps), h, dir, stateDir };
}

describe('DeployService', () => {
  it('sem o workflow, o deploy não é por aqui (o cartão segue pela conversa SSH)', async () => {
    const c = await setup({ workflow: false });
    expect(await c.svc.available('p')).toMatchObject({ ok: false, reason: expect.stringMatching(/deploy\.yml/) });
    await expect(c.svc.dispatch('p', { taskId: 't-aaaa01' }, true)).rejects.toThrow(/conversa com o funcionário de infra/);
  });

  it('do cartão: só você, com o commit mesclado completo; dispara uma vez, na branch padrão, com ref e ambiente', async () => {
    const c = await setup();
    await expect(c.svc.dispatch('p', { taskId: 't-aaaa01' }, false)).rejects.toMatchObject({ status: 403 });
    const rec = await c.svc.dispatch('p', { taskId: 't-aaaa01' }, true);
    expect(rec).toMatchObject({ ref: FULL, environment: 'staging', taskId: 't-aaaa01', state: 'queued' });
    expect(c.h.dispatched).toEqual([{ gitRef: 'main', inputs: { ref: FULL, ambiente: 'staging' } }]);
    // Um deploy por ambiente de cada vez.
    await expect(c.svc.dispatch('p', { taskId: 't-aaaa01' }, true)).rejects.toThrow(/já há um deploy em staging rodando/);
    // Registro fora do projeto.
    expect(JSON.parse(await fs.readFile(path.join(c.stateDir, 'p.json'), 'utf8')).records).toHaveLength(1);
    await expect(fs.access(path.join(c.dir, '.myco'))).rejects.toThrow();
  });

  it('produção só com o seu ok; tarefa sem commit, commit fora do GitHub e gh sem login recusam antes de disparar', async () => {
    const c = await setup();
    await expect(c.svc.dispatch('p', { taskId: 't-aaaa01', environment: 'producao' }, true)).rejects.toThrow(/produção pede o seu ok/);
    await expect(c.svc.dispatch('p', { taskId: 't-none02' }, true)).rejects.toThrow(/ainda não tem commit/);
    await expect((await setup({ onGitHub: false })).svc.dispatch('p', { taskId: 't-aaaa01' }, true)).rejects.toThrow(/ainda não está no GitHub/);
    await expect((await setup({ token: null })).svc.dispatch('p', { taskId: 't-aaaa01' }, true)).rejects.toThrow(/gh desta máquina precisa estar logado/);
    expect(c.h.dispatched).toEqual([]);
    expect((await c.svc.dispatch('p', { taskId: 't-aaaa01', environment: 'producao', confirm: true }, true)).environment).toBe('producao');
  });

  it('versão e rollback: a tag mais nova, ou a anterior (com de onde voltou); tag desconhecida recusa', async () => {
    const c = await setup();
    await expect(c.svc.dispatch('p', { tag: 'v9.9.9' }, true)).rejects.toThrow(/não existe/);
    expect(await c.svc.dispatch('p', { tag: 'v1.5.2' }, true)).toMatchObject({ ref: 'v1.5.2', rollbackFrom: null });
    const back = await c.svc.dispatch('p', { rollback: true, environment: 'producao', confirm: true }, true);
    expect(back).toMatchObject({ ref: 'v1.5.1', rollbackFrom: 'v1.5.2', environment: 'producao' });
    await expect((await setup({ tags: ['v1.0.0'] })).svc.dispatch('p', { rollback: true }, true)).rejects.toThrow(/não há versão anterior/);
    await expect(c.svc.dispatch('p', { tag: 'v1.5.2', rollback: true }, true)).rejects.toMatchObject({ status: 400 });
  });

  it('acompanha só enquanto roda e no máximo 1x a cada 30 s: acha a execução, lê até terminar, avisa a caixa e para', async () => {
    const c = await setup();
    await c.svc.dispatch('p', { taskId: 't-aaaa01' }, true);
    c.h.runs = [{ id: 7, status: 'in_progress', conclusion: null, url: 'https://github.com/dono/club/actions/runs/7', createdAt: new Date(c.h.now + 2000).toISOString() }];
    let info = (await c.svc.info('p', 't-aaaa01'))!;
    expect(info.records[0]).toMatchObject({ state: 'running', runId: 7, runUrl: 'https://github.com/dono/club/actions/runs/7' });
    await c.svc.info('p', 't-aaaa01');
    await c.svc.sweep();
    expect(c.h.calls).toBe(1);
    c.h.runs[0] = { ...c.h.runs[0]!, status: 'completed', conclusion: 'success' };
    c.h.now += CHECK_MS;
    await c.svc.sweep();
    info = (await c.svc.info('p'))!;
    expect(info.records[0]).toMatchObject({ state: 'success', finishedAt: expect.any(String) });
    expect(c.h.notices).toEqual([expect.stringMatching(/deploy de aaaaaaa em staging: no ar \(smoke ok\)/)]);
    // Terminado: não consulta mais.
    c.h.now += 10 * CHECK_MS;
    await c.svc.sweep();
    await c.svc.info('p');
    expect(c.h.calls).toBe(2);
    expect(info.latestTag).toBe('v1.5.2');
    expect(info.previousTag).toBe('v1.5.1');
  });

  it('execução que não aparece em 10 min vira "sem resposta"; falha do disparo não grava registro', async () => {
    const c = await setup();
    await c.svc.dispatch('p', { taskId: 't-aaaa01' }, true);
    c.h.now += 11 * 60_000;
    await c.svc.sweep();
    expect((await c.svc.info('p'))!.records[0]).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/não apareceu/) });
    const f = await setup({ dispatchFails: new GitHubError('o GitHub não achou o workflow', 404) });
    await expect(f.svc.dispatch('p', { taskId: 't-aaaa01' }, true)).rejects.toThrow(/não achou o workflow/);
    expect((await f.svc.info('p'))!.records).toEqual([]);
  });
});

describe('o adaptador: disparo', () => {
  it('POST uma vez só (falha de rede não repete e manda conferir no GitHub), com o token e as entradas', async () => {
    const seen: Array<{ method?: string; body?: string; auth?: string }> = [];
    let fail = true;
    const client = createGitHubClient({
      cacheDir: await tmp('myco-gh-dispatch-'),
      sleep: async () => {},
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push({ method: init?.method, body: init?.body as string, auth: (init?.headers as Record<string, string>).authorization });
        if (fail) throw new TypeError('fetch failed');
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    await expect(client.dispatchWorkflow('dono', 'club', 'deploy.yml', 'main', { ref: 'v1.5.2', ambiente: 'staging' }, 'tok_' + 'z'.repeat(30))).rejects.toThrow(/pode ter chegado/);
    expect(seen).toHaveLength(1);
    fail = false;
    await client.dispatchWorkflow('dono', 'club', 'deploy.yml', 'main', { ref: 'v1.5.2', ambiente: 'staging' }, 'tok_' + 'z'.repeat(30));
    expect(seen[1]).toEqual({ method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { ref: 'v1.5.2', ambiente: 'staging' } }), auth: `Bearer tok_${'z'.repeat(30)}` });
    await expect(client.dispatchWorkflow('dono', 'club', '../x.yml', 'main', {}, 't')).rejects.toThrow(/inválido/);
  });
});

describe('a tela', () => {
  it('sem o workflow, o cartão mostra o "Pedir deploy" de sempre; com ele, o ambiente, o botão e os últimos deploys com o log', () => {
    const fallback = createElement('span', null, 'SSH de sempre');
    expect(renderToStaticMarkup(createElement(DeployPanel, { projectId: 'p', taskId: 't-1', fallback, initial: { available: false, records: [], latestTag: null, previousTag: null } }))).toContain('SSH de sempre');
    const html = renderToStaticMarkup(
      createElement(DeployPanel, {
        projectId: 'p',
        initial: {
          available: true,
          latestTag: 'v1.5.2',
          previousTag: 'v1.5.1',
          records: [{ id: '1', ref: 'v1.5.1', environment: 'producao', taskId: null, rollbackFrom: 'v1.5.2', at: '', state: 'failure', runId: 7, runUrl: 'https://github.com/d/r/actions/runs/7', finishedAt: '' }],
        },
      }),
    );
    expect(html).toContain('Deploy de v1.5.2');
    expect(html).toContain('Voltar para v1.5.1 (versão anterior)');
    expect(html).toContain('produção · <code>v1.5.1</code> · rollback de v1.5.2 · <b>falhou</b>');
    expect(html).toContain('href="https://github.com/d/r/actions/runs/7"');
  });
});
