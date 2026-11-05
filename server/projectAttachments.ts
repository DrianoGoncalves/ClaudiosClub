import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ProjectAttachment, ProjectAttachmentUpload } from '../shared/model';
import { ensureMycoGitignore } from './mycoGitignore';
import { ProjectFileError } from './projectFiles';

// Anexos do projeto: arquivos úteis (prints, docs, PDFs) guardados em `<projeto>/.myco/attachments/`, sem
// subpastas. O anexo é sempre só um nome de arquivo; o caminho é montado aqui, com o realpath da pasta
// conferido (link simbólico que desvia a pasta é recusado). Nunca sobrescreve: nome repetido ganha " (2)".

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Tamanho máximo do nome, em caracteres (o limite dos sistemas de arquivos é 255 bytes). */
const MAX_NAME_CHARS = 120;
const MAX_EXT_CHARS = 16;
/** Folga para o sufixo " (999)". */
const SUFFIX_ROOM = 8;
const MAX_TRIES = 999;

/** Só estes saem inline (pré-visualização). SVG, HTML e PDF nunca: rodam script ou abrem como página. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

// Nomes que o Windows não aceita (ou aceita e depois não abre): vale em qualquer sistema, o projeto pode ir para lá.
const WIN_BAD_CHARS = /[<>:"|?*\x00-\x1f\x7f]/;
const WIN_BAD_CHARS_G = new RegExp(WIN_BAD_CHARS.source, 'g');
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const forbidden = (message: string) => new ProjectFileError(403, message);
const badName = (why: string) => new ProjectFileError(400, `nome inválido: ${why}`);
const isErr = (err: unknown, ...codes: string[]) => codes.includes((err as NodeJS.ErrnoException).code ?? '');

export const mimeOf = (name: string): string => MIME[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
const isPreviewable = (type: string) => INLINE_TYPES.has(type);

/** O anexo é só um nome: separador, caminho absoluto, "." e ".." são tentativa de sair da pasta (403). */
function rejectPathLike(raw: string): void {
  if (raw.includes('\0') || /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw === '.' || raw === '..') {
    throw forbidden('o anexo é só um nome de arquivo, sem caminho');
  }
}

/** Nome de um anexo que já existe (baixar, apagar): tem de ser exatamente um nome que o envio poderia ter gravado. */
function storedName(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) throw new ProjectFileError(400, 'informe o nome do anexo');
  rejectPathLike(raw);
  if (WIN_BAD_CHARS.test(raw) || raw.startsWith('.') || /[ .]$/.test(raw) || WIN_RESERVED.test(raw) || Buffer.byteLength(raw, 'utf8') > 255) {
    throw badName('esse nome não é de um anexo');
  }
  return raw;
}

interface UploadName {
  stem: string;
  ext: string;
}

/** Nome do envio: caminho é recusado; caractere inválido vira "_"; ponto inicial e final saem; nome longo é encurtado. */
export function cleanUploadName(raw: unknown): UploadName {
  if (typeof raw !== 'string') throw new ProjectFileError(400, 'informe o nome do arquivo');
  rejectPathLike(raw);
  const n = raw
    .normalize('NFC')
    .replace(WIN_BAD_CHARS_G, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (!n) throw new ProjectFileError(400, 'informe o nome do arquivo');
  if (WIN_RESERVED.test(n)) throw badName(`"${n}" é reservado no Windows`);
  let ext = path.extname(n);
  if (Array.from(ext).length > MAX_EXT_CHARS) ext = '';
  let stem = Array.from(n.slice(0, n.length - ext.length))
    .slice(0, MAX_NAME_CHARS - Array.from(ext).length - SUFFIX_ROOM)
    .join('')
    .replace(/[. ]+$/, '');
  if (!stem) stem = 'arquivo';
  return { stem, ext };
}

/**
 * Pasta de anexos já conferida. O realpath tem de ser exatamente `<projeto>/.myco/attachments`: se `.myco` ou
 * `attachments` for um link que leva a outro lugar, recusa. Sem `create`, pasta que não existe devolve null.
 */
async function attachmentsDir(root: string, create: boolean): Promise<string | null> {
  const realRoot = await fs.realpath(root).catch(() => {
    throw new ProjectFileError(404, 'pasta do projeto não encontrada');
  });
  const lexical = path.join(realRoot, '.myco', 'attachments');
  if (create) await fs.mkdir(lexical, { recursive: true });
  let real: string;
  try {
    real = await fs.realpath(lexical);
  } catch (err) {
    if (isErr(err, 'ENOENT', 'ENOTDIR')) return null;
    throw err;
  }
  if (path.relative(lexical, real) !== '') throw forbidden('a pasta de anexos desvia para outro lugar (link simbólico)');
  return real;
}

function toAttachment(name: string, st: { size: number; mtimeMs: number }): ProjectAttachment {
  const type = mimeOf(name);
  return { name, size: st.size, mtimeMs: st.mtimeMs, type, previewable: isPreviewable(type) };
}

export async function listAttachments(root: string): Promise<{ attachments: ProjectAttachment[]; maxBytes: number }> {
  const dir = await attachmentsDir(root, false);
  const attachments: ProjectAttachment[] = [];
  if (dir) {
    for (const name of await fs.readdir(dir)) {
      // Temporários do envio (começam com ponto) e tudo que não for arquivo comum ficam de fora.
      try {
        storedName(name);
      } catch {
        continue;
      }
      const st = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (st?.isFile()) attachments.push(toAttachment(name, st));
    }
  }
  attachments.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }) || a.name.localeCompare(b.name));
  return { attachments, maxBytes: MAX_ATTACHMENT_BYTES };
}

/** Cabeçalhos de download: nunca HTML/SVG/PDF inline; só raster pode ser pré-visualizado. */
export function downloadHeaders(name: string, type: string): Record<string, string> {
  const disposition = isPreviewable(type) ? 'inline' : 'attachment';
  // `filename` só com ASCII seguro (para clientes antigos); `filename*` leva o nome real (RFC 5987/8187).
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'content-disposition': `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
    // Defesa extra se o navegador abrir o arquivo mesmo assim: sem script, sem recursos, em sandbox.
    'content-security-policy': "default-src 'none'; sandbox",
  };
}

export async function readAttachment(
  root: string,
  rawName: unknown,
): Promise<{ bytes: Buffer; type: string; headers: Record<string, string> }> {
  const name = storedName(rawName);
  const notFound = () => new ProjectFileError(404, 'anexo não encontrado');
  const dir = await attachmentsDir(root, false);
  if (!dir) throw notFound();
  const target = path.join(dir, name);
  const st = await fs.lstat(target).catch(() => null);
  if (!st) throw notFound();
  if (st.isSymbolicLink()) throw forbidden('o anexo é um link simbólico');
  if (!st.isFile()) throw notFound();
  const tooBig = () => new ProjectFileError(413, 'anexo grande demais (máx. 10 MB)');
  if (st.size > MAX_ATTACHMENT_BYTES) throw tooBig();
  const bytes = await fs.readFile(target);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw tooBig(); // cresceu entre o lstat e a leitura
  // Tipo (e, portanto, inline ou não) vem do nome gravado, nunca do que o cliente disse no envio.
  const type = mimeOf(name);
  return { bytes, type, headers: downloadHeaders(name, type) };
}

/** Grava `bytes` em `<pasta>/<name>` sem sobrescrever: o link físico do temporário falha com EEXIST se o nome existe. */
async function placeAtomic(dir: string, tmp: string, stem: string, ext: string): Promise<string> {
  for (let n = 1; n <= MAX_TRIES; n++) {
    const name = n === 1 ? `${stem}${ext}` : `${stem} (${n})${ext}`;
    const target = path.join(dir, name);
    try {
      await fs.link(tmp, target);
      return name;
    } catch (err) {
      if (isErr(err, 'EEXIST')) continue;
      // Sistema de arquivos sem link físico (ex.: exFAT): confere e renomeia.
      if (!isErr(err, 'EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP', 'EXDEV')) throw err;
      if (await fs.lstat(target).then(() => true, () => false)) continue;
      await fs.rename(tmp, target);
      return name;
    }
  }
  throw new ProjectFileError(409, 'já existem anexos demais com esse nome');
}

/** Guarda um anexo. Escrita: só pela página do Claudio’s Club. */
export async function saveAttachment(root: string, rawName: unknown, body: unknown, fromBrowser: boolean): Promise<ProjectAttachmentUpload> {
  if (!fromBrowser) throw forbidden('anexos só são enviados pelo Claudio’s Club');
  const { stem, ext } = cleanUploadName(rawName);
  if (!Buffer.isBuffer(body)) throw new ProjectFileError(400, 'corpo inválido: envie os bytes do arquivo');
  if (body.length === 0) throw new ProjectFileError(400, 'arquivo vazio');
  if (body.length > MAX_ATTACHMENT_BYTES) throw new ProjectFileError(413, 'arquivo grande demais (máx. 10 MB)');

  const dir = (await attachmentsDir(root, true))!;
  await ensureMycoGitignore(root);
  // Temporário na mesma pasta (o link/rename só é atômico no mesmo volume); começa com ponto, então a lista o ignora.
  const tmp = path.join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, body, { flag: 'wx' });
    const name = await placeAtomic(dir, tmp, stem, ext);
    const st = await fs.stat(path.join(dir, name));
    return { ...toAttachment(name, st), renamed: name !== rawName };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/** Apaga um anexo. Escrita: só pela página do Claudio’s Club. */
export async function deleteAttachment(root: string, rawName: unknown, fromBrowser: boolean): Promise<{ ok: true }> {
  if (!fromBrowser) throw forbidden('anexos só são apagados pelo Claudio’s Club');
  const name = storedName(rawName);
  const notFound = () => new ProjectFileError(404, 'anexo não encontrado');
  const dir = await attachmentsDir(root, false);
  if (!dir) throw notFound();
  const target = path.join(dir, name);
  const st = await fs.lstat(target).catch(() => null);
  // Link simbólico é apagado como link (o alvo não é tocado), mas só se for arquivo ou link: pasta não.
  if (!st || !(st.isFile() || st.isSymbolicLink())) throw notFound();
  await fs.unlink(target);
  return { ok: true };
}
