import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { TestRun } from '../shared/model';
import { writeAtomic } from './atomicWrite';
import { ensureMycoGitignore } from './mycoGitignore';
import { IDS_MAX } from './testFailures';

// A memória das provas da entrega (`<projeto>/.myco/proof-baseline.json`, fora do git: ver mycoGitignore.ts): o que falhava num commit da base, para a entrega separar a falha que já existia da que ela trouxe.
// Três tipos de chave, todas por commit (sha inteiro): `suite:<sha>` = a suíte completa rodada naquele commit (a mescla roda a suíte inteira: ver `recordSuite`); `tsc:<sha>` = os erros de tipos; `file:<sha>:<arquivo>` =
// um arquivo de teste rodado sozinho no checkout da base. Um commit nunca muda, então a entrada não vence: só sai quando passa de `ENTRIES_MAX` (as mais antigas).

const ENTRIES_MAX = 60;

export interface BaselineEntry {
  at: string;
  /** As falhas (ids de teste, ou de erro do tsc) que havia naquele commit. */
  ids: string[];
  /** A leitura viu TODAS as falhas: sem isso, "não está em `ids`" não prova que passava (a lista passou do teto). */
  complete: boolean;
  /** `file:`: o arquivo existia naquele commit e rodou; ausente/falso = o arquivo é novo desta entrega. */
  present?: boolean;
}

export type BaselineStore = Record<string, BaselineEntry>;

export const suiteKey = (sha: string): string => `suite:${sha}`;
export const tscKey = (sha: string): string => `tsc:${sha}`;
export const fileKey = (sha: string, file: string): string => `file:${sha}:${file}`;

const fileOf = (dir: string) => path.join(dir, '.myco', 'proof-baseline.json');

/** Uma gravação por vez por projeto (ler, juntar e gravar não se perdem entre duas entregas juntas). */
const queues = new Map<string, Promise<void>>();

function valid(e: unknown): e is BaselineEntry {
  const x = e as Partial<BaselineEntry> | null;
  return !!x && typeof x === 'object' && typeof x.at === 'string' && typeof x.complete === 'boolean' && Array.isArray(x.ids) && x.ids.every((id) => typeof id === 'string');
}

/** O arquivo como mapa; ausente, ilegível ou torto vira vazio (a gravação refaz), e entrada torta é ignorada. */
export async function readBaseline(dir: string): Promise<BaselineStore> {
  const raw = await fs.readFile(fileOf(dir), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as { v?: unknown; entries?: unknown };
    if (data?.v !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) return {};
    return Object.fromEntries(Object.entries(data.entries).filter(([, e]) => valid(e))) as BaselineStore;
  } catch {
    return {};
  }
}

/**
 * Junta `items` ao arquivo (a entrada nova troca a velha da mesma chave) e guarda só as `ENTRIES_MAX` mais recentes. Nunca lança: a memória é só ganho de tempo. Só grava em projeto que já tem `.myco/`
 * (a pasta do Club): não cria uma em pasta que não é dele, e garante o `.gitignore` dela antes (o arquivo é máquina, não vai para o git).
 */
export function putBaseline(dir: string, items: BaselineStore): Promise<void> {
  const key = path.resolve(dir);
  const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
    if (!(await fs.stat(path.join(dir, '.myco')).then((s) => s.isDirectory(), () => false))) return;
    await ensureMycoGitignore(dir).catch(() => {});
    const merged = { ...(await readBaseline(dir)), ...items };
    const keep = Object.entries(merged)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, ENTRIES_MAX);
    await writeAtomic(fileOf(dir), JSON.stringify({ v: 1, entries: Object.fromEntries(keep) }, null, 2) + '\n');
  });
  const safe = run.catch(() => {});
  queues.set(key, safe);
  void safe.then(() => {
    if (queues.get(key) === safe) queues.delete(key);
  });
  return safe;
}

/**
 * Guarda o resultado de uma suíte completa que rodou num commit conhecido (a mescla, depois de commitar: a árvore testada é a do commit). Rodada cortada no tempo, cancelada ou que nem abriu não conta,
 * e uma lista de falhas que passou do teto não prova ausência (`complete: false`).
 */
export function recordSuite(dir: string, sha: string, run: TestRun | null): Promise<void> {
  if (!run || run.timedOut || run.aborted || run.spawnFailed) return Promise.resolve();
  const ids = run.failureIds ?? [];
  if (!run.ok && !ids.length) return Promise.resolve();
  return putBaseline(dir, { [suiteKey(sha)]: { at: new Date().toISOString(), ids, complete: run.ok || ids.length < IDS_MAX } });
}
