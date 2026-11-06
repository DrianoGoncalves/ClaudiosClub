// Limites da memória pessoal (os mesmos de server/staff/personalMemory.ts, que é quem recusa) e a conta que a tela mostra.
export const MEMORY_MAX_LINES = 40;
export const MEMORY_MAX_BYTES = 4096;

/** Como o servidor grava: quebras LF, sem espaço no fim da linha nem do texto, uma quebra final (vazio continua vazio). */
const stored = (text: string) => {
  const body = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return body ? `${body}\n` : '';
};

/** Linhas e bytes que o texto ocupa depois de gravado, e se cabe nos limites. */
export function memoryUsage(text: string): { lines: number; bytes: number; fits: boolean } {
  const body = stored(text);
  const lines = body ? body.split('\n').length - 1 : 0;
  const bytes = new TextEncoder().encode(body).length;
  return { lines, bytes, fits: lines <= MEMORY_MAX_LINES && bytes <= MEMORY_MAX_BYTES };
}
