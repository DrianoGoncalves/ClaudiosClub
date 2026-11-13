import { describe, expect, it } from 'vitest';
import { TtlCache } from '../server/ttlCache';

describe('TtlCache', () => {
  it('reaproveita dentro do prazo, recarrega depois e separa por chave', async () => {
    let t = 0;
    let n = 0;
    const cache = new TtlCache<number>(5_000, () => t);
    const load = async () => ++n;
    expect(await cache.get('a', load)).toBe(1);
    t = 4_999;
    expect(await cache.get('a', load)).toBe(1);
    expect(await cache.get('b', load)).toBe(2);
    t = 5_000;
    expect(await cache.get('a', load)).toBe(3);
  });

  it('invalidate esquece tudo, inclusive leitura em curso', async () => {
    let n = 0;
    const cache = new TtlCache<number>(5_000, () => 0);
    const load = async () => ++n;
    expect(await cache.get('a', load)).toBe(1);
    cache.invalidate();
    expect(await cache.get('a', load)).toBe(2);
    const slow = cache.get('a', async () => 9); // já em cache (2): não carrega
    expect(await slow).toBe(2);
  });

  it('não guarda falha', async () => {
    const cache = new TtlCache<number>(5_000, () => 0);
    await expect(cache.get('a', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await cache.get('a', async () => 7)).toBe(7);
  });
});
