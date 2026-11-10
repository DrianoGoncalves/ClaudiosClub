import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StaffProfile, Task } from '../shared/model';
import { CostReviewApplyBody, CostReviewApplyError, runCostReviewApply } from '../server/costReviewApply';
import { createProfile, readProfile, saveProfile, StaffInputSchema } from '../server/staff/store';

// Fixtures sintéticas num temp dir (nada do ~/.claude real). Os textos das regras são os de server/costReview.ts.
const PROJECT = 'proj-test';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const DAY = 86_400_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const RULE_OUTPUT = 'Saída grande (JSON, log, diff): salve em arquivo e filtre (grep, head, trecho); não imprima inteira na conversa.';
const TASK_TITLE = 'Compactar a memória';

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

interface SetupOptions {
  model?: string | null;
  effort?: string | null;
  role?: string;
  rules?: string[];
  sessions?: string[];
}

interface Fixture {
  projectPath: string;
  transcriptsDir: string;
  staffId: string;
  transcript: (sid: string, lines: string[]) => Promise<void>;
  memory: (bytes: number) => Promise<void>;
  tasks: (list: Array<Partial<Task>>) => Promise<void>;
}

async function setup(opts: SetupOptions = {}): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'costapply-'));
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
    rules: opts.rules ?? [],
  });
  const sessions = (opts.sessions ?? []).map((id) => ({ id, startedAt: at(2 * 60) }));
  const profile = await createProfile(projectPath, PROJECT, input, new Date(NOW - 30 * DAY), sessions);
  return {
    projectPath,
    transcriptsDir,
    staffId: profile.id,
    transcript: async (sid, lines) => {
      const dir = path.join(transcriptsDir, PROJECT);
      await fs.mkdir(path.join(dir, sid, 'subagents'), { recursive: true });
      await fs.writeFile(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n');
    },
    memory: async (bytes) => {
      await fs.writeFile(path.join(projectPath, '.myco', 'staff', `${profile.id}.memory.md`), 'x'.repeat(bytes));
    },
    tasks: async (list) => {
      const full = list.map((t, i) => ({
        id: `old-${i}`,
        title: 'Tarefa',
        description: '',
        status: 'done',
        staffId: profile.id,
        sessionId: null,
        plan: null,
        branch: null,
        pr: null,
        createdAt: at(60),
        updatedAt: at(30),
        history: [],
        ...t,
      }));
      await fs.writeFile(path.join(projectPath, '.myco', 'tasks.json'), JSON.stringify(full));
    },
  };
}

// ---- linhas no formato do Claude Code (só o que a revisão lê) ----
const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const call = (id: string, blocks: unknown[] = [{ type: 'text', text: 'ok' }]) =>
  JSON.stringify({ type: 'assistant', timestamp: at(60), requestId: `req-${id}`, message: { id, model: 'claude-sonnet-4-5', role: 'assistant', content: blocks, usage } });
const toolResult = (id: string, text: string) =>
  JSON.stringify({ type: 'user', timestamp: at(60), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const tool = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use', id, name, input });

/** Fakes da ficha e das tarefas. `persist`: a ficha gravada vale para a próxima chamada (como a tela). */
function fakes(f: Fixture, persist = false) {
  const updates: Array<Record<string, unknown>> = [];
  const created: Array<{ staffId: string; title: string; description: string }> = [];
  return {
    updates,
    created,
    updateFicha: async (body: Record<string, unknown>) => {
      updates.push(body);
      if (persist) {
        const cur = (await readProfile(f.projectPath, f.staffId))!;
        await saveProfile(f.projectPath, { ...cur, ...body, projectId: PROJECT } as StaffProfile);
      }
    },
    createTask: async (t: { staffId: string; title: string; description: string }) => {
      created.push(t);
      return { id: `task-${created.length}` } as Task;
    },
  };
}

const apply = (f: Fixture, ids: string[], k: ReturnType<typeof fakes>, days = 7) =>
  runCostReviewApply({
    fromBrowser: true,
    body: { ids, days },
    projectPath: f.projectPath,
    projectId: PROJECT,
    staffId: f.staffId,
    transcriptsDir: f.transcriptsDir,
    now: NOW,
    updateFicha: k.updateFicha,
    createTask: k.createTask,
  });

describe('recusa e validação', () => {
  it('fora do navegador (token de conversa): recusa e não muda a ficha', async () => {
    const f = await setup({ model: null });
    const k = fakes(f);
    const err = await runCostReviewApply({
      fromBrowser: false,
      body: { ids: ['no-model'], days: 7 },
      projectPath: f.projectPath,
      projectId: PROJECT,
      staffId: f.staffId,
      transcriptsDir: f.transcriptsDir,
      now: NOW,
      updateFicha: k.updateFicha,
      createTask: k.createTask,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CostReviewApplyError);
    expect((err as Error).message).toBe('só pelo Claudio’s Club');
    expect(k.updates).toEqual([]);
  });

  it('body inválido (id desconhecido, repetido, vazio, mais de 20, days fora do intervalo): recusa', async () => {
    const f = await setup({ model: null });
    const bad: unknown[] = [
      { ids: ['nao-existe'], days: 7 },
      { ids: ['no-model', 'no-model'], days: 7 },
      { ids: [], days: 7 },
      { ids: Array.from({ length: 21 }, () => 'no-model'), days: 7 },
      { ids: ['no-model'], days: 0 },
      { ids: ['no-model'], days: 3651 },
      { ids: ['no-model'], days: 1.5 },
      { ids: 'no-model', days: 7 },
      { days: 7 },
    ];
    const k = fakes(f);
    for (const body of bad) {
      const err = await runCostReviewApply({
        fromBrowser: true,
        body,
        projectPath: f.projectPath,
        projectId: PROJECT,
        staffId: f.staffId,
        transcriptsDir: f.transcriptsDir,
        now: NOW,
        updateFicha: k.updateFicha,
        createTask: k.createTask,
      }).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(CostReviewApplyError);
    }
    expect(k.updates).toEqual([]);
    expect(CostReviewApplyBody.safeParse({ ids: ['no-model'], days: 7 }).success).toBe(true);
  });

  it('ficha que não existe: null (404 na rota), sem gravar', async () => {
    const f = await setup({ model: null });
    const k = fakes(f);
    const out = await runCostReviewApply({
      fromBrowser: true,
      body: { ids: ['no-model'], days: 7 },
      projectPath: f.projectPath,
      projectId: PROJECT,
      staffId: 'nao-existe',
      transcriptsDir: f.transcriptsDir,
      now: NOW,
      updateFicha: k.updateFicha,
      createTask: k.createTask,
    });
    expect(out).toBeNull();
    expect(k.updates).toEqual([]);
  });
});

describe('ficha: só model e effort', () => {
  it('heavy-model com xhigh: muda model e effort e mais nada na ficha', async () => {
    const f = await setup({ model: 'opus', effort: 'xhigh', rules: ['Regra que já estava'] });
    const before = (await readProfile(f.projectPath, f.staffId))!;
    const k = fakes(f);
    const out = await apply(f, ['heavy-model-on-implementation'], k);

    expect(k.updates).toHaveLength(1);
    expect(k.updates[0]).toEqual({
      name: before.name,
      role: before.role,
      reportsTo: before.reportsTo,
      mission: before.mission,
      firstTask: before.firstTask,
      autonomy: before.autonomy,
      agents: before.agents,
      skills: before.skills,
      mcps: before.mcps,
      knowledge: before.knowledge,
      rules: before.rules,
      doneWhen: before.doneWhen,
      engine: before.engine,
      model: 'sonnet',
      effort: 'high',
      canHire: before.canHire,
      playbook: before.playbook,
      worktree: before.worktree,
      servers: before.servers,
      browser: before.browser,
    });
    expect(out).toEqual({
      applied: [{ id: 'heavy-model-on-implementation', kind: 'ficha', before: { model: 'opus', effort: 'xhigh' }, after: { model: 'sonnet', effort: 'high' } }],
      skipped: [],
    });
    expect(k.created).toEqual([]);
  });

  it('no-model: pede sonnet e grava só o modelo', async () => {
    const f = await setup({ model: null });
    const k = fakes(f);
    const out = await apply(f, ['no-model'], k);
    expect(k.updates[0]).toMatchObject({ model: 'sonnet', effort: null });
    expect(out!.applied).toEqual([{ id: 'no-model', kind: 'ficha', before: { model: null }, after: { model: 'sonnet' } }]);
  });
});

describe('o que não aplica vai para skipped', () => {
  it('id que não dispara mais: "não dispara mais", sem gravar nada', async () => {
    const f = await setup();
    const k = fakes(f);
    const out = await apply(f, ['no-model', 'big-memory'], k);
    expect(out).toEqual({
      applied: [],
      skipped: [
        { id: 'no-model', reason: 'não dispara mais' },
        { id: 'big-memory', reason: 'não dispara mais' },
      ],
    });
    expect(k.updates).toEqual([]);
    expect(k.created).toEqual([]);
  });

  it('achado sem ajuste automático (long-context): "sem ajuste automático"', async () => {
    const f = await setup({ sessions: ['s1'] });
    const bigCall = JSON.stringify({
      type: 'assistant',
      timestamp: at(60),
      requestId: 'r1',
      message: { id: 'm1', model: 'claude-sonnet-4-5', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { ...usage, input_tokens: 150_000, cache_read_input_tokens: 60_000 } },
    });
    await f.transcript('s1', [bigCall]);
    const k = fakes(f);
    const out = await apply(f, ['long-context'], k);
    expect(out!.skipped).toEqual([{ id: 'long-context', reason: 'sem ajuste automático' }]);
    expect(k.updates).toEqual([]);
  });
});

describe('regra: acrescenta sem duplicar', () => {
  it('não duplica: rodar duas vezes deixa a regra uma vez; a segunda vira "já aplicado"', async () => {
    const f = await setup({ sessions: ['s1'] });
    await f.transcript('s1', [call('m1', [tool('b1', 'Bash', { command: 'npm test' })]), toolResult('b1', 'x'.repeat(25 * 1024))]);
    const k = fakes(f, true);

    const first = await apply(f, ['big-tool-output'], k);
    expect(first!.applied).toEqual([{ id: 'big-tool-output', kind: 'rule' }]);
    expect((await readProfile(f.projectPath, f.staffId))!.rules).toEqual([RULE_OUTPUT]);

    const second = await apply(f, ['big-tool-output'], k);
    expect(second!.skipped).toEqual([{ id: 'big-tool-output', reason: 'já aplicado' }]);
    expect(k.updates).toHaveLength(1);
    expect((await readProfile(f.projectPath, f.staffId))!.rules).toEqual([RULE_OUTPUT]);
  });

  it('regra que já está na ficha: "já aplicado" e nem grava', async () => {
    const f = await setup({ sessions: ['s1'], rules: [RULE_OUTPUT] });
    await f.transcript('s1', [call('m1', [tool('b1', 'Bash', { command: 'npm test' })]), toolResult('b1', 'x'.repeat(25 * 1024))]);
    const k = fakes(f);
    const out = await apply(f, ['big-tool-output'], k);
    expect(out!.skipped).toEqual([{ id: 'big-tool-output', reason: 'já aplicado' }]);
    expect(k.updates).toEqual([]);
  });
});

describe('tarefa: para o próprio funcionário, sem duplicar', () => {
  it('cria uma tarefa (start, sem gestor) com o título e a descrição do ajuste', async () => {
    const f = await setup();
    await f.memory(9 * 1024);
    const k = fakes(f);
    const out = await apply(f, ['big-memory'], k);
    expect(k.created).toEqual([expect.objectContaining({ staffId: f.staffId, title: TASK_TITLE })]);
    expect(k.created[0]!.description).toContain(`.myco/staff/${f.staffId}.memory/`);
    expect(out!.applied).toEqual([{ id: 'big-memory', kind: 'task', taskId: 'task-1' }]);
    expect(k.updates).toEqual([]);
  });

  it('já existe tarefa aberta com o mesmo título: não cria outra ("já aplicado")', async () => {
    const f = await setup();
    await f.memory(9 * 1024);
    await f.tasks([{ title: TASK_TITLE, staffId: f.staffId, status: 'todo' }]);
    const k = fakes(f);
    const out = await apply(f, ['big-memory'], k);
    expect(out!.skipped).toEqual([{ id: 'big-memory', reason: 'já aplicado' }]);
    expect(k.created).toEqual([]);
  });

  it('tarefa com o mesmo título já concluída (done) não bloqueia: cria outra', async () => {
    const f = await setup();
    await f.memory(9 * 1024);
    await f.tasks([{ title: TASK_TITLE, staffId: f.staffId, status: 'done' }]);
    const k = fakes(f);
    const out = await apply(f, ['big-memory'], k);
    expect(out!.applied).toEqual([{ id: 'big-memory', kind: 'task', taskId: 'task-1' }]);
    expect(k.created).toHaveLength(1);
  });
});

describe('ficha e regra juntas numa gravação', () => {
  it('no-model e repeated-reads: uma gravação com model e regra', async () => {
    const f = await setup({ model: null, sessions: ['s1'] });
    await f.transcript('s1', [1, 2, 3].map((n) => call(`r${n}`, [tool(`rd${n}`, 'Read', { file_path: '/src/app.ts' })])));
    const k = fakes(f);
    const out = await apply(f, ['no-model', 'repeated-reads'], k);
    expect(k.updates).toHaveLength(1);
    expect(k.updates[0]).toMatchObject({ model: 'sonnet', rules: [expect.stringContaining('Não releia arquivo inteiro')] });
    expect(out!.applied.map((a) => a.id)).toEqual(['no-model', 'repeated-reads']);
  });
});
