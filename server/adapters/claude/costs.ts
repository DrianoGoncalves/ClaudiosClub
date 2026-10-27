import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CostReport, CostSummary } from '../../../shared/model';
import { listDir, tryJson } from './fsutil';
import { costOf, isBillable, normalizeModel, PRICING_AS_OF, type Usage } from './pricing';

// Custo equivalente em API, lido dos transcripts (~1 GB numa máquina com uso real).
// Cada arquivo é lido uma vez e depois só no trecho acrescentado; o resultado por arquivo
// fica em cache no disco, então reiniciar o servidor não relê tudo.

// 2: tokens por modelo (relatório "valeu a pena?").
const CACHE_VERSION = 2;
/** Ids recentes guardados por arquivo, para deduplicar respostas na fronteira de uma leitura incremental. */
const RECENT_IDS = 64;

interface FileEntry {
  size: number;
  mtimeMs: number;
  /** Até onde o arquivo já foi lido (sempre numa quebra de linha). */
  offset: number;
  /** US$ por dia local (AAAA-MM-DD). */
  byDay: Record<string, number>;
  byModel: Record<string, number>;
  /** Tokens por modelo: permitem recalcular o custo como se outro modelo tivesse feito o trabalho. */
  tokens: Record<string, TokenTotals>;
  unpriced: string[];
  /** Respostas recentes já somadas: id → maior uso visto. */
  recent: Array<[string, CountedUsage]>;
}

export interface TokenTotals {
  input: number;
  output: number;
  write: number;
  write1h: number;
  read: number;
}

/** Custo e tokens de um transcript (principal ou de subagent) de uma sessão. */
export interface FileCost {
  file: string;
  agentType?: string;
  usd: number;
  byModel: Record<string, number>;
  tokens: Record<string, TokenTotals>;
}

interface CountedUsage {
  model: string;
  day: string;
  input: number;
  output: number;
  write: number;
  write1h: number;
  read: number;
  speed: string | null;
}

const CacheFile = z.object({ version: z.literal(CACHE_VERSION), files: z.record(z.any()) });

export interface CostTarget {
  projectId: string;
  sessionId: string;
  /** Tipo do subagent (`agentType` do .meta.json); ausente no transcript principal. */
  agentType?: string;
  file: string;
}

export class CostIndex {
  private files = new Map<string, FileEntry>();
  private loaded = false;
  private scanning: Promise<void> | null = null;
  private lastScanAt = 0;
  private lastTargets: CostTarget[] = [];

  constructor(
    private readonly projectsDir: string,
    private readonly cacheFile: string,
  ) {}

  /** Relê o que mudou. Chamadas simultâneas compartilham a mesma varredura. */
  refresh(): Promise<void> {
    if (!this.scanning) {
      this.scanning = this.scan().finally(() => {
        this.scanning = null;
        this.lastScanAt = Date.now();
      });
    }
    return this.scanning;
  }

  get isScanning(): boolean {
    return this.scanning !== null;
  }

  get scannedAt(): number {
    return this.lastScanAt;
  }

  report(now = new Date()): CostReport {
    const today = dayKey(now);
    const weekAgo = dayKey(new Date(now.getTime() - 6 * 86_400_000));
    const month = today.slice(0, 7);
    const summarize = (byDay: Record<string, number>): CostSummary => {
      const s = { usd: 0, today: 0, last7d: 0, month: 0 };
      for (const [day, usd] of Object.entries(byDay)) {
        s.usd += usd;
        if (day === today) s.today += usd;
        if (day >= weekAgo) s.last7d += usd;
        if (day.startsWith(month)) s.month += usd;
      }
      return s;
    };

    const totalDays: Record<string, number> = {};
    const projectDays = new Map<string, Record<string, number>>();
    const sessionTotals = new Map<string, Map<string, number>>();
    const agentDays = new Map<string, Record<string, number>>();
    const agentRuns = new Map<string, number>();
    const agentProjects = new Map<string, Record<string, number>>();
    const models: Record<string, number> = {};
    const unpriced = new Set<string>();

    for (const t of this.lastTargets) {
      const e = this.files.get(t.file);
      if (!e) continue;
      const fileUsd = sum(e.byDay);
      addDays(totalDays, e.byDay);
      addDays(getOr(projectDays, t.projectId, (): Record<string, number> => ({})), e.byDay);
      const sessions = getOr(sessionTotals, t.projectId, () => new Map<string, number>());
      sessions.set(t.sessionId, (sessions.get(t.sessionId) ?? 0) + fileUsd);
      for (const [m, usd] of Object.entries(e.byModel)) models[m] = (models[m] ?? 0) + usd;
      e.unpriced.forEach((m) => unpriced.add(m));
      if (t.agentType) {
        addDays(getOr(agentDays, t.agentType, (): Record<string, number> => ({})), e.byDay);
        agentRuns.set(t.agentType, (agentRuns.get(t.agentType) ?? 0) + 1);
        const byProject = getOr(agentProjects, t.agentType, (): Record<string, number> => ({}));
        byProject[t.projectId] = (byProject[t.projectId] ?? 0) + fileUsd;
      }
    }

    return {
      generatedAt: now.toISOString(),
      pricingAsOf: PRICING_AS_OF,
      scanning: this.isScanning || !this.loaded,
      total: summarize(totalDays),
      projects: Object.fromEntries(
        [...projectDays].map(([id, days]) => [
          id,
          { ...summarize(days), sessions: Object.fromEntries(sessionTotals.get(id) ?? []) },
        ]),
      ),
      agents: Object.fromEntries(
        [...agentDays].map(([type, days]) => [
          type,
          { ...summarize(days), runs: agentRuns.get(type) ?? 0, projects: agentProjects.get(type) ?? {} },
        ]),
      ),
      models,
      unpricedModels: [...unpriced].sort(),
    };
  }

  /**
   * Os transcripts de uma sessão: o principal primeiro, depois os subagents. Pelo id só (é um
   * UUID): a sessão de um funcionário numa worktree fica na pasta da worktree, não na do projeto.
   */
  sessionFiles(sessionId: string): FileCost[] {
    const out: FileCost[] = [];
    for (const t of this.lastTargets) {
      if (t.sessionId !== sessionId) continue;
      const e = this.files.get(t.file);
      if (!e) continue;
      out.push({ file: t.file, agentType: t.agentType, usd: sum(e.byDay), byModel: e.byModel, tokens: e.tokens ?? {} });
    }
    return out.sort((a, b) => Number(!!a.agentType) - Number(!!b.agentType));
  }

  private async scan(): Promise<void> {
    if (!this.loaded) await this.loadCache();
    const targets = await findTargets(this.projectsDir);
    const live = new Set(targets.map((t) => t.file));
    for (const file of this.files.keys()) if (!live.has(file)) this.files.delete(file);

    let changed = false;
    for (const t of targets) {
      // Arquivo a arquivo: um erro de leitura (arquivo em uso, apagado no meio) não derruba o resto.
      try {
        changed = (await this.update(t.file)) || changed;
      } catch {
        // tenta de novo na próxima varredura
      }
      // Publica o progresso para quem já está lendo o relatório durante a 1ª varredura.
      this.lastTargets = targets;
    }
    this.lastTargets = targets;
    this.loaded = true;
    if (changed) await this.saveCache().catch(() => {});
  }

  private async update(file: string): Promise<boolean> {
    const st = await fs.stat(file);
    let e = this.files.get(file);
    if (e && e.size === st.size && e.mtimeMs === st.mtimeMs) return false;
    // Encolheu: foi reescrito; relê do início.
    if (!e || st.size < e.offset) {
      e = { size: 0, mtimeMs: 0, offset: 0, byDay: {}, byModel: {}, tokens: {}, unpriced: [], recent: [] };
    }
    const next = await readFrom(file, e, st.size);
    this.files.set(file, { ...next, size: st.size, mtimeMs: st.mtimeMs });
    return true;
  }

  private async loadCache() {
    const raw = await fs.readFile(this.cacheFile, 'utf8').catch(() => null);
    const parsed = raw === null ? null : CacheFile.safeParse(tryJson(raw));
    if (parsed?.success) {
      for (const [file, entry] of Object.entries(parsed.data.files)) this.files.set(file, entry as FileEntry);
    }
    this.loaded = true;
  }

  private async saveCache() {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(this.files) }));
    await fs.rename(tmp, this.cacheFile);
  }
}

/** Transcripts principais e de subagents, com o projeto e a sessão a que pertencem. */
export async function findTargets(projectsDir: string): Promise<CostTarget[]> {
  const targets: CostTarget[] = [];
  for (const p of await listDir(projectsDir)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projectsDir, p.name);
    for (const f of await listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const sessionId = f.name.slice(0, -'.jsonl'.length);
      targets.push({ projectId: p.name, sessionId, file: path.join(dir, f.name) });
      const subDir = path.join(dir, sessionId, 'subagents');
      for (const s of await listDir(subDir)) {
        if (!s.isFile() || !s.name.endsWith('.jsonl')) continue;
        const meta = await fs.readFile(path.join(subDir, s.name.replace(/\.jsonl$/, '.meta.json')), 'utf8').catch(() => null);
        const agentType = (tryJson(meta ?? '') as { agentType?: unknown } | null)?.agentType;
        targets.push({
          projectId: p.name,
          sessionId,
          agentType: typeof agentType === 'string' ? agentType : 'subagent',
          file: path.join(subDir, s.name),
        });
      }
    }
  }
  return targets;
}

/** Lê do `offset` até `size`, somando o custo de cada resposta nova (ou o que cresceu numa repetida). */
async function readFrom(file: string, prev: FileEntry, size: number): Promise<Omit<FileEntry, 'size' | 'mtimeMs'>> {
  const byDay = { ...prev.byDay };
  const byModel = { ...prev.byModel };
  const tokens: Record<string, TokenTotals> = Object.fromEntries(Object.entries(prev.tokens ?? {}).map(([m, t]) => [m, { ...t }]));
  const unpriced = new Set(prev.unpriced);
  const recent = new Map(prev.recent);
  let offset = prev.offset;

  const add = (c: CountedUsage, sign: 1 | -1) => {
    const t = (tokens[normalizeModel(c.model)] ??= { input: 0, output: 0, write: 0, write1h: 0, read: 0 });
    t.input += sign * c.input;
    t.output += sign * c.output;
    t.write += sign * c.write;
    t.write1h += sign * c.write1h;
    t.read += sign * c.read;
    const usd = costOf(c.model, {
      input_tokens: c.input,
      output_tokens: c.output,
      cache_creation_input_tokens: c.write,
      cache_read_input_tokens: c.read,
      cache_creation: { ephemeral_1h_input_tokens: c.write1h },
      speed: c.speed,
    });
    if (usd === null) {
      unpriced.add(normalizeModel(c.model));
      return;
    }
    byDay[c.day] = (byDay[c.day] ?? 0) + sign * usd;
    const m = normalizeModel(c.model);
    byModel[m] = (byModel[m] ?? 0) + sign * usd;
  };

  if (size <= prev.offset) return { offset, byDay, byModel, tokens, unpriced: [...unpriced], recent: [...recent] };
  const stream = createReadStream(file, { start: prev.offset, end: size - 1, highWaterMark: 1 << 20 });
  // Linhas separadas nos bytes (0x0A nunca aparece dentro de um caractere UTF-8 multibyte),
  // para o `offset` ficar exato mesmo quando um pedaço corta um caractere ao meio.
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const line = buf.toString('utf8', start, nl);
      offset += nl - start + 1;
      start = nl + 1;
      const parsed = parseAssistantLine(line);
      if (!parsed) continue;
      const old = recent.get(parsed.id);
      if (old) {
        // A mesma resposta se repete em uma linha por bloco: soma só o que cresceu.
        const merged = maxUsage(old, parsed.usage);
        add(old, -1);
        add(merged, 1);
        recent.set(parsed.id, merged);
      } else {
        add(parsed.usage, 1);
        recent.set(parsed.id, parsed.usage);
      }
      if (recent.size > RECENT_IDS * 4) trim(recent);
    }
    carry = buf.subarray(start);
  }
  // Linha final sem quebra (resposta sendo escrita): fica para a próxima leitura.
  trim(recent);
  return { offset, byDay, byModel, tokens, unpriced: [...unpriced], recent: [...recent] };
}

const UsageShape = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation: z
    .object({ ephemeral_5m_input_tokens: z.number().optional(), ephemeral_1h_input_tokens: z.number().optional() })
    .optional(),
  speed: z.string().nullable().optional(),
});

/**
 * Extrai id, modelo, dia e uso de uma linha `assistant` sem decodificar o conteúdo (que pode ter
 * centenas de KB): o objeto `usage` vem depois de `stop_reason`, e o `timestamp` da linha é o último.
 */
export function parseAssistantLine(line: string): { id: string; usage: CountedUsage } | null {
  if (!line.includes('"type":"assistant"')) return null;
  const msgAt = line.indexOf('"message":{');
  if (msgAt === -1) return null;
  const model = /"model":"([^"]+)"/.exec(line.slice(msgAt, msgAt + 300))?.[1];
  const id = /"id":"([^"]+)"/.exec(line.slice(msgAt, msgAt + 400))?.[1];
  if (!id || !isBillable(model)) return null;

  const stopAt = line.indexOf('"stop_reason":', msgAt);
  const usageAt = line.indexOf('"usage":{', stopAt === -1 ? msgAt : stopAt);
  if (usageAt === -1) return null;
  const objStart = usageAt + '"usage":'.length;
  const objEnd = matchBrace(line, objStart);
  if (objEnd === -1) return null;
  const usage = UsageShape.safeParse(tryJson(line.slice(objStart, objEnd + 1)));
  if (!usage.success) return null;

  const tsAt = line.lastIndexOf('"timestamp":"');
  const ts = tsAt === -1 ? null : line.slice(tsAt + 13, tsAt + 13 + 30).split('"')[0];
  const u = usage.data as Usage;
  return {
    id,
    usage: {
      model,
      day: dayKey(ts ? new Date(ts) : new Date()),
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      write: u.cache_creation_input_tokens ?? 0,
      write1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      read: u.cache_read_input_tokens ?? 0,
      speed: u.speed ?? null,
    },
  };
}

/** Índice da chave que fecha o objeto aberto em `start`, respeitando strings JSON. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

function maxUsage(a: CountedUsage, b: CountedUsage): CountedUsage {
  return {
    ...a,
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    write: Math.max(a.write, b.write),
    write1h: Math.max(a.write1h, b.write1h),
    read: Math.max(a.read, b.read),
  };
}

function trim(recent: Map<string, CountedUsage>) {
  const keep = [...recent].slice(-RECENT_IDS);
  recent.clear();
  for (const [k, v] of keep) recent.set(k, v);
}

/** Data local AAAA-MM-DD. */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sum(byDay: Record<string, number>): number {
  return Object.values(byDay).reduce((s, v) => s + v, 0);
}

function addDays(into: Record<string, number>, from: Record<string, number>) {
  for (const [d, v] of Object.entries(from)) into[d] = (into[d] ?? 0) + v;
}

function getOr<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}
