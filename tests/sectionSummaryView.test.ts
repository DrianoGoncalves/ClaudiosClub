import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from '../shared/model';
import { codeSummary, reviewLine } from '../client/src/tasks/codeSummary';
import { ReviewStatus } from '../client/src/tasks/ReviewDelegate';
import { BlockedByField, depsSummary } from '../client/src/tasks/TaskDeps';
import { TasksBoard } from '../client/src/tasks/TasksBoard';

// Detalhe da tarefa: custo, "Código, revisão e deploy" e "Bloqueada por" abrem recolhidos, com o resumo de uma linha no cabeçalho.

const name = (id: string) => ({ 'rui-1': 'Rui', 'ana-1': 'Ana' })[id] ?? id;
const review = (over: Record<string, unknown> = {}) => ({ staffId: 'rui-1', sessionId: 'rev-sess', at: '2026-11-18T10:00:00.000Z', ...over }) as NonNullable<Task['review']>;
const tests = (ok: boolean) => ({ ok, command: 'npm test', at: '2026-11-18T10:00:00.000Z', output: '' }) as NonNullable<Task['tests']>;
const merged = { base: 'main', sha: 'abc1234', at: '2026-11-18T11:00:00.000Z' } as NonNullable<Task['merged']>;

describe('codeSummary: o que a seção recolhida diz no cabeçalho', () => {
  it('veredito primeiro, depois os testes e a mesclagem', () => {
    expect(codeSummary({ review: review({ doneAt: 'x', verdict: 'approved' }), tests: tests(true), merged }, name)).toBe('Aprovada por Rui · Testes: passaram · Mesclada');
    expect(codeSummary({ review: review({ doneAt: 'x', verdict: 'rejected' }), tests: tests(false) }, name)).toBe('Reprovada por Rui · Testes: falharam');
  });

  it('revisão pedida e sem resposta: quem está revisando; respondeu sem veredito: "respondeu"', () => {
    expect(codeSummary({ review: review() }, name)).toBe('Rui · revisando');
    expect(codeSummary({ review: review({ doneAt: 'x', verdict: null }) }, name)).toBe('Rui · respondeu');
  });

  it('sem revisão: só os testes; sem nada, a frase de "ainda não"', () => {
    expect(codeSummary({ tests: tests(true) }, name)).toBe('Testes: passaram');
    expect(codeSummary({}, name)).toBe('Sem testes nem revisão ainda');
  });

  it('revisor sem ficha aparece pelo id, como no status da seção (nunca em branco)', () => {
    expect(reviewLine(review({ staffId: 'sumiu-9', doneAt: 'x', verdict: 'approved' }), name)).toBe('Aprovada por sumiu-9');
    expect(reviewLine(undefined, name)).toBe('');
  });

  it('ReviewStatus (a linha da seção) e o cabeçalho usam a mesma frase', () => {
    const t = { review: review({ doneAt: 'x', verdict: 'approved' }) } as Task;
    const html = renderToStaticMarkup(createElement(ReviewStatus, { task: t, staff: [], onOpenStaff: () => {} }));
    expect(html).toContain(`>${reviewLine(t.review, (id) => id)}`);
  });
});

describe('depsSummary: o que "Bloqueada por" diz recolhida', () => {
  const task = (id: string, status: TaskStatus) => ({ id, status, title: `Tarefa ${id}` });
  const all = [task('t-a', 'doing'), task('t-b', 'done'), task('t-c', 'cancelled'), task('t-d', 'review')];

  it('sem dependência', () => {
    expect(depsSummary([], all)).toBe('Nenhuma dependência');
  });

  it('quantas são e quantas ainda estão em aberto; a cancelada ainda segura', () => {
    expect(depsSummary(['t-a'], all)).toBe('1 tarefa · 1 em aberto');
    expect(depsSummary(['t-a', 't-b', 't-c'], all)).toBe('3 tarefas · 2 em aberto');
    expect(depsSummary(['t-b'], all)).toBe('1 tarefa · nenhuma em aberto');
  });

  it('vínculo de fora do projeto conta no total, não como aberto', () => {
    expect(depsSummary(['t-x', 't-a'], all)).toBe('2 tarefas · 1 em aberto');
    expect(depsSummary(['t-x'], all)).toBe('1 tarefa · nenhuma em aberto');
  });

  it('o rascunho manda: marcar mais uma muda o cabeçalho antes de salvar', () => {
    expect(depsSummary(['t-a', 't-d'], all)).toBe('2 tarefas · 2 em aberto');
  });
});

describe('BlockedByField recolhido', () => {
  const labels = { waiting: 'Aguardar', todo: 'A fazer', planning: 'Planejando', doing: 'Fazendo', review: 'Revisão', done: 'Pronto', cancelled: 'Cancelada' };
  const tasks = [{ id: 't-a', status: 'doing' as const, title: 'Tarefa A' }];
  const render = (collapsible?: boolean) => renderToStaticMarkup(createElement(BlockedByField, { tasks, selfId: null, value: ['t-a'], labels, onChange: () => {}, collapsible }));

  it('com `collapsible`: <details> sem `open`, cabeçalho com o resumo, lista dentro', () => {
    const html = render(true);
    expect(html).toMatch(/^<details class="collapse task-deps"><summary class="has-sum">Bloqueada por<span class="collapse-sum muted small" title="1 tarefa · 1 em aberto">1 tarefa · 1 em aberto<\/span><\/summary>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('Tarefa A');
  });

  it('sem `collapsible` (o formulário de criar): o fieldset de sempre', () => {
    const html = render();
    expect(html).toMatch(/^<fieldset class="task-deps"><legend>Bloqueada por<\/legend>/);
    expect(html).not.toContain('<details');
  });
});

describe('o detalhe da tarefa de verdade: as três seções abrem recolhidas, em qualquer coluna', () => {
  const full = (over: Partial<Task> = {}): Task =>
    ({
      id: 't-secao1',
      title: 'Exportar em CSV',
      description: 'exportar',
      staffId: 'ana-1',
      sessionId: 'sess-1',
      plan: null,
      branch: null,
      pr: null,
      history: [
        { at: '2026-11-18T09:00:00.000Z', status: 'doing', by: 'auto' },
        { at: '2026-11-18T10:00:00.000Z', status: 'review', by: 'auto' },
      ],
      blockedBy: ['t-dep1'],
      createdAt: '2026-11-18T09:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
      ...over,
    }) as Task;
  const dep = { id: 't-dep1', title: 'Base da API', description: '', staffId: null, plan: null, history: [], blockedBy: [], status: 'doing', createdAt: '2026-11-18T08:00:00.000Z', updatedAt: '2026-11-18T08:00:00.000Z' } as unknown as Task;

  const detail = (over: Partial<Task> = {}) => {
    const t = full(over);
    const html = renderToStaticMarkup(
      createElement(TasksBoard, { projectId: 'p', projectName: 'Projeto', staff: [], costs: null, onClose: () => {}, onOpenStaff: () => {}, onChanged: () => {}, initialTasks: [t, dep], initialTaskId: t.id }),
    );
    const at = html.indexOf('<aside class="task-detail">');
    expect(at).toBeGreaterThan(0);
    return html.slice(at);
  };
  /** O <details> que abre com `label` no cabeçalho: abertura e resumo. */
  const section = (html: string, label: string) => html.match(new RegExp(`<details class="collapse[^"]*"([^>]*)><summary class="has-sum">${label}<span[^>]*>([^<]*)</span>`));

  for (const status of ['review', 'done', 'doing'] as const) {
    it(`em ${status}: custo, código/revisão e bloqueada por fechados, cada um com o seu resumo`, () => {
      const html = detail({ status, review: review({ doneAt: 'x', verdict: 'approved' }), tests: tests(true) });
      const cost = section(html, 'Custo da tarefa');
      const code = section(html, 'Código, revisão e deploy');
      const deps = section(html, 'Bloqueada por');
      for (const s of [cost, code, deps]) {
        expect(s).not.toBeNull();
        expect(s![1]).toBe(''); // nenhum atributo `open`
      }
      expect(cost![2]).toBe('calculando…');
      // Sem ficha do revisor na equipe do teste, o nome cai no id (como no status da seção).
      expect(code![2]).toBe('Aprovada por rui-1 · Testes: passaram');
      expect(deps![2]).toBe('1 tarefa · 1 em aberto');
    });
  }

  it('o resto do detalhe não foi recolhido: Histórico e o plano seguem como eram (fechados por si, sem resumo)', () => {
    const html = detail({ plan: 'passo 1' });
    expect(html).toContain('<summary>Plano aprovado</summary>');
    expect(html).toContain('<summary>Histórico</summary>');
  });
});
