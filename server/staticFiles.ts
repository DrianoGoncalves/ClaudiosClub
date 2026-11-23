import { promises as fs } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

// Os arquivos do cliente compilado (dist/client): o tipo e o cache no navegador. Sem compressão: o servidor só escuta no loopback
// (127.0.0.1), onde a rede não custa nada e comprimir só atrasaria a primeira carga.

export const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** O Vite põe o hash no nome de tudo que grava em assets/: o arquivo daquele nome nunca muda. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile()).catch(() => false);
}

/** A versão do arquivo para o 304: tamanho e mtime em ms (o Last-Modified só tem segundos; um build no mesmo segundo passaria por igual). */
export const fileEtag = (size: number, mtimeMs: number): string => `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

/** `If-Modified-Since` cobre o `mtimeMs` (o cabeçalho HTTP só tem segundos)? Só vale sem `If-None-Match` (ver `notModified`). */
export function notModifiedSince(header: string | undefined, mtimeMs: number): boolean {
  if (!header) return false;
  const since = Date.parse(header);
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/** O navegador já tem esta versão? O ETag manda quando vem (RFC 9110); sem ele, a data. */
function notModified(req: http.IncomingMessage | undefined, etag: string, mtimeMs: number): boolean {
  const match = req?.headers['if-none-match'];
  if (match !== undefined) return match.split(',').some((m) => m.trim().replace(/^W\//, '') === etag);
  return notModifiedSince(req?.headers['if-modified-since'], mtimeMs);
}

/**
 * Serve `pathname` de `clientDir`. Rota do app (sem extensão) cai no index.html; arquivo que falta é 404. O que está em assets/ o navegador guarda por
 * 1 ano sem perguntar; o resto (index.html, sw.js, manual, ícones) confere sempre e, sem mudança, volta 304 sem corpo (ETag e Last-Modified).
 */
export async function serveStatic(clientDir: string, pathname: string, req: http.IncomingMessage | undefined, res: http.ServerResponse): Promise<void> {
  const requested = path.resolve(clientDir, '.' + decodeURIComponent(pathname));
  const inside = requested === clientDir || requested.startsWith(clientDir + path.sep);
  const asFile = inside && (await isFile(requested));
  // Arquivo que falta (ex.: /assets/x.js de um build quebrado) é 404: devolver HTML no lugar do JS deixava a tela em branco, sem erro nenhum.
  if (inside && !asFile && path.extname(pathname) !== '') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Arquivo não encontrado.');
    return;
  }
  const file = asFile ? requested : path.join(clientDir, 'index.html');
  try {
    const st = await fs.stat(file);
    // Pelo caminho já resolvido, não pelo pedido: `/assets/..%2fsw.js` cai no sw.js da raiz e não pode sair como imutável.
    const immutable = asFile && file.startsWith(path.join(clientDir, 'assets') + path.sep);
    const etag = fileEtag(st.size, st.mtimeMs);
    const headers: Record<string, string> = {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? IMMUTABLE : 'no-cache',
      etag,
      'last-modified': new Date(st.mtimeMs).toUTCString(),
    };
    if (!immutable && notModified(req, etag, st.mtimeMs)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    const data = await fs.readFile(file);
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Cliente não compilado. Use `npm run dev` ou `npm run build`.');
  }
}
