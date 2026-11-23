import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { commitMessage } from '../server/autoCommit';
import { commitInboxItem } from '../server/inboxItems';
import { MAX_OWNER_EDITS, readOwnerWrites, recordOwnerWrite, writeOwnerFile } from '../server/ownerEdits';
import { TaskError, TaskForbiddenError, TaskService, commitAlerts, readTasks } from '../server/tasks';
import { CHANGED_FILES_MAX, type StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// Commit automático por tarefa pronta (t-33bd83): um commit local só com os arquivos da tarefa, sem varrer o trabalho de outras tarefas abertas, sem mexer no que você deixou staged
// e sem esvaziar o `git diff HEAD` de quem está em revisão. Repositórios git de verdade, em pasta temporária.

// Dezenas de chamadas ao git por teste: sob carga (outra suíte rodando) passam dos 5 s padrão.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-autocommit-'));
});
afterAll(() => removeTemp(root));

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
/** `git status` sem a pasta do Club (tasks.json e afins ficam sem rastreio em todo teste). */
const dirty = (dir: string) => git(dir, 'status', '--porcelain', '--', '.', ':(exclude).myco').split(/\r?\n/).filter(Boolean).sort();
const commits = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
const filesOf = (dir: string, rev = 'HEAD') => git(dir, 'show', '--name-only', '--format=', rev).split(/\r?\n/).filter(Boolean).sort();
const write = (dir: string, rel: string, text: string) => fs.writeFile(path.join(dir, rel), text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Opts {
  /** O projeto é a subpasta `proj` do repositório. */
  sub?: boolean;
  /** A ficha da Ana trabalha numa worktree própria. */
  worktree?: boolean;
}

/** Repositório com a.ts, b.ts, c.ts, `.env` (rastreado à força), `my file.ts` e `a[1].ts` commitados; o Club liga o commit automático depois, com `on()`. */
async function project(name: string, opts: Opts = {}) {
  const repo = path.join(root, name);
  const dir = opts.sub ? path.join(repo, 'proj') : repo;
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const f of ['a.ts', 'b.ts', 'c.ts', '.env', 'my file.ts', 'a[1].ts']) await write(dir, f, `export const v = 1; // ${f}\n`);
  git(repo, 'add', '-f', '--', ...['a.ts', 'b.ts', 'c.ts', '.env', 'my file.ts', 'a[1].ts'].map((f) => (opts.sub ? `proj/${f}` : f)));
  git(repo, 'commit', '-q', '-m', 'base');

  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: !!opts.worktree } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };
  const svc = new TaskService({
    projectPath: async () => dir,
    projectIds: async () => ['p'],
    readProfile: async (_p, id) => people[id] ?? null,
    send: async () => 's-1',
    sendTo: async (_p, session) => session,
    branchFor: async () => null,
    isWorking: () => false,
    isSessionWorking: () => false,
    lastText: () => null,
    notify: async () => {},
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const file = path.join(dir, '.myco', 'tasks.json');
  /** Cria a tarefa e grava o que a detecção de edição (`noteTaskEdit`) gravaria. */
  const task = async (title: string, patch: Record<string, unknown> = {}) => {
    const t = (await svc.create('p', { title, description: `Pedido de ${title}`, staffId: 'ana-1' }))!;
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((x) => x.id === t.id)!, patch);
    await fs.writeFile(file, JSON.stringify(all));
    return t.id;
  };
  const get = async (id: string) => (await readTasks(dir)).find((t) => t.id === id)!;
  /** Fica pronta pela tela (a via do dono) e espera o commit, que corre em segundo plano. */
  const finish = async (id: string) => {
    await svc.update('p', id, { status: 'done' }, true);
    await svc.commitsSettled();
    return get(id);
  };
  const on = () => svc.setBoardCommit('p', { autoCommit: true }, true);
  return { repo, dir, svc, task, get, finish, on };
}

describe('commit automático: o que entra', () => {
  it('desligado (o padrão) não faz nada: nenhum commit e nada gravado na tarefa', async () => {
    const p = await project('desligado');
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: false });
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(commits(p.dir)).toBe(1);
    expect(t.commit).toBeUndefined();
    expect(dirty(p.dir)).toEqual([' M a.ts']);
  });

  it('commita só os arquivos da tarefa, com a mensagem "<título> (<id>)", e deixa o resto como estava', async () => {
    const p = await project('so-dela');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n'); // da tarefa
    await write(p.dir, 'n.ts', 'export const n = 1;\n'); // da tarefa, novo
    await write(p.dir, 'b.ts', 'export const b = 2;\n'); // de ninguém que o Club conheça: fica
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'n.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(commits(p.dir)).toBe(2);
    expect(git(p.dir, 'log', '-1', '--format=%s').trim()).toBe(`Tela A (${id})`);
    expect(filesOf(p.dir)).toEqual(['a.ts', 'n.ts']);
    expect(dirty(p.dir)).toEqual([' M b.ts']); // o que não é da tarefa segue sujo, e o commit não deixou lixo no índice
    expect(t.commit).toMatchObject({ status: 'committed', sha: git(p.dir, 'rev-parse', '--short', 'HEAD').trim(), files: ['a.ts', 'n.ts'], left: [], note: null, alert: false });
    expect(t.history.at(-1)).toMatchObject({ by: 'auto', note: expect.stringContaining('commit local') });
    expect(commitAlerts([t])).toEqual([]);
  });

  it('arquivo que outra tarefa aberta também alterou fica de fora e é registrado; o diff dela segue inteiro', async () => {
    const p = await project('compartilhado');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'review' });
    await p.task('Tela C', { changedFiles: ['a.ts', 'b.ts'], status: 'done' }); // encerrada não conta
    await p.task('Tela D', { changedFiles: ['b.ts'], status: 'cancelled' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
    expect(t.commit).toMatchObject({ status: 'partial', files: ['a.ts'], alert: true });
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: other }]);
    expect(t.history.at(-1)!.note).toBe(`commit parcial ${t.commit!.sha}: 1 arquivo; de fora: b.ts (também alterado por ${other}, que ainda não terminou)`);
    // A revisão da outra tarefa usa `git diff HEAD`: continua com o diff dela.
    expect(git(p.dir, 'diff', 'HEAD', '--name-only').trim()).toBe('b.ts');
    expect(commitAlerts([t])).toHaveLength(1);
  });

  it('arquivo barrado (segredo, dependência) fica de fora mesmo rastreado e com mudança', async () => {
    const p = await project('barrado');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, '.env', 'SECRET=2\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts', '.env', '../fora.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
    expect(t.commit!.left.map((l) => l.path).sort()).toEqual(['../fora.ts', '.env']);
    expect(t.commit!.left.every((l) => l.why === 'blocked')).toBe(true);
    expect(dirty(p.dir)).toEqual([' M .env']);
  });

  it('caminhos literais: espaço, colchetes e asterisco no nome valem como são, sem varrer os vizinhos', async () => {
    const p = await project('literal');
    await p.on();
    await write(p.dir, 'my file.ts', 'export const v = 2;\n');
    await write(p.dir, 'a[1].ts', 'export const v = 2;\n');
    await write(p.dir, '[abc].ts', 'export const v = 2;\n'); // como padrão, `[abc].ts` casaria com a.ts, b.ts e c.ts
    await write(p.dir, 'a.ts', 'export const v = 2;\n');
    await write(p.dir, 'b.ts', 'export const v = 2;\n');
    const id = await p.task('Nomes', { changedFiles: ['my file.ts', 'a[1].ts', '[abc].ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['[abc].ts', 'a[1].ts', 'my file.ts']);
    expect(t.commit).toMatchObject({ status: 'committed' });
    expect(dirty(p.dir)).toEqual([' M a.ts', ' M b.ts']);
  });

  it('exclusão e renome: o que sumiu e o que chegou entram juntos; exclusão sozinha também', async () => {
    const p = await project('renome');
    await p.on();
    await fs.rename(path.join(p.dir, 'a.ts'), path.join(p.dir, 'novo.ts'));
    await fs.rm(path.join(p.dir, 'c.ts'));
    const id = await p.task('Renomear', { changedFiles: ['a.ts', 'novo.ts', 'c.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'committed' });
    expect(git(p.dir, 'show', '--name-status', '--format=', '-M', 'HEAD').split(/\r?\n/).filter(Boolean).sort()).toEqual(['D\tc.ts', 'R100\ta.ts\tnovo.ts']);
    expect(dirty(p.dir)).toEqual([]);
  });

  it('conflito (git stash pop): o arquivo em conflito fica de fora, o resto entra', async () => {
    const p = await project('conflito');
    await p.on();
    await write(p.dir, 'c.ts', 'export const v = "Y";\n');
    git(p.dir, 'stash');
    await write(p.dir, 'c.ts', 'export const v = "Z";\n');
    git(p.dir, 'commit', '-qam', 'z');
    expect(() => git(p.dir, 'stash', 'pop')).toThrow(); // conflito, sem MERGE_HEAD
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'c.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
    expect(t.commit!.left).toEqual([{ path: 'c.ts', why: 'conflict' }]);
    expect(dirty(p.dir)).toContain('UU c.ts');
  });

  it('projeto numa subpasta do repositório: os caminhos da tarefa são os do projeto', async () => {
    const p = await project('subpasta', { sub: true });
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.repo, 'fora.ts', 'export const f = 1;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts'] });
    expect(filesOf(p.repo)).toEqual(['proj/a.ts']);
    expect(git(p.repo, 'status', '--porcelain', '--', ':(exclude)proj/.myco').trim()).toBe('?? fora.ts');
  });
});

describe('commit automático: você mexeu no arquivo', () => {
  it('gravado por você no editor do Club DEPOIS da última edição da tarefa: fica de fora, "editado por você"', async () => {
    const p = await project('dono-depois');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n'); // a tarefa mexeu
    await sleep(20);
    const st = await fs.stat(path.join(p.dir, 'b.ts'));
    await writeOwnerFile(p.dir, { path: 'b.ts', content: 'export const b = "dono";\n', baseMtimeMs: st.mtimeMs }); // e você mexeu depois
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
    expect(t.commit).toMatchObject({ status: 'partial', alert: true });
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'owner' }]);
    expect(t.history.at(-1)!.note).toContain('b.ts (editado por você)');
    expect(dirty(p.dir)).toEqual([' M b.ts']);
    expect(await fs.readFile(path.join(p.dir, 'b.ts'), 'utf8')).toBe('export const b = "dono";\n');
  });

  it('gravado por você ANTES de a tarefa mexer de novo: entra (a última mão foi a da tarefa)', async () => {
    const p = await project('dono-antes');
    await p.on();
    const st = await fs.stat(path.join(p.dir, 'b.ts'));
    await writeOwnerFile(p.dir, { path: 'b.ts', content: 'export const b = "dono";\n', baseMtimeMs: st.mtimeMs });
    await sleep(30);
    await write(p.dir, 'b.ts', 'export const b = "tarefa";\n');
    const id = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['b.ts'], left: [] });
    expect(filesOf(p.dir)).toEqual(['b.ts']);
  });

  it('o editor registra o caminho, o mtime e a hora; o registro tem teto e aguenta arquivo torto', async () => {
    const p = await project('registro');
    const st = await fs.stat(path.join(p.dir, 'a.ts'));
    const out = await writeOwnerFile(p.dir, { path: './a.ts', content: 'x\n', baseMtimeMs: st.mtimeMs });
    const all = await readOwnerWrites(p.dir);
    const w = all[process.platform === 'win32' ? 'a.ts' : 'a.ts']!;
    expect(w.mtimeMs).toBe(out.mtimeMs);
    expect(Date.parse(w.at)).toBeGreaterThan(Date.now() - 60_000);
    // Segredo: a gravação é recusada e nada é registrado.
    await expect(writeOwnerFile(p.dir, { path: '.env', content: 'x', baseMtimeMs: 1 })).rejects.toThrow();
    expect(Object.keys(await readOwnerWrites(p.dir))).toEqual(['a.ts']);
    // Teto: passou de MAX_OWNER_EDITS, saem as mais antigas.
    for (let i = 0; i < MAX_OWNER_EDITS + 2; i++) await recordOwnerWrite(p.dir, `pasta/arq${i}.ts`, i, new Date(Date.now() + i * 1000));
    const capped = Object.keys(await readOwnerWrites(p.dir));
    expect(capped).toHaveLength(MAX_OWNER_EDITS);
    expect(capped).not.toContain('a.ts');
    expect(capped).toContain(`pasta/arq${MAX_OWNER_EDITS + 1}.ts`);
    await fs.writeFile(path.join(p.dir, '.myco', 'owner-edits.json'), '{ torto');
    expect(await readOwnerWrites(p.dir)).toEqual({});
  }, 60_000);
});

describe('commit automático: o índice do git é seu', () => {
  it('o que você deixou staged não entra e segue staged; o arquivo da tarefa que você também staged entra e o índice o acompanha', async () => {
    const p = await project('staged');
    await p.on();
    await write(p.dir, 'c.ts', 'export const c = 2;\n');
    git(p.dir, 'add', 'c.ts'); // staged por você, de outro assunto
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    git(p.dir, 'add', 'a.ts'); // staged por você, e é da tarefa
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
    // `c.ts` segue staged (e só ele); `a.ts` não aparece mais como mudança, nem para frente nem ao contrário; `b.ts` segue sujo.
    expect(git(p.dir, 'diff', '--cached', '--name-only').trim()).toBe('c.ts');
    expect(dirty(p.dir)).toEqual([' M b.ts', 'M  c.ts']);
  });

  it('arquivo da tarefa staged por você e com mudança nova por cima (MM) fica de fora', async () => {
    const p = await project('staged-mm');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    git(p.dir, 'add', 'a.ts');
    await write(p.dir, 'a.ts', 'export const a = 3;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(filesOf(p.dir)).toEqual(['b.ts']);
    expect(t.commit!.left).toEqual([{ path: 'a.ts', why: 'staged' }]);
    expect(dirty(p.dir)).toEqual(['MM a.ts']);
  });

  it('o hook do repositório roda de verdade, com o índice temporário: ele só vê os arquivos da tarefa', async () => {
    const p = await project('hook-ok');
    await p.on();
    const hook = path.join(p.dir, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\ngit diff --cached --name-only > "$(git rev-parse --git-dir)/hook-saw"\n', { mode: 0o755 });
    await write(p.dir, 'c.ts', 'export const c = 2;\n');
    git(p.dir, 'add', 'c.ts');
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'committed' });
    expect((await fs.readFile(path.join(p.dir, '.git', 'hook-saw'), 'utf8')).trim()).toBe('a.ts');
  });

  it('hook que recusa vira aviso: a tarefa segue pronta, nada é commitado e o índice fica como estava', async () => {
    const p = await project('hook-falha');
    await p.on();
    const hook = path.join(p.dir, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\necho "lint falhou: faltou ponto e vírgula" >&2\nexit 1\n', { mode: 0o755 });
    await write(p.dir, 'c.ts', 'export const c = 2;\n');
    git(p.dir, 'add', 'c.ts');
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.status).toBe('done');
    expect(commits(p.dir)).toBe(1);
    expect(t.commit).toMatchObject({ status: 'failed', sha: null, alert: true });
    expect(t.commit!.note).toContain('lint falhou');
    expect(t.history.at(-1)!.note).toContain('commit automático falhou');
    expect(dirty(p.dir)).toEqual([' M a.ts', 'M  c.ts']);
    const item = commitInboxItem(commitAlerts([t])[0]!, { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' });
    expect(item).toMatchObject({ id: `commit:p:${id}`, kind: 'error', staffId: null, autoCommit: { taskId: id, status: 'failed' } });
    expect(item.summary).toContain('o commit automático falhou: lint falhou');
  });
});

describe('commit automático: quando não commita', () => {
  it('lista ausente ou vazia: não commita e registra o motivo, sem aviso na caixa', async () => {
    const p = await project('vazia');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const sem = await p.finish(await p.task('Sem lista', { status: 'review' }));
    const vazia = await p.finish(await p.task('Lista vazia', { changedFiles: [], status: 'review' }));
    for (const t of [sem, vazia]) expect(t.commit).toMatchObject({ status: 'none', sha: null, files: [], alert: false, note: expect.stringContaining('não tem lista de arquivos') });
    expect(commits(p.dir)).toBe(1);
    expect(dirty(p.dir)).toEqual([' M a.ts']);
  });

  it('lista no limite (truncada): não commita, avisa na caixa', async () => {
    const p = await project('truncada');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const files = ['a.ts', ...Array.from({ length: CHANGED_FILES_MAX - 1 }, (_, i) => `f${i}.ts`)];
    const t = await p.finish(await p.task('Muita coisa', { changedFiles: files, status: 'review' }));
    expect(t.commit).toMatchObject({ status: 'none', alert: true, note: expect.stringContaining('limite') });
    expect(commits(p.dir)).toBe(1);
    expect(commitAlerts([t])).toHaveLength(1);
  });

  it('os arquivos já estão commitados (ou desfeitos): nada a commitar, sem aviso', async () => {
    const p = await project('limpa');
    await p.on();
    const t = await p.finish(await p.task('Já feito', { changedFiles: ['a.ts'], status: 'review' }));
    expect(t.commit).toMatchObject({ status: 'none', alert: false, note: expect.stringContaining('já commitados ou desfeitos') });
    expect(commits(p.dir)).toBe(1);
  });

  it('tudo da tarefa fica de fora: nada commitado, e o aviso diz quais', async () => {
    const p = await project('tudo-fora');
    await p.on();
    await write(p.dir, '.env', 'SECRET=2\n');
    const t = await p.finish(await p.task('Só segredo', { changedFiles: ['.env'], status: 'review' }));
    expect(t.commit).toMatchObject({ status: 'none', alert: true, left: [expect.objectContaining({ path: '.env' })] });
    expect(commits(p.dir)).toBe(1);
  });

  it('repositório no meio de um merge, ou com o HEAD destacado: não commita e avisa', async () => {
    const p = await project('estado');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const head = git(p.dir, 'rev-parse', 'HEAD').trim();
    await fs.writeFile(path.join(p.dir, '.git', 'MERGE_HEAD'), `${head}\n`);
    const t = await p.finish(await p.task('Durante merge', { changedFiles: ['a.ts'], status: 'review' }));
    expect(t.commit).toMatchObject({ status: 'none', alert: true, note: expect.stringContaining('merge') });
    expect(commits(p.dir)).toBe(1);
    await fs.rm(path.join(p.dir, '.git', 'MERGE_HEAD'));
    git(p.dir, 'checkout', '-q', '--detach');
    const d = await p.finish(await p.task('Destacado', { changedFiles: ['a.ts'], status: 'review' }));
    expect(d.commit).toMatchObject({ status: 'none', alert: true, note: expect.stringContaining('destacado') });
    expect(commits(p.dir)).toBe(1);
  });

  it('o projeto não é um repositório git: registra o motivo, sem aviso', async () => {
    const dir = path.join(root, 'sem-git');
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await write(dir, 'a.ts', 'x\n');
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async () => null,
      send: async () => 's-1',
      sendTo: async (_p, s) => s,
      branchFor: async () => null,
      isWorking: () => false,
      isSessionWorking: () => false,
      lastText: () => null,
      notify: async () => {},
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
    });
    await svc.setBoardCommit('p', { autoCommit: true }, true);
    const t = (await svc.create('p', { title: 'Sem git', description: '', staffId: null }))!;
    const tasksFile = path.join(dir, '.myco', 'tasks.json');
    const all = JSON.parse(await fs.readFile(tasksFile, 'utf8')) as Array<Record<string, unknown>>;
    await fs.writeFile(tasksFile, JSON.stringify(all.map((x) => ({ ...x, changedFiles: ['a.ts'] }))));
    await svc.update('p', t.id, { status: 'done' }, true);
    await svc.commitsSettled();
    expect((await readTasks(dir))[0]!.commit).toMatchObject({ status: 'none', alert: false, note: 'o projeto não é um repositório git' });
  });

  it('tarefa de worktree (própria ou já mesclada) é ignorada: nem commit nem registro', async () => {
    const p = await project('worktree', { worktree: true });
    await p.on();
    const wt = path.join(p.dir, '.claude', 'worktrees', 'myco-ana-1');
    git(p.dir, 'worktree', 'add', '-q', '-b', 'myco/ana-1', wt);
    await write(p.dir, 'a.ts', 'export const a = 2;\n'); // sujeira do projeto principal que não é desta tarefa
    const own = await p.finish(await p.task('Na worktree', { changedFiles: ['a.ts'], status: 'review' }));
    expect(own.commit).toBeUndefined();
    const merged = await p.finish(await p.task('Mesclada', { changedFiles: ['a.ts'], status: 'review', merged: { at: new Date().toISOString(), sha: 'abc1234', branch: 'myco/ana-1', base: 'main' } }));
    expect(merged.commit).toBeUndefined();
    expect(commits(p.dir)).toBe(1);
    expect(dirty(p.dir)).toContain(' M a.ts');
  });
});

describe('commit automático: uma entrega, um commit, um de cada vez', () => {
  it('o mesmo "pronto" disparado duas vezes não commita duas vezes; reabrir e fechar sem mudança nova também não', async () => {
    const p = await project('idempotente');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const first = await p.finish(id);
    expect(first.commit!.status).toBe('committed');
    expect(commits(p.dir)).toBe(2);
    // O mesmo evento outra vez (e junto): a entrega já tem commit.
    (p.svc as any).commitSoon('p', id);
    (p.svc as any).commitSoon('p', id);
    await p.svc.commitsSettled();
    expect(commits(p.dir)).toBe(2);
    expect((await p.get(id)).commit).toEqual(first.commit);
    // Reaberta e pronta de novo, sem nada novo no git: outra entrega, mas não há o que commitar.
    await p.svc.update('p', id, { status: 'doing' }, true);
    const again = await p.finish(id);
    expect(commits(p.dir)).toBe(2);
    expect(again.commit).toMatchObject({ status: 'none', alert: false });
    expect(again.commit!.for).not.toBe(first.commit!.for);
  });

  it('duas tarefas prontas ao mesmo tempo viram dois commits, cada um com os seus arquivos', async () => {
    const p = await project('serial');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    const ida = await p.task('Tela A', { changedFiles: ['a.ts'], status: 'review' });
    const idb = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'review' });
    await Promise.all([p.svc.update('p', ida, { status: 'done' }, true), p.svc.update('p', idb, { status: 'done' }, true)]);
    await p.svc.commitsSettled();
    expect(commits(p.dir)).toBe(3);
    const subjects = git(p.dir, 'log', '-2', '--format=%s').trim().split(/\r?\n/).sort();
    expect(subjects).toEqual([`Tela A (${ida})`, `Tela B (${idb})`]);
    for (const [id, f] of [[ida, 'a.ts'], [idb, 'b.ts']] as const) {
      const sha = git(p.dir, 'log', '-1', '--format=%H', '--fixed-strings', `--grep=(${id})`).trim();
      expect(filesOf(p.dir, sha)).toEqual([f]);
    }
    expect(dirty(p.dir)).toEqual([]);
  });

  it('a mensagem é determinística: título em uma linha, id no fim, sem IA', () => {
    expect(commitMessage('Corrigir  a\nrota', 't-abc123')).toBe('Corrigir a rota (t-abc123)');
    expect(commitMessage('   ', 't-abc123')).toBe('Tarefa (t-abc123)');
    expect(commitMessage('x'.repeat(300), 't-abc123')).toHaveLength(200 + ' (t-abc123)'.length);
  });
});

describe('commit automático: configuração e política', () => {
  it('só a tela liga e desliga: sem fromBrowser dá 403 (TaskForbiddenError), corpo torto dá 400, e nada é gravado', async () => {
    const p = await project('config');
    await expect(p.svc.setBoardCommit('p', { autoCommit: true }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(p.svc.setBoardCommit('p', { autoCommit: 'sim' }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(p.svc.setBoardCommit('p', { autoCommit: true, extra: 1 }, true)).rejects.toBeInstanceOf(TaskError);
    await expect(fs.stat(path.join(p.dir, '.myco', 'board.json'))).rejects.toThrow();
    expect(await p.svc.setBoardCommit('p', { autoCommit: true }, true)).toEqual({ autoCommit: true });
    expect(await p.svc.boardCommit('p')).toEqual({ autoCommit: true });
    expect(await p.svc.setBoardCommit('p', { autoCommit: false }, true)).toEqual({ autoCommit: false });
  });

  it('gravar uma chave não apaga a outra, em qualquer ordem; a leitura da revisão não vê o commit', async () => {
    const p = await project('chaves');
    const file = path.join(p.dir, '.myco', 'board.json');
    await p.svc.setBoardConfig('p', { autoReview: true, reviewerId: 'rev-1' });
    await p.svc.setBoardCommit('p', { autoCommit: true }, true);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoReview: true, reviewerId: 'rev-1', autoCommit: true });
    expect(await p.svc.boardConfig('p')).toEqual({ autoReview: true, reviewerId: 'rev-1' });
    await p.svc.setBoardConfig('p', { autoReview: false, reviewerId: 'rev-1' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoReview: false, reviewerId: 'rev-1', autoCommit: true });
    // Duas telas gravando juntas não se perdem.
    await Promise.all([p.svc.setBoardCommit('p', { autoCommit: false }, true), p.svc.setBoardConfig('p', { autoReview: true, reviewerId: 'rev-1' })]);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ autoReview: true, reviewerId: 'rev-1', autoCommit: false });
  });

  it('o item da caixa some ao ignorar; id torto ou tarefa sem aviso não ignora nada', async () => {
    const p = await project('ignorar');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, '.env', 'SECRET=2\n');
    const id = await p.task('Tela A', { changedFiles: ['a.ts', '.env'], status: 'review' });
    expect(commitAlerts([await p.finish(id)])).toHaveLength(1);
    expect(await p.svc.ackCommit('commit:p:t-ffffff')).toBe(false);
    expect(await p.svc.ackCommit('commit:p:../../x')).toBe(false);
    expect(await p.svc.ackCommit(`commit:${'p'}:${id}`)).toBe(true);
    const t = await p.get(id);
    expect(t.commit).toMatchObject({ status: 'partial', ack: true }); // o cartão segue mostrando
    expect(commitAlerts([t])).toEqual([]);
    expect(await p.svc.ackCommit(`commit:p:${id}`)).toBe(false);
  });

  it('funcionário e a sandbox do Codex não têm a rota; a tela, as rotas e o commit nunca fazem push', async () => {
    expect(staffMayPost('/api/projects/p/board-commit')).toBe(false);
    expect(sandboxVerdict('POST', '/api/projects/p/board-commit', 'p')).toMatchObject({ status: 403 });
    expect(sandboxVerdict('GET', '/api/projects/p/board-commit', 'p')).toMatchObject({ status: 403 });
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('board-commit$`), ({ params: [id] }) => tasks.boardCommit(id!)');
    expect(index).toMatch(/board-commit\$`\),\s*\(\{ params: \[id\], body, fromBrowser \}\) => tasks\.setBoardCommit\(id!, body, fromBrowser\)/);
    expect(index).toContain('writeOwnerFile(dir, input)'); // files/write registra a gravação
    expect(index).toMatch(/\(error\|cap\|commit\|guardoff\|codexsandbox\)/);
    expect(index).toContain('tasks.ackCommit(b.id)');
    const code = await fs.readFile(path.join(__dirname, '..', 'server', 'autoCommit.ts'), 'utf8');
    expect(code).not.toMatch(/'push'|--no-verify/);
  });
});
