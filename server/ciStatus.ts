import { summarizeChecks, type CiStatus, type PrCi } from '../shared/ci';
import { GitHubError, GitHubRateLimited, type GitHubCiClient } from './adapters/github/client';

// Status do CI do GitHub para a tela (página da versão, histórico e cartão com PR) e para a regra da tag (ver server/release.ts). A consulta é sempre
// sob demanda (a tela pede ao abrir e, enquanto o CI roda, em intervalo longo) e nunca no polling da tela; cada commit é consultado no máximo uma vez a cada
// PENDING_TTL_MS enquanto roda, e o resultado final (verde, vermelho, sem CI) fica guardado para sempre (o commit não muda). Pedidos iguais em voo dividem a mesma
// ida ao GitHub. Repositório só o do origin do próprio projeto (nunca um que a tela mande). Token: o do `gh` do dono, pedido ao `gh auth token`, só na memória
// e só para a API do GitHub (ver adapters/github/client.ts); sem ele, a consulta vai sem token (repositório público) e o privado fica "indisponível".

/** Enquanto o CI roda (ou deu indisponível), a próxima consulta ao GitHub para o mesmo commit espera isto. */
export const PENDING_TTL_MS = 60_000;
/** O PR aberto: o estado (aberto, mesclado) é relido no máximo a cada isto. */
const PR_TTL_MS = 60_000;
/** O token do `gh` vale isto na memória (e a falta dele também, para não chamar o `gh` a cada consulta). */
const TOKEN_TTL_MS = 10 * 60_000;
/** Teto do que fica guardado (commits e PRs). */
const CACHE_MAX = 500;
const SHA = /^[0-9a-f]{40}$/;

export interface CiDeps {
  client: GitHubCiClient;
  /** O `owner/repo` do origin do projeto (só GitHub); null = não é GitHub ou o projeto não existe. */
  repoOf: (projectId: string) => Promise<{ owner: string; repo: string } | null>;
  /** O token do `gh` do dono (`gh auth token`); null = sem login. Não lança. */
  token: () => Promise<string | null>;
  now?: () => number;
}

interface Cached<T> {
  value: T;
  at: number;
  final: boolean;
}

export class CiService {
  private commits = new Map<string, Cached<CiStatus>>();
  private pulls = new Map<string, Cached<{ state: 'open' | 'closed'; merged: boolean; headSha: string; mergeSha: string | null }>>();
  private tokenCache: { value: string | null; at: number } | null = null;

  constructor(private readonly deps: CiDeps) {}

  private now = () => this.deps.now?.() ?? Date.now();

  private async token(): Promise<string | null> {
    if (this.tokenCache && this.now() - this.tokenCache.at < TOKEN_TTL_MS) return this.tokenCache.value;
    const value = await this.deps.token().catch(() => null);
    this.tokenCache = { value, at: this.now() };
    return value;
  }

  private remember<T>(map: Map<string, Cached<T>>, key: string, value: T, final: boolean): T {
    map.delete(key);
    map.set(key, { value, at: this.now(), final });
    if (map.size > CACHE_MAX) map.delete(map.keys().next().value!);
    return value;
  }

  private unavailable(sha: string | null, err: unknown): CiStatus {
    const reason =
      err instanceof GitHubRateLimited
        ? err.message
        : err instanceof GitHubError && (err.status === 404 || err.status === 401 || err.status === 403)
          ? 'sem acesso ao repositório no GitHub (o gh está logado nesta máquina?)'
          : err instanceof GitHubError
            ? err.message
            : 'não consegui falar com o GitHub';
    return { state: 'unavailable', sha, checks: [], checkedAt: new Date(this.now()).toISOString(), reason };
  }

  /** As checagens de um commit do repositório do projeto. Nunca lança: sem GitHub, sem token ou sem rede vira `unavailable`. */
  async commit(projectId: string, sha: string): Promise<CiStatus> {
    if (!SHA.test(sha)) return { state: 'unavailable', sha: null, checks: [], checkedAt: new Date(this.now()).toISOString(), reason: 'commit inválido' };
    const repo = await this.deps.repoOf(projectId).catch(() => null);
    if (!repo) return { state: 'unavailable', sha, checks: [], checkedAt: new Date(this.now()).toISOString(), reason: 'o origin deste projeto não é um repositório do GitHub' };
    const key = `${repo.owner}/${repo.repo}@${sha}`;
    const hit = this.commits.get(key);
    if (hit && (hit.final || this.now() - hit.at < PENDING_TTL_MS)) return hit.value;
    try {
      const runs = await this.deps.client.checkRuns(repo.owner, repo.repo, sha, await this.token());
      const s = summarizeChecks(runs);
      const value: CiStatus = { state: s.state, sha, checks: s.checks, checkedAt: new Date(this.now()).toISOString() };
      return this.remember(this.commits, key, value, s.state !== 'pending');
    } catch (err) {
      return this.remember(this.commits, key, this.unavailable(sha, err), false);
    }
  }

  /** O CI de um PR do repositório do projeto: o estado do PR, as checagens do último commit e, mesclado, as do commit da mescla. Nunca lança. */
  async pull(projectId: string, number: number): Promise<PrCi> {
    const repo = await this.deps.repoOf(projectId).catch(() => null);
    if (!repo) return { pr: null, head: this.unavailable(null, new GitHubError('o origin deste projeto não é um repositório do GitHub')), merge: null };
    const key = `${repo.owner}/${repo.repo}#${number}`;
    let pr = this.pulls.get(key);
    if (!pr || (!pr.final && this.now() - pr.at >= PR_TTL_MS)) {
      try {
        const value = await this.deps.client.pull(repo.owner, repo.repo, number, await this.token());
        this.remember(this.pulls, key, value, value.state === 'closed');
        pr = this.pulls.get(key)!;
      } catch (err) {
        if (!pr) return { pr: null, head: this.unavailable(null, err), merge: null };
      }
    }
    const p = pr.value;
    const head = await this.commit(projectId, p.headSha);
    const merge = p.merged && p.mergeSha ? await this.commit(projectId, p.mergeSha) : null;
    return { pr: { number, state: p.merged ? 'merged' : p.state, mergeSha: p.mergeSha }, head, merge };
  }
}
