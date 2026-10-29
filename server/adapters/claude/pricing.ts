// Preço equivalente em API (US$ por milhão de tokens), primeira parte da Anthropic.
// É estimativa para comparar agents/projetos: as sessões do Claudio’s Club rodam pela assinatura.
// Fonte: tabela de modelos do skill claude-api (cache de 2026-10-06).

export const PRICING_AS_OF = '2026-10-06';

interface Rate {
  input: number;
  output: number;
  /** Leitura de cache; padrão 0,1× a entrada. */
  cacheRead?: number;
  /** Faixa de prompt longo (Haiku 5.5: acima de 100K tokens). */
  long?: { above: number; input: number; output: number };
  /** Multiplicador do modo rápido (`usage.speed === 'fast'`). */
  fast?: number;
}

const RATES: Record<string, Rate> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, long: { above: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string | null;
}

/** `claude-haiku-4-5-20251001` → `claude-haiku-4-5`; `claude-opus-5-5[1m]` → `claude-opus-5-5`. */
export function normalizeModel(model: string): string {
  return model.replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
}

/** Janela de contexto por modelo; os atuais têm 1M. */
export function contextWindowFor(model: string | null | undefined): number {
  const m = model ? normalizeModel(model) : '';
  return m === 'claude-haiku-4-5' ? 200_000 : 1_000_000;
}

/** Respostas sem custo real (ex.: `<synthetic>`, mensagens geradas localmente). */
export function isBillable(model: string | undefined): model is string {
  return !!model && !model.startsWith('<');
}

const FAMILY = /^claude-(fable|mythos|opus|sonnet|haiku)-/;

/**
 * Preço do modelo; um que ainda não está na tabela (saiu depois dela) usa o mais recente da mesma
 * família (a tabela vai do mais novo ao mais velho em cada uma), para o custo e o orçamento não
 * sumirem até a tabela ser atualizada. Família desconhecida: null.
 */
export function rateFor(model: string): Rate | null {
  const m = normalizeModel(model);
  if (RATES[m]) return RATES[m];
  const family = FAMILY.exec(m)?.[0];
  const sibling = family ? Object.keys(RATES).find((k) => k.startsWith(family)) : undefined;
  return sibling ? RATES[sibling]! : null;
}

/** Custo em US$, ou null quando não há preço para o modelo (nem pela família). */
export function costOf(model: string, u: Usage): number | null {
  const rate = rateFor(model);
  if (!rate) return null;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  // Sem o detalhamento por TTL, toda escrita conta como de 5 minutos.
  const write1h = Math.min(write, u.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  const write5m = write - write1h;

  const prompt = input + read + write;
  const tier = rate.long && prompt > rate.long.above ? rate.long : rate;
  const readRate = tier === rate ? (rate.cacheRead ?? rate.input * 0.1) : tier.input * 0.1;
  const multiplier = u.speed === 'fast' ? (rate.fast ?? 1) : 1;

  const usd =
    input * tier.input +
    output * tier.output +
    write5m * tier.input * 1.25 +
    write1h * tier.input * 2 +
    read * readRate;
  return (usd * multiplier) / 1_000_000;
}
