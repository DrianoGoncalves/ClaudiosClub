// Status do CI do GitHub (as check runs de um commit), lido pelo servidor (server/ciStatus.ts) e mostrado na página da versão e no cartão com PR.

/** `none` = o commit não tem nenhuma checagem (repositório sem CI); `unavailable` = não deu para ler (sem token, sem rede, limite da API). */
export type CiState = 'success' | 'failure' | 'pending' | 'none' | 'unavailable';

export interface CiCheck {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'neutral';
  /** O link da checagem no GitHub (só https://github.com/…). */
  url: string | null;
}

export interface CiStatus {
  state: CiState;
  sha: string | null;
  checks: CiCheck[];
  checkedAt: string;
  /** Por que está indisponível (para a dica), em pt-BR. */
  reason?: string;
}

/** O CI de um PR: o estado do PR, as checagens do último commit dele e, se mesclado, as do commit da mescla. Sem PR (ou PR de outro repositório): tudo null. */
export interface PrCi {
  pr: { number: number; state: 'open' | 'closed' | 'merged'; mergeSha: string | null } | null;
  head: CiStatus | null;
  merge: CiStatus | null;
}

/** Uma check run do GitHub, como a API devolve. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

const OK = new Set(['success']);
const NEUTRAL = new Set(['neutral', 'skipped']);

/** O estado de uma check run: rodando enquanto não termina; neutra/pulada não reprova; o resto (falha, cancelada, tempo esgotado, ação pedida) reprova. */
export function checkState(r: CheckRun): CiCheck['state'] {
  if (r.status !== 'completed') return 'pending';
  if (r.conclusion && OK.has(r.conclusion)) return 'success';
  if (r.conclusion && NEUTRAL.has(r.conclusion)) return 'neutral';
  return 'failure';
}

/** O resumo das checagens de um commit: falha em qualquer uma vence; depois, alguma rodando; sem nenhuma, `none`. A mesma checagem repetida vale a última. */
export function summarizeChecks(runs: CheckRun[]): { state: Exclude<CiState, 'unavailable'>; checks: CiCheck[] } {
  const byName = new Map<string, CheckRun>();
  for (const r of runs) byName.set(r.name, r);
  const checks = [...byName.values()].map((r) => ({ name: r.name.slice(0, 120), state: checkState(r), url: r.url && /^https:\/\/github\.com\//.test(r.url) ? r.url : null }));
  if (!checks.length) return { state: 'none', checks };
  if (checks.some((c) => c.state === 'failure')) return { state: 'failure', checks };
  if (checks.some((c) => c.state === 'pending')) return { state: 'pending', checks };
  return { state: 'success', checks };
}

/** `https://github.com/dono/repo/pull/12` → dono, repo e número; null se não for um link de PR do GitHub. */
export function parsePrUrl(url: string | null | undefined): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/(\d{1,9})\/?$/.exec((url ?? '').trim());
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null;
}
