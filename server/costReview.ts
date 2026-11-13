// Revisão de custo de um funcionário: regras fixas sobre a ficha, a memória, as tarefas e os transcripts dele
// no período. Sem IA e sem custo: só leitura. Os .jsonl são lidos linha a linha (podem ter dezenas de MB) e
// só o que cai no período conta. Nada do conteúdo das mensagens sai daqui, só títulos e alvos de até 80 caracteres.
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexEffort, CostReview, CostReviewFinding, CostReviewSession, StaffProfile, Task } from '../shared/model';
import { BUILTIN_ROLES } from '../shared/roles';
import { listDir } from './adapters/claude/fsutil';
import { sessionTopic } from './adapters/claude/sessions';
import { CONTEXT_NOTICE } from './chat/items';
import { findTranscript } from './chat/manager';
import { findSecret } from './chat/secrets';
import { memoryDir, memoryFile, readProfile } from './staff/store';
import { readTasks } from './tasks';

// ---- limiares: as regras usam só estas constantes ----
const DAY_MS = 86_400_000;
export const COST_REVIEW_DEFAULT_DAYS = 7;
export const COST_REVIEW_MAX_DAYS = 3650;
/** Quantas conversas entram no top (por cache-read). */
const TOP_SESSIONS = 5;
/** Alvo de ferramenta (arquivo, comando, padrão) e título: no máximo isso, numa linha. */
const TEXT_MAX_CHARS = 80;
/** Contexto de uma chamada acima disso: perto do limite; dividir a tarefa (long-context). */
const LONG_CONTEXT_TOKENS = 200_000;
/** Chamadas depois do aviso de contexto que mostram o aviso ignorado. */
const IGNORED_WARNING_CALLS = 5;
const MEMORY_MAX_BYTES = 8 * 1024;
const MEMORY_MAX_LINES = 60;
/** Um resultado de ferramenta acima disso, ou a soma de uma conversa acima de TOOL_OUTPUT_SESSION_BYTES. */
const TOOL_OUTPUT_MAX_BYTES = 20 * 1024;
const TOOL_OUTPUT_SESSION_BYTES = 150 * 1024;
/** O mesmo arquivo lido essa quantidade de vezes numa conversa. */
const REPEATED_READS = 3;
/** Fração das tarefas do período (com pelo menos REWORK_MIN_TASKS) que é retrabalho. */
const REWORK_RATIO = 0.3;
const REWORK_MIN_TASKS = 3;
const REWORK_PREFIX = 'Complemento de';
/** Cargos de execução (ids de shared/roles.ts): modelo pesado e esforço alto não compensam aqui. */
const EXECUTION_ROLE_IDS = ['desenvolvedor', 'frontend', 'design-system', 'web-designer', 'dados', 'testador'];
const HEAVY_MODEL = /opus|fable/i;
const HIGH_EFFORTS: readonly CodexEffort[] = ['xhigh', 'max'];
/** Subagents sem tipo próprio (ou com um destes) herdam o modelo da conversa. */
const INHERITING_AGENTS = new Set(['general-purpose', 'Explore', 'fork']);
/** Profundidade máxima ao somar a pasta de detalhes da memória. */
const MAX_DETAIL_DEPTH = 5;
/** Mesmo formato de id de ficha de server/staff/store.ts (SAFE_ID). */
const STAFF_ID = /^[a-z0-9-]{1,40}$/;
/** Id de sessão (UUID do Claude Code): nunca vira caminho fora da pasta de transcripts. */
const SESSION_ID = /^[A-Za-z0-9-]{1,80}$/;
// ---- ajustes do botão "Aplicar" (ver CostReviewFix em shared/model.ts): os textos vão para as regras como estão ----
const FIX_RULE_OUTPUT = 'Saída grande (JSON, log, diff): salve em arquivo e filtre (grep, head, trecho); não imprima inteira na conversa.';
const FIX_RULE_REREAD = 'Não releia arquivo inteiro já lido: leia só o trecho que falta (offset e limit).';
const FIX_RULE_AGENTS = 'Não use Agent general-purpose, Explore nem fork: use os agents do roteiro da ficha.';
const FIX_TASK_MEMORY_TITLE = 'Compactar a memória';
const fixTaskMemoryDescription = (staffId: string) =>
  `Compacte o índice da sua memória (.myco/staff/${staffId}.memory.md) para até 60 linhas curtas. Mova os detalhes para .myco/staff/${staffId}.memory/<assunto>.md. Não perca decisões nem pendências. Não grave segredos (senhas, tokens, chaves).`;

const SEVERITY_RANK: Record<CostReviewFinding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** `?days=`: inteiro de 1 a 3650; sem ele, 7. Null = inválido (a rota responde 400). */
export function parseCostReviewDays(raw: string | null): number | null {
  if (raw === null) return COST_REVIEW_DEFAULT_DAYS;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= COST_REVIEW_MAX_DAYS ? n : null;
}

/** Id de funcionário válido (sem barra nem ponto: não sai da pasta .myco/staff). */
export function isStaffId(id: string): boolean {
  return STAFF_ID.test(id);
}

export interface CostReviewInput {
  projectPath: string;
  projectId: string;
  staffId: string;
  days: number;
  /** ~/.claude/projects: onde ficam os transcripts. */
  transcriptsDir: string;
  /** Instante de referência (padrão: agora). */
  now?: number;
}

interface Usage {
  input: number;
  output: number;
  write: number;
  read: number;
}

interface Biggest {
  bytes: number;
  name: string;
  target: string | null;
}

/** O que um transcript (a conversa principal ou um subagent) soma no período. */
interface Conversation {
  calls: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  maxContext: number;
  /** Chamadas novas depois do aviso "[MyCo] Contexto desta conversa". */
  callsAfterNotice: number;
  model: string | null;
  lastAt: string | null;
  /** Primeiro pedido da conversa (só o texto que sessionTopic devolve, até 80 caracteres). */
  topic: string | null;
  toolBytes: number;
  biggest: Biggest | null;
  topRead: { count: number; target: string } | null;
  /** Agent sem subagent_type próprio (ou com general-purpose, Explore, fork). */
  inheritingAgents: number;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const asNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const blocksOf = (content: unknown): Obj[] => (Array.isArray(content) ? content.flatMap((b) => (asObj(b) ? [asObj(b)!] : [])) : []);

/** Texto que sai na tela (alvo, título): uma linha, até 80 caracteres; se parece segredo, só o tipo. */
function clipText(s: string): string {
  const secret = findSecret(s);
  if (secret) return `(${secret.label}, oculto)`;
  return s.replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX_CHARS);
}

/** O arquivo, o comando ou o padrão que a ferramenta usou (o primeiro que houver). */
function targetOf(input: Obj): string | null {
  const v = [input.file_path, input.command, input.pattern].find((x): x is string => typeof x === 'string' && x.length > 0);
  return v === undefined ? null : clipText(v);
}

function resultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  return blocksOf(content).reduce((s, b) => s + (typeof b.text === 'string' ? Buffer.byteLength(b.text, 'utf8') : 0), 0);
}

function inPeriod(row: Obj, sinceMs: number): boolean {
  const at = Date.parse(asStr(row.timestamp) ?? '');
  return Number.isFinite(at) && at >= sinceMs;
}

/**
 * Lê um transcript linha a linha. As chamadas se contam pelo id da mensagem + requestId (o streaming repete a
 * mesma resposta em várias linhas: fica o maior uso visto). Cada tool_use e tool_result conta uma vez.
 */
async function scanTranscript(file: string, sinceMs: number): Promise<Conversation> {
  const out: Conversation = {
    calls: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    maxContext: 0,
    callsAfterNotice: 0,
    model: null,
    lastAt: null,
    topic: null,
    toolBytes: 0,
    biggest: null,
    topRead: null,
    inheritingAgents: 0,
  };
  const usage = new Map<string, Usage>();
  const tools = new Map<string, { name: string; target: string | null }>();
  const seenResults = new Set<string>();
  const reads = new Map<string, { count: number; target: string }>();
  let noticeSeen = false;

  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = asObj(parsed);
    if (!row) continue;
    const type = asStr(row.type);
    const msg = asObj(row.message);

    if (type === 'user') {
      // O título vem do começo da conversa, não do período.
      if (out.topic === null && msg) out.topic = sessionTopic([{ type: 'user', message: msg }]);
      if (!inPeriod(row, sinceMs)) continue;
      const content = msg?.content;
      const blocks = blocksOf(content);
      const texts = typeof content === 'string' ? [content] : blocks.map((b) => (b.type === 'text' ? asStr(b.text) : null)).filter((t): t is string => t !== null);
      if (texts.some((t) => t.trimStart().startsWith(CONTEXT_NOTICE))) noticeSeen = true;
      for (const b of blocks) {
        const id = asStr(b.tool_use_id);
        if (b.type !== 'tool_result' || !id || seenResults.has(id)) continue;
        seenResults.add(id);
        const bytes = resultBytes(b.content);
        out.toolBytes += bytes;
        if (!out.biggest || bytes > out.biggest.bytes) {
          const ref = tools.get(id);
          out.biggest = { bytes, name: ref?.name ?? 'ferramenta', target: ref?.target ?? null };
        }
      }
      continue;
    }

    if (type !== 'assistant' || !msg || !inPeriod(row, sinceMs)) continue;
    const model = asStr(msg.model);
    // Modelo sintético (`<synthetic>`, erros da CLI) não é o modelo do funcionário.
    const real = model !== null && !model.startsWith('<');
    if (real) out.model = model;
    const ts = asStr(row.timestamp);
    if (ts && (out.lastAt === null || ts > out.lastAt)) out.lastAt = ts;

    const u = asObj(msg.usage);
    const msgId = asStr(msg.id);
    if (u && msgId && real) {
      const key = `${msgId}|${asStr(row.requestId) ?? ''}`;
      const next: Usage = {
        input: asNum(u.input_tokens),
        output: asNum(u.output_tokens),
        write: asNum(u.cache_creation_input_tokens),
        read: asNum(u.cache_read_input_tokens),
      };
      const prev = usage.get(key);
      if (!prev) {
        usage.set(key, next);
        if (noticeSeen) out.callsAfterNotice++;
      } else {
        usage.set(key, {
          input: Math.max(prev.input, next.input),
          output: Math.max(prev.output, next.output),
          write: Math.max(prev.write, next.write),
          read: Math.max(prev.read, next.read),
        });
      }
    }

    for (const b of blocksOf(msg.content)) {
      const toolId = asStr(b.id);
      if (b.type !== 'tool_use' || !toolId || tools.has(toolId)) continue;
      const input = asObj(b.input) ?? {};
      const name = asStr(b.name) ?? 'ferramenta';
      const target = targetOf(input);
      tools.set(toolId, { name, target });
      const filePath = asStr(input.file_path);
      if (name === 'Read' && filePath) {
        const r = reads.get(filePath) ?? { count: 0, target: clipText(filePath) };
        r.count++;
        reads.set(filePath, r);
      }
      if (name === 'Agent') {
        const sub = asStr(input.subagent_type);
        if (!sub || INHERITING_AGENTS.has(sub)) out.inheritingAgents++;
      }
    }
  }

  for (const u of usage.values()) {
    out.calls++;
    out.cacheRead += u.read;
    out.cacheWrite += u.write;
    out.output += u.output;
    out.maxContext = Math.max(out.maxContext, u.input + u.write + u.read);
  }
  for (const r of reads.values()) if (!out.topRead || r.count > out.topRead.count) out.topRead = r;
  return out;
}

/** Subagents de uma conversa: `<sessão>/subagents/*.jsonl`, ao lado do transcript principal. */
async function subagentFiles(mainFile: string, sessionId: string): Promise<string[]> {
  const dir = path.join(path.dirname(mainFile), sessionId, 'subagents');
  return (await listDir(dir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}

interface SessionScan {
  item: CostReviewSession;
  /** Título da conversa, para o texto dos achados. */
  title: string | null;
  conversations: Conversation[];
}

/** As conversas da ficha que têm algo no período (principal e subagents). */
async function scanSessions(profile: StaffProfile, projectId: string, transcriptsDir: string, sinceMs: number): Promise<SessionScan[]> {
  const ids = [...new Set(profile.sessions.map((s) => s.id))].filter((id) => SESSION_ID.test(id));
  const out: SessionScan[] = [];
  for (const id of ids) {
    const main = await findTranscript(transcriptsDir, projectId, id);
    const files = [main, ...(await subagentFiles(main, id))];
    const scans: Array<{ conv: Conversation; isMain: boolean }> = [];
    for (const file of files) {
      const st = await fs.stat(file).catch(() => null);
      // Arquivo parado antes do período não tem nada nele: nem lê.
      if (!st || st.mtimeMs < sinceMs) continue;
      try {
        scans.push({ conv: await scanTranscript(file, sinceMs), isMain: file === main });
      } catch {
        // arquivo apagado ou em escrita no meio da leitura: fica para a próxima revisão
      }
    }
    const convs = scans.map((s) => s.conv);
    if (!convs.some((c) => c.calls > 0)) continue;
    const mainConv = scans.find((s) => s.isMain)?.conv ?? null;
    const topic = mainConv?.topic ?? convs.find((c) => c.topic)?.topic ?? null;
    const title = topic ? clipText(topic) : null;
    const lastAt = convs.reduce<string | null>((max, c) => (c.lastAt && (max === null || c.lastAt > max) ? c.lastAt : max), null);
    out.push({
      title,
      conversations: convs,
      item: {
        id,
        title,
        calls: convs.reduce((s, c) => s + c.calls, 0),
        cacheRead: convs.reduce((s, c) => s + c.cacheRead, 0),
        maxContext: convs.reduce((m, c) => Math.max(m, c.maxContext), 0),
        model: mainConv?.model ?? convs.find((c) => c.model)?.model ?? null,
        lastAt,
      },
    });
  }
  return out;
}

interface MemoryStats {
  bytes: number;
  lines: number;
  detailBytes: number;
}

/** Índice da memória (o que entra no contexto) e a pasta de detalhes. Arquivo que falta conta como zero. */
async function memoryOf(projectPath: string, staffId: string): Promise<MemoryStats> {
  const text = await fs.readFile(memoryFile(projectPath, staffId), 'utf8').catch(() => null);
  return {
    bytes: text === null ? 0 : Buffer.byteLength(text, 'utf8'),
    lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
    detailBytes: await dirBytes(memoryDir(projectPath, staffId), 0),
  };
}

async function dirBytes(dir: string, depth: number): Promise<number> {
  if (depth > MAX_DETAIL_DEPTH) return 0;
  let total = 0;
  for (const e of await listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p, depth + 1);
    else if (e.isFile()) total += (await fs.stat(p).catch(() => null))?.size ?? 0;
  }
  return total;
}

interface TaskStats {
  total: number;
  rework: number;
  reopened: number;
  /** Retrabalho ou reabertura (uma tarefa conta uma vez). */
  either: number;
}

/** Tarefas do funcionário criadas no período. Reaberta = passou de review para doing no histórico. */
function taskStats(tasks: Task[], staffId: string, sinceMs: number): TaskStats {
  const mine = tasks.filter((t) => t.staffId === staffId && Date.parse(t.createdAt) >= sinceMs);
  const stats: TaskStats = { total: mine.length, rework: 0, reopened: 0, either: 0 };
  for (const t of mine) {
    const isRework = t.title.trimStart().startsWith(REWORK_PREFIX);
    const history = t.history ?? [];
    const isReopened = history.some((h, i) => i > 0 && h.status === 'doing' && history[i - 1]?.status === 'review');
    if (isRework) stats.rework++;
    if (isReopened) stats.reopened++;
    if (isRework || isReopened) stats.either++;
  }
  return stats;
}

const kTokens = (n: number) => `${Math.round(n / 1000)}k`;
const kBytes = (n: number) => `${Math.round(n / 1024)} kB`;

/** O item com o maior valor (só conta se for acima de zero). */
function worst<T>(items: T[], value: (t: T) => number): T | undefined {
  let best: T | undefined;
  let bestValue = 0;
  for (const t of items) {
    const v = value(t);
    if (v > bestValue) {
      best = t;
      bestValue = v;
    }
  }
  return best;
}

interface ConvRef {
  title: string | null;
  c: Conversation;
}

interface FindingInput {
  staffId: string;
  profile: StaffProfile;
  memory: MemoryStats;
  tasks: TaskStats;
  refs: ConvRef[];
}

/** Os achados, por regra fixa; a ordem já é a de severidade. */
function findingsOf(input: FindingInput): CostReviewFinding[] {
  const { staffId, profile, memory, tasks, refs } = input;
  const out: CostReviewFinding[] = [];
  const label = (r: ConvRef) => (r.title ? `Conversa "${r.title}"` : 'Uma conversa sem título');
  const engineName = profile.engine === 'codex' ? 'Codex' : 'Claude Code';

  const longest = worst(refs, (r) => r.c.maxContext);
  if (longest && longest.c.maxContext > LONG_CONTEXT_TOKENS) {
    out.push({
      id: 'long-context',
      severity: 'high',
      evidence: `${label(longest)} chegou a ${kTokens(longest.c.maxContext)} de contexto (referência: ${kTokens(LONG_CONTEXT_TOKENS)}).`,
      suggestion: 'Dividir a tarefa e usar o ponto de corte antes de a conversa passar de 200k: fechar a parte atual e abrir outra com um resumo.',
    });
  }

  const warned = worst(refs, (r) => r.c.callsAfterNotice);
  if (warned && warned.c.callsAfterNotice >= IGNORED_WARNING_CALLS) {
    out.push({
      id: 'ignored-context-warning',
      severity: 'medium',
      evidence: `${label(warned)} fez ${warned.c.callsAfterNotice} chamadas depois do aviso de contexto, sem fechar o assunto.`,
      suggestion: 'Ao receber o aviso de contexto, fechar o assunto atual e abrir outra conversa no ponto de corte.',
    });
  }

  const heavy = profile.model !== null && HEAVY_MODEL.test(profile.model);
  const executionRoles = new Set(BUILTIN_ROLES.filter((r) => EXECUTION_ROLE_IDS.includes(r.id)).map((r) => r.role.trim().toLowerCase()));
  const execRole = executionRoles.has(profile.role.trim().toLowerCase());
  const highEffort = profile.effort !== null && HIGH_EFFORTS.includes(profile.effort);
  if ((heavy && execRole) || highEffort) {
    const parts: string[] = [];
    if (heavy && execRole) parts.push(`modelo ${profile.model} num cargo de execução (${profile.role})`);
    else if (heavy) parts.push(`modelo ${profile.model}`);
    if (highEffort) parts.push(`esforço ${profile.effort}`);
    // Só o que é o problema: o modelo pesado num cargo de execução, o esforço xhigh/max.
    const fix: { kind: 'ficha'; model?: 'sonnet'; effort?: 'high' } = { kind: 'ficha' };
    if (heavy && execRole) fix.model = 'sonnet';
    if (highEffort) fix.effort = 'high';
    out.push({
      id: 'heavy-model-on-implementation',
      severity: 'medium',
      evidence: `Ficha com ${parts.join(' e ')}.`,
      suggestion: 'Implementação em sonnet com esforço high; opus fica para o plano. Trocar na ficha.',
      fix,
    });
  }

  if (profile.model === null) {
    // Sem modelo no Codex não há sonnet para pôr: nesse caso o achado fica só de leitura.
    out.push({
      id: 'no-model',
      severity: 'low',
      evidence: `Ficha sem modelo: herda o padrão do ${engineName}.`,
      suggestion: 'Definir o modelo na ficha (sonnet para execução, opus só para plano).',
      ...(profile.engine === 'codex' ? {} : { fix: { kind: 'ficha' as const, model: 'sonnet' as const } }),
    });
  }

  if (memory.bytes > MEMORY_MAX_BYTES || memory.lines > MEMORY_MAX_LINES) {
    out.push({
      id: 'big-memory',
      severity: 'medium',
      evidence: `Memória com ${kBytes(memory.bytes)} e ${memory.lines} linhas (limite: ${kBytes(MEMORY_MAX_BYTES)} e ${MEMORY_MAX_LINES} linhas).`,
      suggestion: `Compactar o índice e mover os detalhes para ${staffId}.memory/<assunto>.md.`,
      fix: { kind: 'task', title: FIX_TASK_MEMORY_TITLE, description: fixTaskMemoryDescription(staffId) },
    });
  }

  const single = worst(refs, (r) => r.c.biggest?.bytes ?? 0);
  const singleBig = single?.c.biggest;
  const summed = worst(refs, (r) => r.c.toolBytes);
  let toolEvidence: string | null = null;
  if (single && singleBig && singleBig.bytes > TOOL_OUTPUT_MAX_BYTES) {
    toolEvidence = `${label(single)} teve um resultado de ${kBytes(singleBig.bytes)} (${singleBig.name}${singleBig.target ? `: ${singleBig.target}` : ''}).`;
  } else if (summed && summed.c.toolBytes > TOOL_OUTPUT_SESSION_BYTES) {
    toolEvidence = `${label(summed)} somou ${kBytes(summed.c.toolBytes)} de resultados de ferramenta.`;
  }
  if (toolEvidence !== null) {
    out.push({
      id: 'big-tool-output',
      severity: 'medium',
      evidence: toolEvidence,
      suggestion: 'Salvar a saída grande em arquivo e filtrar (grep, head, trecho) em vez de imprimir tudo na conversa.',
      fix: { kind: 'rule', text: FIX_RULE_OUTPUT },
    });
  }

  const reread = worst(refs, (r) => r.c.topRead?.count ?? 0);
  if (reread?.c.topRead && reread.c.topRead.count >= REPEATED_READS) {
    out.push({
      id: 'repeated-reads',
      severity: 'low',
      evidence: `${label(reread)} leu ${reread.c.topRead.count} vezes o mesmo arquivo (${reread.c.topRead.target}).`,
      suggestion: 'Ler só o trecho que falta (offset e limit) e manter o que já foi lido, em vez de reler o arquivo inteiro.',
      fix: { kind: 'rule', text: FIX_RULE_REREAD },
    });
  }

  const inheriting = refs.reduce((s, r) => s + r.c.inheritingAgents, 0);
  if (inheriting > 0) {
    out.push({
      id: 'inherited-model-agents',
      severity: 'low',
      evidence: `${inheriting} chamada(s) de Agent sem tipo próprio (general-purpose, Explore ou fork): herdam o modelo da conversa.`,
      suggestion: 'Usar os agents do roteiro (subagent_type com nome) em vez dos genéricos.',
      fix: { kind: 'rule', text: FIX_RULE_AGENTS },
    });
  }

  if (tasks.total >= REWORK_MIN_TASKS && tasks.either / tasks.total >= REWORK_RATIO) {
    out.push({
      id: 'rework',
      severity: 'medium',
      evidence: `${tasks.either} de ${tasks.total} tarefas do período são "${REWORK_PREFIX}…" ou voltaram do review.`,
      suggestion: 'Deixar o critério de pronto mais claro no pedido e quebrar a tarefa em partes menores.',
    });
  }

  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/**
 * A revisão de custo de um funcionário, ou null se o projeto ou a ficha não existem (a rota responde 404).
 * `days` já validado (ver parseCostReviewDays).
 */
export async function buildCostReview(input: CostReviewInput): Promise<CostReview | null> {
  const { projectPath, projectId, staffId, days, transcriptsDir } = input;
  if (!isStaffId(staffId)) return null;
  const profile = await readProfile(projectPath, staffId);
  if (!profile) return null;
  // Mesmo corte do ranking (savingsSince): days=1 é hoje desde a meia-noite local.
  const now = new Date(input.now ?? Date.now());
  const sinceMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();

  const sessions = await scanSessions(profile, projectId, transcriptsDir, sinceMs);
  const refs: ConvRef[] = sessions.flatMap((s) => s.conversations.map((c) => ({ title: s.title, c })));
  const all = refs.map((r) => r.c);
  const memory = await memoryOf(projectPath, staffId);
  const tasks = taskStats(await readTasks(projectPath), staffId, sinceMs);

  return {
    staffId,
    days,
    totals: {
      sessions: sessions.length,
      calls: all.reduce((s, c) => s + c.calls, 0),
      cacheRead: all.reduce((s, c) => s + c.cacheRead, 0),
      cacheWrite: all.reduce((s, c) => s + c.cacheWrite, 0),
      output: all.reduce((s, c) => s + c.output, 0),
      maxContext: all.reduce((m, c) => Math.max(m, c.maxContext), 0),
    },
    sessions: sessions
      .map((s) => s.item)
      .sort((a, b) => b.cacheRead - a.cacheRead)
      .slice(0, TOP_SESSIONS),
    tasks: { total: tasks.total, rework: tasks.rework, reopened: tasks.reopened },
    memory,
    ficha: { model: profile.model, effort: profile.effort, engine: profile.engine ?? 'claude' },
    findings: findingsOf({ staffId, profile, memory, tasks, refs }),
  };
}
