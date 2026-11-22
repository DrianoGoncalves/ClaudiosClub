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

/** Uma worktree tem um arquivo `.git` (não pasta) apontando para o repositório principal. */
export const hasWorktree = (dir: string): Promise<boolean> => fs.stat(path.join(dir, '.git')).then((s) => s.isFile(), () => false);

/** O `git worktree add` baixa todos os arquivos: num projeto grande, com a máquina carregada, passa dos 30 s dos outros comandos (e morto no meio deixa a worktree pela metade). */
const ADD_TIMEOUT_MS = 5 * 60_000;

/** Uma criação por worktree de cada vez (ver `ensureWorktree`). */
const creating = new Map<string, Promise<Worktree>>();

/**
 * Cria a worktree se ainda não existir. Erros de git viram StaffError com a explicação. Duas conversas do mesmo funcionário abrindo juntas dividem a mesma criação: o segundo
 * `worktree add` falharia com "reference already exists" depois de a worktree já ter sido criada pelo primeiro.
 */
export function ensureWorktree(projectPath: string, staffId: string, git: GitRun = runGit): Promise<Worktree> {
  const key = worktreeFor(projectPath, staffId).path;
  const running = creating.get(key);
  if (running) return running;
  const run = create(projectPath, staffId, git).finally(() => creating.delete(key));
  creating.set(key, run);
  return run;
}

async function create(projectPath: string, staffId: string, git: GitRun): Promise<Worktree> {
  const wt = worktreeFor(projectPath, staffId);
  if (await hasWorktree(wt.path)) return wt;

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
    await git(projectPath, branchExists ? ['worktree', 'add', wt.path, wt.branch] : ['worktree', 'add', '-b', wt.branch, wt.path], ADD_TIMEOUT_MS);
  } catch (err) {
    throw new StaffError(`não deu para criar a worktree: ${gitReason((err as Error).message)}`);
  }
  return wt;
}

/** O que roda o git: resolve com a saída padrão se ele sai com 0 (o stderr não conta) e rejeita com o texto do erro se não. */
export type GitRun = (cwd: string, args: string[], timeoutMs?: number) => Promise<string>;

/** Falha do git; `code` é o código de saída (ou o erro do sistema, se nem rodou) e `killed`, se estourou o tempo. */
export class GitFailure extends Error {
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly killed: boolean,
  ) {
    super(message);
  }
}

/**
 * Roda o git e julga pelo CÓDIGO DE SAÍDA: o git escreve o progresso de sucesso no stderr ("Preparing worktree (new branch …)"), então texto lá não é erro. Só saída diferente de 0
 * (ou tempo estourado, ou git que nem abre) rejeita, com o stderr inteiro como mensagem (ver `gitReason` para achar nele a linha do erro).
 */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const killed = !!(err as { killed?: boolean }).killed;
      const code = (err as { code?: number | string }).code ?? null;
      reject(new GitFailure(killed ? `o git passou de ${Math.round(timeoutMs / 1000)} s e foi encerrado` : (stderr || err.message).trim(), code, killed));
    });
  });
}

/** Progresso que o git escreve no stderr de uma execução, com ou sem falha: não explica nada. */
const PROGRESS = /^(Preparing worktree|HEAD is now at|Updating files|Checking out files)\b/i;

/** A linha que explica a falha: o último `fatal:`/`error:`; sem ele, a última que não é progresso. O stderr de uma falha começa pelo progresso, que não é o erro. */
export function gitReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).reverse();
  return lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines.find((l) => !PROGRESS.test(l)) ?? lines[0] ?? 'erro do git sem mensagem';
}
