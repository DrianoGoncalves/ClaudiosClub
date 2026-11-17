import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type TaskQuestion } from '../shared/model';
import { ResourceWaitBadge } from '../client/src/tasks/ResourceWait';
import { BlockedBadge } from '../client/src/tasks/TaskDeps';
import { DoubtBadge } from '../client/src/tasks/TaskDoubt';
import { waitClass, waitWarm } from '../client/src/tasks/waitTone';

// O laranja de espera é só da coluna A fazer: nas outras colunas (Aguardar, Fazendo, Revisão…) os selos ficam neutros.

const blocker = { id: 't-1', title: 'Base', status: 'doing' as const };
const wait = { reason: 'RAM disponível 1,2 GB', since: '2026-11-16T10:00:00.000Z' };
const question = { id: 'q1', status: 'open' } as TaskQuestion;
const nameOf = () => 'Gestor';

describe('waitWarm', () => {
  it('só A fazer é laranja', () => {
    expect(TASK_STATUSES.filter(waitWarm)).toEqual(['todo']);
  });
  it('waitClass só põe a classe quando é laranja', () => {
    expect(waitClass(true)).toBe(' task-wait');
    expect(waitClass(false)).toBe('');
    expect(waitClass(undefined)).toBe('');
  });
});

describe('selos de espera do cartão', () => {
  it.each([
    ['Esperando: …', (warm: boolean) => createElement(BlockedBadge, { blockers: [blocker], warm })],
    ['Aguardando recursos', (warm: boolean) => createElement(ResourceWaitBadge, { wait, now: Date.parse(wait.since), warm })],
    ['Dúvida com o gestor', (warm: boolean) => createElement(DoubtBadge, { question, requestedBy: 'g', nameOf, warm })],
  ])('%s: laranja com warm, neutro sem', (_nome, render) => {
    expect(renderToStaticMarkup(render(true))).toContain('task-wait');
    expect(renderToStaticMarkup(render(false))).not.toContain('task-wait');
  });

  it('sem a prop warm o selo fica neutro', () => {
    expect(renderToStaticMarkup(createElement(BlockedBadge, { blockers: [blocker] }))).not.toContain('task-wait');
  });

  it('dúvida que está com você segue amarela, em qualquer coluna', () => {
    const mine = { id: 'q1', status: 'escalated' } as TaskQuestion;
    for (const warm of [true, false]) {
      const html = renderToStaticMarkup(createElement(DoubtBadge, { question: mine, requestedBy: 'g', nameOf, warm }));
      expect(html).toContain('is-waiting');
      expect(html).not.toContain('task-wait');
    }
  });
});
