import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus, TaskSubtaskRef } from '../shared/model';
import { SubtaskBadges, SubtaskBlock, SubtaskRow, SubtaskStack, awaitText, awaitsSubtasks, openSubtasks, parentOf, parentText } from '../client/src/tasks/TaskSubtasks';
import taskMessages from '../client/src/i18n/tasks';

const LABEL: Record<TaskStatus, string> = {
  waiting: 'Aguardar',
  todo: 'A fazer',
  planning: 'Planejando',
  doing: 'Fazendo',
  review: 'Revisão',
  done: 'Finalizado',
  cancelled: 'Cancelada',
};
const ref = (id: string, status: TaskStatus, title = `Sub ${id}`): TaskSubtaskRef => ({ id, title, status, staffId: 's-1' });
const card = (over: Partial<Task> = {}): Task => ({ id: 't-card', title: 'Card do orquestrador', status: 'doing', staffId: 's-1', ...over }) as Task;
const nameOf = (id: string | null) => (id === 's-1' ? 'Denzel' : null);
const noop = () => {};
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const waiting = (): Task =>
  card({
    awaitingSubtasks: { since: '2026-11-17T10:00:00Z' },
    subtasks: [ref('t-aaaaaa', 'doing', 'Tela do selo'), ref('t-bbbbbb', 'done', 'Docs'), ref('t-cccccc', 'todo', 'Teste')],
  });

describe('card que aguarda subtarefas', () => {
  it('conta só as abertas (pronta e cancelada saem)', () => {
    const task = card({ subtasks: [ref('a', 'doing'), ref('b', 'done'), ref('c', 'cancelled'), ref('d', 'review')] });
    expect(openSubtasks(task).map((s) => s.id)).toEqual(['a', 'd']);
  });

  it('só "aguarda" com a marca do servidor, em Fazendo e com subtarefa aberta', () => {
    expect(awaitsSubtasks(waiting())).toBe(true);
    expect(awaitsSubtasks({ ...waiting(), awaitingSubtasks: undefined })).toBe(false);
    expect(awaitsSubtasks({ ...waiting(), status: 'review' })).toBe(false);
    expect(awaitsSubtasks({ ...waiting(), subtasks: [ref('a', 'done')] })).toBe(false);
  });

  it('selo no cartão diz quantas estão abertas e é só texto (cartão é botão)', () => {
    const out = html(createElement(SubtaskBadges, { task: waiting(), nameOf }));
    expect(out).toContain('Aguardando 2 subtarefas');
    expect(out).not.toContain('<button');
    expect(out).not.toContain('<a ');
    expect(out).toContain('Denzel segue com a próxima da fila dele');
  });

  it('uma só abre no singular', () => {
    expect(awaitText(1)).toBe('Aguardando 1 subtarefa');
    expect(awaitText(3)).toBe('Aguardando 3 subtarefas');
  });

  it('linha de links: um botão por subtarefa aberta, com título e status; a pronta não entra', () => {
    const out = html(createElement(SubtaskRow, { task: waiting(), tasks: [], labels: LABEL, onOpen: noop }));
    expect(out).toContain('Tela do selo');
    expect(out).toContain('Fazendo');
    expect(out).toContain('Teste');
    expect(out).toContain('A fazer');
    expect(out).not.toContain('Docs');
    expect(out.match(/<button/g)).toHaveLength(2);
  });

  it('sem subtarefa aberta e sem origem: nada no cartão', () => {
    const task = card({ subtasks: [ref('a', 'done')] });
    expect(html(createElement(SubtaskBadges, { task, nameOf }))).toBe('');
    expect(html(createElement(SubtaskRow, { task, tasks: [], labels: LABEL, onOpen: noop }))).toBe('');
  });

  it('a bandeja fica na mesma pilha do cartão, depois dele; sem o que mostrar, o cartão fica num div sem a classe da pilha', () => {
    const child = createElement('button', { className: 'task-card' }, 'Cartão');
    const out = html(createElement(SubtaskStack, { task: waiting(), tasks: [], labels: LABEL, onOpen: noop, children: child }));
    expect(out.startsWith('<div class="task-stack"><button class="task-card">Cartão</button><ul class="task-subs-row task-subs-tray">')).toBe(true);
    const plain = html(createElement(SubtaskStack, { task: card(), tasks: [], labels: LABEL, onOpen: noop, children: child }));
    expect(plain).toBe('<div class="task-slot"><button class="task-card">Cartão</button></div>');
  });

  // A pilha é hook-free: chamada como função devolve o elemento que o React reconcilia. O mesmo tipo, a mesma chave e o cartão na mesma posição = o React
  // atualiza o `div` no lugar e o botão (com o foco do teclado) não é desmontado. Se um dos três mudar, o cartão é recriado e o foco se perde.
  it('o cartão não é desmontado quando a bandeja aparece ou some (foco do teclado se mantém)', () => {
    const child = createElement('button', { className: 'task-card' }, 'Cartão');
    const stack = (task: Task): ReactElement<{ className: string; children: ReactNode[] }> =>
      SubtaskStack({ task, tasks: [], labels: LABEL, onOpen: noop, children: child }) as ReactElement<{ className: string; children: ReactNode[] }>;
    const lastClosed = card({ subtasks: [ref('t-aaaaaa', 'done', 'Tela do selo')] });
    const states = [waiting(), lastClosed, card(), waiting()];
    for (const task of states) {
      const el = stack(task);
      expect(el.type).toBe('div');
      expect(el.key).toBeNull();
      expect(el.props.children[0]).toBe(child);
    }
    expect(stack(waiting()).props.className).toBe('task-stack');
    expect(stack(lastClosed).props.className).toBe('task-slot');
    // Subtarefa: com a origem no quadro ou fora dele (cai no id) a bandeja existe, e o `div` é o mesmo.
    const sub = card({ id: 't-aaaaaa', parentTaskId: 't-card' });
    for (const tasks of [[card(), sub], [sub]]) {
      const el = SubtaskStack({ task: sub, tasks, labels: LABEL, onOpen: noop, children: child }) as ReactElement<{ className: string; children: ReactNode[] }>;
      expect(el.type).toBe('div');
      expect(el.props.className).toBe('task-stack');
      expect(el.props.children[0]).toBe(child);
    }
  });

  it('o arrasto é da pilha inteira: os eventos vão para o `div` (a bandeja conta como parte do cartão)', () => {
    const onDragOver = () => {};
    const onDragLeave = () => {};
    const onDrop = () => {};
    const child = createElement('button', { className: 'task-card' }, 'Cartão');
    for (const task of [waiting(), card()]) {
      const el = SubtaskStack({ task, tasks: [], labels: LABEL, onOpen: noop, children: child, onDragOver, onDragLeave, onDrop }) as ReactElement<Record<string, unknown>>;
      expect(el.type).toBe('div');
      expect(el.props.onDragOver).toBe(onDragOver);
      expect(el.props.onDragLeave).toBe(onDragLeave);
      expect(el.props.onDrop).toBe(onDrop);
    }
  });

  it('status de cada subtarefa vai num selo, depois do link', () => {
    const out = html(createElement(SubtaskRow, { task: waiting(), tasks: [], labels: LABEL, onOpen: noop }));
    expect(out).toContain('<span class="task-badge task-subs-status">Fazendo</span>');
  });
});

describe('subtarefa mostra de qual card ela é', () => {
  const sub = card({ id: 't-aaaaaa', title: 'Tela do selo', parentTaskId: 't-card' });
  const tasks = [card(), sub] as Task[];

  it('acha o card de origem pelo `parentTaskId`', () => {
    expect(parentOf(sub, tasks)?.task?.title).toBe('Card do orquestrador');
    expect(parentOf(card(), tasks)).toBeNull();
  });

  it('card de origem fora do quadro: cai no id, sem título nem status', () => {
    const lost = parentOf(sub, [sub])!;
    expect(lost).toEqual({ id: 't-card', task: null });
    expect(parentText(lost)).toBe('Subtarefa de t-card');
    const out = html(createElement(SubtaskRow, { task: sub, tasks: [sub], labels: LABEL, onOpen: noop }));
    expect(out).toContain('t-card');
    expect(out).toContain('fora do quadro');
  });

  it('o link da bandeja traz o título e o status do card de origem; o selo do cartão não repete', () => {
    expect(html(createElement(SubtaskBadges, { task: sub, nameOf }))).toBe('');
    const row = html(createElement(SubtaskRow, { task: sub, tasks, labels: LABEL, onOpen: noop }));
    expect(row).toContain('Subtarefa de “Card do orquestrador”');
    expect(row).toContain('Fazendo');
    expect(row.match(/<button/g)).toHaveLength(1);
  });

  it('subtarefa que também delegou: selo de aguardando no cartão e, na bandeja, a origem antes das subtarefas', () => {
    const both = card({ id: 't-mid', parentTaskId: 't-card', awaitingSubtasks: { since: 'x' }, subtasks: [ref('t-x', 'doing', 'Filha')] });
    expect(html(createElement(SubtaskBadges, { task: both, nameOf }))).toContain('Aguardando 1 subtarefa');
    const row = html(createElement(SubtaskRow, { task: both, tasks: [card(), both], labels: LABEL, onOpen: noop }));
    expect(row.indexOf('Subtarefa de “Card do orquestrador”')).toBeGreaterThan(-1);
    expect(row.indexOf('Subtarefa de “Card do orquestrador”')).toBeLessThan(row.indexOf('Filha'));
  });
});

describe('bloco do detalhe', () => {
  it('no card: lista todas (a fechada também), conta as abertas e diz a regra', () => {
    const out = html(createElement(SubtaskBlock, { task: waiting(), tasks: [], labels: LABEL, staffName: 'Denzel', onOpen: noop }));
    expect(out).toContain('Aguardando 2 subtarefas');
    expect(out).toContain('2 de 3 abertas');
    expect(out).toContain('Docs');
    expect(out).toContain('Finalizado');
    expect(out).toContain('não vai para Revisão');
    expect(out.match(/<button/g)).toHaveLength(3);
  });

  it('card que tem subtarefa mas não aguarda mostra só o título "Subtarefas", sem a regra', () => {
    const task = card({ subtasks: [ref('a', 'done')] });
    const out = html(createElement(SubtaskBlock, { task, tasks: [], labels: LABEL, staffName: null, onOpen: noop }));
    expect(out).toContain('Subtarefas');
    expect(out).toContain('0 de 1 abertas');
    expect(out).not.toContain('não vai para Revisão');
  });

  it('na subtarefa: link para o card de origem', () => {
    const sub = card({ id: 't-aaaaaa', parentTaskId: 't-card' });
    const out = html(createElement(SubtaskBlock, { task: sub, tasks: [card(), sub], labels: LABEL, staffName: null, onOpen: noop }));
    expect(out).toContain('Subtarefa do card');
    expect(out).toContain('Card do orquestrador');
    expect(out.match(/<button/g)).toHaveLength(1);
  });

  it('tarefa comum (sem subtarefa nem origem): nada', () => {
    expect(html(createElement(SubtaskBlock, { task: card(), tasks: [], labels: LABEL, staffName: null, onOpen: noop }))).toBe('');
  });
});

describe('textos nos 3 idiomas', () => {
  const keys = ['subsAwaitOne', 'subsAwaitOther', 'subsAwaitHint', 'subsTitle', 'subsOpenOf', 'subOf', 'subOfGone', 'subOfGoneStatus', 'subOfTitle', 'subOfHint'].map((k) => `tasks.${k}`);
  it.each(['pt-BR', 'en', 'es'] as const)('%s tem todas as chaves', (lang) => {
    const msgs = taskMessages[lang] as Record<string, string>;
    for (const k of keys) expect(msgs[k], k).toBeTruthy();
  });
});
