import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileCost, TranscriptCost } from '../server/adapters/claude/costs';
import { buildOrchestration, buildSavings, readAllMarks, readMarks, saveMark, savingsSince } from '../server/orchestration';

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

describe('ranking de economia', () => {
  // Gasto tudo dentro do período, a não ser que `periodUsd` diga outra coisa.
  const t = (f: FileCost, sessionId = 's1', periodUsd = f.usd): TranscriptCost => ({ ...f, projectId: 'p1', sessionId, periodUsd });

  it('sessão sem subagents: asPlannerUsd é o próprio gasto', () => {
    const r = buildSavings([t(main)], {}, null, false);
    expect(r).toMatchObject({ since: null, scanning: false });
    expect(r.sessions).toEqual([
      { projectId: 'p1', sessionId: 's1', usd: 24, executorUsd: 0, asPlannerUsd: 24, discardedUsd: 0, runs: 0 },
    ]);
  });

  it('subagent em modelo mais barato: custaria mais no modelo do planejador', () => {
    // Executor: 0,7 no Haiku; no Opus seria 28.
    const [s] = buildSavings([t(main), t(run('agent-a', 2, 1))], {}, null, true).sessions;
    expect(s).toMatchObject({ usd: 24.7, runs: 1 });
    expect(s!.executorUsd).toBeCloseTo(0.7);
    expect(s!.asPlannerUsd).toBeCloseTo(24 + 28);
    expect(s!.asPlannerUsd!).toBeGreaterThan(s!.usd);
  });

  it('período: só o gasto de dentro conta, e os tokens entram na proporção do gasto', () => {
    // Metade do gasto do principal e 1/4 do executor no período.
    const files = [t(main, 's1', 12), t(run('agent-a', 2, 1), 's1', 0.175)];
    const [s] = buildSavings(files, {}, '2026-08-01', false).sessions;
    expect(s!.usd).toBeCloseTo(12.175);
    expect(s!.executorUsd).toBeCloseTo(0.175);
    expect(s!.asPlannerUsd).toBeCloseTo(12 + 28 / 4);
  });

  it('subagent sem gasto no período não conta como execução', () => {
    const [s] = buildSavings([t(main), t(run('agent-a', 2, 1), 's1', 0)], {}, '2026-08-01', false).sessions;
    expect(s).toMatchObject({ usd: 24, executorUsd: 0, asPlannerUsd: 24, runs: 0 });
  });

  it('o descartado entra em discardedUsd, só na sessão da marca', () => {
    const files = [t(main), t(run('agent-a', 2, 1)), t(run('agent-b', 1, 1)), t(main, 's2')];
    const r = buildSavings(files, { s1: { 'agent-b': 'discarded', 'agent-a': 'used' } }, null, false);
    expect(r.sessions.find((x) => x.sessionId === 's1')!.discardedUsd).toBeCloseTo(0.6);
    expect(r.sessions.find((x) => x.sessionId === 's2')!.discardedUsd).toBe(0);
  });

  it('sem preço para o modelo: asPlannerUsd é null, mas o resto fica', () => {
    const semModelo = { ...main, byModel: {} };
    const [a] = buildSavings([t(semModelo), t(run('agent-a', 2, 1))], {}, null, false).sessions;
    expect(a).toMatchObject({ asPlannerUsd: null, runs: 1 });
    expect(a!.usd).toBeCloseTo(24.7);
    const desconhecido = { ...main, byModel: { 'modelo-sem-preco': 24 } };
    expect(buildSavings([t(desconhecido), t(run('agent-a', 2, 1))], {}, null, false).sessions[0]!.asPlannerUsd).toBeNull();
    // Sem subagents não precisa de preço.
    expect(buildSavings([t(semModelo)], {}, null, false).sessions[0]!.asPlannerUsd).toBe(24);
  });

  it('modelo sem preço num subagent: o contrafactual cobra só a parte com preço', () => {
    // Haiku: 2M de entrada e 1M de saída = 0,7 (no Opus, 28); o modelo sem preço não entra no custo real nem no contrafactual.
    const misto: FileCost = {
      ...run('agent-a', 2, 1),
      tokens: { 'claude-haiku-5-5': tokens(2_000_000, 1_000_000), 'modelo-sem-preco': tokens(5_000_000, 5_000_000) },
    };
    const [s] = buildSavings([t(main), t(misto)], {}, null, false).sessions;
    expect(s!.usd).toBeCloseTo(24.7);
    expect(s!.asPlannerUsd).toBeCloseTo(24 + 28);
    // O painel "Valeu a pena?" concorda: mesma conta.
    const r = buildOrchestration('s1', [main, misto], {}, false);
    expect(r.savings).toBeCloseTo(1 - 24.7 / (24 + 28));
    expect(r.runs[0]!.extraIfPlanner).toBeCloseTo(28 / 0.7 - 1);
  });

  it('sessão sem gasto no período fica de fora', () => {
    const r = buildSavings([t(main, 's1', 0), t(run('agent-a', 1, 1), 's1', 0), t(main, 's2', 5)], {}, '2026-08-01', false);
    expect(r.sessions.map((x) => x.sessionId)).toEqual(['s2']);
    expect(r.since).toBe('2026-08-01');
  });

  it('lê as marcas de todas as sessões de uma vez', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'myco-marks-')), 'marks.json');
    expect(await readAllMarks(file)).toEqual({});
    await saveMark('s1', 'agent-a', 'used', file);
    await saveMark('s2', 'agent-b', 'discarded', file);
    expect(await readAllMarks(file)).toEqual({ s1: { 'agent-a': 'used' }, s2: { 'agent-b': 'discarded' } });
  });

  it('o início do período conta hoje como o 1º dia', () => {
    const now = new Date(2026, 9, 31, 15, 0);
    expect(savingsSince(null, now)).toBeNull();
    expect(savingsSince(1, now)).toBe('2026-10-31');
    expect(savingsSince(7, now)).toBe('2026-10-25');
    expect(savingsSince(90, now)).toBe('2026-08-03');
  });
});
