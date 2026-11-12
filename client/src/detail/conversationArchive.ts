/** Id da conversa → quando foi arquivada (ISO); é o `archived.conversations` do config. */
export type ArchivedConversations = Record<string, string>;

interface Convo {
  id: string;
  updatedAt: string | null;
}

/**
 * Arquivada = está no mapa e não teve atividade depois da data de arquivamento (atividade nova a traz de volta).
 * `shown` são as conversas que abrem mesmo arquivadas (a do aviso da caixa "precisa de mim"). Sem data de atividade
 * (ou com data ilegível) não há como provar atividade nova: segue arquivada.
 */
export function isConversationArchived(c: Convo, archived: ArchivedConversations, shown: readonly string[] = []): boolean {
  const at = archived[c.id];
  if (!at || shown.includes(c.id)) return false;
  const since = Date.parse(at);
  const last = c.updatedAt ? Date.parse(c.updatedAt) : NaN;
  return Number.isNaN(since) || Number.isNaN(last) || last <= since;
}

/** A lista repartida em as que aparecem no seletor e as arquivadas, cada uma na ordem de entrada. */
export function splitArchived<T extends Convo>(list: T[], archived: ArchivedConversations, shown: readonly string[] = []): { active: T[]; archived: T[] } {
  const out: { active: T[]; archived: T[] } = { active: [], archived: [] };
  for (const c of list) (isConversationArchived(c, archived, shown) ? out.archived : out.active).push(c);
  return out;
}
