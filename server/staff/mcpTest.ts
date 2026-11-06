import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// Teste de um MCP da biblioteca: initialize + tools/list, e nada além disso (não chama ferramenta nenhuma).
// http/sse: HTTP streamable (POST com JSON ou SSE na resposta). O SSE antigo (evento `endpoint` numa
// conexão GET aberta) não é testado: sai com erro claro. stdio: spawn sem shell, JSON por linha, e o
// processo morre no fim. Tempo limite total de ~15 s; uma nova tentativa, com espera curta e jitter, só
// quando a falha é de rede. Nunca loga o config: as mensagens de erro não trazem valor nem URL.

export interface McpTestResult {
  ok: boolean;
  tools: string[];
  error?: string;
}

export interface McpTestOptions {
  /** Pasta onde o processo stdio roda (a do projeto). */
  cwd?: string;
  /** Tempo total (padrão 15 s). */
  timeoutMs?: number;
  /** Espera antes da nova tentativa (padrão 400 ms, com jitter). */
  retryWaitMs?: number;
  /** Troca o fetch (os testes usam um que falha uma vez). */
  fetchImpl?: typeof fetch;
}

const PROTOCOL = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

class TestFail extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const short = (v: unknown) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').slice(0, 200) : 'erro sem detalhe');

/** `${VAR}` e `${VAR:-padrão}`, como o Claude Code faz no config. Variável ausente sem padrão = erro (só o nome). */
export function expandVars(text: string): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def: string | undefined) => {
    const v = process.env[name];
    if (v !== undefined) return v;
    if (def !== undefined) return def;
    throw new TestFail(`a variável ${name} não está no ambiente do Claudio’s Club`);
  });
}

export async function testMcpConfig(cfg: Obj, o: McpTestOptions = {}): Promise<McpTestResult> {
  const budget = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new TestFail(`o servidor não respondeu em ${Math.round(budget / 1000)} s`);
    return ms;
  };
  try {
    const tools = cfg.type === 'stdio' ? await testStdio(cfg, o, left, budget) : cfg.type === 'http' || cfg.type === 'sse' ? await testHttp(cfg, o, left) : fail('tipo de servidor desconhecido');
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, tools: [], error: messageOf(err) };
  }
}

function fail(msg: string): never {
  throw new TestFail(msg);
}

function messageOf(err: unknown): string {
  if (err instanceof TestFail) return err.message;
  const name = (err as { name?: unknown } | null)?.name;
  // AbortSignal.timeout do fetch: o servidor não respondeu a tempo.
  if (name === 'TimeoutError' || name === 'AbortError') return 'o servidor não respondeu a tempo';
  if (isNetworkError(err)) return 'não consegui conectar ao servidor: confira a URL e a rede';
  return 'falha inesperada no teste';
}

const names = (tools: unknown): string[] =>
  Array.isArray(tools) ? tools.map((t) => (isObj(t) ? str(t.name) : undefined)).filter((n): n is string => !!n) : [];

const rpc = (method: string, id?: number, params?: Obj) => ({ jsonrpc: '2.0', ...(id !== undefined && { id }), method, ...(params && { params }) });
const initMsg = () => rpc('initialize', 1, { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Claudio’s Club', version: '1.0.0' } });

// ---- HTTP (streamable) ----

const isNetworkError = (err: unknown): boolean => {
  if (err instanceof TypeError) return true; // fetch failed
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return (typeof e?.code === 'string' && NETWORK_CODES.has(e.code)) || (typeof e?.cause?.code === 'string' && NETWORK_CODES.has(e.cause.code));
};

async function withRetry<T>(fn: () => Promise<T>, o: McpTestOptions, left: () => number): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isNetworkError(err)) throw err;
    const wait = (o.retryWaitMs ?? 400) * (0.5 + Math.random() / 2);
    if (left() <= wait + 1000) throw err; // sem tempo para outra tentativa
    await new Promise((r) => setTimeout(r, wait));
    return fn();
  }
}

async function testHttp(cfg: Obj, o: McpTestOptions, left: () => number): Promise<string[]> {
  const raw = str(cfg.url);
  if (!raw) fail('informe a URL');
  const url = expandVars(raw);
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) fail('URL inválida (use http:// ou https://)');
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(isObj(cfg.headers) ? cfg.headers : {})) if (typeof v === 'string') extra[k] = expandVars(v);
  const fetchFn = o.fetchImpl ?? fetch;
  const httpType = cfg.type;

  const call = (body: Obj, session?: string, protocol?: string): Promise<Response> =>
    withRetry(
      () =>
        fetchFn(url, {
          method: 'POST',
          headers: {
            ...extra,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(session ? { 'mcp-session-id': session } : {}),
            ...(protocol ? { 'mcp-protocol-version': protocol } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(left()),
        }),
      o,
      left,
    );
  const bad = (res: Response) => {
    if (res.status === 401 || res.status === 403) return fail(`o servidor recusou a autenticação (HTTP ${res.status}): confira o token ou o cabeçalho`);
    if (res.status === 404 || res.status === 405) {
      return fail(`o servidor não aceita HTTP streamable (HTTP ${res.status})${httpType === 'sse' ? ': o SSE antigo ainda não é testado aqui; confira a URL' : ': confira a URL'}`);
    }
    return fail(`o servidor respondeu HTTP ${res.status}`);
  };

  const init = await call(initMsg());
  if (!init.ok) bad(init);
  const session = init.headers.get('mcp-session-id') ?? undefined;
  const initResult = await rpcResult(init, 1);
  const protocol = str(initResult.protocolVersion);
  await drain(await call(rpc('notifications/initialized'), session, protocol));

  const tools: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const id = 2 + page;
    const res = await call(rpc('tools/list', id, cursor ? { cursor } : {}), session, protocol);
    if (!res.ok) bad(res);
    const result = await rpcResult(res, id);
    tools.push(...names(result.tools));
    cursor = str(result.nextCursor);
    if (!cursor) break;
  }
  return tools;
}

async function drain(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/** O resultado da resposta com o id pedido (JSON ou SSE). Erro do servidor vira TestFail sem o detalhe cru. */
async function rpcResult(res: Response, id: number): Promise<Obj> {
  const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  const msg = isSse ? await sseMessage(res, id) : jsonMessage(await res.text(), id);
  if (isObj(msg.error)) fail(`o servidor recusou: ${short(msg.error.message)}`);
  if (!isObj(msg.result)) fail('resposta do servidor sem resultado');
  return msg.result;
}

function jsonMessage(text: string, id: number): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('resposta do servidor não é JSON');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const hit = list.find((m): m is Obj => isObj(m) && m.id === id);
  if (!hit) fail('resposta do servidor sem o id esperado');
  return hit;
}

/** Lê o SSE até achar a mensagem com o id; o servidor costuma deixar o stream aberto. */
async function sseMessage(res: Response, id: number): Promise<Obj> {
  if (!res.body) fail('resposta vazia do servidor');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: !done });
      buf = buf.replace(/\r\n?/g, '\n');
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        if (isObj(msg) && msg.id === id) return msg;
      }
      if (done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  fail('o servidor fechou o stream sem responder');
}

// ---- stdio ----

function testStdio(cfg: Obj, o: McpTestOptions, left: () => number, budget: number): Promise<string[]> {
  const rawCommand = str(cfg.command);
  if (!rawCommand?.trim()) return Promise.reject(new TestFail('informe o comando'));
  let command: string;
  let args: string[];
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    command = expandVars(rawCommand);
    args = strs(cfg.args).map(expandVars);
    for (const [k, v] of Object.entries(isObj(cfg.env) ? cfg.env : {})) if (typeof v === 'string') env[k] = expandVars(v);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise<string[]>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd: o.cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return reject(new TestFail('não consegui iniciar o comando'));
    }
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    const finish = (err: TestFail | null, tools: string[] = []) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      rl?.close();
      killTree(child);
      if (err) reject(err);
      else resolve(tools);
    };
    try {
      timer = setTimeout(() => finish(new TestFail(`o servidor não respondeu em ${Math.round(budget / 1000)} s`)), left());
    } catch (err) {
      return finish(err as TestFail);
    }

    const send = (m: Obj) => child.stdin?.write(JSON.stringify(m) + '\n');
    child.stdin?.on('error', () => {});
    child.stderr?.resume(); // o que o processo escreve no erro pode trazer valor: não guardamos
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(
        new TestFail(
          err.code === 'ENOENT'
            ? `não achei o comando ${command}${process.platform === 'win32' ? ' (no Windows, use o caminho completo do programa, ex.: node.exe)' : ''}`
            : 'não consegui iniciar o comando',
        ),
      ),
    );
    child.on('exit', (code) => finish(new TestFail(`o processo saiu (código ${code ?? '?'}) antes de responder`)));

    rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    const tools: string[] = [];
    let page = 2;
    rl.on('line', (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // linha que não é JSON (log no stdout): ignora
      }
      if (!isObj(msg) || typeof msg.id !== 'number') return;
      if (msg.id === 1) {
        if (isObj(msg.error)) return finish(new TestFail(`o servidor recusou: ${short(msg.error.message)}`));
        send(rpc('notifications/initialized'));
        send(rpc('tools/list', page, {}));
        return;
      }
      if (msg.id !== page) return;
      if (isObj(msg.error)) return finish(new TestFail(`o servidor recusou a lista: ${short(msg.error.message)}`));
      const result = isObj(msg.result) ? msg.result : {};
      tools.push(...names(result.tools));
      const cursor = str(result.nextCursor);
      if (cursor && page < MAX_PAGES + 1) {
        page++;
        send(rpc('tools/list', page, { cursor }));
      } else {
        finish(null, tools);
      }
    });
    send(initMsg());
  });
}

/** Mata o processo (e, no Windows, a árvore: o npx sobe um node filho). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  }
  child.kill();
}
