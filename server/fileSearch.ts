import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanEnv } from './auth';

// "@" no chat: os arquivos do projeto que batem com o que foi digitado. Num repositório git, a
// lista vem do próprio git (respeita o .gitignore); fora dele, uma varredura curta das pastas.
// Fichas, segredos e pastas de dependências ficam de fora.

const LIMIT = 20;
const CACHE_MS = 30_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.next', '.cache', 'coverage', '.myco', '.vps']);
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|p12|pfx))$/i;

const cache = new Map<string, { at: number; files: string[] }>();
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export async function searchFiles(dir: string, query: string): Promise<string[]> {
  const files = await listFiles(dir);
  const words = fold(query).split(/[\s/\\]+/).filter(Boolean);
  const hits = words.length ? files.filter((f) => words.every((w) => fold(f).includes(w))) : files;
  // O nome do arquivo começando com o que foi digitado vem antes; depois, os caminhos mais curtos.
  const last = words.at(-1) ?? '';
  const score = (f: string) => (fold(path.posix.basename(f)).startsWith(last) ? 0 : 1);
  return [...hits].sort((a, b) => score(a) - score(b) || a.length - b.length || a.localeCompare(b)).slice(0, LIMIT);
}

async function listFiles(dir: string): Promise<string[]> {
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const fromGit = await git(dir, ['ls-files', '--cached', '--others', '--exclude-standard']).catch(() => null);
  const all = fromGit !== null ? fromGit.split(/\r?\n/).filter(Boolean) : await walk(dir);
  const files = all.filter((f) => !SECRET.test(f) && !f.split('/').some((part) => SKIP_DIRS.has(part)));
  cache.set(dir, { at: Date.now(), files });
  return files;
}

async function walk(root: string, max = 5000): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length < max) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && rel.split('/').length < 8) queue.push(child);
      } else if (e.isFile()) out.push(child);
    }
  }
  return out;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: cleanEnv(), windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}
