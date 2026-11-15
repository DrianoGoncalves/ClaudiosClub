import type { ChatItem } from '../../shared/model';
import { stripCheckpoint } from './items';

// A emenda entre o histórico (o que veio do arquivo da conversa) e o que está na memória do processo (`live`). O histórico
// vai até o `at` do primeiro item que ficou na memória; no Claude os ids são os mesmos nos dois lados e a tela junta pelo id.
// No Codex não: o rollout numera as linhas (`a:<ordinal>`) e o vivo usa `a:<execução>:<id>`. Uma resposta (`agent_message`) só tem
// `item.completed`: o rollout a grava antes de o servidor processar o evento, então a cópia do arquivo tem hora anterior à do vivo,
// passa do corte e a mesma resposta apareceria duas vezes.

/** Quantos itens de cada lado da emenda se comparam (a folga entre os dois relógios cobre poucos itens seguidos). */
const SEAM_ITEMS = 12;

/** Diferença máxima entre a hora do arquivo e a do vivo para ser a mesma resposta (é a folga de processar o evento: ms). */
const SEAM_MS = 10_000;

const trimmed = (text: string) => stripCheckpoint(text).trim();

function sameContent(a: ChatItem, b: ChatItem): boolean {
  if (a.kind === 'tool') return b.kind === 'tool' && a.name === b.name && a.summary === b.summary;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'assistant' || a.kind === 'user' || a.kind === 'notice') return trimmed(a.text) === trimmed((b as typeof a).text);
  return false;
}

function near(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return Math.abs(Date.parse(a) - Date.parse(b)) <= SEAM_MS;
}

/**
 * Tira do fim do histórico os itens que são a cópia, no arquivo, dos primeiros itens do vivo (mesmo tipo e conteúdo, com a hora
 * a poucos segundos). Só vale o trecho seguido no fim do histórico, uma vez por item do vivo: uma mensagem igual mais antiga (um
 * "ok" de ontem) não some, porque a hora não bate.
 */
export function dropSeamEchoes(history: ChatItem[], live: ChatItem[]): ChatItem[] {
  const firsts = live.slice(0, SEAM_ITEMS);
  const used = new Set<number>();
  let end = history.length;
  while (end > 0 && history.length - end < SEAM_ITEMS) {
    const h = history[end - 1]!;
    const at = firsts.findIndex((l, i) => !used.has(i) && near(h.at, l.at) && sameContent(h, l));
    if (at === -1) break;
    used.add(at);
    end--;
  }
  return end === history.length ? history : history.slice(0, end);
}
