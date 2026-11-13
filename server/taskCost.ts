import type {
  ExecutorCostRow,
  ManagerCostRow,
  Task,
  TaskCost,
  TaskCostBucket,
  TaskCostCoverage,
  TaskCostNode,
  TaskCostRankRow,
  TaskCostRanking,
  TaskSession,
  TaskTokens,
} from '../shared/model';
import type { FileCost } from './adapters/claude/costs';
import { dayKey } from './adapters/claude/costs';
import { rateFor } from './adapters/claude/pricing';
import type { CodexTokenUsage } from './adapters/codex/usage';

// Custo de uma tarefa = o custo de todas as conversas dela (`Task.sessions`). Os dois motores saem no mesmo formato de
// tokens: no Claude o cache vem separado da entrada; no Codex, `inputTokens` inclui o cache, então a entrada é a diferença.
// US$ só existe para o Claude (tabela de preço do CostIndex); no Codex é null. Sem dado é null, nunca zero.

/** O que a leitura precisa: transcripts do Claude por conversa, o registro do Club (threadId) e o uso do Codex. */
export interface CostSources {
  /** Transcripts (principal e subagents) de uma conversa do Claude; vazio = nenhum conhecido (apagada, ou nunca lida). */
  claudeFiles(sessionId: string): FileCost[];
  /** Conversas que o Club lançou (o threadId do Codex vem daqui). Conversa fora do registro = sem dado. */
  registry: ReadonlyMap<string, { threadId?: string }>;
  /** Uso do Codex de um thread; null = sem dado. */
  codexUsage(threadId: string): Promise<CodexTokenUsage | null>;
}

/** Campos da tarefa que o custo usa. */
export interface TaskCostInput {
  id: string;
  sessions?: TaskSession[];
  reworkRounds?: number;
  reviewRounds?: number;
}

/** Entrada do ranking: a tarefa concluída, o projeto e o custo já calculado. */
export interface RankedTask {
  projectId: string;
  title: string;
  staffId: string | null;
  requestedBy: string | null;
  completedAt: string;
  cost: TaskCost;
}

const ZERO: TaskTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export function totalTokens(t: TaskTokens): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

/** Tokens do Codex no formato comum: a entrada sem o cache (`inputTokens` já inclui o cache lido), e a saída com o raciocínio. */
export function codexTokens(u: Pick<CodexTokenUsage, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>): TaskTokens {
  return { input: Math.max(0, u.inputTokens - u.cachedInputTokens), cacheRead: u.cachedInputTokens, cacheWrite: 0, output: u.outputTokens };
}

/**
 * Custo de uma conversa do Claude, somando os transcripts dela. Sem transcript = sem dado (null). US$ null se algum
 * modelo com tokens não tem preço: a soma sairia menor que o real, e o número não é honesto.
 */
export function claudeCost(files: FileCost[]): { usd: number | null; tokens: TaskTokens | null } {
  if (files.length === 0) return { usd: null, tokens: null };
  const tokens: TaskTokens = { ...ZERO };
  let usd = 0;
  let unpriced = false;
  for (const f of files) {
    usd += f.usd;
    for (const [model, t] of Object.entries(f.tokens)) {
      tokens.input += t.input;
      tokens.cacheRead += t.read;
      tokens.cacheWrite += t.write;
      tokens.output += t.output;
      if (rateFor(model) === null) unpriced = true;
    }
  }
  return { usd: unpriced ? null : usd, tokens };
}

/** Os transcripts do Claude agrupados pelo id da conversa (o que `getAllSessionCostFiles` devolve, sem filtro de quadro). */
export function claudeFilesBy(files: Array<FileCost & { sessionId: string }>): (sessionId: string) => FileCost[] {
  const by = new Map<string, FileCost[]>();
  for (const f of files) {
    const list = by.get(f.sessionId);
    if (list) list.push(f);
    else by.set(f.sessionId, [f]);
  }
  return (sessionId) => by.get(sessionId) ?? [];
}

/** As conversas da tarefa, sem repetir o id (a primeira vale; `withSession` do serviço já não repete). */
export function uniqueSessions(sessions: TaskSession[] | undefined): TaskSession[] {
  const seen = new Set<string>();
  const out: TaskSession[] = [];
  for (const s of sessions ?? []) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

async function nodeCost(s: TaskSession, src: CostSources): Promise<TaskCostNode> {
  const base = { sessionId: s.id, role: s.role, staffId: s.staffId, engine: s.engine, at: s.at };
  if (s.engine === 'codex') {
    const threadId = src.registry.get(s.id)?.threadId;
    // Falha de leitura conta como sem dado (não derruba a tarefa inteira).
    const u = threadId ? await src.codexUsage(threadId).catch((): null => null) : null;
    return { ...base, usd: null, tokens: u ? codexTokens(u) : null };
  }
  return { ...base, ...claudeCost(src.claudeFiles(s.id)) };
}

/** Cobertura: complete se todo nó tem dado; partial se algum não tem; none se não há conversa ou nenhuma tem dado. */
export function coverageOf(nodes: Array<Pick<TaskCostNode, 'tokens'>>): TaskCostCoverage {
  const withData = nodes.filter((n) => n.tokens !== null).length;
  if (withData === 0) return 'none';
  return withData === nodes.length ? 'complete' : 'partial';
}

function sumUsd(nodes: Array<Pick<TaskCostNode, 'usd'>>): number | null {
  const vals = nodes.filter((n) => n.usd !== null);
  return vals.length ? vals.reduce((s, n) => s + n.usd!, 0) : null;
}

function sumTokens(nodes: Array<Pick<TaskCostNode, 'tokens'>>): TaskTokens | null {
  const withData = nodes.filter((n) => n.tokens !== null);
  if (!withData.length) return null;
  const out: TaskTokens = { ...ZERO };
  for (const n of withData) {
    out.input += n.tokens!.input;
    out.cacheRead += n.tokens!.cacheRead;
    out.cacheWrite += n.tokens!.cacheWrite;
    out.output += n.tokens!.output;
  }
  return out;
}

/** Soma de um grupo de conversas. */
export function bucketOf(nodes: TaskCostNode[]): TaskCostBucket {
  return {
    sessions: nodes.length,
    withData: nodes.filter((n) => n.tokens !== null).length,
    usd: sumUsd(nodes),
    tokens: sumTokens(nodes),
  };
}

/** Custo de uma tarefa a partir das conversas já lidas (`nodes`). Os papéis saem separados. */
export function summarizeTask(task: TaskCostInput, nodes: TaskCostNode[], scanning = false): TaskCost {
  const role = (r: TaskSession['role']) => bucketOf(nodes.filter((n) => n.role === r));
  return {
    taskId: task.id,
    coverage: coverageOf(nodes),
    usd: sumUsd(nodes),
    tokens: sumTokens(nodes),
    byRole: { work: role('work'), review: role('review'), question: role('question') },
    reworkRounds: task.reworkRounds ?? 0,
    reviewRounds: task.reviewRounds ?? 0,
    nodes,
    scanning,
  };
}

/** Custo de todas as conversas de uma tarefa. */
export async function taskCostOf(task: TaskCostInput, src: CostSources, scanning = false): Promise<TaskCost> {
  const nodes = await Promise.all(uniqueSessions(task.sessions).map((s) => nodeCost(s, src)));
  return summarizeTask(task, nodes, scanning);
}

/**
 * Quando a tarefa foi para "pronto": o início da última sequência de `done` no histórico (a mudança de coluna que a levou
 * para lá; as notas depois dela também ficam como done). Sem entrada de `done`, vale `updatedAt`.
 */
export function completedAtOf(task: Pick<Task, 'history' | 'updatedAt'>): string {
  const h = task.history ?? [];
  let last = -1;
  for (let i = 0; i < h.length; i++) if (h[i]!.status === 'done') last = i;
  if (last < 0) return task.updatedAt;
  let start = last;
  while (start > 0 && h[start - 1]!.status === 'done') start--;
  return h[start]!.at;
}

/** Ordena por US$ (maior primeiro; sem US$ vai para o fim), e depois por tokens. */
function byUsdThenTokens(a: { usd: number | null; tokens: TaskTokens | null }, b: { usd: number | null; tokens: TaskTokens | null }): number {
  return usdDesc(a.usd, b.usd) || usdDesc(a.tokens ? totalTokens(a.tokens) : null, b.tokens ? totalTokens(b.tokens) : null);
}

function usdDesc(a: number | null, b: number | null): number {
  return (b ?? -1) - (a ?? -1);
}

/** Soma de US$ e tokens só das parcelas com dado, com a contagem de quantas tinham. */
interface Pool {
  usd: number;
  usdN: number;
  tok: TaskTokens;
  tokN: number;
}

const pool = (): Pool => ({ usd: 0, usdN: 0, tok: { ...ZERO }, tokN: 0 });

function addToPool(p: Pool, c: { usd: number | null; tokens: TaskTokens | null }): void {
  if (c.usd !== null) {
    p.usd += c.usd;
    p.usdN++;
  }
  if (c.tokens) {
    p.tok.input += c.tokens.input;
    p.tok.cacheRead += c.tokens.cacheRead;
    p.tok.cacheWrite += c.tokens.cacheWrite;
    p.tok.output += c.tokens.output;
    p.tokN++;
  }
}

/**
 * Ranking por tarefa concluída. `items` já vêm filtrados pelo período e pelo quadro; aqui só se agrega.
 * Executor: média por tarefa (US$ e tokens só das que têm dado). Gestor: as tarefas que pediu, e as conversas de revisão e dúvida
 * feitas por ele (nós cujo `staffId` é o gestor, em qualquer papel review/question das tarefas do ranking).
 */
export function rankTaskCosts(items: RankedTask[], since: string | null, scanning = false): TaskCostRanking {
  const tasks: TaskCostRankRow[] = items
    .map((it) => ({
      projectId: it.projectId,
      taskId: it.cost.taskId,
      title: it.title,
      staffId: it.staffId,
      requestedBy: it.requestedBy,
      completedAt: it.completedAt,
      coverage: it.cost.coverage,
      sessions: it.cost.nodes.length,
      usd: it.cost.usd,
      tokens: it.cost.tokens,
      reworkRounds: it.cost.reworkRounds,
      reviewRounds: it.cost.reviewRounds,
    }))
    .sort((a, b) => byUsdThenTokens(a, b) || b.completedAt.localeCompare(a.completedAt));

  const execs = new Map<string, { p: Pool; tasks: number; rework: number }>();
  for (const it of items) {
    if (!it.staffId) continue;
    const e = execs.get(it.staffId) ?? { p: pool(), tasks: 0, rework: 0 };
    e.tasks++;
    if (it.cost.reworkRounds > 0) e.rework++;
    addToPool(e.p, it.cost);
    execs.set(it.staffId, e);
  }
  const executors: ExecutorCostRow[] = [...execs].map(([staffId, e]) => ({
    staffId,
    tasks: e.tasks,
    usd: e.p.usdN ? e.p.usd : null,
    tokens: e.p.tokN ? e.p.tok : null,
    usdAvg: e.p.usdN ? e.p.usd / e.p.usdN : null,
    tokensAvg: e.p.tokN ? avgTokens(e.p.tok, e.p.tokN) : null,
    reworkTasks: e.rework,
    reworkShare: e.rework / e.tasks,
  }));
  executors.sort((a, b) => usdDesc(a.usdAvg, b.usdAvg) || b.tasks - a.tasks);

  const allNodes = items.flatMap((it) => it.cost.nodes);
  const mgrs = new Map<string, { p: Pool; tasks: number }>();
  for (const it of items) {
    if (!it.requestedBy) continue;
    const m = mgrs.get(it.requestedBy) ?? { p: pool(), tasks: 0 };
    m.tasks++;
    addToPool(m.p, it.cost);
    mgrs.set(it.requestedBy, m);
  }
  const managers: ManagerCostRow[] = [...mgrs].map(([staffId, m]) => {
    const mine = allNodes.filter((n) => n.staffId === staffId);
    return {
      staffId,
      tasksRequested: m.tasks,
      usd: m.p.usdN ? m.p.usd : null,
      tokens: m.p.tokN ? m.p.tok : null,
      review: bucketOf(mine.filter((n) => n.role === 'review')),
      question: bucketOf(mine.filter((n) => n.role === 'question')),
    };
  });
  managers.sort((a, b) => usdDesc(a.usd, b.usd) || b.tasksRequested - a.tasksRequested);

  return { since, tasks, executors, managers, scanning };
}

/** Média por tarefa de cada componente (arredondada), sobre as `n` tarefas com dado. */
function avgTokens(t: TaskTokens, n: number): TaskTokens {
  return {
    input: Math.round(t.input / n),
    cacheRead: Math.round(t.cacheRead / n),
    cacheWrite: Math.round(t.cacheWrite / n),
    output: Math.round(t.output / n),
  };
}

/**
 * Tarefas concluídas (status `done`) cuja conclusão cai no período (`since`, AAAA-MM-DD local; null = desde sempre), com o custo
 * de todas as conversas de cada uma. `projects`: as tarefas de cada projeto do quadro.
 */
export async function taskCostRanking(
  projects: Array<{ projectId: string; tasks: Task[] }>,
  since: string | null,
  src: CostSources,
  scanning = false,
): Promise<TaskCostRanking> {
  const items: RankedTask[] = [];
  for (const p of projects) {
    for (const t of p.tasks) {
      if (t.status !== 'done') continue;
      const completedAt = completedAtOf(t);
      if (since !== null && dayKey(new Date(completedAt)) < since) continue;
      const cost = await taskCostOf(t, src, scanning);
      items.push({ projectId: p.projectId, title: t.title, staffId: t.staffId, requestedBy: t.requestedBy ?? null, completedAt, cost });
    }
  }
  return rankTaskCosts(items, since, scanning);
}
