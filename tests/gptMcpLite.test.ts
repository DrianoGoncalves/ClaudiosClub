import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createGptMcp } from '../server/staff/gptMcp';
import { runGptMcpLazy, type GptCore } from '../server/staff/gptMcpLite';

// A entrada preguiçosa do MCP do GPT: initialize, ping e tools/list saem sem carregar o MCP inteiro (gptMcp.ts); o resto o carrega uma vez e
// passa a ele a linha que o pediu e tudo o que vier depois. O MCP inteiro é trocado por um falso que anota o que recebe.

const ARGV = ['--project', '/p', '--root', '/p'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 3_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = fn();
    if (v) return v;
    await sleep(10);
  }
  throw new Error('esperou demais');
}

type Msg = { id?: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

function setup(loadCore: () => Promise<GptCore>, argv = ARGV) {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: Msg[] = [];
  let buf = '';
  output.on('data', (c: Buffer) => {
    buf += c.toString();
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      out.push(JSON.parse(buf.slice(0, nl)) as Msg);
      buf = buf.slice(nl + 1);
    }
  });
  const done = runGptMcpLazy(argv, input, output, { loadCore });
  const send = (m: object) => void input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const response = (id: unknown) => until(() => out.find((m) => m.id === id));
  return { input, out, done, send, response };
}

/** O MCP inteiro de mentira: anota o que recebeu e responde a cada pedido com o `id` e o texto da linha. */
function fakeCore() {
  const seen: string[] = [];
  let started = 0;
  let ended = false;
  const core: GptCore = {
    runGptMcpStdio: async (_argv, input, output) => {
      started++;
      let buf = '';
      input.setEncoding?.('utf8' as never);
      input.on('data', (c: string | Buffer) => {
        buf += c.toString();
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          seen.push(line);
          let m: { id?: unknown; method?: string };
          try {
            m = JSON.parse(line) as typeof m;
          } catch {
            continue; // linha que não é JSON: o MCP de verdade responderia -32700; aqui basta ter chegado
          }
          if (m.id !== undefined) output.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { via: 'core', method: m.method } }) + '\n');
        }
      });
      await new Promise<void>((r) => input.once('end', r));
      ended = true;
    },
  };
  return { core, seen, started: () => started, ended: () => ended };
}

describe('gptMcpLite: o que responde sem carregar o MCP inteiro', () => {
  it('initialize, ping e tools/list saem iguais aos do MCP inteiro, e nada é carregado', async () => {
    const loadCore = vi.fn(async () => fakeCore().core);
    const p = setup(loadCore);
    p.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    p.send({ method: 'notifications/initialized' });
    p.send({ method: 'notifications/cancelled', params: { requestId: 9 } });
    p.send({ id: 2, method: 'ping' });
    p.send({ id: 3, method: 'tools/list' });
    p.send({ id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    await p.response(4);
    const real = createGptMcp({ root: '/p', projectPath: '/p', home: '/h', mycoHome: '/m' });
    for (const req of [
      { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { id: 2, method: 'ping' },
      { id: 3, method: 'tools/list' },
      { id: 4, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
    ]) expect(await p.response(req.id), req.method).toEqual(await real.handle({ jsonrpc: '2.0', ...req }));
    expect(p.out).toHaveLength(4); // as notificações não têm resposta
    expect(loadCore).not.toHaveBeenCalled();
    p.input.end();
    await p.done;
    expect(loadCore).not.toHaveBeenCalled();
  });

  it('linha vazia e BOM passam sem carregar nada', async () => {
    const loadCore = vi.fn(async () => fakeCore().core);
    const p = setup(loadCore);
    p.input.write('\n');
    p.input.write('﻿' + JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    expect((await p.response(1)).result).toEqual({});
    p.input.end();
    await p.done;
    expect(loadCore).not.toHaveBeenCalled();
  });
});

describe('gptMcpLite: o que carrega o MCP inteiro', () => {
  it('o primeiro tools/call o carrega (uma vez), recebe a linha e tudo o que vier depois, na ordem; o fim do stdin o encerra', async () => {
    const f = fakeCore();
    const loadCore = vi.fn(async () => f.core);
    const p = setup(loadCore);
    p.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await p.response(1);
    p.send({ id: 2, method: 'tools/call', params: { name: 'perguntar_gpt', arguments: { pergunta: 'q' } } });
    p.send({ id: 3, method: 'tools/list' }); // já com o MCP inteiro aberto: ele responde
    p.send({ method: 'notifications/cancelled', params: { requestId: 2 } });
    expect((await p.response(2)).result).toEqual({ via: 'core', method: 'tools/call' });
    expect((await p.response(3)).result).toEqual({ via: 'core', method: 'tools/list' });
    await until(() => f.seen.length === 3);
    expect(f.seen.map((l) => (JSON.parse(l) as { method: string }).method)).toEqual(['tools/call', 'tools/list', 'notifications/cancelled']);
    expect(loadCore).toHaveBeenCalledTimes(1);
    expect(f.started()).toBe(1);
    p.input.end();
    await p.done;
    expect(f.ended()).toBe(true);
  });

  it('o que chegou no mesmo bloco depois da linha que abre o MCP inteiro vai junto', async () => {
    const f = fakeCore();
    const p = setup(async () => {
      await sleep(50); // o carregamento demora: o resto da conversa chega enquanto isso
      return f.core;
    });
    const line = (m: object) => JSON.stringify({ jsonrpc: '2.0', ...m });
    p.input.write([line({ id: 1, method: 'tools/call', params: { name: 'x' } }), line({ id: 2, method: 'ping' }), line({ id: 3, method: 'resources/list' })].join('\n') + '\n' + '{"jsonrpc":"2.0","id":4,');
    await sleep(120);
    p.input.write('"method":"tools/list"}\n');
    for (const id of [1, 2, 3, 4]) await p.response(id);
    expect(f.seen.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1, 2, 3, 4]);
    p.input.end();
    await p.done;
  });

  it('método desconhecido e linha que não é JSON também vão ao MCP inteiro (a resposta é a dele)', async () => {
    const f = fakeCore();
    const p = setup(async () => f.core);
    p.send({ id: 1, method: 'resources/list' });
    expect((await p.response(1)).result).toEqual({ via: 'core', method: 'resources/list' });
    p.input.end();
    await p.done;

    const g = fakeCore();
    const q = setup(async () => g.core);
    q.input.write('isto não é json\n');
    await until(() => g.seen.includes('isto não é json'));
    q.input.end();
    await q.done;
  });

  it('carregamento que falha: o pedido recebe um erro JSON-RPC e o proxy segue respondendo; a próxima linha tenta de novo', async () => {
    const f = fakeCore();
    let tries = 0;
    const p = setup(async () => {
      if (++tries === 1) throw new Error('pacote ausente');
      return f.core;
    });
    p.send({ id: 1, method: 'tools/call', params: { name: 'perguntar_gpt', arguments: {} } });
    const r = await p.response(1);
    expect(r.error?.code).toBe(-32603);
    expect(r.error?.message).toMatch(/não carregou/);
    p.send({ id: 2, method: 'ping' });
    expect((await p.response(2)).result).toEqual({});
    p.send({ id: 3, method: 'tools/call', params: { name: 'perguntar_gpt', arguments: {} } });
    expect((await p.response(3)).result).toEqual({ via: 'core', method: 'tools/call' });
    expect(tries).toBe(2);
    p.input.end();
    await p.done;
  });

  it('uso errado (sem --project absoluto): quem diz o erro é o MCP inteiro, já na subida', async () => {
    const run = vi.fn(async () => {
      throw new Error('uso: --project <pasta>');
    });
    const loadCore = vi.fn(async () => ({ runGptMcpStdio: run }) as GptCore);
    await expect(runGptMcpLazy(['--project', 'relativo'], new PassThrough(), new PassThrough(), { loadCore })).rejects.toThrow(/uso:/);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('gptMcpLite: módulo leve de verdade', () => {
  const importsOf = (rel: string) => [...readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8').matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]!);

  it('a entrada e a parte leve só importam built-ins do node, a parte leve e shared/model', () => {
    for (const spec of importsOf('server/staff/gptMcpLite.ts')) expect(spec.startsWith('node:') || spec === './gptMcpMeta', spec).toBe(true);
    for (const spec of importsOf('server/staff/gptMcpMeta.ts')) expect(spec, spec).toBe('../../shared/model');
    for (const spec of importsOf('server/gpt-mcp.ts')) expect(spec, spec).toBe('./staff/gptMcpLite');
  });

  it('o MCP inteiro é carregado por import() dinâmico, não por import estático', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'server/staff/gptMcpLite.ts'), 'utf8');
    expect(src).toMatch(/await import\(spec\)/);
    expect(src).not.toMatch(/^import .* from '\.\/gptMcp'/m);
  });
});
