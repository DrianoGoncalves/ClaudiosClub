import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentInput, readAgentSource, saveAgent } from '../server/adapters/claude/agentWrite';
import { activeSubagents } from '../server/adapters/claude/sessions';
import { encodeProjectDir } from '../server/adapters/claude/paths';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-agents-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const input = (over: object = {}) =>
  AgentInput.parse({
    name: 'executor',
    description: 'Executa tarefas mecânicas delegadas pelo orquestrador.',
    model: 'haiku',
    tools: ['Read', 'Edit'],
    prompt: 'Faça só a tarefa pedida.',
    ...over,
  });

describe('agents: criar e editar', () => {
  it('cria com modelo e ferramentas no frontmatter', async () => {
    const dir = path.join(root, 'p1', '.claude', 'agents');
    const a = await saveAgent(dir, input(), path.join(root, 'bk'));
    expect(a).toMatchObject({ name: 'executor', model: 'haiku', tools: ['Read', 'Edit'], prompt: 'Faça só a tarefa pedida.', linked: false });
    const text = await fs.readFile(path.join(dir, 'executor.md'), 'utf8');
    expect(text).toMatch(/^---\nname: executor\ndescription: .+\ntools: Read, Edit\nmodel: haiku\n---\n\nFaça só a tarefa pedida\.\n$/);
  });

  it('edita preservando chaves desconhecidas, guarda backup e recusa nome repetido', async () => {
    const dir = path.join(root, 'p2', '.claude', 'agents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'arquivo-antigo.md'), '---\nname: velho\ndescription: x\ncolor: blue\n---\ncorpo antigo\n');
    const backups = path.join(root, 'bk2');

    const a = await saveAgent(dir, input({ originalName: 'velho', name: 'novo', model: 'inherit', tools: null }), backups);
    expect(a).toMatchObject({ name: 'novo', model: null, tools: null });
    const text = await fs.readFile(path.join(dir, 'arquivo-antigo.md'), 'utf8');
    expect(text).toContain('color: blue');
    expect(text).not.toContain('model:');
    expect(await fs.readdir(backups)).toHaveLength(1);

    await saveAgent(dir, input({ name: 'outro' }), backups);
    await expect(saveAgent(dir, input({ originalName: 'outro', name: 'novo' }), backups)).rejects.toThrow('já existe');
    expect(await readAgentSource(dir, 'nao-existe')).toBeNull();
  });

  it('valida nome, descrição e modelo', () => {
    expect(() => input({ name: 'Com Espaço' })).toThrow();
    expect(() => input({ description: 'curta' })).toThrow();
    expect(() => input({ model: 'rm -rf' })).toThrow();
  });
});

describe('subagents trabalhando agora', () => {
  it('detecta pelo transcript recente do subagent', async () => {
    const home = path.join(root, 'home');
    const cwd = path.join(root, 'proj');
    const dir = path.join(home, 'projects', encodeProjectDir(path.resolve(cwd)), 's1', 'subagents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'agent-a.jsonl'), '{}\n');
    await fs.writeFile(path.join(dir, 'agent-a.meta.json'), JSON.stringify({ agentType: 'executor' }));
    await fs.writeFile(path.join(dir, 'agent-b.jsonl'), '{}\n');
    await fs.writeFile(path.join(dir, 'agent-b.meta.json'), JSON.stringify({ agentType: 'Explore' }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(dir, 'agent-b.jsonl'), old, old);

    expect(await activeSubagents(home, cwd, 's1')).toEqual(['executor']);
    expect(await activeSubagents(home, cwd, 'sem-subagents')).toEqual([]);
  });
});
