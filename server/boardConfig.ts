import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BoardCardWorktreeConfig, BoardCommitConfig, BoardConfig, BoardWriterConfig } from '../shared/model';
import { writeAtomic } from './staff/store';

// Configuração do quadro, por projeto: `<projeto>/.myco/board.json`, ao lado de `tasks.json` e das fichas. Duas coisas moram nele, cada uma com a sua rota e a sua leitura:
// a revisão automática (`autoReview`/`reviewerId`: quem revisa uma tarefa que chega em "revisão", ver TaskService.reviewerOf: o revisor apontado na tarefa; senão o responsável
// daqui, se não foi ele quem executou; senão você, pela tela) e o commit automático (`autoCommit`, ver server/autoCommit.ts). Ligar/desligar é só pela tela (a rota confere,
// ver server/index.ts). Gravar uma não apaga a outra: toda gravação lê o arquivo, troca só as chaves dela e grava de volta, uma por vez por arquivo.

export const DEFAULT_BOARD_CONFIG: BoardConfig = { autoReview: false, reviewerId: null };

const boardFile = (dir: string) => path.join(dir, '.myco', 'board.json');

const SAFE_ID = /^[a-z0-9-]{1,40}$/;

const BoardConfigShape = z.object({
  autoReview: z.boolean({ message: 'autoReview: use true ou false' }),
  reviewerId: z.string().regex(SAFE_ID, 'reviewerId: id de funcionário inválido').nullable(),
});

/** O corpo de `POST /api/projects/:id/board-review`: os dois campos, sempre (o quadro grava o estado inteiro), e nenhum a mais. */
export const BoardConfigInput = BoardConfigShape.strict();

/** O corpo de `POST /api/projects/:id/board-commit`: só `autoCommit`, e nenhum campo a mais. */
export const BoardCommitInput = z.object({ autoCommit: z.boolean({ message: 'autoCommit: use true ou false' }) }).strict();

/** O corpo de `POST /api/projects/:id/board-writer`: só `singleWriter`, e nenhum campo a mais. */
export const BoardWriterInput = z.object({ singleWriter: z.boolean({ message: 'singleWriter: use true ou false' }) }).strict();

/** O corpo de `POST /api/projects/:id/board-card-worktree`: só `cardWorktree`, e nenhum campo a mais. */
export const BoardCardWorktreeInput = z.object({ cardWorktree: z.boolean({ message: 'cardWorktree: use true ou false' }) }).strict();

/** O arquivo como objeto; ausente, ilegível ou que não é objeto vira vazio (a gravação refaz). */
async function readRaw(dir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(boardFile(dir), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const queues = new Map<string, Promise<void>>();

/** Troca só as chaves de `patch` e mantém as outras; uma gravação por vez por arquivo (duas telas gravando juntas não se perdem). */
function patchBoardFile(dir: string, patch: Record<string, unknown>): Promise<void> {
  const file = boardFile(dir);
  const run = (queues.get(file) ?? Promise.resolve()).then(async () => {
    await writeAtomic(file, JSON.stringify({ ...(await readRaw(dir)), ...patch }, null, 2) + '\n');
  });
  queues.set(file, run.catch(() => {}));
  return run;
}

/** A configuração do projeto; arquivo ausente, ilegível ou inválido vira o padrão (desligada), nunca um erro. */
export async function readBoardConfig(dir: string): Promise<BoardConfig> {
  const parsed = BoardConfigShape.safeParse(await readRaw(dir));
  // Ligada sem responsável não existe: valeria como desligada.
  return parsed.success && (!parsed.data.autoReview || parsed.data.reviewerId) ? parsed.data : DEFAULT_BOARD_CONFIG;
}

export function writeBoardConfig(dir: string, config: BoardConfig): Promise<void> {
  return patchBoardFile(dir, { autoReview: config.autoReview, reviewerId: config.reviewerId });
}

/** O commit automático do projeto; qualquer coisa além de `true` gravado (arquivo ausente, ilegível, valor torto) é desligado. */
export async function readBoardCommit(dir: string): Promise<BoardCommitConfig> {
  return { autoCommit: (await readRaw(dir)).autoCommit === true };
}

export function writeBoardCommit(dir: string, config: BoardCommitConfig): Promise<void> {
  return patchBoardFile(dir, { autoCommit: config.autoCommit });
}

/** Um escritor por vez no checkout principal; como o commit automático, qualquer coisa além de `true` gravado (arquivo ausente, ilegível, valor torto) é desligado. */
export async function readBoardWriter(dir: string): Promise<BoardWriterConfig> {
  return { singleWriter: (await readRaw(dir)).singleWriter === true };
}

export function writeBoardWriter(dir: string, config: BoardWriterConfig): Promise<void> {
  return patchBoardFile(dir, { singleWriter: config.singleWriter });
}

/**
 * Worktree por card: o padrão é LIGADA (arquivo ausente, ilegível ou com valor torto liga); só o `false` gravado desliga. `MYCO_CARD_WORKTREE_DEFAULT=off` troca só o padrão de quem não gravou nada
 * (existe para a bateria de testes dos outros assuntos, que começam cards em repositórios git e não querem a cópia por card; ver `tests/support/cardOff.ts`): em produção a variável não existe.
 */
export async function readBoardCardWorktree(dir: string): Promise<BoardCardWorktreeConfig> {
  const saved = (await readRaw(dir)).cardWorktree;
  return { cardWorktree: typeof saved === 'boolean' ? saved : process.env.MYCO_CARD_WORKTREE_DEFAULT !== 'off' };
}

export function writeBoardCardWorktree(dir: string, config: BoardCardWorktreeConfig): Promise<void> {
  return patchBoardFile(dir, { cardWorktree: config.cardWorktree });
}
