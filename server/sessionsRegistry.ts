import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MYCO_HOME } from './config';
import { writeAtomic } from './staff/store';

// Registro das conversas que o Claudio’s Club lançou: MYCO_HOME/sessions-registry.json. Fica fora de run/ (a limpeza de
// run/ apaga pastas com mais de 3 dias). Só entra o que o Club abriu; conversa do usuário fora do Club nunca entra.
// A exclusão (etapa posterior) mexe só nestas entradas. O codex-thread.json de run/ não é tocado: o threadId vai junto.
//
// Formato: { "version": 1, "sessions": { "<sessionId>": { engine, projectPath, cwd, staffId?, threadId?, createdAt } } }
// Regra de segurança: arquivo ausente = registro vazio; arquivo que existe mas não lê (JSON inválido, EBUSY, EPERM…) = erro,
// e então NADA é regravado (regravar um registro lido pela metade apagaria entradas).

export const REGISTRY_FILE = path.join(MYCO_HOME, 'sessions-registry.json');

const ENGINES = ['claude', 'codex'] as const;
export type RegisteredEngine = (typeof ENGINES)[number];

/** Id da conversa do Club (randomUUID). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** thread_id do Codex: letras, números e hífen. */
const THREAD_ID = /^[0-9A-Za-z-]+$/;

export interface RegisteredSession {
  engine: RegisteredEngine;
  /** Pasta do projeto. */
  projectPath: string;
  /** Pasta real da sessão (a worktree, quando roda noutra pasta que o projeto). */
  cwd: string;
  /** Ficha do funcionário; ausente em conversa avulsa (freela). */
  staffId?: string;
  /** thread_id do Codex, quando já se sabe (o Codex dá no primeiro turno). */
  threadId?: string;
  /** ISO, na hora do lançamento. */
  createdAt: string;
}

export interface NewRegisteredSession {
  sessionId: string;
  engine: RegisteredEngine;
  projectPath: string;
  cwd: string;
  staffId?: string | null;
  threadId?: string | null;
  /** Só para os testes. */
  at?: Date;
}

/** Arquivo que existe e não se lê: quem chama decide (o lançamento só registra o aviso no log). */
export class RegistryReadError extends Error {}
/** Id ou thread_id fora do formato: nada é gravado. */
export class RegistryInputError extends Error {}

// Entrada estranha (editada à mão) some na leitura; as outras seguem.
const ENTRY = z.object({
  engine: z.enum(ENGINES),
  projectPath: z.string().min(1),
  cwd: z.string().min(1),
  staffId: z.string().min(1).optional().catch(undefined),
  threadId: z.string().regex(THREAD_ID).optional().catch(undefined),
  createdAt: z.string().datetime(),
});

/** Uma gravação por vez por arquivo: a ordem das chamadas é a ordem de gravação, e nenhuma pisa na outra. */
const queues = new Map<string, Promise<unknown>>();
function serial<T>(file: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(job);
  queues.set(file, run);
  return run;
}

/** Tudo que o registro conhece. Entradas fora do formato ficam de fora; arquivo que não lê lança RegistryReadError. */
export async function readSessionRegistry(file = REGISTRY_FILE): Promise<Map<string, RegisteredSession>> {
  return loadAll(file);
}

async function loadAll(file: string): Promise<Map<string, RegisteredSession>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new RegistryReadError(`não consegui ler o registro de conversas (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, '')); // editado à mão no Windows pode vir com BOM
  } catch {
    throw new RegistryReadError('o registro de conversas não é JSON válido');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new RegistryReadError('o registro de conversas tem formato inesperado');
  const sessions = (parsed as { sessions?: unknown }).sessions ?? {};
  if (typeof sessions !== 'object' || Array.isArray(sessions)) throw new RegistryReadError('o registro de conversas tem formato inesperado');
  const out = new Map<string, RegisteredSession>();
  for (const [id, entry] of Object.entries(sessions as Record<string, unknown>)) {
    if (!SESSION_ID.test(id)) continue;
    const ok = ENTRY.safeParse(entry);
    if (ok.success) out.set(id, ok.data);
  }
  return out;
}

/** A entrada de uma conversa do Club, ou null (não lançada pelo Club, ou lançada antes do registro). */
export async function getRegisteredSession(sessionId: string, file = REGISTRY_FILE): Promise<RegisteredSession | null> {
  return (await loadAll(file)).get(sessionId) ?? null;
}

async function saveAll(file: string, all: Map<string, RegisteredSession>): Promise<void> {
  await writeAtomic(file, JSON.stringify({ version: 1, sessions: Object.fromEntries(all) }, null, 2) + '\n');
}

/**
 * Grava uma conversa que o Club acabou de lançar. Se já existe (ela foi reaberta), mantém o `createdAt` e o que já tinha
 * (ficha, threadId) quando o pedido não traz. Id fora do formato, ou arquivo que não lê: lança erro e não grava.
 */
export function recordSession(s: NewRegisteredSession, file = REGISTRY_FILE): Promise<void> {
  if (!SESSION_ID.test(s.sessionId)) return Promise.reject(new RegistryInputError(`id de conversa inválido: ${s.sessionId}`));
  if (s.threadId && !THREAD_ID.test(s.threadId)) return Promise.reject(new RegistryInputError('thread_id inválido'));
  return serial(file, async () => {
    const all = await loadAll(file);
    const prev = all.get(s.sessionId);
    const staffId = s.staffId ?? prev?.staffId;
    const threadId = s.threadId ?? prev?.threadId;
    all.set(s.sessionId, {
      engine: s.engine,
      projectPath: s.projectPath,
      cwd: s.cwd,
      createdAt: prev?.createdAt ?? (s.at ?? new Date()).toISOString(),
      ...(staffId ? { staffId } : {}),
      ...(threadId ? { threadId } : {}),
    });
    await saveAll(file, all);
  });
}

/** Tira do registro as conversas apagadas. Arquivo que não lê: lança erro e não grava. */
export function removeFromRegistry(ids: string[], file = REGISTRY_FILE): Promise<void> {
  return serial(file, async () => {
    const all = await loadAll(file);
    let changed = false;
    for (const id of ids) changed = all.delete(id) || changed;
    if (changed) await saveAll(file, all);
  });
}

/** Poda as entradas que `drop` manda tirar (ex.: o arquivo da conversa já não existe). Devolve os ids podados. */
export function pruneRegistry(drop: (id: string, entry: RegisteredSession) => Promise<boolean>, file = REGISTRY_FILE): Promise<string[]> {
  return serial(file, async () => {
    const all = await loadAll(file);
    const dropped: string[] = [];
    for (const [id, entry] of all) if (await drop(id, entry)) dropped.push(id);
    if (dropped.length) {
      for (const id of dropped) all.delete(id);
      await saveAll(file, all);
    }
    return dropped;
  });
}

/**
 * Anota o thread_id do Codex numa conversa JÁ registrada. Não cria entrada: uma conversa antiga (de antes do registro), que
 * o Codex reabre, não entra no registro por isso (não tem data de lançamento para contar).
 */
export function attachThreadId(sessionId: string, threadId: string, file = REGISTRY_FILE): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return Promise.reject(new RegistryInputError(`id de conversa inválido: ${sessionId}`));
  if (!THREAD_ID.test(threadId)) return Promise.reject(new RegistryInputError('thread_id inválido'));
  return serial(file, async () => {
    const all = await loadAll(file);
    const prev = all.get(sessionId);
    if (!prev || prev.threadId === threadId) return;
    all.set(sessionId, { ...prev, threadId });
    await saveAll(file, all);
  });
}
