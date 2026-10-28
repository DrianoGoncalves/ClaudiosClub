import { describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { byHierarchy } from '../client/src/tasks/TasksBoard';

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
