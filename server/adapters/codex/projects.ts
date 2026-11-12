import { promises as fs, realpathSync, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, pathKey, worktreeParent } from '../claude/paths';
import { codexHome } from './rollout';

// Pastas que o Codex (OpenAI Codex CLI/app) conhece, para o "Importar" listar também as dele. Só leitura, de duas fontes:
// as tabelas `[projects.'…']` do config.toml (sem parser de TOML: só essas linhas) e o `cwd` da 1ª linha (session_meta)
// de cada rollout `.jsonl` em sessions/AAAA/MM/DD. Nada de auth.json nem de outro arquivo do ~/.codex.

export interface CodexProject {
  /** Pasta, com a caixa real no Windows. */
  path: string;
  /** Último rollout gravado nela (mtime). Ausente se só o config.toml a cita. */
  lastActivityAt?: string;
}

export interface CodexProjectsOptions {
  /** Inclui pastas dentro da temporária do sistema (pastas de teste). Padrão: fora. */
  includeTemp?: boolean;
}

/** Quantos rollouts (os mais novos) são lidos. O resto é mais antigo e não muda a lista de forma útil. */
const MAX_ROLLOUTS = 300;
/**
 * Começo do rollout onde fica o `cwd`. A 1ª linha (session_meta) passa de 16 KB, então não dá para fazer JSON.parse
 * nela; o `cwd` vem bem antes desse limite (no começo da linha), e a busca é por ele dentro da 1ª linha.
 */
const HEAD_BYTES = 16 * 1024;

/** `[projects.'caminho']` (literal) ou `[projects."caminho"]` (basic, com `\\` escapado), uma tabela por linha. */
const PROJECT_TABLE = /^[ \t]*\[projects\.(?:'([^'\r\n]*)'|"((?:[^"\\\r\n]|\\.)*)")\][ \t]*$/gm;
const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/;

/**
 * As pastas que o Codex conhece e que existem, normalizadas e sem as que não são projeto: dentro do próprio
 * CODEX_HOME (inclui `~/.codex/worktrees`), na temporária (sem `includeTemp`), worktree do git ou do Claude Code.
 * Uma pasta que aparece várias vezes (outra caixa, config e rollout) sai uma vez, com a atividade mais recente.
 * Tolerante: arquivo ausente ou quebrado não derruba; o que não lê, não entra.
 */
export async function listCodexProjects(home = codexHome(), opts: CodexProjectsOptions = {}): Promise<CodexProject[]> {
  const sources = [...(await configPaths(home)).map((p) => ({ p, ms: 0 })), ...(await rolloutCwds(home))];
  const checked = new Map<string, string | null>();
  const byKey = new Map<string, { path: string; ms: number }>();
  for (const { p, ms } of sources) {
    if (!checked.has(p)) checked.set(p, await usableDir(p, home, opts));
    const real = checked.get(p) ?? null;
    if (!real) continue;
    const key = pathKey(real);
    const prev = byKey.get(key);
    byKey.set(key, { path: prev?.path ?? real, ms: Math.max(prev?.ms ?? 0, ms) });
  }
  return [...byKey.values()]
    .sort((a, b) => b.ms - a.ms)
    .map((e): CodexProject => (e.ms ? { path: e.path, lastActivityAt: new Date(e.ms).toISOString() } : { path: e.path }));
}

/** A pasta com a caixa real, se existe, é diretório e é um projeto possível; senão null. */
async function usableDir(p: string, home: string, opts: CodexProjectsOptions): Promise<string | null> {
  if (!path.isAbsolute(p)) return null;
  let real: string;
  try {
    const resolved = path.resolve(p);
    // Só no Windows: a caixa das letras vem do disco (o config.toml costuma trazer tudo em minúsculas).
    real = process.platform === 'win32' ? realpathSync.native(resolved) : resolved;
  } catch {
    return null;
  }
  const st = await fs.stat(real).catch(() => null);
  if (!st?.isDirectory()) return null;
  if (isInside(real, home) || (!opts.includeTemp && isInside(real, os.tmpdir())) || worktreeParent(real)) return null;
  if (await isGitWorktree(real)) return null;
  return real;
}

/** Worktree do git: o `.git` é arquivo com `gitdir: …/worktrees/…`. (Submódulo também tem `.git` arquivo, mas aponta para `modules/`.) */
async function isGitWorktree(dir: string): Promise<boolean> {
  const text = await fs.readFile(path.join(dir, '.git'), 'utf8').catch(() => null);
  return text !== null && /^gitdir:.*[\\/]worktrees[\\/]/m.test(text);
}

/** Os caminhos das tabelas `[projects…]` do config.toml (sem ler o resto do arquivo). */
async function configPaths(home: string): Promise<string[]> {
  const text = await fs.readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '');
  return [...text.matchAll(PROJECT_TABLE)].map((m) => (m[1] !== undefined ? m[1] : unescapeBasic(m[2] ?? '')));
}

/** Basic string do TOML: só `\\` e `\"` importam para caminho. */
function unescapeBasic(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

/** `cwd` de cada rollout `.jsonl` (o `.zst` fica de fora), do mais novo para o mais antigo, até MAX_ROLLOUTS arquivos. */
async function rolloutCwds(home: string): Promise<Array<{ p: string; ms: number }>> {
  const out: Array<{ p: string; ms: number }> = [];
  const root = path.join(home, 'sessions');
  let visited = 0;
  for (const y of await subdirs(root))
    for (const m of await subdirs(path.join(root, y)))
      for (const d of await subdirs(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const names = (await fs.readdir(dir).catch((): string[] => []))
          .filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
          .sort()
          .reverse();
        for (const name of names) {
          if (++visited > MAX_ROLLOUTS) return out;
          const file = path.join(dir, name);
          const st = await fs.stat(file).catch(() => null);
          if (!st?.isFile()) continue;
          const cwd = await sessionCwd(file);
          if (cwd) out.push({ p: cwd, ms: st.mtimeMs });
        }
      }
  return out;
}

/** Pastas filhas, da mais nova para a mais antiga (AAAA, MM e DD têm largura fixa: a ordem por nome serve). */
async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** O `cwd` do rollout, lido da 1ª linha (session_meta). Null se a 1ª linha não é session_meta ou não traz cwd. */
async function sessionCwd(file: string): Promise<string | null> {
  const first = (await readHead(file)).split('\n', 1)[0] ?? '';
  if (!first.includes('"type":"session_meta"')) return null;
  const m = CWD.exec(first);
  if (!m) return null;
  try {
    const v: unknown = JSON.parse(`"${m[1]}"`);
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Os primeiros HEAD_BYTES do arquivo, como texto. Vazio se não abre. */
async function readHead(file: string): Promise<string> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh.close();
  }
}
