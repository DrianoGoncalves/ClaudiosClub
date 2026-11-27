import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameWithRetry } from './atomicWrite';
import { KeyringError, systemKeyring, type Keyring, type KeyringReason } from './secretKeyring';

// Cofre de segredos do Claudio’s Club (senhas de FTP), fora de qualquer projeto: ~/.myco/secrets/.
// Windows: cada segredo é cifrado com o DPAPI do usuário (CurrentUser) pelo powershell.exe, e o valor
// passa só pela entrada padrão (nunca em argumento, variável de ambiente ou log).
// Linux: o valor vai para o chaveiro do sistema (Secret Service, pelo `secret-tool`; server/secretKeyring.ts),
// que o cifra e o prende ao login do usuário, como o DPAPI. O arquivo `<hash>.secret` guarda só um marcador
// (`v1:keyring:<id>`), sem o segredo. Sem chaveiro (servidor sem sessão gráfica, secret-tool ausente, bloqueado)
// o segredo cai para o formato de arquivo: modo 0600 numa pasta 0700, sem cifra (protege de outros usuários da
// máquina, não de quem roda como você), e o aviso diz isso. macOS: só o arquivo.
// Em nenhum sistema protege de um processo do seu próprio usuário (inclusive um funcionário
// com terminal): é por isso que o funcionário só usa a senha pelo MCP do Claudio’s Club e as regras
// da sessão bloqueiam a leitura desta pasta (e o `secret-tool`).

export interface VaultOptions {
  /** Pasta do cofre (padrão ~/.myco/secrets; os testes trocam). */
  dir?: string;
  /** Sistema (os testes trocam para cobrir o modo arquivo no Windows). */
  platform?: NodeJS.Platform;
  /**
   * Chaveiro do Linux: um objeto (os testes trocam por um de memória) ou `null` (desliga). Ausente = o do sistema, mas só para gravar no cofre da
   * casa padrão (`~/.myco`; ver `keyringForWrite`). Ler um marcador `v1:keyring:` sempre usa o do sistema.
   */
  keyring?: Keyring | null;
}

/** Onde o segredo ficou e, se o chaveiro era esperado e não serviu, o aviso em texto. */
export interface SetSecretResult {
  backend: 'dpapi' | 'keyring' | 'file';
  warning?: string;
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

const MARKER = /^v1:(dpapi|file|keyring):([A-Za-z0-9+/=]+)\s*$/;
const KEYRING_ID = /^[0-9a-f]{24}$/;
const newKeyringId = () => randomBytes(12).toString('hex');

/** Quem grava no mesmo cofre roda um de cada vez (neste processo): a migração do boot não atravessa um `setSecret`. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/** O cofre da casa padrão (`~/.myco/secrets`): só ele usa o chaveiro do sistema sem `MYCO_VAULT_KEYRING=on`. */
const HOME_SECRETS_DIR = path.join(os.homedir(), '.myco', 'secrets');
const samePath = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/**
 * O chaveiro para gravar um segredo novo, ou null (arquivo): só Linux, só no cofre da instância (nunca numa `dir` de teste) e só na casa padrão
 * (`~/.myco`): uma instância de teste, com outro MYCO_HOME, não enche o chaveiro do usuário de itens sem dono. `MYCO_VAULT_KEYRING=off` desliga;
 * `=on` liga também com MYCO_HOME personalizado. Sob o vitest, só com `keyring` injetado (ou `=on`): os testes nunca chegam ao chaveiro de verdade.
 */
function keyringForWrite(o?: VaultOptions): Keyring | null {
  if (platformOf(o) !== 'linux') return null;
  if (o?.keyring !== undefined) return o.keyring;
  const mode = process.env.MYCO_VAULT_KEYRING;
  if (mode === 'off' || (process.env.VITEST && mode !== 'on')) return null;
  if (o?.dir !== undefined && !samePath(o.dir, DEFAULT_SECRETS_DIR)) return null;
  if (mode !== 'on' && !samePath(DEFAULT_SECRETS_DIR, HOME_SECRETS_DIR)) return null;
  return systemKeyring();
}

/** O chaveiro para ler, apagar ou devolver um segredo que já está nele (não depende da pasta nem de `MYCO_VAULT_KEYRING`). */
function keyringForRead(o?: VaultOptions): Keyring | null {
  if (platformOf(o) !== 'linux') return null;
  return o?.keyring === undefined ? systemKeyring() : o.keyring;
}

// --- Aviso de queda para arquivo: uma linha de log por motivo e por processo (nunca com valor), e o texto para a resposta da rota.
const warned = new Set<string>();

function fallbackWarning(reason: KeyringReason): string {
  return `Sem chaveiro do sistema (${new KeyringError(reason).message}): as senhas ficam em arquivo (0600, sem cifra) neste computador. Instale e ative um chaveiro (secret-tool do libsecret com GNOME Keyring, KWallet ou KeePassXC) para guardá-las cifradas.`;
}

function noteFallback(reason: KeyringReason): string {
  const warning = fallbackWarning(reason);
  if (!warned.has(reason)) {
    warned.add(reason);
    console.warn(`[cofre] ${warning}`);
  }
  return warning;
}

/** Aviso solto (apagar item que o chaveiro não deixou apagar etc.): uma vez por texto. */
function warnOnce(text: string): void {
  if (warned.has(text)) return;
  warned.add(text);
  console.warn(`[cofre] ${text}`);
}

/** O id do chaveiro que o marcador do arquivo aponta, ou null (sem arquivo, outro formato, ilegível). */
async function keyringIdIn(file: string): Promise<string | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  return raw === null ? null : keyringIdOf(raw);
}

function keyringIdOf(raw: string): string | null {
  const m = MARKER.exec(raw);
  return m && m[1] === 'keyring' && KEYRING_ID.test(m[2]!) ? m[2]! : null;
}

/** Tira o item do chaveiro sem deixar a falha derrubar quem chamou: sobra um item sem dono (o arquivo já não aponta para ele). */
async function dropKeyringItem(o: VaultOptions | undefined, id: string): Promise<void> {
  const kr = keyringForRead(o);
  if (!kr) return;
  await kr.clear(id).catch((err: unknown) => warnOnce(`não deu para apagar um item antigo do chaveiro (${err instanceof KeyringError ? err.message : 'erro'}): ele fica lá, sem uso`));
}

export async function setSecret(id: string, value: string, o?: VaultOptions): Promise<SetSecretResult> {
  if (!value) throw new VaultError('segredo vazio');
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET) throw new VaultError('segredo grande demais');
  const plainB64 = Buffer.from(value, 'utf8').toString('base64');
  if (platformOf(o) === 'win32') {
    await writePrivate(secretFile(id, o), `v1:dpapi:${await dpapi('protect', plainB64)}`, o);
    return { backend: 'dpapi' };
  }
  const file = secretFile(id, o);
  return serial(dirOf(o), async () => {
    const prev = await keyringIdIn(file);
    const kr = keyringForWrite(o);
    let warning: string | undefined;
    if (kr) {
      const kid = newKeyringId();
      let failure: KeyringReason | null = null;
      try {
        await kr.store(kid, value);
      } catch (err) {
        failure = err instanceof KeyringError ? err.reason : 'failed';
      }
      if (!failure) {
        try {
          await writePrivate(file, `v1:keyring:${kid}`, o);
        } catch (err) {
          await kr.clear(kid).catch(() => {});
          throw err;
        }
        if (prev) await dropKeyringItem(o, prev);
        return { backend: 'keyring' as const };
      }
      warning = noteFallback(failure);
    }
    await writePrivate(file, `v1:file:${plainB64}`, o);
    if (prev) await dropKeyringItem(o, prev);
    return warning ? { backend: 'file' as const, warning } : { backend: 'file' as const };
  });
}

/** O segredo, ou null se não há. Erro (VaultError) se o arquivo existe mas não abre. */
export async function getSecret(id: string, o?: VaultOptions): Promise<string | null> {
  const raw = await fs.readFile(secretFile(id, o), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return null;
  const m = MARKER.exec(raw);
  if (!m) throw new VaultError('segredo corrompido no cofre: cadastre a senha de novo');
  if (m[1] === 'dpapi') {
    if (platformOf(o) !== 'win32') throw new VaultError('segredo cifrado no Windows: cadastre a senha de novo nesta máquina');
    return Buffer.from(await dpapi('unprotect', m[2]!), 'base64').toString('utf8');
  }
  if (m[1] === 'keyring') return readFromKeyring(m[2]!, o);
  return Buffer.from(m[2]!, 'base64').toString('utf8');
}

async function readFromKeyring(kid: string, o?: VaultOptions): Promise<string> {
  if (!KEYRING_ID.test(kid)) throw new VaultError('segredo corrompido no cofre: cadastre a senha de novo');
  if (platformOf(o) !== 'linux') throw new VaultError('segredo guardado no chaveiro do Linux: cadastre a senha de novo nesta máquina');
  const kr = keyringForRead(o);
  if (!kr) throw new VaultError('o segredo está no chaveiro do sistema, que está desligado aqui: cadastre a senha de novo');
  let value: string | null;
  try {
    value = await kr.lookup(kid);
  } catch (err) {
    const why = err instanceof KeyringError ? err.message : 'erro ao ler';
    throw new VaultError(`o segredo está no chaveiro do sistema e ele não abriu (${why}): destrave o chaveiro e tente de novo`);
  }
  if (value === null) throw new VaultError('o chaveiro do sistema não tem este segredo: cadastre a senha de novo');
  return value;
}

export async function hasSecret(id: string, o?: VaultOptions): Promise<boolean> {
  return fs.stat(secretFile(id, o)).then((s) => s.isFile(), () => false);
}

export async function deleteSecret(id: string, o?: VaultOptions): Promise<boolean> {
  const file = secretFile(id, o);
  return serial(dirOf(o), async () => {
    const had = await hasSecret(id, o);
    const kid = await keyringIdIn(file);
    if (kid) await dropKeyringItem(o, kid);
    await fs.rm(file, { force: true });
    return had;
  });
}

/** Renomear a conexão: o segredo vai junto (copia e depois apaga o antigo; sem segredo, nada a fazer). */
export async function moveSecret(from: string, to: string, o?: VaultOptions): Promise<void> {
  if (from === to) return;
  return serial(dirOf(o), async () => {
    const src = secretFile(from, o);
    const raw = await fs.readFile(src, 'utf8').catch(() => null);
    if (raw === null) return;
    const dst = secretFile(to, o);
    const replaced = await keyringIdIn(dst);
    // O blob do DPAPI e o marcador do chaveiro não dependem do id: dá para levar sem decifrar.
    await writePrivate(dst, raw, o);
    await fs.rm(src, { force: true });
    if (replaced && replaced !== keyringIdOf(raw)) await dropKeyringItem(o, replaced);
  });
}

// --- Estado do cofre e migração (Linux)

export interface VaultStatus {
  backend: 'dpapi' | 'keyring' | 'file';
  /** Só quando o chaveiro era esperado (Linux, ligado) e não serve: o aviso em texto. */
  warning?: string;
}

/** Onde um segredo novo iria agora. No Linux consulta o chaveiro (um `lookup` de item que não existe: não grava e não pede senha). */
export async function vaultStatus(o?: VaultOptions): Promise<VaultStatus> {
  if (platformOf(o) === 'win32') return { backend: 'dpapi' };
  const kr = keyringForWrite(o);
  if (!kr) return { backend: 'file' };
  try {
    await kr.probe();
    return { backend: 'keyring' };
  } catch (err) {
    return { backend: 'file', warning: noteFallback(err instanceof KeyringError ? err.reason : 'failed') };
  }
}

async function secretFiles(dir: string): Promise<Array<{ file: string; raw: string }>> {
  const names = await fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [] as string[];
    throw err;
  });
  const out: Array<{ file: string; raw: string }> = [];
  for (const name of names.filter((n) => n.endsWith('.secret')).sort()) {
    const file = path.join(dir, name);
    const raw = await fs.readFile(file, 'utf8').catch(() => null);
    if (raw !== null) out.push({ file, raw });
  }
  return out;
}

export interface MigrateResult {
  /** Segredos que passaram do arquivo para o chaveiro agora. */
  migrated: number;
  /** Segredos que seguem em arquivo (chaveiro fora ou desligado, ou o item não conferiu). */
  kept: number;
  /** Por que o chaveiro parou a migração, em texto. */
  reason?: string;
}

/**
 * Passa os segredos `v1:file:` para o chaveiro (Linux, na subida do servidor). Sem perda: cada um vai ao chaveiro, é lido de volta e conferido, e só então o
 * arquivo vira marcador (rename atômico). Qualquer falha deixa o arquivo como estava; nada do chaveiro é apagado por causa de erro. Roda de novo sem
 * efeito (só olha o que ainda é `v1:file:`). Quem lê (os MCPs) nunca migra: o servidor é o único a gravar.
 */
export async function migrateVault(o?: VaultOptions): Promise<MigrateResult> {
  const kr = keyringForWrite(o);
  return serial(dirOf(o), async () => {
    const pending = (await secretFiles(dirOf(o)))
      .map((f) => ({ ...f, m: MARKER.exec(f.raw) }))
      .filter((f) => f.m && f.m[1] === 'file');
    if (!pending.length) return { migrated: 0, kept: 0 };
    if (!kr) return { migrated: 0, kept: pending.length };
    let migrated = 0;
    let reason: KeyringReason | undefined;
    for (const p of pending) {
      const value = Buffer.from(p.m![2]!, 'base64').toString('utf8');
      const kid = newKeyringId();
      try {
        await kr.store(kid, value);
        const back = await kr.lookup(kid);
        const unchanged = back === value && (await fs.readFile(p.file, 'utf8').catch(() => null)) === p.raw;
        if (!unchanged) {
          await kr.clear(kid).catch(() => {});
          continue;
        }
        try {
          await writePrivate(p.file, `v1:keyring:${kid}`, o);
        } catch {
          await kr.clear(kid).catch(() => {});
          continue;
        }
        migrated++;
      } catch (err) {
        reason = err instanceof KeyringError ? err.reason : 'failed';
        break;
      }
    }
    if (reason) noteFallback(reason);
    return { migrated, kept: pending.length - migrated, ...(reason ? { reason: new KeyringError(reason).message } : {}) };
  });
}

/**
 * Subida do servidor: diz onde os segredos ficam (e o aviso, se o chaveiro era esperado e não serve) e migra os `v1:file:` para o chaveiro. O log leva a
 * contagem migrada e a mantida em arquivo; nunca um valor.
 */
export async function vaultBoot(o?: VaultOptions, out: { log(line: string): void; warn(line: string): void } = console): Promise<MigrateResult> {
  const status = await vaultStatus(o);
  if (status.warning) out.warn(`[cofre] ${status.warning}`);
  else out.log(`[cofre] segredos guardados em: ${{ keyring: 'chaveiro do sistema', dpapi: 'DPAPI do Windows', file: 'arquivo (0600, sem cifra)' }[status.backend]}`);
  const r = await migrateVault(o);
  // Sem nada em arquivo, ou em arquivo por escolha (macOS, `MYCO_VAULT_KEYRING=off`): sem linha.
  if (r.migrated || (r.kept && (status.backend === 'keyring' || status.warning))) {
    out.log(`[cofre] ${r.migrated} segredo(s) migrado(s) para o chaveiro, ${r.kept} mantido(s) em arquivo${r.reason ? ` (${r.reason})` : ''}`);
  }
  return r;
}

export interface RestoreResult {
  /** Segredos que voltaram do chaveiro para o arquivo (`v1:file:`, 0600, sem cifra). */
  restored: number;
  /** Segredos que seguem no chaveiro (ele não respondeu, ou o item não existe mais). */
  kept: number;
}

/**
 * Caminho de volta da migração: lê cada segredo do chaveiro e regrava como `v1:file:`, e só depois tira o item do chaveiro. Para quem vai tirar o chaveiro
 * ou migrar o cofre para outro computador. O que o chaveiro não entrega fica como está.
 */
export async function restoreVaultToFile(o?: VaultOptions): Promise<RestoreResult> {
  const kr = keyringForRead(o);
  return serial(dirOf(o), async () => {
    let restored = 0;
    let kept = 0;
    for (const f of await secretFiles(dirOf(o))) {
      const kid = keyringIdOf(f.raw);
      if (!kid) continue;
      try {
        const value = kr ? await kr.lookup(kid) : null;
        if (value === null) {
          kept++;
          continue;
        }
        await writePrivate(f.file, `v1:file:${Buffer.from(value, 'utf8').toString('base64')}`, o);
        restored++;
        await kr!.clear(kid).catch(() => warnOnce('não deu para apagar um item do chaveiro depois de devolver o segredo ao arquivo: ele fica lá, sem uso'));
      } catch {
        kept++;
      }
    }
    return { restored, kept };
  });
}

async function writePrivate(file: string, content: string, o?: VaultOptions): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (platformOf(o) !== 'win32') await fs.chmod(dir, 0o700);
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (platformOf(o) !== 'win32') await fs.chmod(tmp, 0o600);
    await renameWithRetry(tmp, file);
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
