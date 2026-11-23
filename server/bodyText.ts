/**
 * Texto do corpo de um pedido à API. UTF-8 é o esperado; o que não é UTF-8 válido é lido como
 * Windows-1252, porque é o que o PowerShell 5.1 (`Invoke-RestMethod -Body '<texto>'`) manda: sem isso,
 * cada acento vira U+FFFD na gravação e não há como recuperar depois. O BOM do começo sai.
 */
export function bodyText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
