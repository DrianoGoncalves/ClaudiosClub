/**
 * Notas da entrega: a ficha pede, ao entregar, uma linha por arquivo mudado no formato
 * `- \`caminho/relativo\`: por que mudou`. Aqui só se lê esse texto; o que não cabe no formato é descartado.
 */

export const DELIVERY_SUMMARY_MAX = 2500;
export const DELIVERY_NOTE_MAX = 200;
export const DELIVERY_NOTES_MAX = 50;

/**
 * O resumo da entrega para guardar e para os avisos: o texto inteiro se cabe em `max`; senão, cortado em fim de linha (sem quebra que sirva, em fim de palavra) com uma marca
 * visível no fim, que diz quantos caracteres ficaram de fora. A marca cabe dentro de `max`. Quebra ou espaço só serve se deixa pelo menos metade do espaço (uma quebra no começo de
 * um texto longo não esvazia o resumo); sem nenhum que sirva, o corte é seco. Cortar de novo um texto já cortado não muda nada (a marca está dentro do teto).
 */
export function fitDeliverySummary(text: string, max = DELIVERY_SUMMARY_MAX): string {
  const full = text.trim();
  if (full.length <= max) return full;
  const mark = (n: number) => `\n… (entrega cortada: ${n} caracteres a mais)`;
  const room = Math.max(0, max - mark(full.length).length);
  const window = full.slice(0, room + 1); // o caractere de `room` é o primeiro a sair: se for a quebra, a linha de antes está inteira
  let cut = window.lastIndexOf('\n');
  if (cut < room / 2) cut = window.search(/\s\S*$/);
  if (cut < room / 2) cut = room;
  const high = full.charCodeAt(cut - 1);
  if (cut === room && high >= 0xd800 && high <= 0xdbff) cut -= 1; // não parte um par substituto ao meio
  const kept = full.slice(0, cut).trimEnd();
  return kept + mark(full.length - kept.length);
}

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

/**
 * O texto é uma entrega no formato (e não uma resposta a mensagem ou aviso)? Tem ao menos uma linha por arquivo mudado (`- \`caminho\`: por quê`) ou abre o item "Critério de pronto"
 * do formato fixo da tarefa (numerado, em negrito ou título). Resposta curta ("Aviso visto…", uma pergunta, uma explicação) não tem nenhum dos dois.
 */
export function looksLikeDelivery(text: string): boolean {
  return !!parseDeliveryNotes(text) || /^\s*(?:\d+[.)]\s*)?[*_#\s]*crit[ée]rio de pronto\b/im.test(text);
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
