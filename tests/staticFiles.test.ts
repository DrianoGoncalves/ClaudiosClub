import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileEtag, notModifiedSince, serveStatic } from '../server/staticFiles';
import { removeTemp } from './support/tmp';

// Os estáticos do cliente (server/staticFiles.ts) num servidor HTTP de verdade: cache no navegador (assets/ imutável, o resto com 304 por ETag ou data),
// contenção na pasta (inclusive com o caminho codificado) e os 404 de antes.

let base: string;
let client: string;
let server: http.Server;
let port: number;
const js = 'export const x = 1;\n'.repeat(50);
const html = '<!doctype html><title>t</title><p>oi</p>';
const SECRET = 'NAO-PODE-SAIR';

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-static-'));
  client = path.join(base, 'client');
  await fs.mkdir(path.join(client, 'assets'), { recursive: true });
  await fs.writeFile(path.join(client, 'index.html'), html);
  await fs.writeFile(path.join(client, 'sw.js'), 'self.x = 1;');
  await fs.writeFile(path.join(client, 'assets', 'index-abc123.js'), js);
  await fs.writeFile(path.join(client, 'icon.png'), Buffer.alloc(400, 7));
  await fs.writeFile(path.join(base, 'secret.txt'), SECRET); // fora da pasta do cliente
  server = http.createServer((req, res) => void serveStatic(client, new URL(req.url ?? '/', 'http://x').pathname, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeTemp(base);
});

/** GET cru, com o caminho exatamente como escrito (sem normalizar `..` nem decodificar). */
function get(p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serveStatic', () => {
  it('assets/ com hash: guardado por 1 ano (immutable), com o tipo certo', async () => {
    const r = await get('/assets/index-abc123.js');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(r.body).toBe(js);
    expect(r.headers['content-encoding']).toBeUndefined(); // sem compressão: servidor só local
  });

  it('index.html (e a rota do app que cai nele): no-cache; 304 sem corpo pelo ETag ou pela data quando não mudou', async () => {
    const first = await get('/tarefas');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toBe('no-cache');
    expect(first.body).toBe(html);
    const byEtag = await get('/', { 'if-none-match': String(first.headers.etag) });
    expect(byEtag.status).toBe(304);
    expect(byEtag.body).toBe('');
    const byDate = await get('/', { 'if-modified-since': String(first.headers['last-modified']) });
    expect(byDate.status).toBe(304);
    // ETag de outra versão: corpo inteiro, mesmo com a data cobrindo (o ETag manda).
    const stale = await get('/', { 'if-none-match': '"0-0"', 'if-modified-since': String(first.headers['last-modified']) });
    expect(stale.status).toBe(200);
    expect(stale.body).toBe(html);
  });

  it('ícone e sw.js: no-cache (o navegador confere)', async () => {
    expect((await get('/icon.png')).headers['cache-control']).toBe('no-cache');
    expect((await get('/icon.png')).headers['content-type']).toBe('image/png');
    expect((await get('/sw.js')).headers['cache-control']).toBe('no-cache');
  });

  it('caminho codificado que sai de assets/ (`..%2f`) não ganha immutable', async () => {
    const r = await get('/assets/..%2fsw.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('self.x = 1;');
    expect(r.headers['cache-control']).toBe('no-cache');
  });

  it('nada de fora da pasta do cliente sai, nem com `..` codificado', async () => {
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const r = await get(p);
      expect(r.body, p).not.toContain(SECRET);
    }
  });

  it('arquivo com extensão que falta dentro da pasta: 404 (não o index.html)', async () => {
    expect((await get('/assets/sumiu-999.js')).status).toBe(404);
  });
});

describe('fileEtag e notModifiedSince', () => {
  it('ETag muda com o tamanho e com o mtime em ms (o mesmo segundo não engana)', () => {
    const t = Date.parse('2026-11-22T12:00:00.100Z');
    expect(fileEtag(10, t)).not.toBe(fileEtag(11, t));
    expect(fileEtag(10, t)).not.toBe(fileEtag(10, t + 500));
    expect(fileEtag(10, t)).toBe(fileEtag(10, t));
  });

  it('a data (só segundos) cobre o arquivo: 304; arquivo mais novo ou cabeçalho ruim: corpo inteiro', () => {
    const mtime = Date.parse('2026-11-22T12:00:00.750Z');
    expect(notModifiedSince(new Date(mtime).toUTCString(), mtime)).toBe(true);
    expect(notModifiedSince('Sun, 22 Nov 2026 12:00:01 GMT', mtime)).toBe(true);
    expect(notModifiedSince('Sun, 22 Nov 2026 11:59:59 GMT', mtime)).toBe(false);
    expect(notModifiedSince('ontem', mtime)).toBe(false);
    expect(notModifiedSince(undefined, mtime)).toBe(false);
  });
});
