import type { ShowcaseStatus } from '../api';
import { formatUsd } from '../format';

/** De quanto em quanto tempo o painel pergunta ao servidor como vai a geração da vitrine. */
export const SHOWCASE_POLL_MS = 3000;

/** Só pergunta enquanto gera e com a aba à vista: aba escondida não gasta requisição. */
export function shouldPollShowcase(state: ShowcaseStatus['state'] | undefined, hidden: boolean): boolean {
  return state === 'running' && !hidden;
}

/** Custo que o servidor informou ("US$ 0,42"); sem o campo (ou fora do normal) nada aparece: nunca se estima. */
export function showcaseCost(status: Pick<ShowcaseStatus, 'costUsd'> | null): string | null {
  const cost = status?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? formatUsd(cost) : null;
}

/** Identifica uma geração concluída (para reler o guia uma vez só por conclusão). */
export function showcaseDoneKey(status: ShowcaseStatus | null): string | null {
  return status?.state === 'done' ? (status.finishedAt ?? 'done') : null;
}
