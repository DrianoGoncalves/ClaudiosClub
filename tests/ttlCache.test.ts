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

  it('a validade conta do fim da leitura, e leitura em curso é dividida mesmo passando do prazo', async () => {
    let t = 0;
    let n = 0;
    const cache = new TtlCache<number>(5_000, () => t);
    const slow = async () => {
      n++;
      t += 4_000; // a leitura leva 4 s
      return n;
    };
    expect(await cache.get('a', slow)).toBe(1); // termina em t=4000
    t = 8_999; // 4999 ms depois do fim da leitura (8999 desde que começou): ainda vale
    expect(await cache.get('a', slow)).toBe(1);
    t = 9_000;
    expect(await cache.get('a', slow)).toBe(2);

    let finish!: () => void;
    const pending = cache.get('b', () => new Promise<number>((r) => (finish = () => r(7))));
    t += 60_000; // muito além do prazo, e a leitura ainda não acabou: quem chega divide a mesma
    const again = cache.get('b', async () => 99);
    finish();
    expect(await pending).toBe(7);
    expect(await again).toBe(7);
  });

  it('não guarda falha', async () => {
    const cache = new TtlCache<number>(5_000, () => 0);
    await expect(cache.get('a', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await cache.get('a', async () => 7)).toBe(7);
  });
});
