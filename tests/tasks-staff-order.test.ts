import { describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { byHierarchy, byQueue, byRecent } from '../client/src/tasks/TasksBoard';

const p = (id: string, name: string, role: string, reportsTo: string[] = []) => ({ id, name, role, reportsTo }) as StaffProfile;

describe('byHierarchy (quem cuida, na nova tarefa)', () => {
  it('orquestrador primeiro, depois por nível e nome', () => {
    const staff = [
      p('c', 'Carla', 'Executor(a)', ['b']),
      p('b', 'Bruno', 'Back-end', ['d']),
      p('a', 'Ana', 'QA'),
      p('d', 'Daniel', 'Orquestrador(a)'),
    ];
    expect(byHierarchy(staff).map((s) => s.id)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('não trava com ciclo de gestores', () => {
    const staff = [p('x', 'X', 'Dev', ['y']), p('y', 'Y', 'Dev', ['x'])];
    expect(byHierarchy(staff)).toHaveLength(2);
  });
});

describe('byRecent (ordem do cartão na coluna)', () => {
  const k = (id: string, status: 'todo' | 'planning' | 'doing' | 'done', updatedAt: string) => ({ id, status, updatedAt });

  it('última atualização no topo', () => {
    const col = [k('a', 'todo', '2026-11-01T10:00:00Z'), k('b', 'todo', '2026-11-05T10:00:00Z'), k('c', 'todo', '2026-11-03T10:00:00Z')];
    expect(byRecent(col).map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('plano para aprovar fica antes, mesmo mais antigo; o resto por data', () => {
    const col = [k('a', 'doing', '2026-11-05T10:00:00Z'), k('p', 'planning', '2026-11-01T10:00:00Z'), k('b', 'doing', '2026-11-04T10:00:00Z')];
    expect(byRecent(col).map((x) => x.id)).toEqual(['p', 'a', 'b']);
  });

  it('Pronto por data; empate mantém a ordem e a lista original não muda', () => {
    const col = [k('d', 'done', '2026-11-02T10:00:00Z'), k('l', 'done', '2026-11-04T10:00:00Z'), k('e', 'done', '2026-11-02T10:00:00Z')];
    expect(byRecent(col).map((x) => x.id)).toEqual(['l', 'd', 'e']);
    expect(col.map((x) => x.id)).toEqual(['d', 'l', 'e']);
  });
});

describe('byQueue (A fazer: a próxima no topo)', () => {
  // `queuePos` é do servidor (1 = a próxima do funcionário); sem ele o cartão está fora da fila.
  const q = (id: string, queuePos?: number, updatedAt = '2026-11-01T10:00:00Z') => ({
    id,
    status: 'todo' as const,
    queuePos,
    updatedAt,
  });

  it('fila antes das soltas; soltas por última atualização', () => {
    const col = [q('s1', undefined, '2026-11-02T10:00:00Z'), q('f1', 1), q('s2', undefined, '2026-11-05T10:00:00Z')];
    expect(byQueue(col).map((x) => x.id)).toEqual(['f1', 's2', 's1']);
  });

  it('a 1ª de cada funcionário antes das 2ªs, na ordem do servidor', () => {
    const col = [q('a1', 1), q('a2', 2), q('b1', 1)];
    expect(byQueue(col).map((x) => x.id)).toEqual(['a1', 'b1', 'a2']);
  });

  it('a posição do servidor manda, não a ordem em que a lista chegou (fila reordenada)', () => {
    const col = [q('a1', 2), q('a2', 3), q('a3', 1)];
    expect(byQueue(col).map((x) => x.id)).toEqual(['a3', 'a1', 'a2']);
  });
});