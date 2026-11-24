import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { autoLeft, type AutoCtx } from '../server/commitAuto';
import { planLeftovers } from '../server/commitLeft';
import { recordOwnerWrite } from '../server/ownerEdits';
import type { TaskService } from '../server/tasks';
import type { Task, TaskCommit, TaskCommitLeft, TaskStatus } from '../shared/model';
import { commits, dirty, filesOf, git, project, write, type Project } from './support/commitRepo';
import { removeTemp } from './support/tmp';

// Commit das sobras refeito SOZINHO quando o card que travava fecha (t-c9975b): o que o quadro libera (`autoLeft`, puro) e o fluxo inteiro com git de verdade (gatilho do `done`, `tick`, reinício, falha do git,
// card reaberto, sem laço de tentativas). `planLeftovers` é o `git status` das sobras: contá-lo mostra quando o tick volta a ler o git.

vi.mock('../server/commitLeft', async (importOriginal) => {
  const m = await importOriginal<typeof import('../server/commitLeft')>();
  return { ...m, planLeftovers: vi.fn(m.planLeftovers) };
});
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const plans = vi.mocked(planLeftovers);

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-commitauto-'));
});
afterAll(() => removeTemp(root));

// ---- o que o quadro libera (sem git) ----

const ctx: AutoCtx = { doneAt: () => 'T', busy: () => false };
const card = (id: string, status: TaskStatus, patch: Partial<Task> = {}): Task => ({ id, title: `Card ${id}`, status, history: [], updatedAt: 'T', changedFiles: [], ...patch }) as unknown as Task;
const commitOf = (left: TaskCommitLeft[], patch: Partial<TaskCommit> = {}): TaskCommit => ({ for: 'T', at: 'T', status: 'partial', sha: 'abc1234', files: ['a.ts'], left, note: null, alert: true, ...patch });
const shared = (p: string, by: string): TaskCommitLeft => ({ path: p, why: 'shared', by });
/** A entrega pronta de quem tem sobras; o bloqueador B pronto e com o commit dele gravado. */
const mine = (left: TaskCommitLeft[], patch: Partial<TaskCommit> = {}) => card('A', 'done', { commit: commitOf(left, patch) });
const doneB = (commit: Partial<TaskCommit> = {}) => card('B', 'done', { changedFiles: ['b.ts'], commit: commitOf([], { status: 'none', sha: null, files: [], alert: false, ...commit }) });
const paths = (t: Task, others: Task[], c: AutoCtx = ctx) => autoLeft(t, [t, ...others], c).map((l) => l.path);

describe('autoLeft: o que o automático pode levar (só o quadro)', () => {
  it('libera o arquivo shared quando todo card que o barrava está pronto e com o commit dele gravado', () => {
    expect(paths(mine([shared('b.ts', 'B')]), [doneB()])).toEqual(['b.ts']);
  });

  it('vários bloqueadores: só libera quando TODOS estão prontos', () => {
    const a = mine([shared('b.ts', 'B, E')]);
    expect(paths(a, [doneB(), card('E', 'review', { changedFiles: ['b.ts'] })])).toEqual([]);
    expect(paths(a, [doneB(), card('E', 'done', { changedFiles: ['b.ts'], commit: commitOf([], { status: 'none', files: [], sha: null, alert: false }) })])).toEqual(['b.ts']);
  });

  it('bloqueador cancelado ou apagado: nada sozinho (pode ter deixado mudança no disco)', () => {
    const a = mine([shared('b.ts', 'B')]);
    expect(paths(a, [card('B', 'cancelled', { changedFiles: ['b.ts'] })])).toEqual([]);
    expect(paths(a, [])).toEqual([]);
  });

  it('um card cancelado que também tocou o arquivo segura, mesmo com o `by` pronto', () => {
    expect(paths(mine([shared('b.ts', 'B')]), [doneB(), card('D', 'cancelled', { changedFiles: ['b.ts'] })])).toEqual([]);
  });

  it('card aberto tocando o arquivo (o bloqueador voltou ao trabalho, ou um novo): nada', () => {
    const a = mine([shared('b.ts', 'B')]);
    expect(paths(a, [card('B', 'doing', { changedFiles: ['b.ts'] })])).toEqual([]);
    expect(paths(a, [doneB(), card('E', 'review', { changedFiles: ['b.ts'] })])).toEqual([]);
  });

  it('bloqueador pronto sem o commit dele ainda: com o commit em andamento, sem registro, de outra entrega, que falhou ou que recusou o arquivo, nada', () => {
    const a = mine([shared('b.ts', 'B')]);
    expect(paths(a, [doneB()], { ...ctx, busy: (id) => id === 'B' })).toEqual([]);
    expect(paths(a, [card('B', 'done', { changedFiles: ['b.ts'] })])).toEqual([]);
    expect(paths(a, [doneB({ for: 'OUTRA' })])).toEqual([]);
    expect(paths(a, [doneB({ status: 'failed', note: 'x' })])).toEqual([]);
    expect(paths(a, [doneB({ status: 'partial', left: [{ path: 'b.ts', why: 'owner' }] })])).toEqual([]);
  });

  it.each(['owner', 'staged', 'conflict', 'blocked'] as const)('motivo %s nunca é automático', (why) => {
    expect(paths(mine([{ path: 'b.ts', why }]), [doneB()])).toEqual([]);
  });

  it('segredo na lista: o caminho barra mesmo com o motivo gravado shared', () => {
    expect(paths(mine([shared('.env', 'B')]), [card('B', 'done', { changedFiles: ['.env'], commit: commitOf([], { status: 'none', files: [], sha: null, alert: false }) })])).toEqual([]);
  });

  it('lista mista: só os shared liberados entram, os outros motivos ficam', () => {
    expect(paths(mine([shared('b.ts', 'B'), { path: 'c.ts', why: 'owner' }, { path: 'd.ts', why: 'staged' }]), [doneB()])).toEqual(['b.ts']);
  });

  it('o aviso que o dono ignorou, que o automático já tentou para estas sobras, de entrega anterior ou sem aviso: nada', async () => {
    const { leftKey } = await vi.importActual<typeof import('../server/commitLeft')>('../server/commitLeft');
    const left = [shared('b.ts', 'B')];
    expect(paths(mine(left, { ack: true }), [doneB()])).toEqual([]);
    expect(paths(mine(left, { auto: { key: leftKey({ for: 'T', left }), at: 'T' } }), [doneB()])).toEqual([]);
    expect(paths(mine(left, { auto: { key: 'outra', at: 'T' } }), [doneB()])).toEqual(['b.ts']); // sobras diferentes das da tentativa: vale de novo
    expect(paths(mine(left, { for: 'ANTIGA' }), [doneB()])).toEqual([]);
    expect(paths(mine(left, { alert: false }), [doneB()])).toEqual([]);
    expect(paths(mine(left, { status: 'failed' }), [doneB()])).toEqual([]);
    expect(autoLeft(card('A', 'review', { commit: commitOf(left) }), [doneB()], ctx)).toEqual([]);
  });
});

// ---- o fluxo, com git de verdade ----

/** "Tela A" fica pronta levando a.ts e deixa `left` de fora porque "Tela B" (aberta, em revisão) também os alterou. */
async function scenario(name: string, left: string[] = ['b.ts'], prep?: (p: Project) => Promise<void>) {
  const p = await project(root, name);
  await p.on();
  if (prep) await prep(p);
  else {
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
  }
  const b = await p.task('Tela B', { changedFiles: left, status: 'review' });
  const a = await p.task('Tela A', { changedFiles: ['a.ts', ...left], status: 'review' });
  const t = await p.finish(a);
  return { p, a, b, t };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

/** O card que travava fecha: o commit dele não leva o arquivo (a lista dele já não o tem), então quem leva é o automático das sobras. */
const close = async (s: Scenario, id = s.b) => {
  await s.p.edit(id, { changedFiles: ['x.ts'] });
  return s.p.finish(id);
};
/** O mesmo, mas como se o Club estivesse fora do ar: pronto e com o commit gravado no disco, sem passar pelo gatilho. */
const closeQuietly = async (s: Scenario, id = s.b) => {
  const t = await s.p.get(id);
  await s.p.edit(id, { status: 'done', changedFiles: ['x.ts'], commit: { for: t.updatedAt, at: t.updatedAt, status: 'none', sha: null, files: [], left: [], note: null, alert: false } });
};
const tick = async (svc: TaskService) => {
  await svc.tick(new Date(), 'p');
  await svc.commitsSettled();
};
const head = (p: Project) => git(p.dir, 'rev-parse', '--short', 'HEAD').trim();
const subject = (p: Project) => git(p.dir, 'log', '-1', '--format=%s').trim();

describe('o card que travava fecha: o commit complementar sai sozinho', () => {
  it('commita só as sobras, "Sobras de <título> (<id>)", com sha, for e files do original; o registro marca `auto`', async () => {
    const s = await scenario('auto-ok');
    const original = s.t.commit!;
    expect(original).toMatchObject({ status: 'partial', left: [{ path: 'b.ts', why: 'shared' }], alert: true });
    expect(commits(s.p.dir)).toBe(2);

    await close(s);
    expect(commits(s.p.dir)).toBe(3);
    expect(subject(s.p)).toBe(`Sobras de Tela A (${s.a})`);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(dirty(s.p.dir)).toEqual([]);
    const t = await s.p.get(s.a);
    expect(t.commit).toMatchObject({ sha: original.sha, for: original.for, at: original.at, files: ['a.ts'], status: 'committed', left: [], alert: false });
    expect(t.commit!.redos).toEqual([{ at: expect.any(String), sha: head(s.p), files: ['b.ts'], auto: true }]);
    expect(t.commit!.auto).toBeUndefined();
    expect(t.history.at(-1)).toMatchObject({ by: 'auto', note: expect.stringMatching(/^commit complementar automático [0-9a-f]+: 1 arquivo das sobras do commit /) });
    expect((await s.p.listedTask(s.a)).commitLeft).toBeUndefined();
  });

  it('se o commit do próprio bloqueador já leva o arquivo, não sai um segundo (nem "Sobras")', async () => {
    const s = await scenario('auto-proprio');
    await s.p.finish(s.b); // B ainda tem b.ts na lista: o commit dele leva o arquivo inteiro
    expect(commits(s.p.dir)).toBe(3);
    expect(subject(s.p)).toBe(`Tela B (${s.b})`);
    const t = await s.p.get(s.a);
    expect(t.commit!.redos).toBeUndefined();
    await tick(s.p.svc);
    expect(commits(s.p.dir)).toBe(3);
  });

  it('lista mista: leva o shared e deixa o resto em `left` com o motivo de agora; o índice do dono segue como estava', async () => {
    const s = await scenario('auto-misto', ['b.ts', '.env', 'c.ts'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
      await write(p.dir, '.env', 'SECRET=2\n');
      await write(p.dir, 'c.ts', 'export const c = 2;\n');
      git(p.dir, 'add', 'c.ts'); // staged...
      await write(p.dir, 'c.ts', 'export const c = 3;\n'); // ...com mudança nova por cima (MM)
    });
    await close(s);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(git(s.p.dir, 'diff', '--cached', '--name-only').trim()).toBe('c.ts');
    const t = await s.p.get(s.a);
    expect(t.commit).toMatchObject({ status: 'partial', alert: true });
    expect(t.commit!.left.map((l) => [l.path, l.why])).toEqual([['.env', 'blocked'], ['c.ts', 'staged']]);
    // Sem laço: o que sobrou não é shared, então o tick nem olha o git.
    plans.mockClear();
    await tick(s.p.svc);
    await tick(s.p.svc);
    expect(plans).not.toHaveBeenCalled();
    expect(commits(s.p.dir)).toBe(3);
  });

  it('você gravou o arquivo no editor do Club depois: nada é commitado, o aviso fica `ready` e o automático não tenta de novo', async () => {
    const s = await scenario('auto-owner');
    await write(s.p.dir, 'b.ts', 'export const b = 3;\n');
    await recordOwnerWrite(s.p.dir, 'b.ts', (await fs.stat(path.join(s.p.dir, 'b.ts'))).mtimeMs);
    await close(s);
    expect(commits(s.p.dir)).toBe(2);
    const t = await s.p.get(s.a);
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: s.b }]);
    expect(t.commit!.auto).toEqual({ key: expect.stringMatching(/^[0-9a-f]{32}$/), at: expect.any(String) }); // tentou, sem erro: sem `note`
    expect((await s.p.listedTask(s.a)).commitLeft).toMatchObject({ state: 'ready', canRedo: true });
    plans.mockClear();
    await tick(s.p.svc);
    await tick(s.p.svc);
    expect(plans).not.toHaveBeenCalled();
    expect(commits(s.p.dir)).toBe(2);
  });
});

describe('o que nunca é automático', () => {
  it('bloqueador cancelado: nada é commitado e o aviso fica `ready` para o dono (cancelledBy no estado), sem ler o git no tick', async () => {
    const s = await scenario('auto-cancelado');
    await s.p.edit(s.b, { status: 'cancelled' });
    plans.mockClear();
    await tick(s.p.svc);
    await tick(s.p.svc);
    expect(plans).not.toHaveBeenCalled();
    expect(commits(s.p.dir)).toBe(2);
    const t = await s.p.listedTask(s.a);
    expect(t.commitLeft).toMatchObject({ state: 'ready', canRedo: true, files: [{ path: 'b.ts', cancelledBy: [s.b] }] });
    expect(t.commit!.auto).toBeUndefined();
  });

  it('o dono ignorou o aviso: o automático respeita', async () => {
    const s = await scenario('auto-ack');
    expect(await s.p.svc.ackCommit(`commit:p:${s.a}`)).toBe(true);
    await close(s);
    expect(commits(s.p.dir)).toBe(2);
    expect(dirty(s.p.dir)).toEqual([' M b.ts']);
    expect((await s.p.get(s.a)).commit!.auto).toBeUndefined();
  });

  it('commit automático desligado no projeto: o tick não commita nada', async () => {
    const s = await scenario('auto-desligado');
    await closeQuietly(s);
    await s.p.svc.setBoardCommit('p', { autoCommit: false }, true);
    await tick(s.p.svc);
    expect(commits(s.p.dir)).toBe(2);
    await s.p.on();
    await tick(s.p.svc);
    expect(commits(s.p.dir)).toBe(3);
  });
});

describe('novo card tocando: volta a esperar', () => {
  it('um card abre no arquivo depois: `waiting` sem commit e sem ler o git; quando o último fecha, o commit sai', async () => {
    const s = await scenario('auto-waiting');
    const c = await s.p.task('Tela C', { changedFiles: ['b.ts'], status: 'review' });
    plans.mockClear();
    await close(s); // B fecha, mas C (aberto depois do commit da A) ainda toca b.ts
    expect(commits(s.p.dir)).toBe(2);
    expect(plans).not.toHaveBeenCalled();
    expect((await s.p.listedTask(s.a)).commitLeft).toMatchObject({ state: 'waiting', blockers: [{ id: c, paths: ['b.ts'] }] });

    await close(s, c);
    expect(commits(s.p.dir)).toBe(3);
    expect(subject(s.p)).toBe(`Sobras de Tela A (${s.a})`);
    expect((await s.p.get(s.a)).commit).toMatchObject({ left: [], alert: false });
  });
});

describe('sem laço de tentativas', () => {
  it('sobra commitada à mão: uma tentativa, gravada, e os ticks seguintes não leem o git de novo', async () => {
    const s = await scenario('auto-a-mao');
    git(s.p.dir, 'commit', '-q', '-m', 'à mão', '--', 'b.ts');
    await close(s);
    expect(commits(s.p.dir)).toBe(3);
    expect(plans).toHaveBeenCalled(); // a primeira tentativa leu o git e viu que não havia o que levar
    const t = await s.p.get(s.a);
    expect(t.commit!.auto).toEqual({ key: expect.stringMatching(/^[0-9a-f]{32}$/), at: expect.any(String) });
    expect(t.commit!.redos).toBeUndefined();

    plans.mockClear();
    await tick(s.p.svc);
    await tick(s.p.svc);
    await tick(s.p.svc);
    expect(plans).not.toHaveBeenCalled();
    expect(commits(s.p.dir)).toBe(3);
    expect((await s.p.listedTask(s.a)).commitLeft).toBeUndefined();
  });

  it('o git recusa (hook): o aviso vira `failed` com a linha do git, o botão segue valendo e o automático não repete', async () => {
    const s = await scenario('auto-hook');
    const hook = path.join(s.p.dir, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\necho x >> "$(dirname "$0")/count"\necho "lint falhou: faltou ponto e vírgula" >&2\nexit 1\n', { mode: 0o755 });
    const tries = async () => (await fs.readFile(path.join(path.dirname(hook), 'count'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

    await close(s);
    expect(commits(s.p.dir)).toBe(2);
    expect(await tries()).toBe(1);
    const t = await s.p.get(s.a);
    expect(t.commit!.auto).toMatchObject({ note: expect.stringMatching(/o git recusou o commit.*lint falhou/) });
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: s.b }]); // nada mudou no registro das sobras
    expect(t.history.at(-1)!.note).toMatch(/commit complementar automático das sobras não saiu: .*lint falhou/);
    const view = (await s.p.listedTask(s.a)).commitLeft!;
    expect(view).toMatchObject({ state: 'failed', canRedo: true, note: expect.stringMatching(/lint falhou/) });

    plans.mockClear();
    await tick(s.p.svc);
    await tick(s.p.svc);
    expect(await tries()).toBe(1); // sem nova tentativa
    expect(plans).not.toHaveBeenCalled();

    // O dono corrige o hook e refaz pelo botão: o mesmo estado (o `left` não mudou) não prende o aviso em `failed`.
    await fs.rm(hook);
    const pv = (await s.p.svc.previewLeftovers('p', s.a, true))!;
    expect(pv).toMatchObject({ state: 'failed', canRedo: true, digest: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(pv.files[0]!.diff).toContain('+export const b = 2;');
    const out = (await s.p.svc.redoLeftovers('p', s.a, { digest: pv.digest }, true))!;
    expect(out.ok).toBe(true);
    expect(commits(s.p.dir)).toBe(3);
    const done = await s.p.get(s.a);
    expect(done.commit).toMatchObject({ status: 'committed', left: [], alert: false });
    expect(done.commit!.auto).toBeUndefined();
    expect(done.commit!.redos).toEqual([{ at: expect.any(String), sha: out.sha, files: ['b.ts'] }]); // pelo botão: sem `auto`
  });
});

describe('reinício e card reaberto: nunca dois commits', () => {
  it('o card fechou com o Club fora do ar: o tick de um serviço novo commita uma vez só', async () => {
    const s = await scenario('auto-reinicio');
    await closeQuietly(s);
    expect(commits(s.p.dir)).toBe(2);
    const novo = s.p.restart();
    await tick(novo);
    expect(commits(s.p.dir)).toBe(3);
    expect(subject(s.p)).toBe(`Sobras de Tela A (${s.a})`);
    plans.mockClear();
    await tick(novo);
    await tick(s.p.restart());
    expect(commits(s.p.dir)).toBe(3);
    expect(plans).not.toHaveBeenCalled();
    expect((await s.p.get(s.a)).commit!.redos).toHaveLength(1);
  });

  it('o card das sobras é reaberto antes do bloqueador fechar: nada sozinho; a nova entrega leva o arquivo no commit dela, sem "Sobras"', async () => {
    const s = await scenario('auto-reaberto');
    await s.p.svc.update('p', s.a, { status: 'review' }, true);
    await close(s);
    expect(commits(s.p.dir)).toBe(2);
    expect(dirty(s.p.dir)).toEqual([' M b.ts']);

    const t = await s.p.finish(s.a); // nova entrega: B já fechou, então o commit comum da A leva o b.ts
    expect(commits(s.p.dir)).toBe(3);
    expect(subject(s.p)).toBe(`Tela A (${s.a})`);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['b.ts'], left: [], alert: false });
    expect(t.commit!.redos).toBeUndefined();
    await tick(s.p.svc);
    expect(commits(s.p.dir)).toBe(3);
  });
});
