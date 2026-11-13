import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexUsageOf } from '../server/adapters/codex/usage';

// Uso de tokens do Codex a partir dos rollouts: último total cumulativo, arquivo sem uso, retomada em dois arquivos.
// Fixture sintética (nenhum conteúdo de conversa real).

const THREAD = 'aaaaaaaa-1111-2222-3333-444444444444';

const turn = (model: string) => ({ timestamp: '2026-11-12T10:00:00Z', ordinal: 1, type: 'turn_context', payload: { model } });

const count = (input: number, cached: number, output: number, reasoning: number) => ({
  timestamp: '2026-11-12T10:01:00Z',
  ordinal: 2,
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: input + output,
      },
    },
  },
});

// Evento só com limites (info nulo), como o Codex grava às vezes: não conta como uso.
const limitsOnly = { timestamp: '2026-11-12T10:02:00Z', ordinal: 3, type: 'event_msg', payload: { type: 'token_count', info: null } };

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-usage-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** Grava um rollout em sessions/AAAA/MM/DD (day = AAAA-MM-DD). */
async function rolloutAt(day: string, lines: unknown[], name = `rollout-${day}T10-00-00-${THREAD}.jsonl`): Promise<void> {
  const [y, m, d] = day.split('-');
  const dir = path.join(home, 'sessions', y!, m!, d!);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

describe('codexUsageOf', () => {
  it('usa o último total cumulativo do arquivo (não soma os eventos) e o modelo do turno', async () => {
    await rolloutAt('2026-11-12', [
      turn('modelo-teste'),
      count(100, 60, 10, 4),
      limitsOnly,
      count(300, 200, 50, 20),
    ]);
    expect(await codexUsageOf(THREAD, home)).toEqual({
      model: 'modelo-teste',
      inputTokens: 300,
      cachedInputTokens: 200,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    });
  });

  it('arquivo sem evento de uso dá null (indisponível, não zero)', async () => {
    await rolloutAt('2026-11-12', [turn('modelo-teste'), { timestamp: 't', ordinal: 4, type: 'response_item', payload: { type: 'message' } }, limitsOnly]);
    expect(await codexUsageOf(THREAD, home)).toBeNull();
  });

  it('sem nenhum rollout do thread dá null', async () => {
    expect(await codexUsageOf(THREAD, home)).toBeNull();
  });

  it('retomada em dois arquivos: soma o último total de cada um, sem contar duas vezes', async () => {
    await rolloutAt('2026-11-12', [turn('modelo-antigo'), count(300, 200, 50, 20)]);
    await rolloutAt('2026-11-13', [turn('modelo-novo'), count(120, 80, 15, 5), count(130, 90, 18, 6)]);
    expect(await codexUsageOf(THREAD, home)).toEqual({
      model: 'modelo-novo',
      inputTokens: 430,
      cachedInputTokens: 290,
      outputTokens: 68,
      reasoningOutputTokens: 26,
    });
  });

  it('arquivo sem uso na retomada não entra na soma', async () => {
    await rolloutAt('2026-11-12', [turn('modelo-teste'), count(300, 200, 50, 20)]);
    await rolloutAt('2026-11-13', [turn('modelo-teste'), limitsOnly]);
    expect(await codexUsageOf(THREAD, home)).toEqual({
      model: 'modelo-teste',
      inputTokens: 300,
      cachedInputTokens: 200,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    });
  });

  it('o .jsonl vence o .zst de mesmo nome (o mesmo rollout não é somado duas vezes)', async () => {
    const name = `rollout-2026-11-12T10-00-00-${THREAD}`;
    await rolloutAt('2026-11-12', [turn('modelo-teste'), count(300, 200, 50, 20)], `${name}.jsonl`);
    // Cópia compactada com outros totais: se o código lesse as duas, o resultado mudaria.
    const zst = zlib.zstdCompressSync(Buffer.from(JSON.stringify(count(999, 999, 999, 999)) + '\n'));
    await fs.writeFile(path.join(home, 'sessions', '2026', '11', '12', `${name}.jsonl.zst`), zst);
    expect(await codexUsageOf(THREAD, home)).toEqual({
      model: 'modelo-teste',
      inputTokens: 300,
      cachedInputTokens: 200,
      outputTokens: 50,
      reasoningOutputTokens: 20,
    });
  });

  it('só um .zst ilegível dá null', async () => {
    const dir = path.join(home, 'sessions', '2026', '11', '12');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `rollout-2026-11-12T10-00-00-${THREAD}.jsonl.zst`), 'nao e zstd');
    expect(await codexUsageOf(THREAD, home)).toBeNull();
  });

  it('id inválido dá null sem tocar no disco', async () => {
    expect(await codexUsageOf('../fora', home)).toBeNull();
  });
});
