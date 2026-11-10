import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codexHistoryOf,
  codexSession,
  findRollout,
  readCodexHistory,
  rolloutSummary,
} from '../server/adapters/codex/rollout';

// Rollout do Codex (conversa do funcionário no motor Codex): histórico, assunto, achar o arquivo e a sessão do quadro.
// A amostra é sintética (tests/fixtures/codex/rollout-sample.jsonl), sem conversa real.

const SAMPLE = path.join(process.cwd(), 'tests', 'fixtures', 'codex', 'rollout-sample.jsonl');
const THREAD = '019f0000-0000-7000-8000-000000000001';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Põe um rollout em `<home>/sessions/2026/11/09/` (a amostra, se não vier `lines`). */
async function placeRollout(home: string, threadId: string, lines?: string[]): Promise<string> {
  const day = path.join(home, 'sessions', '2026', '11', '09');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-2026-11-09T10-00-00-${threadId}.jsonl`);
  await fs.writeFile(file, lines ? `${lines.join('\n')}\n` : await fs.readFile(SAMPLE, 'utf8'));
  return file;
}

/** Grava o thread da sessão como o processo do Codex faz (`<runDir>/<sessão>/codex-thread.json`). */
async function placeThread(runDir: string, sessionId: string, threadId: string): Promise<void> {
  await fs.mkdir(path.join(runDir, sessionId), { recursive: true });
  await fs.writeFile(path.join(runDir, sessionId, 'codex-thread.json'), JSON.stringify({ threadId, savedAt: '2026-11-09T10:00:00.000Z' }) + '\n');
}

/** Roda com CODEX_HOME apontando para `home` (as funções sem `home` leem a variável). */
async function withCodexHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
}

/** Uma linha de mensagem do usuário, no formato do rollout. */
const userLine = (ordinal: number, text: string) =>
  JSON.stringify({ timestamp: `2026-11-09T10:00:${String(ordinal).padStart(2, '0')}.000Z`, ordinal, type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: `m${ordinal}`, content: [{ type: 'text', text }] } } });

describe('readCodexHistory', () => {
  it('tira a ficha da 1ª mensagem e fica com o que a pessoa digitou', async () => {
    const { items, context } = await readCodexHistory(SAMPLE);
    const users = items.filter((i) => i.kind === 'user').map((i) => (i.kind === 'user' ? i.text : ''));
    expect(users).toEqual(['Olá, primeira mensagem', 'Segunda mensagem']);
    expect(JSON.stringify(items)).not.toContain('Fim das instruções');
    expect(context).toBeNull();
  });

  it('mapeia cada tipo de item para o cartão da conversa', async () => {
    const { items } = await readCodexHistory(SAMPLE);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'notice', 'user', 'assistant']);
    const [, reply, ls, git, edit, mcp, compact] = items;
    expect(reply).toMatchObject({ kind: 'assistant', text: 'Resposta de teste.' });
    expect(ls).toMatchObject({ kind: 'tool', name: 'Bash', result: 'total 0', isError: false });
    expect(git).toMatchObject({ kind: 'tool', name: 'Bash', isError: true });
    expect(git && git.kind === 'tool' ? git.result : '').toContain('[código de saída 1]');
    expect(edit).toMatchObject({ kind: 'tool', name: 'Edit', summary: 'update a.txt', result: '1 arquivo alterado' });
    expect(mcp).toMatchObject({ kind: 'tool', name: 'mcp__servidor__busca', result: 'achado' });
    expect(compact).toMatchObject({ kind: 'notice', text: 'Conversa compactada', tone: 'info' });
  });

  it('ignora os tipos que não aparecem e a linha corrompida', async () => {
    // Reasoning, Extension, SubAgentActivity, ImageView e a linha cortada não viram nada: 9 itens da amostra.
    const { items } = await readCodexHistory(SAMPLE);
    expect(items).toHaveLength(9);
    expect(JSON.stringify(items)).not.toContain('Reasoning');
    expect(JSON.stringify(items)).not.toContain('imagem.png');
  });

  it('before corta no instante dado (como o histórico do Claude)', async () => {
    const { items } = await readCodexHistory(SAMPLE, { before: '2026-11-09T10:00:07.000Z' });
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'tool']);
  });

  it('arquivo ausente dá lista vazia, sem erro', async () => {
    expect(await readCodexHistory(path.join(dir, 'nao-existe.jsonl'))).toEqual({ items: [], context: null });
  });
});

const zstdZlib = zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer };
const zstdOk = typeof zstdZlib.zstdCompressSync === 'function';

/** Põe um rollout compactado (`.jsonl.zst`, como o Codex faz com os antigos) em `<home>/sessions/2026/11/09/`. */
async function placeZst(home: string, threadId: string, content?: Buffer): Promise<string> {
  const day = path.join(home, 'sessions', '2026', '11', '09');
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, `rollout-2026-11-09T10-00-00-${threadId}.jsonl.zst`);
  const raw = content ?? (await fs.readFile(SAMPLE));
  await fs.writeFile(file, zstdZlib.zstdCompressSync!(raw));
  return file;
}

describe.skipIf(!zstdOk)('rollout compactado (.jsonl.zst)', () => {
  it('lê histórico e assunto do .zst e acha pelo threadId', async () => {
    const file = await placeZst(dir, THREAD);
    expect(await findRollout(THREAD, dir)).toBe(file);
    const { items } = await readCodexHistory(file);
    expect(items).toHaveLength(9);
    expect(items[0]).toMatchObject({ kind: 'user', text: 'Olá, primeira mensagem' });
    expect((await rolloutSummary(file))?.topic).toBe('Olá, primeira mensagem');
  });

  it('prefere o .jsonl quando existem os dois', async () => {
    const jsonl = await placeRollout(dir, THREAD);
    await placeZst(dir, THREAD);
    expect(await findRollout(THREAD, dir)).toBe(jsonl);
  });

  it('cache: quando o .jsonl vira .jsonl.zst, a busca acha o novo arquivo', async () => {
    const jsonl = await placeRollout(dir, THREAD);
    expect(await findRollout(THREAD, dir)).toBe(jsonl);
    await fs.rm(jsonl);
    const zst = await placeZst(dir, THREAD);
    expect(await findRollout(THREAD, dir)).toBe(zst);
    expect((await readCodexHistory(zst)).items).toHaveLength(9);
  });

  it('compactado acima de 20 MB não é lido: histórico vazio, sem erro', async () => {
    // 21 MB de bytes aleatórios não encolhem na compressão: o arquivo passa do teto.
    const file = await placeZst(dir, THREAD, randomBytes(21 * 1024 * 1024));
    expect(await readCodexHistory(file)).toEqual({ items: [], context: null });
  });
});

describe('findRollout', () => {
  it('acha o arquivo pelo threadId dentro de sessions/AAAA/MM/DD', async () => {
    const file = await placeRollout(dir, THREAD);
    expect(await findRollout(THREAD, dir)).toBe(file);
  });

  it('id desconhecido ou inválido dá null', async () => {
    await placeRollout(dir, THREAD);
    expect(await findRollout('019f0000-0000-7000-8000-0000000000ff', dir)).toBeNull();
    expect(await findRollout('../fora', dir)).toBeNull();
  });
});

describe('rolloutSummary', () => {
  it('traz o assunto sem a ficha, o início, a última gravação e o tamanho', async () => {
    const file = await placeRollout(dir, THREAD);
    const sum = await rolloutSummary(file);
    const st = await fs.stat(file);
    expect(sum).toEqual({ topic: 'Olá, primeira mensagem', startedAt: '2026-11-09T10:00:00.000Z', updatedAt: st.mtime.toISOString(), sizeBytes: st.size });
  });

  it('corta o assunto em 80 caracteres', async () => {
    const long = 'a'.repeat(120);
    const file = await placeRollout(dir, THREAD, [userLine(1, long)]);
    const sum = await rolloutSummary(file);
    expect(sum?.topic).toHaveLength(80);
    expect(sum?.topic?.endsWith('…')).toBe(true);
  });

  it('arquivo ausente dá null', async () => {
    expect(await rolloutSummary(path.join(dir, 'nao-existe.jsonl'))).toBeNull();
  });
});

describe('codexHistoryOf e codexSession', () => {
  it('sessão sem thread do Codex não é do Codex (null)', async () => {
    expect(await codexHistoryOf(path.join(dir, 'run'), 'sess-x')).toBeNull();
  });

  it('com thread e rollout, lê o histórico pela sessão', async () => {
    const runDir = path.join(dir, 'run');
    const home = path.join(dir, 'codex');
    await placeThread(runDir, 'sess-1', THREAD);
    await placeRollout(home, THREAD);
    const got = await withCodexHome(home, () => codexHistoryOf(runDir, 'sess-1'));
    expect(got?.items).toHaveLength(9);
    expect(got?.context).toBeNull();
  });

  it('sessão do quadro: título é o nome do funcionário e assunto vem do rollout', async () => {
    const runDir = path.join(dir, 'run');
    const home = path.join(dir, 'codex');
    await placeThread(runDir, 'sess-1', THREAD);
    await placeRollout(home, THREAD);
    const s = await withCodexHome(home, () => codexSession(runDir, 'Bia', { id: 'sess-1', startedAt: '2026-11-08T09:00:00.000Z' }));
    expect(s).toMatchObject({ id: 'sess-1', title: 'Bia', topic: 'Olá, primeira mensagem', entrypoint: 'codex', gitBranch: null, version: null, subagentCount: 0, live: null, startedAt: '2026-11-09T10:00:00.000Z' });
  });

  it('sem rollout, a sessão vale pela hora da ficha', async () => {
    const runDir = path.join(dir, 'run');
    const s = await withCodexHome(path.join(dir, 'vazio'), () => codexSession(runDir, 'Bia', { id: 'sess-2', startedAt: '2026-11-08T09:00:00.000Z' }));
    expect(s).toMatchObject({ topic: null, startedAt: '2026-11-08T09:00:00.000Z', updatedAt: '2026-11-08T09:00:00.000Z', sizeBytes: 0, entrypoint: 'codex' });
  });
});
