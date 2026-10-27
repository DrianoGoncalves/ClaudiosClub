import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileCost } from '../server/adapters/claude/costs';
import { buildOrchestration, readMarks, saveMark } from '../server/orchestration';

const tokens = (input: number, output: number) => ({ input, output, write: 0, write1h: 0, read: 0 });

// Opus 5.5: 4/20 por milhão; Haiku 5.5: 0,1/0,5.
const main: FileCost = {
  file: 'C:/x/s1.jsonl',
  usd: 4 + 20,
  byModel: { 'claude-opus-5-5': 24 },
  tokens: { 'claude-opus-5-5': tokens(1_000_000, 1_000_000) },
};
const run = (id: string, inM: number, outM: number): FileCost => ({
  file: `C:/x/s1/subagents/${id}.jsonl`,
  agentType: 'executor',
  usd: inM * 0.1 + outM * 0.5,
  byModel: { 'claude-haiku-5-5': inM * 0.1 + outM * 0.5 },
  tokens: { 'claude-haiku-5-5': tokens(inM * 1_000_000, outM * 1_000_000) },
});

describe('valeu a pena?', () => {
  it('separa planejador e executores e estima a economia contra tudo no modelo do planejador', () => {
    // Executor: 2M de entrada e 1M de saída no Haiku = 0,7; no Opus seria 8 + 20 = 28.
    const r = buildOrchestration('s1', [main, run('agent-a', 2, 1)], {}, false);
    expect(r.plannerModel).toBe('claude-opus-5-5');
    expect(r.plannerShare).toBeCloseTo(24 / 24.7);
    expect(r.executorShare).toBeCloseTo(0.7 / 24.7);
    expect(r.savings).toBeCloseTo(1 - 24.7 / (24 + 28));
    expect(r.runs[0]).toMatchObject({ id: 'agent-a', model: 'claude-haiku-5-5', mark: null });
    expect(r.runs[0]!.extraIfPlanner).toBeCloseTo(28 / 0.7 - 1);
  });

  it('o descartado entra como desperdício; sem subagents não há economia', () => {
    const r = buildOrchestration('s1', [main, run('agent-a', 2, 1), run('agent-b', 1, 1)], { 'agent-b': 'discarded' }, false);
    expect(r.wasteShare).toBeCloseTo(0.6 / 25.3);
    expect(r.runs.find((x) => x.id === 'agent-b')?.mark).toBe('discarded');
    expect(buildOrchestration('s1', [main], {}, false).savings).toBeNull();
  });

  it('guarda e tira marcas por sessão', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'myco-marks-')), 'marks.json');
    await saveMark('s1', 'agent-a', 'used', file);
    await saveMark('s1', 'agent-b', 'partial', file);
    expect(await readMarks('s1', file)).toEqual({ 'agent-a': 'used', 'agent-b': 'partial' });
    await saveMark('s1', 'agent-a', null, file);
    expect(await readMarks('s1', file)).toEqual({ 'agent-b': 'partial' });
    expect(await readMarks('outra', file)).toEqual({});
  });
});
