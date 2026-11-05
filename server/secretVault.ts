import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cofre de segredos do Claudio’s Club (senhas de FTP), fora de qualquer projeto: ~/.myco/secrets/.
// Windows: cada segredo é cifrado com o DPAPI do usuário (CurrentUser) pelo powershell.exe, e o valor
// passa só pela entrada padrão (nunca em argumento, variável de ambiente ou log). Linux/mac: arquivo
// com modo 0600 numa pasta 0700, sem cifra: protege de outros usuários da máquina, não de quem roda
// como você. Em nenhum sistema protege de um processo do seu próprio usuário (inclusive um funcionário
// com terminal): é por isso que o funcionário só usa a senha pelo MCP do Claudio’s Club e as regras
// da sessão bloqueiam a leitura desta pasta.

export interface VaultOptions {
  /** Pasta do cofre (padrão ~/.myco/secrets; os testes trocam). */
  dir?: string;
  /** Sistema (os testes trocam para cobrir o modo arquivo no Windows). */
  platform?: NodeJS.Platform;
}

export class VaultError extends Error {}

export const DEFAULT_SECRETS_DIR = path.join(process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco'), 'secrets');

const MAX_SECRET = 4096;
/** Entropia extra do DPAPI: um blob deste cofre não abre com uma chamada genérica sem ela. */
const ENTROPY_B64 = Buffer.from('claudios-club-vault-v1').toString('base64');

const dirOf = (o?: VaultOptions) => o?.dir ?? DEFAULT_SECRETS_DIR;
const platformOf = (o?: VaultOptions) => o?.platform ?? process.platform;

/** O nome do arquivo não revela o projeto nem a conexão (e não colide por maiúsculas no Windows). */
export function secretFile(id: string, o?: VaultOptions): string {
  return path.join(dirOf(o), `${createHash('sha256').update(id).digest('hex').slice(0, 40)}.secret`);
}

export async function setSecret(id: string, value: string, o?: VaultOptions): Promise<void> {
  if (!value) throw new VaultError('segredo vazio');
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET) throw new VaultError('segredo grande demais');
  const plainB64 = Buffer.from(value, 'utf8').toString('base64');
  const content = platformOf(o) === 'win32' ? `v1:dpapi:${await dpapi('protect', plainB64)}` : `v1:file:${plainB64}`;
  await writePrivate(secretFile(id, o), content, o);
}

/** O segredo, ou null se não há. Erro (VaultError) se o arquivo existe mas não abre. */
export async function getSecret(id: string, o?: VaultOptions): Promise<string | null> {
  const raw = await fs.readFile(secretFile(id, o), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return null;
  const m = /^v1:(dpapi|file):([A-Za-z0-9+/=]+)\s*$/.exec(raw);
  if (!m) throw new VaultError('segredo corrompido no cofre: cadastre a senha de novo');
  if (m[1] === 'dpapi') {
    if (platformOf(o) !== 'win32') throw new VaultError('segredo cifrado no Windows: cadastre a senha de novo nesta máquina');
    return Buffer.from(await dpapi('unprotect', m[2]!), 'base64').toString('utf8');
  }
  return Buffer.from(m[2]!, 'base64').toString('utf8');
}

export async function hasSecret(id: string, o?: VaultOptions): Promise<boolean> {
  return fs.stat(secretFile(id, o)).then((s) => s.isFile(), () => false);
}

export async function deleteSecret(id: string, o?: VaultOptions): Promise<boolean> {
  const file = secretFile(id, o);
  const had = await hasSecret(id, o);
  await fs.rm(file, { force: true });
  return had;
}

/** Renomear a conexão: o segredo vai junto (copia e depois apaga o antigo; sem segredo, nada a fazer). */
export async function moveSecret(from: string, to: string, o?: VaultOptions): Promise<void> {
  if (from === to) return;
  const src = secretFile(from, o);
  const raw = await fs.readFile(src, 'utf8').catch(() => null);
  if (raw === null) return;
  // O blob do DPAPI não depende do id: dá para levar sem decifrar.
  await writePrivate(secretFile(to, o), raw, o);
  await fs.rm(src, { force: true });
}

async function writePrivate(file: string, content: string, o?: VaultOptions): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (platformOf(o) !== 'win32') await fs.chmod(dir, 0o700);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (platformOf(o) !== 'win32') await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** powershell.exe do sistema (não o primeiro do PATH). */
function powershell(): string {
  const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(sys) ? sys : 'powershell.exe';
}

// O script não tem o segredo nem aspas duplas: entrada e saída em base64 (a entrada padrão do
// PowerShell 5.1 usa a página de código do console e estragaria acentos).
const script = (op: 'Protect' | 'Unprotect') =>
  [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$i=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$e=[Convert]::FromBase64String('${ENTROPY_B64}')`,
    `$o=[Security.Cryptography.ProtectedData]::${op}($i,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($o))',
  ].join(';');

/** Cifra/decifra com o DPAPI; entrada e saída em base64. A mensagem de erro nunca traz o valor. */
function dpapi(op: 'protect' | 'unprotect', inputB64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(op === 'protect' ? 'Protect' : 'Unprotect')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new VaultError('o cofre do Windows não respondeu'));
    }, 20_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', () => {
      clearTimeout(timer);
      reject(new VaultError('não deu para abrir o PowerShell para usar o cofre do Windows'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const b64 = out.trim();
      if (code === 0 && /^[A-Za-z0-9+/=]+$/.test(b64)) return resolve(b64);
      // stderr do PowerShell: só o tipo do erro (a entrada nunca aparece nele, mas não custa cortar).
      const why = /CryptographicException/i.test(err) ? 'o segredo não abre com este usuário do Windows' : 'falha no cofre do Windows';
      reject(new VaultError(op === 'unprotect' ? `${why}: cadastre a senha de novo` : why));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(inputB64);
  });
}
