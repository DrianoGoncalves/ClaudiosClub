import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandVars, testMcpConfig } from '../server/staff/mcpTest';

// Servidor HTTP falso (streamable: JSON e SSE) e um MCP stdio falso num arquivo temporário.

let root: string;
let server: http.Server;
let base: string;
let stdioScript: string;
let hangScript: string;
const AUTH = { Authorization: 'Bearer ok-123' };

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcptest-'));
  stdioScript = path.join(root, 'fake-mcp.mjs');
  await fs.writeFile(
    stdioScript,
    [
      "import { createInterface } from 'node:readline';",
      "process.stdout.write('aviso de log, não é JSON\\n');",
      "const rl = createInterface({ input: process.stdin });",
      'rl.on("line", (line) => {',
      '  const m = JSON.parse(line);',
      "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'falso', version: '1' } } }) + '\\n');",
      "  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: process.env.NOME_DA_FERRAMENTA ?? 'sem-nome' }, { name: 'soma' }] } }) + '\\n');",
      '});',
    ].join('\n'),
  );
  hangScript = path.join(root, 'mudo.mjs');
  await fs.writeFile(hangScript, 'setInterval(() => {}, 1000);\n');

  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const path0 = req.url ?? '';
    if (!['/mcp', '/sse', '/mudo'].includes(path0)) {
      res.writeHead(404).end();
      return;
    }
    if (path0 === '/mudo') return; // nunca responde
    if (req.headers.authorization !== 'Bearer ok-123') {
      res.writeHead(401).end();
      return;
    }
    const msg = JSON.parse(raw || 'null') as { id?: number; method?: string };
    const sse = path0 === '/sse';
    const send = (payload: object, extra: Record<string, string> = {}) => {
      if (sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        // Fica aberto: o cliente tem de parar de ler sozinho ao achar a resposta.
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(payload));
      }
    };
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'http-falso', version: '1' } } }, { 'mcp-session-id': 'sess-1' });
    } else if (msg.method === 'notifications/initialized') {
      res.writeHead(202).end();
    } else if (msg.method === 'tools/list') {
      if (req.headers['mcp-session-id'] !== 'sess-1') {
        res.writeHead(400).end();
        return;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'busca' }, { name: 'resumo' }] } });
    } else {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

describe('teste de MCP: HTTP (streamable)', () => {
  it('lista as ferramentas (resposta em JSON)', async () => {
    const r = await testMcpConfig({ type: 'http', url: `${base}/mcp`, headers: AUTH });
    expect(r).toEqual({ ok: true, tools: ['busca', 'resumo'], readOnly: [] });
  });

  it('lista as ferramentas quando a resposta vem em SSE', async () => {
    const r = await testMcpConfig({ type: 'http', url: `${base}/sse`, headers: AUTH });
    expect(r).toEqual({ ok: true, tools: ['busca', 'resumo'], readOnly: [] });
  });

  it('autenticação recusada: mensagem clara, sem o token', async () => {
    const r = await testMcpConfig({ type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer errado-999' } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('autenticação');
    expect(JSON.stringify(r)).not.toContain('errado-999');
  });

  it('caminho que não é streamable: erro claro', async () => {
    const r = await testMcpConfig({ type: 'http', url: `${base}/nada`, headers: AUTH });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('não aceita HTTP streamable');
  });

  it('sem resposta: para no tempo limite (não fica preso)', async () => {
    const started = Date.now();
    const r = await testMcpConfig({ type: 'http', url: `${base}/mudo`, headers: AUTH }, { timeoutMs: 600 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('não respondeu');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('falha de rede: uma nova tentativa e depois erro (sem a URL na mensagem)', async () => {
    let calls = 0;
    const r = await testMcpConfig(
      { type: 'http', url: `${base}/mcp`, headers: AUTH },
      {
        retryWaitMs: 10,
        fetchImpl: async () => {
          calls++;
          throw new TypeError('fetch failed');
        },
      },
    );
    expect(calls).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('não consegui conectar');
    expect(r.error).not.toContain(base);
  });

  it('falha de rede passageira: a segunda tentativa passa', async () => {
    let calls = 0;
    const r = await testMcpConfig(
      { type: 'http', url: `${base}/mcp`, headers: AUTH },
      {
        retryWaitMs: 10,
        fetchImpl: async (input, init) => {
          calls++;
          if (calls === 1) throw new TypeError('fetch failed');
          return fetch(input, init);
        },
      },
    );
    expect(r).toEqual({ ok: true, tools: ['busca', 'resumo'], readOnly: [] });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('URL inválida e tipo desconhecido: recusa antes de chamar a rede', async () => {
    expect((await testMcpConfig({ type: 'http', url: 'ftp://x.dev/mcp' })).error).toContain('URL inválida');
    expect((await testMcpConfig({ type: 'ws', url: 'https://x.dev/mcp' })).error).toContain('tipo de servidor desconhecido');
  });
});

describe('teste de MCP: stdio', () => {
  it('lista as ferramentas; as variáveis do env valem, com ${VAR} expandido', async () => {
    process.env.MYCO_TESTE_FERRAMENTA = 'vinda-do-ambiente';
    try {
      const r = await testMcpConfig({
        type: 'stdio',
        command: process.execPath,
        args: [stdioScript],
        env: { NOME_DA_FERRAMENTA: '${MYCO_TESTE_FERRAMENTA}' },
      });
      expect(r).toEqual({ ok: true, tools: ['vinda-do-ambiente', 'soma'], readOnly: [] });
    } finally {
      delete process.env.MYCO_TESTE_FERRAMENTA;
    }
  });

  it('${VAR:-padrão} usa o padrão quando a variável não existe', async () => {
    const r = await testMcpConfig({ type: 'stdio', command: process.execPath, args: [stdioScript], env: { NOME_DA_FERRAMENTA: '${MYCO_TESTE_NAO_EXISTE:-padrao-do-teste}' } });
    expect(r).toEqual({ ok: true, tools: ['padrao-do-teste', 'soma'], readOnly: [] });
  });

  it('variável ausente sem padrão: erro com o nome da variável', async () => {
    const r = await testMcpConfig({ type: 'stdio', command: process.execPath, args: ['${MYCO_TESTE_NAO_EXISTE}'] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MYCO_TESTE_NAO_EXISTE');
  });

  it('processo que não responde: tempo limite, e o teste volta', async () => {
    const started = Date.now();
    const r = await testMcpConfig({ type: 'stdio', command: process.execPath, args: [hangScript] }, { timeoutMs: 800 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('não respondeu');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('comando que não existe: erro claro', async () => {
    const r = await testMcpConfig({ type: 'stdio', command: 'mycoh-comando-que-nao-existe-xyz', args: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('não achei o comando');
  });

  it('expandVars: troca só ${NOME}; texto sem variável fica igual', () => {
    process.env.MYCO_TESTE_X = 'valor';
    try {
      expect(expandVars('a-${MYCO_TESTE_X}-b')).toBe('a-valor-b');
      expect(expandVars('sem variável $HOME')).toBe('sem variável $HOME');
    } finally {
      delete process.env.MYCO_TESTE_X;
    }
  });
});
