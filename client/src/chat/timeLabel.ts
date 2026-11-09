// Rodapé do balão: data e hora em que a mensagem foi enviada/recebida. Vêm do `at` do item (instante gravado pelo
// servidor ou lido do transcript), nunca do momento de desenhar a tela; sem `at` não há rodapé.

/** "09/11, 14:32" no idioma da tela, na hora desta máquina; com o ano ("09/11/2025, 14:32") quando não é o ano de `now`. null sem `at` válido. */
export function msgTimeLabel(at: string | null | undefined, loc: string, now: number = Date.now()): string | null {
  const ms = at ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) return null;
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleString(loc, { day: '2-digit', month: '2-digit', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
}

/** Data completa com segundos, para o tooltip do rodapé ("segunda-feira, 9 de novembro de 2026 às 14:32:07"). */
export function msgTimeFull(at: string | null | undefined, loc: string): string | null {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleString(loc, { dateStyle: 'full', timeStyle: 'medium' });
}
