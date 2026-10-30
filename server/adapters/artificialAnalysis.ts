import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import type { IndexMetric, ModelBenchmark, ModelBenchmarks, ModelVariant } from '../../shared/model';

// Índice de código e preço dos modelos pela API gratuita do Artificial Analysis
// (https://artificialanalysis.ai/api-reference: pede crédito ao site e cache das respostas, 1.000
// chamadas por dia). A chave fica no .env da pasta do Claudio’s Club e só é lida aqui: não entra no
// process.env (as sessões dos funcionários herdam o ambiente do servidor) nem vai ao navegador.

const API_URL = 'https://artificialanalysis.ai/api/v2/data/llms/models';
export const KEY_NAME = 'ARTIFICIAL_ANALYSIS_API_KEY';
const ENV_FILE = path.resolve(import.meta.dirname, '../../.env');

/** Quantos modelos o ranking mostra. */
const TOP = 20;
/** Só os fornecedores que interessam aqui (slug do `model_creator` na API): Claude e OpenAI. */
const CREATORS = new Set(['anthropic', 'openai']);
/** Sem pedido de atualizar, os dados valem por 6 h (mudam pouco). */
const CACHE_MS = 6 * 60 * 60_000;
/** Atualizar de novo antes de 1 min devolve o que já veio. */
const MIN_REFRESH_MS = 60_000;
const TIMEOUT_MS = 10_000;
const ATTEMPTS = 3;
/** Disjuntor: 3 buscas seguidas falhando param as chamadas por 5 min. */
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 5 * 60_000;

const ApiModel = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  model_creator: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish(),
  evaluations: z
    .object({ artificial_analysis_coding_index: z.number().nullish(), artificial_analysis_intelligence_index: z.number().nullish() })
    .nullish(),
  pricing: z.object({ price_1m_blended_3_to_1: z.number().nullish() }).nullish(),
});
type ApiModelData = z.infer<typeof ApiModel>;
const ApiResponse = z.object({ data: z.array(z.unknown()) });

/** Da mais preferida para a menos: a lista inteira usa a primeira métrica que algum modelo tem. */
const INDEX_METRICS: IndexMetric[] = ['coding', 'intelligence'];

type Ranking = Pick<ModelBenchmarks, 'metric' | 'models'>;

/** Falha que não adianta repetir (chave recusada, limite do dia). */
class PermanentError extends Error {}

export interface ArtificialAnalysisDeps {
  fetch: typeof fetch;
  readKey: () => Promise<string | null>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export class ArtificialAnalysis {
  private cache: (Ranking & { at: number }) | null = null;
  private failures = 0;
  private openUntil = 0;
  private inflight: Promise<ModelBenchmarks> | null = null;
  private readonly deps: ArtificialAnalysisDeps;

  constructor(deps: Partial<ArtificialAnalysisDeps> = {}) {
    this.deps = {
      fetch: (...args) => globalThis.fetch(...args),
      readKey: readKeyFromEnvFile,
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...deps,
    };
  }

  /** O ranking; `refresh` busca de novo (respeitando o intervalo mínimo entre buscas). */
  async get(refresh = false): Promise<ModelBenchmarks> {
    const key = await this.deps.readKey();
    if (!key) return { configured: false, metric: null, models: [], fetchedAt: null, error: null };
    const now = this.deps.now();
    const age = this.cache ? now - this.cache.at : Infinity;
    if (age < (refresh ? MIN_REFRESH_MS : CACHE_MS)) return this.report(null);
    if (now < this.openUntil) {
      const min = Math.ceil((this.openUntil - now) / 60_000);
      return this.report(`a API do Artificial Analysis falhou seguidas vezes; nova tentativa em ${min} min`);
    }
    // Dois cliques ao mesmo tempo esperam a mesma busca.
    this.inflight ??= this.fetchModels(key).finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetchModels(key: string): Promise<ModelBenchmarks> {
    try {
      const ranking = await this.withRetry(() => this.request(key));
      this.cache = { ...ranking, at: this.deps.now() };
      this.failures = 0;
      return this.report(null);
    } catch (err) {
      if (++this.failures >= BREAKER_FAILURES) this.openUntil = this.deps.now() + BREAKER_OPEN_MS;
      return this.report((err as Error).message);
    }
  }

  /** Repete falhas passageiras (rede, 5xx) com espera exponencial e jitter. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof PermanentError || attempt >= ATTEMPTS) throw err;
        const base = 500 * 2 ** (attempt - 1);
        await this.deps.sleep(base + Math.random() * base);
      }
    }
  }

  private async request(key: string): Promise<Ranking> {
    let res: Response;
    try {
      res = await this.deps.fetch(API_URL, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new Error('sem resposta da API do Artificial Analysis');
    }
    if (res.status === 401 || res.status === 403) throw new PermanentError(`chave recusada pela API (confira ${KEY_NAME} no .env)`);
    if (res.status === 429) throw new PermanentError('limite diário da API atingido; tente amanhã');
    if (!res.ok) throw new Error(`a API do Artificial Analysis respondeu ${res.status}`);
    const body = ApiResponse.safeParse(await res.json().catch(() => null));
    if (!body.success) throw new Error('resposta inesperada da API do Artificial Analysis');
    return pickTop(body.data.data);
  }

  private report(error: string | null): ModelBenchmarks {
    return {
      configured: true,
      metric: this.cache?.metric ?? null,
      models: this.cache?.models ?? [],
      fetchedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
      error,
    };
  }
}

const EFFORTS = ['non-reasoning', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join('|')})$`);

/**
 * Os de maior índice, só os que têm preço. A métrica (código ou inteligência) é a mesma para a lista
 * inteira: a primeira que algum modelo tem. Sem nenhum índice, a lista vem vazia e a métrica é null.
 * Cada esforço vem como um item ("claude-x-high", "claude-x-low"…, slug com sufixo): juntam-se num
 * modelo só, que aparece com o esforço padrão, a variante principal do AA (o slug sem sufixo, como "claude-x").
 */
export function pickTop(items: unknown[], top = TOP): Ranking {
  const priced: Array<{ m: ApiModelData; priceBlended: number }> = [];
  for (const item of items) {
    const m = ApiModel.safeParse(item);
    if (!m.success || !CREATORS.has(m.data.model_creator?.slug ?? '')) continue;
    const priceBlended = m.data.pricing?.price_1m_blended_3_to_1;
    if (priceBlended == null || priceBlended < 0) continue;
    priced.push({ m: m.data, priceBlended });
  }
  const metric = INDEX_METRICS.find((k) => priced.some(({ m }) => indexOf(m, k) != null)) ?? null;
  if (!metric) return { metric, models: [] };

  const families = new Map<string, Array<ModelVariant & { name: string; creator: string; slug: string }>>();
  for (const { m, priceBlended } of priced) {
    const codingIndex = indexOf(m, metric);
    // Modelo sem a métrica escolhida fica de fora: não se misturam escalas.
    if (codingIndex == null) continue;
    const { id, name, slug } = m;
    const key = slug.replace(EFFORT_SUFFIX, '');
    const list = families.get(key) ?? [];
    list.push({ id, name, slug, creator: m.model_creator?.name ?? '', effort: effortOf(slug, name), codingIndex, priceBlended });
    families.set(key, list);
  }
  const out: ModelBenchmark[] = [];
  for (const [key, list] of families) {
    list.sort((a, b) => EFFORTS.indexOf(a.effort ?? '') - EFFORTS.indexOf(b.effort ?? ''));
    // Sem a variante principal na resposta, vale a de maior índice.
    const main = list.find((v) => v.slug === key) ?? list.reduce((a, b) => (b.codingIndex > a.codingIndex ? b : a));
    out.push({
      id: main.id,
      // "Claude X (Max, Default Fallback)" → "Claude X"; "Qwen Y (0902)" fica (é versão, não esforço).
      name: main.effort ? main.name.replace(/\s*\([^)]*\)\s*$/, '') : main.name,
      creator: main.creator,
      effort: main.effort,
      codingIndex: main.codingIndex,
      priceBlended: main.priceBlended,
      variants: list.map(({ id, effort, codingIndex, priceBlended }) => ({ id, effort, codingIndex, priceBlended })),
    });
  }
  return { metric, models: out.sort((a, b) => b.codingIndex - a.codingIndex).slice(0, top) };
}

function indexOf(m: ApiModelData, metric: IndexMetric): number | null | undefined {
  return metric === 'coding' ? m.evaluations?.artificial_analysis_coding_index : m.evaluations?.artificial_analysis_intelligence_index;
}

/** O esforço pelo sufixo do slug ou, na variante principal (sem sufixo), pelo nome: "(Max, …)". */
function effortOf(slug: string, name: string): string | null {
  const fromSlug = EFFORT_SUFFIX.exec(slug)?.[1];
  if (fromSlug) return fromSlug;
  const fromName = /\(([^,)]+)/.exec(name)?.[1]?.trim().toLowerCase() ?? '';
  return EFFORTS.includes(fromName) ? fromName : null;
}

async function readKeyFromEnvFile(): Promise<string | null> {
  const raw = await fs.readFile(ENV_FILE, 'utf8').catch(() => null);
  if (!raw) return null;
  // Editado à mão no Windows, o arquivo pode vir com BOM.
  const key = parseEnv(raw.replace(/^﻿/, ''))[KEY_NAME]?.trim();
  // Só caracteres de chave: nada que vire outro cabeçalho na requisição.
  return key && /^[\w.-]{8,200}$/.test(key) ? key : null;
}
