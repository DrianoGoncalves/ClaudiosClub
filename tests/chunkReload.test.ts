import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, mayReload, reloadOnce, RELOAD_GUARD_MS } from '../client/src/chunkReload';

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

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: http://x/assets/Tasks-abc.js',
    'error loading dynamically imported module: http://x/assets/Tasks-abc.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/Tasks-abc.css',
  ])('reconhece falha de carga de pedaço: %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('reconhece ChunkLoadError pelo nome', () => {
    const error = new Error('x');
    error.name = 'ChunkLoadError';
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    new TypeError("Cannot read properties of undefined (reading 'map')"),
    new Error('Objects are not valid as a React child'),
    'algo quebrou',
    null,
    undefined,
  ])('erro de render não é de carga: %s', (error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('reloadOnce', () => {
  let store: Map<string, string>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new Map();
    reload = vi.fn();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('window', { location: { reload } });
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recarrega na primeira falha e não entra em laço na segunda seguida', () => {
    expect(reloadOnce()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnce()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('volta a recarregar depois do prazo', () => {
    expect(reloadOnce()).toBe(true);
    vi.setSystemTime(1_000_000 + RELOAD_GUARD_MS);
    expect(reloadOnce()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('sem sessionStorage não recarrega (não há como vigiar o laço)', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('bloqueado');
      },
    });
    expect(reloadOnce()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
