import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { MYCO_HOME } from '../config';
import { getSecret, setSecret } from '../secretVault';
import { StaffError, writeAtomic } from './store';

// Memória pessoal: uma por pessoa (personId), lida por todas as fichas dela (cópias em outros projetos). Fica em
// MYCO_HOME/people, fora dos projetos, então não vai para o git. Só o Claudio’s Club grava (pela tela, com
// `fromBrowser`). Cada versão é assinada (HMAC-SHA256, chave no cofre de MYCO_HOME/secrets): se o arquivo for
// mexido por fora, não é injetado; vale a última versão anterior que ainda bata com a assinatura, ou nada.

export const PERSON_MEMORY_MAX_LINES = 40;
export const PERSON_MEMORY_MAX_BYTES = 4096;
/** Versões anteriores guardadas (as mais recentes ficam). */
const HISTORY_KEEP = 20;
const KEY_ID = 'myco:memoria-pessoal';
const PERSON_ID = /^[A-Za-z0-9-]{1,60}$/;
/** Caracteres de controle (tab e quebra de linha passam). */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export type PersonMemoryStatus = 'ok' | 'empty' | 'fallback' | 'tampered' | 'unavailable';
export interface PersonMemory {
  /** O que vai para o prompt (vazio quando não há versão confiável). */
  text: string;
  status: PersonMemoryStatus;
}

const BodySchema = z.object({ text: z.string().max(20_000) });

const peopleDir = () => path.join(MYCO_HOME, 'people');
const memoryFile = (id: string) => path.join(peopleDir(), `${id}.memory.md`);
const sigFile = (id: string) => path.join(peopleDir(), `${id}.memory.sig`);
const historyDir = (id: string) => path.join(peopleDir(), `${id}.memory.history`);

function checkId(personId: string): string {
  if (typeof personId !== 'string' || !PERSON_ID.test(personId)) throw new StaffError('pessoa inválida');
  return personId;
}

/** Como fica gravado: quebras LF, sem espaço no fim da linha nem no fim do texto, uma quebra final (vazio continua vazio). */
function normalize(text: string): string {
  const body = text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
  return body ? `${body}\n` : '';
}

function prepare(raw: string): string {
  const stored = normalize(raw);
  if (CONTROL.test(stored)) throw new StaffError('a memória aceita só texto (sem caracteres de controle)');
  const lines = stored.split('\n').length - 1;
  if (lines > PERSON_MEMORY_MAX_LINES) throw new StaffError(`a memória passa de ${PERSON_MEMORY_MAX_LINES} linhas (são ${lines}): resuma o que vale levar`);
  if (Buffer.byteLength(stored, 'utf8') > PERSON_MEMORY_MAX_BYTES) throw new StaffError(`a memória passa de ${PERSON_MEMORY_MAX_BYTES / 1024} KB: resuma`);
  return stored;
}

// Chave da assinatura: uma por processo, no cofre (DPAPI no Windows). Se falhar, a próxima chamada tenta de novo.
let keyPromise: Promise<Buffer> | null = null;
function hmacKey(): Promise<Buffer> {
  if (!keyPromise) {
    keyPromise = loadKey().catch((err: unknown) => {
      keyPromise = null;
      throw err;
    });
  }
  return keyPromise;
}

async function loadKey(): Promise<Buffer> {
  const saved = await getSecret(KEY_ID);
  if (saved) return Buffer.from(saved, 'base64');
  const key = randomBytes(32);
  await setSecret(KEY_ID, key.toString('base64'));
  return key;
}

const sign = (key: Buffer, text: string) => createHmac('sha256', key).update(text, 'utf8').digest('hex');

function matches(key: Buffer, text: string, sig: string): boolean {
  const a = Buffer.from(sign(key, text), 'hex');
  const b = Buffer.from(sig.trim(), 'hex');
  return b.length === a.length && timingSafeEqual(a, b);
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

/** Carimbos das versões anteriores, da mais nova para a mais velha. */
async function versions(id: string): Promise<string[]> {
  const names = await fs.readdir(historyDir(id)).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .sort((a, b) => b.localeCompare(a));
}

/** Guarda a versão atual (texto e assinatura) no histórico e apaga as mais antigas que o limite. */
async function archive(id: string): Promise<void> {
  const text = await readText(memoryFile(id));
  if (text === null) return;
  const sig = await readText(sigFile(id));
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const dir = historyDir(id);
  await writeAtomic(path.join(dir, `${stamp}.md`), text);
  if (sig !== null) await writeAtomic(path.join(dir, `${stamp}.sig`), sig);
  for (const old of (await versions(id)).slice(HISTORY_KEEP)) {
    await Promise.all([fs.rm(path.join(dir, `${old}.md`), { force: true }), fs.rm(path.join(dir, `${old}.sig`), { force: true })]);
  }
}

// Uma operação por pessoa por vez (leitura e gravação): mesmo padrão do withProfileLock das fichas.
const queues = new Map<string, Promise<unknown>>();
function withPersonLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/**
 * A memória que vai para o prompt. Assinatura errada: usa a versão anterior do histórico que bata, ou nada, e avisa no
 * log (sem o conteúdo). Erro no cofre: nada é injetado e a conversa abre do mesmo jeito.
 */
export async function readPersonMemory(personId: string): Promise<PersonMemory> {
  const id = checkId(personId);
  return withPersonLock(id, async () => {
    let key: Buffer;
    try {
      key = await hmacKey();
    } catch (err) {
      console.warn(`[memória pessoal] ${id}: cofre indisponível, nada injetado (${err instanceof Error ? err.message : String(err)})`);
      return { text: '', status: 'unavailable' };
    }
    const text = await readText(memoryFile(id));
    if (text === null) return { text: '', status: 'empty' };
    const sig = await readText(sigFile(id));
    if (sig !== null && matches(key, text, sig)) return { text, status: 'ok' };
    const dir = historyDir(id);
    for (const v of await versions(id)) {
      const old = await readText(path.join(dir, `${v}.md`));
      const oldSig = await readText(path.join(dir, `${v}.sig`));
      if (old !== null && oldSig !== null && matches(key, old, oldSig)) {
        console.warn(`[memória pessoal] ${id}: o arquivo não bate com a assinatura (editado por fora); usando a versão anterior ${v}`);
        return { text: old, status: 'fallback' };
      }
    }
    console.warn(`[memória pessoal] ${id}: o arquivo não bate com a assinatura (editado por fora) e não há versão anterior válida; nada injetado`);
    return { text: '', status: 'tampered' };
  });
}

/**
 * Grava a memória da pessoa. Só pelo navegador (`fromBrowser`); texto acima de 40 linhas ou 4 KB é recusado (400).
 * Ordem: a versão atual vai para o histórico, depois texto e assinatura. Se cair no meio, a assinatura antiga não
 * bate com o texto novo e a leitura usa a versão anterior, que é a certa.
 */
export async function savePersonMemory(personId: string, body: unknown, fromBrowser: boolean): Promise<PersonMemory> {
  if (!fromBrowser) throw new StaffError('a memória pessoal só é editada pelo Claudio’s Club');
  const id = checkId(personId);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) throw new StaffError('texto da memória inválido');
  const stored = prepare(parsed.data.text);
  return withPersonLock(id, async () => {
    let key: Buffer;
    try {
      key = await hmacKey();
    } catch {
      throw new StaffError('não consegui abrir o cofre para assinar a memória');
    }
    if ((await readText(memoryFile(id))) !== stored) await archive(id);
    await writeAtomic(memoryFile(id), stored);
    await writeAtomic(sigFile(id), sign(key, stored) + '\n');
    return { text: stored, status: 'ok' };
  });
}
