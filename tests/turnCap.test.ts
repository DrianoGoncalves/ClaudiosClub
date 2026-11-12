import { describe, expect, it } from 'vitest';
import { normalizeTurnMinutes, normalizeTurnTools } from '../client/src/toolbar/turnCap';

describe('normalizeTurnTools', () => {
  it('inteiro de 0 (desligado) a 100000', () => {
    expect(normalizeTurnTools('0')).toBe(0);
    expect(normalizeTurnTools('500')).toBe(500);
    expect(normalizeTurnTools('12.6')).toBe(13);
    expect(normalizeTurnTools('-7')).toBe(0);
    expect(normalizeTurnTools('100000')).toBe(100000);
    expect(normalizeTurnTools('999999')).toBe(100000);
  });
  it('vazio ou lixo devolve null (o campo volta ao valor salvo)', () => {
    expect(normalizeTurnTools('')).toBeNull();
    expect(normalizeTurnTools('  ')).toBeNull();
    expect(normalizeTurnTools('muitas')).toBeNull();
  });
});

describe('normalizeTurnMinutes', () => {
  it('inteiro de 0 (desligado) a 1440', () => {
    expect(normalizeTurnMinutes('0')).toBe(0);
    expect(normalizeTurnMinutes('180')).toBe(180);
    expect(normalizeTurnMinutes('1440')).toBe(1440);
    expect(normalizeTurnMinutes('2000')).toBe(1440);
    expect(normalizeTurnMinutes('-1')).toBe(0);
  });
  it('vazio ou lixo devolve null', () => {
    expect(normalizeTurnMinutes('')).toBeNull();
    expect(normalizeTurnMinutes('abc')).toBeNull();
  });
});
