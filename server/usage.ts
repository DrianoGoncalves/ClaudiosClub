import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AccountUsage } from '../shared/model';
import { MYCO_HOME } from './config';

// Os limites 5h/7d só existem dentro do Claude Code; o mod myco-tap os grava aqui (mod/myco-tap).

const UsageFile = z.object({
  updatedAt: z.string(),
  limits: z.array(
    z.object({
      kind: z.string(),
      percentUsed: z.number(),
      resetsAt: z.string().nullable(),
    }),
  ),
});

const CLAUDE_HOME = process.env.MYCO_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');

export async function readUsage(
  usageFile = path.join(MYCO_HOME, 'usage.json'),
  tapFile = path.join(CLAUDE_HOME, 'mods', 'myco-tap', 'hooks', 'register.ts'),
): Promise<AccountUsage> {
  const [raw, tapFileExists] = await Promise.all([
    fs.readFile(usageFile, 'utf8').catch(() => null),
    fs.access(tapFile).then(() => true, () => false),
  ]);
  // O mod pode estar carregado por outro caminho (plugin dir do app): se ele já gravou o usage, está ativo.
  const tapInstalled = tapFileExists || raw !== null;
  if (raw === null) return { tapInstalled, limits: [], updatedAt: null };
  try {
    const parsed = UsageFile.safeParse(JSON.parse(raw.replace(/^﻿/, '')));
    if (!parsed.success) return { tapInstalled, limits: [], updatedAt: null };
    return { tapInstalled, limits: parsed.data.limits, updatedAt: parsed.data.updatedAt };
  } catch {
    return { tapInstalled, limits: [], updatedAt: null };
  }
}
