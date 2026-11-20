import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// O seletor de funcionário filtra todas as colunas: fica entre o bloco de revisão e as colunas, não no cabeçalho de uma coluna.

const task = (id: string, status: Task['status'], staffId: string): Task =>
  ({ id, title: `Tarefa ${id}`, description: 'x', status, staffId, sessionId: null, plan: null, branch: null, pr: null, history: [], createdAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:00:00.000Z' }) as Task;
const person = (id: string, name: string) => ({ id, name, role: 'Back-end', reportsTo: [], servers: [] }) as unknown as StaffProfile;

const render = (tasks: Task[]) =>
  renderToStaticMarkup(
    createElement(TasksBoard, {
      projectId: 'p',
      projectName: 'Projeto',
      staff: [person('ana-1', 'Ana'), person('bia-2', 'Bia'), person('cris-3', 'Cris')],
      costs: null,
      onClose: () => {},
      onOpenStaff: () => {},
      onChanged: () => {},
      initialTasks: tasks,
    }),
  );

describe('seletor de funcionário do quadro', () => {
  const html = render([task('t-1', 'todo', 'ana-1'), task('t-2', 'doing', 'bia-2')]);

  it('um só seletor, antes das colunas e fora do cabeçalho delas', () => {
    expect(html.match(/tasks-staff-filter/g)).toHaveLength(1);
    expect(html.indexOf('tasks-staff-filter')).toBeLessThan(html.indexOf('tasks-columns'));
    expect(html).not.toContain('tasks-col-filter');
  });

  it('lista só quem tem tarefa no quadro (em qualquer coluna)', () => {
    const select = html.slice(html.indexOf('<select class="tasks-staff-filter'), html.indexOf('</select>', html.indexOf('tasks-staff-filter')));
    expect(select).toContain('>Ana</option>');
    expect(select).toContain('>Bia</option>');
    expect(select).not.toContain('>Cris</option>');
  });

  it('sem tarefas: sem seletor', () => {
    expect(render([])).not.toContain('tasks-staff-filter');
  });
});
