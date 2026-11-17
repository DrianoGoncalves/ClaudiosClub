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
  it('nas últimas 72h, liga quando no ritmo da semana ia sobrar o bastante para o tempo que falta', () => {
    expect(quotaBoost(usage(30, 47), now)).toEqual({ until: inHours(47), projected: 42 });
    // Com 45% e 47h, ainda sobra ~37% (a exigência é ~19,6%).
    expect(quotaBoost(usage(45, 47), now)?.projected).toBe(62);
    expect(quotaBoost(usage(60, 20), now)?.projected).toBe(68);
    // Com 20h a exigência está no piso de 10%: sobrar ~20% já compensa.
    expect(quotaBoost(usage(70, 20), now)?.projected).toBe(79);
    // Sobraria só ~3%: não compensa.
    expect(quotaBoost(usage(85, 20), now)).toBeNull();
    // Fora da janela: cedo demais para saber se sobra.
    expect(quotaBoost(usage(10, 80), now)).toBeNull();
  });

  it('a janela é de 72h: liga com ~70h, na borda de 72h, e não liga com ~73h', () => {
    // Com 60h restantes (antes fora, quando a janela era de 48h) agora liga.
    expect(quotaBoost(usage(10, 60), now)).toEqual({ until: inHours(60), projected: 16 });
    expect(quotaBoost(usage(30, 70), now)).toEqual({ until: inHours(70), projected: 51 });
    // A borda é inclusiva: faltando exatamente 72h ainda vale.
    expect(quotaBoost(usage(30, 72), now)).not.toBeNull();
    expect(quotaBoost(usage(30, 73), now)).toBeNull();
    // Dentro da janela a projeção continua mandando: no ritmo, estouraria a cota.
    expect(quotaBoost(usage(70, 70), now)).toBeNull();
  });

  it('a sobra exigida é proporcional às horas restantes: 30% em 72h, 20% em 48h, piso de 10% em 24h ou menos', () => {
    // Faltando 72h: exige 30% (projeção de até 70%). Com 39% a projeção é 68,25%; com 41%, 71,75%.
    expect(quotaBoost(usage(39, 72), now)).not.toBeNull();
    expect(quotaBoost(usage(41, 72), now)).toBeNull();
    // Faltando 60h: exige 25%. Com 48% sobra ~25,3%; com 49%, ~23,8%.
    expect(quotaBoost(usage(48, 60), now)).not.toBeNull();
    expect(quotaBoost(usage(49, 60), now)).toBeNull();
    // Faltando 48h: exige 20%. Com 57% sobra 20,2%; com 58%, 18,8%.
    expect(quotaBoost(usage(57, 48), now)).not.toBeNull();
    expect(quotaBoost(usage(58, 48), now)).toBeNull();
    // Faltando 36h: exige 15%. Com 65% sobra ~17,3%; com 70%, ~10,9%.
    expect(quotaBoost(usage(65, 36), now)).not.toBeNull();
    expect(quotaBoost(usage(70, 36), now)).toBeNull();
    // Faltando 24h: a fórmula dá 10%, o piso. 75% usado projeta 87,5%: sobra 12,5% e liga; 80%, ~6,7%: não.
    expect(quotaBoost(usage(75, 24), now)).not.toBeNull();
    expect(quotaBoost(usage(80, 24), now)).toBeNull();
    // Abaixo de 24h a fórmula daria menos que 10%, mas o piso segura: faltando 12h, 83% sobra ~10,6%; 85%, ~8,5%.
    expect(quotaBoost(usage(83, 12), now)).not.toBeNull();
    expect(quotaBoost(usage(85, 12), now)).toBeNull();
    // Mesmo uso (60%): faltando 48h projeta 84% e não chega à exigência de 20%; faltando 24h projeta 70% e liga.
    expect(quotaBoost(usage(60, 48), now)).toBeNull();
    expect(quotaBoost(usage(60, 24), now)).not.toBeNull();
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
