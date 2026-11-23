import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { gitDefault, type GitRun, type StatusEntry } from '../server/autoCommit';
import { CommitLeftCache, commitInboxAlerts, commitWaitingCount, deriveCommitLeft, resolveBy, withCommitLeft } from '../server/commitLeft';
import { InboxResolver } from '../server/inboxResolved';
import { commitInboxItem } from '../server/inboxItems';
import { pathKey } from '../server/ownerEdits';
import { commitAlerts } from '../server/tasks';
import { CHANGED_FILES_MAX, COMMIT_LIST_MAX, type Task, type TaskCommit } from '../shared/model';
import { commits, dirty, git, project, write } from './support/commitRepo';
import { removeTemp } from './support/tmp';

// Estado do aviso de commit parcial (t-50cd4f): waiting, ready e failed derivados no servidor, na tarefa e no item da caixa. A derivação pura (sem git) e a leitura real (repositórios git em pasta temporária).

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-commitleft-'));
});
afterAll(() => removeTemp(root));

const card = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: `Card ${id}`, description: '', status: 'review', history: [], createdAt: '2026-11-21T09:00:00.000Z', updatedAt: '2026-11-21T09:00:00.000Z', ...patch }) as Task;
const commitOf = (patch: Partial<TaskCommit> = {}): TaskCommit => ({
  for: '2026-11-21T10:00:00.000Z',
  at: '2026-11-21T10:01:00.000Z',
  status: 'partial',
  sha: 'abc1234',
  files: ['a.ts'],
  left: [{ path: 'b.ts', why: 'shared', by: 't-bbbbbb' }],
  note: null,
  alert: true,
  ...patch,
});
/** O `git status` das sobras: `[caminho, XY]` (padrão " M": alterado no disco). */
const st = (...entries: Array<[string, string?]>): Map<string, StatusEntry> => new Map(entries.map(([p, xy = ' M']) => [pathKey(p), { path: p, x: xy[0]!, y: xy[1]! }]));
const owner = (patch: Partial<Task> = {}) => card('t-aaaaaa', { status: 'done', commit: commitOf(), ...patch });

describe('deriveCommitLeft: sem aviso e failed', () => {
  it('sem aviso de pé (alert falso ou sem commit): nada', () => {
    expect(deriveCommitLeft(owner({ commit: commitOf({ alert: false }) }), [], st(['b.ts']))).toBeNull();
    expect(deriveCommitLeft(owner({ commit: undefined }), [], st(['b.ts']))).toBeNull();
  });

  it('status failed: failed com o motivo do git, sem botão', () => {
    const t = owner({ commit: commitOf({ status: 'failed', sha: null, left: [], note: 'lint falhou' }) });
    expect(deriveCommitLeft(t, [], null)).toEqual({ state: 'failed', sha: null, files: [], blockers: [], canRedo: false, note: 'lint falhou' });
  });

  it('alerta sem sobra (repositório no meio de um merge, lista no teto, HEAD solto): failed', () => {
    const t = owner({ commit: commitOf({ status: 'none', sha: null, left: [], note: 'o repositório está no meio de um merge: nada foi commitado' }) });
    expect(deriveCommitLeft(t, [], null)).toMatchObject({ state: 'failed', canRedo: false, note: expect.stringContaining('merge') });
  });

  it('commit que saiu mas deixou o índice por refazer (alerta sem sobra): failed, e o botão não existe', () => {
    const t = owner({ commit: commitOf({ status: 'committed', left: [], note: 'o índice do git não foi atualizado (x): rode git reset -q para os arquivos do commit' }) });
    expect(deriveCommitLeft(t, [card('t-bbbbbb')], st())).toMatchObject({ state: 'failed', canRedo: false });
  });

  it('failed com sobras listadas: mostra os arquivos, nenhum com botão', () => {
    const t = owner({ commit: commitOf({ status: 'failed', sha: null, left: [{ path: 'b.ts', why: 'owner' }], note: 'hook' }) });
    expect(deriveCommitLeft(t, [], st(['b.ts']))!.files).toEqual([{ path: 'b.ts', why: 'owner', by: [], redo: false }]);
  });
});

describe('deriveCommitLeft: waiting e ready', () => {
  it('waiting: card aberto ainda toca a sobra; lista o card e os arquivos dele', () => {
    const other = card('t-bbbbbb', { title: 'Tela B', status: 'doing', changedFiles: ['b.ts', 'x.ts'] });
    const v = deriveCommitLeft(owner(), [owner(), other], st(['b.ts']))!;
    expect(v).toMatchObject({ state: 'waiting', sha: 'abc1234', canRedo: false });
    expect(v.blockers).toEqual([{ id: 't-bbbbbb', title: 'Tela B', status: 'doing', paths: ['b.ts'] }]);
    expect(v.files).toEqual([{ path: 'b.ts', why: 'shared', by: ['t-bbbbbb'], redo: true }]);
  });

  it('waiting vale para todo motivo de `left`, não só shared (owner, staged, conflict, blocked)', () => {
    const other = card('t-bbbbbb', { changedFiles: ['o.ts', 's.ts', 'c.ts', '.env'] });
    const left = [
      { path: 'o.ts', why: 'owner' as const },
      { path: 's.ts', why: 'staged' as const },
      { path: 'c.ts', why: 'conflict' as const },
      { path: '.env', why: 'blocked' as const },
    ];
    const v = deriveCommitLeft(owner({ commit: commitOf({ left }) }), [other], st(['o.ts'], ['s.ts'], ['c.ts'], ['.env']))!;
    expect(v.state).toBe('waiting');
    expect(v.files.map((f) => f.by)).toEqual([['t-bbbbbb'], ['t-bbbbbb'], ['t-bbbbbb'], ['t-bbbbbb']]);
    expect(v.blockers[0]!.paths).toEqual(['o.ts', 's.ts', 'c.ts', '.env']);
  });

  it('ready: nenhum card aberto toca as sobras e elas seguem com mudança no git', () => {
    const other = card('t-bbbbbb', { changedFiles: ['x.ts'] }); // aberto, mas em outros arquivos
    const v = deriveCommitLeft(owner(), [other], st(['b.ts']))!;
    expect(v).toEqual({ state: 'ready', sha: 'abc1234', files: [{ path: 'b.ts', why: 'shared', by: [], redo: true }], blockers: [], canRedo: true });
  });

  it('card cancelado não trava (conta como fechado), mas fica em cancelledBy: o commit leva o arquivo inteiro', () => {
    const cancelled = card('t-cccccc', { status: 'cancelled', changedFiles: ['b.ts'] });
    const v = deriveCommitLeft(owner(), [cancelled], st(['b.ts']))!;
    expect(v.state).toBe('ready');
    expect(v.blockers).toEqual([]);
    expect(v.files[0]).toMatchObject({ by: [], cancelledBy: ['t-cccccc'], redo: true });
  });

  it('card pronto (done) não trava e nem entra em cancelledBy', () => {
    const v = deriveCommitLeft(owner(), [card('t-dddddd', { status: 'done', changedFiles: ['b.ts'] })], st(['b.ts']))!;
    expect(v.state).toBe('ready');
    expect(v.files[0]!.cancelledBy).toBeUndefined();
  });

  it('card aberto com a lista de arquivos no teto pode ter mais do que ela guarda: trava tudo', () => {
    const full = card('t-eeeeee', { changedFiles: Array.from({ length: CHANGED_FILES_MAX }, (_, i) => `f${i}.ts`) });
    expect(deriveCommitLeft(owner(), [full], st(['b.ts']))!.state).toBe('waiting');
  });

  it('mais de um card: um blocker por card, cada um com os arquivos que toca', () => {
    const left = [
      { path: 'b.ts', why: 'shared' as const },
      { path: 'c.ts', why: 'shared' as const },
    ];
    const b = card('t-bbbbbb', { changedFiles: ['b.ts', 'c.ts'] });
    const c = card('t-cccccc', { status: 'doing', changedFiles: ['c.ts'] });
    const v = deriveCommitLeft(owner({ commit: commitOf({ left }) }), [b, c], st(['b.ts'], ['c.ts']))!;
    expect(v.blockers.map((x) => [x.id, x.paths])).toEqual([
      ['t-bbbbbb', ['b.ts', 'c.ts']],
      ['t-cccccc', ['c.ts']],
    ]);
    expect(v.files.map((f) => f.by)).toEqual([['t-bbbbbb'], ['t-bbbbbb', 't-cccccc']]);
  });

  it('o próprio card não se trava', () => {
    const me = owner({ changedFiles: ['b.ts'] });
    expect(deriveCommitLeft(me, [me], st(['b.ts']))!.state).toBe('ready');
  });
});

describe('deriveCommitLeft: o git', () => {
  it('sobra sem mudança no git (commitada ou desfeita) sai da lista; todas limpas: sem estado', () => {
    const left = [
      { path: 'b.ts', why: 'shared' as const },
      { path: 'c.ts', why: 'shared' as const },
    ];
    const t = owner({ commit: commitOf({ left }) });
    expect(deriveCommitLeft(t, [], st(['c.ts']))!.files.map((f) => f.path)).toEqual(['c.ts']);
    expect(deriveCommitLeft(t, [], st())).toBeNull();
  });

  it('git que não respondeu (null): tudo conta como ainda com mudança; o botão revalida na hora', () => {
    expect(deriveCommitLeft(owner(), [], null)).toMatchObject({ state: 'ready', files: [{ path: 'b.ts', redo: true }] });
  });

  it('segredo pelo caminho: why vira blocked e o botão não o leva, mesmo com outro motivo gravado', () => {
    const t = owner({
      commit: commitOf({
        left: [
          { path: '.env', why: 'shared', by: 't-bbbbbb' },
          { path: 'b.ts', why: 'shared' },
        ],
      }),
    });
    const v = deriveCommitLeft(t, [], st(['.env'], ['b.ts']))!;
    expect(v.files).toEqual([
      { path: '.env', why: 'blocked', by: [], redo: false },
      { path: 'b.ts', why: 'shared', by: [], redo: true },
    ]);
    // Só o segredo sobrando: decisão do dono, mas sem botão.
    const only = deriveCommitLeft(owner({ commit: commitOf({ left: [{ path: '.env', why: 'blocked' }] }) }), [], st(['.env']))!;
    expect(only).toMatchObject({ state: 'ready', canRedo: false });
  });

  it('conflito e staged-com-mudança-por-cima valem pelo estado de agora e o botão não os leva; só staged, sem mudança nova, vai', () => {
    const left = [
      { path: 'b.ts', why: 'shared' as const },
      { path: 'c.ts', why: 'shared' as const },
      { path: 'd.ts', why: 'shared' as const },
    ];
    const v = deriveCommitLeft(owner({ commit: commitOf({ left }) }), [], st(['b.ts', 'UU'], ['c.ts', 'MM'], ['d.ts', 'M ']))!;
    expect(v.files.map((f) => [f.path, f.why, f.redo])).toEqual([
      ['b.ts', 'conflict', false],
      ['c.ts', 'staged', false],
      ['d.ts', 'shared', true],
    ]);
  });

  it('caminho que não é do projeto (com `..`) não se consulta no git e fica bloqueado', () => {
    const v = deriveCommitLeft(owner({ commit: commitOf({ left: [{ path: '../fora.ts', why: 'blocked' }] }) }), [], st())!;
    expect(v.files).toEqual([{ path: '../fora.ts', why: 'blocked', by: [], redo: false }]);
  });

  it('lista de sobras no teto de 100: truncated avisa que pode haver mais', () => {
    const left = Array.from({ length: COMMIT_LIST_MAX }, (_, i) => ({ path: `f${i}.ts`, why: 'shared' as const }));
    const v = deriveCommitLeft(owner({ commit: commitOf({ left }) }), [], null)!;
    expect(v.truncated).toBe(true);
    expect(deriveCommitLeft(owner(), [], null)!.truncated).toBeUndefined();
  });
});

describe('withCommitLeft: a listagem de tarefas (git de verdade)', () => {
  it('waiting enquanto a Tela B toca b.ts; ready quando B é cancelada (com cancelledBy); some quando b.ts é commitado à mão', async () => {
    const p = await project(root, 'lista');
    const { a, b } = await p.partial();
    const w = await p.listedTask(a);
    // A rota usa o serviço (com o cache de verdade): na primeira leitura dá o mesmo.
    expect((await p.svc.commitLeftOf('p', await p.svc.list('p')))!.find((t) => t.id === a)!.commitLeft).toEqual(w.commitLeft);
    expect(await p.svc.commitLeftOf('nao-existe-no-disco', null)).toBeNull();
    expect(w.commitLeft).toMatchObject({ state: 'waiting', sha: w.commit!.sha, canRedo: false });
    expect(w.commitLeft!.blockers).toEqual([{ id: b, title: 'Tela B', status: 'review', paths: ['b.ts'] }]);
    expect((await p.listedTask(b)).commitLeft).toBeUndefined(); // só quem tem aviso

    await p.edit(b, { status: 'cancelled' });
    const r = await p.listedTask(a);
    expect(r.commitLeft).toMatchObject({ state: 'ready', canRedo: true, blockers: [] });
    expect(r.commitLeft!.files).toEqual([{ path: 'b.ts', why: 'shared', by: [], cancelledBy: [b], redo: true }]);

    git(p.dir, 'commit', '-q', '-m', 'sobra à mão', '--', 'b.ts');
    expect((await p.listedTask(a)).commitLeft).toBeUndefined();
    expect(commits(p.dir)).toBe(3);
  });

  it('o estado também vale com o aviso já ignorado (ack): o cartão segue mostrando', async () => {
    const p = await project(root, 'lista-ack');
    const { a } = await p.partial();
    await p.svc.ackCommit(`commit:p:${a}`);
    const t = await p.listedTask(a);
    expect(t.commit!.ack).toBe(true);
    expect(t.commitLeft!.state).toBe('waiting');
  });

  it('sem nenhum aviso: a mesma lista, sem chamar o git', async () => {
    const calls: string[][] = [];
    const spy: GitRun = (cwd, args, opts) => (calls.push(args), gitDefault(cwd, args, opts));
    const tasks = [card('t-aaaaaa'), card('t-bbbbbb', { status: 'done', commit: commitOf({ alert: false }) })];
    expect(await withCommitLeft(tasks, 'p', root, { git: spy, cache: new CommitLeftCache() })).toBe(tasks);
    expect(calls).toEqual([]);
  });

  it('cache: duas leituras seguidas consultam o git uma vez; passado o TTL, de novo', async () => {
    const p = await project(root, 'cache');
    await p.partial();
    let now = 1_000_000;
    const cache = new CommitLeftCache(() => now);
    let status = 0;
    const spy: GitRun = (cwd, args, opts) => (args[0] === 'status' && status++, gitDefault(cwd, args, opts));
    const list = (await p.svc.list('p'))!;
    await withCommitLeft(list, 'p', p.dir, { git: spy, cache });
    await withCommitLeft(list, 'p', p.dir, { git: spy, cache });
    expect(status).toBe(1);
    now += 31_000;
    await withCommitLeft(list, 'p', p.dir, { git: spy, cache });
    expect(status).toBe(2);
  });

  it('git que falha: a lista sai com o estado "não sei" (ready), sem lançar', async () => {
    const p = await project(root, 'git-falha');
    const { a, b } = await p.partial();
    const boom: GitRun = async () => {
      throw new Error('git quebrou');
    };
    const out = await withCommitLeft((await p.svc.list('p'))!, 'p', p.dir, { git: boom, cache: new CommitLeftCache() });
    expect(out.find((t) => t.id === a)!.commitLeft).toMatchObject({ state: 'waiting' }); // o card B ainda toca: isso nem precisa do git
    await p.edit(b, { status: 'cancelled' });
    const again = await withCommitLeft((await p.svc.list('p'))!, 'p', p.dir, { git: boom, cache: new CommitLeftCache() });
    expect(again.find((t) => t.id === a)!.commitLeft).toMatchObject({ state: 'ready', files: [{ path: 'b.ts' }] });
  });

  it('reinício: um serviço novo sobre o mesmo disco dá o mesmo estado (nada fica só na memória)', async () => {
    const p = await project(root, 'reinicio');
    const { a, b } = await p.partial();
    const before = (await p.listedTask(a)).commitLeft;
    const fresh = p.restart();
    expect((await p.listedTask(a, fresh)).commitLeft).toEqual(before);
    await p.edit(b, { status: 'cancelled' });
    expect((await p.listedTask(a, p.restart())).commitLeft).toMatchObject({ state: 'ready' });
  });

  it('commit que falhou (hook): failed na tarefa, com o motivo do git', async () => {
    const p = await project(root, 'falhou');
    await p.on();
    const hook = path.join(p.dir, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\necho "lint falhou" >&2\nexit 1\n', { mode: 0o755 });
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    await p.finish(id);
    const t = await p.listedTask(id);
    expect(t.commit!.status).toBe('failed');
    expect(t.commitLeft).toMatchObject({ state: 'failed', canRedo: false, note: expect.stringContaining('lint falhou') });
  });
});

describe('a caixa: item, filtro e contagem', () => {
  const place = { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' };

  it('ready: continua kind error (o client não muda), o tom sai de autoCommit.state, e o item traz sha, arquivos, motivo e quem trava (ninguém)', async () => {
    const p = await project(root, 'item-ready');
    const { a, b } = await p.partial();
    await p.edit(b, { status: 'cancelled' });
    const t = await p.listedTask(a);
    const item = commitInboxItem({ task: t, commit: t.commit! }, place);
    expect(item).toMatchObject({ id: `commit:p:${a}`, kind: 'error', staffId: null, name: 'Ana', at: t.commit!.at });
    expect(item.summary).toContain('refazer o commit das sobras');
    expect(item.autoCommit).toEqual({
      taskId: a,
      taskTitle: 'Tela A',
      status: 'partial',
      sha: t.commit!.sha,
      state: 'ready',
      files: [{ path: 'b.ts', why: 'shared', by: [], cancelledBy: [b], redo: true }],
      blockers: [],
      canRedo: true,
    });
  });

  it('failed: o item leva o estado failed e o motivo, sem pedir decisão', () => {
    const t = owner({ commit: commitOf({ status: 'failed', sha: null, left: [], note: 'lint falhou' }) });
    const item = commitInboxItem({ task: { ...t, commitLeft: deriveCommitLeft(t, [], null)! }, commit: t.commit! }, place);
    expect(item.kind).toBe('error');
    expect(item.autoCommit).toMatchObject({ state: 'failed', note: 'lint falhou', canRedo: false, sha: null });
    expect(item.summary).not.toContain('refazer o commit das sobras');
  });

  it('sem estado (o problema passou): o item não leva state, e quem resolve é o resolvedAt de sempre', () => {
    const t = owner();
    const item = commitInboxItem({ task: t, commit: t.commit! }, place);
    expect(item.autoCommit).toEqual({ taskId: 't-aaaaaa', taskTitle: 'Card t-aaaaaa', status: 'partial', sha: 'abc1234' });
  });

  it('a lista da caixa tira o waiting e mantém ready e failed', () => {
    const mk = (id: string, state: 'waiting' | 'ready' | 'failed') => {
      const t = card(id, { status: 'done', commit: commitOf(), commitLeft: { state, sha: 'x', files: [], blockers: [], canRedo: false } });
      return { task: t, commit: t.commit! };
    };
    const alerts = [mk('t-111111', 'waiting'), mk('t-222222', 'ready'), mk('t-333333', 'failed')];
    expect(commitInboxAlerts(alerts).map((a) => a.task.id)).toEqual(['t-222222', 't-333333']);
  });

  it('commitAlerts + filtro, de ponta a ponta: o card que espera B não vira item; depois que B é cancelada, vira', async () => {
    const p = await project(root, 'caixa-fim');
    const { a, b } = await p.partial();
    expect(commitInboxAlerts(commitAlerts(await p.listed())).map((x) => x.task.id)).toEqual([]);
    await p.edit(b, { status: 'cancelled' });
    expect(commitInboxAlerts(commitAlerts(await p.listed())).map((x) => x.task.id)).toEqual([a]);
  });

  it('a contagem do waiting só conta o que espera e ainda não foi ignorado', () => {
    const waiting = (id: string, ack = false) => card(id, { status: 'done', commit: commitOf({ ack }), commitLeft: { state: 'waiting', sha: 'x', files: [], blockers: [], canRedo: false } });
    const ready = card('t-999999', { status: 'done', commit: commitOf(), commitLeft: { state: 'ready', sha: 'x', files: [], blockers: [], canRedo: true } });
    expect(commitWaitingCount([waiting('t-111111'), waiting('t-222222'), waiting('t-333333', true), ready, card('t-444444')])).toBe(2);
  });

  it('o resolvedAt olha as sobras: commitadas à mão, o item some do pendente mesmo com outro arquivo da tarefa sujo', async () => {
    const p = await project(root, 'resolvido');
    const { a, b } = await p.partial();
    await p.edit(b, { status: 'cancelled' });
    await write(p.dir, 'a.ts', 'export const a = 3;\n'); // a.ts, que o commit levou, voltou a ficar sujo por outro motivo
    const t = await p.get(a);
    const resolver = new InboxResolver();
    const item = () => commitInboxItem({ task: t, commit: t.commit! }, { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' });
    expect((await resolver.commit(item(), p.dir, resolveBy(t)))?.resolvedAt).toBeUndefined(); // b.ts ainda sujo
    git(p.dir, 'commit', '-q', '-m', 'sobra', '--', 'b.ts');
    const done = await new InboxResolver().commit(item(), p.dir, resolveBy(t));
    expect(done?.resolvedAt).toBeDefined();
    expect(dirty(p.dir)).toEqual([' M a.ts']);
  });

  it('resolveBy: aviso de sobras usa só `left`; aviso de erro usa os arquivos da tarefa', () => {
    expect(resolveBy(owner({ changedFiles: ['a.ts', 'b.ts'] }))).toEqual({ changedFiles: ['b.ts'] });
    const failed = owner({ changedFiles: ['a.ts', 'b.ts'], commit: commitOf({ status: 'failed', left: [], note: 'x' }) });
    expect(resolveBy(failed)).toBe(failed);
  });
});

describe('rotas: só a tela', () => {
  const path1 = '/api/projects/p/tasks/t-abc123/commit-leftovers';

  it('funcionário não faz o POST (fora da lista de apiPolicy) e a sandbox do Codex não alcança nenhuma das duas', () => {
    expect(staffMayPost(path1)).toBe(false);
    expect(sandboxVerdict('POST', path1, 'p')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', path1, 'p')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/inbox/commit-waiting', 'p')).toMatchObject({ status: 403 });
  });
});
