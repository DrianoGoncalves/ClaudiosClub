import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CostIndex, dayKey, parseAssistantLine } from '../server/adapters/claude/costs';
import { costOf, normalizeModel } from '../server/adapters/claude/pricing';

describe('pricing', () => {
  it('normaliza ids com data ou sufixo', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModel('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
  });

  it('preço do Opus 5.5: entrada, saída, cache 5m/1h e leitura a 0,05×', () => {
    // 1M de cada: 4 + 20 + 0,5M×5 + 0,5M×8 + 1M×0,20
    const usd = costOf('claude-opus-5-5', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_1h_input_tokens: 500_000 },
      cache_read_input_tokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(4 + 20 + 2.5 + 4 + 0.2, 6);
  });

  it('leitura de cache padrão é 0,1× a entrada; sem detalhamento, escrita conta como 5m', () => {
    expect(costOf('claude-sonnet-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 6);
    expect(costOf('claude-sonnet-5', { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(2.5, 6);
  });

  it('Haiku 5.5 muda de faixa acima de 100K tokens de prompt', () => {
    expect(costOf('claude-haiku-5-5', { input_tokens: 100_000 })).toBeCloseTo(0.01, 6);
    expect(costOf('claude-haiku-5-5', { input_tokens: 200_000 })).toBeCloseTo(0.1, 6);
  });

  it('modo rápido dobra no Opus 5.5; modelo desconhecido não tem preço', () => {
    expect(costOf('claude-opus-5-5', { output_tokens: 1_000_000, speed: 'fast' })).toBeCloseTo(40, 6);
    expect(costOf('modelo-novo', { input_tokens: 1 })).toBeNull();
  });

  it('modelo que saiu depois da tabela usa o preço do mais recente da família', () => {
    expect(costOf('claude-haiku-6', { input_tokens: 1_000_000 })).toBeCloseTo(costOf('claude-haiku-5-5', { input_tokens: 1_000_000 })!, 6);
    expect(costOf('claude-opus-6-1-20270101', { output_tokens: 1_000_000 })).toBeCloseTo(20, 6);
    expect(costOf('claude-sonnet-6[1m]', { output_tokens: 1_000_000 })).toBeCloseTo(10, 6);
    expect(costOf('claude-novafamilia-1', { input_tokens: 1 })).toBeNull();
  });
});

function assistant(id: string, usage: object, opts: { model?: string; ts?: string; text?: string } = {}) {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: {
      model: opts.model ?? 'claude-sonnet-5',
      id,
      type: 'message',
      role: 'assistant',
      // Conteúdo com chaves que imitam as de uso: o leitor não pode se confundir.
      content: [{ type: 'tool_use', input: { usage: { input_tokens: 999999 } }, text: opts.text ?? '"usage":{"output_tokens":5}' }],
      stop_reason: 'tool_use',
      usage,
    },
    type: 'assistant',
    uuid: 'u',
    timestamp: opts.ts ?? '2026-10-26T12:00:00.000Z',
  });
}

describe('parseAssistantLine', () => {
  it('pega o usage da mensagem, não o de dentro do conteúdo', () => {
    const r = parseAssistantLine(assistant('m1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 }));
    expect(r).toMatchObject({ id: 'm1', usage: { model: 'claude-sonnet-5', input: 10, output: 20, read: 30 } });
  });

  it('ignora linhas que não são de resposta e respostas sintéticas', () => {
    expect(parseAssistantLine(JSON.stringify({ type: 'user', message: { content: 'oi' } }))).toBeNull();
    expect(parseAssistantLine(assistant('m2', { output_tokens: 1 }, { model: '<synthetic>' }))).toBeNull();
  });
});

describe('CostIndex', () => {
  let root: string;
  let projectsDir: string;
  let main: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-costs-'));
    projectsDir = path.join(root, 'projects');
    const proj = path.join(projectsDir, 'C--www-a');
    main = path.join(proj, 's1.jsonl');
    await fs.mkdir(path.join(proj, 's1', 'subagents'), { recursive: true });
    const u = { input_tokens: 1_000_000, output_tokens: 0 }; // US$ 2 no Sonnet 5
    await fs.writeFile(
      main,
      [
        JSON.stringify({ type: 'user', message: { content: 'çãé — acentos para testar o offset em bytes' } }),
        assistant('m1', u),
        assistant('m1', u), // mesma resposta, outro bloco: não conta de novo
        assistant('m2', { input_tokens: 500_000, output_tokens: 0 }, { ts: '2026-09-01T12:00:00.000Z' }),
      ].join('\n') + '\n',
    );
    await fs.writeFile(path.join(proj, 's1', 'subagents', 'agent-x.jsonl'), assistant('m9', u) + '\n');
    await fs.writeFile(path.join(proj, 's1', 'subagents', 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('soma por projeto, sessão (com subagents), agent e dia, sem contar respostas repetidas', async () => {
    const idx = new CostIndex(projectsDir, path.join(root, 'cache.json'));
    await idx.refresh();
    const r = idx.report(new Date('2026-10-26T15:00:00'));

    expect(r.scanning).toBe(false);
    expect(r.total.usd).toBeCloseTo(2 + 1 + 2, 6);
    expect(r.total.today).toBeCloseTo(4, 6); // m1 + subagent hoje; m2 em setembro
    expect(r.total.month).toBeCloseTo(4, 6);
    expect(r.projects['C--www-a']!.sessions['s1']).toBeCloseTo(5, 6);
    expect(r.agents['Explore']).toMatchObject({ runs: 1 });
    expect(r.agents['Explore']!.usd).toBeCloseTo(2, 6);
    expect(r.models['claude-sonnet-5']).toBeCloseTo(5, 6);
  });

  it('lê só o que foi acrescentado e reaproveita o cache em disco', async () => {
    const cache = path.join(root, 'cache2.json');
    const idx = new CostIndex(projectsDir, cache);
    await idx.refresh();

    // Mais um bloco de m2 (com mais saída) e uma resposta nova.
    await fs.appendFile(
      main,
      assistant('m2', { input_tokens: 500_000, output_tokens: 100_000 }, { ts: '2026-09-01T12:00:00.000Z' }) +
        '\n' +
        assistant('m3', { input_tokens: 0, output_tokens: 100_000 }) +
        '\n',
    );
    await idx.refresh();
    const r = idx.report(new Date('2026-10-26T15:00:00'));
    // + US$ 1 (cresceu a saída de m2) + US$ 1 (m3)
    expect(r.total.usd).toBeCloseTo(7, 6);

    const fresh = new CostIndex(projectsDir, cache);
    await fresh.refresh();
    expect(fresh.report().total.usd).toBeCloseTo(7, 6);
  });

  it('dayKey usa a data local', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
