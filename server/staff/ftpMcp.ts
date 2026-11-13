import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { FTP_MCP_NAME, type FtpConnection } from '../../shared/model';
import { isSecretFileRel } from '../projectFiles';
import { ROOT } from '../root';
import { DEFAULT_SECRETS_DIR, getSecret, type VaultOptions } from '../secretVault';
import {
  basicFtpConnector,
  connectWithRetry,
  explainFtpError,
  FtpBreaker,
  FtpError,
  ftpSecretId,
  readFtpConnections,
  resolveRemote,
  type FtpConnector,
  type FtpSession,
} from './ftp';
import { staffDir } from './store';

// MCP do Claudio’s Club para FTP: um servidor stdio (JSON-RPC por linha) que o Claude Code do funcionário
// sobe só quando a ficha dele autoriza alguma conexão FTP. Recebe o projeto, a pasta da sessão e os
// nomes autorizados (nunca a senha); a senha ele mesmo tira do cofre, a cada chamada, e ela nunca sai
// daqui (as mensagens de erro passam por scrub). Cada chamada abre e fecha a conexão.
//
// Sem o SDK oficial de propósito: para stdio ele traria express, hono, cors, jose e ajv. O protocolo
// usado aqui é pequeno: initialize, ping, tools/list e tools/call.

export { FTP_MCP_NAME };
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LIST = 500;

export interface FtpMcpOptions {
  projectPath: string;
  /** Pasta da sessão (o projeto ou a worktree): os caminhos locais ficam presos a ela. */
  root: string;
  /** A ficha é relida a cada chamada: tirar a conexão da ficha corta o acesso na hora. null = sem ficha. */
  staffId: string | null;
  /** Conexões que a ficha autorizava quando a sessão abriu. */
  allowed: string[];
  vault?: VaultOptions;
  connect?: FtpConnector;
  /** Inatividade do socket (padrão 30 s). */
  timeoutMs?: number;
  maxBytes?: number;
  breaker?: FtpBreaker;
}

// ---- ferramentas ----

const conn = z.string({ error: (iss) => (iss.input === undefined ? 'informe a conexão' : undefined) });
const flag = z.boolean().optional().default(false);
const Schemas = {
  ftp_list: z.object({ connection: conn, path: z.string().optional() }),
  ftp_download: z.object({ connection: conn, remote: z.string(), local: z.string(), overwrite: flag }),
  ftp_upload: z.object({ connection: conn, local: z.string(), remote: z.string(), overwrite: flag }),
  ftp_delete: z.object({ connection: conn, path: z.string(), directory: flag }),
  ftp_rename: z.object({ connection: conn, from: z.string(), to: z.string() }),
  ftp_mkdir: z.object({ connection: conn, path: z.string() }),
};
type ToolName = keyof typeof Schemas;

const C = { type: 'string', description: 'Nome da conexão FTP da sua ficha.' };
const R = (d: string) => ({ type: 'string', description: `${d} Relativo à pasta da conexão (ou absoluto dentro dela).` });
const L = (d: string) => ({ type: 'string', description: `${d} Relativo à pasta do projeto.` });
const O = (d: string) => ({ type: 'boolean', description: d, default: false });

export const TOOLS: Array<{ name: ToolName; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'ftp_list',
    description: 'Lista uma pasta no servidor FTP (até 500 itens).',
    inputSchema: { type: 'object', properties: { connection: C, path: R('Pasta; vazio = a pasta da conexão.') }, required: ['connection'] },
  },
  {
    name: 'ftp_download',
    description: `Baixa um arquivo do servidor para o projeto (até ${MAX_TRANSFER_BYTES / 1024 / 1024} MB).`,
    inputSchema: {
      type: 'object',
      properties: { connection: C, remote: R('Arquivo no servidor.'), local: L('Onde gravar.'), overwrite: O('Substituir se o arquivo local já existe.') },
      required: ['connection', 'remote', 'local'],
    },
  },
  {
    name: 'ftp_upload',
    description: `Envia um arquivo do projeto para o servidor (até ${MAX_TRANSFER_BYTES / 1024 / 1024} MB). Antes de substituir, baixe uma cópia do que está lá.`,
    inputSchema: {
      type: 'object',
      properties: { connection: C, local: L('Arquivo a enviar.'), remote: R('Destino no servidor (a pasta tem de existir).'), overwrite: O('Substituir se já existe no servidor.') },
      required: ['connection', 'local', 'remote'],
    },
  },
  {
    name: 'ftp_delete',
    description: 'Apaga um arquivo no servidor, ou uma pasta vazia (directory: true).',
    inputSchema: { type: 'object', properties: { connection: C, path: R('O que apagar.'), directory: O('É uma pasta (vazia).') }, required: ['connection', 'path'] },
  },
  {
    name: 'ftp_rename',
    description: 'Renomeia ou move um arquivo/pasta no servidor.',
    inputSchema: { type: 'object', properties: { connection: C, from: R('Caminho atual.'), to: R('Caminho novo.') }, required: ['connection', 'from', 'to'] },
  },
  {
    name: 'ftp_mkdir',
    description: 'Cria uma pasta no servidor (e as que faltarem até ela).',
    inputSchema: { type: 'object', properties: { connection: C, path: R('Pasta a criar.') }, required: ['connection', 'path'] },
  },
];

// ---- caminho local ----

const BAD_SEGMENT = /[<>:"|?*\u0000-\u001f]/;
const PROTECTED_DIRS = new Set(['.myco', '.claude']);

/** Segredo (critério da aba de arquivos) ou pasta do Claudio’s Club/Claude Code (fichas, permissões). */
export function isProtectedLocalRel(rel: string): boolean {
  if (rel.split('/').some((p) => PROTECTED_DIRS.has(p.toLowerCase()))) return true;
  return isSecretFileRel(rel);
}

const inside = (base: string, target: string) => {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const relOf = (base: string, abs: string) => path.relative(base, abs).split(path.sep).filter(Boolean).join('/');

/**
 * Caminho local dentro de `root`, conferido pelo caminho pedido e pelo real (links seguidos). Para gravar,
 * cria as pastas que faltam (depois de conferir as que existem). Devolve o caminho real.
 */
export async function resolveLocal(
  root: string,
  raw: unknown,
  mode: 'read' | 'write',
  o: { overwrite?: boolean; maxBytes?: number; secretsDir?: string } = {},
): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new FtpError('informe o caminho local');
  if (raw.includes('\0')) throw new FtpError('caminho local inválido');
  const abs = path.resolve(root, raw.trim());
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new FtpError('caminho local fora da pasta do projeto');
  const parts = rel.split(path.sep);
  for (const p of parts) {
    if (BAD_SEGMENT.test(p) || /[. ]$/.test(p)) throw new FtpError(`nome local inválido: "${p.slice(0, 80)}"`);
  }
  const protectedMsg = 'caminho protegido (segredo, .git, .vps, .myco ou .claude): não passa pelo FTP';
  if (isProtectedLocalRel(parts.join('/'))) throw new FtpError(protectedMsg);
  const realRoot = await fs.realpath(root);
  const secrets = await fs.realpath(o.secretsDir ?? DEFAULT_SECRETS_DIR).catch(() => null);
  const check = (real: string) => {
    if (!inside(realRoot, real)) throw new FtpError('o caminho local sai do projeto (link simbólico)');
    if (isProtectedLocalRel(relOf(realRoot, real)) || (secrets && inside(secrets, real))) throw new FtpError(protectedMsg);
  };
  const max = o.maxBytes ?? MAX_TRANSFER_BYTES;

  if (mode === 'read') {
    const real = await fs.realpath(abs).catch(() => {
      throw new FtpError('arquivo local não encontrado');
    });
    check(real);
    const st = await fs.stat(real);
    if (!st.isFile()) throw new FtpError('o caminho local não é um arquivo');
    if (st.size > max) throw new FtpError(`arquivo grande demais (máx. ${Math.round(max / 1024 / 1024)} MB)`);
    return real;
  }

  // Sobe até o primeiro pedaço que existe; ele (com os links seguidos) tem de estar dentro.
  let cur = path.dirname(abs);
  const missing: string[] = [];
  let realParent: string;
  for (;;) {
    try {
      realParent = await fs.realpath(cur);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      missing.unshift(path.basename(cur));
      cur = path.dirname(cur);
    }
  }
  check(realParent);
  if (!(await fs.stat(realParent)).isDirectory()) throw new FtpError('um pedaço do caminho local é arquivo, não pasta');
  const dir = path.join(realParent, ...missing);
  if (missing.length) await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, path.basename(abs));
  check(target);
  const st = await fs.lstat(target).catch(() => null);
  if (st) {
    if (st.isSymbolicLink()) throw new FtpError('o destino local é um link: não é substituído');
    if (!st.isFile()) throw new FtpError('o destino local é uma pasta');
    if (!o.overwrite) throw new FtpError('o arquivo local já existe: use overwrite: true para substituir');
  }
  return target;
}

/** Grava o que chega do servidor num arquivo, parando no limite de tamanho. */
class LimitedFile extends Writable {
  bytes = 0;
  constructor(
    private readonly fh: FileHandle,
    private readonly max: number,
  ) {
    super();
  }
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) return cb(new FtpError(`arquivo grande demais (máx. ${Math.round(this.max / 1024 / 1024)} MB)`));
    this.fh.write(chunk).then(() => cb(), cb);
  }
}

const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// ---- servidor ----

export function createFtpMcp(opts: FtpMcpOptions) {
  const connect = opts.connect ?? basicFtpConnector;
  const breaker = opts.breaker ?? new FtpBreaker();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? MAX_TRANSFER_BYTES;
  const secretsDir = opts.vault?.dir;

  /** As conexões que a ficha autoriza agora (falha ao ler = nenhuma). */
  async function fichaServers(): Promise<string[] | null> {
    if (!opts.staffId) return null;
    if (!/^[a-z0-9-]{1,40}$/.test(opts.staffId)) return [];
    const raw = await fs.readFile(path.join(staffDir(opts.projectPath), `${opts.staffId}.json`), 'utf8').catch(() => null);
    try {
      const servers = (JSON.parse((raw ?? '').replace(/^﻿/, '')) as { servers?: unknown }).servers;
      return Array.isArray(servers) ? servers.filter((s): s is string => typeof s === 'string') : [];
    } catch {
      return [];
    }
  }

  async function authorize(name: string): Promise<{ conn: FtpConnection; password: string }> {
    const list = opts.allowed.length ? opts.allowed.join(', ') : 'nenhuma';
    if (!opts.allowed.includes(name)) throw new FtpError(`a conexão "${name.slice(0, 60)}" não está autorizada na sua ficha (autorizadas: ${list})`);
    const now = await fichaServers();
    if (now && !now.includes(name)) throw new FtpError(`a conexão ${name} saiu da sua ficha: não use mais`);
    const conn = (await readFtpConnections(opts.projectPath, opts.vault)).find((c) => c.name === name);
    if (!conn) throw new FtpError(`a conexão ${name} não existe mais no projeto: avise o usuário`);
    const password = await getSecret(ftpSecretId(opts.projectPath, name), opts.vault).catch(() => null);
    if (!password) throw new FtpError(`a conexão ${name} está sem senha no cofre: avise o usuário (não peça a senha)`);
    return { conn, password };
  }

  async function withSession<T>(name: string, fn: (s: FtpSession, conn: FtpConnection, base: string) => Promise<T>): Promise<T> {
    const { conn, password } = await authorize(name);
    breaker.check(name);
    let s: FtpSession;
    try {
      s = await connectWithRetry(connect, conn, password, timeoutMs);
      breaker.ok(name);
    } catch (err) {
      breaker.fail(name);
      throw new FtpError(explainFtpError(err, conn, password));
    }
    try {
      const base = conn.remoteRoot ?? (await s.pwd());
      return await fn(s, conn, base);
    } catch (err) {
      throw new FtpError(explainFtpError(err, conn, password));
    } finally {
      s.close();
    }
  }

  const remote = (conn: FtpConnection, base: string, raw: unknown) => resolveRemote(conn.remoteRoot, base, raw);
  const notRoot = (conn: FtpConnection, p: string) => {
    if (p === '/' || p === conn.remoteRoot) throw new FtpError('isso é a pasta da conexão inteira: não é apagado nem movido');
  };

  /** Existe no servidor? Pela listagem da pasta (SIZE não vale para pasta e nem todo servidor tem). */
  async function remoteEntry(s: FtpSession, file: string) {
    const parent = path.posix.dirname(file);
    const entries = await s.list(parent).catch(() => {
      throw new FtpError(`a pasta remota ${parent} não existe: crie com ftp_mkdir`);
    });
    return entries.find((e) => e.name === path.posix.basename(file)) ?? null;
  }

  const handlers: { [K in ToolName]: (a: z.infer<(typeof Schemas)[K]>) => Promise<string> } = {
    ftp_list: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const dir = a.path?.trim() ? remote(conn, base, a.path) : base;
        const entries = await s.list(dir);
        const lines = entries.slice(0, MAX_LIST).map((e) => `${e.type === 'dir' ? 'd' : e.type === 'link' ? 'l' : e.type === 'file' ? 'f' : '?'}  ${e.type === 'dir' ? '-' : fmtSize(e.size)}  ${e.modifiedAt ?? '-'}  ${e.name}${e.type === 'dir' ? '/' : ''}`);
        const more = entries.length > MAX_LIST ? `\n… e mais ${entries.length - MAX_LIST} itens` : '';
        return `${a.connection}:${dir} (${entries.length} itens)\n${lines.join('\n')}${more}`;
      }),

    ftp_download: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const from = remote(conn, base, a.remote);
        const size = await s.size(from).catch(() => null);
        if (size !== null && size > maxBytes) throw new FtpError(`arquivo grande demais (${fmtSize(size)}; máx. ${fmtSize(maxBytes)})`);
        const target = await resolveLocal(opts.root, a.local, 'write', { overwrite: a.overwrite, maxBytes, secretsDir });
        const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.part`);
        const fh = await fs.open(tmp, 'wx');
        const sink = new LimitedFile(fh, maxBytes);
        try {
          await s.download(from, sink);
          await fh.close();
          await fs.rename(tmp, target);
        } catch (err) {
          await fh.close().catch(() => {});
          await fs.rm(tmp, { force: true }).catch(() => {});
          throw err;
        }
        return `baixado ${a.connection}:${from} → ${relOf(await fs.realpath(opts.root), target)} (${fmtSize(sink.bytes)})`;
      }),

    ftp_upload: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const local = await resolveLocal(opts.root, a.local, 'read', { maxBytes, secretsDir });
        const to = remote(conn, base, a.remote);
        notRoot(conn, to);
        const existing = await remoteEntry(s, to);
        if (existing?.type === 'dir') throw new FtpError('o destino no servidor é uma pasta: informe o caminho do arquivo');
        if (existing && !a.overwrite) throw new FtpError('o arquivo já existe no servidor: baixe uma cópia antes e use overwrite: true para substituir');
        const { size } = await fs.stat(local);
        await s.upload(createReadStream(local), to);
        return `enviado ${a.local} → ${a.connection}:${to} (${fmtSize(size)})${existing ? ', substituiu o anterior' : ''}`;
      }),

    ftp_delete: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const p = remote(conn, base, a.path);
        notRoot(conn, p);
        if (a.directory) await s.removeDir(p);
        else await s.remove(p);
        return `apagado ${a.connection}:${p}${a.directory ? ' (pasta)' : ''}`;
      }),

    ftp_rename: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const from = remote(conn, base, a.from);
        const to = remote(conn, base, a.to);
        notRoot(conn, from);
        notRoot(conn, to);
        await s.rename(from, to);
        return `renomeado ${a.connection}:${from} → ${to}`;
      }),

    ftp_mkdir: (a) =>
      withSession(a.connection, async (s, conn, base) => {
        const p = remote(conn, base, a.path);
        await s.mkdir(p);
        return `pasta criada: ${a.connection}:${p}`;
      }),
  };

  async function callTool(name: unknown, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    const schema = Schemas[name as ToolName];
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) return text(`argumentos inválidos: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ')}`, true);
    try {
      return text(await (handlers[name as ToolName] as (a: unknown) => Promise<string>)(parsed.data));
    } catch (err) {
      // Erro nosso já vem em palavras; o resto, sem detalhe (pode ter caminho interno).
      return text(err instanceof FtpError ? err.message : 'falha inesperada no MCP de FTP', true);
    }
  }

  type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /** Uma mensagem JSON-RPC; devolve a resposta, ou null (notificação, ou resposta do cliente). */
  async function handle(raw: unknown): Promise<object | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(null, -32600, 'Invalid Request');
    const m = raw as Msg;
    if (!('method' in m) && ('result' in m || 'error' in m)) return null; // resposta do cliente: este servidor não pergunta nada
    const isRequest = 'id' in m && m.id !== null && (typeof m.id === 'string' || typeof m.id === 'number');
    if (typeof m.method !== 'string') return isRequest ? fail(m.id, -32600, 'Invalid Request') : null;
    if (!isRequest) return null; // notifications/initialized, cancelled…
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: FTP_MCP_NAME, version: VERSION },
          instructions:
            'Acesso FTP do Claudio’s Club às conexões da sua ficha. A senha fica no cofre: nunca peça, procure ou use outro cliente FTP. Caminho local relativo ao projeto; remoto preso à pasta da conexão.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string' || !(name in Schemas)) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        return reply(m.id, await callTool(name, m.params?.arguments));
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  return { handle, callTool };
}

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr. */
export async function runFtpMcpStdio(argv: string[], input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const projectPath = argOf(argv, '--project');
  const root = argOf(argv, '--root') ?? projectPath;
  if (!projectPath || !path.isAbsolute(projectPath) || !root || !path.isAbsolute(root)) throw new Error('uso: --project <pasta absoluta> [--root <pasta>] [--staff <id>] --connections a,b');
  const vaultDir = argOf(argv, '--vault');
  const server = createFtpMcp({
    projectPath,
    root,
    staffId: argOf(argv, '--staff') ?? null,
    allowed: (argOf(argv, '--connections') ?? '').split(',').filter((n) => /^[A-Za-z0-9][\w.-]{0,39}$/.test(n)),
    ...(vaultDir && { vault: { dir: vaultDir } }),
  });
  const pending = new Set<Promise<void>>();
  const write = (obj: object | null) => {
    if (obj) output.write(JSON.stringify(obj) + '\n');
  };
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const raw of lines) {
    const line = raw.replace(/^﻿/, ''); // BOM (pipe do PowerShell 5.1)
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Em paralelo: uma transferência longa não segura o ping.
    const p = server.handle(msg).then(write, (err: unknown) => {
      process.stderr.write(`[myco-ftp] ${err instanceof Error ? err.name : 'erro'}\n`);
      const id = (msg as { id?: unknown })?.id;
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}

// ---- como o funcionário sobe este MCP ----

/** Pacote gerado pelo build (scripts/bundle.ts); sem ele (dev), o .ts pelo tsx. */
export const FTP_MCP_BUNDLE = path.join(ROOT, 'dist', 'ftp-mcp.mjs');
export const FTP_MCP_ENTRY = path.join(ROOT, 'server', 'ftp-mcp.ts');

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts com o tsx. */
export function ftpMcpCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(FTP_MCP_BUNDLE)) return { command: process.execPath, args: [FTP_MCP_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, FTP_MCP_ENTRY] };
}

/** A entrada do mcpConfig (só nomes e caminhos: a senha nunca entra aqui). */
export function ftpMcpServerConfig(o: { projectPath: string; root: string; staffId: string; connections: string[]; vaultDir?: string }) {
  const { command, args } = ftpMcpCommand();
  return {
    type: 'stdio',
    command,
    args: [
      ...args,
      '--project',
      o.projectPath,
      '--root',
      o.root,
      '--staff',
      o.staffId,
      '--connections',
      o.connections.join(','),
      ...(o.vaultDir ? ['--vault', o.vaultDir] : []),
    ],
  };
}
