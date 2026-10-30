import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '../shared/model';

// Atualizar o próprio Claudio’s Club pelo GitHub. Ele roda de um clone git: de tempos em tempos busca o remoto
// (git fetch) e conta o que chegou no branch que ele segue. "Atualizar" só avança (fast-forward), nunca mescla
// nem descarta nada: com mudança local no código, ou commit seu que o remoto não tem, para e diz por quê.
// Mudou o package.json ou o lock, roda o npm install. Quem reinicia é o servidor (com o vigia, ele sobe de novo
// e refaz o build do cliente, que ficou mais velho que o código).

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_COMMITS = 20;

export class UpdateError extends Error {}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(root: string, args: string[], timeout = 15_000): Promise<GitResult> {
  return new Promise((resolve) =>
    execFile(
      'git',
      ['-C', root, ...args],
      // Sem senha a pedir: um remoto que exige login falha na hora, em vez de travar à espera.
      { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || (err?.message ?? '') }),
    ),
  );
}

/** Primeira linha útil do erro do git, sem o "fatal: ". */
const gitMessage = (r: GitResult) => (r.err.split(/\r?\n/).find((l) => l.trim()) ?? 'erro desconhecido').replace(/^(fatal|error): /, '');

const unsupported = (): UpdateStatus => ({ supported: false, upstream: null, behind: 0, ahead: 0, dirty: false, commits: [], checkedAt: null, error: null });

/** Lê o estado contra o remoto; com `fetch`, busca antes (rede). */
export async function readUpdateStatus(root = ROOT, opts: { fetch: boolean } = { fetch: true }): Promise<UpdateStatus> {
  const isRepo = await fs.stat(path.join(root, '.git')).then(() => true, () => false);
  if (!isRepo) return unsupported();
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) return unsupported();

  const fetched = opts.fetch ? await git(root, ['fetch', '--quiet'], 60_000) : null;
  const [counts, log, status] = await Promise.all([
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    git(root, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%cI%x09%s', 'HEAD..@{u}']),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const [ahead = 0, behind = 0] = counts.out.split(/\s+/).map(Number);
  return {
    supported: true,
    upstream: upstream.out,
    behind,
    ahead,
    dirty: status.ok && status.out.length > 0,
    commits: log.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash = '', at = '', ...subject] = line.split('\t');
        return { hash, at, subject: subject.join('\t') };
      }),
    checkedAt: new Date().toISOString(),
    error: fetched && !fetched.ok ? gitMessage(fetched) : null,
  };
}

export interface UpdateResult {
  from: string;
  to: string;
  /** Rodou o npm install (as dependências mudaram). */
  installed: boolean;
}

function npmInstall(root: string): Promise<GitResult> {
  const win = process.platform === 'win32';
  return new Promise((resolve) =>
    execFile(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      { cwd: root, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, shell: win },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || (err?.message ?? '') }),
    ),
  );
}

/** Busca, avança até o remoto (só fast-forward) e, se as dependências mudaram, instala. */
export async function applyUpdate(root = ROOT, install = npmInstall): Promise<UpdateResult> {
  const s = await readUpdateStatus(root);
  if (!s.supported) throw new UpdateError('o Claudio’s Club não está num clone git que segue um branch do GitHub');
  if (s.error) throw new UpdateError(`não consegui buscar as novidades: ${s.error}`);
  if (s.behind === 0) throw new UpdateError('já está na versão mais nova');
  if (s.dirty) throw new UpdateError('há arquivos do Claudio’s Club mudados à mão: guarde ou desfaça (git stash) e tente de novo');
  if (s.ahead > 0) throw new UpdateError(`há ${s.ahead} commit(s) seus que o ${s.upstream} não tem: atualize pelo terminal (git pull)`);

  const from = (await git(root, ['rev-parse', '--short', 'HEAD'])).out;
  const changed = await git(root, ['diff', '--name-only', 'HEAD', '@{u}', '--', 'package.json', 'package-lock.json']);
  const merged = await git(root, ['merge', '--ff-only', '--quiet', '@{u}'], 60_000);
  if (!merged.ok) throw new UpdateError(`o git não conseguiu avançar: ${gitMessage(merged)}`);
  const to = (await git(root, ['rev-parse', '--short', 'HEAD'])).out;

  const needsInstall = changed.ok && changed.out.length > 0;
  if (needsInstall) {
    const r = await install(root);
    if (!r.ok) throw new UpdateError(`o código foi atualizado (${from} → ${to}), mas o npm install falhou: rode npm run setup no terminal`);
  }
  return { from, to, installed: needsInstall };
}

/**
 * Status guardado para o quadro: busca no remoto ao subir e a cada 6 h; "procurar agora" busca de novo, no
 * máximo uma vez por minuto. Um pedido por vez (fetch e atualização não se cruzam).
 */
export class SelfUpdater {
  private status: UpdateStatus | null = null;
  private running: Promise<unknown> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root = ROOT,
    private readonly every = 6 * 60 * 60_000,
  ) {}

  start(delay = 15_000) {
    const tick = () => void this.check(true).catch(() => {});
    setTimeout(tick, delay).unref();
    this.timer = setInterval(tick, this.every);
    this.timer.unref();
  }

  async check(fresh = false): Promise<UpdateStatus> {
    const age = this.status?.checkedAt ? Date.now() - Date.parse(this.status.checkedAt) : Infinity;
    if (this.status && (!fresh || age < 60_000)) return this.status;
    return this.exclusive(async () => (this.status = await readUpdateStatus(this.root)));
  }

  async apply(): Promise<UpdateResult> {
    return this.exclusive(async () => {
      try {
        return await applyUpdate(this.root);
      } finally {
        this.status = await readUpdateStatus(this.root, { fetch: false }).catch(() => this.status);
      }
    });
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => {});
    const p = fn();
    this.running = p;
    try {
      return await p;
    } finally {
      this.running = null;
    }
  }
}
