import type { ChatSnapshot } from '../../../shared/model';

// Quando o stream da conversa cai (ou precisa abrir), o que a tela decide. Aqui só as contas (testáveis, sem DOM nem timer);
// o uso está em useChat.ts.

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/** Um stream que ficou aberto pelo menos isto contou como "abriu de verdade": a próxima queda volta ao 1 s. */
export const STABLE_OPEN_MS = 5000;

/** Espera antes da tentativa depois de `failures` falhas seguidas: 1 s, 2, 4, 8… até 30 s. */
export function reconnectDelay(failures: number): number {
  const n = Math.min(20, Math.max(0, Math.floor(failures)));
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n);
}

export type ReconnectPlan =
  /** Tenta de novo (relendo o snapshot) depois de `delay` ms. */
  | { kind: 'retry'; delay: number; failures: number; lost: boolean }
  /** Sem rede: não gasta tentativa; espera o evento `online` do navegador. */
  | { kind: 'wait-online'; failures: number; lost: true };

/**
 * O que fazer quando o stream caiu ou a leitura do snapshot falhou. `failures`: quantas falhas seguidas já houve;
 * `openedForMs`: por quanto tempo o stream que caiu ficou aberto (null: nunca abriu, ou foi a leitura do snapshot que falhou).
 * Um stream que abriu e durou o bastante zera a conta (o tempo é de uma queda nova); um que abre e cai logo não zera, senão
 * um servidor que aceita e derruba em seguida seria relido a cada 1 s, para sempre.
 * `lost`: já vale avisar na tela que a conexão se foi (a primeira queda, com rede, costuma voltar antes de alguém notar).
 */
export function planReconnect(failures: number, online: boolean, openedForMs: number | null = null): ReconnectPlan {
  const n = openedForMs !== null && openedForMs >= STABLE_OPEN_MS ? 0 : failures;
  if (!online) return { kind: 'wait-online', failures: n, lost: true };
  return { kind: 'retry', delay: reconnectDelay(n), failures: n + 1, lost: n >= 1 };
}

/**
 * Preciso abrir (ou reabrir) o stream desta sessão? Só se não há um aberto para ela. Quando precisa, NUNCA abre do zero: passa
 * pelo snapshot (a tela pode não conhecer o processo, ou ele já passou do limite de itens da memória, e o stream do zero só
 * traz os mais recentes: o meio da conversa ficaria faltando) e abre depois do `seq` dele (`afterSnapshot`).
 * `readyState`: o do EventSource atual (0 conectando, 1 aberto, 2 fechado), ou null sem stream; `streamSid`: de que sessão ele é.
 */
export function streamNeed(readyState: number | null, streamSid: string | null, wanted: string): 'keep' | 'snapshot' {
  return (readyState === 0 || readyState === 1) && streamSid === wanted ? 'keep' : 'snapshot';
}

/** Depois de que `seq` o stream abre, dado o snapshot lido; null: não há processo, não há stream (o transcript já tem tudo). */
export function afterSnapshot(snap: Pick<ChatSnapshot, 'live'>): number | null {
  return snap.live ? snap.live.seq : null;
}
