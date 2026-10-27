import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanEnv } from '../auth';
import { StaffError } from './store';

// Worktree própria de um funcionário: <projeto>/.claude/worktrees/myco-<ficha>, no branch
// myco/<ficha>. Fica onde o Claude Code guarda as dele, então o quadro já a reconhece como
// worktree do projeto. É sempre a mesma: o funcionário chamado de volta reencontra o trabalho.

export interface Worktree {
  path: string;
  branch: string;
}

export const worktreeFor = (projectPath: string, staffId: string): Worktree => ({
  path: path.join(projectPath, '.claude', 'worktrees', `myco-${staffId}`),
  branch: `myco/${staffId}`,
});

/** Cria a worktree se ainda não existir. Erros de git viram StaffError com a explicação. */
export async function ensureWorktree(projectPath: string, staffId: string, git = runGit): Promise<Worktree> {
  const wt = worktreeFor(projectPath, staffId);
  // Uma worktree tem um arquivo `.git` (não pasta) apontando para o repositório principal.
  if (await fs.stat(path.join(wt.path, '.git')).then((s) => s.isFile(), () => false)) return wt;

  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree']).catch(() => '');
  if (inside.trim() !== 'true') {
    throw new StaffError('o projeto não é um repositório git: rode `git init` nele ou desmarque "worktree própria" na ficha');
  }
  if (!(await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false))) {
    throw new StaffError('o repositório ainda não tem nenhum commit: a worktree precisa de um ponto de partida');
  }
  const branchExists = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).then(() => true, () => false);
  await fs.mkdir(path.dirname(wt.path), { recursive: true });
  try {
    await git(projectPath, branchExists ? ['worktree', 'add', wt.path, wt.branch] : ['worktree', 'add', '-b', wt.branch, wt.path]);
  } catch (err) {
    throw new StaffError(`não deu para criar a worktree: ${(err as Error).message.split('\n')[0]}`);
  }
  return wt;
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}
