import fs from 'node:fs/promises';
import path from 'node:path';
import { EXTENSION_KEY } from './identity';

// O .zip da extensão para instalar (modo desenvolvedor do Chrome). Sem dependência: ZIP "store" (sem compressão), o que basta para uma
// extensão pequena. A pasta `extension/` fica no repositório, onde agentes escrevem: por isso o zip só sai com um manifest dentro do combinado
// (ver checkManifest), e não com qualquer coisa que um agente tenha colocado lá.

export interface ZipFile {
  /** Caminho dentro do zip, com `/`. */
  name: string;
  data: Buffer;
  mtime: Date;
}

/** Pasta ausente, manifest recusado ou pacote grande demais: a rota responde com este status. */
export class ExtensionPackError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const MAX_FILES = 300;
const MAX_BYTES = 10 * 1024 * 1024;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (o do ZIP). */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Data e hora no formato do MS-DOS (o que o ZIP guarda). */
function dosStamp(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** ZIP sem compressão: cabeçalho local, dados, cabeçalho central por arquivo, e o fim (EOCD). */
export function storeZip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;
    const { time, date } = dosStamp(f.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versão para extrair
    local.writeUInt16LE(0x0800, 6); // flag: nomes em UTF-8
    local.writeUInt16LE(0, 8); // método 0: guardado
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // versão que gerou
    entry.writeUInt16LE(20, 6); // versão para extrair
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(0, 38); // atributos externos
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + size;
  }
  const centralDir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDir, end]);
}

/**
 * Os arquivos da pasta, recursivo. Pula symlinks, o que não é arquivo e o que começa com `.` (no caminho todo). Passou de 300 arquivos ou de
 * 10 MB, recusa (409).
 */
export async function collectExtension(dir: string): Promise<ZipFile[]> {
  const out: ZipFile[] = [];
  let total = 0;
  const walk = async (current: string, rel: string): Promise<void> => {
    const entries = (await fs.readdir(current)).sort();
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const abs = path.join(current, name);
      const relName = rel ? `${rel}/${name}` : name;
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await walk(abs, relName);
        continue;
      }
      if (!st.isFile()) continue;
      if (out.length >= MAX_FILES) throw new ExtensionPackError(409, `a extensão tem arquivos demais (máx. ${MAX_FILES})`);
      total += st.size;
      if (total > MAX_BYTES) throw new ExtensionPackError(409, 'a extensão passou de 10 MB');
      out.push({ name: relName, data: await fs.readFile(abs), mtime: st.mtime });
    }
  };
  await walk(dir, '');
  return out;
}

const PERMISSIONS = ['storage', 'alarms', 'notifications', 'activeTab', 'scripting', 'contextMenus'];

/**
 * Motivo da recusa do manifest, ou null se pode sair no zip. A extensão é só a da tela: a chave fixa (o ID não muda), as permissões do
 * combinado, o host só o do Claudio’s Club (o `port`) e nada que injete código em páginas ou abra o que é de fora.
 */
export function checkManifest(json: unknown, port: number): string | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'manifest.json não é um objeto';
  const m = json as Record<string, unknown>;
  if (m.manifest_version !== 3) return 'manifest_version tem de ser 3';
  if (m.key !== EXTENSION_KEY) return 'key diferente da do Claudio’s Club (o ID da extensão mudaria)';
  const subset = (value: unknown, allowed: readonly string[]): boolean =>
    value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string' && allowed.includes(v)));
  if (!subset(m.permissions, PERMISSIONS)) return 'permissions fora do combinado';
  const hosts = [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`];
  if (!subset(m.host_permissions, hosts)) return 'host_permissions fora do Claudio’s Club';
  for (const key of ['optional_permissions', 'optional_host_permissions'] as const) {
    if (Array.isArray(m[key]) && (m[key] as unknown[]).length) return `${key} não pode ter nada`;
  }
  for (const key of ['content_scripts', 'externally_connectable', 'web_accessible_resources'] as const) {
    if (m[key] !== undefined) return `${key} não é permitido`;
  }
  // A política em texto (ou o objeto dela): sem eval e sem carregar nada de http/https.
  if (m.content_security_policy !== undefined && /unsafe-eval|https?:/i.test(JSON.stringify(m.content_security_policy))) {
    return 'content_security_policy com eval ou com http/https';
  }
  return null;
}

/**
 * O zip da extensão para o `port`. Pasta sem manifest: 404 ("ainda não está nesta versão"). Manifest recusado: 409 com o motivo.
 */
export async function buildExtensionZip(dir: string, port: number): Promise<Buffer> {
  let files: ZipFile[];
  try {
    files = await collectExtension(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ExtensionPackError(404, 'a extensão ainda não está nesta versão');
    throw err;
  }
  const manifest = files.find((f) => f.name === 'manifest.json');
  if (!manifest) throw new ExtensionPackError(404, 'a extensão ainda não está nesta versão');
  let json: unknown;
  try {
    json = JSON.parse(manifest.data.toString('utf8'));
  } catch {
    throw new ExtensionPackError(409, 'manifest.json não é um JSON válido');
  }
  const refused = checkManifest(json, port);
  if (refused) throw new ExtensionPackError(409, `manifest.json recusado: ${refused}`);
  return storeZip(files);
}
