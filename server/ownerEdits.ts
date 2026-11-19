import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomicWrite';
import { cleanRel, writeProjectFile, type WriteInput } from './projectFiles';

// O que você gravou pelo editor do Claudio’s Club (rota `files/write`), por projeto, em `<projeto>/.myco/owner-edits.json`: o caminho, o mtime que o arquivo ficou e a hora. O commit
// automático (server/autoCommit.ts) usa para não levar para o commit de uma tarefa o arquivo que você mexeu DEPOIS da última edição dela: se o mtime do arquivo ainda é o da sua
// gravação, ninguém mexeu nele desde então. Fica fora do git (`.myco/`) e com teto: passando de `MAX_OWNER_EDITS`, saem as mais antigas. Editor externo (VS Code, vim…) não passa
// por aqui: o Club não vê essas gravações.

export interface OwnerWrite {
  /** O mtime do arquivo logo depois da sua gravação (o que `writeProjectFile` devolve). */
  mtimeMs: number;
  at: string;
}

export const MAX_OWNER_EDITS = 500;

const ownerFile = (dir: string) => path.join(dir, '.myco', 'owner-edits.json');

/** No Windows o disco não diferencia maiúsculas: o mesmo arquivo pode chegar escrito de dois jeitos (o editor e a ferramenta do funcionário). */
export const pathKey = (rel: string): string => (process.platform === 'win32' ? rel.toLowerCase() : rel);

/** As gravações do projeto, pelo `pathKey` do caminho; ausente, ilegível ou torto vira vazio (o commit só deixa de ver, nunca erra). */
export async function readOwnerWrites(dir: string): Promise<Record<string, OwnerWrite>> {
  const raw = await fs.readFile(ownerFile(dir), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Record<string, OwnerWrite> = {};
    for (const [k, v] of Object.entries(data)) {
      const w = v as Partial<OwnerWrite> | null;
      if (w && typeof w.mtimeMs === 'number' && Number.isFinite(w.mtimeMs) && typeof w.at === 'string') out[k] = { mtimeMs: w.mtimeMs, at: w.at };
    }
    return out;
  } catch {
    return {};
  }
}

const queues = new Map<string, Promise<void>>();

/** Guarda a gravação (uma por vez por projeto: duas gravações juntas não se perdem). O teto tira as mais antigas. */
export function recordOwnerWrite(dir: string, rel: string, mtimeMs: number, at = new Date()): Promise<void> {
  const file = ownerFile(dir);
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    const all = await readOwnerWrites(dir);
    all[pathKey(rel)] = { mtimeMs, at: at.toISOString() };
    const keep = Object.entries(all)
      .sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0))
      .slice(0, MAX_OWNER_EDITS);
    await writeAtomic(file, JSON.stringify(Object.fromEntries(keep), null, 2) + '\n');
  });
  queues.set(file, run.catch(() => {}));
  return run;
}

/**
 * A gravação da rota `files/write`: grava o arquivo (`writeProjectFile`, com todas as suas conferências) e só depois registra a gravação. Não conseguir registrar (disco, permissão)
 * não desfaz nem falha a sua gravação: o pior caso é o commit automático não saber que o arquivo é seu.
 */
export async function writeOwnerFile(dir: string, input: WriteInput): Promise<{ mtimeMs: number }> {
  const out = await writeProjectFile(dir, input);
  await recordOwnerWrite(dir, cleanRel(input.path), out.mtimeMs).catch(() => {});
  return out;
}
