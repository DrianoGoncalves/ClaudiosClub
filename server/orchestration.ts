import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { OrchestrationReport, OrchestrationRun, RunMark } from '../shared/model';
import type { FileCost, TokenTotals } from './adapters/claude/costs';
import { tryJson } from './adapters/claude/fsutil';
import { costOf } from './adapters/claude/pricing';
import { MYCO_HOME } from './config';
import { writeAtomic } from './staff/store';

// "Valeu a pena?": numa sessão, quanto foi do planejador (transcript principal) e quanto dos
// executores (subagents), e quanto custaria se tudo rodasse no modelo do planejador.

const MARKS_FILE = path.join(MYCO_HOME, 'marks.json');
const MARKS = ['used', 'partial', 'discarded'] as const;
const MarksFile = z.record(z.record(z.enum(MARKS)));

export const MarkBody = z.object({
  runId: z.string().regex(/^agent-[\w-]{1,80}$/, 'execução inválida'),
  mark: z.enum(MARKS).nullable(),
});

export function buildOrchestration(
  sessionId: string,
  files: Array<FileCost & { description?: string | null; at?: string | null }>,
  marks: Record<string, RunMark>,
  scanning: boolean,
): OrchestrationReport {
  const main = files.find((f) => !f.agentType);
  const runs = files.filter((f) => f.agentType);
  const plannerModel = main ? topModel(main.byModel) : null;
  const total = files.reduce((s, f) => s + f.usd, 0);
  const share = (usd: number) => (total > 0 ? usd / total : 0);

  let counterfactual = main?.usd ?? 0;
  let priced = !!plannerModel;
  const out: OrchestrationRun[] = runs.map((f) => {
    const id = path.basename(f.file, '.jsonl');
    const asPlanner = plannerModel ? priceAs(plannerModel, f.tokens) : null;
    if (asPlanner === null) priced = false;
    else counterfactual += asPlanner;
    return {
      id,
      agentType: f.agentType!,
      description: f.description ?? null,
      model: topModel(f.byModel),
      share: share(f.usd),
      extraIfPlanner: asPlanner !== null && f.usd > 0 ? asPlanner / f.usd - 1 : null,
      at: f.at ?? null,
      mark: marks[id] ?? null,
    };
  });

  const executorUsd = runs.reduce((s, f) => s + f.usd, 0);
  const wasted = runs.filter((f) => marks[path.basename(f.file, '.jsonl')] === 'discarded').reduce((s, f) => s + f.usd, 0);
  return {
    sessionId,
    plannerModel,
    plannerShare: share(main?.usd ?? 0),
    executorShare: share(executorUsd),
    savings: runs.length && priced && counterfactual > 0 ? 1 - total / counterfactual : null,
    wasteShare: share(wasted),
    runs: out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
    scanning,
  };
}

/** Descrição (o que o planejador pediu) e hora de cada execução, do .meta.json ao lado. */
export async function withRunInfo<T extends FileCost>(files: T[]): Promise<Array<T & { description: string | null; at: string | null }>> {
  return Promise.all(
    files.map(async (f) => {
      if (!f.agentType) return { ...f, description: null, at: null };
      const [meta, st] = await Promise.all([
        fs.readFile(f.file.replace(/\.jsonl$/, '.meta.json'), 'utf8').catch(() => null),
        fs.stat(f.file).catch(() => null),
      ]);
      const description = (tryJson(meta ?? '') as { description?: unknown } | null)?.description;
      return { ...f, description: typeof description === 'string' ? description : null, at: st?.mtime.toISOString() ?? null };
    }),
  );
}

export async function readMarks(sessionId: string, file = MARKS_FILE): Promise<Record<string, RunMark>> {
  return (await readAllMarks(file))[sessionId] ?? {};
}

export async function saveMark(sessionId: string, runId: string, mark: RunMark | null, file = MARKS_FILE) {
  const all = await readAllMarks(file);
  const session = { ...(all[sessionId] ?? {}) };
  if (mark) session[runId] = mark;
  else delete session[runId];
  if (Object.keys(session).length) all[sessionId] = session;
  else delete all[sessionId];
  await writeAtomic(file, JSON.stringify(all, null, 2) + '\n');
  return session;
}

async function readAllMarks(file: string): Promise<Record<string, Record<string, RunMark>>> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  const parsed = MarksFile.safeParse(tryJson((raw ?? '{}').replace(/^﻿/, '')));
  return parsed.success ? parsed.data : {};
}

function topModel(byModel: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [m, usd] of Object.entries(byModel)) if (best === null || usd > byModel[best]!) best = m;
  return best;
}

/** Os tokens de todos os modelos de uma execução, cobrados como se fossem de `model`. */
function priceAs(model: string, tokens: Record<string, TokenTotals>): number | null {
  let usd = 0;
  for (const t of Object.values(tokens)) {
    const c = costOf(model, {
      input_tokens: t.input,
      output_tokens: t.output,
      cache_creation_input_tokens: t.write,
      cache_read_input_tokens: t.read,
      cache_creation: { ephemeral_1h_input_tokens: t.write1h },
    });
    if (c === null) return null;
    usd += c;
  }
  return usd;
}
