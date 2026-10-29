import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '../shared/model';
import { quotaBoost } from '../server/quotaBoost';

const now = Date.parse('2026-10-29T12:00:00Z');
const inHours = (h: number) => new Date(now + h * 3600_000).toISOString();
const usage = (week: number, hoursLeft: number, fiveHour = 10, over: Partial<AccountUsage> = {}): AccountUsage => ({
  tapInstalled: true,
  updatedAt: inHours(-0.5),
  limits: [
    { kind: 'five_hour', percentUsed: fiveHour, resetsAt: inHours(3) },
    { kind: 'seven_day', percentUsed: week, resetsAt: inHours(hoursLeft) },
  ],
  ...over,
});

describe('folga de cota', () => {
  it('nas últimas 48h, liga quando no ritmo da semana ia sobrar 30% ou mais', () => {
    expect(quotaBoost(usage(30, 47), now)).toEqual({ until: inHours(47), projected: 42 });
    // Entre as duas faixas fixas: com 45% e 47h, ainda sobra ~37%.
    expect(quotaBoost(usage(45, 47), now)?.projected).toBe(62);
    expect(quotaBoost(usage(60, 20), now)?.projected).toBe(68);
    // Sobraria só ~20%: não compensa.
    expect(quotaBoost(usage(70, 20), now)).toBeNull();
    // Fora da janela: cedo demais para saber se sobra.
    expect(quotaBoost(usage(10, 60), now)).toBeNull();
  });

  it('espera com a janela de 5h cheia e não liga sem leitura confiável', () => {
    expect(quotaBoost(usage(30, 47, 50), now)).toBeNull();
    // A janela de 5h já renovou: a leitura antiga dela não conta.
    const renewed = usage(30, 47, 90);
    renewed.limits[0]!.resetsAt = inHours(-1);
    expect(quotaBoost(renewed, now)).not.toBeNull();
    expect(quotaBoost(usage(30, 47, 10, { updatedAt: inHours(-4) }), now)).toBeNull();
    expect(quotaBoost(usage(30, 47, 10, { updatedAt: null }), now)).toBeNull();
    expect(quotaBoost(usage(30, -1), now)).toBeNull();
    expect(quotaBoost({ tapInstalled: true, updatedAt: inHours(0), limits: [] }, now)).toBeNull();
  });
});
