import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import type { LinkInfo } from '../../../shared/model';

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Junctions do Windows aparecem como symlink no Node. */
export async function linkInfo(p: string): Promise<LinkInfo> {
  const st = await fs.lstat(p);
  if (st.isSymbolicLink()) {
    const raw = await fs.readlink(p).catch(() => null);
    return { kind: 'symlink', target: raw === null ? null : absoluteTarget(p, raw) };
  }
  if (st.isFile() && st.nlink > 1) return { kind: 'hardlink', target: null };
  return { kind: 'file', target: null };
}

/** Destinos podem vir relativos ao link ou, em junctions, com o prefixo `\\?\`. */
function absoluteTarget(linkPath: string, raw: string): string {
  return path.resolve(path.dirname(linkPath), raw.replace(/^\\\\\?\\/, ''));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Lê só o começo e o fim de um arquivo (transcripts passam de MB) e devolve as linhas completas
 * de cada trecho. Arquivos pequenos são lidos inteiros, e `head` e `tail` trazem as mesmas linhas.
 */
export async function readHeadTail(
  file: string,
  bytes = 64 * 1024,
): Promise<{ head: string[]; tail: string[]; size: number }> {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const read = async (position: number, length: number) => {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= bytes * 2) {
      const lines = splitLines(await read(0, size));
      return { head: lines, tail: lines, size };
    }
    const head = (await read(0, bytes)).split('\n');
    head.pop(); // última linha cortada
    const tail = (await read(size - bytes, bytes)).split('\n');
    tail.shift(); // primeira linha cortada
    return { head: head.filter(Boolean), tail: tail.filter(Boolean), size };
  } finally {
    await fh.close();
  }
}

function splitLines(text: string): string[] {
  return text.split('\n').filter(Boolean);
}

/** JSON.parse que devolve null em vez de lançar. */
export function tryJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
