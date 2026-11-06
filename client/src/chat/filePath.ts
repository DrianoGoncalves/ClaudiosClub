// Caminho de arquivo citado numa resposta (`docs/x.md`, `src\a.ts:42`, `C:\...\MyCo\README.md#L10`) para abrir no editor do Club.
// Só forma: quem decide se pode ler é o servidor (files/read confina ao projeto); aqui só se descarta o que nem parece arquivo.

/** Sufixo de linha que o Claude Code põe: `:42`, `:42:7` ou `#L42` / `#L42-L50`. */
const LINE_SUFFIX = /(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/i;

/** Limpa o texto e devolve o caminho com "/"; null se tem espaço, caractere proibido em nome de arquivo ou esquema (http:, file:…). */
function clean(text: string): string | null {
  const s = text.trim().replace(LINE_SUFFIX, '');
  if (!s || /[\s<>"|?*\u0000-\u001f]/.test(s)) return null;
  const slashed = s.replace(/\\/g, '/');
  // Letra de unidade (`C:/`) não é esquema; `javascript:`, `http:`, `file:` são.
  if (/^[a-z][a-z0-9+.-]*:/i.test(slashed) && !/^[a-z]:\//i.test(slashed)) return null;
  return slashed;
}

/** Relativo ao projeto: sem `..`, sem `~`, sem segmento vazio, com extensão no nome. */
function relativeOk(s: string): string | null {
  const rel = s.replace(/^(\.\/)+/, '');
  if (rel.startsWith('~')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  if (!/\.[a-z0-9]{1,8}$/i.test(parts[parts.length - 1]!)) return null;
  return parts.join('/');
}

const ABSOLUTE = /^(?:[a-z]:)?\//i;

/**
 * Caminho relativo ao projeto (com "/") se o texto parece um arquivo dele; senão null.
 * Absoluto só vale dentro de `projectRoot` (comparação sem diferenciar maiúsculas, `\` ou `/`).
 */
export function projectRelativePath(text: string, projectRoot?: string): string | null {
  let s = clean(text);
  if (s === null) return null;
  if (ABSOLUTE.test(s)) {
    const root = (projectRoot ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!root) return null;
    const prefix = `${root}/`;
    if (s.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
    s = s.slice(prefix.length);
  }
  return relativeOk(s);
}

/**
 * Forma de caminho de arquivo, sem olhar o projeto. Só para o link passar pelo `urlTransform` até o componente,
 * que decide de novo com o projeto na mão; nunca vira `<a href>` sozinho.
 */
export function looksLikeFilePath(text: string): boolean {
  const s = clean(text);
  if (s === null) return false;
  return relativeOk(s.replace(ABSOLUTE, '')) !== null;
}
