import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TaskCode, TaskCodeFile, TestRun } from '../shared/model';
import { cleanEnv } from './auth';
import { worktreeFor } from './staff/worktree';

// O código de uma tarefa: onde está (worktree do funcionário ou o próprio projeto), o que mudou,
// os testes e a mescla. A pasta `.myco/` (fichas, imagens) fica fora de tudo: não é código.
// Mesclar acontece no checkout principal, em três passos: `merge --no-commit`, testes no resultado
// (é ali que estão as dependências instaladas) e só então o commit; teste vermelho desfaz a mescla.

export class CodeError extends Error {
  constructor(
    message: string,
    /** `no-tests`: não há testes; dá para mesclar confirmando. */
    readonly code: 'no-tests' | null = null,
    readonly tests: TestRun | null = null,
  ) {
    super(message);
  }
}

const NOT_MYCO = [':(exclude).myco', ':(exclude).myco/**'];
const MAX_DIFF = 200_000;

export interface CodePlace {
  where: 'worktree' | 'project';
  path: string;
  branch: string | null;
}

/** Onde está o código da tarefa; null quando o projeto não é um repositório git. */
export async function locateCode(projectPath: string, staffId: string | null, ownWorktree: boolean): Promise<CodePlace | null> {
  if (staffId && ownWorktree) {
    const wt = worktreeFor(projectPath, staffId);
    if (await fs.stat(path.join(wt.path, '.git')).then((s) => s.isFile(), () => false)) return { where: 'worktree', path: wt.path, branch: wt.branch };
  }
  if (!(await isRepo(projectPath))) return null;
  return { where: 'project', path: projectPath, branch: (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null };
}

/**
 * Fecha a entrega numa worktree: commita o que estiver pendente (com o título da tarefa) e devolve o
 * commit. Fora de worktree, null: no projeto principal o MyCo não commita por você.
 */
export async function checkpoint(place: CodePlace, title: string): Promise<string | null> {
  if (place.where !== 'worktree') return null;
  if (await dirtyCount(place.path)) {
    await git(place.path, ['add', '-A', '--', '.', ...NOT_MYCO]);
    await git(place.path, ['commit', '-m', `${title} (MyCo)`]).catch(() => {});
  }
  return (await git(place.path, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
}

/** `upTo` só vale se for um commit desta worktree (ancestral do HEAD dela). */
async function validEnd(place: CodePlace, upTo: string | null | undefined): Promise<string | null> {
  if (!upTo || place.where !== 'worktree') return null;
  return (await git(place.path, ['merge-base', '--is-ancestor', upTo, 'HEAD']).then(() => true, () => false)) ? upTo : null;
}

/**
 * O que mudou: na worktree, tudo desde onde ela saiu da base (commits + o que ainda não foi
 * commitado). Com `upTo` (o commit da entrega), só até ele: o resto é da tarefa seguinte.
 */
export async function readCode(projectPath: string, place: CodePlace, upTo?: string | null, only?: string[]): Promise<TaskCode> {
  const base = (await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  const test = await detectTest(projectPath);
  const mainDirty = await dirtyCount(projectPath);
  if (place.where === 'project') {
    // `only`: só estes arquivos (os que um funcionário editou numa conversa).
    const keep = only ? new Set(only) : null;
    const files = (await changedFiles(projectPath, 'HEAD')).filter((f) => !keep || keep.has(f.path));
    const diff = keep && !keep.size ? '' : await git(projectPath, ['diff', 'HEAD', '--', ...(keep ? [...keep] : ['.', ...NOT_MYCO])]).catch(() => '');
    return {
      where: 'project',
      path: place.path,
      branch: place.branch,
      base,
      files,
      commits: [],
      uncommitted: files.length,
      ...clip(diff),
      test,
      canMerge: false,
      whyNot: 'as mudanças já estão no próprio projeto (a ficha não usa worktree): não há o que mesclar',
    };
  }
  const end = await validEnd(place, upTo);
  const mb = base ? (await git(place.path, ['merge-base', base, 'HEAD']).catch(() => '')).trim() : '';
  const from = mb || 'HEAD';
  const files = await changedFiles(place.path, from, end);
  const uncommitted = end ? 0 : (await changedFiles(place.path, 'HEAD')).length;
  const log = mb ? await git(place.path, ['log', '--format=%h%x09%s', `${mb}..${end ?? 'HEAD'}`]).catch(() => '') : '';
  const commits = log
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha: sha!, subject: rest.join('\t') };
    });
  const diff = await git(place.path, ['diff', from, ...(end ? [end] : []), '--', '.', ...NOT_MYCO]).catch(() => '');
  const whyNot = !base
    ? 'o projeto principal está com o HEAD destacado'
    : mainDirty
      ? `o projeto principal tem ${mainDirty} ${mainDirty === 1 ? 'arquivo alterado' : 'arquivos alterados'} sem commit: commite ou guarde antes de mesclar`
      : !files.length && !commits.length
        ? 'não há mudanças na worktree'
        : null;
  return { where: 'worktree', path: place.path, branch: place.branch, base, files, commits, uncommitted, ...clip(diff), test, canMerge: !whyNot, whyNot };
}

/**
 * Mescla a worktree no branch atual do projeto. O que não foi commitado na worktree é commitado
 * antes (com a mensagem da tarefa). Com `upTo` (o commit da entrega), mescla só até ele e não
 * commita o pendente, que é da tarefa seguinte. Sem testes, só com `skipTests` (confirmado no MyCo).
 */
export async function mergeCode(
  projectPath: string,
  place: CodePlace,
  title: string,
  opts: { skipTests?: boolean; upTo?: string | null } = {},
): Promise<{ sha: string; base: string; branch: string; tests: TestRun | null }> {
  if (place.where !== 'worktree' || !place.branch) throw new CodeError('só dá para mesclar o trabalho de uma worktree');
  const end = await validEnd(place, opts.upTo);
  const code = await readCode(projectPath, place, end);
  if (!code.canMerge || !code.base) throw new CodeError(code.whyNot ?? 'não dá para mesclar agora');
  const test = code.test;
  if (!test && !opts.skipTests) throw new CodeError('não achei testes neste projeto (npm test, composer test ou phpunit)', 'no-tests');

  if (code.uncommitted && !end) {
    await git(place.path, ['add', '-A', '--', '.', ...NOT_MYCO]);
    await git(place.path, ['commit', '-m', `${title} (MyCo)`]).catch((err: Error) => {
      throw new CodeError(`não deu para commitar na worktree: ${firstLine(err.message)}`);
    });
  }
  const message = `Merge ${place.branch}: ${title}`;
  try {
    await git(projectPath, ['merge', '--no-ff', '--no-commit', end ?? place.branch]);
  } catch (err) {
    const conflicts = (await git(projectPath, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
    await git(projectPath, ['merge', '--abort']).catch(() => {});
    throw new CodeError(conflicts ? `conflito ao mesclar em: ${conflicts.split(/\r?\n/).join(', ')}` : `não deu para mesclar: ${firstLine((err as Error).message)}`);
  }
  let tests: TestRun | null = null;
  if (test) {
    tests = await runTests(projectPath, test);
    if (!tests.ok) {
      await git(projectPath, ['merge', '--abort']).catch(() => {});
      throw new CodeError('os testes falharam com a mescla: nada foi mesclado', null, tests);
    }
  }
  // Mescla sem mudança nenhuma (a base já tinha tudo): não há o que commitar.
  await git(projectPath, ['commit', '--no-edit', '-m', message]).catch(async (err: Error) => {
    if (!/nothing to commit|nada a submeter/i.test(err.message)) {
      await git(projectPath, ['merge', '--abort']).catch(() => {});
      throw new CodeError(`não deu para concluir a mescla: ${firstLine(err.message)}`);
    }
  });
  const sha = (await git(projectPath, ['rev-parse', '--short', 'HEAD'])).trim();
  return { sha, base: code.base, branch: place.branch, tests };
}

/** O comando de testes do projeto, se houver um claro. */
export async function detectTest(dir: string): Promise<string | null> {
  const pkg = await readJson(path.join(dir, 'package.json'));
  const npmTest = (pkg?.scripts as Record<string, unknown> | undefined)?.test;
  if (typeof npmTest === 'string' && npmTest.trim() && !/no test specified/i.test(npmTest)) return 'npm test';
  const composer = await readJson(path.join(dir, 'composer.json'));
  if ((composer?.scripts as Record<string, unknown> | undefined)?.test) return 'composer test';
  if (await fs.stat(path.join(dir, 'vendor', 'bin', 'phpunit')).then(() => true, () => false)) return process.platform === 'win32' ? 'vendor\\bin\\phpunit' : 'vendor/bin/phpunit';
  return null;
}

/** Roda os testes (até 10 min); guarda só o fim da saída. O comando vem de detectTest, nunca do pedido. */
export function runTests(dir: string, command: string): Promise<TestRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command, { cwd: dir, shell: true, env: { ...cleanEnv(), CI: '1' }, windowsHide: true });
    const keep = (d: Buffer) => (out = (out + d.toString('utf8')).slice(-6000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, ok: code === 0, output: out.trim(), ms: Date.now() - started, at: new Date().toISOString() });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ command, ok: false, output: err.message, ms: Date.now() - started, at: new Date().toISOString() });
    });
  });
}

/** De `from` até o que está no disco, ou até o commit `to` (aí sem os arquivos novos não commitados). */
async function changedFiles(dir: string, from: string, to?: string | null): Promise<TaskCodeFile[]> {
  const range = to ? [from, to] : [from];
  const numstat = await git(dir, ['diff', '--numstat', ...range, '--', '.', ...NOT_MYCO]).catch(() => '');
  const status = await git(dir, ['diff', '--name-status', ...range, '--', '.', ...NOT_MYCO]).catch(() => '');
  const kinds = new Map(
    status
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const parts = l.split('\t');
        return [parts.at(-1)!, parts[0]!.charAt(0)] as const;
      }),
  );
  const files: TaskCodeFile[] = numstat
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...p] = l.split('\t');
      const file = p.join('\t').replace(/^.*=> /, '').replace(/[{}]/g, '');
      return { path: file, status: kinds.get(file) ?? 'M', add: a === '-' ? 0 : Number(a), del: d === '-' ? 0 : Number(d) };
    });
  if (to) return files;
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '--', '.', ...NOT_MYCO]).catch(() => '');
  for (const f of untracked.split(/\r?\n/).filter(Boolean)) files.push({ path: f, status: '?', add: 0, del: 0 });
  return files;
}

async function dirtyCount(dir: string): Promise<number> {
  const out = await git(dir, ['status', '--porcelain', '--', '.', ...NOT_MYCO]).catch(() => '');
  return out.split(/\r?\n/).filter(Boolean).length;
}

async function isRepo(dir: string): Promise<boolean> {
  return (await git(dir, ['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() === 'true';
}

function clip(diff: string): { diff: string; truncated: boolean } {
  return diff.length > MAX_DIFF ? { diff: diff.slice(0, MAX_DIFF), truncated: true } : { diff, truncated: false };
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  try {
    return raw ? (JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? s;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}
