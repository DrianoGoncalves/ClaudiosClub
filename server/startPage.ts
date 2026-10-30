import { promises as fs } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';

// A página de início (scripts/start.html) também é a tela de "parado": o service worker (client/public/sw.js)
// guarda uma cópia e a mostra quando a porta não responde. Aberta como arquivo, ela usa o CSS e os ícones do
// projeto por caminho relativo; servida aqui, vai num arquivo só (CSS e ícones embutidos), porque com o servidor
// parado nada mais carrega. O checklist (scripts/status.js, do `npm run doctor`) vai à parte, em /status.js.

const ROOT = path.resolve(import.meta.dirname, '..');

const dataUri = async (file: string) => `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;

export async function buildStartPage(root = ROOT): Promise<string> {
  const [html, css, icon32, icon192] = await Promise.all([
    fs.readFile(path.join(root, 'scripts', 'start.html'), 'utf8'),
    fs.readFile(path.join(root, 'client', 'src', 'styles.css'), 'utf8'),
    dataUri(path.join(root, 'client', 'public', 'icon-32.png')),
    dataUri(path.join(root, 'client', 'public', 'icon-192.png')),
  ]);
  return html
    .replace('<link rel="stylesheet" href="../client/src/styles.css" />', () => `<style>\n${css}\n</style>`)
    .replace('href="../client/public/icon-32.png"', () => `href="${icon32}"`)
    .replace('src="../client/public/icon-192.png"', () => `src="${icon192}"`);
}

/** Responde /start.html e /status.js; devolve false para os outros caminhos. */
export async function serveStartFiles(pathname: string, res: http.ServerResponse, root = ROOT): Promise<boolean> {
  if (pathname === '/start.html') {
    const page = await buildStartPage(root);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return true;
  }
  if (pathname === '/status.js') {
    const status = await fs.readFile(path.join(root, 'scripts', 'status.js'), 'utf8').catch(() => null);
    res.writeHead(status === null ? 404 : 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(status ?? '');
    return true;
  }
  return false;
}
