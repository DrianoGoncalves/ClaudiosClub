import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Arquivos do projeto na aba de arquivos: listar, ler, gravar um arquivo que já existe e criar arquivo vazio
// ou pasta (sem sobrescrever). Tudo fica preso à pasta do projeto: o caminho é resolvido e o realpath
// conferido (link simbólico que sai do projeto é recusado). Arquivo de segredo aparece na lista (locked), mas não abre nem grava.

export const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
/** Imagens que a aba de arquivos mostra (só visualização). SVG fica de fora: é texto e abre no editor. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Pastas de dependências e de build: somem da lista. */
const HIDDEN = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'vendor', '__pycache__', '.venv']);
/** Pastas inteiras de segredo: tudo dentro delas é bloqueado. */
const SECRET_DIRS = new Set(['.vps', '.ssh']);
const SECRET_NAME = /^(\.env(\..*)?|id_rsa.*|id_ed25519.*|credentials.*\.json|.*\.(pem|key|p12|pfx|keystore))$/;
/** Modelos de .env que podem ser lidos e editados (não guardam valor real). */
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample']);

export class ProjectFileError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  locked?: true;
}

export interface ProjectFile {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
}

export interface WriteInput {
  path: string;
  content: string;
  baseMtimeMs: number;
}

const forbidden = (message = 'caminho fora do projeto') => new ProjectFileError(403, message);
const secretError = () => new ProjectFileError(403, 'arquivo de segredo: não é aberto pelo Claudio’s Club');
const notFound = (message: string) => new ProjectFileError(404, message);

/** Segredo pelo caminho relativo (com "/"): nome, extensão, ou dentro de .vps/ e .ssh/. */
export function isSecretRel(rel: string): boolean {
  const parts = rel.split('/').filter(Boolean).map((p) => p.toLowerCase());
  // .git fica junto: o .git/config pode ter token na URL do remote.
  if (parts.some((p) => SECRET_DIRS.has(p) || HIDDEN.has(p))) return true;
  const name = parts.at(-1) ?? '';
  if (ENV_TEMPLATES.has(name)) return false;
  return SECRET_NAME.test(name);
}

/** Valida o caminho pedido e devolve a forma normalizada ("a/b", sem "." nem barras sobrando). */
export function cleanRel(raw: string): string {
  if (raw.includes('\0')) throw forbidden('caminho inválido');
  const p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) throw forbidden('caminho absoluto não é aceito');
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.includes('..')) throw forbidden();
  return parts.join('/');
}

function isInside(base: string, target: string): boolean {
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return target === base || target.startsWith(prefix);
}

const toRel = (base: string, abs: string) => path.relative(base, abs).split(path.sep).filter(Boolean).join('/');

async function realOrNotFound(p: string, message: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') throw notFound(message);
    throw err;
  }
}

/** Resolve o caminho dentro do projeto e devolve o caminho real (com os links seguidos) e o relativo a ele. */
async function resolveInside(root: string, rel: string): Promise<{ abs: string; realRoot: string; realRel: string }> {
  const lexical = path.resolve(root, rel);
  if (!isInside(root, lexical)) throw forbidden();
  const realRoot = await realOrNotFound(root, 'pasta do projeto não encontrada');
  const abs = await realOrNotFound(lexical, 'não encontrado');
  if (!isInside(realRoot, abs)) throw forbidden('o caminho sai do projeto (link simbólico)');
  return { abs, realRoot, realRel: toRel(realRoot, abs) };
}

function decodeText(bytes: Buffer): string {
  try {
    // ignoreBOM: o BOM fica no texto, para a gravação devolver o arquivo como estava.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ProjectFileError(415, 'arquivo não é texto UTF-8');
  }
}

export async function readProjectFile(root: string, rawPath: string): Promise<ProjectFile> {
  const rel = cleanRel(rawPath);
  if (isSecretRel(rel)) throw secretError();
  const { abs, realRel } = await resolveInside(root, rel);
  if (isSecretRel(realRel)) throw secretError();
  const st = await fs.stat(abs);
  if (!st.isFile()) throw notFound('não é um arquivo');
  if (st.size > MAX_FILE_BYTES) throw new ProjectFileError(413, 'arquivo grande demais (máx. 1 MB)');
  const bytes = await fs.readFile(abs);
  if (bytes.length > MAX_FILE_BYTES) throw new ProjectFileError(413, 'arquivo grande demais (máx. 1 MB)');
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) throw new ProjectFileError(415, 'arquivo binário: não é aberto como texto');
  return { path: rel, content: decodeText(bytes), mtimeMs: st.mtimeMs, size: bytes.length };
}

/** Os bytes de uma imagem do projeto, para visualizar. Mesmas regras de caminho e de segredo da leitura de texto. */
export async function readProjectImageFile(root: string, rawPath: string): Promise<{ bytes: Buffer; type: string }> {
  const rel = cleanRel(rawPath);
  if (isSecretRel(rel)) throw secretError();
  if (!IMAGE_TYPES[path.extname(rel).slice(1).toLowerCase()]) throw new ProjectFileError(415, 'não é uma imagem que dá para mostrar');
  const { abs, realRel } = await resolveInside(root, rel);
  if (isSecretRel(realRel)) throw secretError();
  // O tipo vale pelo arquivo de verdade: um link `a.png` que aponta para texto não sai como imagem.
  const realType = IMAGE_TYPES[path.extname(realRel).slice(1).toLowerCase()];
  if (!realType) throw new ProjectFileError(415, 'não é uma imagem que dá para mostrar');
  const st = await fs.stat(abs);
  if (!st.isFile()) throw notFound('não é um arquivo');
  const tooBig = () => new ProjectFileError(413, 'imagem grande demais (máx. 10 MB)');
  if (st.size > MAX_IMAGE_BYTES) throw tooBig();
  const bytes = await fs.readFile(abs);
  if (bytes.length > MAX_IMAGE_BYTES) throw tooBig(); // cresceu entre o stat e a leitura
  return { bytes, type: realType };
}

/** Uma pasta, um nível. Pastas primeiro, depois por nome (sem diferenciar maiúsculas). */
export async function listProjectTree(root: string, rawPath: string): Promise<{ entries: TreeEntry[] }> {
  const rel = cleanRel(rawPath);
  if (rel.split('/').some((p) => HIDDEN.has(p))) throw notFound('pasta oculta');
  const { abs, realRoot } = await resolveInside(root, rel);
  const dirStat = await fs.stat(abs);
  if (!dirStat.isDirectory()) throw notFound('não é uma pasta');

  const entries: TreeEntry[] = [];
  for (const dirent of await fs.readdir(abs, { withFileTypes: true })) {
    const name = dirent.name;
    if (HIDDEN.has(name)) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    // Link para fora do projeto: some da lista. Link para dentro: aparece com o alvo real.
    const real = await fs.realpath(path.join(abs, name)).catch(() => null);
    if (!real || !isInside(realRoot, real)) continue;
    const st = await fs.stat(real).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      entries.push({ name, path: childRel, type: 'dir' });
    } else if (st.isFile()) {
      const entry: TreeEntry = { name, path: childRel, type: 'file', size: st.size };
      if (isSecretRel(childRel) || isSecretRel(toRel(realRoot, real))) entry.locked = true;
      entries.push(entry);
    }
  }

  entries.sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) ||
      a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) ||
      a.name.localeCompare(b.name),
  );
  return { entries };
}

/** Valida o corpo do POST de gravação; tipo errado vira 400. */
export function parseWriteBody(body: unknown): WriteInput {
  if (!body || typeof body !== 'object') throw new ProjectFileError(400, 'corpo inválido');
  const b = body as Record<string, unknown>;
  if (typeof b.path !== 'string') throw new ProjectFileError(400, 'path precisa ser texto');
  if (typeof b.content !== 'string') throw new ProjectFileError(400, 'content precisa ser texto');
  if (typeof b.baseMtimeMs !== 'number' || !Number.isFinite(b.baseMtimeMs)) throw new ProjectFileError(400, 'baseMtimeMs precisa ser número');
  return { path: b.path, content: b.content, baseMtimeMs: b.baseMtimeMs };
}

/** Grava um arquivo que já existe, se ninguém mudou ele desde `baseMtimeMs`. Atômico: temporário + rename. */
export async function writeProjectFile(root: string, input: WriteInput): Promise<{ mtimeMs: number }> {
  const rel = cleanRel(input.path);
  if (isSecretRel(rel)) throw secretError();
  if (Buffer.byteLength(input.content, 'utf8') > MAX_FILE_BYTES) throw new ProjectFileError(413, 'conteúdo grande demais (máx. 1 MB)');
  const { abs, realRel } = await resolveInside(root, rel);
  if (isSecretRel(realRel)) throw secretError();
  const st = await fs.stat(abs);
  if (!st.isFile()) throw notFound('não é um arquivo');
  if (st.mtimeMs !== input.baseMtimeMs) {
    throw new ProjectFileError(409, 'o arquivo mudou no disco desde que foi aberto', { mtimeMs: st.mtimeMs });
  }
  await writeAtomic(abs, input.content, st.mode & 0o777);
  return { mtimeMs: (await fs.stat(abs)).mtimeMs };
}

export interface CreateInput {
  path: string;
  kind: 'file' | 'dir';
}

/** Valida o corpo do POST de criação; tipo errado vira 400. */
export function parseCreateBody(body: unknown): CreateInput {
  if (!body || typeof body !== 'object') throw new ProjectFileError(400, 'corpo inválido');
  const b = body as Record<string, unknown>;
  if (typeof b.path !== 'string') throw new ProjectFileError(400, 'path precisa ser texto');
  if (b.kind !== 'file' && b.kind !== 'dir') throw new ProjectFileError(400, 'kind precisa ser "file" ou "dir"');
  return { path: b.path, kind: b.kind };
}

// Nomes que o Windows não aceita (ou aceita e depois não abre): vale em qualquer sistema, o projeto pode ir para lá.
const WIN_BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function checkName(name: string): void {
  const bad = (why: string) => new ProjectFileError(400, `nome inválido: ${why}`);
  if (WIN_BAD_CHARS.test(name)) throw bad('não use < > : " | ? * nem caracteres de controle');
  if (/[ .]$/.test(name)) throw bad('não pode terminar com ponto ou espaço');
  if (WIN_RESERVED.test(name)) throw bad(`"${name}" é reservado no Windows`);
  if (Buffer.byteLength(name, 'utf8') > 255) throw bad('nome grande demais');
}

const isErr = (err: unknown, ...codes: string[]) => codes.includes((err as NodeJS.ErrnoException).code ?? '');

/**
 * Cria um arquivo vazio ou uma pasta. Nunca sobrescreve: o que já existe dá 409. Pastas intermediárias que
 * faltarem são criadas, mas só depois de conferir que cada pedaço que já existe fica dentro do projeto.
 */
export async function createProjectEntry(root: string, input: CreateInput): Promise<{ path: string }> {
  const rel = cleanRel(input.path);
  if (!rel) throw new ProjectFileError(400, 'informe o nome');
  const parts = rel.split('/');
  parts.forEach(checkName);
  if (isSecretRel(rel)) throw forbidden('caminho protegido: não é criado pelo Claudio’s Club');
  if (!isInside(root, path.resolve(root, rel))) throw forbidden();
  const realRoot = await realOrNotFound(root, 'pasta do projeto não encontrada');

  // Desce pelo que já existe seguindo os links; o primeiro pedaço que falta marca onde a criação começa.
  let cur = realRoot;
  let i = 0;
  for (; i < parts.length; i++) {
    const next = path.join(cur, parts[i]!);
    let real: string;
    try {
      real = await fs.realpath(next);
    } catch (err) {
      if (!isErr(err, 'ENOENT')) throw err;
      // Link quebrado também ocupa o nome.
      if (await fs.lstat(next).then(() => true, () => false)) throw new ProjectFileError(409, 'já existe algo com esse nome');
      break;
    }
    if (!isInside(realRoot, real)) throw forbidden('o caminho sai do projeto (link simbólico)');
    if (isSecretRel(toRel(realRoot, real))) throw forbidden('caminho protegido: não é criado pelo Claudio’s Club');
    if (i === parts.length - 1) throw new ProjectFileError(409, 'já existe algo com esse nome');
    if (!(await fs.stat(real)).isDirectory()) throw new ProjectFileError(409, `"${parts.slice(0, i + 1).join('/')}" é um arquivo, não uma pasta`);
    cur = real;
  }

  const target = path.join(cur, ...parts.slice(i));
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Flag exclusiva: se alguém criou no meio do caminho, dá EEXIST em vez de sobrescrever.
    if (input.kind === 'dir') await fs.mkdir(target);
    else await fs.writeFile(target, '', { flag: 'wx' });
  } catch (err) {
    if (isErr(err, 'EEXIST')) throw new ProjectFileError(409, 'já existe algo com esse nome');
    if (isErr(err, 'ENOTDIR')) throw new ProjectFileError(409, 'um pedaço do caminho é arquivo, não pasta');
    if (isErr(err, 'ENAMETOOLONG')) throw new ProjectFileError(400, 'caminho grande demais');
    throw err;
  }
  return { path: rel };
}

async function writeAtomic(abs: string, text: string, mode: number): Promise<void> {
  // Temporário na mesma pasta (o rename só é atômico no mesmo volume). O conteúdo vai exatamente como veio.
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', mode });
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
