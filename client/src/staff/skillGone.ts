// Skill marcada na ficha que a lista de skills não oferece mais (apagada ou renomeada): a ficha continua mostrando a linha, para a
// pessoa poder desmarcar. A lista nunca oferece as sincronizadas da conta; essas aparecem como são, sem acusar que sumiram.

/** A biblioteca do Club chega depois das skills do projeto e da conta; `failed` = não deu para ler. */
export type LibraryState = 'loading' | 'ok' | 'failed';

/** As marcadas na ficha (ao abrir) que `offered` não tem. Lendo a biblioteca ainda: nenhuma, para não acusar uma skill da biblioteca. */
export function goneSkills(marked: string[], offered: string[], library: LibraryState): string[] {
  return library === 'loading' ? [] : marked.filter((s) => !offered.includes(s));
}

/** Só dá para dizer "não existe mais" com a biblioteca lida e a skill fora das sincronizadas (essas existem, só não são oferecidas). */
export function skillIsGone(name: string, library: LibraryState, synced: ReadonlySet<string>): boolean {
  return library === 'ok' && !synced.has(name);
}
