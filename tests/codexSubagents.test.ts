import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTask } from '../shared/model';
import { isToolCall, itemFromCodex } from '../server/chat/codexEvents';
import { CodexSubagentWatch, parseSubAgentActivity, roleFromChildMeta } from '../server/chat/codexSubagents';
import { removeTemp } from './support/tmp';

const activity = (kind: 'started' | 'completed', thread = 'filho-1', agentPath = '/root/editar_alvo') =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'pai', item: { type: 'SubAgentActivity', kind, id: 'call_1', agent_thread_id: thread, agent_path: agentPath } } });

describe('parseSubAgentActivity', () => {
  it('started e completed', () => {
    expect(parseSubAgentActivity(activity('started'))).toEqual({ kind: 'started', threadId: 'filho-1', task: 'editar_alvo' });
    expect(parseSubAgentActivity(activity('completed'))).toEqual({ kind: 'completed', threadId: 'filho-1', task: 'editar_alvo' });
  });
  it('ignora outras linhas e JSON quebrado', () => {
    expect(parseSubAgentActivity('{"type":"session_meta","payload":{}}')).toBeNull();
    expect(parseSubAgentActivity('texto qualquer')).toBeNull();
    expect(parseSubAgentActivity(activity('started').slice(0, 60))).toBeNull();
    expect(parseSubAgentActivity('{"payload":{"item":{"type":"SubAgentActivity","kind":"started"}}}')).toBeNull();
  });
});

describe('roleFromChildMeta', () => {
  it('lê o agent_role do session_meta', () => {
    const line = JSON.stringify({ type: 'session_meta', payload: { parent_thread_id: 'pai', source: { subagent: { thread_spawn: { agent_role: 'executor' } } } } });
    expect(roleFromChildMeta(line)).toBe('executor');
  });
  it('null sem tipo, ou se não é session_meta', () => {
    expect(roleFromChildMeta(JSON.stringify({ type: 'session_meta', payload: { source: { subagent: { thread_spawn: { agent_role: null } } } } }))).toBeNull();
    expect(roleFromChildMeta('{"type":"turn_context"}')).toBeNull();
    expect(roleFromChildMeta('quebrado')).toBeNull();
  });
});

describe('CodexSubagentWatch', () => {
  let dir: string;
  let parent: string;
  let child: string;
  let seen: BackgroundTask[][];
  let watch: CodexSubagentWatch;
  let findCalls: number;
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const until = (fn: () => void) => vi.waitFor(fn, { timeout: 2000, interval: 10 });
  // Espera a 1ª leitura de verdade (find chamado + uma volta extra) antes de anexar ao arquivo.
  const firstLap = async () => {
    await until(() => expect(findCalls).toBeGreaterThan(0));
    await tick();
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sub-'));
    parent = path.join(dir, 'pai.jsonl');
    child = path.join(dir, 'filho.jsonl');
    await fs.writeFile(parent, '{"type":"session_meta","payload":{}}\n');
    await fs.writeFile(child, JSON.stringify({ type: 'session_meta', payload: { agent_role: 'executor' } }) + '\n');
    seen = [];
    findCalls = 0;
    watch = new CodexSubagentWatch({
      find: async (id) => {
        if (id === 'pai') findCalls++;
        return id === 'pai' ? parent : id === 'filho-1' ? child : null;
      },
      readFirstLine: async (file) => (await fs.readFile(file, 'utf8')).split('\n')[0] ?? null,
      onChange: (tasks) => seen.push(tasks),
      intervalMs: 10,
    });
  });
  afterEach(async () => {
    watch.stop();
    await removeTemp(dir);
  });

  const last = () => seen.at(-1);

  it('started entra com o papel, completed sai', async () => {
    watch.start('pai');
    await firstLap();
    await fs.appendFile(parent, activity('started') + '\n');
    await until(() => expect(last()).toEqual([{ id: 'filho-1', kind: 'agent', label: 'executor: editar_alvo' }]));
    await fs.appendFile(parent, activity('completed') + '\n');
    await until(() => expect(last()).toEqual([]));
  });

  it('linha parcial sem \\n espera o resto', async () => {
    watch.start('pai');
    await firstLap();
    const line = activity('started');
    await fs.appendFile(parent, line.slice(0, 50));
    await tick();
    expect(seen).toEqual([]);
    await fs.appendFile(parent, line.slice(50) + '\n');
    await until(() => expect(last()?.[0]?.label).toBe('executor: editar_alvo'));
  });

  it('sem rollout do filho mostra agent e corrige depois', async () => {
    await fs.rm(child);
    watch.start('pai');
    await firstLap();
    await fs.appendFile(parent, activity('started') + '\n');
    await until(() => expect(last()?.[0]?.label).toBe('agent: editar_alvo'));
    await fs.writeFile(child, JSON.stringify({ type: 'session_meta', payload: { agent_role: 'explorer' } }) + '\n');
    await until(() => expect(last()?.[0]?.label).toBe('explorer: editar_alvo'));
  });

  it('retomada começa do fim: eventos antigos não voltam', async () => {
    await fs.appendFile(parent, activity('started') + '\n');
    watch.start('pai');
    await firstLap();
    expect(seen).toEqual([]);
  });

  it('stop limpa a lista', async () => {
    watch.start('pai');
    await firstLap();
    await fs.appendFile(parent, activity('started') + '\n');
    await until(() => expect(last()).toHaveLength(1));
    watch.stop();
    expect(last()).toEqual([]);
    const n = seen.length;
    await fs.appendFile(parent, activity('started') + '\n');
    await tick();
    expect(seen).toHaveLength(n);
  });
});
describe('collab_tool_call', () => {
  const wait = (status: string) => ({ id: 'item_4', type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'pai', receiver_thread_ids: [], prompt: null, agents_states: {}, status });
  it('wait em andamento fica sem resultado; completo, com resultado vazio', () => {
    const run = itemFromCodex(wait('in_progress'), 'k', 'agora', 'started');
    expect(run).toMatchObject({ kind: 'tool', name: 'Agent', summary: 'esperando os agents', result: null, isError: false });
    const done = itemFromCodex(wait('completed'), 'k', 'agora', 'completed');
    expect(done).toMatchObject({ kind: 'tool', name: 'Agent', result: '', isError: false });
  });
  it('failed vira erro e conta como ferramenta', () => {
    expect(itemFromCodex(wait('failed'), 'k', 'agora', 'completed')).toMatchObject({ result: 'falhou', isError: true });
    expect(isToolCall(wait('in_progress'))).toBe(true);
  });
});
