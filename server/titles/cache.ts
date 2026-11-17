import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MYCO_HOME } from '../config';
import { writeAtomic } from '../staff/store';

// Títulos gerados: MYCO_HOME/cache/ai-titles.json, uma entrada por conversa (assunto novo substitui a antiga). Mesma regra
// do registro de conversas: arquivo que existe e não lê não é regravado por cima (apagaria entradas), então os títulos
// ficam de fora até ele ser consertado.

export const AI_TITLES_FILE = path.join(MYCO_HOME, 'cache', 'ai-titles.json');

export type TitleStatus = 'ok' | 'skip' | 'failed';

export interface TitleEntry {
  /** Id do assunto (ver titles/subject.ts): se o assunto mudou, a entrada vale menos. */
  subjectKey: string;
  /** Versão de como se gera (ver GEN_VERSION no gerador). */
  gen: number;
  status: TitleStatus;
  title?: string;
  /** ISO da última tentativa. */
  at: string;
}

const STATUSES = new Set<string>(['ok', 'skip', 'failed']);

function isEntry(v: unknown): v is TitleEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.subjectKey === 'string' &&
    typeof e.gen === 'number' &&
    typeof e.status === 'string' &&
    STATUSES.has(e.status) &&
    typeof e.at === 'string' &&
    (e.title === undefined || typeof e.title === 'string')
  );
}

/** Lê o arquivo: ausente = vazio; existe e não lê = 'broken' (quem chama não regrava). */
async function readEntries(file: string): Promise<Map<string, TitleEntry> | 'broken'> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? new Map() : 'broken';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return 'broken';
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return 'broken';
  const out = new Map<string, TitleEntry>();
  for (const [k, v] of Object.entries(entries as Record<string, unknown>)) if (isEntry(v)) out.set(k, v);
  return out;
}

export class AiTitleCache {
  private entries: Map<string, TitleEntry> | null = null;
  private broken = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string = AI_TITLES_FILE,
    private readonly log: (line: string) => void = (line) => console.log(line),
  ) {}

  /** Chave da entrada: uma por conversa. */
  static keyOf(projectId: string, engine: string, sessionId: string): string {
    return `${projectId}|${engine}|${sessionId}`;
  }

  async get(key: string): Promise<TitleEntry | undefined> {
    return (await this.load()).get(key);
  }

  set(key: string, entry: TitleEntry): Promise<void> {
    return this.serial(async () => {
      const all = await this.load();
      if (this.broken) return;
      all.set(key, entry);
      await this.save(all);
    });
  }

  /** Tira as entradas destas conversas (apagadas pela retenção). */
  forget(sessionIds: string[]): Promise<void> {
    const ids = new Set(sessionIds);
    return this.serial(async () => {
      const all = await this.load();
      if (this.broken) return;
      let changed = false;
      for (const key of [...all.keys()]) {
        if (ids.has(key.split('|').at(-1) ?? '')) {
          all.delete(key);
          changed = true;
        }
      }
      if (changed) await this.save(all);
    });
  }

  private async load(): Promise<Map<string, TitleEntry>> {
    if (this.entries) return this.entries;
    const loaded = await readEntries(this.file);
    if (loaded === 'broken') {
      // Sem cache em memória: a próxima chamada lê de novo (um erro de leitura passa).
      if (!this.broken) this.log(`[titulos] não consegui ler ${this.file}: os títulos ficam de fora e o arquivo não é regravado`);
      this.broken = true;
      return new Map();
    }
    this.broken = false;
    this.entries = loaded;
    return loaded;
  }

  private async save(all: Map<string, TitleEntry>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await writeAtomic(this.file, JSON.stringify({ version: 1, entries: Object.fromEntries(all) }, null, 2) + '\n');
  }

  /** Uma gravação por vez: a ordem das chamadas é a ordem da escrita. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(job);
    this.queue = run;
    return run;
  }
}
