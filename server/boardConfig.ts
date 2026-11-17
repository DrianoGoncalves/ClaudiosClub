import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BoardConfig } from '../shared/model';
import { writeAtomic } from './staff/store';

// Revisão automática do quadro, por projeto: `<projeto>/.myco/board.json`, ao lado de `tasks.json` e das fichas. Quem revisa uma
// tarefa que chega em "revisão" (ver TaskService.reviewerOf): o revisor apontado na tarefa; senão o responsável daqui, se não foi ele
// quem executou; senão você, pela tela. Ligar/desligar é só pela tela (a rota confere, ver server/index.ts).

export const DEFAULT_BOARD_CONFIG: BoardConfig = { autoReview: false, reviewerId: null };

const boardFile = (dir: string) => path.join(dir, '.myco', 'board.json');

const SAFE_ID = /^[a-z0-9-]{1,40}$/;

const BoardConfigShape = z.object({
  autoReview: z.boolean({ message: 'autoReview: use true ou false' }),
  reviewerId: z.string().regex(SAFE_ID, 'reviewerId: id de funcionário inválido').nullable(),
});

/** O corpo de `POST /api/projects/:id/board-review`: os dois campos, sempre (o quadro grava o estado inteiro), e nenhum a mais. */
export const BoardConfigInput = BoardConfigShape.strict();

/** A configuração do projeto; arquivo ausente, ilegível ou inválido vira o padrão (desligada), nunca um erro. */
export async function readBoardConfig(dir: string): Promise<BoardConfig> {
  const raw = await fs.readFile(boardFile(dir), 'utf8').catch(() => null);
  if (!raw) return DEFAULT_BOARD_CONFIG;
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    const parsed = BoardConfigShape.safeParse(data);
    // Ligada sem responsável não existe: valeria como desligada.
    return parsed.success && (!parsed.data.autoReview || parsed.data.reviewerId) ? parsed.data : DEFAULT_BOARD_CONFIG;
  } catch {
    return DEFAULT_BOARD_CONFIG;
  }
}

export async function writeBoardConfig(dir: string, config: BoardConfig): Promise<void> {
  await writeAtomic(boardFile(dir), JSON.stringify(config, null, 2) + '\n');
}
