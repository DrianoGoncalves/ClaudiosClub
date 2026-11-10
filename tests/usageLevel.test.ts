import { describe, expect, it } from 'vitest';
import { usageLevel } from '../client/src/toolbar/Toolbar';

// Semáforo das barras de consumo do header: verde <50%, amarelo <70%, vermelho dali em diante.

describe('usageLevel', () => {
  it('verde abaixo de 50%', () => {
    expect(usageLevel(0)).toBe('low');
    expect(usageLevel(49.9)).toBe('low');
  });

  it('amarelo de 50% a 69%', () => {
    expect(usageLevel(50)).toBe('mid');
    expect(usageLevel(69.9)).toBe('mid');
  });

  it('vermelho de 70% em diante, inclusive acima de 90%', () => {
    expect(usageLevel(70)).toBe('high');
    expect(usageLevel(89)).toBe('high');
    expect(usageLevel(100)).toBe('high');
  });
});
