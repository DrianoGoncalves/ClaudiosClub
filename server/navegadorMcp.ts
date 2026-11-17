import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ROOT } from './root';

// Proxy preguiçoso do MCP do navegador limpo (`myco-navegador`). O Claude Code e o Codex sobem os MCPs da ficha em toda conversa, usados ou
// não, e o Playwright MCP custa ~117 MB parado. Este processo (só built-ins do node: ~54 MB, node 26; o node vazio já pesa ~44) fica no lugar dele e só abre o de verdade
// quando alguém usa o navegador:
// - `initialize` e `tools/list` saem de um cache em disco (chave: versões do pacote + argumentos que mudam as ferramentas + protocolo do
//   cliente), sem abrir o Playwright. Sem cache, abre o de verdade uma vez, grava e segue com ele (ele vai ser usado). Com cache, o primeiro
//   uso confere o `initialize` e o `tools/list` de verdade com os servidos: se mudaram, o cache é regravado e o cliente recebe
//   `notifications/tools/list_changed` (quando o servidor declarou `tools.listChanged`).
// - `ping` o proxy mesmo responde, em qualquer estado. `server/discover` (a sonda que o Claude Code manda antes do `initialize`) também, com o
//   mesmo -32601 que o Playwright dá: o cliente então segue para o `initialize`. Sem isso, a sonda abria o Playwright em toda conversa.
// - Qualquer outro pedido (tools/call, resources/*, prompts/*…) abre o de verdade, repete o `initialize` do cliente (a resposta some) e o
//   `notifications/initialized`, entrega o pedido e dali em diante repassa as linhas dos dois lados sem mexer (inclusive o que o servidor
//   pergunta ao cliente, como roots/list). Os pedidos que chegam enquanto ele sobe ficam numa fila.
// - Ocioso (nenhuma mensagem nos dois sentidos por `IDLE_MS`, e nenhum pedido esperando resposta), o de verdade é encerrado (o navegador e as
//   abas dele vão junto); o próximo pedido o abre de novo, como depois de uma queda.
// - Se o de verdade cai, os pedidos em andamento falham com um erro JSON-RPC e o próximo pedido o abre de novo. Quando o stdin acaba (ou um
//   sinal chega), ele morre (o grupo todo, SIGTERM e depois SIGKILL; no Windows, taskkill) e o proxy sai.
// Só built-ins do node (e ./root, que também só usa node:fs e node:path): módulo do servidor com dependências grandes faria o proxy pesar o
// que ele existe para evitar (tests/navegadorMcp.test.ts confere os imports).

export const NAVEGADOR_BUNDLE = path.join(ROOT, 'dist', 'navegador-mcp.mjs');
export const NAVEGADOR_ENTRY = path.join(ROOT, 'server', 'navegador-mcp.ts');

const CACHE_VERSION = 1;
const NAME = 'myco-navegador';
/** Depois do SIGTERM, quanto esperar antes do SIGKILL no grupo do Playwright. */
export const KILL_GRACE_MS = 3_000;
/** O Playwright que não responde ao `initialize` nesse prazo é morto e o pedido falha (um navegador ausente não deixa a conversa esperando). */
const HANDSHAKE_TIMEOUT_MS = 60_000;
/** No primeiro uso sem cache, o `notifications/initialized` do cliente tem até aqui para chegar antes de o proxy mandar o dele. */
const CLIENT_INITIALIZED_WAIT_MS = 5_000;
/** Sem mensagem nos dois sentidos por esse tempo (e nada esperando resposta), o Playwright é encerrado; o próximo uso o abre de novo. */
export const IDLE_MS = 10 * 60_000;
const PROXY_ID = 'myco-proxy-';

export interface NavegadorProxyOptions {
  /** O servidor de verdade: comando e argumentos. */
  command: string;
  args: string[];
  /** Pasta do cache de `initialize` e `tools/list`. Sem ela, nada é guardado (todo uso abre o servidor de verdade). */
  cacheDir?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** SIGTERM/SIGINT/SIGHUP e o fim do stdin encerram (a entrada real); um segundo sinal sai na hora. */
  handleSignals?: boolean;
  killGraceMs?: number;
  handshakeTimeoutMs?: number;
  /** Ociosidade que encerra o servidor de verdade (0 = nunca); o padrão é `IDLE_MS`. */
  idleMs?: number;
  /** Cada linha de diagnóstico (os testes leem); o padrão é o stderr. */
  log?: (line: string) => void;
}

type Json = Record<string, unknown>;
type Waiter = (m: { result?: unknown; error?: { message?: unknown } }) => void;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const idKey = (id: unknown) => JSON.stringify(id);
const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// ---- cache ----

/** Pacote (nome@versão) que contém este arquivo: o package.json mais próximo acima dele. */
function packageOf(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === 'string') return `${pkg.name}@${String(pkg.version)}`;
    } catch {
      // sem package.json aqui: sobe
    }
  }
  return null;
}

/** Hash curto do conteúdo de um arquivo de configuração (ilegível vira um marcador: o servidor de verdade nem abriria com ele). */
function fileDigest(file: string): string {
  try {
    return shortHash(readFileSync(path.resolve(file), 'utf8'));
  } catch {
    return 'ilegivel';
  }
}

/**
 * O que identifica o servidor de verdade: as versões dos pacotes dos arquivos que ele roda (o @playwright/mcp e o playwright-core, que traz as
 * ferramentas), os argumentos (menos a pasta de capturas, que muda a cada conversa e não muda as ferramentas), o conteúdo do arquivo de
 * `--config` e as variáveis `PLAYWRIGHT_MCP_*` do ambiente (equivalem a argumentos; a da pasta de capturas fica de fora pelo mesmo motivo).
 * O cache vale só com isso igual.
 */
export function serverFingerprint(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const kept: string[] = [];
  const configs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--output-dir') i++;
    else if (!a.startsWith('--output-dir=')) {
      kept.push(a);
      if (a === '--config' && args[i + 1] !== undefined) configs.push(fileDigest(args[i + 1]!));
      else if (a.startsWith('--config=')) configs.push(fileDigest(a.slice('--config='.length)));
    }
  }
  const vars: Array<[string, string]> = [];
  for (const name of Object.keys(env).sort()) {
    const up = name.toUpperCase();
    if (!up.startsWith('PLAYWRIGHT_MCP_') || up === 'PLAYWRIGHT_MCP_OUTPUT_DIR' || env[name] === undefined) continue;
    vars.push([up, env[name]!]);
    if (up === 'PLAYWRIGHT_MCP_CONFIG') configs.push(fileDigest(env[name]!));
  }
  const versions: string[] = [];
  for (const a of kept) {
    if (!path.isAbsolute(a) || !existsSync(a)) continue;
    const own = packageOf(a);
    if (own) versions.push(own);
    try {
      const core = createRequire(a).resolve('playwright-core/package.json');
      versions.push(`playwright-core@${String((JSON.parse(readFileSync(core, 'utf8')) as { version?: unknown }).version)}`);
    } catch {
      // sem playwright-core ao lado (servidor de teste): só o que já entrou
    }
  }
  return JSON.stringify({ command: path.basename(command), kept, versions, env: vars, configs });
}

interface CacheEntry {
  initialize: Json;
  tools: unknown[];
}

/** Hash curto (dois FNV-1a de 32 bits, em hexa) para o nome do arquivo: o `node:crypto` custa ~2 MB no processo que existe para ser leve. */
function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(i), 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** A chave inteira vai dentro do arquivo (`key`) e é conferida na leitura: um choque de hash vira só um cache perdido, nunca ferramentas de outro servidor. */
const cacheKeyOf = (fingerprint: string, protocolVersion: string) => `${CACHE_VERSION}\n${fingerprint}\n${protocolVersion}`;
const cacheFileOf = (dir: string, key: string) => path.join(dir, `navegador-${shortHash(key)}.json`);

/** As ferramentas do cache só valem como lista de objetos com `name` texto: o que for diferente disso vira cache perdido. */
const validTools = (v: unknown): v is Json[] => Array.isArray(v) && v.every((t) => isObject(t) && typeof t.name === 'string');

/** Igual por conteúdo, sem depender da ordem das chaves. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function readCache(file: string, key: string): CacheEntry | null {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { key?: unknown; initialize?: unknown; tools?: unknown };
    if (c.key !== key || !isObject(c.initialize) || typeof c.initialize.protocolVersion !== 'string' || !validTools(c.tools)) return null;
    return { initialize: c.initialize, tools: c.tools };
  } catch {
    return null;
  }
}

/** Melhor esforço: uma pasta sem escrita só tira o cache (o servidor de verdade abre a cada conversa que usa o navegador). Pasta 0700 e arquivo 0600 (só o dono; nada disso vale no Windows). */
function writeCache(file: string, key: string, entry: CacheEntry): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const unix = process.platform !== 'win32';
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, ...(unix && { mode: 0o700 }) });
    if (unix) chmodSync(dir, 0o700);
    writeFileSync(tmp, JSON.stringify({ key, ...entry }), unix ? { mode: 0o600 } : undefined);
    if (unix) chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // a pasta nem existe (ou é um arquivo): não há o que limpar
    }
  }
}

// ---- processos ----

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/**
 * O SIGTERM/SIGKILL no grupo do servidor (no Unix ele é líder de grupo, e o grupo pode ter sobrado mesmo com o líder morto); sem o grupo, no processo.
 * No Windows, taskkill (sempre à força), e só enquanto o processo não saiu: depois o PID pode ser de outro programa.
 */
function signalTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    if (exited(child)) return;
    return void execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  }
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // já saiu
    }
  }
}

const live = new Set<ChildProcess>();

/** Último recurso, síncrono (evento `exit` do proxy): o servidor de verdade e o que ele abriu não ficam para trás. */
function killLeftovers(): void {
  for (const c of live) signalTree(c, 'SIGKILL');
  live.clear();
}

const DEFAULT_INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: NAME, version: '1.0.0' } };

/**
 * O proxy no stdin/stdout (uma mensagem JSON por linha). Termina quando o stdin acaba, depois de matar o servidor de verdade.
 */
export async function runNavegadorProxy(o: NavegadorProxyOptions): Promise<void> {
  const input = o.input ?? process.stdin;
  const output = o.output ?? process.stdout;
  const graceMs = o.killGraceMs ?? KILL_GRACE_MS;
  const handshakeMs = o.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const idleLimit = o.idleMs ?? IDLE_MS;
  const log = o.log ?? ((line: string) => void process.stderr.write(`[${NAME}] ${line}\n`));
  output.on('error', () => {}); // o cliente já foi embora (EPIPE): não derruba o encerramento
  const write = (obj: object) => void output.write(JSON.stringify(obj) + '\n');

  /** O `params` do `initialize` do cliente: o que se repete a cada servidor de verdade aberto. */
  let clientInit: Json | null = null;
  let initResult: Json | null = null;
  let tools: unknown[] | null = null;
  let cache: { file: string; key: string } | null = null;
  /** O que o cliente recebeu do cache em disco e ainda não foi conferido com o servidor de verdade (ver `verifyCache`). */
  let served: { initialize: Json; tools: unknown[]; initChanged: boolean } | null = null;
  let closing = false;
  let state: 'idle' | 'starting' | 'live' = 'idle';
  let child: ChildProcess | null = null;
  let starting: Promise<void> | null = null;
  let lastError = '';
  let seq = 0;
  /** Quando a última mensagem passou entre o cliente e o servidor de verdade (o que o proxy responde sozinho não conta). */
  let lastActive = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  let clientReady!: () => void;
  const clientInitialized = new Promise<void>((resolve) => (clientReady = resolve));

  /** Pedidos do cliente já entregues ao servidor de verdade e sem resposta: se ele cai, cada um falha. */
  const inflight = new Map<string, unknown>();
  /** Pedidos do servidor ao cliente (roots/list…) sem resposta: só a resposta a um deles volta ao servidor (a de um servidor que já morreu, não). */
  const serverRequests = new Set<string>();
  /** Respostas esperadas pelo próprio proxy (o `initialize` repetido, o `tools/list` do cache). */
  const proxyWaiters = new Map<string, Waiter>();
  /** O que chegou enquanto o servidor de verdade abria. */
  const queue: Array<{ line: string; id?: unknown; method: string | null; cancelled?: unknown }> = [];
  /** Pedidos `initialize` do cliente à espera da resposta do servidor de verdade (sem cache): saem assim que ela chega, sem esperar o resto da abertura. */
  const initWaiting: unknown[] = [];

  function loadCache(protocolVersion: string): void {
    if (!o.cacheDir || cache) return;
    const key = cacheKeyOf(serverFingerprint(o.command, o.args), protocolVersion);
    cache = { file: cacheFileOf(o.cacheDir, key), key };
    const hit = readCache(cache.file, key);
    if (hit) {
      initResult = hit.initialize;
      tools = hit.tools;
      served = { initialize: hit.initialize, tools: hit.tools, initChanged: false };
    }
  }

  function answerInitWaiting(): void {
    for (const id of initWaiting.splice(0)) write(initResult ? reply(id, initResult) : fail(id, -32603, `${NAME}: ${lastError || 'o navegador não abriu'}`));
  }

  function ask(method: string, params: unknown): Promise<{ result?: unknown; error?: { message?: unknown } }> {
    return new Promise((resolve) => {
      const c = child;
      if (!c?.stdin) return resolve({ error: { message: lastError || 'o servidor do navegador não está aberto' } });
      const id = `${PROXY_ID}${++seq}`;
      proxyWaiters.set(idKey(id), resolve);
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function onChildLine(c: ChildProcess, line: string): void {
    if (c !== child) return;
    lastActive = Date.now();
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return void output.write(line + '\n');
    }
    if (isObject(m) && typeof m.method !== 'string' && m.id !== undefined && m.id !== null) {
      const waiter = proxyWaiters.get(idKey(m.id));
      if (waiter) {
        proxyWaiters.delete(idKey(m.id));
        return waiter(m as Parameters<Waiter>[0]);
      }
      inflight.delete(idKey(m.id));
    } else if (isObject(m) && typeof m.method === 'string' && m.id !== undefined && m.id !== null) {
      serverRequests.add(idKey(m.id));
    }
    output.write(line + '\n');
  }

  function onChildGone(c: ChildProcess, why: string): void {
    live.delete(c);
    if (c !== child) return;
    child = null;
    if (!starting) state = 'idle'; // abrindo: quem decide é o `start` (a fila falha lá)
    serverRequests.clear();
    lastError = why;
    for (const w of [...proxyWaiters.values()]) w({ error: { message: why } });
    proxyWaiters.clear();
    if (closing) return;
    // Se estava abrindo, quem falha os pedidos é o `start` (a fila); os que já foram entregues falham aqui.
    for (const id of inflight.values()) write(fail(id, -32603, `${NAME}: ${why}. O próximo pedido abre o navegador de novo.`));
    inflight.clear();
  }

  /**
   * Com o servidor de verdade aberto: confere de tempos em tempos se passou `idleLimit` sem mensagem e, se nenhum pedido do cliente espera
   * resposta (uma chamada longa mantém aberto; a pergunta do servidor que o cliente nunca respondeu, como o roots/list, não), encerra o
   * servidor. `ms` é o que falta para a próxima conferência.
   */
  function watchIdle(ms = idleLimit): void {
    clearTimeout(idleTimer);
    if (!idleLimit || closing || state !== 'live' || !child) return;
    idleTimer = setTimeout(() => {
      const c = child;
      if (!c || closing || state !== 'live') return;
      const left = lastActive + idleLimit - Date.now();
      if (left > 0) return watchIdle(left);
      if (inflight.size) return watchIdle();
      retire(c);
    }, ms);
    idleTimer.unref();
  }

  /** Larga o servidor de verdade (o próximo pedido abre outro) e o mata: SIGTERM no grupo e, passada a tolerância, SIGKILL. */
  function retire(c: ChildProcess): void {
    child = null;
    state = 'idle';
    serverRequests.clear();
    lastError = 'o servidor do navegador foi encerrado por ociosidade';
    for (const w of [...proxyWaiters.values()]) w({ error: { message: lastError } });
    proxyWaiters.clear();
    log(`ocioso há ${Math.round(idleLimit / 1000)} s: servidor do navegador encerrado (o próximo uso o abre de novo)`);
    const hard = setTimeout(() => signalTree(c, 'SIGKILL'), graceMs);
    hard.unref();
    c.once('close', () => {
      clearTimeout(hard);
      signalTree(c, 'SIGKILL'); // sobrou alguém do grupo (o `close` só espera o líder); no Windows, não faz nada com o processo que já saiu
    });
    signalTree(c, 'SIGTERM');
  }

  function spawnReal(): ChildProcess {
    const c = spawn(o.command, o.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, detached: process.platform !== 'win32' });
    child = c;
    live.add(c);
    c.stdin!.on('error', () => {});
    createInterface({ input: c.stdout!, crlfDelay: Infinity }).on('line', (line) => onChildLine(c, line));
    c.once('error', (err) => onChildGone(c, `não abriu o servidor do navegador (${err.message})`));
    c.once('close', (code, signal) => onChildGone(c, `o servidor do navegador encerrou (${signal ?? `código ${code}`})`));
    return c;
  }

  /** O `tools/list` inteiro do servidor de verdade (todas as páginas); null se ele recusou, caiu ou não terminou. */
  async function fetchTools(): Promise<unknown[] | null> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const r = await ask('tools/list', cursor ? { cursor } : {});
      if (r.error || !isObject(r.result) || !Array.isArray(r.result.tools)) return null;
      all.push(...r.result.tools);
      cursor = typeof r.result.nextCursor === 'string' ? r.result.nextCursor : undefined;
      if (!cursor) return all;
    }
    return null;
  }

  const declaresListChanged = (init: Json | null) => isObject(init?.capabilities) && isObject(init.capabilities.tools) && init.capabilities.tools.listChanged === true;

  /**
   * Com o servidor de verdade aberto pela primeira vez a partir do cache: confere o que ele diz com o que o cliente recebeu. Se o `tools/list` ou o
   * `initialize` mudaram, regrava o cache (a próxima conversa já vê o novo); e se as ferramentas mudaram, avisa o cliente com
   * `notifications/tools/list_changed`, mas só se o servidor declarou `tools.listChanged` (no que o cliente recebeu e no que o servidor diz agora).
   * Roda depois de o pedido que abriu o servidor ser entregue, sem atrasá-lo.
   */
  async function verifyCache(c: ChildProcess): Promise<void> {
    const before = served;
    if (!before || c !== child) return;
    const real = await fetchTools();
    if (!real || c !== child || closing) return; // caiu ou não respondeu: fica para a próxima abertura
    served = null;
    const toolsChanged = !sameJson(real, before.tools);
    if (toolsChanged) tools = real;
    if ((toolsChanged || before.initChanged) && cache && initResult) writeCache(cache.file, cache.key, { initialize: initResult, tools: real });
    if (toolsChanged && declaresListChanged(before.initialize) && declaresListChanged(initResult)) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  /** Abre o servidor de verdade, repete o `initialize` e o `initialized` do cliente e, sem cache, grava o `initialize` e o `tools/list`. */
  async function handshake(): Promise<void> {
    const c = spawnReal();
    // Sem resposta no prazo: quem espera recebe o erro (o `start` mata o processo).
    const timer = setTimeout(() => {
      lastError = 'o servidor do navegador não respondeu a tempo';
      for (const w of [...proxyWaiters.values()]) w({ error: { message: lastError } });
      proxyWaiters.clear();
    }, handshakeMs);
    try {
      const init = await ask('initialize', clientInit ?? DEFAULT_INIT);
      if (init.error || !isObject(init.result)) throw new Error(`o servidor do navegador recusou o initialize (${String(init.error?.message ?? lastError)})`);
      if (served && !sameJson(init.result, served.initialize)) served.initChanged = true;
      initResult = init.result;
      answerInitWaiting();
      // Sem cache o cliente pode ainda não ter terminado o dele: o servidor só deve ouvir `initialized` depois (ele pergunta roots/list ao receber).
      // (cliente que nem mandou `initialize` está fora do protocolo: não há `initialized` a esperar)
      if (clientInit) {
        let wait: NodeJS.Timeout | undefined;
        await Promise.race([clientInitialized, new Promise<void>((r) => (wait = setTimeout(r, CLIENT_INITIALIZED_WAIT_MS)))]);
        clearTimeout(wait);
      }
      if (c !== child) throw new Error(lastError);
      c.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      if (!tools) {
        const all = await fetchTools();
        if (all) {
          tools = all;
          if (cache && initResult) writeCache(cache.file, cache.key, { initialize: initResult, tools: all });
        }
        if (c !== child) throw new Error(lastError);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function start(): Promise<void> {
    if (starting) return starting;
    state = 'starting';
    starting = (async () => {
      try {
        await handshake();
        state = 'live';
        lastActive = Date.now();
        watchIdle();
        // Os pedidos que esperavam entram na ordem em que chegaram (o tools/list, do que acabou de ser gravado: o servidor já o disse).
        const opened = child;
        for (const q of queue.splice(0)) {
          if (q.method === 'tools/list' && q.id !== undefined && tools) write(reply(q.id, { tools }));
          else {
            if (q.cancelled !== undefined) inflight.delete(idKey(q.cancelled));
            deliver(q.line, q.id);
          }
        }
        if (opened) void verifyCache(opened).catch(() => {});
      } catch (err) {
        const why = err instanceof Error ? err.message : lastError;
        log(why);
        const dead = child;
        child = null;
        state = 'idle';
        serverRequests.clear(); // o `onChildGone` do que acabou de cair sai antes de chegar aqui (`c !== child`)
        if (dead) signalTree(dead, 'SIGKILL');
        answerInitWaiting();
        for (const q of queue.splice(0)) if (q.id !== undefined) write(fail(q.id, -32603, `${NAME}: ${why}`));
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  /** Entrega a linha do cliente ao servidor de verdade (que está aberto). `id` é o do pedido, se for um. */
  function deliver(line: string, id?: unknown): void {
    if (!child) return; // caiu entre a fila e agora: o pedido já falhou ou falha em `onChildGone`
    lastActive = Date.now();
    if (id !== undefined) inflight.set(idKey(id), id);
    child.stdin!.write(line + '\n');
  }

  function answerInitialize(id: unknown): void {
    if (initResult) return write(reply(id, initResult));
    // Sem cache: abre o servidor de verdade; o cliente recebe a resposta dele ao initialize (que também é gravada) e só então manda o `initialized`.
    initWaiting.push(id);
    void start();
  }

  function onClientLine(raw: string): void {
    const line = raw.replace(/^﻿/, ''); // BOM (pipe do PowerShell 5.1)
    if (!line.trim()) return;
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return state === 'live' ? deliver(line) : write(fail(null, -32700, 'Parse error'));
    }
    if (!isObject(m)) return state === 'live' ? deliver(line) : write(fail(null, -32600, 'Invalid Request'));
    const method = typeof m.method === 'string' ? m.method : null;
    const isRequest = method !== null && m.id !== undefined && m.id !== null;

    // O proxy fala sozinho com o cliente: o servidor de verdade recebe o `initialize` e o `initialized` repetidos por ele (ver `handshake`).
    if (method === 'notifications/initialized') return clientReady();
    if (method === 'initialize' && isRequest) {
      if (!clientInit) clientInit = isObject(m.params) ? m.params : {};
      loadCache(typeof clientInit.protocolVersion === 'string' ? clientInit.protocolVersion : DEFAULT_INIT.protocolVersion);
      return answerInitialize(m.id);
    }
    if (method === 'ping' && isRequest) return write(reply(m.id, {}));
    // A sonda do Claude Code antes do `initialize`: o Playwright responde -32601 (e o cliente cai para o `initialize`); o proxy responde igual, sem abri-lo.
    if (method === 'server/discover' && isRequest && state !== 'live') return write(fail(m.id, -32601, 'Method not found'));
    if (method === 'tools/list' && isRequest && tools && state !== 'live') return write(reply(m.id, { tools }));

    if (method === null) {
      // Resposta do cliente a um pedido do servidor: só vai se ele a pediu (o servidor pode estar abrindo ou ter morrido).
      if (m.id !== undefined && m.id !== null && child && serverRequests.delete(idKey(m.id))) child.stdin!.write(line + '\n');
      return;
    }
    // O cliente desistiu do pedido: se o servidor cair, ninguém espera o erro dele.
    const cancelled = method === 'notifications/cancelled' && isObject(m.params) ? m.params.requestId : undefined;
    if (state === 'live') {
      if (cancelled !== undefined) inflight.delete(idKey(cancelled));
      return deliver(line, isRequest ? m.id : undefined);
    }
    if (!isRequest && state === 'idle') return; // notificação sem servidor aberto (cancelled, roots/list_changed): ninguém a recebe, e a abertura já refaz roots
    queue.push({ line, method, ...(isRequest && { id: m.id }), ...(cancelled !== undefined && { cancelled }) });
    void start();
  }

  // Sem `initialize` nem cache ainda (cliente fora do protocolo): o primeiro pedido abre o servidor com o `initialize` padrão.
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', onClientLine);
  let signaled = false;
  const onSignal = () => {
    if (signaled) process.exit(1); // segunda vez: sem esperar (o evento `exit` mata o que sobrou)
    signaled = true;
    rl.close();
  };
  const STOP = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  if (o.handleSignals) {
    for (const sig of STOP) process.on(sig, onSignal);
    process.on('exit', killLeftovers);
  }
  await new Promise<void>((resolve) => rl.once('close', resolve));
  // Fim do stdin ou sinal: ninguém mais espera resposta. O servidor de verdade morre (grupo todo) antes de o proxy sair.
  closing = true;
  clearTimeout(idleTimer);
  const c = child as ChildProcess | null;
  if (c) {
    await new Promise<void>((resolve) => {
      if (c.exitCode !== null || c.signalCode !== null) return resolve();
      const hard = setTimeout(() => signalTree(c, 'SIGKILL'), graceMs);
      const giveUp = setTimeout(resolve, graceMs + 1_000);
      c.once('close', () => {
        clearTimeout(hard);
        clearTimeout(giveUp);
        resolve();
      });
      signalTree(c, 'SIGTERM');
    });
    signalTree(c, 'SIGKILL'); // sobrou alguém do grupo (o `close` só espera o líder): sem erro se não sobrou. No Windows, não faz nada com o processo que já saiu
  }
  if (o.handleSignals) for (const sig of STOP) process.off(sig, onSignal);
}

// ---- como o funcionário sobe este proxy ----

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts pelo tsx. */
export function navegadorProxyCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(NAVEGADOR_BUNDLE)) return { command: process.execPath, args: [NAVEGADOR_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, NAVEGADOR_ENTRY] };
}

/** O comando do MCP do navegador limpo: o proxy, com o cache em `cacheDir` e, depois de `--`, o servidor de verdade (mesmos argumentos, sem tirar nem pôr). */
export function lazyNavegadorCommand(real: { command: string; args: string[] }, cacheDir: string, bundled?: boolean): { command: string; args: string[] } {
  const proxy = navegadorProxyCommand(bundled);
  return { command: proxy.command, args: [...proxy.args, '--cache-dir', cacheDir, '--', real.command, ...real.args] };
}

/** Lê os argumentos da entrada: `[--cache-dir <pasta>] -- <comando> <argumentos…>`. */
export function parseProxyArgs(argv: string[]): { command: string; args: string[]; cacheDir?: string } {
  const sep = argv.indexOf('--');
  if (sep < 0 || !argv[sep + 1]) throw new Error('uso: [--cache-dir <pasta>] -- <comando> [argumentos…]');
  const head = argv.slice(0, sep);
  const at = head.indexOf('--cache-dir');
  const cacheDir = at >= 0 ? head[at + 1] : undefined;
  return { command: argv[sep + 1]!, args: argv.slice(sep + 2), ...(cacheDir && { cacheDir }) };
}
