import { describe, expect, it } from 'vitest';
import { paceLevel, usageLevel, weekPace } from '../client/src/toolbar/Toolbar';

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

// Listra da barra de 7d: o que ainda resta da cota por dia que falta para o reset (nas últimas 24h, o total até reiniciar).

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('weekPace', () => {
  it('divide o que resta pelos dias que faltam, com uma casa decimal', () => {
    expect(weekPace(10, 6 * DAY)).toEqual({ value: 15, perDay: true, level: 'slack' });
    expect(weekPace(50, 4 * DAY)).toEqual({ value: 12.5, perDay: true, level: 'even' });
    expect(weekPace(0, 7 * DAY)).toEqual({ value: 14.3, perDay: true, level: 'slack' });
  });

  it('a cor sai do mesmo número da tela: 14,2 e 13,96 não ficam com cores diferentes sob o mesmo "14"', () => {
    // 3% usado com 6d19h: 14,25 → 14,3 (no ritmo exato, verde)
    expect(weekPace(3, 6 * DAY + 19 * HOUR)).toMatchObject({ value: 14.3, level: 'slack' });
    // 4% usado: 14,1 (amarela)
    expect(weekPace(4, 6 * DAY + 19 * HOUR)).toMatchObject({ value: 14.1, level: 'even' });
    // 5% usado: 13,96 → 14,0 (amarela)
    expect(weekPace(5, 6 * DAY + 19 * HOUR)).toMatchObject({ value: 14, level: 'even' });
  });

  it('nas últimas 24h mostra o total até reiniciar, e a cor vem do ritmo real', () => {
    // 76% usado e 3h: restam 24% até reiniciar (192%/dia: verde)
    expect(weekPace(76, 3 * HOUR)).toEqual({ value: 24, perDay: false, level: 'slack' });
    // 94% usado e 12h: restam 6%, ritmo real 12%/dia (amarela, não vermelha)
    expect(weekPace(94, 12 * HOUR)).toEqual({ value: 6, perDay: false, level: 'even' });
    // 99% usado e 12h: 2%/dia (vermelha)
    expect(weekPace(99, 12 * HOUR)).toEqual({ value: 1, perDay: false, level: 'tight' });
  });

  it('com exatamente 1 dia ainda é por dia', () => {
    expect(weekPace(76, DAY)).toEqual({ value: 24, perDay: true, level: 'slack' });
  });

  it('cota estourada não dá ritmo negativo', () => {
    expect(weekPace(100, 2 * DAY)).toEqual({ value: 0, perDay: true, level: 'tight' });
  });
});

describe('paceLevel', () => {
  it('verde do ritmo exato (14,3%/dia) para cima', () => {
    expect(paceLevel(14.3)).toBe('slack');
    expect(paceLevel(40)).toBe('slack');
  });

  it('amarela de 7 até abaixo do ritmo exato', () => {
    expect(paceLevel(14.2)).toBe('even');
    expect(paceLevel(10)).toBe('even');
    expect(paceLevel(7)).toBe('even');
  });

  it('vermelha abaixo de 7%/dia', () => {
    expect(paceLevel(6.9)).toBe('tight');
    expect(paceLevel(0)).toBe('tight');
  });
});
