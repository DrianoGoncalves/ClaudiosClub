import { describe, expect, it } from 'vitest';
import { bareVersion } from '../client/src/format';

describe('bareVersion', () => {
  it('tira o v da tag', () => {
    expect(bareVersion('v0.2.8')).toBe('0.2.8');
    expect(bareVersion('V1.0.0')).toBe('1.0.0');
  });
  it('deixa em paz o que já vem sem v', () => {
    expect(bareVersion('0.2.8')).toBe('0.2.8');
    expect(bareVersion('?')).toBe('?');
  });
});
