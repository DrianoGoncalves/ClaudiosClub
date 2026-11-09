import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cleanEnv } from '../auth';
import { checkFile, checkProject, maskSnippet, RULES, TEST_PATH, tooBigFile, type Finding, type ProjectCtx, type SourceFile } from './rules';

// Health check do projeto: varredura determinística (sem IA e sem token) com as regras de rules.ts.
// Num repositório git, a lista vem do próprio git (respeita o .gitignore); fora dele, uma varredura das pastas.

export interface HealthOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  timeBudgetMs?: number;
}

export interface HealthReport {
  disclaimer: string;
  scannedAt: string;
  durationMs: number;
  stats: {
    files: number;
    skipped: { binary: number; tooBig: number; generated: number };
    truncated: boolean;
    truncatedBy: 'files' | 'bytes' | 'time' | null;
  };
  summary: Record<'high' | 'medium' | 'low', number>;
  rules: typeof RULES;
  findings: Finding[];
}

const DEFAULTS: Required<HealthOptions> = { maxFiles: 5000, maxFileBytes: 1_000_000, maxTotalBytes: 30_000_000, timeBudgetMs: 10_000 };
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', '.next', '.git', '.myco', '.vps', 'coverage', '.cache']);
const GENERATED = /\.min\.js$|\.map$|\.snap$|\.svg$|(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/i;
const BINARY = /\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|tar|7z|rar|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|webm|wav|ogg|exe|dll|so|dylib|bin|class|jar|pyc|wasm|sqlite|db)$/i;
const DISCLAIMER = 'Checagem rápida, não auditoria: regras fixas por padrão de texto; pode haver falso positivo e risco que ela não vê.';
const RANK = { high: 0, medium: 1, low: 2 } as const;

// Uma varredura por projeto por vez: um clique repetido espera a que já está rodando.
const running = new Map<string, Promise<HealthReport>>();

export function checkProjectHealth(dir: string, opts: HealthOptions = {}): Promise<HealthReport> {
  const hit = running.get(dir);
  if (hit) return hit;
  const job = scan(dir, { ...DEFAULTS, ...opts }).finally(() => running.delete(dir));
  running.set(dir, job);
  return job;
}

async function scan(dir: string, o: Required<HealthOptions>): Promise<HealthReport> {
  const started = Date.now();
  const root = path.resolve(dir);
  const { files: all, tracked } = await listFiles(root, o.maxFiles);
  const skipped = { binary: 0, tooBig: 0, generated: 0 };
  const findings: Finding[] = [];
  let truncatedBy: HealthReport['stats']['truncatedBy'] = null;

  const candidates = all.filter((rel) => !rel.split('/').some((part) => SKIP_DIRS.has(part)));
  if (candidates.length > o.maxFiles) truncatedBy = 'files';
  const queue = truncatedBy ? candidates.slice(0, o.maxFiles) : candidates;

  const texts: SourceFile[] = [];
  let bytes = 0;
  for (const rel of queue) {
    if (Date.now() - started >= o.timeBudgetMs) {
      truncatedBy = 'time';
      break;
    }
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep)) continue;
    // lstat: symlink não é seguido, e quem não é arquivo comum fica de fora.
    const st = await fs.lstat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    if (BINARY.test(rel)) {
      skipped.binary++;
      continue;
    }
    if (GENERATED.test(rel)) {
      skipped.generated++;
      continue;
    }
    if (st.size > o.maxFileBytes) {
      skipped.tooBig++;
      findings.push(tooBigFile(rel, st.size));
      continue;
    }
    if (bytes + st.size > o.maxTotalBytes) {
      truncatedBy = 'bytes';
      break;
    }
    const buf = await fs.readFile(abs);
    bytes += buf.length;
    if (buf.subarray(0, 8192).includes(0)) {
      skipped.binary++;
      continue;
    }
    texts.push({ rel, text: buf.toString('utf8') });
  }

  const pkg = texts.find((f) => f.rel === 'package.json')?.text ?? '';
  const ctx: ProjectCtx = {
    usesSupabase: all.some((rel) => rel.startsWith('supabase/')) || pkg.includes('"@supabase/'),
    hasRootMiddleware: all.some((rel) => rel === 'middleware.ts' || rel === 'middleware.js'),
  };
  for (const f of texts) findings.push(...checkFile(f, ctx));
  findings.push(...checkProject(texts, tracked, ctx));

  // Código de teste tem segredo de mentira de propósito: high vira medium, em qualquer regra (loopback continua low).
  const masked = findings
    .map((f) => ({ ...f, severity: f.severity === 'high' && TEST_PATH.test(f.file) ? ('medium' as const) : f.severity, snippet: maskSnippet(f.snippet) }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const summary = { high: 0, medium: 0, low: 0 };
  for (const f of masked) summary[f.severity]++;

  return {
    disclaimer: DISCLAIMER,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stats: { files: texts.length, skipped, truncated: truncatedBy !== null, truncatedBy },
    summary,
    rules: RULES,
    findings: masked,
  };
}

/** Arquivos do projeto (caminhos com "/") e, quando há git, os rastreados (para o .env versionado). */
async function listFiles(root: string, max: number): Promise<{ files: string[]; tracked: string[] }> {
  const all = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).catch(() => null);
  if (all === null) return { files: await walk(root, max), tracked: [] };
  const cached = await git(root, ['ls-files', '--cached', '-z']).catch(() => '');
  return { files: splitZ(all), tracked: splitZ(cached) };
}

const splitZ = (out: string) => out.split('\0').filter(Boolean);

// Passa um pouco do limite para o scan saber que houve corte por arquivos.
async function walk(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  const queue = [''];
  while (queue.length && out.length <= max) {
    const rel = queue.shift()!;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
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
