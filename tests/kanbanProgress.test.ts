import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { kanbanProgress, progressPercent, progressTotal, STATUS_POINTS, TASK_POINTS, type ProgressTask } from '../shared/kanbanProgress';
import { KanbanProgressBar } from '../client/src/tasks/KanbanProgressBar';
import { TaskService } from '../server/tasks';
import type { StaffProfile, TaskStatus } from '../shared/model';

// Dados simulados. Cada tarefa na conta vale 3 pontos; A fazer 0, Fazendo/Planejando 1, Revisão 2. Aguardar, Pronto e
// Cancelada ficam fora da conta (nem pontos nem máximo).

const task = (status: TaskStatus): ProgressTask => ({ status });

describe('kanbanProgress', () => {
  it('sem tarefas não há barra', () => {
    expect(kanbanProgress([])).toBeNull();
  });

  it('só Aguardar, Pronto e Cancelada: nada na conta, sem barra', () => {
    expect(kanbanProgress([task('waiting'), task('done'), task('cancelled')])).toBeNull();
  });

  it('cada coluna vale seus pontos de 3', () => {
    expect(TASK_POINTS).toBe(3);
    expect(STATUS_POINTS).toEqual({ todo: 0, planning: 1, doing: 1, review: 2 });
    expect(kanbanProgress([task('todo')])).toEqual({ points: 0, max: 3 });
    expect(kanbanProgress([task('doing')])).toEqual({ points: 1, max: 3 });
    expect(kanbanProgress([task('review')])).toEqual({ points: 2, max: 3 });
  });

  it('mistura: soma os pontos sobre 3 × tarefas na conta, ignorando Aguardar e Pronto', () => {
    const p = kanbanProgress([task('waiting'), task('todo'), task('doing'), task('review'), task('done'), task('cancelled')])!;
    expect(p).toEqual({ points: 3, max: 9 });
    expect([progressPercent(p), progressTotal(p)]).toEqual([33, 3]);
  });

  it('revisão reprovada volta para Fazendo: de 2/3 para 1/3', () => {
    const before = kanbanProgress([task('review')])!;
    const after = kanbanProgress([task('doing')])!;
    expect([before.points, after.points, after.max]).toEqual([2, 1, 3]);
    expect(progressPercent(after)).toBe(33);
  });

  it('planejando vale o mesmo que Fazendo', () => {
    expect(STATUS_POINTS.planning).toBe(STATUS_POINTS.doing);
    expect(kanbanProgress([task('planning')])).toEqual({ points: 1, max: 3 });
  });

  it('arredonda para baixo; tudo em Revisão = 66%, nunca 100%', () => {
    expect(progressPercent({ points: 2, max: 3 })).toBe(66);
    expect(progressPercent(kanbanProgress([task('review'), task('review')])!)).toBe(66);
  });

  it('máximo 0 vindo de um servidor estranho não divide por zero', () => {
    expect(progressPercent({ points: 0, max: 0 })).toBe(0);
  });
});

describe('KanbanProgressBar', () => {
  const render = (progress: { points: number; max: number } | null | undefined) =>
    renderToStaticMarkup(createElement(KanbanProgressBar, { progress }));

  it('sem progresso (servidor antigo ou nada na conta) não desenha nada', () => {
    expect(render(null)).toBe('');
    expect(render(undefined)).toBe('');
  });

  it('progressbar com aria e title com a contagem', () => {
    const html = render({ points: 5, max: 9 }); // 55%, 3 tarefas
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="55"');
    expect(html).toContain('aria-label="');
    expect(html).toContain('title="55% · 3 tarefas no cálculo"');
    expect(html).toContain('width:55%');
  });

  it('uma tarefa fica no singular', () => {
    expect(render({ points: 1, max: 3 })).toContain('title="33% · 1 tarefa no cálculo"');
  });
});

describe('TaskService.summary: progress', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** Serviço sobre um tasks.json de dados fixos. */
  async function summaryOf(raw: unknown[]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-progress-'));
    dirs.push(dir);
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(dir, '.myco', 'tasks.json'), JSON.stringify(raw));
    const ana = { id: 'ana-1', name: 'Ana', autonomy: 'acceptEdits', worktree: false } as StaffProfile;
    const svc = new TaskService({
      projectPath: async (id) => (id === 'p' ? dir : null),
      projectIds: async () => ['p'],
      readProfile: async () => ana,
      send: async () => 'sess-1',
      branchFor: async () => 'main',
    });
    return svc.summary();
  }

  const at = '2026-11-01T12:00:00.000Z';
  const raw = (id: string, status: TaskStatus) => ({
    id, title: id, description: '', status, staffId: null, sessionId: null, plan: null, branch: null, pr: null,
    createdAt: at, updatedAt: at, history: [{ at, status, by: 'you' }],
  });

  it('open/review seguem como antes e o progresso soma só A fazer, Fazendo e Revisão', async () => {
    const out = await summaryOf([raw('pronta', 'done'), raw('espera', 'waiting'), raw('a-fazer', 'todo'), raw('fazendo', 'doing'), raw('revisao', 'review')]);
    expect(out).toEqual({ p: { open: 4, review: 1, progress: { points: 3, max: 9 } } });
  });

  it('só Aguardar em aberto: o projeto aparece, mas sem barra', async () => {
    expect(await summaryOf([raw('espera', 'waiting')])).toEqual({ p: { open: 1, review: 0, progress: null } });
  });

  it('só prontas: o projeto fica de fora', async () => {
    expect(await summaryOf([raw('a', 'done')])).toEqual({});
  });
});
