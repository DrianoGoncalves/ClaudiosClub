import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskRunEvent } from '../client/src/api';
import { BlockedBadge, BlockedByField, MAX_DEPS, openBlockers, sameDeps } from '../client/src/tasks/TaskDeps';
import { groupRuns, runDuration } from '../client/src/tasks/TaskRuns';

const task = (id: string, status: 'todo' | 'doing' | 'done', extra: { archived?: boolean; title?: string } = {}) => ({
  id,
  status,
  title: extra.title ?? `Tarefa ${id}`,
  archived: extra.archived,
});

describe('openBlockers', () => {
  it('só as dependências que existem e ainda não estão prontas (a regra do servidor)', () => {
    const all = [task('t-a', 'doing'), task('t-b', 'done'), task('t-c', 'todo')];
    expect(openBlockers({ blockedBy: ['t-a', 't-b', 't-x', 't-c'] }, all).map((o) => o.id)).toEqual(['t-a', 't-c']);
    expect(openBlockers({}, all)).toEqual([]);
  });
});

describe('sameDeps', () => {
  it('compara como conjunto: a ordem não conta', () => {
    expect(sameDeps(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameDeps(['a'], ['a', 'b'])).toBe(false);
    expect(sameDeps([], [])).toBe(true);
  });
});

describe('BlockedBadge', () => {
  it('sem dependência aberta não desenha nada', () => {
    expect(renderToStaticMarkup(createElement(BlockedBadge, { blockers: [] }))).toBe('');
  });
  it('mostra os dois primeiros nomes e "+N" para o resto; o title traz todos com o id', () => {
    const html = renderToStaticMarkup(createElement(BlockedBadge, { blockers: [task('t-1', 'todo'), task('t-2', 'todo'), task('t-3', 'doing')] }));
    expect(html).toContain('Esperando: “Tarefa t-1”, “Tarefa t-2” +1');
    expect(html).toContain('Tarefa t-3 (t-3)');
  });
});

describe('BlockedByField', () => {
  const labels = { waiting: 'Aguardar', todo: 'A fazer', planning: 'Planejando', doing: 'Fazendo', review: 'Revisão', done: 'Pronto' };
  const render = (props: { tasks: ReturnType<typeof task>[]; selfId: string | null; value: string[] }) =>
    renderToStaticMarkup(createElement(BlockedByField, { ...props, labels, onChange: () => {} }));

  it('não oferece a própria tarefa nem as arquivadas (a menos que já marcadas); prontas vão por último', () => {
    const html = render({
      tasks: [task('t-me', 'todo'), task('t-old', 'done', { archived: true }), task('t-kept', 'done', { archived: true }), task('t-ok', 'todo'), task('t-done', 'done')],
      selfId: 't-me',
      value: ['t-kept'],
    });
    expect(html).not.toContain('Tarefa t-me');
    expect(html).not.toContain('Tarefa t-old');
    expect(html.indexOf('Tarefa t-ok')).toBeLessThan(html.indexOf('Tarefa t-done'));
    expect(html).toContain('Tarefa t-kept');
  });

  it('sem outras tarefas, avisa em vez de mostrar lista vazia', () => {
    const html = render({ tasks: [task('t-me', 'todo')], selfId: 't-me', value: [] });
    expect(html).toContain('Não há outras tarefas');
    expect(html).not.toContain('<ul');
  });

  it('no teto de 20 dependências, as não marcadas ficam desabilitadas', () => {
    const many = Array.from({ length: MAX_DEPS + 1 }, (_, i) => task(`t-${i}`, 'todo'));
    const value = many.slice(0, MAX_DEPS).map((o) => o.id);
    const html = render({ tasks: many, selfId: null, value });
    expect(html.match(/disabled/g)).toHaveLength(1);
  });
});

const ev = (e: Partial<TaskRunEvent> & Pick<TaskRunEvent, 'ev' | 'runId' | 'at'>): TaskRunEvent => ({ taskId: 't-1', staffId: 's-1', ...e });

describe('groupRuns', () => {
  it('junta start e end do mesmo runId, a mais recente primeiro', () => {
    const runs = groupRuns([
      ev({ ev: 'start', runId: 'r-1', at: '2026-11-13T10:00:00.000Z', trigger: 'queue' }),
      ev({ ev: 'end', runId: 'r-1', at: '2026-11-13T10:12:00.000Z', outcome: 'delivered' }),
      ev({ ev: 'start', runId: 'r-2', at: '2026-11-13T11:00:00.000Z', trigger: 'manual' }),
    ]);
    expect(runs.map((r) => r.runId)).toEqual(['r-2', 'r-1']);
    expect(runs[0]).toMatchObject({ trigger: 'manual', outcome: null, endedAt: null, started: true });
    expect(runs[1]).toMatchObject({ trigger: 'queue', outcome: 'delivered', endedAt: '2026-11-13T10:12:00.000Z' });
  });

  it('end sem start (o começo já girou do arquivo): vale o fim, sem gatilho nem duração', () => {
    const [run] = groupRuns([ev({ ev: 'end', runId: 'r-9', at: '2026-11-13T09:00:00.000Z', outcome: 'limit', note: 'limite de 5h' })]);
    expect(run).toMatchObject({ trigger: null, outcome: 'limit', started: false, note: 'limite de 5h' });
    expect(runDuration(run!, Date.now())).toBeNull();
  });
});

describe('runDuration', () => {
  const NOW = Date.parse('2026-11-13T12:00:00.000Z');
  it('fechada: do começo ao fim; aberta: do começo até agora', () => {
    const [closed] = groupRuns([
      ev({ ev: 'start', runId: 'r-1', at: '2026-11-13T10:00:00.000Z' }),
      ev({ ev: 'end', runId: 'r-1', at: '2026-11-13T10:12:00.000Z', outcome: 'delivered' }),
    ]);
    const [open] = groupRuns([ev({ ev: 'start', runId: 'r-2', at: '2026-11-13T10:00:00.000Z' })]);
    expect(runDuration(closed!, NOW)).toBe('12min');
    expect(runDuration(open!, NOW)).toBe('2h00');
  });
});
