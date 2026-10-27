import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkpoint, CodeError, locateCode, mergeCode, readCode } from '../server/taskCode';
import { ensureWorktree } from '../server/staff/worktree';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-code-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Repositório de verdade, com um teste que passa ou falha conforme `ok.txt`. */
async function repo(name: string, withTests = true) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Teste');
  git('config', 'user.email', 't@t');
  git('config', 'core.autocrlf', 'false'); // no Windows, o checkout trocaria \n por \r\n
  if (withTests) {
    const test = "node -e \"process.exit(require('fs').readFileSync('ok.txt','utf8').trim()==='sim'?0:1)\"";
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test } }));
    await fs.writeFile(path.join(dir, 'ok.txt'), 'sim');
  }
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  git('add', '.');
  git('commit', '-qm', 'início');
  return { dir, git };
}

describe('código da tarefa', () => {
  it('vê as mudanças da worktree (commitadas e não) e mescla com os testes passando', async () => {
    const { dir, git } = await repo('verde');
    const wt = await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'app.txt'), 'v2\n');
    await fs.writeFile(path.join(wt.path, 'novo.txt'), 'oi\n');
    await fs.mkdir(path.join(wt.path, '.myco'), { recursive: true });
    await fs.writeFile(path.join(wt.path, '.myco', 'tasks.json'), '[]'); // não é código

    const place = (await locateCode(dir, 'ana-1', true))!;
    expect(place).toMatchObject({ where: 'worktree', branch: 'myco/ana-1' });
    const code = await readCode(dir, place);
    expect(code).toMatchObject({ base: 'main', uncommitted: 2, test: 'npm test', canMerge: true });
    expect(code.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['? novo.txt', 'M app.txt']);
    expect(code.diff).toContain('+v2');

    const merged = await mergeCode(dir, place, 'Atualizar o app');
    expect(merged).toMatchObject({ base: 'main', branch: 'myco/ana-1', tests: { ok: true, command: 'npm test' } });
    expect(await fs.readFile(path.join(dir, 'app.txt'), 'utf8')).toBe('v2\n');
    expect(git('log', '-1', '--format=%s').trim()).toBe('Merge myco/ana-1: Atualizar o app');
    expect(git('status', '--porcelain').trim()).toBe('');
  }, 60_000);

  it('a entrega tem o seu commit; mesclar ela não leva o que a próxima tarefa já começou', async () => {
    const { dir, git } = await repo('fila');
    const wt = await ensureWorktree(dir, 'ana-1');
    const place = (await locateCode(dir, 'ana-1', true))!;
    await fs.writeFile(path.join(wt.path, 'app.txt'), 'v2\n'); // tarefa A
    const sha = (await checkpoint(place, 'Tarefa A'))!;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    await fs.writeFile(path.join(wt.path, 'b.txt'), 'meio da B\n'); // a próxima já começou
    await fs.writeFile(path.join(wt.path, 'app.txt'), 'v3\n');

    const code = await readCode(dir, place, sha);
    expect(code).toMatchObject({ uncommitted: 0, canMerge: true, commits: [expect.objectContaining({ subject: 'Tarefa A (MyCo)' })] });
    expect(code.files.map((f) => f.path)).toEqual(['app.txt']);

    await mergeCode(dir, place, 'Tarefa A', { upTo: sha });
    expect(await fs.readFile(path.join(dir, 'app.txt'), 'utf8')).toBe('v2\n');
    await expect(fs.stat(path.join(dir, 'b.txt'))).rejects.toThrow();
    // A B continua lá, sem commit, do jeito que estava.
    expect(await fs.readFile(path.join(wt.path, 'app.txt'), 'utf8')).toBe('v3\n');
    expect(git('-C', wt.path, 'status', '--porcelain').split(/\r?\n/).filter(Boolean).sort()).toEqual([' M app.txt', '?? b.txt']);
    // Um commit que não é desta worktree é ignorado (mescla tudo, como antes).
    expect((await readCode(dir, place, 'f'.repeat(40))).uncommitted).toBe(2);
  }, 60_000);

  it('teste vermelho desfaz a mescla; sem testes, só confirmando; projeto sujo não mescla', async () => {
    const { dir, git } = await repo('vermelho');
    const wt = await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'ok.txt'), 'nao'); // quebra o teste
    const place = (await locateCode(dir, 'ana-1', true))!;
    const err = await mergeCode(dir, place, 'Quebrar').catch((e: CodeError) => e);
    expect(err).toBeInstanceOf(CodeError);
    expect((err as CodeError).tests).toMatchObject({ ok: false });
    expect(await fs.readFile(path.join(dir, 'ok.txt'), 'utf8')).toBe('sim'); // a mescla foi desfeita
    expect(git('status', '--porcelain').trim()).toBe('');

    await fs.writeFile(path.join(dir, 'app.txt'), 'mexido\n');
    expect((await readCode(dir, place)).whyNot).toMatch(/1 arquivo alterado sem commit/);

    const plain = await repo('sem-testes', false);
    const wt2 = await ensureWorktree(plain.dir, 'bia-1');
    await fs.writeFile(path.join(wt2.path, 'app.txt'), 'v2\n');
    const place2 = (await locateCode(plain.dir, 'bia-1', true))!;
    await expect(mergeCode(plain.dir, place2, 'Sem testes')).rejects.toMatchObject({ code: 'no-tests' });
    expect((await mergeCode(plain.dir, place2, 'Sem testes', { skipTests: true })).tests).toBeNull();
    expect(await fs.readFile(path.join(plain.dir, 'app.txt'), 'utf8')).toBe('v2\n');
  }, 90_000);

  it('sem worktree: mostra o que mudou no próprio projeto e não oferece mesclar', async () => {
    const { dir } = await repo('sem-wt', false);
    await fs.writeFile(path.join(dir, 'app.txt'), 'v3\n');
    const place = (await locateCode(dir, 'ana-1', false))!;
    expect(place).toMatchObject({ where: 'project', branch: 'main' });
    const code = await readCode(dir, place);
    expect(code).toMatchObject({ canMerge: false, uncommitted: 1 });
    expect(await locateCode(path.join(root, 'nao-existe'), null, false)).toBeNull();
  }, 30_000);
});
