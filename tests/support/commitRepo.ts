import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CommitLeftCache, withCommitLeft } from '../../server/commitLeft';
import { TaskService, readTasks } from '../../server/tasks';
import type { StaffProfile, Task } from '../../shared/model';

// Repositório git de verdade + TaskService com o commit automático, para os testes do aviso de commit parcial (commitLeft.test.ts, commitRedo.test.ts).

export const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
/** `git status` sem a pasta do Club (tasks.json e afins ficam sem rastreio em todo teste). */
export const dirty = (dir: string) => git(dir, 'status', '--porcelain', '--', '.', ':(exclude).myco').split(/\r?\n/).filter(Boolean).sort();
export const commits = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD').trim());
export const filesOf = (dir: string, rev = 'HEAD') => git(dir, 'show', '--name-only', '--format=', rev).split(/\r?\n/).filter(Boolean).sort();
export const write = (dir: string, rel: string, text: string | Buffer) => fs.writeFile(path.join(dir, rel), text);

export type Project = Awaited<ReturnType<typeof project>>;

/** Repositório com a.ts, b.ts, c.ts, `.env` (rastreado à força) e d.ts commitados; o commit automático do projeto fica desligado até `on()`. */
export async function project(root: string, name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  const base = ['a.ts', 'b.ts', 'c.ts', 'd.ts', '.env'];
  for (const f of base) await write(dir, f, `export const v = 1; // ${f}\n`);
  git(dir, 'add', '-f', '--', ...base);
  git(dir, 'commit', '-q', '-m', 'base');

  const people: Record<string, StaffProfile> = { 'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile };
  const mk = () =>
    new TaskService({
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
  const svc = mk();
  const file = path.join(dir, '.myco', 'tasks.json');
  const edit = async (id: string, patch: Record<string, unknown>) => {
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((x) => x.id === id)!, patch);
    await fs.writeFile(file, JSON.stringify(all));
  };
  /** Cria a tarefa e grava o que a detecção de edição gravaria. */
  const task = async (title: string, patch: Record<string, unknown> = {}) => {
    const t = (await svc.create('p', { title, description: `Pedido de ${title}`, staffId: 'ana-1' }))!;
    await edit(t.id, patch);
    return t.id;
  };
  const get = async (id: string): Promise<Task> => (await readTasks(dir)).find((t) => t.id === id)!;
  /** Fica pronta pela tela (a via do dono) e espera o commit, que corre em segundo plano. */
  const finish = async (id: string) => {
    await svc.update('p', id, { status: 'done' }, true);
    await svc.commitsSettled();
    return get(id);
  };
  const on = () => svc.setBoardCommit('p', { autoCommit: true }, true);
  /** O projeto lido por um serviço novo (um reinício do servidor): nada além do disco. */
  const restart = () => mk();
  /** Uma lista com `commitLeft`, como a rota de tarefas a devolve, mas sem o cache de 30 s (o teste muda o git entre uma leitura e outra). */
  const listed = async (s: TaskService = svc) => withCommitLeft((await s.list('p'))!, 'p', dir, { cache: new CommitLeftCache() });
  const listedTask = async (id: string, s: TaskService = svc) => (await listed(s)).find((t) => t.id === id)!;

  /**
   * A entrega parcial de sempre: "Tela A" fica pronta levando a.ts e deixa b.ts de fora, porque "Tela B" (em revisão, aberta) também o alterou. `a`/`b` são os ids; `t` é a Tela A depois do commit.
   * Para liberar b.ts: `edit(b, { changedFiles: ['x.ts'] })` (B segue aberta, mas já não toca) ou `edit(b, { status: 'cancelled' })`.
   */
  const partial = async () => {
    await on();
    await write(dir, 'a.ts', 'export const a = 2;\n');
    await write(dir, 'b.ts', 'export const b = 2;\n');
    const b = await task('Tela B', { changedFiles: ['b.ts'], status: 'review' });
    const a = await task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await finish(a);
    return { a, b, t };
  };
  return { dir, svc, file, task, edit, get, finish, on, restart, listed, listedTask, partial };
}
