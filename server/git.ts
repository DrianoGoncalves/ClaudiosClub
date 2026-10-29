import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitState } from '../shared/model';

// Estado do código de cada projeto, para o cabeçalho da sala: branch, arquivos sem commit e distância
// do remoto. Só leitura (`git status`), sem rede: "atrás" conta o que o último fetch trouxe.

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; state: GitState | null }>();

/** A pasta `.myco/` é do próprio Claudio’s Club (fichas, imagens): não conta como trabalho sem commit. */
function isMycoPath(line: string): boolean {
  const file = line.startsWith('? ') ? line.slice(2) : line.split(' ').slice(-1)[0] ?? '';
  return file === '.myco/' || file.startsWith('.myco/');
}

/** `git status --porcelain=v2 --branch` → estado. */
export function parseStatus(out: string): GitState {
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice(14).trim();
      branch = head === '(detached)' ? null : head;
    } else if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line && !line.startsWith('#') && !isMycoPath(line)) dirty++;
  }
  return { branch, dirty, upstream, ahead, behind };
}

export async function gitState(projectPath: string, now = Date.now()): Promise<GitState | null> {
  const hit = cache.get(projectPath);
  if (hit && now - hit.at < TTL_MS) return hit.state;
  // Pasta sem .git (nem arquivo .git de worktree): nem chama o git.
  const isRepo = await fs.stat(path.join(projectPath, '.git')).then(() => true, () => false);
  const state = isRepo ? await run(projectPath) : null;
  cache.set(projectPath, { at: now, state });
  return state;
}

function run(cwd: string): Promise<GitState | null> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
      { windowsHide: true, timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : parseStatus(stdout)),
    ),
  );
}
