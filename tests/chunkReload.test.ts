import { describe, expect, it } from 'vitest';
import { mayReload, RELOAD_GUARD_MS } from '../client/src/chunkReload';

describe('mayReload', () => {
  it('recarrega na primeira falha da sessão', () => {
    expect(mayReload(null, 1_000)).toBe(true);
  });

  it('não recarrega de novo dentro do prazo (evita laço)', () => {
    expect(mayReload(1_000, 1_000 + RELOAD_GUARD_MS - 1)).toBe(false);
  });

  it('volta a recarregar passado o prazo', () => {
    expect(mayReload(1_000, 1_000 + RELOAD_GUARD_MS)).toBe(true);
  });

  it('relógio que voltou no tempo não libera o recarregamento', () => {
    expect(mayReload(5_000, 1_000)).toBe(false);
  });
});
