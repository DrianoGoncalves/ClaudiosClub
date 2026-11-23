import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { LIST_STEP, TasksBoard } from '../client/src/tasks/TasksBoard';
import { LazyScreen } from '../client/src/LazyScreen';
import { Skeleton } from '../client/src/lib/Skeleton';

// O quadro com centenas de cartões: Pronto mostra os LIST_STEP mais recentes e um "Mostrar mais" (o contador segue com o total); "A fazer" fica
// inteira (a fila se arrasta). E o esqueleto no lugar do "Carregando…" enquanto a primeira leitura não volta.

const task = (id: string, status: Task['status'], minute: number): Task =>
  ({
    id,
    title: `Tarefa ${id}`,
    description: 'x',
    status,
    staffId: 'ana-1',
    sessionId: null,
    plan: null,
    branch: null,
    pr: null,
    history: [],
    createdAt: '2026-11-17T09:00:00.000Z',
    updatedAt: new Date(Date.parse('2026-11-17T09:00:00.000Z') + minute * 60_000).toISOString(),
  }) as Task;
const person = { id: 'ana-1', name: 'Ana', role: 'Back-end', reportsTo: [], servers: [] } as unknown as StaffProfile;

const render = (tasks?: Task[]) =>
  renderToStaticMarkup(
    createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [person], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: tasks }),
  );

const column = (html: string, status: string) => {
  const from = html.indexOf(`tasks-col-${status}`);
  const to = html.indexOf('<section', from + 1);
  return html.slice(from, to === -1 ? undefined : to);
};
const cards = (html: string) => (html.match(/class="task-card[ "]/g) ?? []).length;

describe('grupos longos do quadro', () => {
  const done = Array.from({ length: 100 }, (_, i) => task(`d-${i}`, 'done', i));
  const todo = Array.from({ length: 50 }, (_, i) => task(`t-${i}`, 'todo', i));
  const html = render([...done, ...todo]);

  it(`Pronto: só os ${LIST_STEP} primeiros, os mais recentes, e o botão com o que falta; o contador com o total`, () => {
    const col = column(html, 'done');
    expect(cards(col)).toBe(LIST_STEP);
    expect(col).toContain('Mostrar mais 40 (de 60 restantes)');
    expect(col).toContain('<span class="muted">100</span>');
    expect(col).toContain('Tarefa d-99'); // o mais recente
    expect(col).not.toContain('Tarefa d-0<'); // o mais antigo fica para o "Mostrar mais"
  });

  it('A fazer: inteira, sem botão (a ordem da fila se arrasta)', () => {
    const col = column(html, 'todo');
    expect(cards(col)).toBe(50);
    expect(col).not.toContain('Mostrar mais');
  });

  it('Fazendo e Revisão: inteiras (trabalho em andamento não some atrás de um botão)', () => {
    const busy = render([...Array.from({ length: 45 }, (_, i) => task(`f-${i}`, 'doing', i)), ...Array.from({ length: 45 }, (_, i) => task(`r-${i}`, 'review', i))]);
    expect(cards(column(busy, 'doing'))).toBe(45);
    expect(cards(column(busy, 'review'))).toBe(45);
    expect(busy).not.toContain('Mostrar mais');
  });

  it('grupo curto: sem botão', () => {
    const short = column(render([task('d-1', 'done', 1), task('d-2', 'done', 2)]), 'done');
    expect(cards(short)).toBe(2);
    expect(short).not.toContain('Mostrar mais');
  });
});

describe('esqueleto de carregamento', () => {
  it('o quadro antes da primeira leitura: colunas de esqueleto, com o texto para o leitor de tela', () => {
    const html = render(undefined);
    expect(html).toContain('class="skel skel-columns" role="status"');
    expect(html).toContain('<span class="sr-only">Carregando…</span>');
    expect(html).not.toContain('tasks-columns');
  });

  it('Skeleton em linhas: o número pedido, só visual (aria-hidden)', () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { label: 'Carregando a tela…', lines: 4 }));
    expect((html.match(/class="skel-bar"/g) ?? []).length).toBe(4);
    expect((html.match(/aria-hidden="true"/g) ?? []).length).toBe(4);
  });

  it('LazyScreen sem a tela pronta: o esqueleto (modal = dentro do véu do modal); fallback null = nada', () => {
    const pending = { then: () => {} } as unknown as Promise<never>;
    const Never = () => {
      throw pending; // sempre suspenso: o Suspense mostra o fallback
    };
    const inline = renderToStaticMarkup(createElement(LazyScreen, null, createElement(Never)));
    expect(inline).toContain('skel skel-lines');
    expect(inline).not.toContain('modal-backdrop');
    const modal = renderToStaticMarkup(createElement(LazyScreen, { modal: true, children: createElement(Never) }));
    expect(modal).toContain('modal-backdrop');
    expect(modal).toContain('skel skel-lines');
    expect(renderToStaticMarkup(createElement(LazyScreen, { fallback: null, children: createElement(Never) }))).toBe('');
  });
});
