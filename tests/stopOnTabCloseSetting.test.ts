import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toolbar from '../client/src/i18n/toolbar';
import { startPresence } from '../client/src/presence';
import { PresenceBody } from '../server/tabPresence';

// Opção "Parar ao fechar a aba" (config `stopOnTabClose`): textos nos 3 idiomas e o sinal de presença que a tela manda ao servidor.
describe('opção Parar ao fechar a aba (tela)', () => {
  const langs = ['pt-BR', 'en', 'es'] as const;

  it('título, descrição e palavras de busca nos 3 idiomas, e a descrição avisa da carência e do F5', () => {
    for (const lang of langs) {
      for (const key of ['toolbar.stopOnTabCloseTitle', 'toolbar.stopOnTabCloseDesc', 'toolbar.stopOnTabCloseKeywords'] as const) {
        expect((toolbar[lang] as Record<string, string>)[key]?.trim(), `${lang} ${key}`).toBeTruthy();
      }
      const desc = (toolbar[lang] as Record<string, string>)['toolbar.stopOnTabCloseDesc'] ?? '';
      expect(desc, lang).toMatch(/30/);
      expect(desc, lang).toMatch(/F5/);
    }
  });
});

describe('sinal de presença da aba', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const listeners = new Map<string, Array<(e: unknown) => void>>();

  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
    listeners.clear();
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}'));
    });
    vi.stubGlobal('window', {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: number) => clearInterval(id),
      addEventListener: (name: string, fn: (e: unknown) => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
      removeEventListener: (name: string, fn: (e: unknown) => void) => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn)),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const bodies = () => calls.map((c) => JSON.parse(String(c.init.body)) as { tab: string; leaving?: boolean });

  it('dá sinal ao abrir e a cada 15 s, com o cabeçalho x-myco e um id que o servidor aceita', () => {
    const stop = startPresence();
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe('/api/presence');
      expect(c.init.method).toBe('POST');
      expect((c.init.headers as Record<string, string>)['x-myco']).toBe('1');
    }
    for (const b of bodies()) expect(PresenceBody.safeParse(b).success).toBe(true);
    expect(new Set(bodies().map((b) => b.tab)).size).toBe(1);
    stop();
  });

  it('ao sair (pagehide) avisa com leaving e, depois de parar, não dá mais sinal', () => {
    const stop = startPresence();
    listeners.get('pagehide')?.forEach((fn) => fn({}));
    expect(bodies().at(-1)).toMatchObject({ leaving: true });
    expect(PresenceBody.safeParse(bodies().at(-1)).success).toBe(true);
    stop();
    const n = calls.length;
    vi.advanceTimersByTime(60_000);
    expect(calls).toHaveLength(n);
    expect(listeners.get('pagehide')).toHaveLength(0);
  });

  it('cada carga da página tem o seu id (F5 e aba duplicada nunca dividem o mesmo)', () => {
    const a = startPresence();
    const b = startPresence();
    expect(bodies()[0]?.tab).not.toBe(bodies()[1]?.tab);
    a();
    b();
  });
});
