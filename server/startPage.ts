import { promises as fs } from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './root';

// A página de início (scripts/start.html) também é a tela de "parado": o service worker (client/public/sw.js)
// guarda uma cópia e a mostra quando a porta não responde. Aberta como arquivo, ela usa o CSS e os ícones do
// projeto por caminho relativo; servida aqui, vai num arquivo só (CSS e ícones embutidos), porque com o servidor
// parado nada mais carrega. O checklist (scripts/status.js, do `npm run doctor`) vai à parte, em /status.js, e o
// fim do log (~/.myco/logs/server.log), em /log.js.

const LOG_FILE = path.join(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'), 'logs', 'server.log');

export interface LogEntry {
  /** AAAA-MM-DD HH:MM:SS; vazio nas linhas sem carimbo (saída do servidor ou do build). */
  at: string;
  source: string;
  text: string;
}

/** Fim de um arquivo (até `bytes`), sem ler o resto: o log chega a alguns MB. */
export async function readTail(file: string, bytes = 64 * 1024): Promise<string> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Começou no meio: a primeira linha veio cortada.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

const STAMPED = /^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[([^\]]+)\] (.*)$/;
const ANSI = /\x1b\[[0-9;]*m/g;

/** As últimas linhas do log em hora, origem e mensagem. */
export function logEntries(text: string, max = 40): LogEntry[] {
  return text
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-max)
    .map((line) => {
      const m = STAMPED.exec(line);
      return m ? { at: m[1]!, source: m[2]!, text: m[3]! } : { at: '', source: 'saída', text: line };
    });
}

/** O log como script para a página de início: window.claudioLog = { at, entries }. */
export function logScript(entries: LogEntry[], at = new Date()): string {
  return `window.claudioLog = ${JSON.stringify({ at: at.toISOString(), entries })};`;
}

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

/** Responde /start.html, /status.js e /log.js; devolve false para os outros caminhos. */
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
  if (pathname === '/log.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end(logScript(logEntries(await readTail(LOG_FILE))));
    return true;
  }
  return false;
}
