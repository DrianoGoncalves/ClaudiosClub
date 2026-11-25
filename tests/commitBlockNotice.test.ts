import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lastCommitMs } from '../server/autoCommit';
import { commitInboxItem } from '../server/inboxItems';
import { TaskService, commitAlerts, readTasks } from '../server/tasks';
import type { StaffProfile, Task } from '../shared/model';
import { removeTemp } from './support/tmp';

// Commit automático barrado por outra tarefa (t-2a8ee8): quem pediu a tarefa é avisado, uma vez por motivo, na conversa em que pediu; e a outra tarefa só barra se ainda pode ter mudança
// pendente no arquivo (em fazendo/planejando/a fazer, ou parada sem commit do arquivo depois da parada). Repositórios git de verdade, em pasta temporária.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-commitnotice-'));
});
afterAll(() => removeTemp(root));

const PAST = '2020-01-01T00:00:00';
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
/** O commit-base é de 2020: tudo o que o teste commitar depois é "posterior" à parada das outras tarefas. */
const gitPast = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: PAST, GIT_COMMITTER_DATE: PAST } }).toString();
const filesOf = (dir: string, rev = 'HEAD') => git(dir, 'show', '--name-only', '--format=', rev).split(/\r?\n/).filter(Boolean).sort();
const write = (dir: string, rel: string, text: string) => fs.writeFile(path.join(dir, rel), text);
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

/** Repositório com a.ts, b.ts, c.ts, `a[1].ts` e `.env` (rastreado à força) commitados em 2020; o Club liga o commit automático com `on()`. */
async function project(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (const f of ['a.ts', 'b.ts', 'c.ts', '.env', 'a[1].ts']) await write(dir, f, `export const v = 1; // ${f}\n`);
  gitPast(dir, 'add', '-f', '--', 'a.ts', 'b.ts', 'c.ts', '.env', 'a[1].ts');
  gitPast(dir, 'commit', '-q', '-m', 'base');

  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'gio-1': { id: 'gio-1', name: 'Gio', role: 'Orquestrador', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };
  const h = { notified: [] as Array<{ staffId: string; text: string; sessionId: string | null | undefined }>, notifyFails: false };
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
    notify: async (_p, staffId, text, sessionId) => {
      if (h.notifyFails) throw new Error('conversa dele não abriu');
      h.notified.push({ staffId, text, sessionId });
    },
    hasAsk: () => false,
    answerAsk: () => false,
    awaitingLimit: async () => false,
    apiUrl: 'http://127.0.0.1:4848',
  });
  const file = path.join(dir, '.myco', 'tasks.json');
  /** Cria a tarefa de Ana e grava por cima o que a detecção de edição e o fluxo de revisão gravariam. */
  const task = async (title: string, patch: Partial<Task> = {}) => {
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
  /** A mesma tarefa volta a "revisão" e fica pronta de novo: outra entrega, então o commit roda outra vez. */
  const again = async (id: string) => {
    await svc.update('p', id, { status: 'review' }, true);
    return finish(id);
  };
  const on = () => svc.setBoardCommit('p', { autoCommit: true }, true);
  /** O histórico de uma tarefa que parou (saiu de "fazendo" em `stopMs`) no estado `status`. */
  const stopped = (stopMs: number, status: Task['status'] = 'review'): Pick<Task, 'status' | 'history'> => ({
    status,
    history: [
      { at: iso(stopMs - 2 * HOUR), status: 'todo', by: 'you' },
      { at: iso(stopMs - HOUR), status: 'doing', by: 'auto' },
      { at: iso(stopMs), status, by: 'auto', note: 'turno terminou' },
    ],
  });
  return { dir, h, svc, task, get, finish, again, on, stopped };
}
type Project = Awaited<ReturnType<typeof project>>;
const asked = { requestedBy: 'gio-1', requestedSession: 'gio-s' } as const;

/** A.ts e b.ts com mudança pendente; "B" é a outra tarefa, que mexeu em b.ts. */
async function dirtyAB(p: Project) {
  await write(p.dir, 'a.ts', 'export const a = 2;\n');
  await write(p.dir, 'b.ts', 'export const b = 2;\n');
}

describe('commit barrado por outra tarefa: o aviso a quem pediu', () => {
  it('avisa na conversa em que pediu, com os arquivos e as tarefas que barraram, e grava a chave', async () => {
    const p = await project('aviso');
    await p.on();
    await dirtyAB(p);
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'doing' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review', ...asked });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'partial', files: ['a.ts'], left: [{ path: 'b.ts', why: 'shared', by: other }], alert: true });
    expect(p.h.notified).toHaveLength(1);
    expect(p.h.notified[0]).toMatchObject({ staffId: 'gio-1', sessionId: 'gio-s' });
    const text = p.h.notified[0]!.text;
    expect(text).toContain(`“Tela A” (id ${id})`);
    expect(text).toContain('só levou parte dos arquivos');
    expect(text).toContain('`b.ts`');
    expect(text).toContain(`${other} (“Tela B”, fazendo)`);
    expect(text).toContain('tenta commitá-los sozinho');
    expect(text).not.toContain('não se refaz sozinho');
    expect(t.commitNotice).toMatchObject({ key: expect.stringMatching(/^[0-9a-f]{32}$/), at: expect.any(String) });
    // O mesmo texto do histórico e do aviso vem do mesmo `left`: o id que barrou é o mesmo.
    expect(t.history.at(-1)!.note).toContain(other);
  });

  it('o mesmo motivo não repete; um motivo novo (outra tarefa também barrando) avisa de novo', async () => {
    const p = await project('motivo');
    await p.on();
    await dirtyAB(p);
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'doing' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review', ...asked });
    const first = await p.finish(id);
    expect(p.h.notified).toHaveLength(1);

    // Outra entrega da mesma tarefa, mesmo motivo (b.ts, mesma tarefa): nada novo a dizer.
    const second = await p.again(id);
    expect(second.commit!.for).not.toBe(first.commit!.for);
    expect(second.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: other }]);
    expect(p.h.notified).toHaveLength(1);
    expect(second.commitNotice!.key).toBe(first.commitNotice!.key);

    // Outra tarefa passa a barrar o mesmo arquivo: motivo novo, aviso novo, com as duas.
    const third = await p.task('Tela E', { changedFiles: ['b.ts'], status: 'planning' });
    const last = await p.again(id);
    expect(last.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: `${other}, ${third}` }]);
    expect(p.h.notified).toHaveLength(2);
    expect(p.h.notified[1]!.text).toContain(`${other} (“Tela B”, fazendo)`);
    expect(p.h.notified[1]!.text).toContain(`${third} (“Tela E”, planejando)`);
    expect(last.commitNotice!.key).not.toBe(first.commitNotice!.key);
    expect(last.history.at(-1)!.note).toContain(`${other}, ${third}`);
  });

  it('sem gestor (o dono pediu): nada é enviado e o item do commit na caixa dele existe', async () => {
    const p = await project('sem-gestor');
    await p.on();
    await dirtyAB(p);
    await p.task('Tela B', { changedFiles: ['b.ts'], status: 'doing' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(p.h.notified).toEqual([]);
    expect(t.commitNotice).toBeUndefined();
    const alerts = commitAlerts([t]);
    expect(alerts).toHaveLength(1);
    expect(commitInboxItem(alerts[0]!, { projectId: 'p', projectName: 'P', sessionId: '', name: 'Ana' })).toMatchObject({ id: `commit:p:${id}`, kind: 'error' });
  });

  it('o aviso que não chegou não grava a chave (a caixa do dono segue com o item) e a próxima entrega tenta de novo', async () => {
    const p = await project('nao-chegou');
    await p.on();
    await dirtyAB(p);
    await p.task('Tela B', { changedFiles: ['b.ts'], status: 'doing' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review', ...asked });
    p.h.notifyFails = true;
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'partial', alert: true }); // o commit está gravado, o aviso é que não foi
    expect(t.commitNotice).toBeUndefined();
    expect(commitAlerts([t])).toHaveLength(1);
    p.h.notifyFails = false;
    const retried = await p.again(id);
    expect(p.h.notified).toHaveLength(1);
    expect(retried.commitNotice).toBeDefined();
  });

  it('o que não é de outra tarefa (segredo barrado) e o commit inteiro não avisam', async () => {
    const p = await project('outros-motivos');
    await p.on();
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, '.env', 'SECRET=2\n');
    const blocked = await p.task('Tela A', { changedFiles: ['a.ts', '.env'], status: 'review', ...asked });
    const t = await p.finish(blocked);
    expect(t.commit!.left).toEqual([{ path: '.env', why: 'blocked' }]);
    await write(p.dir, 'c.ts', 'export const c = 2;\n');
    const clean = await p.task('Tela C', { changedFiles: ['c.ts'], status: 'review', ...asked });
    expect((await p.finish(clean)).commit).toMatchObject({ status: 'committed', alert: false });
    expect(p.h.notified).toEqual([]);
  });
});

describe('tarefa aberta sem mudança pendente própria não barra o commit de outra', () => {
  it('parada (em revisão) e o arquivo commitado depois da parada: não barra, e o arquivo entra no commit', async () => {
    const p = await project('parada-commit-posterior');
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n'); // a mudança da tarefa B, que parou há 1 h
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'Commit do trabalho acumulado'); // um commit seu, de agora, que levou o b.ts dela
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 3;\n'); // a mudança pendente de agora é da tarefa A
    await p.task('Tela B', { changedFiles: ['b.ts'], ...p.stopped(Date.now() - HOUR) });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review', ...asked });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'committed', files: ['a.ts', 'b.ts'], left: [], alert: false });
    expect(filesOf(p.dir)).toEqual(['a.ts', 'b.ts']);
    expect(p.h.notified).toEqual([]);
    expect(t.commitNotice).toBeUndefined();
  });

  it('parada, mas o arquivo NÃO teve commit depois da parada: barra (a mudança pendente pode ser dela)', async () => {
    const p = await project('parada-sem-commit');
    await p.on();
    await dirtyAB(p);
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], ...p.stopped(Date.now() - HOUR) });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit).toMatchObject({ status: 'partial', files: ['a.ts'], left: [{ path: 'b.ts', why: 'shared', by: other }] });
  });

  it.each(['todo', 'planning', 'doing'] as const)('ainda pode editar (%s): barra mesmo com commit posterior ao arquivo', async (status) => {
    const p = await project(`pode-editar-${status}`);
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'acumulado');
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 3;\n');
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], ...p.stopped(Date.now() - HOUR, status) });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review' });
    const t = await p.finish(id);
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: other }]);
    expect(filesOf(p.dir)).toEqual(['a.ts']);
  });

  it('Aguardar também é parada: com o arquivo commitado depois, não barra', async () => {
    const p = await project('aguardar');
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'acumulado');
    await write(p.dir, 'b.ts', 'export const b = 3;\n');
    await p.task('Tela B', { changedFiles: ['b.ts'], waitReason: 'espera', ...p.stopped(Date.now() - HOUR, 'waiting') });
    const id = await p.task('Tela A', { changedFiles: ['b.ts'], status: 'review' });
    expect((await p.finish(id)).commit).toMatchObject({ status: 'committed', files: ['b.ts'], left: [] });
  });

  it('empate com o segundo do commit (o git conta em segundos): barra', async () => {
    const p = await project('empate');
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'acumulado');
    await write(p.dir, 'b.ts', 'export const b = 3;\n');
    const committed = (await lastCommitMs(p.dir, 'b.ts'))!;
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], ...p.stopped(committed) });
    const id = await p.task('Tela A', { changedFiles: ['b.ts'], status: 'review' });
    expect((await p.finish(id)).commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: other }]);
  });

  it('histórico sem a saída de "fazendo" (cortado, ou card que nunca trabalhou): não dá para saber, barra', async () => {
    const p = await project('sem-saida');
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'acumulado');
    await write(p.dir, 'b.ts', 'export const b = 3;\n');
    const other = await p.task('Tela B', { changedFiles: ['b.ts'], status: 'review', history: [{ at: iso(Date.now() - HOUR), status: 'review', by: 'you' }] });
    const id = await p.task('Tela A', { changedFiles: ['b.ts'], status: 'review' });
    expect((await p.finish(id)).commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: other }]);
  });

  it('duas tarefas no mesmo arquivo: a que já parou e foi commitada sai da lista, a que ainda edita continua nela', async () => {
    const p = await project('duas');
    await p.on();
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
    git(p.dir, 'add', 'b.ts');
    git(p.dir, 'commit', '-q', '-m', 'acumulado');
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 3;\n');
    await p.task('Tela B', { changedFiles: ['b.ts'], ...p.stopped(Date.now() - HOUR) });
    const working = await p.task('Tela D', { changedFiles: ['b.ts'], status: 'doing' });
    const id = await p.task('Tela A', { changedFiles: ['a.ts', 'b.ts'], status: 'review', ...asked });
    const t = await p.finish(id);
    expect(t.commit!.left).toEqual([{ path: 'b.ts', why: 'shared', by: working }]);
    expect(p.h.notified[0]!.text).toContain(`${working} (“Tela D”, fazendo)`);
    expect(p.h.notified[0]!.text).not.toContain('Tela B');
  });
});

describe('lastCommitMs', () => {
  it('é a hora do último commit que levou o arquivo (caminho literal); null sem commit, fora do git ou com caminho que o git não conhece', async () => {
    const p = await project('last-commit');
    expect(await lastCommitMs(p.dir, 'a.ts')).toBe(Date.parse('2020-01-01T00:00:00') );
    expect(await lastCommitMs(p.dir, 'a[1].ts')).toBe(Date.parse('2020-01-01T00:00:00'));
    expect(await lastCommitMs(p.dir, 'a?.ts')).toBeNull(); // curinga não vale: o caminho é literal
    expect(await lastCommitMs(p.dir, 'nunca-commitado.ts')).toBeNull();
    await write(p.dir, 'novo.ts', 'x\n');
    git(p.dir, 'add', 'novo.ts');
    git(p.dir, 'commit', '-q', '-m', 'novo');
    const novo = (await lastCommitMs(p.dir, 'novo.ts'))!;
    expect(Math.abs(novo - Date.now())).toBeLessThan(120_000);
    expect(await lastCommitMs(path.join(root, 'nao-existe'), 'a.ts')).toBeNull();
  });
});
