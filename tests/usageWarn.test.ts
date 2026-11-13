import { describe, expect, it } from 'vitest';
import type { AccountUsage, UsageStop } from '../shared/model';
import { UsageWarnings, type UsageWarnInput } from '../server/usageWarn';

// Aviso de consumo antes da linha de parada (10 pontos antes, na conta Claude), uma vez por janela.

const NOW = Date.parse('2026-11-13T12:00:00Z');
const RESET_5H = new Date(NOW + 2 * 3_600_000).toISOString();
const RESET_5H_NEXT = new Date(NOW + 7 * 3_600_000).toISOString();
const RESET_7D = new Date(NOW + 3 * 86_400_000).toISOString();

/** Leitura de agora (ou de `ago` ms atrás) com as janelas dadas. */
function usage(limits: AccountUsage['limits'], ago = 0): AccountUsage {
  return { tapInstalled: true, limits, updatedAt: new Date(NOW - ago).toISOString() };
}

const STOP: UsageStop = { fiveHour: 90, sevenDay: 95 };

function input(over: Partial<UsageWarnInput> & { five?: number | null; fiveReset?: string | null; now?: number } = {}): UsageWarnInput {
  const { five = 85, fiveReset = RESET_5H, ...rest } = over;
  const limits = five === null ? [] : [{ kind: 'five_hour', percentUsed: five, resetsAt: fiveReset }];
  return {
    usage: usage(limits),
    usageStop: STOP,
    projectBudgets: {},
    week: {},
    projectName: (id) => `Projeto ${id}`,
    now: NOW,
    ...rest,
  };
}

describe('UsageWarnings: linha de parada 5h (90, aviso a partir de 80)', () => {
  it('cruza o limiar: avisa uma vez, com a conta Claude e a linha', () => {
    const w = new UsageWarnings();
    const r = w.update(input({ five: 85 }));
    expect(r.fresh).toHaveLength(1);
    expect(r.fresh[0]?.scope).toBe('five_hour');
    expect(r.fresh[0]?.summary).toBe(
      'Consumo da conta Claude em 85% na janela 5h; tarefas novas param em 90%. O Codex tem conta própria e não entra nessa conta.',
    );
  });

  it('segunda leitura acima do limiar: segue na caixa, não avisa de novo', () => {
    const w = new UsageWarnings();
    const first = w.update(input({ five: 85 }));
    const second = w.update(input({ five: 87 }));
    expect(second.fresh).toHaveLength(0);
    expect(second.active).toHaveLength(1);
    expect(second.active[0]?.id).toBe(first.active[0]?.id);
    expect(second.active[0]?.summary).toContain('87%');
  });

  it('cai abaixo do limiar e volta: avisa de novo', () => {
    const w = new UsageWarnings();
    w.update(input({ five: 85 }));
    const down = w.update(input({ five: 70 }));
    expect(down.active).toHaveLength(0);
    const back = w.update(input({ five: 84 }));
    expect(back.fresh).toHaveLength(1);
  });

  it('reset da janela: rearma e avisa de novo (id novo)', () => {
    const w = new UsageWarnings();
    const first = w.update(input({ five: 85 }));
    const next = w.update(input({ five: 82, fiveReset: RESET_5H_NEXT }));
    expect(next.fresh).toHaveLength(1);
    expect(next.active[0]?.id).not.toBe(first.active[0]?.id);
  });

  it('janela que já virou no tempo sai da caixa, mesmo sem leitura nova', () => {
    const w = new UsageWarnings();
    w.update(input({ five: 85 }));
    const later = w.update(input({ five: null, now: NOW + 3 * 3_600_000 }));
    expect(later.active).toHaveLength(0);
  });

  it('passou da linha: sai da caixa (a trava de início já barra)', () => {
    const w = new UsageWarnings();
    w.update(input({ five: 85 }));
    const over = w.update(input({ five: 91 }));
    expect(over.active).toHaveLength(0);
  });
});

describe('UsageWarnings: sem leitura ou sem linha', () => {
  it('sem leitura: nada', () => {
    const w = new UsageWarnings();
    expect(w.update(input({ five: null }))).toEqual({ active: [], fresh: [] });
  });

  it('leitura velha: não avisa', () => {
    const w = new UsageWarnings();
    const r = w.update({ ...input(), usage: usage([{ kind: 'five_hour', percentUsed: 95, resetsAt: RESET_5H }], 60 * 60_000) });
    expect(r).toEqual({ active: [], fresh: [] });
  });

  it('sem updatedAt: nada', () => {
    const w = new UsageWarnings();
    const r = w.update({ ...input(), usage: { tapInstalled: false, limits: [{ kind: 'five_hour', percentUsed: 95, resetsAt: RESET_5H }], updatedAt: null } });
    expect(r.active).toHaveLength(0);
  });

  it('linha de parada desligada: sem aviso', () => {
    const w = new UsageWarnings();
    const r = w.update({ ...input({ five: 99 }), usageStop: { fiveHour: null, sevenDay: 95 } });
    expect(r.active).toHaveLength(0);
  });
});

describe('UsageWarnings: orçamento de projeto (estimativa, a 80%)', () => {
  // Sem 5h e com a linha 7d desligada, para o teste olhar só o projeto.
  const projectInput = (projectCost: number, total: number, sevenPct: number, budget = 50): UsageWarnInput => ({
    usage: usage([{ kind: 'seven_day', percentUsed: sevenPct, resetsAt: RESET_7D }]),
    usageStop: { fiveHour: null, sevenDay: null },
    projectBudgets: { 'p-1': budget },
    week: { 'p-1': { project: projectCost, total } },
    projectName: () => 'Site',
    now: NOW,
  });

  it('a 80% do orçamento avisa, rotulado como estimativa', () => {
    const w = new UsageWarnings();
    // parte do projeto = 40/100 × 100% = 40 (80% de 50)
    const r = w.update(projectInput(40, 100, 100));
    expect(r.fresh).toHaveLength(1);
    expect(r.fresh[0]?.scope).toBe('project_week');
    expect(r.fresh[0]?.summary.startsWith('Estimativa: Site já usou cerca de 40%')).toBe(true);
  });

  it('abaixo de 80% do orçamento: sem aviso', () => {
    const w = new UsageWarnings();
    expect(w.update(projectInput(30, 100, 100)).active).toHaveLength(0);
  });

  it('passou do orçamento: sai da caixa (a trava de início já barra)', () => {
    const w = new UsageWarnings();
    w.update(projectInput(40, 100, 100));
    expect(w.update(projectInput(60, 100, 100)).active).toHaveLength(0);
  });

  it('projeto sem orçamento: sai da caixa', () => {
    const w = new UsageWarnings();
    w.update(projectInput(40, 100, 100));
    const r = w.update({ ...projectInput(40, 100, 100), projectBudgets: {} });
    expect(r.active).toHaveLength(0);
  });
});
