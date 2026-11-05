// Anexos do projeto: o que o cliente confere antes de enviar (o servidor confere tudo de novo e tem a palavra final).

/** Limite do servidor, até a lista chegar com o `maxBytes` dele. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Tamanho legível: 512 B, 3,4 KB, 1,2 MB (separador decimal do idioma). */
export function formatBytes(bytes: number, locale = 'pt-BR'): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  const [value, unit] = kb < 1024 ? [kb, 'KB'] : [kb / 1024, 'MB'];
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${unit}`;
}

/** Arquivos que podem subir e os recusados aqui mesmo (vazio ou acima do limite). */
export function splitBySize<T extends { name: string; size: number }>(
  files: T[],
  maxBytes: number,
): { ok: T[]; empty: T[]; tooBig: T[] } {
  const out = { ok: [] as T[], empty: [] as T[], tooBig: [] as T[] };
  for (const f of files) (f.size === 0 ? out.empty : f.size > maxBytes ? out.tooBig : out.ok).push(f);
  return out;
}

/**
 * Nome do print colado: o navegador chama todos de "image.png"; vira "print 2026-11-04 14-05-09.png".
 * Arquivo copiado do Explorer chega com o nome real e fica como está.
 */
export function pastedName(name: string, type: string, now: Date): string {
  if (name && !/^image\.\w+$/i.test(name)) return name;
  const ext = /^image\/(png|jpeg|gif|webp)$/.exec(type)?.[1]?.replace('jpeg', 'jpg') ?? name.split('.').pop() ?? 'png';
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return `print ${day} ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}.${ext}`;
}
