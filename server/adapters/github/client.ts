import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MYCO_HOME } from '../../config';
import { writeAtomic } from '../../staff/store';

// Adaptador do GitHub para instalar skills de repositório PÚBLICO. Não manda token nem cookie, e não sabe de skill:
// quem chama (server/skillInstall.ts) recebe dados ou um GitHubError com mensagem para o usuário. Cache em ~/.myco/cache/github
// (refs com TTL curto; árvore e blob são imutáveis pelo sha, então ficam para sempre).

/** Erro do GitHub com mensagem para o usuário (400). `status` vem quando houve resposta HTTP. */
export class GitHubError extends Error {
  status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Limite de consultas da API atingido: `resetAt` (ISO) é quando volta. A rota responde 429. */
export class GitHubRateLimited extends GitHubError {
  resetAt: string;
  constructor(resetAt: string) {
    super(`limite de consultas do GitHub atingido: tente de novo depois de ${new Date(resetAt).toLocaleTimeString('pt-BR')}`, 429);
    this.resetAt = resetAt;
  }
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

export interface GitHubTree {
  /** Sha da árvore da raiz do commit. */
  sha: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export interface GitHubClient {
  /** `ref` null = branch padrão. Devolve o nome do ref usado e o sha do commit. */
  resolveRef(owner: string, repo: string, ref: string | null): Promise<{ ref: string; sha: string }>;
  tree(owner: string, repo: string, sha: string): Promise<GitHubTree>;
  /** Conteúdo de um arquivo no commit `sha`, conferido pelo sha1 de git (`expectedBlobSha`). Passa de `maxBytes`: erro. */
  blob(owner: string, repo: string, sha: string, filePath: string, expectedBlobSha: string, maxBytes: number): Promise<Buffer>;
}

/** Trocas para teste: fetch, espera, sorteio do jitter, relógio e pasta do cache. */
export interface GitHubDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  cacheDir?: string;
}

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const BASE_MS = 1_000;
const MAX_WAIT_MS = 60_000;
const MAX_HOPS = 3;
const REF_TTL_MS = 10 * 60_000;
const FAILS_TO_BREAK = 5;
const BREAK_MS = 5 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/** Dono e repositório que o GitHub aceita (`.` e `..` ficam de fora). */
export function validRepo(owner: string, repo: string): boolean {
  return OWNER.test(owner) && REPO.test(repo) && repo !== '.' && repo !== '..';
}

/** Branch, tag ou commit com cara de nome git: sem `..`, sem barra nas pontas, sem caractere estranho. */
export function validRef(ref: string): boolean {
  return ref.length <= 200 && /^[A-Za-z0-9._/-]+$/.test(ref) && !ref.includes('..') && !ref.startsWith('/') && !ref.endsWith('/') && !ref.startsWith('-');
}

/** O sha1 de um blob de git (`blob <tamanho>\0<conteúdo>`): é o que a árvore do GitHub informa para cada arquivo. */
export function gitBlobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function createGitHubClient(deps: GitHubDeps = {}): GitHubClient {
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const cacheDir = deps.cacheDir ?? path.join(MYCO_HOME, 'cache', 'github');
  const refsFile = path.join(cacheDir, 'refs.json');

  // Disjuntores: a API fica sem chamar até `rateResetAt`; falhas de rede/5xx seguidas param tudo por 5 min.
  let rateResetAt = 0;
  let failUntil = 0;
  let failures = 0;
  // Pedidos iguais em voo compartilham a mesma promessa (ex.: duas prévias do mesmo repositório).
  const inflight = new Map<string, Promise<unknown>>();

  function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
    const hit = inflight.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function recordFailure() {
    failures++;
    if (failures >= FAILS_TO_BREAK) {
      failUntil = now() + BREAK_MS;
      failures = 0;
    }
  }

  const backoff = (attempt: number, waitMs = 0) => Math.max(BASE_MS * 2 ** (attempt - 1) + random() * BASE_MS, waitMs);

  /** Segue redirecionamento só para o próprio GitHub (rename de repo dá 301 para api.github.com/repositories/...). */
  async function follow(start: string, headers: Record<string, string>): Promise<Response> {
    let url = start;
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!REDIRECTS.has(res.status)) return res;
      void res.body?.cancel().catch(() => undefined);
      const next = safeUrl(res.headers.get('location'), url);
      if (!next || next.protocol !== 'https:' || !HOSTS.has(next.hostname) || next.username || next.password || next.port) {
        throw new GitHubError('redirecionamento para fora do GitHub: recusado');
      }
      if (hop >= MAX_HOPS) throw new GitHubError('redirecionamento demais no GitHub');
      url = next.href;
    }
  }

  async function get(url: string, api: boolean, accept: string): Promise<Response> {
    const headers: Record<string, string> = { 'user-agent': 'claudios-club', accept };
    if (api) headers['x-github-api-version'] = '2022-11-28';
    for (let attempt = 1; ; attempt++) {
      if (api && rateResetAt > now()) throw rateLimited(rateResetAt);
      if (failUntil > now()) throw new GitHubError('o GitHub está falhando: tente de novo daqui a alguns minutos');
      let res: Response;
      try {
        res = await follow(url, headers);
      } catch (err) {
        if (err instanceof GitHubError) throw err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoff(attempt));
          continue;
        }
        recordFailure();
        throw new GitHubError('não consegui falar com o GitHub (rede ou tempo esgotado)');
      }
      if (res.ok) {
        failures = 0;
        return res;
      }
      void res.body?.cancel().catch(() => undefined);
      if (api && (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        const reset = Number(res.headers.get('x-ratelimit-reset'));
        rateResetAt = reset > 0 ? reset * 1000 : now() + 60_000;
        throw rateLimited(rateResetAt);
      }
      // Limite secundário (403/429 com retry-after) e 5xx: tenta de novo com espera; 404/422 não repetem.
      const retryAfter = Number(res.headers.get('retry-after') ?? NaN) * 1000;
      const transient = res.status >= 500 || ((res.status === 429 || res.status === 403) && Number.isFinite(retryAfter));
      const wait = Number.isFinite(retryAfter) ? retryAfter : 0;
      if (transient && attempt < MAX_ATTEMPTS && wait <= MAX_WAIT_MS) {
        await sleep(backoff(attempt, wait));
        continue;
      }
      if (res.status >= 500) recordFailure();
      throw new GitHubError(messageOf(res.status), res.status);
    }
  }

  async function json(url: string, accept = 'application/vnd.github+json'): Promise<unknown> {
    const res = await get(url, true, accept);
    try {
      return JSON.parse(await res.text());
    } catch {
      throw new GitHubError('resposta do GitHub ilegível');
    }
  }

  async function loadRefs(): Promise<Record<string, RefEntry>> {
    const raw = await readJson(refsFile);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, RefEntry>) : {};
  }

  async function remember(key: string, entry: RefEntry): Promise<void> {
    const refs = await loadRefs();
    refs[key] = entry;
    await writeAtomic(refsFile, JSON.stringify(refs)).catch(() => undefined);
  }

  async function resolveRef(owner: string, repo: string, ref: string | null): Promise<{ ref: string; sha: string }> {
    if (!validRepo(owner, repo)) throw new GitHubError('repositório inválido');
    if (ref !== null && !validRef(ref)) throw new GitHubError('referência inválida', 422);
    return shared(`ref:${owner}/${repo}@${ref ?? ''}`, async () => {
      let name = ref;
      if (name === null) {
        const key = `${owner}/${repo}@`;
        const hit = (await loadRefs())[key];
        if (hit?.branch && now() - hit.at < REF_TTL_MS) {
          name = hit.branch;
        } else {
          const info = (await json(`${API}/repos/${owner}/${repo}`)) as { default_branch?: unknown };
          if (typeof info.default_branch !== 'string' || !validRef(info.default_branch)) throw new GitHubError('não achei o branch padrão do repositório');
          name = info.default_branch;
          await remember(key, { branch: name, at: now() });
        }
      }
      const key = `${owner}/${repo}@${name}`;
      const hit = (await loadRefs())[key];
      if (hit?.sha && SHA.test(hit.sha) && now() - hit.at < REF_TTL_MS) return { ref: name, sha: hit.sha };
      const res = await get(`${API}/repos/${owner}/${repo}/commits/${encodePath(name)}`, true, 'application/vnd.github.sha');
      const sha = (await res.text()).trim();
      if (!SHA.test(sha)) throw new GitHubError('o GitHub não devolveu um commit válido');
      await remember(key, { sha, at: now() });
      return { ref: name, sha };
    });
  }

  function tree(owner: string, repo: string, sha: string): Promise<GitHubTree> {
    if (!validRepo(owner, repo) || !SHA.test(sha)) throw new GitHubError('pedido inválido ao GitHub');
    return shared(`tree:${owner}/${repo}@${sha}`, async () => {
      const file = path.join(cacheDir, 'trees', `${owner}__${repo}__${sha}.json`);
      const cached = await readJson(file);
      if (isTree(cached)) return cached;
      const out = parseTree(await json(`${API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`));
      await writeAtomic(file, JSON.stringify(out)).catch(() => undefined);
      return out;
    });
  }

  function blob(owner: string, repo: string, sha: string, filePath: string, expectedBlobSha: string, maxBytes: number): Promise<Buffer> {
    if (!validRepo(owner, repo) || !SHA.test(sha) || !SHA.test(expectedBlobSha)) throw new GitHubError('pedido inválido ao GitHub');
    return shared(`blob:${expectedBlobSha}`, async () => {
      const file = path.join(cacheDir, 'blobs', expectedBlobSha);
      const cached = await fs.readFile(file).catch(() => null);
      if (cached && gitBlobSha(cached) === expectedBlobSha) return cached;
      // Raw não conta no limite de consultas da API.
      const res = await get(`${RAW}/${owner}/${repo}/${sha}/${encodePath(filePath)}`, false, '*/*');
      const bytes = await readLimited(res, maxBytes);
      if (gitBlobSha(bytes) !== expectedBlobSha) throw new GitHubError(`${filePath} não bate com o que o GitHub registrou (sha1 diferente)`);
      await writeBinary(file, bytes);
      return bytes;
    });
  }

  return { resolveRef, tree, blob };
}

interface RefEntry {
  sha?: string;
  branch?: string;
  at: number;
}

/** O cliente padrão (cache em ~/.myco/cache/github). Quem testa cria o seu com `createGitHubClient`. */
export const github: GitHubClient = createGitHubClient();

const rateLimited = (ms: number) => new GitHubRateLimited(new Date(ms).toISOString());

function messageOf(status: number): string {
  if (status === 404) return 'não achei no GitHub (o repositório é público e o caminho existe?)';
  if (status === 422) return 'o GitHub não reconheceu essa referência (branch, tag ou commit)';
  if (status === 401 || status === 403) return 'o GitHub recusou o pedido (o repositório é público?)';
  return `o GitHub respondeu ${status}`;
}

function safeUrl(loc: string | null, base: string): URL | null {
  if (!loc) return null;
  try {
    return new URL(loc, base);
  } catch {
    return null;
  }
}

/** Lê o corpo até `maxBytes`; passou disso, cancela e recusa (o declarado no cabeçalho também conta). */
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    void res.body?.cancel().catch(() => undefined);
    throw new GitHubError('arquivo maior que o declarado: recusado');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubError('arquivo maior que o declarado: recusado');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof GitHubError) throw err;
    throw new GitHubError('não consegui ler o arquivo do GitHub (rede ou tempo esgotado)');
  }
  return Buffer.concat(chunks);
}

function parseTree(body: unknown): GitHubTree {
  const b = body as { sha?: unknown; tree?: unknown; truncated?: unknown } | null;
  if (!b || typeof b.sha !== 'string' || !Array.isArray(b.tree)) throw new GitHubError('árvore do GitHub inválida');
  const entries = b.tree.map((e): TreeEntry => {
    const x = e as Record<string, unknown>;
    if (typeof x.path !== 'string' || typeof x.mode !== 'string' || typeof x.type !== 'string' || typeof x.sha !== 'string') {
      throw new GitHubError('árvore do GitHub inválida');
    }
    return { path: x.path, mode: x.mode, type: x.type, sha: x.sha, ...(typeof x.size === 'number' && { size: x.size }) };
  });
  return { sha: b.sha, entries, truncated: b.truncated === true };
}

const isTree = (v: unknown): v is GitHubTree => !!v && typeof v === 'object' && typeof (v as GitHubTree).sha === 'string' && Array.isArray((v as GitHubTree).entries);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Blob grava em arquivo temporário ao lado e troca pelo nome (writeAtomic de staff/store só aceita texto). */
async function writeBinary(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, bytes, { flag: 'wx' });
    await fs.rename(tmp, file);
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Cada segmento codificado, com as barras no lugar (caminho de arquivo ou de ref). */
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
