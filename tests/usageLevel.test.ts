import { describe, expect, it } from 'vitest';
import { pacePerDay, paceLevel, usageLevel } from '../client/src/toolbar/Toolbar';

// Semáforo das barras de consumo do header: verde <70%, amarelo <90%, vermelho dali em diante.

describe('usageLevel', () => {
  it('verde abaixo de 70%', () => {
    expect(usageLevel(0)).toBe('low');
    expect(usageLevel(50)).toBe('low');
    expect(usageLevel(69.9)).toBe('low');
  });

  it('amarelo de 70% a 89%', () => {
    expect(usageLevel(70)).toBe('mid');
    expect(usageLevel(89.9)).toBe('mid');
  });

  it('vermelho de 90% em diante', () => {
    expect(usageLevel(90)).toBe('high');
    expect(usageLevel(100)).toBe('high');
  });
});

// Listra da barra de 7d: o que ainda resta da cota por dia que falta para o reset.

const DAY = 86_400_000;

describe('pacePerDay', () => {
  it('divide o que resta pelos dias que faltam', () => {
    expect(pacePerDay(10, 6 * DAY)).toBeCloseTo(15);
    expect(pacePerDay(50, 4 * DAY)).toBeCloseTo(12.5);
    expect(pacePerDay(0, 7 * DAY)).toBeCloseTo(100 / 7);
  });

  it('aceita fração de dia', () => {
    expect(pacePerDay(80, DAY / 2)).toBeCloseTo(40);
  });
});

describe('paceLevel', () => {
  it('branca acima de 14%/dia (sobra)', () => {
    expect(paceLevel(14.1)).toBe('slack');
    expect(paceLevel(40)).toBe('slack');
  });

  it('cinza de 7 a 14%/dia, limites incluídos', () => {
    expect(paceLevel(14)).toBe('even');
    expect(paceLevel(10)).toBe('even');
    expect(paceLevel(7)).toBe('even');
  });

  it('preta abaixo de 7%/dia (apertado)', () => {
    expect(paceLevel(6.9)).toBe('tight');
    expect(paceLevel(0)).toBe('tight');
  });

  it('semana nova sem uso já está na faixa branca', () => {
    expect(paceLevel(pacePerDay(0, 7 * DAY))).toBe('slack');
  });
});
