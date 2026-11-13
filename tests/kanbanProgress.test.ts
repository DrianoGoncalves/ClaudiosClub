import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { kanbanProgress, progressPercent, progressTotal, STAGE_WEIGHTS, STATUS_POINTS, type ProgressTask } from '../shared/kanbanProgress';
import { KanbanProgressBar } from '../client/src/tasks/KanbanProgressBar';
import { TaskService } from '../server/tasks';
import type { StaffProfile, TaskStatus } from '../shared/model';

// Dados simulados. Pesos das etapas: Aguardar 1, A fazer 3, Fazendo 2, Revisão 1; a coluna vale a soma das etapas vencidas
// (Aguardar 0, A fazer 1, Fazendo 4, Revisão 6, Pronto 7); progresso = pontos / (7 × lote);
// lote = abertas + as que ficaram prontas depois da criação da aberta mais antiga.

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}T12:00:00.000Z`;
const task = (status: TaskStatus, createdAt: string, over: Partial<ProgressTask> = {}): ProgressTask => ({ status, createdAt, updatedAt: createdAt, ...over });
/** Pronta: criada em `created`, entrou em Pronto em `at`. */
const done = (created: string, at: string): ProgressTask => task('done', created, { updatedAt: at, history: [{ at, status: 'done' }] });

describe('kanbanProgress', () => {
  it('lote vazio: sem tarefas não há barra', () => {
    expect(kanbanProgress([])).toBeNull();
  });

  it('só prontas: nada a zerar, sem barra', () => {
    expect(kanbanProgress([done(day(1), day(2)), done(day(3), day(4))])).toBeNull();
  });

  it('mistura de status: soma os pontos de cada coluna sobre 7 × o lote', () => {
    const tasks = [
      task('waiting', day(1)), // 0
      task('todo', day(2)), // 1
      task('doing', day(3)), // 4
      task('review', day(4)), // 6
      done(day(5), day(6)), // 7, pronta depois da aberta mais antiga: entra
    ];
    const p = kanbanProgress(tasks)!;
    expect(p).toEqual({ points: 18, max: 35 });
    expect([progressPercent(p), progressTotal(p)]).toEqual([51, 5]);
  });

  it('pronta antiga (antes da aberta mais antiga) fica fora do lote', () => {
    const tasks = [
      done(day(1), day(2)), // fora: ficou pronta antes de a aberta mais antiga existir
      done(day(1), day(9)), // dentro
      task('todo', day(5)),
    ];
    // lote = aberta (1 ponto) + pronta de dia 9 (7 pontos) = 8 / 14
    const p = kanbanProgress(tasks)!;
    expect(p).toEqual({ points: 8, max: 14 });
    expect([progressPercent(p), progressTotal(p)]).toEqual([57, 2]);
  });

  it('a data de pronto vem da última entrada em Pronto no histórico, não do updatedAt', () => {
    const reopened = task('done', day(1), {
      updatedAt: day(20), // mexida depois (ex.: nota), mas ficou pronta antes do lote
      history: [
        { at: day(2), status: 'done' },
        { at: day(3), status: 'doing' },
        { at: day(4), status: 'done' },
      ],
    });
    expect(kanbanProgress([reopened, task('todo', day(10))])).toEqual({ points: 1, max: 7 });
  });

  it('sem histórico usa o updatedAt; pronta no mesmo instante da criação da aberta entra', () => {
    const noHistory: ProgressTask = { status: 'done', createdAt: day(1), updatedAt: day(5) };
    expect(kanbanProgress([noHistory, task('doing', day(5))])).toEqual({ points: 11, max: 14 });
  });

  it('planejando vale o mesmo que Fazendo', () => {
    expect(STATUS_POINTS.planning).toBe(STATUS_POINTS.doing);
    expect(progressPercent(kanbanProgress([task('planning', day(1))])!)).toBe(57);
  });

  it('pesos das etapas: Aguardar 1, A fazer 3, Fazendo 2, Revisão 1 (Pronto = 7)', () => {
    expect(STAGE_WEIGHTS).toEqual({ waiting: 1, todo: 3, doing: 2, review: 1 });
    expect(STATUS_POINTS).toEqual({ waiting: 0, todo: 1, planning: 4, doing: 4, review: 6, done: 7 });
  });

  it('pontos crescentes até Pronto', () => {
    const order: TaskStatus[] = ['waiting', 'todo', 'doing', 'review', 'done'];
    const points = order.map((s) => STATUS_POINTS[s]);
    expect(points).toEqual([...points].sort((a, b) => a - b));
    expect(new Set(points).size).toBe(points.length);
  });

  it('arredonda para baixo: nunca 100% com tarefa aberta', () => {
    const tasks = [task('review', day(1)), ...Array.from({ length: 99 }, (_, i) => done(day(1), day(2 + (i % 20))))];
    const p = kanbanProgress(tasks)!;
    expect(p).toEqual({ points: 699, max: 700 });
    expect(progressPercent(p)).toBe(99);
  });

  it('data ilegível não infla a barra: a pronta fica fora do lote', () => {
    const broken: ProgressTask = { status: 'done', createdAt: 'x', updatedAt: 'x' };
    expect(kanbanProgress([broken, task('todo', day(1))])).toEqual({ points: 1, max: 7 });
  });

  it('máximo 0 vindo de um servidor estranho não divide por zero', () => {
    expect(progressPercent({ points: 0, max: 0 })).toBe(0);
  });
});

describe('KanbanProgressBar', () => {
  const render = (progress: { points: number; max: number } | null | undefined, open: number) =>
    renderToStaticMarkup(createElement(KanbanProgressBar, { progress, open }));

  it('sem progresso (servidor antigo ou nada aberto) não desenha nada', () => {
    expect(render(null, 0)).toBe('');
    expect(render(undefined, 3)).toBe('');
  });

  it('progressbar com aria e title com a contagem', () => {
    const html = render({ points: 35, max: 56 }, 3); // 62%, lote de 8
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="62"');
    expect(html).toContain('aria-label="');
    expect(html).toContain('title="62% · 3 abertas de 8"');
    expect(html).toContain('width:62%');
  });

  it('uma aberta fica no singular', () => {
    expect(render({ points: 7, max: 28 }, 1)).toContain('title="25% · 1 aberta de 4"');
  });
});

describe('TaskService.summary: progress', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  /** Serviço sobre um tasks.json de dados fixos (datas fixas: a regra do lote depende delas). */
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

  const raw = (id: string, status: TaskStatus, created: string, at = created) => ({
    id, title: id, description: '', status, staffId: null, sessionId: null, plan: null, branch: null, pr: null,
    createdAt: created, updatedAt: at, history: [{ at, status, by: 'you' }],
  });

  it('open/review seguem como antes e o progresso soma só o lote (pronta antiga fica fora)', async () => {
    const out = await summaryOf([
      raw('antiga', 'done', day(1), day(2)), // fora do lote
      raw('nova', 'done', day(1), day(9)), // 7
      raw('a-fazer', 'todo', day(5)), // 1
      raw('revisao', 'review', day(6)), // 6
    ]);
    expect(out).toEqual({ p: { open: 2, review: 1, progress: { points: 14, max: 21 } } });
  });

  it('só prontas: o projeto fica de fora, sem barra', async () => {
    expect(await summaryOf([raw('a', 'done', day(1), day(2))])).toEqual({});
  });
});
