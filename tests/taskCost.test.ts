import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task, TaskSession } from '../shared/model';
import { ClaudeAdapter } from '../server/adapters/claude';
import { encodeProjectDir } from '../server/adapters/claude/paths';
import type { FileCost, TokenTotals } from '../server/adapters/claude/costs';
import { claudeFilesBy } from '../server/taskCost';
import { codexUsageOf, type CodexTokenUsage } from '../server/adapters/codex/usage';
import {
  claudeCost,
  codexTokens,
  completedAtOf,
  coverageOf,
  rankTaskCosts,
  summarizeTask,
  taskCostOf,
  taskCostRanking,
  type CostSources,
  type RankedTask,
} from '../server/taskCost';

// Fontes simuladas: transcripts do Claude (como o CostIndex devolve), registro do Club e uso do Codex (como codexUsageOf).
// Nenhum conteúdo de conversa real.

const tok = (input: number, output: number, read = 0, write = 0): TokenTotals => ({ input, output, read, write, write1h: 0 });

/** Um transcript do Claude já somado (usd é o do CostIndex; tokens por modelo). */
const tf = (sessionId: string, usd: number, tokens: Record<string, TokenTotals>): FileCost & { sessionId: string } => ({
  sessionId,
  file: `/proj/${sessionId}.jsonl`,
  usd,
  byModel: {},
  tokens,
});

const SONNET = 'claude-sonnet-4-6';

interface Fixtures {
  claude?: Array<FileCost & { sessionId: string }>;
  registry?: Record<string, { threadId?: string }>;
  codex?: Record<string, CodexTokenUsage | null>;
}

/** Fontes de teste: o que o servidor monta com CostIndex, o registro e codexUsageOf. */
function sourcesOf(f: Fixtures): CostSources {
  const claude = claudeFilesBy(f.claude ?? []);
  return {
    claudeFiles: claude,
    registry: new Map(Object.entries(f.registry ?? {})),
    codexUsage: async (threadId) => f.codex?.[threadId] ?? null,
  };
}

const sess = (id: string, role: TaskSession['role'], engine: TaskSession['engine'], staffId: string | null = 'ana'): TaskSession => ({
  id,
  role,
  engine,
  staffId,
  at: '2026-11-12T10:00:00',
});

const taskOf = (over: Partial<Task> & { id: string }): Task =>
  ({
    title: over.id,
    description: '',
    staffId: 'ana',
    sessionId: null,
    status: 'done',
    plan: null,
    branch: null,
    pr: null,
    createdAt: '2026-11-01T10:00:00',
    updatedAt: '2026-11-01T10:00:00',
    history: [],
    ...over,
  }) as Task;

describe('normalização', () => {
  it('Codex: entrada sem o cache (inputTokens inclui o cache lido); saída como veio', () => {
    expect(codexTokens({ inputTokens: 300, cachedInputTokens: 200, outputTokens: 50 })).toEqual({
      input: 100,
      cacheRead: 200,
      cacheWrite: 0,
      output: 50,
    });
  });

  it('Claude: soma modelos e transcripts; US$ é a soma dos transcripts', () => {
    const got = claudeCost([
      { ...tf('a', 2, { [SONNET]: tok(100, 10, 1000, 200) }) },
      { ...tf('a', 3, { [SONNET]: tok(50, 5, 500, 0), 'claude-haiku-4-5': tok(20, 2) }) },
    ]);
    expect(got).toEqual({ usd: 5, tokens: { input: 170, cacheRead: 1500, cacheWrite: 200, output: 17 } });
  });

  it('modelo sem preço: US$ null, mas os tokens continuam contados', () => {
    const got = claudeCost([tf('a', 1, { [SONNET]: tok(10, 1), 'modelo-sem-preco': tok(7, 3) })]);
    expect(got.usd).toBeNull();
    expect(got.tokens).toEqual({ input: 17, cacheRead: 0, cacheWrite: 0, output: 4 });
  });
});

describe('sem dado é null, nunca zero', () => {
  it('conversa do Claude sem transcript: tokens e US$ null', async () => {
    const cost = await taskCostOf({ id: 't1', sessions: [sess('s1', 'work', 'claude')] }, sourcesOf({}));
    expect(cost.nodes[0]).toMatchObject({ usd: null, tokens: null });
    expect(cost.usd).toBeNull();
    expect(cost.tokens).toBeNull();
  });

  it('Codex sem registro (ou sem threadId) e Codex sem uso: tokens null', async () => {
    const cost = await taskCostOf(
      { id: 't1', sessions: [sess('s1', 'work', 'codex'), sess('s2', 'review', 'codex')] },
      sourcesOf({ registry: { s1: {}, s2: { threadId: 'th2' } }, codex: { th2: null } }),
    );
    expect(cost.nodes.map((n) => n.tokens)).toEqual([null, null]);
    expect(cost.coverage).toBe('none');
  });

  it('o threadId do registro é o que vai para o uso do Codex', async () => {
    const seen: string[] = [];
    const src: CostSources = {
      ...sourcesOf({ registry: { s1: { threadId: 'th-9' } } }),
      codexUsage: async (id) => {
        seen.push(id);
        return null;
      },
    };
    await taskCostOf({ id: 't1', sessions: [sess('s1', 'work', 'codex')] }, src);
    expect(seen).toEqual(['th-9']);
  });

  it('Codex com dado: US$ null (o Codex não tem tabela de preço aqui)', async () => {
    const cost = await taskCostOf(
      { id: 't1', sessions: [sess('s1', 'work', 'codex')] },
      sourcesOf({ registry: { s1: { threadId: 'th1' } }, codex: { th1: { model: 'gpt-x', inputTokens: 300, cachedInputTokens: 200, outputTokens: 50, reasoningOutputTokens: 5 } } }),
    );
    expect(cost.nodes[0]).toMatchObject({ usd: null, tokens: { input: 100, cacheRead: 200, cacheWrite: 0, output: 50 } });
    expect(cost.usd).toBeNull();
    expect(cost.tokens).toEqual({ input: 100, cacheRead: 200, cacheWrite: 0, output: 50 });
  });

  it('tarefa sem sessions (criada antes): coverage none, sem nós e sem totais', async () => {
    const cost = await taskCostOf({ id: 't1' }, sourcesOf({}));
    expect(cost).toMatchObject({ coverage: 'none', usd: null, tokens: null, nodes: [], reworkRounds: 0, reviewRounds: 0 });
  });
});

describe('cobertura e dedupe', () => {
  const claude = [tf('s1', 2, { [SONNET]: tok(10, 5) }), tf('s2', 3, { [SONNET]: tok(4, 1) })];

  it('complete quando todo nó tem dado; partial quando algum não tem (totais só do que tem)', async () => {
    const full = await taskCostOf({ id: 't', sessions: [sess('s1', 'work', 'claude'), sess('s2', 'review', 'claude')] }, sourcesOf({ claude }));
    expect(full.coverage).toBe('complete');
    expect(full.usd).toBe(5);

    const part = await taskCostOf({ id: 't', sessions: [sess('s1', 'work', 'claude'), sess('s9', 'question', 'claude')] }, sourcesOf({ claude }));
    expect(part.coverage).toBe('partial');
    expect(part.usd).toBe(2);
    expect(part.tokens).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, output: 5 });
  });

  it('coverageOf: nenhum com dado = none', () => {
    expect(coverageOf([{ tokens: null }, { tokens: null }])).toBe('none');
    expect(coverageOf([])).toBe('none');
  });

  it('o mesmo id em duas entradas conta uma vez', async () => {
    const cost = await taskCostOf({ id: 't', sessions: [sess('s1', 'work', 'claude'), sess('s1', 'work', 'claude')] }, sourcesOf({ claude }));
    expect(cost.nodes).toHaveLength(1);
    expect(cost.usd).toBe(2);
    expect(cost.tokens).toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, output: 5 });
  });
});

describe('papéis e rodadas', () => {
  it('separa fazer, revisar e dúvida; rodadas ausentes valem zero', async () => {
    const claude = [tf('w', 4, { [SONNET]: tok(1, 1) }), tf('r', 1, { [SONNET]: tok(1, 1) }), tf('q', 2, { [SONNET]: tok(1, 1) })];
    const cost = await taskCostOf(
      { id: 't', sessions: [sess('w', 'work', 'claude'), sess('r', 'review', 'claude', 'bia'), sess('q', 'question', 'claude', 'bia')], reworkRounds: 1 },
      sourcesOf({ claude }),
    );
    expect(cost.byRole.work).toMatchObject({ sessions: 1, withData: 1, usd: 4 });
    expect(cost.byRole.review).toMatchObject({ sessions: 1, usd: 1 });
    expect(cost.byRole.question).toMatchObject({ sessions: 1, usd: 2 });
    expect(cost.reworkRounds).toBe(1);
    expect(cost.reviewRounds).toBe(0);
  });

  it('papel sem conversa: bucket zerado em contagem e null nos totais', async () => {
    const cost = await taskCostOf({ id: 't', sessions: [sess('w', 'work', 'claude')] }, sourcesOf({ claude: [tf('w', 1, { [SONNET]: tok(1, 1) })] }));
    expect(cost.byRole.review).toEqual({ sessions: 0, withData: 0, usd: null, tokens: null });
  });
});

describe('período e conclusão', () => {
  it('completedAtOf: início da última sequência de done (a passagem para pronto)', () => {
    const history = [
      { at: '2026-11-08T09:00:00', status: 'doing' as const, by: 'you' as const },
      { at: '2026-11-09T09:00:00', status: 'done' as const, by: 'you' as const },
      { at: '2026-11-10T09:00:00', status: 'doing' as const, by: 'you' as const },
      { at: '2026-11-11T09:00:00', status: 'done' as const, by: 'auto' as const },
      { at: '2026-11-11T10:00:00', status: 'done' as const, by: 'auto' as const, note: 'nota' },
    ];
    expect(completedAtOf({ history, updatedAt: 'x' })).toBe('2026-11-11T09:00:00');
    expect(completedAtOf({ history: [], updatedAt: '2026-11-12T08:00:00' })).toBe('2026-11-12T08:00:00');
  });

  it('taskCostRanking: só tarefas prontas cuja conclusão cai no período', async () => {
    const claude = [tf('a', 1, { [SONNET]: tok(1, 1) }), tf('b', 1, { [SONNET]: tok(1, 1) }), tf('c', 1, { [SONNET]: tok(1, 1) }), tf('d', 1, { [SONNET]: tok(1, 1) })];
    const projects = [
      {
        projectId: 'p1',
        tasks: [
          taskOf({ id: 'antiga', sessions: [sess('a', 'work', 'claude')], history: [{ at: '2026-11-09T12:00:00', status: 'done', by: 'you' }] }),
          taskOf({ id: 'nova', sessions: [sess('b', 'work', 'claude')], history: [{ at: '2026-11-09T12:00:00', status: 'review', by: 'auto' }, { at: '2026-11-11T12:00:00', status: 'done', by: 'you' }] }),
          taskOf({ id: 'fazendo', status: 'doing', sessions: [sess('c', 'work', 'claude')] }),
          taskOf({ id: 'so-updated', updatedAt: '2026-11-12T08:00:00', sessions: [sess('d', 'work', 'claude')], history: [] }),
        ],
      },
    ];
    const periodo = await taskCostRanking(projects, '2026-11-10', sourcesOf({ claude }));
    expect(periodo.tasks.map((t) => t.taskId).sort()).toEqual(['nova', 'so-updated']);
    expect(periodo.tasks.find((t) => t.taskId === 'nova')?.completedAt).toBe('2026-11-11T12:00:00');

    const tudo = await taskCostRanking(projects, null, sourcesOf({ claude }));
    expect(tudo.tasks.map((t) => t.taskId).sort()).toEqual(['antiga', 'nova', 'so-updated']);
    expect(tudo.since).toBeNull();
  });
});

/** Custo de uma tarefa pronta, para o ranking (a conclusão é só o que o período olha). */
async function ranked(
  id: string,
  staffId: string | null,
  sessions: TaskSession[],
  f: Fixtures,
  over: Partial<Task> = {},
): Promise<RankedTask> {
  const t = taskOf({ id, staffId, sessions, ...over });
  return { projectId: 'p1', title: id, staffId, requestedBy: t.requestedBy ?? null, completedAt: completedAtOf(t), cost: await taskCostOf(t, sourcesOf(f)) };
}

describe('agregados', () => {
  it('ordena por US$ (sem US$ por último) e depois por tokens', async () => {
    const f: Fixtures = {
      claude: [
        tf('x', 5, { [SONNET]: tok(1, 1) }),
        tf('w', 5, { [SONNET]: tok(9000, 9000) }),
        tf('y', 0, { [SONNET]: tok(3, 3) }),
        tf('z', 0, { [SONNET]: tok(1, 1) }),
        tf('n', 0, { 'modelo-sem-preco': tok(1, 1) }),
      ],
    };
    const items = [
      await ranked('X', 'ana', [sess('x', 'work', 'claude')], f),
      await ranked('Y', 'ana', [sess('y', 'work', 'claude')], f),
      await ranked('N', 'ana', [sess('n', 'work', 'claude')], f),
      await ranked('Z', 'ana', [sess('z', 'work', 'claude')], f),
      await ranked('W', 'ana', [sess('w', 'work', 'claude')], f),
    ];
    // US$ igual: desempata por tokens. US$ 0 (preço existe) fica antes de US$ null (modelo sem preço, que vai para o fim).
    const out = rankTaskCosts(items, null);
    expect(out.tasks.map((t) => t.taskId)).toEqual(['W', 'X', 'Y', 'Z', 'N']);
    expect(out.tasks.find((t) => t.taskId === 'N')).toMatchObject({ usd: null, tokens: { input: 1, output: 1 } });
  });

  it('executor: média de US$ só com quem tem US$; tokens médios; % com retrabalho', async () => {
    const f: Fixtures = {
      claude: [tf('a', 2, { [SONNET]: tok(10, 5) })],
      registry: { b: { threadId: 'th1' } },
      codex: { th1: { model: null, inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 3 } },
    };
    const items = [
      await ranked('A', 'ana', [sess('a', 'work', 'claude')], f),
      await ranked('B', 'ana', [sess('b', 'work', 'codex')], f, { reworkRounds: 1 }),
      await ranked('C', 'bia', [sess('a', 'work', 'claude', 'bia')], f),
    ];
    const out = rankTaskCosts(items, null);
    const ana = out.executors.find((e) => e.staffId === 'ana');
    expect(ana).toMatchObject({ tasks: 2, usd: 2, usdAvg: 2, reworkTasks: 1, reworkShare: 0.5 });
    // Tokens: A (10/0/0/5) e B (60/40/0/10): média por tarefa com dado, arredondada.
    expect(ana?.tokensAvg).toEqual({ input: 35, cacheRead: 20, cacheWrite: 0, output: 8 });
    expect(out.executors.find((e) => e.staffId === 'bia')?.reworkShare).toBe(0);
  });

  it('executor sem nenhuma tarefa com US$ (só Codex): usdAvg null, não zero', async () => {
    const f: Fixtures = { registry: { b: { threadId: 'th1' } }, codex: { th1: { model: null, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 } } };
    const out = rankTaskCosts([await ranked('B', 'ana', [sess('b', 'work', 'codex')], f)], null);
    expect(out.executors[0]).toMatchObject({ usd: null, usdAvg: null, tokensAvg: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 } });
  });

  it('gestor: tarefas pedidas, custo delas, e revisão/dúvida feitas por ele (nós com o staffId dele)', async () => {
    const f: Fixtures = {
      claude: [
        tf('w1', 4, { [SONNET]: tok(1, 1) }),
        tf('r1', 1, { [SONNET]: tok(1, 1) }),
        tf('w2', 2, { [SONNET]: tok(1, 1) }),
        tf('q2', 3, { [SONNET]: tok(1, 1) }),
        tf('w3', 9, { [SONNET]: tok(1, 1) }),
      ],
    };
    const items = [
      await ranked('T1', 'ana', [sess('w1', 'work', 'claude'), sess('r1', 'review', 'claude', 'bia')], f, { requestedBy: 'bia' }),
      await ranked('T2', 'ana', [sess('w2', 'work', 'claude'), sess('q2', 'question', 'claude', 'bia')], f, { requestedBy: 'bia' }),
      await ranked('T3', 'caio', [sess('w3', 'work', 'claude')], f, { requestedBy: 'dan' }),
    ];
    const out = rankTaskCosts(items, null);
    // bia pediu T1 (4+1) e T2 (2+3): US$ 10; dan pediu T3 (9). Ordem por US$.
    expect(out.managers.map((m) => m.staffId)).toEqual(['bia', 'dan']);
    const bia = out.managers.find((m) => m.staffId === 'bia');
    expect(bia).toMatchObject({ tasksRequested: 2, usd: 10 });
    expect(bia?.review).toMatchObject({ sessions: 1, usd: 1 });
    expect(bia?.question).toMatchObject({ sessions: 1, usd: 3 });
    expect(out.managers.find((m) => m.staffId === 'dan')).toMatchObject({ tasksRequested: 1, usd: 9, review: { sessions: 0, usd: null } });
  });
});

describe('cache do uso do Codex', () => {
  const THREAD = 'cccccccc-1111-2222-3333-444444444444';
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-taskcost-'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const rollout = (input: number, cached: number, output: number) =>
    [
      { type: 'turn_context', payload: { model: 'gpt-teste' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n';

  it('relê quando o rollout cresce (mtime e tamanho mudam) e não devolve o valor antigo', async () => {
    const dir = path.join(home, 'sessions', '2026', '11', '12');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-11-12T10-00-00-${THREAD}.jsonl`);
    await fs.writeFile(file, rollout(100, 10, 5));
    expect((await codexUsageOf(THREAD, home))?.inputTokens).toBe(100);
    expect((await codexUsageOf(THREAD, home))?.inputTokens).toBe(100);
    await fs.writeFile(file, rollout(300, 200, 50));
    expect(await codexUsageOf(THREAD, home)).toMatchObject({ inputTokens: 300, cachedInputTokens: 200, outputTokens: 50 });
  });
});

describe('sessão de projeto fora do quadro ainda tem custo', () => {
  let root: string;
  let home: string;
  let boardDir: string;
  let offDir: string;
  let prevCodexHome: string | undefined;

  const transcript = (model = 'claude-sonnet-5') =>
    JSON.stringify({
      type: 'assistant',
      uuid: 'u',
      timestamp: new Date().toISOString(),
      message: { model, id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    });

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-taskcost-adapter-'));
    home = path.join(root, 'home', '.claude');
    boardDir = path.join(root, 'work', 'quadro');
    offDir = path.join(root, 'work', 'fora');
    // Sem isto, a lista do Codex leria o ~/.codex de quem roda o teste.
    prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(root, 'codex');
    for (const d of [boardDir, offDir]) await fs.mkdir(d, { recursive: true });
    await fs.mkdir(path.join(root, 'home'), { recursive: true });
    await fs.writeFile(path.join(root, 'home', '.claude.json'), JSON.stringify({ projects: { [boardDir]: {}, [offDir]: {} } }));
    for (const [d, sid] of [
      [boardDir, 'sess-quadro'],
      [offDir, 'sess-fora'],
    ] as const) {
      const dir = path.join(home, 'projects', encodeProjectDir(d));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), transcript() + '\n');
    }
  });

  afterAll(async () => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  const adapter = () =>
    new ClaudeAdapter({
      locations: { home, configFile: path.join(root, 'home', '.claude.json') },
      includeTemp: true,
      // Só o projeto "quadro" entra no quadro; "fora" fica de fora.
      onBoard: async (refs) => refs.filter((r) => r.path === boardDir),
      costCacheFile: path.join(root, 'cache.json'),
      discoveryTtlMs: 0,
    });

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
    for (let i = 0; ; i++) {
      const v = await read();
      if (ok(v) || i > 200) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('o custo da sessão de fora do quadro conta; o ranking de economia continua só com o quadro', async () => {
    const a = adapter();
    const first = await a.getAllSessionCostFiles();
    // Primeira varredura ainda em andamento: `scanning` avisa que o que veio pode estar incompleto.
    expect(first.scanning).toBe(true);

    const all = await until(() => a.getAllSessionCostFiles(), (r) => !r.scanning && r.files.length > 0);
    expect(all.scanning).toBe(false);
    expect(all.files.map((f) => f.sessionId).sort()).toEqual(['sess-fora', 'sess-quadro']);
    expect(all.files.find((f) => f.sessionId === 'sess-fora')?.usd).toBeCloseTo(2, 6);

    const board = await a.getSavingsFiles(null);
    expect(board.files.map((f) => f.sessionId)).toEqual(['sess-quadro']);
  });

  it('a fonte de custo por tarefa acha a sessão de fora pelo id (claudeFilesBy)', async () => {
    const a = adapter();
    const all = await until(() => a.getAllSessionCostFiles(), (r) => !r.scanning && r.files.length > 0);
    const files = claudeFilesBy(all.files);
    expect(files('sess-fora')).toHaveLength(1);
    expect(files('sess-inexistente')).toEqual([]);
  });
});

describe('resumo direto', () => {
  it('summarizeTask: papéis e totais a partir de nós já lidos', () => {
    const cost = summarizeTask(
      { id: 't', reviewRounds: 2 },
      [{ sessionId: 's', role: 'review', staffId: 'bia', engine: 'claude', at: 'x', usd: 1, tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } }],
    );
    expect(cost).toMatchObject({ coverage: 'complete', usd: 1, reviewRounds: 2, reworkRounds: 0, scanning: false });
    expect(cost.byRole.review.sessions).toBe(1);
  });
});
