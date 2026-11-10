import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CostReview } from '../shared/model';
import { buildCostReview, isStaffId, parseCostReviewDays } from '../server/costReview';
import { createProfile, StaffInputSchema } from '../server/staff/store';

// Fixtures sintéticas: um projeto e transcripts num temp dir; nada do ~/.claude real.
const PROJECT = 'proj-test';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

interface SetupOptions {
  model?: string | null;
  effort?: string | null;
  role?: string;
  sessions?: string[];
}

interface Fixture {
  projectPath: string;
  transcriptsDir: string;
  staffId: string;
  /** Escreve o transcript principal (e os subagents, por nome do arquivo). */
  transcript: (sid: string, lines: string[], subagents?: Record<string, string[]>) => Promise<void>;
  review: (days?: number) => Promise<CostReview | null>;
}

async function setup(opts: SetupOptions = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'costreview-'));
  roots.push(root);
  const projectPath = path.join(root, 'proj');
  const transcriptsDir = path.join(root, 'projects');
  await fs.mkdir(projectPath, { recursive: true });
  const input = StaffInputSchema.parse({
    name: 'Ana',
    role: opts.role ?? 'Desenvolvedor(a) back-end',
    reportsTo: [],
    mission: 'Implementar a tela de login',
    model: opts.model === undefined ? 'sonnet' : opts.model,
    effort: opts.effort ?? null,
  });
  const sessions = (opts.sessions ?? []).map((id) => ({ id, startedAt: at(2 * 60) }));
  const profile = await createProfile(projectPath, PROJECT, input, new Date(NOW - 30 * DAY), sessions);
  return {
    projectPath,
    transcriptsDir,
    staffId: profile.id,
    transcript: async (sid, lines, subagents = {}) => {
      const dir = path.join(transcriptsDir, PROJECT);
      await fs.mkdir(path.join(dir, sid, 'subagents'), { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
      for (const [name, subLines] of Object.entries(subagents)) {
        await fs.writeFile(path.join(dir, sid, 'subagents', `${name}.jsonl`), subLines.join('\n') + '\n');
      }
    },
    review: (days = 7) => buildCostReview({ projectPath, projectId: PROJECT, staffId: profile.id, days, transcriptsDir, now: NOW }),
  };
}

// ---- linhas no formato do Claude Code ----
type Usage = { input?: number; output?: number; write?: number; read?: number };
const usage = (u: Usage = {}) => ({
  input_tokens: u.input ?? 10,
  output_tokens: u.output ?? 10,
  cache_creation_input_tokens: u.write ?? 0,
  cache_read_input_tokens: u.read ?? 0,
});

function call(opts: { id: string; minAgo?: number; req?: string; model?: string; usage?: Usage; blocks?: unknown[] }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: at(opts.minAgo ?? 60),
    requestId: opts.req ?? `req-${opts.id}`,
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-sonnet-4-5',
      role: 'assistant',
      content: opts.blocks ?? [{ type: 'text', text: 'ok' }],
      usage: usage(opts.usage),
    },
  });
}

const prompt = (text: string, minAgo = 120) => JSON.stringify({ type: 'user', timestamp: at(minAgo), message: { role: 'user', content: text } });
const notice = (minAgo = 60) => prompt('[MyCo] Contexto desta conversa: 180k tokens, esta conversa já está grande.', minAgo);
const toolResult = (id: string, text: string, minAgo = 60) =>
  JSON.stringify({ type: 'user', timestamp: at(minAgo), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

const ids = (r: CostReview | null) => (r ? r.findings.map((f) => f.id) : []);

describe('validação de days e staffId', () => {
  it('days: padrão 7; inteiro de 1 a 3650', () => {
    expect(parseCostReviewDays(null)).toBe(7);
    expect(parseCostReviewDays('1')).toBe(1);
    expect(parseCostReviewDays('3650')).toBe(3650);
  });

  it('days inválido: zero, acima do limite, negativo, decimal, texto, vazio', () => {
    for (const raw of ['0', '3651', '10000', '-1', '1.5', '1e2', 'abc', '']) expect(parseCostReviewDays(raw)).toBeNull();
  });

  it('staffId só com letras minúsculas, números e hífen (sem barra nem ponto)', () => {
    expect(isStaffId('ana-1a2b')).toBe(true);
    expect(isStaffId('../etc')).toBe(false);
    expect(isStaffId('Ana')).toBe(false);
    expect(isStaffId('')).toBe(false);
  });

  it('staffId inválido ou de ficha inexistente: null (404 na rota)', async () => {
    const f = await setup();
    const base = { projectPath: f.projectPath, projectId: PROJECT, days: 7, transcriptsDir: f.transcriptsDir, now: NOW };
    expect(await buildCostReview({ ...base, staffId: '../proj' })).toBeNull();
    expect(await buildCostReview({ ...base, staffId: 'nao-existe' })).toBeNull();
  });
});

describe('métricas e dedupe', () => {
  it('sem conversa nem achado: lista vazia e zeros', async () => {
    const f = await setup();
    const r = await f.review();
    expect(r).not.toBeNull();
    expect(r!.totals).toEqual({ sessions: 0, calls: 0, cacheRead: 0, cacheWrite: 0, output: 0, maxContext: 0 });
    expect(r!.findings).toEqual([]);
    expect(r!.ficha).toEqual({ model: 'sonnet', effort: null, engine: 'claude' });
  });

  it('streaming repete a mesma resposta: conta uma vez, com o maior uso visto', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [
      prompt('Implementa o login'),
      call({ id: 'm1', usage: { output: 10, read: 1000 } }),
      call({ id: 'm1', usage: { output: 50, read: 1000 } }),
      call({ id: 'm2', usage: { output: 20, read: 2000 } }),
    ]);
    const r = await f.review();
    expect(r!.totals.calls).toBe(2);
    expect(r!.totals.output).toBe(70);
    expect(r!.totals.cacheRead).toBe(3000);
    expect(r!.sessions[0]).toMatchObject({ id: 's1', title: 'Implementa o login', calls: 2, cacheRead: 3000, model: 'claude-sonnet-4-5' });
  });

  it('mesma mensagem com requestId diferente conta como outra chamada', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [call({ id: 'm1', req: 'a' }), call({ id: 'm1', req: 'b' })]);
    expect((await f.review())!.totals.calls).toBe(2);
  });

  it('contexto máximo = entrada + escrita e leitura de cache', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [call({ id: 'm1', usage: { input: 1000, write: 2000, read: 3000 } })]);
    expect((await f.review())!.totals.maxContext).toBe(6000);
  });

  it('linhas antes do período não contam', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [call({ id: 'velha', minAgo: 10 * 1440, usage: { read: 9999 } }), call({ id: 'nova', minAgo: 60, usage: { read: 1 } })]);
    const r = await f.review(7);
    expect(r!.totals.calls).toBe(1);
    expect(r!.totals.cacheRead).toBe(1);
  });

  it('subagents somam na conversa e no total; título vem da conversa principal', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [prompt('Revisa o módulo de pagamento'), call({ id: 'm1', usage: { read: 100 } })], {
      'agent-a': [call({ id: 'sub1', usage: { read: 400 } })],
    });
    const r = await f.review();
    expect(r!.totals.calls).toBe(2);
    expect(r!.sessions[0]).toMatchObject({ title: 'Revisa o módulo de pagamento', calls: 2, cacheRead: 500 });
  });

  it('sessions: top 5 por cache-read, do maior ao menor', async () => {
    const sids = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const f = await setup({ sessions: sids });
    for (const [i, sid] of sids.entries()) await f.transcript(sid, [call({ id: `m-${sid}`, usage: { read: (i + 1) * 100 } })]);
    const r = await f.review();
    expect(r!.totals.sessions).toBe(6);
    expect(r!.sessions.map((s) => s.id)).toEqual(['s6', 's5', 's4', 's3', 's2']);
  });

  it('memória: bytes e linhas do índice; pasta de detalhes à parte', async () => {
    const f = await setup();
    const staffDir = path.join(f.projectPath, '.myco', 'staff');
    await fs.writeFile(path.join(staffDir, `${f.staffId}.memory.md`), 'a\nb\n');
    await fs.mkdir(path.join(staffDir, `${f.staffId}.memory`), { recursive: true });
    await fs.writeFile(path.join(staffDir, `${f.staffId}.memory`, 'detalhe.md'), '0123456789');
    const r = await f.review();
    expect(r!.memory).toEqual({ bytes: 4, lines: 2, detailBytes: 10 });
  });
});

describe('achados (cada regra dispara e não dispara)', () => {
  it('long-context: conversa acima de 200k dispara; abaixo não', async () => {
    const hot = await setup({ sessions: ['s1'] });
    await hot.transcript('s1', [call({ id: 'm1', usage: { input: 150_000, read: 60_000 } })]);
    const hotR = await hot.review();
    expect(ids(hotR)).toContain('long-context');
    expect(hotR!.findings.find((x) => x.id === 'long-context')!.severity).toBe('high');

    const cool = await setup({ sessions: ['s1'] });
    await cool.transcript('s1', [call({ id: 'm1', usage: { input: 100_000, read: 60_000 } })]);
    expect(ids(await cool.review())).not.toContain('long-context');
  });

  it('ignored-context-warning: 5 chamadas depois do aviso dispara; 4 não', async () => {
    const many = await setup({ sessions: ['s1'] });
    await many.transcript('s1', [
      call({ id: 'antes' }),
      notice(),
      ...['a', 'b', 'c', 'd', 'e'].map((x) => call({ id: x, minAgo: 50 })),
    ]);
    const r = await many.review();
    expect(ids(r)).toContain('ignored-context-warning');
    expect(r!.findings.find((x) => x.id === 'ignored-context-warning')!.evidence).toContain('5 chamadas');

    const few = await setup({ sessions: ['s1'] });
    await few.transcript('s1', [notice(), ...['a', 'b', 'c', 'd'].map((x) => call({ id: x, minAgo: 50 }))]);
    expect(ids(await few.review())).not.toContain('ignored-context-warning');
  });

  it('heavy-model-on-implementation: opus em cargo de execução dispara; opus no planejador não', async () => {
    const exec = await setup({ model: 'opus', role: 'Desenvolvedor(a) back-end' });
    expect(ids(await exec.review())).toContain('heavy-model-on-implementation');

    const planner = await setup({ model: 'opus', role: 'Arquiteto(a) de software' });
    expect(ids(await planner.review())).not.toContain('heavy-model-on-implementation');
  });

  it('heavy-model-on-implementation: esforço xhigh ou max dispara, mesmo com sonnet', async () => {
    const xhigh = await setup({ model: 'sonnet', effort: 'xhigh' });
    const r = await xhigh.review();
    expect(ids(r)).toContain('heavy-model-on-implementation');
    expect(r!.findings.find((x) => x.id === 'heavy-model-on-implementation')!.evidence).toContain('xhigh');

    const high = await setup({ model: 'sonnet', effort: 'high' });
    expect(ids(await high.review())).not.toContain('heavy-model-on-implementation');
  });

  it('no-model: ficha sem modelo dispara; com modelo não', async () => {
    const none = await setup({ model: null });
    expect(ids(await none.review())).toContain('no-model');
    const set = await setup({ model: 'sonnet' });
    expect(ids(await set.review())).not.toContain('no-model');
  });

  it('big-memory: mais de 8 kB ou mais de 60 linhas dispara; pequena não', async () => {
    const f = await setup();
    const file = path.join(f.projectPath, '.myco', 'staff', `${f.staffId}.memory.md`);
    await fs.writeFile(file, 'x'.repeat(9 * 1024));
    expect(ids(await f.review())).toContain('big-memory');

    await fs.writeFile(file, Array.from({ length: 61 }, (_, i) => `linha ${i}`).join('\n'));
    expect(ids(await f.review())).toContain('big-memory');

    await fs.writeFile(file, 'curta\n');
    expect(ids(await f.review())).not.toContain('big-memory');
  });

  it('big-tool-output: um resultado acima de 20 kB dispara; soma acima de 150 kB também; pequenos não', async () => {
    const big = await setup({ sessions: ['s1'] });
    await big.transcript('s1', [call({ id: 'm1', blocks: [tool('t1', 'Bash', { command: 'npm test' })] }), toolResult('t1', 'x'.repeat(25 * 1024))]);
    const bigR = await big.review();
    expect(ids(bigR)).toContain('big-tool-output');
    expect(bigR!.findings.find((x) => x.id === 'big-tool-output')!.evidence).toContain('npm test');

    const sum = await setup({ sessions: ['s1'] });
    const lines: string[] = [];
    for (let i = 0; i < 3; i++) {
      lines.push(call({ id: `m${i}`, blocks: [tool(`t${i}`, 'Read', { file_path: `/f${i}.ts` })] }));
      lines.push(toolResult(`t${i}`, 'y'.repeat(60 * 1024)));
    }
    await sum.transcript('s1', lines);
    expect(ids(await sum.review())).toContain('big-tool-output');

    const small = await setup({ sessions: ['s1'] });
    const smallLines: string[] = [];
    for (let i = 0; i < 10; i++) {
      smallLines.push(call({ id: `s${i}`, blocks: [tool(`u${i}`, 'Bash', { command: `echo ${i}` })] }));
      smallLines.push(toolResult(`u${i}`, 'z'.repeat(1024)));
    }
    await small.transcript('s1', smallLines);
    expect(ids(await small.review())).not.toContain('big-tool-output');
  });

  it('repeated-reads: o mesmo arquivo lido 3 vezes dispara; 2 não', async () => {
    const three = await setup({ sessions: ['s1'] });
    await three.transcript('s1', [1, 2, 3].map((n) => call({ id: `r${n}`, blocks: [tool(`rd${n}`, 'Read', { file_path: '/src/app.ts' })] })));
    const r = await three.review();
    expect(ids(r)).toContain('repeated-reads');
    expect(r!.findings.find((x) => x.id === 'repeated-reads')!.evidence).toContain('/src/app.ts');

    const two = await setup({ sessions: ['s1'] });
    await two.transcript('s1', [1, 2].map((n) => call({ id: `r${n}`, blocks: [tool(`rd${n}`, 'Read', { file_path: '/src/app.ts' })] })));
    expect(ids(await two.review())).not.toContain('repeated-reads');
  });

  it('inherited-model-agents: Agent sem subagent_type ou general-purpose dispara; tipo próprio não', async () => {
    const inherit = await setup({ sessions: ['s1'] });
    await inherit.transcript('s1', [call({ id: 'm1', blocks: [tool('ag1', 'Agent', { prompt: 'faça tudo' })] })]);
    expect(ids(await inherit.review())).toContain('inherited-model-agents');

    const named = await setup({ sessions: ['s1'] });
    await named.transcript('s1', [call({ id: 'm1', blocks: [tool('ag1', 'Agent', { subagent_type: 'Plan', prompt: 'planeje' })] })]);
    expect(ids(await named.review())).not.toContain('inherited-model-agents');
  });

  it('rework: 2 de 3 tarefas (complemento ou reaberta) dispara; com menos de 3 tarefas não', async () => {
    const f = await setup();
    const tasksFile = path.join(f.projectPath, '.myco', 'tasks.json');
    const task = (id: string, title: string, history: Array<{ at: string; status: string; by: 'auto' }>) => ({
      id,
      title,
      description: '',
      status: 'done',
      staffId: f.staffId,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: at(60),
      updatedAt: at(30),
      history: history.map((h) => ({ ...h, at: at(30) })),
    });
    await fs.writeFile(
      tasksFile,
      JSON.stringify([
        task('t1', 'Complemento de login', [{ at: '', status: 'done', by: 'auto' }]),
        task('t2', 'Tela de login', [
          { at: '', status: 'review', by: 'auto' },
          { at: '', status: 'doing', by: 'auto' },
        ]),
        task('t3', 'Tela de cadastro', []),
      ]),
    );
    const r = await f.review();
    expect(r!.tasks).toEqual({ total: 3, rework: 1, reopened: 1 });
    expect(ids(r)).toContain('rework');

    await fs.writeFile(tasksFile, JSON.stringify([task('t1', 'Complemento de login', []), task('t3', 'Tela de cadastro', [])]));
    const few = await f.review();
    expect(few!.tasks.total).toBe(2);
    expect(ids(few)).not.toContain('rework');
  });

  it('achados saem por severidade: alta antes de baixa', async () => {
    const f = await setup({ model: null, sessions: ['s1'] });
    await f.transcript('s1', [call({ id: 'm1', usage: { input: 250_000 } })]);
    const r = await f.review();
    expect(ids(r)).toEqual(['long-context', 'no-model']);
  });

  it('o texto dos achados não traz segredo que apareceu no comando', async () => {
    const f = await setup({ sessions: ['s1'] });
    const secret = 'sk-ant-api03-a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
    await f.transcript('s1', [
      call({ id: 'm1', blocks: [tool('b1', 'Bash', { command: `curl -H "x-api-key: ${secret}" https://api.exemplo.com` })] }),
      toolResult('b1', 'x'.repeat(25 * 1024)),
    ]);
    const r = await f.review();
    const big = r!.findings.find((x) => x.id === 'big-tool-output');
    expect(big).toBeDefined();
    expect(JSON.stringify(r)).not.toContain('sk-ant-api03');
    expect(big!.evidence).toContain('oculto');
  });
});

describe('fix (ajuste do botão Aplicar) só nos achados aplicáveis', () => {
  const fixOf = (r: CostReview | null, id: string) => r!.findings.find((x) => x.id === id)!.fix;

  it('heavy-model: modelo pesado em execução pede sonnet; esforço xhigh pede high; só o que é o problema', async () => {
    const model = await setup({ model: 'opus', role: 'Desenvolvedor(a) back-end', effort: null });
    expect(fixOf(await model.review(), 'heavy-model-on-implementation')).toEqual({ kind: 'ficha', model: 'sonnet' });

    const effort = await setup({ model: 'sonnet', effort: 'xhigh' });
    expect(fixOf(await effort.review(), 'heavy-model-on-implementation')).toEqual({ kind: 'ficha', effort: 'high' });

    const both = await setup({ model: 'opus', role: 'Desenvolvedor(a) back-end', effort: 'max' });
    expect(fixOf(await both.review(), 'heavy-model-on-implementation')).toEqual({ kind: 'ficha', model: 'sonnet', effort: 'high' });
  });

  it('heavy-model: opus fora de execução com esforço alto não mexe no modelo', async () => {
    const f = await setup({ model: 'opus', role: 'Arquiteto(a) de software', effort: 'xhigh' });
    expect(fixOf(await f.review(), 'heavy-model-on-implementation')).toEqual({ kind: 'ficha', effort: 'high' });
  });

  it('no-model: pede sonnet; big-memory vira tarefa; regras de saída, releitura e agents', async () => {
    const none = await setup({ model: null });
    expect(fixOf(await none.review(), 'no-model')).toEqual({ kind: 'ficha', model: 'sonnet' });

    const mem = await setup();
    await fs.writeFile(path.join(mem.projectPath, '.myco', 'staff', `${mem.staffId}.memory.md`), 'x'.repeat(9 * 1024));
    const memFix = fixOf(await mem.review(), 'big-memory');
    expect(memFix).toMatchObject({ kind: 'task', title: 'Compactar a memória' });
    expect((memFix as { description: string }).description).toContain(`.myco/staff/${mem.staffId}.memory/`);

    const tools = await setup({ sessions: ['s1'] });
    await tools.transcript('s1', [call({ id: 'm1', blocks: [tool('t1', 'Bash', { command: 'npm test' })] }), toolResult('t1', 'x'.repeat(25 * 1024))]);
    const out = await tools.review();
    expect(fixOf(out, 'big-tool-output')).toMatchObject({ kind: 'rule' });
    expect(fixOf(out, 'big-tool-output')).not.toHaveProperty('model');

    const reads = await setup({ sessions: ['s1'] });
    await reads.transcript('s1', [1, 2, 3].map((n) => call({ id: `r${n}`, blocks: [tool(`rd${n}`, 'Read', { file_path: '/src/app.ts' })] })));
    expect(fixOf(await reads.review(), 'repeated-reads')).toMatchObject({ kind: 'rule' });

    const agents = await setup({ sessions: ['s1'] });
    await agents.transcript('s1', [call({ id: 'm1', blocks: [tool('ag1', 'Agent', { prompt: 'faça tudo' })] })]);
    expect(fixOf(await agents.review(), 'inherited-model-agents')).toMatchObject({ kind: 'rule' });
  });

  it('sem fix: long-context e ignored-context-warning (comportamento, a ficha já manda usar o ponto de corte)', async () => {
    const long = await setup({ sessions: ['s1'] });
    await long.transcript('s1', [call({ id: 'm1', usage: { input: 150_000, read: 60_000 } })]);
    expect(fixOf(await long.review(), 'long-context')).toBeUndefined();

    const warned = await setup({ sessions: ['s1'] });
    await warned.transcript('s1', [call({ id: 'antes' }), notice(), ...['a', 'b', 'c', 'd', 'e'].map((x) => call({ id: x, minAgo: 50 }))]);
    expect(fixOf(await warned.review(), 'ignored-context-warning')).toBeUndefined();
  });
});
