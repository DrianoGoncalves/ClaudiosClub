import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { UpdateStatus } from '../shared/model';

// Atualizar o próprio Claudio’s Club pelo GitHub, por versão publicada: uma tag vX.Y.Z (o Release no GitHub).
// O que é mesclado no main não chega a ninguém até você publicar a versão. De tempos em tempos ele busca as tags
// do remoto (git fetch) e compara com a versão daqui. "Atualizar" só avança (fast-forward) até a tag, nunca
// mescla nem descarta nada: com mudança local no código, ou commit seu que a versão não tem, para e diz por quê.
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

const unsupported = (): UpdateStatus => ({
  supported: false,
  current: null,
  latest: null,
  behind: 0,
  diverged: false,
  dirty: false,
  notes: null,
  commits: [],
  checkedAt: null,
  error: null,
});

const RELEASE = /^v\d+\.\d+\.\d+$/;

/** O remoto de onde vêm as versões: o do branch seguido, ou o origin. */
async function remoteOf(root: string): Promise<string | null> {
  const tracked = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remotes = (await git(root, ['remote'])).out.split(/\r?\n/).filter(Boolean);
  const fromUpstream = tracked.ok ? remotes.find((r) => tracked.out.startsWith(`${r}/`)) : undefined;
  return fromUpstream ?? (remotes.includes('origin') ? 'origin' : (remotes[0] ?? null));
}

/** A versão daqui: a última tag de versão no histórico, ou a do package.json (antes da primeira tag). */
async function currentVersion(root: string): Promise<string | null> {
  const described = await git(root, ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD']);
  if (described.ok && described.out) return described.out;
  const pkg = await fs.readFile(path.join(root, 'package.json'), 'utf8').then((t) => JSON.parse(t) as { version?: string }, () => null);
  return pkg?.version ? `v${pkg.version}` : null;
}

/** O texto da tag anotada (as notas da versão); tag leve não tem. */
async function tagNotes(root: string, tag: string): Promise<string | null> {
  const r = await git(root, ['for-each-ref', `refs/tags/${tag}`, '--format=%(objecttype)%00%(contents:subject)%00%(contents:body)']);
  const [type, subject = '', body = ''] = r.out.split('\0');
  if (type !== 'tag') return null;
  return [subject.trim(), body.trim()].filter(Boolean).join('\n\n') || null;
}

/** Lê a versão daqui contra a mais nova publicada; com `fetch`, busca as tags antes (rede). */
export async function readUpdateStatus(root = ROOT, opts: { fetch: boolean } = { fetch: true }): Promise<UpdateStatus> {
  const isRepo = await fs.stat(path.join(root, '.git')).then(() => true, () => false);
  if (!isRepo) return unsupported();
  const remote = await remoteOf(root);
  if (!remote) return unsupported();

  const fetched = opts.fetch ? await git(root, ['fetch', '--quiet', '--tags', remote], 60_000) : null;
  const [tags, status, current] = await Promise.all([
    git(root, ['tag', '--list', 'v*', '--sort=-v:refname']),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
    currentVersion(root),
  ]);
  const latest = tags.out.split(/\r?\n/).find((t) => RELEASE.test(t)) ?? null;
  const base = {
    ...unsupported(),
    supported: true,
    current,
    latest,
    dirty: status.ok && status.out.length > 0,
    checkedAt: new Date().toISOString(),
    error: fetched && !fetched.ok ? gitMessage(fetched) : null,
  };
  if (!latest) return base;

  const [count, log, contained, notes] = await Promise.all([
    git(root, ['rev-list', '--count', `HEAD..${latest}`]),
    git(root, ['log', `--max-count=${MAX_COMMITS}`, '--format=%h%x09%cI%x09%s', `HEAD..${latest}`]),
    git(root, ['merge-base', '--is-ancestor', 'HEAD', latest]),
    tagNotes(root, latest),
  ]);
  const behind = Number(count.out) || 0;
  return {
    ...base,
    behind,
    // Tem coisa nova na versão, mas este código não está no caminho dela: não dá para só avançar.
    diverged: behind > 0 && !contained.ok,
    notes: behind > 0 ? notes : null,
    commits: log.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash = '', at = '', ...subject] = line.split('\t');
        return { hash, at, subject: subject.join('\t') };
      }),
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

/** Busca, avança até a versão mais nova (só fast-forward) e, se as dependências mudaram, instala. */
export async function applyUpdate(root = ROOT, install = npmInstall): Promise<UpdateResult> {
  const s = await readUpdateStatus(root);
  if (!s.supported) throw new UpdateError('o Claudio’s Club não está num clone git do GitHub');
  if (s.error) throw new UpdateError(`não consegui buscar as versões: ${s.error}`);
  if (!s.latest || s.behind === 0) throw new UpdateError('já está na versão mais nova');
  if (s.dirty) throw new UpdateError('há arquivos do Claudio’s Club mudados à mão: guarde ou desfaça (git stash) e tente de novo');
  if (s.diverged) throw new UpdateError(`este código tem commits que a ${s.latest} não tem: atualize pelo terminal (git merge ${s.latest})`);

  const from = s.current ?? (await git(root, ['rev-parse', '--short', 'HEAD'])).out;
  const changed = await git(root, ['diff', '--name-only', 'HEAD', s.latest, '--', 'package.json', 'package-lock.json']);
  const merged = await git(root, ['merge', '--ff-only', '--quiet', s.latest], 60_000);
  if (!merged.ok) throw new UpdateError(`o git não conseguiu avançar: ${gitMessage(merged)}`);
  const to = s.latest;

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
