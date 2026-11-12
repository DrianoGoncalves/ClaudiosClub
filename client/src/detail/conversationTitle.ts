/** Id da conversa → título que o user deu a ela; é o `conversationTitles` do config. */
export type ConversationTitles = Record<string, string>;

/** O título manual da conversa (sem entrada, ou em branco, não há). */
export function manualTitle(id: string, manual?: ConversationTitles): string | null {
  const own = manual && Object.prototype.hasOwnProperty.call(manual, id) ? manual[id]?.trim() : '';
  return own || null;
}

/**
 * O título que a lista mostra: o manual, senão o último assunto (`topic`), senão o `title`. Quem lista as conversas da
 * ficha não passa `title`: no Claude Code e no Codex ele é o nome do funcionário, só serve de reserva às soltas.
 */
export function conversationTitle(c: { id: string; topic?: string | null; title?: string | null }, manual?: ConversationTitles): string | null {
  return manualTitle(c.id, manual) ?? (c.topic?.trim() || c.title?.trim() || null);
}

/**
 * O que gravar ao salvar o campo do "Renomear": `undefined` = nada mudou (não chama o servidor), `null` = volta ao título
 * automático, texto = o novo título manual. `shown` é o título que estava na lista ao abrir o campo.
 */
export function titleToSave(draft: string, shown: string | null, hasManual: boolean): string | null | undefined {
  const title = draft.trim();
  if (!title) return hasManual ? null : undefined;
  return title === (shown ?? '').trim() ? undefined : title;
}
