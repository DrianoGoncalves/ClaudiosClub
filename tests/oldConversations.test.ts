import { describe, expect, it } from 'vitest';
import { leftOutByRetention } from '../client/src/detail/oldConversations';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const sessions = [
  { id: 'velha', startedAt: daysAgo(40) },
  { id: 'meio', startedAt: daysAgo(20) },
  { id: 'recente', startedAt: daysAgo(2) },
  { id: 'ultima', startedAt: daysAgo(1) },
];

describe('leftOutByRetention', () => {
  it('fica de fora a que o quadro não lista e começou antes do prazo', () => {
    const listed = new Set(['recente', 'ultima']);
    expect([...leftOutByRetention(sessions, listed, 7, NOW)].sort()).toEqual(['meio', 'velha']);
  });
  it('a que o quadro lista nunca sai, mesmo velha (ao vivo, de tarefa aberta)', () => {
    const listed = new Set(['velha', 'recente', 'ultima']);
    expect([...leftOutByRetention(sessions, listed, 7, NOW)]).toEqual(['meio']);
  });
  it('a que ainda não gravou nada (fora do quadro) mas começou há pouco fica', () => {
    expect([...leftOutByRetention(sessions, new Set(), 7, NOW)].sort()).toEqual(['meio', 'velha']);
  });
  it('a última da ficha nunca sai, como no servidor', () => {
    const only = [{ id: 'unica', startedAt: daysAgo(90) }];
    expect(leftOutByRetention(only, new Set(), 7, NOW).size).toBe(0);
  });
  it('sem prazo (0), nada sai', () => {
    expect(leftOutByRetention(sessions, new Set(), 0, NOW).size).toBe(0);
  });
  it('data ilegível não esconde a conversa', () => {
    const bad = [{ id: 'a', startedAt: 'ontem' }, { id: 'b', startedAt: daysAgo(1) }];
    expect(leftOutByRetention(bad, new Set(), 7, NOW).size).toBe(0);
  });
});
