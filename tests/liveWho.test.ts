import { describe, expect, it } from 'vitest';
import type { LiveSession, StaffProfile } from '../shared/model';
import { liveLines } from '../client/src/board/liveWho';
import { liveTitle } from '../client/src/board/nodes';

function live(sessionId: string, name: string | null, status: LiveSession['status'], pid = 1): LiveSession {
  return { sessionId, pid, cwd: 'C:\\www\\a', name, status, alive: true, entrypoint: null, kind: null, startedAt: null, statusUpdatedAt: null };
}

function staff(id: string, name: string, sessions: string[]): StaffProfile {
  return { id, name, sessions: sessions.map((s) => ({ id: s, startedAt: '' })) } as StaffProfile;
}

describe('liveLines (hover do "ao vivo")', () => {
  it('junta as conversas do mesmo funcionário numa linha, com o status mais ativo', () => {
    const lines = liveLines(
      [live('s1', 'Ana', 'idle', 1), live('s2', 'Ana', 'busy', 2), live('s3', 'Bia', 'idle', 3)],
      [staff('ana', 'Ana', ['s1', 's2']), staff('bia', 'Bia', ['s3'])],
    );
    expect(lines).toEqual([
      { name: 'Ana', status: 'busy', conversations: 2 },
      { name: 'Bia', status: 'idle', conversations: 1 },
    ]);
  });

  it('trabalhando vence esperando, que vence parado, em qualquer ordem', () => {
    const st = [staff('ana', 'Ana', ['s1', 's2', 's3'])];
    const statuses = (order: LiveSession['status'][]) =>
      liveLines(order.map((status, i) => live(`s${i + 1}`, 'Ana', status, i + 1)), st)[0]!.status;
    expect(statuses(['idle', 'waiting', 'busy'])).toBe('busy');
    expect(statuses(['busy', 'waiting', 'idle'])).toBe('busy');
    expect(statuses(['idle', 'waiting', 'idle'])).toBe('waiting');
  });

  it('conversa que ainda não está na ficha cai no funcionário pelo nome', () => {
    const lines = liveLines([live('s1', 'Ana', 'idle', 1), live('novo', 'Ana', 'busy', 2)], [staff('ana', 'Ana', ['s1'])]);
    expect(lines).toEqual([{ name: 'Ana', status: 'busy', conversations: 2 }]);
  });

  it('o mesmo sessionId em dois processos vivos conta uma conversa só', () => {
    const lines = liveLines([live('s1', 'Ana', 'idle', 1), live('s1', 'Ana', 'busy', 2)], [staff('ana', 'Ana', ['s1'])]);
    expect(lines).toEqual([{ name: 'Ana', status: 'busy', conversations: 1 }]);
  });

  it('conversa sem ficha segue uma linha por conversa (nome ou começo do id)', () => {
    const lines = liveLines([live('abcdef123456', null, 'idle', 1), live('zzzzzz999999', null, 'busy', 2), live('s3', 'Solta', 'idle', 3)], []);
    expect(lines.map((l) => l.name)).toEqual(['abcdef12', 'zzzzzz99', 'Solta']);
  });

  it('o título do hover não repete o funcionário e avisa quando há mais de uma conversa', () => {
    const title = liveTitle(
      liveLines([live('s1', 'Ana', 'idle', 1), live('s2', 'Ana', 'busy', 2), live('s3', 'Bia', 'idle', 3)], [staff('ana', 'Ana', ['s1', 's2']), staff('bia', 'Bia', ['s3'])]),
    );
    const rows = title.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^Ana: .+ \(.*2.*\)$/);
    expect(rows[1]).toMatch(/^Bia: [^()]+$/);
    expect(title.match(/Ana/g)).toHaveLength(1);
  });
});
