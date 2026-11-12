import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSystemCost, CostIndex, readSystemCosts, type SystemCostRow } from '../server/adapters/claude/costs';
import { ShowcaseRunner, type ClaudeOutput, type ClaudeRun, type SpawnClaude } from '../server/showcaseRunner';

const HTML = '<!doctype html><html lang="pt-BR"><head></head><body><h1>Projeto</h1></body></html>';
const PROMPT = 'PROMPT_NAO_VAI_AO_LEDGER';
/** Ao meio-dia local: o dia local é o mesmo em qualquer fuso. */
const NOON = new Date(2026, 9, 26, 12, 0).toISOString();
const NOW = new Date(2026, 9, 26, 15, 0);

/** Saída do `claude -p --output-format json`. */
const out = (subtype: string, result: string | null, extra: Record<string, unknown> = {}): ClaudeOutput => ({
  code: 0,
  stderr: '',
  stdout: JSON.stringify({ type: 'result', subtype, is_error: subtype !== 'success', ...(result === null ? {} : { result }), ...extra }),
});
const finished = (o: ClaudeOutput): ClaudeRun => ({ done: Promise.resolve(o), kill: () => {} });

/** Sonnet 5: 1M de entrada (US$ 2) + 100k de saída (US$ 1) = US$ 3. O CLI diz 3,5: o ledger não usa esse número. */
const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const MODEL_USAGE = { 'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 100_000, costUSD: 3.5 } };

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );
const readRows = async (file: string) => (await fs.readFile(file, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as SystemCostRow);

describe('gerador da vitrine: ledger do Sistema (gravação)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ledger-gerador-'));
    file = path.join(dir, 'logs', 'system-costs.jsonl');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  function runnerWith(responses: ClaudeRun[], systemCostsFile = file) {
    const logs: string[] = [];
    const spawnClaude: SpawnClaude = () => {
      const next = responses.shift();
      if (!next) throw new Error('spawn inesperado');
      return next;
    };
    const runner = new ShowcaseRunner({
      spawnClaude,
      checkUsage: async () => {},
      reserve: async () => ({ ok: true, release: () => {} }),
      sleep: async () => {},
      random: () => 0,
      log: (line) => logs.push(line),
      timeoutMs: 60_000,
      systemCostsFile,
    });
    return { runner, logs };
  }

  const job = () => ({ projectId: 'p1', dir, prompt: PROMPT, head: null });

  it('done: uma linha com modelo, tokens e custo do CLI; sem prompt nem HTML', async () => {
    const { runner } = runnerWith([finished(out('success', HTML, { usage, modelUsage: MODEL_USAGE, total_cost_usd: 3.5 }))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'done' });
    const rows = await readRows(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'p1',
      source: 'vitrine',
      costUsd: 3.5,
      model: 'claude-sonnet-5',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(Number.isNaN(Date.parse(rows[0]!.at))).toBe(false);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain('<html');
    expect(raw).not.toContain(PROMPT);
  });

  it('failed: o gasto de uma geração que falhou também entra', async () => {
    const { runner } = runnerWith([finished(out('error_max_turns', '', { usage, modelUsage: MODEL_USAGE, total_cost_usd: 3.5 }))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'failed' });
    expect(await readRows(file)).toHaveLength(1);
  });

  it('duas tentativas (a 1ª com sobrecarga): uma linha só, com a soma das duas', async () => {
    const { runner } = runnerWith([
      finished(out('error_during_execution', 'API Error: 529 overloaded_error', { usage: { input_tokens: 100_000, output_tokens: 0 }, modelUsage: MODEL_USAGE, total_cost_usd: 0.2 })),
      finished(out('success', HTML, { usage: { input_tokens: 200_000, output_tokens: 0 }, modelUsage: MODEL_USAGE, total_cost_usd: 0.4 })),
    ]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'done' });
    const rows = await readRows(file);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5', inputTokens: 300_000, outputTokens: 0 });
    expect(rows[0]!.costUsd).toBeCloseTo(0.6, 6);
  });

  it('o CLI não informou uso nenhum: nenhuma linha, e o arquivo nem aparece', async () => {
    const { runner } = runnerWith([finished(out('success', HTML))]);
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1').state).toBe('done');
    expect(await exists(file)).toBe(false);
  });

  it('falha de gravação do ledger não derruba a geração (vira linha de log)', async () => {
    const bloqueado = path.join(dir, 'bloqueado');
    await fs.writeFile(bloqueado, 'arquivo comum no lugar da pasta de logs');
    const { runner, logs } = runnerWith([finished(out('success', HTML, { usage, modelUsage: MODEL_USAGE, total_cost_usd: 3.5 }))], path.join(bloqueado, 'system-costs.jsonl'));
    await runner.start(job());
    await runner.settled('p1');
    expect(runner.status('p1')).toMatchObject({ state: 'done', costUsd: 3.5 });
    expect(await fs.readFile(path.join(dir, 'VITRINE.html'), 'utf8')).toBe(HTML + '\n');
    expect(logs.some((l) => l.includes('não gravei o custo no ledger'))).toBe(true);
  });

  it('o que o gerador grava, o relatório lê como Sistema (mesmo arquivo)', async () => {
    const { runner } = runnerWith([finished(out('success', HTML, { usage, modelUsage: MODEL_USAGE, total_cost_usd: 3.5 }))]);
    await runner.start(job());
    await runner.settled('p1');
    const idx = new CostIndex(path.join(dir, 'projects'), path.join(dir, 'cache.json'), file);
    await idx.refresh();
    const r = idx.report(NOW);
    expect(r.system!.usd).toBeCloseTo(3, 6);
    expect(r.system!.runs).toBe(1);
    expect(r.total.usd).toBeCloseTo(3, 6);
    expect(r.projects['p1']!.usd).toBeCloseTo(3, 6);
  });
});

describe('Sistema no relatório de custos (ledger)', () => {
  let root: string;
  let ledger: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ledger-custos-'));
    ledger = path.join(root, 'logs', 'system-costs.jsonl');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  /** Pasta de projetos inexistente: só o ledger tem gasto. */
  const index = (systemFile?: string) => new CostIndex(path.join(root, 'projects'), path.join(root, 'cache.json'), systemFile);
  const row = (over: Partial<SystemCostRow>): SystemCostRow => ({
    at: NOON,
    projectId: 'a',
    source: 'vitrine',
    model: 'claude-sonnet-5',
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    ...over,
  });

  it('sem ledger nada muda: sem o campo system e com o total zerado', async () => {
    const idx = index(path.join(root, 'nao-existe.jsonl'));
    await idx.refresh();
    const r = idx.report(NOW);
    expect(r).not.toHaveProperty('system');
    expect(r.total.usd).toBe(0);
    expect(r.models).toEqual({});
    expect(r.unpricedModels).toEqual([]);
  });

  it('soma o ledger como Sistema: total, projeto e modelo; o preço é o da tabela (tokens), não o do CLI', async () => {
    await appendSystemCost(ledger, row({ projectId: 'a', costUsd: 3.5 })); // US$ 3 pela tabela
    await appendSystemCost(ledger, row({ projectId: 'b', inputTokens: 500_000, outputTokens: 0, costUsd: 1 })); // US$ 1
    await appendSystemCost(ledger, { at: NOON, projectId: 'a', source: 'vitrine', costUsd: 9 }); // sem modelo nem tokens: fora
    const idx = index(ledger);
    await idx.refresh();
    const r = idx.report(NOW);

    expect(r.total.usd).toBeCloseTo(4, 6);
    expect(r.total.today).toBeCloseTo(4, 6);
    expect(r.system!.usd).toBeCloseTo(4, 6);
    expect(r.system!.runs).toBe(3);
    expect(r.system!.projects['a']).toBeCloseTo(3, 6);
    expect(r.system!.projects['b']).toBeCloseTo(1, 6);
    expect(r.projects['a']!.usd).toBeCloseTo(3, 6);
    expect(r.projects['b']!.usd).toBeCloseTo(1, 6);
    expect(r.models['claude-sonnet-5']).toBeCloseTo(4, 6);
    expect(r.unpricedModels).toEqual(['(sem modelo)']);
    expect(r.agents).toEqual({}); // o Sistema não vira agent: ranking e participação dos agents não mudam
  });

  it('o quadro (only): o total conta tudo; o Sistema e os projetos, só os do quadro', async () => {
    await appendSystemCost(ledger, row({ projectId: 'a' }));
    await appendSystemCost(ledger, row({ projectId: 'b', inputTokens: 500_000, outputTokens: 0 }));
    await appendSystemCost(ledger, { at: NOON, projectId: 'a', source: 'vitrine', costUsd: 9 });
    const idx = index(ledger);
    await idx.refresh();
    const r = idx.report(NOW, new Set(['a']));

    expect(r.total.usd).toBeCloseTo(4, 6);
    expect(r.system!.runs).toBe(2);
    expect(r.system!.usd).toBeCloseTo(3, 6);
    expect(Object.keys(r.system!.projects)).toEqual(['a']);
    expect(r.projects).not.toHaveProperty('b');
    expect(r.models['claude-sonnet-5']).toBeCloseTo(3, 6);
  });

  it('readSystemCosts pula linha quebrada, data inválida e campo vazio', async () => {
    await appendSystemCost(ledger, row({}));
    await fs.appendFile(ledger, 'linha { quebrada\n');
    await fs.appendFile(ledger, JSON.stringify({ ...row({}), at: 'nao-e-data' }) + '\n');
    await fs.appendFile(ledger, JSON.stringify({ ...row({}), projectId: '' }) + '\n');
    expect(await readSystemCosts(ledger)).toHaveLength(1);
    expect(await readSystemCosts(path.join(root, 'nao-existe.jsonl'))).toEqual([]);
  });
});
