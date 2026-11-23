import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxItem, Task } from '../shared/model';
import { planPending, planSessions } from '../client/src/tasks/planPending';
import { TasksBoard, byRecent } from '../client/src/tasks/TasksBoard';

// "Plano para aprovar" só com plano esperando de verdade: o status `planning` não prova (ficha Codex não tem cartão de plano, e a
// resposta do gestor a uma dúvida não aprova plano). Quem prova é o item `plan` da caixa para a conversa de trabalho do cartão.

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'perm:x1',
  kind: 'plan',
  projectId: 'p',
  projectName: 'Projeto',
  sessionId: 'sess-a',
  staffId: 'ana-1',
  name: 'Ana',
  summary: 'plano pronto para aprovar',
  at: '2026-11-18T10:00:00.000Z',
  ...over,
});

describe('planSessions / planPending: a regra', () => {
  it('só item `plan` conta (permissão, dúvida e erro da mesma conversa não)', () => {
    const sessions = planSessions([item(), item({ id: 'perm:x2', kind: 'permission', sessionId: 'sess-b' }), item({ id: 'q:1', kind: 'question', sessionId: 'sess-c' })]);
    expect([...sessions]).toEqual(['sess-a']);
  });

  it('planejando com plano esperando na conversa da tarefa: vale', () => {
    expect(planPending({ status: 'planning', sessionId: 'sess-a' }, planSessions([item()]))).toBe(true);
  });

  it('planejando sem item `plan` (Codex, dúvida respondida): não vale', () => {
    expect(planPending({ status: 'planning', sessionId: 'sess-a' }, planSessions([]))).toBe(false);
  });

  it('plano esperando em OUTRA conversa não vale para esta tarefa', () => {
    expect(planPending({ status: 'planning', sessionId: 'sess-a' }, planSessions([item({ sessionId: 'sess-b' })]))).toBe(false);
  });

  it('sem conversa na tarefa: não vale (nada a casar)', () => {
    expect(planPending({ status: 'planning', sessionId: null }, planSessions([item({ sessionId: '' })]))).toBe(false);
  });

  it('fora de planejando não vale, mesmo com item `plan` na conversa', () => {
    expect(planPending({ status: 'doing', sessionId: 'sess-a' }, planSessions([item()]))).toBe(false);
  });
});

describe('byRecent: o topo da coluna é de quem espera você', () => {
  const k = (id: string, status: 'doing' | 'planning', updatedAt: string) => ({ id, status, updatedAt });
  const col = [k('a', 'doing', '2026-11-05T10:00:00Z'), k('p', 'planning', '2026-11-01T10:00:00Z'), k('b', 'doing', '2026-11-04T10:00:00Z')];

  it('planejando sem plano esperando não passa na frente: ordem por data', () => {
    expect(byRecent(col).map((x) => x.id)).toEqual(['a', 'b', 'p']);
    expect(byRecent(col, () => false).map((x) => x.id)).toEqual(['a', 'b', 'p']);
  });

  it('com plano esperando, vai antes de tudo, mesmo mais antigo', () => {
    expect(byRecent(col, (x) => x.id === 'p').map((x) => x.id)).toEqual(['p', 'a', 'b']);
  });
});

describe('o quadro: selo, destaque e topo da coluna Fazendo', () => {
  const task = (over: Partial<Task> = {}): Task =>
    ({
      id: 't-17e624',
      title: 'Tarefa do plano',
      description: 'x',
      status: 'planning',
      staffId: 'ana-1',
      sessionId: 'sess-a',
      plan: null,
      branch: null,
      pr: null,
      history: [],
      createdAt: '2026-11-17T09:00:00.000Z',
      updatedAt: '2026-11-17T09:00:00.000Z',
      ...over,
    }) as Task;

  const render = (tasks: Task[], inboxItems?: InboxItem[]) =>
    renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: tasks, inboxItems }),
    );
  /** O cartão da tarefa `id`: do `<button class="task-card` dela até o `</button>` que o fecha (o id é o primeiro filho; os selos vêm depois). */
  const cardOf = (html: string, id: string) => {
    const at = html.indexOf(`>${id}</span>`);
    expect(at).toBeGreaterThan(0);
    return html.slice(html.lastIndexOf('<button class="task-card', at), html.indexOf('</button>', at));
  };

  it('sem plano esperando: "Planejando" neutro, sem selo amarelo nem is-waiting', () => {
    const card = cardOf(render([task()], []), 't-17e624');
    expect(card).toContain('<span class="task-badge small" title="Ele está planejando.');
    expect(card).toContain('>Planejando</span>');
    expect(card).not.toContain('Plano para aprovar');
    expect(card).not.toContain('is-waiting');
    expect(card).not.toContain('tone-action');
  });

  it('sem a caixa (undefined): o mesmo, nada de plano esperando', () => {
    const card = cardOf(render([task()]), 't-17e624');
    expect(card).not.toContain('Plano para aprovar');
    expect(card).not.toContain('is-waiting');
    expect(card).not.toContain('tone-action');
  });

  it('com plano esperando na conversa dela: selo amarelo "Plano para aprovar" e cartão is-waiting, como antes', () => {
    const card = cardOf(render([task()], [item()]), 't-17e624');
    expect(card).toMatch(/^<button class="task-card[^"]*is-waiting/);
    expect(card).toContain('<span class="task-badge tone-action" title="Ele está montando o plano; você aprova no cartão de plano do chat.">Plano para aprovar</span>');
    expect(card).not.toContain('>Planejando</span>');
  });

  it('plano esperando em outra conversa: este cartão segue neutro', () => {
    const card = cardOf(render([task()], [item({ sessionId: 'sess-outra' })]), 't-17e624');
    expect(card).not.toContain('Plano para aprovar');
    expect(card).not.toContain('is-waiting');
    expect(card).not.toContain('tone-action');
  });

  it('topo da coluna: só quem tem plano esperando passa na frente do mais recente', () => {
    const velho = task({ id: 't-velho1', title: 'Plano velho', sessionId: 'sess-v', updatedAt: '2026-11-01T09:00:00.000Z' });
    const novo = task({ id: 't-novo01', title: 'Trabalho novo', status: 'doing', sessionId: 'sess-n', updatedAt: '2026-11-17T09:00:00.000Z' });
    const order = (html: string) => (html.indexOf('t-velho1') < html.indexOf('t-novo01') ? 'velho-primeiro' : 'novo-primeiro');
    expect(order(render([velho, novo], [item({ sessionId: 'sess-v' })]))).toBe('velho-primeiro');
    expect(order(render([velho, novo], []))).toBe('novo-primeiro');
  });
});
