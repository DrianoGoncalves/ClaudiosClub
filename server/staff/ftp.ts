import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { Client, FileType, type FileInfo } from 'basic-ftp';
import { z } from 'zod';
import type { FtpConnection, ServerInfo } from '../../shared/model';
import { pathKey } from '../adapters/claude/paths';
import { tryJson } from '../adapters/claude/fsutil';
import { deleteSecret, getSecret, hasSecret, moveSecret, setSecret, VaultError, type VaultOptions } from '../secretVault';
import { ConnectionInput, ensureVpsGitignore, readConnections, vpsDir } from './servers';
import { StaffError, writeAtomic } from './store';

// Conexões FTP de cada projeto: `<projeto>/.vps/ftp.json`, ao lado do config.json da skill vps, mas em
// arquivo próprio: a skill trata toda entrada do config.json como SSH (tentaria scp numa conexão FTP), e o
// ssh_config é gerado de lá. A pasta já fica fora do git e bloqueada para os funcionários. A senha nunca
// entra no arquivo: vai para o cofre (server/secretVault.ts), e nenhuma rota a devolve.
//
// FTPS (TLS explícito, AUTH TLS) é o padrão; o certificado é sempre conferido (nada de aceitar sozinho).
// FTP puro só como escolha explícita, marcado como sem criptografia.

const FTP_USER = /^[A-Za-z0-9_][\w.@+-]{0,99}$/;

export const FtpInput = z.object({
  name: ConnectionInput.shape.name,
  protocol: z.enum(['ftps', 'ftp'], { error: 'protocolo: ftps (com TLS) ou ftp (sem criptografia)' }).default('ftps'),
  host: ConnectionInput.shape.host,
  port: z.number().int('porta inválida').min(1, 'porta inválida').max(65535, 'porta inválida').default(21),
  user: z.string().trim().regex(FTP_USER, 'usuário inválido (letras, números, . _ @ + -, sem espaços)'),
  remoteRoot: ConnectionInput.shape.remoteRoot,
  // Vazia = não mudar (na edição). Sem trim: espaço pode ser parte da senha.
  password: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z
      .string()
      .max(256, 'senha grande demais')
      .refine((v) => !/[\r\n\0]/.test(v), 'a senha não pode ter quebra de linha')
      .optional(),
  ),
});

/** O que fica no ftp.json (sem senha). */
const FtpStored = FtpInput.omit({ password: true });

const ftpFile = (projectPath: string) => path.join(vpsDir(projectPath), 'ftp.json');

/** Id da senha no cofre: projeto + conexão (o nome do arquivo no cofre é um hash disto). */
export const ftpSecretId = (projectPath: string, name: string) => `ftp:${pathKey(projectPath)}:${name}`;

interface FtpFile {
  connections?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

async function readFtpFile(projectPath: string): Promise<FtpFile> {
  const raw = await fs.readFile(ftpFile(projectPath), 'utf8').catch(() => null);
  const data = tryJson((raw ?? '').replace(/^﻿/, ''));
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as FtpFile) : {};
}

/** As conexões FTP do projeto, para a tela: nunca com a senha, só se ela existe. */
export async function readFtpConnections(projectPath: string, vault?: VaultOptions): Promise<FtpConnection[]> {
  const file = await readFtpFile(projectPath);
  const out: FtpConnection[] = [];
  for (const [name, c] of Object.entries(file.connections ?? {})) {
    if (!c || typeof c !== 'object') continue;
    const parsed = FtpStored.safeParse({ ...c, name });
    if (!parsed.success) continue;
    const d = parsed.data;
    out.push({ protocol: d.protocol, name: d.name, host: d.host, port: d.port, user: d.user, remoteRoot: d.remoteRoot, hasPassword: await hasSecret(ftpSecretId(projectPath, d.name), vault) });
  }
  return out;
}

/** Para a ficha: só as que têm senha, sem usuário. */
export async function listFtpServers(projectPath: string, vault?: VaultOptions): Promise<ServerInfo[]> {
  return (await readFtpConnections(projectPath, vault))
    .filter((c) => c.hasPassword)
    .map((c) => ({ name: c.name, source: 'ftp', protocol: c.protocol, host: c.host, remoteRoot: c.remoteRoot }));
}

/** Cria ou edita (`originalName` no corpo: a editada; renomear leva a senha). Senha ausente na edição = mantém. */
export async function saveFtpConnection(projectPath: string, body: unknown, vault?: VaultOptions): Promise<FtpConnection> {
  const original = (body as { originalName?: unknown } | null)?.originalName;
  const originalName = typeof original === 'string' && original ? original : undefined;
  const parsed = FtpInput.safeParse(body);
  if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'conexão inválida');
  const c = parsed.data;
  const file = await readFtpFile(projectPath);
  const conns = { ...(file.connections ?? {}) };
  if (originalName && !conns[originalName]) throw new StaffError('conexão FTP não encontrada');
  if (c.name !== originalName && conns[c.name]) throw new StaffError(`já existe uma conexão ${c.name}`);
  // O nome é a referência na ficha: não pode repetir entre SSH e FTP (nem só nas maiúsculas).
  if ((await readConnections(projectPath)).some((s) => s.name.toLowerCase() === c.name.toLowerCase())) {
    throw new StaffError(`já existe uma conexão SSH ${c.name}`);
  }
  const id = ftpSecretId(projectPath, c.name);
  const oldId = originalName ? ftpSecretId(projectPath, originalName) : id;
  if (!c.password && !(await hasSecret(oldId, vault))) throw new StaffError('informe a senha');

  // A senha antes do arquivo: se o cofre falhar, nada muda.
  try {
    if (c.password) await setSecret(id, c.password, vault);
    else if (oldId !== id) await moveSecret(oldId, id, vault);
  } catch (err) {
    throw new StaffError(`não deu para guardar a senha no cofre: ${err instanceof VaultError ? err.message : 'erro ao gravar'}`);
  }
  const prev = (originalName && conns[originalName]) || {};
  if (originalName) delete conns[originalName];
  conns[c.name] = { ...prev, protocol: c.protocol, host: c.host, port: c.port, user: c.user, remoteRoot: c.remoteRoot };
  await ensureVpsGitignore(projectPath);
  await writeAtomic(ftpFile(projectPath), JSON.stringify({ ...file, connections: conns }, null, 2) + '\n');
  if (c.password && oldId !== id) await deleteSecret(oldId, vault);
  return (await readFtpConnections(projectPath, vault)).find((x) => x.name === c.name)!;
}

/** Apaga a conexão e a senha dela no cofre. */
export async function removeFtpConnection(projectPath: string, name: string, vault?: VaultOptions): Promise<boolean> {
  const file = await readFtpFile(projectPath);
  if (!file.connections?.[name]) return false;
  const conns = { ...file.connections };
  delete conns[name];
  await writeAtomic(ftpFile(projectPath), JSON.stringify({ ...file, connections: conns }, null, 2) + '\n');
  await deleteSecret(ftpSecretId(projectPath, name), vault);
  return true;
}

export async function isFtpConnection(projectPath: string, name: string): Promise<boolean> {
  return !!(await readFtpFile(projectPath)).connections?.[name];
}

// ---- cliente (adaptador: o basic-ftp de verdade, ou um falso nos testes) ----

export interface FtpEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  modifiedAt: string | null;
}

export interface FtpSession {
  pwd(): Promise<string>;
  list(dir: string): Promise<FtpEntry[]>;
  size(file: string): Promise<number>;
  download(remote: string, dest: Writable): Promise<void>;
  upload(src: Readable, remote: string): Promise<void>;
  remove(file: string): Promise<void>;
  /** Só pasta vazia (RMD). */
  removeDir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Cria a pasta e as que faltarem até ela. */
  mkdir(dir: string): Promise<void>;
  close(): void;
}

export type FtpConnector = (conn: FtpConnection, password: string, timeoutMs: number) => Promise<FtpSession>;

/** Erro que já pode ir para a tela ou para o funcionário (sem senha). */
export class FtpError extends Error {}

const stage = (s: string) => (err: unknown) => {
  if (err && typeof err === 'object') (err as { ftpStage?: string }).ftpStage = s;
  throw err;
};

const entryType = (f: FileInfo): FtpEntry['type'] =>
  f.type === FileType.Directory ? 'dir' : f.type === FileType.File ? 'file' : f.type === FileType.SymbolicLink ? 'link' : 'other';

/** basic-ftp. Os dados vão pelo mesmo host do controle (um servidor não manda o cliente conectar noutro IP). */
export const basicFtpConnector: FtpConnector = async (conn, password, timeoutMs) => {
  const client = new Client(timeoutMs, { allowSeparateTransferHost: false });
  try {
    await client.connect(conn.host, conn.port).catch(stage('connect'));
    if (conn.protocol === 'ftps') {
      // Certificado conferido (cadeia e nome do host): rejectUnauthorized é o padrão do node, e fica explícito.
      await client.useTLS({ host: conn.host, rejectUnauthorized: true, minVersion: 'TLSv1.2' }).catch(stage('tls'));
    }
    await client.sendIgnoringError('OPTS UTF8 ON');
    await client.login(conn.user, password).catch(stage('login'));
    await client.useDefaultSettings();
  } catch (err) {
    client.close();
    throw err;
  }
  return {
    pwd: () => client.pwd(),
    list: async (dir) =>
      (await client.list(dir)).map((f) => ({ name: f.name, type: entryType(f), size: f.size, modifiedAt: f.modifiedAt?.toISOString() ?? (f.rawModifiedAt || null) })),
    size: (file) => client.size(file),
    download: async (remote, dest) => void (await client.downloadTo(dest, remote)),
    upload: async (src, remote) => void (await client.uploadFrom(src, remote)),
    remove: async (file) => void (await client.remove(file)),
    removeDir: async (dir) => void (await client.removeEmptyDir(dir)),
    rename: async (from, to) => void (await client.rename(from, to)),
    mkdir: (dir) => client.ensureDir(dir),
    close: () => client.close(),
  };
};

const RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ECONNABORTED']);

/** Falha passageira (rede, servidor ocupado): vale tentar de novo. Senha, TLS e host errado, não. */
export function isTransient(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === 'string') return RETRY_CODES.has(e.code);
  if (e?.code === 421) return true;
  return typeof e?.message === 'string' && /^Timeout/i.test(e.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Conecta com até `attempts` tentativas, espera exponencial com jitter (~0,4 s, 0,8 s…). */
export async function connectWithRetry(
  connect: FtpConnector,
  conn: FtpConnection,
  password: string,
  timeoutMs: number,
  o: { attempts?: number; baseMs?: number; wait?: (ms: number) => Promise<unknown> } = {},
): Promise<FtpSession> {
  const attempts = o.attempts ?? 3;
  for (let i = 1; ; i++) {
    try {
      return await connect(conn, password, timeoutMs);
    } catch (err) {
      if (i >= attempts || !isTransient(err)) throw err;
      await (o.wait ?? sleep)((o.baseMs ?? 400) * 2 ** (i - 1) * (0.5 + Math.random() / 2));
    }
  }
}

/**
 * Disjuntor por conexão: depois de `threshold` falhas seguidas, recusa na hora por `coolMs`. Evita que um
 * funcionário insista numa senha errada até o servidor bloquear o IP (fail2ban e afins).
 */
export class FtpBreaker {
  private readonly state = new Map<string, { fails: number; openUntil: number }>();
  constructor(
    private readonly threshold = 3,
    private readonly coolMs = 30_000,
    private readonly now = Date.now,
  ) {}

  check(key: string): void {
    const s = this.state.get(key);
    const left = s ? s.openUntil - this.now() : 0;
    if (left > 0) throw new FtpError(`${key}: ${this.threshold} falhas seguidas; espere ${Math.ceil(left / 1000)} s antes de tentar de novo`);
  }

  ok(key: string): void {
    this.state.delete(key);
  }

  fail(key: string): void {
    const s = this.state.get(key) ?? { fails: 0, openUntil: 0 };
    s.fails++;
    if (s.fails >= this.threshold) {
      s.fails = 0;
      s.openUntil = this.now() + this.coolMs;
    }
    this.state.set(key, s);
  }
}

/** Promessa com prazo; o que chegar atrasado é entregue a `late` (para fechar a conexão). */
export function withDeadline<T>(p: Promise<T>, ms: number, message: string, late?: (v: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new FtpError(message));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        if (done) late?.(v);
        else resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        if (!done) reject(err);
      },
    );
  });
}

/** Tira a senha de qualquer texto que vá para a tela, para o log ou para o funcionário. */
export function scrub(text: string, password: string | null | undefined): string {
  return password && password.length >= 3 ? text.split(password).join('***') : text;
}

const TLS_UNTRUSTED = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

/** Erro do FTP em palavras (como explainSshError). Nunca traz a senha. */
export function explainFtpError(err: unknown, conn: Pick<FtpConnection, 'host' | 'port' | 'protocol'>, password?: string | null): string {
  if (err instanceof FtpError) return scrub(err.message, password);
  const e = (err ?? {}) as { code?: unknown; message?: unknown; ftpStage?: string };
  const msg = scrub(typeof e.message === 'string' ? e.message : String(err), password);
  const code = e.code;
  if (typeof code === 'string') {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host não encontrado: confira o endereço';
    if (code === 'ECONNREFUSED') return `conexão recusada na porta ${conn.port}`;
    if (code === 'ETIMEDOUT') return `o servidor não respondeu na porta ${conn.port}`;
    if (code === 'ECONNRESET') return 'o servidor fechou a conexão no meio';
    if (TLS_UNTRUSTED.has(code)) {
      return 'o certificado TLS do servidor não é confiável (autoassinado ou sem a cadeia): o Claudio’s Club não aceita sozinho. Use o nome de host que está no certificado da hospedagem ou peça um certificado válido';
    }
    if (code === 'CERT_HAS_EXPIRED') return 'o certificado TLS do servidor venceu: avise quem cuida da hospedagem';
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      return `o certificado TLS não é de ${conn.host}: use o nome de host que está no certificado (muitas hospedagens usam o do servidor, ex.: servidor123.hospedagem.com)`;
    }
    if (/^ERR_SSL|^EPROTO$/.test(code) || /wrong version number|SSL routines/i.test(msg)) return 'o servidor não respondeu em TLS: confira a porta e se ele aceita FTPS';
  }
  if (typeof code === 'number') {
    if (e.ftpStage === 'tls') return 'o servidor não aceita FTPS (TLS explícito): peça para ligar o TLS na hospedagem; FTP sem criptografia só se você aceitar o risco';
    if (code === 530) return 'o servidor recusou o usuário ou a senha';
    if (code === 421) return 'o servidor está ocupado ou limitou as conexões: tente daqui a pouco';
    if (code === 550) return 'arquivo ou pasta não encontrado no servidor (ou sem permissão)';
    if (code === 552 || code === 452) return 'sem espaço no servidor (ou cota cheia)';
    if (code === 553) return 'o servidor não aceitou esse nome de arquivo';
  }
  if (/^Timeout/i.test(msg)) return `o servidor não respondeu na porta ${conn.port}`;
  if (/certificate|self.signed/i.test(msg)) return `falha no certificado TLS: ${msg.slice(0, 200)}`;
  return `a conexão falhou: ${msg.split(/\r?\n/)[0]!.slice(0, 200)}`;
}

/**
 * Caminho remoto preso a `root` (a pasta da conexão), quando há. `\` vira `/` (servidor Windows trata como
 * separador) e `..` é resolvido antes de conferir: nada sai da pasta.
 */
export function resolveRemote(root: string | null, base: string, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new FtpError('informe o caminho remoto');
  if (raw.length > 1000 || /[\u0000-\u001f\u007f]/.test(raw)) throw new FtpError('caminho remoto inválido');
  const p = raw.trim().replace(/\\/g, '/');
  const abs = path.posix.normalize(p.startsWith('/') ? p : path.posix.join(base, p));
  const clean = abs.length > 1 ? abs.replace(/\/+$/, '') : abs;
  if (root && root !== '/' && clean !== root && !clean.startsWith(`${root}/`)) throw new FtpError(`caminho fora da pasta da conexão (${root})`);
  return clean;
}

/** Conecta, lista a pasta da conexão (ou a de login) e diz o que houve em palavras. ~15 s no máximo. */
export async function testFtpConnection(
  projectPath: string,
  name: string,
  o: { connect?: FtpConnector; vault?: VaultOptions; timeoutMs?: number } = {},
): Promise<{ ok: boolean; message: string }> {
  const conn = (await readFtpConnections(projectPath, o.vault)).find((c) => c.name === name);
  if (!conn) throw new StaffError('conexão não encontrada');
  if (!conn.hasPassword) throw new StaffError('cadastre a senha antes de testar');
  const timeoutMs = o.timeoutMs ?? 15_000;
  let password: string | null = null;
  let session: FtpSession | null = null;
  try {
    password = await getSecret(ftpSecretId(projectPath, name), o.vault);
    if (!password) return { ok: false, message: 'a senha não está no cofre: cadastre de novo' };
    const late = (s: FtpSession) => s.close();
    session = await withDeadline((o.connect ?? basicFtpConnector)(conn, password, timeoutMs), timeoutMs, `o servidor não respondeu em ${timeoutMs / 1000} s`, late);
    const s = session;
    const dir = conn.remoteRoot ?? (await s.pwd());
    const entries = await withDeadline(s.list(dir), timeoutMs, `a listagem não respondeu em ${timeoutMs / 1000} s`);
    const plain = conn.protocol === 'ftp' ? ' Sem criptografia: a senha e os arquivos passam abertos na rede.' : '';
    return { ok: true, message: `conectou em ${conn.user}@${conn.host} (${conn.protocol.toUpperCase()}); ${dir}: ${entries.length} itens.${plain}` };
  } catch (err) {
    return { ok: false, message: explainFtpError(err, conn, password) };
  } finally {
    session?.close();
  }
}
