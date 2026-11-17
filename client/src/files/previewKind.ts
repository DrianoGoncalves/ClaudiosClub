// Arquivos que o editor sabe mostrar formatados (botão "Visualizar"), pela extensão.

export type PreviewKind = 'markdown' | 'json';

/** .md e .markdown, em qualquer caixa. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);

/** Só .json: .jsonc/.json5 aceitam comentário e o JSON.parse recusaria. */
export const isJsonPath = (path: string): boolean => /\.json$/i.test(path);

/** Como o arquivo é visualizado; null = sem visualização (o editor mostra só o código). */
export function previewKind(path: string): PreviewKind | null {
  if (isMarkdownPath(path)) return 'markdown';
  if (isJsonPath(path)) return 'json';
  return null;
}
