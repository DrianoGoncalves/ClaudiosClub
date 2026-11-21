import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './atomicWrite';
import { dirtyOf, EXTRA_MAX, type GitRun, type SlotFound } from './autoCommit';
import { pathKey } from './ownerEdits';

// A foto da vaga de escrita (t-80893a). Com `singleWriter` ligado só o dono da vaga edita o checkout principal enquanto a segura, então o que mudou no projeto desde que ele a ocupou é dele, inclusive
// o que ele fez por shell ou script e que `Task.changedFiles` não vê (server/chat/codeEdits.ts). Ao ocupar a vaga o TaskService tira esta foto: cada arquivo que já estava sujo no git e o hash do
// conteúdo. Ao fechar, o commit automático compara: arquivo sujo agora e fora da foto, ou com hash diferente, entra; arquivo sujo na foto e igual fica de fora (é de antes da vaga).
//
// Fica em `<projeto>/.myco/write-slot.json` (fora do git), um registro por tarefa, para sobreviver a reinício. Nada é escrito no repositório: o hash é calculado aqui (sha1 do conteúdo, sem filtros),
// não pelo `git hash-object -w`. Limites: mais de `SNAPSHOT_MAX` arquivos sujos, ou o git que não responde, e a foto vira um registro sem arquivos (`why`), com o commit voltando a só `changedFiles`;
// arquivo grande (`BIG_FILE`, ou o que passa do orçamento total de leitura) é comparado por tamanho e mtime, não por conteúdo. Limite aceito: o git não diz de quem é a mudança, então a edição do dono
// por fora do editor do Club durante a vaga é indistinguível da da tarefa (a do editor do Club segue de fora, ver ownerEdits.ts), e o arquivo que já estava sujo e foi mexido de novo leva o commit
// inteiro dele, o trecho de antes junto.

/** Arquivos sujos que a foto aceita; acima disso ela não guarda nada (`why: 'cap'`). */
export const SNAPSHOT_MAX = 5000;
/** Acima disto o arquivo é comparado por tamanho e mtime. */
const BIG_FILE = 8 * 1024 * 1024;
/** O que a foto lê de conteúdo no total (cada arquivo grande que sobrar usa a assinatura rápida). */
const READ_BUDGET = 256 * 1024 * 1024;
/** O git (status) e a foto inteira: a partida do card espera por ela, então não passa de segundos. */
const GIT_TIMEOUT_MS = 15_000;
const TAKE_TIMEOUT_MS = 30_000;
const PARALLEL = 8;

/** Uma foto: `files` é `pathKey(caminho)` → impressão do conteúdo; null = não deu para tirar (`why`). `at` identifica a foto (quem a tirou só a apaga se ainda for a dele). */
export interface SlotSnapshot {
  at: string;
  files: Record<string, string> | null;
  why?: 'cap' | 'git';
}

const snapFile = (dir: string) => path.join(dir, '.myco', 'write-slot.json');

/** As fotos do projeto, por id de tarefa; ausente, ilegível ou torto vale vazio (o commit só volta a `changedFiles`, nunca erra). */
export async function readSnapshots(dir: string): Promise<Record<string, SlotSnapshot>> {
  const raw = await fs.readFile(snapFile(dir), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Record<string, SlotSnapshot> = {};
    for (const [id, v] of Object.entries(data)) {
      const s = v as Partial<SlotSnapshot> | null;
      if (!s || typeof s.at !== 'string') continue;
      if (s.files === null) out[id] = { at: s.at, files: null, why: s.why === 'git' ? 'git' : 'cap' };
      else if (s.files && typeof s.files === 'object' && !Array.isArray(s.files) && Object.values(s.files).every((h) => typeof h === 'string')) out[id] = { at: s.at, files: s.files };
    }
    return out;
  } catch {
    return {};
  }
}

const queues = new Map<string, Promise<void>>();

/**
 * Muda as fotos do projeto, uma gravação por vez (duas juntas não se perdem). `fn` muda o objeto e devolve true se mudou algo: sem mudança nada é gravado, e um projeto sem foto nunca cria o arquivo.
 * Sem nenhuma foto sobrando, o arquivo some.
 */
export function updateSnapshots(dir: string, fn: (all: Record<string, SlotSnapshot>) => boolean): Promise<void> {
  const file = snapFile(dir);
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    const all = await readSnapshots(dir);
    if (!fn(all)) return;
    if (!Object.keys(all).length) await fs.rm(file, { force: true });
    else await writeAtomic(file, JSON.stringify(all) + '\n');
  });
  queues.set(file, run.catch(() => {}));
  return run;
}

/** O que identifica o conteúdo (ou o estado) do arquivo: o hash; para o que não é arquivo regular ou é grande, o tamanho e o mtime; `-` para o que não existe (apagado). Nunca lança. */
async function fingerprint(abs: string, budget: { left: number }): Promise<string> {
  try {
    const st = await fs.lstat(abs);
    if (st.isSymbolicLink()) return `l:${await fs.readlink(abs)}`;
    if (!st.isFile() || st.size > BIG_FILE || st.size > budget.left) return `s:${st.size}:${Math.trunc(st.mtimeMs)}`;
    budget.left -= st.size;
    const h = createHash('sha1');
    for await (const chunk of createReadStream(abs)) h.update(chunk as Buffer);
    return `h:${h.digest('hex')}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? '-' : `e:${code ?? 'erro'}`;
  }
}

/** `fn` em cada item, `PARALLEL` por vez. */
async function pool<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
}

/** `.myco/` é do Club (tarefas, fichas, memórias: gravado o tempo todo) e não é código; nunca entra na foto nem no que ela acha. */
const inMyco = (rel: string): boolean => rel.split('/')[0]!.toLowerCase() === '.myco';

/** Corre `work` contra o prazo da foto: estourou, é erro de git (a partida segue, sem foto). */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('tempo esgotado')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** Tira a foto do que está sujo agora. Nunca lança: o que não deu vira uma foto sem arquivos, com o motivo. */
export async function takeSnapshot(dir: string, git?: GitRun): Promise<SlotSnapshot> {
  const at = new Date().toISOString();
  try {
    return await within(TAKE_TIMEOUT_MS, (async (): Promise<SlotSnapshot> => {
      const dirty = [...(await dirtyOf(dir, git, GIT_TIMEOUT_MS)).values()].filter((e) => !inMyco(e.path));
      if (dirty.length > SNAPSHOT_MAX) return { at, files: null, why: 'cap' };
      const files: Record<string, string> = {};
      const budget = { left: READ_BUDGET };
      await pool(dirty, async (e) => void (files[pathKey(e.path)] = await fingerprint(path.join(dir, e.path), budget)));
      return { at, files };
    })());
  } catch {
    return { at, files: null, why: 'git' };
  }
}

/**
 * O que mudou desde a foto, para o commit automático: os arquivos sujos agora que não estavam sujos na foto, ou que estavam e o conteúdo mudou. O que estava sujo e igual fica de fora (é de antes da
 * vaga), e o que a foto tinha sujo e hoje está limpo (commitado por você, desfeito) não conta. Nunca lança.
 */
export async function changedSince(dir: string, snap: SlotSnapshot, git?: GitRun): Promise<SlotFound> {
  if (!snap.files) return { skipped: snap.why ?? 'cap' };
  const before = snap.files;
  try {
    return await within(TAKE_TIMEOUT_MS, (async (): Promise<SlotFound> => {
      const extra: string[] = [];
      const same: Array<{ path: string; was: string }> = [];
      for (const e of (await dirtyOf(dir, git, GIT_TIMEOUT_MS)).values()) {
        if (inMyco(e.path)) continue;
        const was = before[pathKey(e.path)];
        if (was === undefined) extra.push(e.path);
        else same.push({ path: e.path, was });
      }
      const budget = { left: READ_BUDGET };
      await pool(same, async (s) => {
        if ((await fingerprint(path.join(dir, s.path), budget)) !== s.was) extra.push(s.path);
      });
      if (extra.length > EXTRA_MAX) return { skipped: 'limit', found: extra.length };
      return { extra: extra.sort() };
    })());
  } catch {
    return { skipped: 'git' };
  }
}
