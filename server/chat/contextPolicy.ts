import type { ContextSwitch } from '../../shared/model';
import { rateFor } from '../adapters/claude/pricing';

// Quando vale começar uma conversa nova. Cada resposta relê o contexto inteiro (do cache), então
// uma conversa grande custa caro a cada passo e o modelo presta menos atenção nela; uma nova lê só
// a ficha e a memória. Quem sabe que o assunto acabou é o funcionário (o ponto de corte, na ficha);
// quem sabe quanto custa continuar é o Claudio’s Club (o tamanho do contexto e se o cache já esfriou).

/** Daqui para cima, a mensagem que vai ao funcionário leva o tamanho e o custo do contexto. */
export const NOTICE_AT = 150_000;
/** Depois de um ponto de corte, a partir daqui a próxima mensagem segue numa conversa nova. */
export const SWITCH_AT = 100_000;
/**
 * Com o cache já frio (pausa maior que a validade dele), vale trocar a partir de um contexto menor. Não muito
 * menor: uma conversa nova já começa com 20–70k (ficha, memória, ferramentas), e abaixo disto trocar quase não
 * economiza.
 */
export const COLD_SWITCH_AT = 80_000;
/** Validade do cache quando a resposta não diz (não gravou nada nele): a menor, a de 5 min. */
export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
/** Sem ponto de corte, a partir daqui você é avisado (uma vez a cada 100k a mais). */
export const CEILING_AT = 300_000;

export interface TurnInfo {
  at: number;
  used: number | null;
  checkpoint: boolean;
  model: string | null;
  /** Validade do cache da conversa (ms), lida das respostas; null enquanto nenhuma disse. */
  ttl: number | null;
}

/**
 * Validade com que a resposta gravou o cache: o Claude Code usa 1 h na assinatura e pode usar 5 min com chave
 * de API. Sem nada gravado (só leitura), null: vale o que a conversa já mostrou.
 */
export function cacheTtlOf(usage: unknown): number | null {
  const c = (usage as { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } | null)?.cache_creation;
  if ((c?.ephemeral_1h_input_tokens ?? 0) > 0) return CACHE_TTL_1H_MS;
  if ((c?.ephemeral_5m_input_tokens ?? 0) > 0) return CACHE_TTL_MS;
  return null;
}

/** Trocar, sugerir ou nada, para a próxima mensagem desta conversa. */
export function switchDecision(t: TurnInfo, now: number, policy: ContextSwitch): 'switch' | 'suggest' | null {
  if (policy === 'off' || !t.checkpoint || t.used === null) return null;
  const cold = now - t.at >= (t.ttl ?? CACHE_TTL_MS);
  if (t.used < SWITCH_AT && !(cold && t.used >= COLD_SWITCH_AT)) return null;
  return policy === 'auto' ? 'switch' : 'suggest';
}

/** US$ que cada resposta gasta só para reler o contexto (leitura de cache). */
export function rereadUsd(used: number, model: string | null): number {
  const rate = model ? rateFor(model) : null;
  const read = rate ? (rate.cacheRead ?? rate.input * 0.1) : 0.3;
  return (used * read) / 1_000_000;
}

export const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
export const usd = (n: number) => `US$ ${n < 0.01 ? n.toFixed(3) : n.toFixed(2)}`.replace('.', ',');

/** Linha que vai junto da mensagem ao funcionário (a conversa não mostra). */
export function contextNotice(used: number, model: string | null, prefix: string): string {
  return `${prefix} ${kTokens(used)} tokens (cerca de ${usd(rereadUsd(used, model))} por resposta só para reler). Feche o assunto atual e use o ponto de corte assim que for natural.`;
}
