import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { GitRun } from '../server/autoCommit';
import { CommitLeftCache, GIT_READ_SLOTS, withCommitLeft } from '../server/commitLeft';
import type { Task, TaskCommit } from '../shared/model';

// Rajada de git do aviso de sobras (t-56749a): `withCommitLeft` rodava `inspectRepo` (~10 git) mais um `status` POR card com aviso, todos ao mesmo tempo, a cada TTL e em 3 chamadores (539 git por ciclo
// com 49 cards, 49 de uma vez). Aqui o git é um falso que só conta e mede o pico: o que importa é quantos processos saem, não o que o repositório diz.

const dir = os.tmpdir();
const card = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, description: '', status: 'done', history: [], createdAt: '2026-11-21T09:00:00.000Z', updatedAt: '2026-11-21T09:00:00.000Z', ...patch }) as Task;
const commitOf = (patch: Partial<TaskCommit> = {}): TaskCommit => ({ for: '2026-11-21T10:00:00.000Z', at: '2026-11-21T10:01:00.000Z', status: 'partial', sha: 'abc1234', files: ['a.ts'], left: [], note: null, alert: true, ...patch });
const id = (i: number) => `t-${String(i).padStart(6, '0')}`;
const paths = (i: number) => [1, 2, 3].map((n) => `f${i}-${n}.ts`);
/** `n` cards com aviso de sobras (3 arquivos cada), os `live` primeiros ainda não ignorados e o resto com ack. */
const board = (n: number, live: number): Task[] =>
  Array.from({ length: n }, (_, i) => card(id(i), { commit: commitOf({ ack: i >= live, left: paths(i).map((p) => ({ path: p, why: 'shared' as const, by: 't-zzzzzz' })) }) }));

/** Um git falso que responde como um repositório limpo em condição (todo arquivo pedido aparece alterado), conta cada chamada e mede o pico de chamadas ao mesmo tempo. */
function fakeGit(fail = false) {
  const calls: string[][] = [];
  let inflight = 0;
  let peak = 0;
  const run: GitRun = async (_cwd, args) => {
    calls.push(args);
    inflight++;
    peak = Math.max(peak, inflight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (fail) throw new Error('git quebrou');
      if (args.includes('--is-inside-work-tree')) return 'true\n';
      if (args.includes('--verify')) return 'abc123\n';
      if (args[0] === 'symbolic-ref') return 'refs/heads/main\n';
      if (args.includes('--git-path')) return `.git/${args[2]}\n`;
      if (args.includes('--show-prefix')) return '\n';
      if (args[0] === 'status') return args.slice(args.indexOf('--') + 1).map((p) => ` M ${p}\0`).join('');
      return '';
    } finally {
      inflight--;
    }
  };
  const count = (pick: (c: string[]) => boolean) => calls.filter(pick).length;
  return { run, calls, peak: () => peak, inspects: () => count((c) => c.includes('--is-inside-work-tree')), statuses: () => count((c) => c[0] === 'status') };
}

describe('withCommitLeft: aviso ignorado não gasta git', () => {
  it('só quem ainda não foi ignorado é lido: os arquivos dos cards com ack nem entram no status, e o card sai como veio', async () => {
    const tasks = board(49, 9);
    const g = fakeGit();
    const out = await withCommitLeft(tasks, 'p', dir, { git: g.run, cache: new CommitLeftCache() });
    const asked = g.calls.filter((c) => c[0] === 'status').flatMap((c) => c.slice(c.indexOf('--') + 1));
    expect(asked.sort()).toEqual(tasks.slice(0, 9).flatMap((_, i) => paths(i)).sort());
    expect(out.slice(0, 9).every((t) => t.commitLeft?.state === 'ready')).toBe(true);
    for (let i = 9; i < 49; i++) expect(out[i]).toBe(tasks[i]);
  });

  it('todos com ack: zero git e a mesma lista', async () => {
    const tasks = board(49, 0);
    const g = fakeGit();
    expect(await withCommitLeft(tasks, 'p', dir, { git: g.run, cache: new CommitLeftCache() })).toBe(tasks);
    expect(g.calls).toEqual([]);
  });
});

describe('withCommitLeft: o repositório é lido uma vez por chamada, não por card', () => {
  it('9 cards: um inspectRepo e um status (11 git, antes eram 99), e cada card só vê os seus arquivos', async () => {
    const g = fakeGit();
    const out = await withCommitLeft(board(9, 9), 'p', dir, { git: g.run, cache: new CommitLeftCache() });
    expect([g.inspects(), g.statuses(), g.calls.length]).toEqual([1, 1, 11]);
    out.forEach((t, i) => expect(t.commitLeft?.files.map((f) => f.path)).toEqual(paths(i)));
  });

  it('49 cards sem ack (147 arquivos): um inspectRepo e os status em lotes de 100, não 49', async () => {
    const g = fakeGit();
    await withCommitLeft(board(49, 49), 'p', dir, { git: g.run, cache: new CommitLeftCache() });
    expect([g.inspects(), g.statuses()]).toEqual([1, 2]);
  });

  it('chamadores ao mesmo tempo (lista, caixa e contagem) dividem a mesma leitura', async () => {
    const g = fakeGit();
    const cache = new CommitLeftCache();
    const tasks = board(9, 9);
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => withCommitLeft(tasks, 'p', dir, { git: g.run, cache })));
    expect([g.inspects(), g.statuses()]).toEqual([1, 1]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('o git que falha dá "não sei" ao card e a leitura em curso não trava o resto: a vaga é devolvida', async () => {
    const bad = fakeGit(true);
    const out = await withCommitLeft(board(3, 3), 'p', dir, { git: bad.run, cache: new CommitLeftCache() });
    expect(out.map((t) => t.commitLeft?.state)).toEqual(['ready', 'ready', 'ready']);
    // Muitas leituras falhando juntas passam pela fila inteira; se alguma vaga vazasse, esta chamada nunca voltaria.
    await Promise.all(Array.from({ length: 8 }, (_, i) => withCommitLeft(board(3, 3), `x${i}`, dir, { git: bad.run, cache: new CommitLeftCache() })));
    const g = fakeGit();
    await withCommitLeft(board(3, 3), 'p', dir, { git: g.run, cache: new CommitLeftCache() });
    expect(g.statuses()).toBe(1);
  });
});

describe('withCommitLeft: concorrência limitada', () => {
  it('12 projetos lidos juntos (a caixa lê todos): no máximo GIT_READ_SLOTS git ao mesmo tempo, e todos terminam', async () => {
    const g = fakeGit();
    const outs = await Promise.all(Array.from({ length: 12 }, (_, i) => withCommitLeft(board(9, 9), `p${i}`, dir, { git: g.run, cache: new CommitLeftCache() })));
    expect(g.calls.length).toBe(12 * 11);
    expect(g.peak()).toBeLessThanOrEqual(GIT_READ_SLOTS);
    expect(g.peak()).toBeGreaterThan(1); // limita, não serializa
    expect(outs.every((o) => o.every((t) => t.commitLeft?.state === 'ready'))).toBe(true);
  });
});
