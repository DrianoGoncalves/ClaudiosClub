// Nome de arquivo/pasta novo: o cliente barra o óbvio (o servidor confere tudo de novo e tem a palavra final).

export type NameProblem = 'empty' | 'absolute' | 'dots';

/** O que há de errado no nome digitado, ou null. Aceita subpastas ("src/novo.ts"), com / ou \. */
export function nameProblem(raw: string): NameProblem | null {
  const name = raw.trim();
  if (!name) return 'empty';
  if (/^[/\\]/.test(name)) return 'absolute';
  const parts = name.replace(/[/\\]+$/, '').split(/[/\\]/);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return 'dots';
  return null;
}

/** Caminho relativo à raiz: pasta escolhida + nome, sempre com "/" e sem barra no fim. */
export function joinPath(dir: string, raw: string): string {
  const name = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return dir ? `${dir}/${name}` : name;
}

/** Pastas de `dir` até a pasta de `path` (inclusive), para abrir e recarregar na árvore depois de criar. */
export function foldersToShow(dir: string, path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  const start = dir ? dir.split('/').length : 0;
  const out = [dir];
  for (let i = start; i < parts.length; i++) out.push(parts.slice(0, i + 1).join('/'));
  return out;
}

/** Pasta de um caminho ("" = raiz). */
export const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** `path` é o próprio `base` ou fica dentro dele: o que sai junto quando `base` é apagado. */
export const isWithin = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
