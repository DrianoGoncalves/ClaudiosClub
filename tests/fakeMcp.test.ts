import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/dev/fake-mcp.mjs', import.meta.url));
const dir = path.join(os.tmpdir(), `fake-mcp-test-${process.pid}-${Date.now()}`);
const children: ChildProcessByStdio<Writable, Readable, null>[] = [];
let seq = 0;

// Sobe o MCP falso com um arquivo de notas próprio (não toca no padrão da pasta temporária).
function connect(extra = '') {
  const file = path.join(dir, `notas-${++seq}.txt`);
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, FAKE_MCP_FILE: file, FAKE_MCP_EXTRA: extra },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(child);
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg);
    }
  });
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`sem resposta para ${method}`)), 3000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const call = (name: string, args: Record<string, unknown> = {}) => request('tools/call', { name, arguments: args });
  return { request, notify, call };
}

const textOf = (msg: any) => msg.result.content[0].text as string;

describe('MCP falso para testar a escrita por MCP (scripts/dev/fake-mcp.mjs)', () => {
  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    for (const c of children) c.kill();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('initialize devolve a versão recebida e a capacidade de ferramentas; ping responde; método desconhecido dá -32601', async () => {
    const mcp = connect();
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0' } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    mcp.notify('notifications/initialized');
    expect((await mcp.request('ping')).result).toEqual({});
    expect((await mcp.request('metodo/inexistente')).error.code).toBe(-32601);
  });

  it('tools/list sem FAKE_MCP_EXTRA: ler_nota (leitura) e gravar_nota (escrita), e mais nada', async () => {
    const { tools } = (await connect().request('tools/list')).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['ler_nota', 'gravar_nota']);
    expect(tools[0].annotations.readOnlyHint).toBe(true);
    expect(tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('tools/list com FAKE_MCP_EXTRA=1: sai apagar_notas, sem readOnlyHint (a ferramenta nova do MCP)', async () => {
    const { tools } = (await connect('1').request('tools/list')).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(['ler_nota', 'gravar_nota', 'apagar_notas']);
    expect(tools[2].annotations.readOnlyHint).toBe(false);
  });

  it('ler_nota vem vazio sem arquivo; gravar_nota acrescenta a linha e ler_nota devolve tudo', async () => {
    const mcp = connect();
    expect(textOf(await mcp.call('ler_nota'))).toBe('');
    expect(textOf(await mcp.call('gravar_nota', { texto: 'primeira' }))).toBe('gravado');
    expect(textOf(await mcp.call('gravar_nota', { texto: 'segunda' }))).toBe('gravado');
    expect(textOf(await mcp.call('ler_nota'))).toBe('primeira\nsegunda\n');
  });
});
