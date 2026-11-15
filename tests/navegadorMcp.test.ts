import { spawn } from 'node:child_process';
import { existsSync, promises as fs, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lazyNavegadorCommand, navegadorProxyCommand, parseProxyArgs, runNavegadorProxy, serverFingerprint, type NavegadorProxyOptions } from '../server/navegadorMcp';

// O proxy preguiçoso do MCP do navegador limpo: `initialize` e `tools/list` saem do cache sem abrir o servidor de verdade; o primeiro pedido que
// precisa dele o abre (repetindo o `initialize` do cliente) e dali em diante tudo passa sem mudar. O servidor de verdade é um script de mentira
// que anota em arquivo cada abertura e cada mensagem recebida.

let root: string;
let FAKE: string;

const FAKE_SERVER = `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [log, mode = 'normal'] = process.argv.slice(2);
const note = (o) => appendFileSync(log, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
note({ ev: 'spawn', mode });
if (mode === 'group') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  note({ ev: 'grandchild', gpid: g.pid });
}
if (mode === 'stubborn') {
  process.on('SIGTERM', () => note({ ev: 'sigterm-ignored' }));
  setInterval(() => {}, 1000);
}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const TOOLS = [
  { name: 'fake_echo', description: 'devolve o texto', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'fake_crash', description: 'derruba o servidor', inputSchema: { type: 'object' } },
];
let clientRoots = false;
const waiting = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  note({ ev: 'recv', msg: m });
  if (m.method === 'initialize') {
    clientRoots = !!m.params?.capabilities?.roots;
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Fake', version: '9.9' } } });
  }
  if (m.method === 'notifications/initialized') {
    if (clientRoots) send({ jsonrpc: '2.0', id: 'r-1', method: 'roots/list' });
    return;
  }
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    if (name === 'fake_echo') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: a.text }] } });
    if (name === 'fake_crash') process.exit(3);
    if (name === 'fake_roots') {
      waiting.set('s-77', m.id);
      return send({ jsonrpc: '2.0', id: 's-77', method: 'roots/list' });
    }
    if (name === 'fake_hang') return; // nunca responde
    return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'ferramenta desconhecida' } });
  }
  if (m.method === undefined && m.id !== undefined) {
    if (waiting.has(m.id)) send({ jsonrpc: '2.0', id: waiting.get(m.id), result: { content: [{ type: 'text', text: JSON.stringify(m.result) }] } });
    return;
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'método não suportado' } });
});
process.stdin.on('end', () => {
  note({ ev: 'stdin-end' });
  if (mode !== 'stubborn') process.exit(0);
});
`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-navegador-'));
  FAKE = path.join(root, 'fake-server.mjs');
  await fs.writeFile(FAKE, FAKE_SERVER);
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

let n = 0;
/** Uma pasta nova por teste: o log do servidor de mentira e o cache. */
async function scratch() {
  const dir = path.join(root, `t${++n}`);
  await fs.mkdir(dir, { recursive: true });
  return { dir, log: path.join(dir, 'fake.log'), cacheDir: path.join(dir, 'cache') };
}

type Msg = { jsonrpc: string; id?: unknown; method?: string; params?: Record<string, unknown>; result?: any; error?: { code: number; message: string } };

/** O que o servidor de mentira anotou (vazio se nunca abriu). */
const events = (log: string): Array<{ pid: number; ev: string; msg?: Msg; gpid?: number }> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const spawns = (log: string) => events(log).filter((e) => e.ev === 'spawn').length;
const received = (log: string) => events(log).filter((e) => e.ev === 'recv').map((e) => e.msg!);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 8_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const v = fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('esperou demais');
}

/** Vivo de verdade: o `kill 0` acerta zumbi, então no Linux olha o estado em /proc. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true;
  }
}

/** O proxy no processo do teste, com o cliente na ponta dos streams. */
function startProxy(s: { log: string; cacheDir?: string }, o: Partial<NavegadorProxyOptions> & { mode?: string; extraArgs?: string[] } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const out: Msg[] = [];
  createInterface({ input: output }).on('line', (l) => out.push(JSON.parse(l) as Msg));
  const { mode, extraArgs, ...rest } = o;
  const done = runNavegadorProxy({
    command: process.execPath,
    args: [FAKE, s.log, mode ?? 'normal', ...(extraArgs ?? [])],
    ...(s.cacheDir && { cacheDir: s.cacheDir }),
    input,
    output,
    killGraceMs: 300,
    handshakeTimeoutMs: 10_000,
    log: () => {},
    ...rest,
  });
  const send = (m: object) => void input.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const raw = (line: string) => void input.write(line + '\n');
  /** A resposta (sem `method`) ao pedido `id`. */
  const response = (id: unknown) => until(() => out.find((m) => m.method === undefined && m.id === id));
  const end = async () => {
    input.end();
    await done;
  };
  return { send, raw, out, response, end, done };
}

const INIT = { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'cliente-teste', version: '3' } };
/** O começo de toda conversa: initialize, initialized e tools/list. */
async function handshake(p: ReturnType<typeof startProxy>, params: object = INIT) {
  p.send({ id: 1, method: 'initialize', params });
  const init = await p.response(1);
  p.send({ method: 'notifications/initialized' });
  p.send({ id: 2, method: 'tools/list' });
  const list = await p.response(2);
  return { init, list };
}

describe('sem cache: o primeiro uso abre o servidor de verdade, grava e segue com ele', () => {
  it('initialize e tools/list vêm do servidor de verdade (uma abertura), vão para o cache e o servidor continua aberto', async () => {
    const s = await scratch();
    const p = startProxy(s);
    const { init, list } = await handshake(p);
    expect(init.result).toEqual({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'Fake', version: '9.9' } });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['fake_echo', 'fake_crash']);
    expect(spawns(s.log)).toBe(1);
    // O servidor recebeu o initialize do cliente (mesmos parâmetros), depois o initialized e o tools/list.
    const rec = received(s.log);
    expect(rec.map((m) => m.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(rec[0]!.params).toEqual(INIT);
    // O cache existe agora.
    await until(() => existsSync(s.cacheDir) && readdirSync(s.cacheDir).some((f) => f.endsWith('.json')));
    // O servidor segue aberto: o primeiro tools/call usa o mesmo processo (sem outra abertura).
    p.send({ id: 3, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'oi' } } });
    expect((await p.response(3)).result.content[0].text).toBe('oi');
    expect(spawns(s.log)).toBe(1);
    await p.end();
  });
});

describe('com cache: initialize, tools/list e ping saem sem abrir o servidor de verdade', () => {
  /** Um primeiro uso para gravar o cache; devolve o que o cliente viu. */
  async function prime(s: { log: string; cacheDir: string }, params: object = INIT, o: Parameters<typeof startProxy>[1] = {}) {
    const p = startProxy(s, o);
    const r = await handshake(p, params);
    await until(() => readdirSync(s.cacheDir).some((f) => f.endsWith('.json')));
    await p.end();
    return r;
  }

  it('a segunda conversa responde initialize e tools/list iguais, sem nenhuma abertura', async () => {
    const s = await scratch();
    const first = await prime(s);
    expect(spawns(s.log)).toBe(1);
    const p = startProxy(s);
    const { init, list } = await handshake(p);
    expect(init.result).toEqual(first.init.result);
    expect(list.result).toEqual(first.list.result);
    expect(spawns(s.log)).toBe(1); // continua a primeira
    p.send({ id: 9, method: 'ping' });
    expect((await p.response(9)).result).toEqual({});
    await p.end();
    expect(spawns(s.log)).toBe(1);
  });

  it('o id da resposta é o do cliente', async () => {
    const s = await scratch();
    await prime(s);
    const p = startProxy(s);
    p.send({ id: 'abc', method: 'initialize', params: INIT });
    expect((await p.response('abc')).result.serverInfo.name).toBe('Fake');
    p.send({ id: 77, method: 'tools/list' });
    expect((await p.response(77)).result.tools).toHaveLength(2);
    await p.end();
  });

  it('o cache não depende da pasta de capturas (--output-dir), mas depende dos demais argumentos e do protocolo do cliente', async () => {
    const s = await scratch();
    await prime(s, INIT, { extraArgs: ['--output-dir', path.join(s.dir, 'a'), '--isolated'] });
    expect(spawns(s.log)).toBe(1);
    // Outra pasta de capturas: o mesmo cache.
    const igual = startProxy(s, { extraArgs: ['--output-dir', path.join(s.dir, 'b'), '--isolated'] });
    await handshake(igual);
    await igual.end();
    expect(spawns(s.log)).toBe(1);
    // Outro argumento (que pode mudar as ferramentas): abre de novo.
    const outro = startProxy(s, { extraArgs: ['--output-dir', path.join(s.dir, 'b'), '--isolated', '--caps', 'vision'] });
    await handshake(outro);
    await outro.end();
    expect(spawns(s.log)).toBe(2);
    // Outro protocolo do cliente: abre de novo (o servidor de verdade responde com a versão pedida).
    const novo = startProxy(s, { extraArgs: ['--output-dir', path.join(s.dir, 'b'), '--isolated'] });
    await handshake(novo, { ...INIT, protocolVersion: '2025-11-25' });
    expect(spawns(s.log)).toBe(3);
    await novo.end();
  });

  it('cache ilegível ou de outra chave: vale como ausente (abre o servidor e regrava)', async () => {
    const s = await scratch();
    await prime(s);
    for (const f of readdirSync(s.cacheDir)) await fs.writeFile(path.join(s.cacheDir, f), '{"key":"outra","initialize":{"protocolVersion":"x"},"tools":[]}');
    const p = startProxy(s);
    const { list } = await handshake(p);
    expect(list.result.tools).toHaveLength(2);
    expect(spawns(s.log)).toBe(2);
    await p.end();
    for (const f of readdirSync(s.cacheDir)) await fs.writeFile(path.join(s.cacheDir, f), 'não é json');
    const q = startProxy(s);
    await handshake(q);
    expect(spawns(s.log)).toBe(3);
    await q.end();
  });

  it('pasta do cache sem escrita: segue funcionando, só sem cache', async () => {
    const s = await scratch();
    await fs.writeFile(path.join(s.dir, 'arquivo'), '');
    const p = startProxy({ log: s.log, cacheDir: path.join(s.dir, 'arquivo', 'filho') });
    const { list } = await handshake(p);
    expect(list.result.tools).toHaveLength(2);
    await p.end();
  });

  it('o primeiro tools/call abre o servidor, repete o initialize e o initialized do cliente e só então entrega o pedido', async () => {
    const s = await scratch();
    await prime(s);
    const p = startProxy(s);
    await handshake(p);
    expect(spawns(s.log)).toBe(1); // só o da primeira conversa
    p.send({ id: 10, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'primeiro' } } });
    expect((await p.response(10)).result.content[0].text).toBe('primeiro');
    expect(spawns(s.log)).toBe(2);
    const depois = received(s.log).slice(3); // depois do tools/list da primeira conversa
    expect(depois.map((m) => m.method).slice(0, 3)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(depois[0]!.params).toEqual(INIT); // o initialize do cliente, repetido
    // A resposta ao initialize repetido não chega ao cliente: só uma resposta por pedido do cliente.
    expect(p.out.filter((m) => m.method === undefined).map((m) => m.id)).toEqual([1, 2, 10]);
    // Os seguintes seguem no mesmo servidor.
    p.send({ id: 11, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'segundo' } } });
    expect((await p.response(11)).result.content[0].text).toBe('segundo');
    expect(spawns(s.log)).toBe(2);
    await p.end();
  });

  it('pedidos que chegam enquanto o servidor abre ficam na fila e saem na ordem', async () => {
    const s = await scratch();
    await prime(s);
    const p = startProxy(s);
    await handshake(p);
    for (const [id, text] of [[20, 'a'], [21, 'b'], [22, 'c']] as const) p.send({ id, method: 'tools/call', params: { name: 'fake_echo', arguments: { text } } });
    expect([(await p.response(20)).result.content[0].text, (await p.response(21)).result.content[0].text, (await p.response(22)).result.content[0].text]).toEqual(['a', 'b', 'c']);
    expect(received(s.log).filter((m) => m.method === 'tools/call').map((m) => m.id)).toEqual([20, 21, 22]);
    expect(spawns(s.log)).toBe(2);
    await p.end();
  });

  it('ping responde na hora mesmo com o servidor abrindo ou parado; tools/list continua vindo do cache enquanto ele abre', async () => {
    const s = await scratch();
    await prime(s);
    const p = startProxy(s);
    await handshake(p);
    p.send({ id: 30, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'x' } } });
    p.send({ id: 31, method: 'ping' });
    p.send({ id: 32, method: 'tools/list' });
    expect((await p.response(31)).result).toEqual({});
    expect((await p.response(32)).result.tools).toHaveLength(2);
    expect((await p.response(30)).result.content[0].text).toBe('x');
    await p.end();
  });
});

describe('servidor de verdade aberto: o que passa e o que o servidor pergunta ao cliente', () => {
  it('o pedido do servidor ao cliente (roots/list) chega ao cliente com o mesmo id e a resposta volta ao servidor', async () => {
    const s = await scratch();
    const p = startProxy(s);
    await handshake(p);
    // No initialized o servidor de mentira pergunta roots/list (o cliente declarou roots).
    const r1 = await until(() => p.out.find((m) => m.method === 'roots/list' && m.id === 'r-1'));
    expect(r1).toEqual({ jsonrpc: '2.0', id: 'r-1', method: 'roots/list' });
    p.send({ id: 'r-1', result: { roots: [{ uri: 'file:///proj' }] } });
    await until(() => received(s.log).find((m) => m.id === 'r-1' && m.result));
    // Durante uma chamada: o servidor pergunta, o cliente responde e a chamada termina com o que ele recebeu.
    p.send({ id: 40, method: 'tools/call', params: { name: 'fake_roots', arguments: {} } });
    const r2 = await until(() => p.out.find((m) => m.method === 'roots/list' && m.id === 's-77'));
    expect(r2.id).toBe('s-77');
    p.send({ id: 's-77', result: { roots: [{ uri: 'file:///outra' }] } });
    expect(JSON.parse((await p.response(40)).result.content[0].text)).toEqual({ roots: [{ uri: 'file:///outra' }] });
    await p.end();
  });

  it('na repetição do initialize (cache), o roots/list do servidor também chega ao cliente', async () => {
    const s = await scratch();
    const first = startProxy(s);
    await handshake(first);
    await first.end();
    const p = startProxy(s);
    await handshake(p);
    p.send({ id: 41, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'k' } } });
    await until(() => p.out.find((m) => m.method === 'roots/list' && m.id === 'r-1'));
    p.send({ id: 'r-1', result: { roots: [] } });
    expect((await p.response(41)).result.content[0].text).toBe('k');
    await until(() => received(s.log).filter((m) => m.id === 'r-1' && m.result).length >= 1); // só o servidor aberto agora recebeu: o da primeira conversa nunca perguntou de novo
    await p.end();
  });

  it('resposta do cliente a um pedido que o servidor não fez (ou de um servidor que já morreu) não chega ao servidor novo', async () => {
    const s = await scratch();
    const p = startProxy(s, { handshakeTimeoutMs: 10_000 });
    await handshake(p, { ...INIT, capabilities: {} }); // sem roots: o servidor não pergunta nada
    p.send({ id: 'fantasma', result: { roots: [] } });
    p.send({ id: 50, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'z' } } });
    await p.response(50);
    expect(received(s.log).some((m) => m.id === 'fantasma')).toBe(false);
    await p.end();
  });

  it('notificações, métodos desconhecidos e erros do servidor passam sem mudar', async () => {
    const s = await scratch();
    const p = startProxy(s);
    await handshake(p);
    p.send({ method: 'notifications/cancelled', params: { requestId: 999, reason: 'x' } });
    p.send({ id: 60, method: 'resources/list' });
    const r = await p.response(60);
    expect(r.error).toEqual({ code: -32601, message: 'método não suportado' });
    p.send({ id: 61, method: 'tools/call', params: { name: 'nenhuma', arguments: {} } });
    expect((await p.response(61)).error).toEqual({ code: -32602, message: 'ferramenta desconhecida' });
    expect(received(s.log).some((m) => m.method === 'notifications/cancelled' && m.params?.requestId === 999)).toBe(true);
    await p.end();
  });

  it('resources/* e prompts/* sem servidor aberto também o abrem', async () => {
    const s = await scratch();
    const first = startProxy(s);
    await handshake(first);
    await first.end();
    const p = startProxy(s);
    await handshake(p);
    expect(spawns(s.log)).toBe(1);
    p.send({ id: 70, method: 'prompts/list' });
    expect((await p.response(70)).error?.code).toBe(-32601);
    expect(spawns(s.log)).toBe(2);
    await p.end();
  });
});

describe('o servidor de verdade cai', () => {
  it('os pedidos em andamento falham com erro JSON-RPC; o próximo pedido abre de novo e funciona', async () => {
    const s = await scratch();
    const p = startProxy(s);
    await handshake(p);
    p.send({ id: 80, method: 'tools/call', params: { name: 'fake_hang', arguments: {} } });
    p.send({ id: 81, method: 'tools/call', params: { name: 'fake_crash', arguments: {} } });
    for (const id of [80, 81]) {
      const r = await p.response(id);
      expect(r.error?.code).toBe(-32603);
      expect(r.error?.message).toMatch(/myco-navegador.*encerrou.*abre o navegador de novo/);
    }
    expect(spawns(s.log)).toBe(1);
    p.send({ id: 82, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'de novo' } } });
    expect((await p.response(82)).result.content[0].text).toBe('de novo');
    expect(spawns(s.log)).toBe(2);
    // O servidor novo recebeu de novo o initialize do cliente.
    expect(received(s.log).filter((m) => m.method === 'initialize').map((m) => m.params)).toEqual([INIT, INIT]);
    await p.end();
  });

  it('cai de novo e de novo: cada pedido recebe o seu erro e a abertura seguinte funciona', async () => {
    const s = await scratch();
    const p = startProxy(s);
    await handshake(p);
    for (const id of [90, 91]) {
      p.send({ id, method: 'tools/call', params: { name: 'fake_crash', arguments: {} } });
      expect((await p.response(id)).error?.code).toBe(-32603);
    }
    p.send({ id: 92, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'ok' } } });
    expect((await p.response(92)).result.content[0].text).toBe('ok');
    expect(spawns(s.log)).toBe(3);
    await p.end();
  });

  it('servidor que não abre (comando inexistente): o pedido falha com o motivo e o proxy segue respondendo', async () => {
    const s = await scratch();
    const p = startProxy(s, { command: path.join(s.dir, 'nao-existe') });
    p.send({ id: 1, method: 'initialize', params: INIT });
    expect((await p.response(1)).error?.message).toMatch(/myco-navegador.*não abriu/);
    p.send({ id: 2, method: 'ping' });
    expect((await p.response(2)).result).toEqual({});
    p.send({ id: 3, method: 'tools/call', params: { name: 'fake_echo', arguments: {} } });
    expect((await p.response(3)).error?.code).toBe(-32603);
    await p.end();
  });

  it('servidor que não responde ao initialize no prazo: o pedido falha e o processo é morto', async () => {
    const s = await scratch();
    const mudo = path.join(s.dir, 'mudo.mjs');
    await fs.writeFile(mudo, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(s.log)}, JSON.stringify({ ev: 'spawn', pid: process.pid }) + '\\n'); setInterval(() => {}, 1000);`);
    const p = startProxy(s, { args: [mudo], handshakeTimeoutMs: 300 });
    p.send({ id: 1, method: 'initialize', params: INIT });
    expect((await p.response(1)).error?.message).toMatch(/não respondeu a tempo/);
    const pid = events(s.log)[0]!.pid;
    await until(() => !alive(pid));
    await p.end();
  });
});

describe('o stdin fecha: o servidor de verdade morre e o proxy sai', () => {
  it('fim do stdin com o servidor aberto: o processo some antes de o proxy devolver', async () => {
    const s = await scratch();
    const p = startProxy(s);
    await handshake(p);
    const pid = events(s.log)[0]!.pid;
    expect(alive(pid)).toBe(true);
    await p.end();
    expect(alive(pid)).toBe(false);
  });

  it('fim do stdin sem servidor aberto (cache): nada a matar, sai logo', async () => {
    const s = await scratch();
    const first = startProxy(s);
    await handshake(first);
    await first.end();
    const p = startProxy(s);
    await handshake(p);
    const t0 = Date.now();
    await p.end();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(spawns(s.log)).toBe(1);
  });

  it('servidor que ignora o SIGTERM: o SIGKILL vem depois da tolerância', async () => {
    const s = await scratch();
    const p = startProxy(s, { mode: 'stubborn', killGraceMs: 250 });
    await handshake(p);
    const pid = events(s.log)[0]!.pid;
    await p.end();
    expect(events(s.log).some((e) => e.ev === 'sigterm-ignored')).toBe(process.platform !== 'win32');
    expect(alive(pid)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('mata o grupo todo: o que o servidor abriu também morre', async () => {
    const s = await scratch();
    const p = startProxy(s, { mode: 'group' });
    await handshake(p);
    const gpid = (await until(() => events(s.log).find((e) => e.ev === 'grandchild')))!.gpid!;
    expect(alive(gpid)).toBe(true);
    await p.end();
    await until(() => !alive(gpid), 3_000);
  });
});

describe('mensagens fora do comum', () => {
  it('linha que não é JSON e mensagem que não é objeto: erro do JSON-RPC, sem abrir o servidor; linha vazia e BOM passam', async () => {
    const s = await scratch();
    const p = startProxy(s);
    p.raw('isto não é json');
    expect((await until(() => p.out.find((m) => m.error?.code === -32700)))!.id).toBeNull();
    p.raw('[1,2]');
    await until(() => p.out.find((m) => m.error?.code === -32600));
    p.raw('');
    p.raw('\uFEFF' + JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' }));
    expect((await p.response(5)).result).toEqual({});
    await p.end();
    expect(spawns(s.log)).toBe(0);
  });

  it('sem initialize (cliente fora do protocolo): o primeiro pedido abre o servidor com um initialize padrão', async () => {
    const s = await scratch();
    const p = startProxy(s);
    p.send({ id: 1, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'sem init' } } });
    expect((await p.response(1)).result.content[0].text).toBe('sem init');
    expect(received(s.log)[0]!.method).toBe('initialize');
    await p.end();
  });
});

describe('módulo: leve de verdade', () => {
  const importsOf = (rel: string) => [...readFileSync(path.join(import.meta.dirname, '..', rel), 'utf8').matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]!);

  it('o proxy só importa built-ins do node (e ./root, que também só usa node:fs e node:path)', () => {
    for (const spec of importsOf('server/navegadorMcp.ts')) expect(spec.startsWith('node:') || spec === './root', spec).toBe(true);
    expect(importsOf('server/root.ts').every((s) => s.startsWith('node:'))).toBe(true);
    for (const spec of importsOf('server/navegador-mcp.ts')) expect(spec === './navegadorMcp', spec).toBe(true);
  });
});

describe('como o proxy é lançado', () => {
  it('serverFingerprint: ignora a pasta de capturas e inclui o que muda as ferramentas', () => {
    const base = ['/x/cli.js', '--isolated', '--browser', 'chrome'];
    const a = serverFingerprint('/usr/bin/node', [...base, '--output-dir', '/run/1/navegador']);
    expect(serverFingerprint('/usr/bin/node', [...base, '--output-dir', '/run/2/navegador'])).toBe(a);
    expect(serverFingerprint('/usr/bin/node', [...base, '--output-dir=/run/3'])).toBe(a);
    expect(serverFingerprint('/usr/bin/node', [...base, '--caps', 'vision', '--output-dir', '/run/1/navegador'])).not.toBe(a);
    expect(serverFingerprint('/usr/bin/node', ['/x/cli.js', '--isolated', '--browser', 'msedge'])).not.toBe(a);
  });

  it('serverFingerprint: a versão do @playwright/mcp instalado entra', () => {
    const cli = path.join(import.meta.dirname, '..', 'node_modules', '@playwright', 'mcp', 'cli.js');
    expect(serverFingerprint(process.execPath, [cli])).toMatch(/@playwright\/mcp@\d+\.\d+\.\d+/);
  });

  it('parseProxyArgs: cache e, depois de --, o comando e os argumentos (inclusive os que começam com --)', () => {
    expect(parseProxyArgs(['--cache-dir', '/c', '--', 'node', 'cli.js', '--isolated', '--', 'x'])).toEqual({ command: 'node', args: ['cli.js', '--isolated', '--', 'x'], cacheDir: '/c' });
    expect(parseProxyArgs(['--', 'node'])).toEqual({ command: 'node', args: [] });
    expect(() => parseProxyArgs(['--cache-dir', '/c'])).toThrow(/uso:/);
    expect(() => parseProxyArgs(['--cache-dir', '/c', '--'])).toThrow(/uso:/);
  });

  it('lazyNavegadorCommand: o proxy, o cache e o comando de verdade intactos depois de --', () => {
    const real = { command: '/usr/bin/node', args: ['/x/cli.js', '--isolated', '--headless', '--blocked-origins', 'http://a;http://b'] };
    const c = lazyNavegadorCommand(real, '/home/u/.myco/cache/navegador-mcp', false);
    expect(c.command).toBe(process.execPath);
    expect(c.args.slice(c.args.indexOf('--cache-dir'))).toEqual(['--cache-dir', '/home/u/.myco/cache/navegador-mcp', '--', real.command, ...real.args]);
    expect(c.args.some((a) => a.endsWith(path.join('server', 'navegador-mcp.ts')))).toBe(true);
    expect(parseProxyArgs(c.args.slice(c.args.indexOf('--cache-dir')))).toEqual({ ...real, cacheDir: '/home/u/.myco/cache/navegador-mcp' });
  });

  it('empacotado e com o pacote no disco: node + dist/navegador-mcp.mjs; sem o pacote, o .ts pelo tsx', () => {
    const dev = navegadorProxyCommand(false);
    expect(dev.args[0]).toBe('--import');
    expect(navegadorProxyCommand(true).args.length).toBe(existsSync(path.join(import.meta.dirname, '..', 'dist', 'navegador-mcp.mjs')) ? 1 : 3);
  });
});

describe('a entrada (server/navegador-mcp.ts) de ponta a ponta', () => {
  it('sobe pelo node, conversa pelo stdio, abre o servidor no primeiro tools/call e, no fim do stdin, mata tudo e sai com 0', async () => {
    const s = await scratch();
    const { command, args } = navegadorProxyCommand(false);
    const proc = spawn(command, [...args, '--cache-dir', s.cacheDir, '--', process.execPath, FAKE, s.log, 'normal'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const out: Msg[] = [];
    createInterface({ input: proc.stdout }).on('line', (l) => out.push(JSON.parse(l) as Msg));
    const send = (m: object) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    const response = (id: number) => until(() => out.find((m) => m.method === undefined && m.id === id), 20_000);
    send({ id: 1, method: 'initialize', params: INIT });
    await response(1);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    expect((await response(2)).result.tools).toHaveLength(2);
    send({ id: 3, method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'ponta' } } });
    expect((await response(3)).result.content[0].text).toBe('ponta');
    const pid = events(s.log)[0]!.pid;
    proc.stdin.end();
    const code = await new Promise<number | null>((resolve) => proc.once('close', resolve));
    expect(code).toBe(0);
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
