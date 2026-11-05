import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveSession } from '../shared/model';
import { idleUnseen, showsStatus, withSeen } from '../client/src/board/unread';

const live = (status: LiveSession['status'], statusUpdatedAt: string | null = '2026-11-04T10:00:00.000Z', alive = true): LiveSession => ({
  sessionId: 's1', pid: 1, cwd: null, name: null, status, alive, entrypoint: 'sdk-cli', kind: null, startedAt: null, statusUpdatedAt,
});

describe('bolinha de ocioso como "não lido"', () => {
  it('acende quando a conversa parou e você ainda não a viu', () => {
    expect(idleUnseen({}, live('idle'))).toBe(true);
    expect(idleUnseen({ s1: '2026-11-04T10:00:00.000Z' }, live('idle'))).toBe(false);
    // Terminou de novo (outro statusUpdatedAt): volta a acender.
    expect(idleUnseen({ s1: '2026-11-04T10:00:00.000Z' }, live('idle', '2026-11-04T10:30:00.000Z'))).toBe(true);
    // Sem data: vista uma vez, fica vista.
    expect(idleUnseen({ s1: '' }, live('idle', null))).toBe(false);
    expect(idleUnseen({}, live('idle', '2026-11-04T10:00:00.000Z', false))).toBe(false);
  });

  it('não mexe nos outros estados', () => {
    const seen = { s1: '2026-11-04T10:00:00.000Z' };
    expect(showsStatus(seen, live('busy'))).toBe(true);
    expect(showsStatus(seen, live('waiting'))).toBe(true);
    expect(showsStatus(seen, live(null))).toBe(true);
    expect(showsStatus(seen, live('idle'))).toBe(false);
    expect(showsStatus({}, live('idle'))).toBe(true);
  });

  it('guarda a última vista no fim e solta as mais antigas', () => {
    const a = withSeen({ x: '1', y: '2' }, 'x', '3');
    expect(Object.entries(a)).toEqual([['y', '2'], ['x', '3']]);
    expect(Object.keys(withSeen(a, 'z', '4', 2))).toEqual(['x', 'z']);
  });
});

describe('primeira vez no navegador', () => {
  // Cada teste lê o armazenamento de novo, como uma página que acabou de abrir.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  const storage = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
  };

  it('conta como visto quem já está parado; os próximos términos acendem', async () => {
    const ls = storage();
    vi.stubGlobal('localStorage', ls);
    const m = await import('../client/src/board/unread');
    m.seedSeenIdle([live('idle'), { ...live('busy'), sessionId: 's2' }]);
    expect(JSON.parse(ls.data.get('myco.seenIdle')!)).toEqual({ s1: '2026-11-04T10:00:00.000Z' });
    // Já guardado: não semeia de novo (a parada nova de s1 segue acesa).
    m.seedSeenIdle([live('idle', '2026-11-04T11:00:00.000Z')]);
    expect(JSON.parse(ls.data.get('myco.seenIdle')!)).toEqual({ s1: '2026-11-04T10:00:00.000Z' });
  });

  it('com algo guardado, não semeia', async () => {
    const ls = storage({ 'myco.seenIdle': '{}' });
    vi.stubGlobal('localStorage', ls);
    const m = await import('../client/src/board/unread');
    m.seedSeenIdle([live('idle')]);
    expect(ls.data.get('myco.seenIdle')).toBe('{}');
  });
});
