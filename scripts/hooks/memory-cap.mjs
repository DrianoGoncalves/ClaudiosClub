// Teto de tamanho da memória do funcionário (`.myco/staff/<id>.memory.md` e `<id>.memory/*.md`). A regra é uma só para quem grava ou avisa:
// o MCP `myco-memoria` (server/staff/memoriaMcp.ts), o aviso da ficha (launch.ts e ficha.ts) e o hook memory-guard.mjs (Write/Edit do Claude).
// Sem dependência: o hook roda este arquivo direto, de uma cópia na pasta da conversa (launch.ts, GUARD_HOOK_FILES).

/** O índice é lido inteiro a cada conversa e regravado por inteiro: a ficha pede "até umas 60 linhas". */
export const MEMORY_INDEX_MAX_LINES = 60;
export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
/** Um detalhe `<id>.memory/<assunto>.md`: lido só quando o assunto volta, mas também regravado por inteiro. */
export const MEMORY_DETAIL_MAX_BYTES = 16 * 1024;

/** Tamanho de um texto: bytes em UTF-8 e linhas (a última, sem quebra no fim, também conta). */
export function memoryMeasure(text) {
  const breaks = (text.match(/\n/g) ?? []).length;
  return { bytes: Buffer.byteLength(text, 'utf8'), lines: breaks + (text !== '' && !text.endsWith('\n') ? 1 : 0) };
}

/** `kind`: 'index' (o índice) ou 'detail' (um detalhe). */
export function memoryOver(kind, m) {
  return kind === 'index' ? m.bytes > MEMORY_INDEX_MAX_BYTES || m.lines > MEMORY_INDEX_MAX_LINES : m.bytes > MEMORY_DETAIL_MAX_BYTES;
}

/** O teto em palavras, para as mensagens. */
export function memoryLimitText(kind) {
  return kind === 'index' ? `${MEMORY_INDEX_MAX_LINES} linhas e ${MEMORY_INDEX_MAX_BYTES / 1024} KB` : `${MEMORY_DETAIL_MAX_BYTES / 1024} KB`;
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

/** O tamanho em palavras: "90 linhas, 3.1 KB". */
export function memorySizeText(m) {
  return `${m.lines} ${m.lines === 1 ? 'linha' : 'linhas'}, ${kb(m.bytes)}`;
}

/**
 * Pode gravar `next` no lugar de `current` (null = o arquivo não existe)? Dentro do teto: sim. Acima: só se o que já está lá também passa do
 * teto e a versão nova é menor (menos bytes, sem mais linhas). Assim quem herdou uma memória gorda reduz aos poucos, sem ficar preso, e
 * nada cresce além do teto. `over`: a versão que fica ainda passa do teto. `currentOver`: o arquivo atual já passa.
 */
export function memoryJudge(kind, next, current) {
  if (!memoryOver(kind, next)) return { ok: true, over: false };
  const currentOver = current !== null && memoryOver(kind, current);
  if (currentOver && next.bytes < current.bytes && next.lines <= current.lines) return { ok: true, over: true };
  return { ok: false, currentOver };
}

/** A recusa em palavras: o que passou, o teto e como resolver. `detailDir`: a pasta dos detalhes (`.myco/staff/<id>.memory`). */
export function memoryRefusal(kind, next, { currentOver, detailDir }) {
  const size = kind === 'index' ? memorySizeText(next) : kb(next.bytes);
  const how =
    kind === 'index'
      ? `resuma; o que não cabe em uma linha vai para um detalhe em ${detailDir}/<assunto>.md, e no índice fica uma linha com o resumo e o nome do arquivo`
      : 'resuma ou divida em dois assuntos';
  const stuck = currentOver ? ' O arquivo que está lá já passa do teto: grave uma versão menor que ele (é aceita mesmo acima do teto) e siga reduzindo.' : '';
  return `${kind === 'index' ? 'o índice da memória' : 'o detalhe da memória'} passa do teto (${size}; o teto é ${memoryLimitText(kind)}): ${how}.${stuck}`;
}
