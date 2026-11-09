/**
 * Notas da entrega: a ficha pede, ao entregar, uma linha por arquivo mudado no formato
 * `- \`caminho/relativo\`: por que mudou`. Aqui só se lê esse texto; o que não cabe no formato é descartado.
 */

export const DELIVERY_SUMMARY_MAX = 1500;
export const DELIVERY_NOTE_MAX = 200;
export const DELIVERY_NOTES_MAX = 50;

const LINE = /^\s*[-*]\s+`([^`\n]+)`\s*(?::|—|–)\s*(.+)$/;

/** Devolve as notas do texto, ou undefined quando não há nenhuma linha no formato. */
export function parseDeliveryNotes(text: string): Record<string, string> | undefined {
  const notes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (notes.size >= DELIVERY_NOTES_MAX) break;
    const m = LINE.exec(line);
    if (!m) continue;
    const file = relativePath(m[1]!);
    const why = plain(m[2]!);
    if (!file || !why || notes.has(file)) continue;
    notes.set(file, why);
  }
  return notes.size ? Object.fromEntries(notes) : undefined;
}

/** Caminho relativo e normalizado com `/`; null para absoluto, `..`, `~`, vazio ou com caractere proibido. */
export function relativePath(raw: string): string | null {
  const p = raw.trim().replace(/\\/g, '/');
  if (!p || p.startsWith('/') || p.startsWith('~') || /^[a-zA-Z]:/.test(p)) return null;
  if (/[<>"|?*]|[\u0000-\u001f]/.test(p)) return null;
  const parts = p.split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

/** Texto puro: sem tags, espaços colapsados, até 200 caracteres. */
function plain(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DELIVERY_NOTE_MAX);
}
