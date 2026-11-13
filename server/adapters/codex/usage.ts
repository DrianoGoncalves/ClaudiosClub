import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { tryJson } from '../claude/fsutil';
import { codexHome, rolloutLines } from './rollout';

// Uso de tokens de uma conversa do Codex, lido dos rollouts (formato em rollout.ts). Os eventos `event_msg/token_count`
// trazem `info.total_token_usage` CUMULATIVO por arquivo: vale o último evento válido de cada arquivo, e a conversa soma
// os arquivos dela (retomada grava em outro arquivo, com contador novo). O modelo vem de `turn_context.payload.model`.
// No Codex, `input_tokens` já inclui o cache lido, e `output_tokens` já inclui o raciocínio (total = entrada + saída).

export interface CodexTokenUsage {
  /** Modelo do turno mais recente que o rollout traz; null se não traz. */
  model: string | null;
  /** Entrada total, cache incluso (no Claude o cache vem separado). */
  inputTokens: number;
  /** Parte da entrada que veio do cache. */
  cachedInputTokens: number;
  /** Saída total, raciocínio incluso. */
  outputTokens: number;
  /** Parte da saída que é raciocínio. */
  reasoningOutputTokens: number;
}

type Totals = Omit<CodexTokenUsage, 'model'>;

interface FileUsage {
  totals: Totals;
  model: string | null;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Os quatro totais; se algum faltar, o evento é ignorado (não se inventa zero). */
function totalsOf(v: unknown): Totals | null {
  const t = rec(v);
  const inputTokens = num(t.input_tokens);
  const cachedInputTokens = num(t.cached_input_tokens);
  const outputTokens = num(t.output_tokens);
  const reasoningOutputTokens = num(t.reasoning_output_tokens);
  if (inputTokens === null || cachedInputTokens === null || outputTokens === null || reasoningOutputTokens === null) return null;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens };
}

/**
 * Uso de cada rollout já lido, por caminho. Vale enquanto o mtime e o tamanho não mudam (um rollout em uso cresce, e aí
 * relê). Limite simples: passando dele, sai o mais antigo (a ordem de inserção).
 */
const FILE_CACHE_MAX = 200;
const fileCache = new Map<string, { mtimeMs: number; size: number; usage: FileUsage | null }>();

/** Uso de um rollout, do cache se o arquivo não mudou. Arquivo que sumiu: null. */
async function fileUsage(file: string): Promise<FileUsage | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.usage;
  const usage = await readFileUsage(file);
  fileCache.delete(file);
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, usage });
  if (fileCache.size > FILE_CACHE_MAX) {
    const oldest = fileCache.keys().next().value;
    if (oldest !== undefined) fileCache.delete(oldest);
  }
  return usage;
}

/** Último total cumulativo do arquivo (e o último modelo visto). Null se o arquivo não tem evento de uso. */
async function readFileUsage(file: string): Promise<FileUsage | null> {
  let totals: Totals | null = null;
  let model: string | null = null;
  // Limite grande = arquivo inteiro (o total cumulativo está no fim, o modelo no começo).
  for (const raw of await rolloutLines(file, 'tail', Number.MAX_SAFE_INTEGER)) {
    if (!raw.includes('"token_count"') && !raw.includes('"turn_context"')) continue;
    const ev = rec(tryJson(raw));
    const payload = rec(ev.payload);
    if (ev.type === 'turn_context' && typeof payload.model === 'string' && payload.model) model = payload.model;
    if (ev.type === 'event_msg' && payload.type === 'token_count') {
      const t = totalsOf(rec(rec(payload.info).total_token_usage));
      if (t) totals = t;
    }
  }
  return totals ? { totals, model } : null;
}

/** Subpastas em ordem crescente (AAAA, MM, DD têm largura fixa: a ordem por nome é a cronológica). */
async function childDirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Todos os rollouts de um thread, do mais antigo para o mais novo. Se o Codex compactou um rollout (`.jsonl.zst`) e o
 * `.jsonl` do mesmo nome ainda existe, vale só o `.jsonl` (não se soma o mesmo arquivo duas vezes).
 */
async function rolloutsOf(threadId: string, home: string): Promise<string[]> {
  const suffix = `-${threadId}.jsonl`;
  const root = path.join(home, 'sessions');
  const byBase = new Map<string, string>();
  for (const y of await childDirs(root))
    for (const m of await childDirs(path.join(root, y)))
      for (const d of await childDirs(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const names = (await fs.readdir(dir).catch((): string[] => [])).filter(
          (n) => n.startsWith('rollout-') && (n.endsWith(suffix) || n.endsWith(`${suffix}.zst`)),
        );
        for (const n of names) {
          const base = n.replace(/\.zst$/, '');
          if (!byBase.has(base) || !n.endsWith('.zst')) byBase.set(base, path.join(dir, n));
        }
      }
  return [...byBase.values()];
}

function add(a: Totals, b: Totals): Totals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

/**
 * Tokens de uma conversa do Codex (soma dos rollouts dela) e o modelo. Null se não há rollout ou nenhum tem evento de uso:
 * "sem dado" nunca vira zero. Não há US$ aqui (o Codex não tem tabela de preço neste projeto). `home`: CODEX_HOME.
 */
export async function codexUsageOf(threadId: string, home = codexHome()): Promise<CodexTokenUsage | null> {
  if (!/^[0-9A-Za-z-]+$/.test(threadId)) return null;
  let sum: Totals | null = null;
  let model: string | null = null;
  for (const file of await rolloutsOf(threadId, home)) {
    const got = await fileUsage(file);
    if (!got) continue;
    sum = sum ? add(sum, got.totals) : got.totals;
    model = got.model ?? model;
  }
  return sum ? { model, ...sum } : null;
}
