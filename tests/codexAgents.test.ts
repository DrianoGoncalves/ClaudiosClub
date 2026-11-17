import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSource } from '../server/adapters/claude/agentWrite';
import { buildCodexArgs, codexAgentArgs, tomlString, type CodexAgentRole } from '../server/chat/codexArgs';
import { codexEffortOf, isReadOnlyAgent, renderCodexAgentToml, resolveCodexAgents, writeCodexAgents } from '../server/staff/codexAgents';
import { renderFicha, type FichaContext } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';

// Os agents da ficha como subagents do Codex: o esforço, o TOML, a gravação em pasta temporária, os `-c agents.*` e a ficha.

describe('codexEffortOf', () => {
  it('sai do modelo do Claude: haiku baixo, sonnet médio, opus alto', () => {
    expect(codexEffortOf({ model: 'haiku', effort: null })).toBe('low');
    expect(codexEffortOf({ model: 'sonnet', effort: null })).toBe('medium');
    expect(codexEffortOf({ model: 'opus', effort: null })).toBe('high');
    expect(codexEffortOf({ model: 'claude-sonnet-4-5', effort: null })).toBe('medium');
  });

  it('o effort explícito vence o modelo', () => {
    expect(codexEffortOf({ model: 'haiku', effort: 'xhigh' })).toBe('xhigh');
    expect(codexEffortOf({ model: 'opus', effort: 'LOW' })).toBe('low');
  });

  it('modelo desconhecido ou ausente: null (o filho herda o esforço do pai)', () => {
    expect(codexEffortOf({ model: 'gpt-6-sol', effort: null })).toBeNull();
    expect(codexEffortOf({ model: null, effort: null })).toBeNull();
    expect(codexEffortOf({ model: null, effort: 'ultra' })).toBeNull(); // nível que o Codex do agent não aceita
  });
});

describe('isReadOnlyAgent', () => {
  it('só com ferramentas de leitura, sim', () => {
    expect(isReadOnlyAgent(['Read', 'Grep', 'Glob'])).toBe(true);
  });

  it('com ferramenta de escrita ou de terminal, não', () => {
    expect(isReadOnlyAgent(['Read', 'Edit'])).toBe(false);
    expect(isReadOnlyAgent(['Read', 'Bash(git:*)'])).toBe(false);
    expect(isReadOnlyAgent(['Read', 'PowerShell'])).toBe(false);
  });

  it('sem lista (todas as ferramentas) ou com "*", não', () => {
    expect(isReadOnlyAgent(null)).toBe(false);
    expect(isReadOnlyAgent(['*'])).toBe(false);
  });
});

describe('renderCodexAgentToml', () => {
  const source = (over: Partial<AgentSource> = {}): AgentSource => ({
    name: 'revisor',
    description: 'Revisa o que foi feito',
    model: 'haiku',
    effort: null,
    tools: ['Read', 'Grep'],
    prompt: 'Revise o diff.',
    filePath: '/proj/.claude/agents/revisor.md',
    linked: false,
    ...over,
  });
  const keysOf = (toml: string) => toml.split('\n').filter(Boolean).map((l) => l.split(' = ')[0]);

  it('nunca grava `model` nem `sandbox_mode`; só as chaves que o Codex lê', () => {
    const toml = renderCodexAgentToml(source({ effort: 'high' }));
    for (const line of toml.split('\n')) {
      expect(line.startsWith('model =')).toBe(false);
      expect(line.startsWith('sandbox_mode')).toBe(false);
    }
    expect(keysOf(toml)).toEqual(['name', 'description', 'developer_instructions', 'model_reasoning_effort']);
    expect(toml).toContain('model_reasoning_effort = "high"');
  });

  it('sem esforço conhecido, a chave `model_reasoning_effort` some', () => {
    const toml = renderCodexAgentToml(source({ model: null, effort: null }));
    expect(keysOf(toml)).toEqual(['name', 'description', 'developer_instructions']);
  });

  it('sem description, o nome ocupa o lugar', () => {
    expect(renderCodexAgentToml(source({ description: null }))).toContain('description = "revisor"');
  });

  it('aspas, """, barra invertida e quebra de linha do prompt saem escapados, como em `tomlString`', () => {
    const prompt = 'Diga "oi"\nTrês aspas: """ fim\nCaminho C:\\x\\y\n\tTab';
    const toml = renderCodexAgentToml(source({ prompt, tools: ['Edit'] }));
    const line = toml.split('\n').find((l) => l.startsWith('developer_instructions = '))!;
    expect(line).toBe(`developer_instructions = ${tomlString(prompt)}`);
    expect(line).not.toContain('"""');
    expect(line).toContain('\\n');
    expect(line).toContain('\\\\x\\\\y');
    // Nenhuma quebra de linha crua dentro do valor: cada chave ocupa exatamente uma linha.
    expect(toml.split('\n').filter(Boolean)).toHaveLength(4);
    expect(toml.endsWith('\n')).toBe(true);
  });

  it('a frase "só leia" entra só no agent sem ferramenta de escrita', () => {
    expect(renderCodexAgentToml(source({ tools: ['Read', 'Grep'] }))).toContain('só leia');
    expect(renderCodexAgentToml(source({ tools: ['Read', 'Edit'] }))).not.toContain('só leia');
    expect(renderCodexAgentToml(source({ tools: ['Bash(git:*)'] }))).not.toContain('só leia');
    expect(renderCodexAgentToml(source({ tools: null }))).not.toContain('só leia');
  });
});

describe('writeCodexAgents', () => {
  let root: string;
  let cwd: string;
  let project: string;
  let user: string;
  let outDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cxagents-'));
    cwd = path.join(root, 'wt');
    project = path.join(root, 'proj');
    user = path.join(root, 'user-agents');
    outDir = path.join(root, 'run', 'agents');
    await fs.mkdir(user, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const dirs = () => ({ cwd, projectPath: project, userAgentsDir: user, outDir });
  const putAgent = async (dir: string, name: string, body: string, extra = 'model: haiku\ntools: Read, Grep\n') => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: desc de ${body}\n${extra}---\n${body}\n`);
  };
  const projAgents = (base: string) => path.join(base, '.claude', 'agents');

  it('grava um TOML por agent em outDir, com a description do frontmatter e o configFile dentro de outDir', async () => {
    await putAgent(projAgents(project), 'executor', 'faz o trabalho', 'model: sonnet\ntools: Read, Edit\n');
    const r = await writeCodexAgents(['executor'], dirs());
    expect(r.missing).toEqual([]);
    expect(r.roles).toEqual([{ name: 'executor', description: 'desc de faz o trabalho', configFile: path.join(outDir, 'executor.toml') }]);
    const toml = await fs.readFile(r.roles[0]!.configFile, 'utf8');
    expect(toml).toContain('name = "executor"');
    expect(toml).toContain('developer_instructions = "faz o trabalho"');
    expect(toml).toContain('model_reasoning_effort = "medium"');
    expect(toml).not.toMatch(/^model =/m);
  });

  it('precedência: pasta do cwd, depois a do projeto, por fim a da conta', async () => {
    await putAgent(projAgents(cwd), 'revisor', 'corpo do cwd');
    await putAgent(projAgents(project), 'revisor', 'corpo do projeto');
    await putAgent(user, 'revisor', 'corpo da conta');
    const r = await writeCodexAgents(['revisor'], dirs());
    expect(await fs.readFile(r.roles[0]!.configFile, 'utf8')).toContain('corpo do cwd');

    await fs.rm(projAgents(cwd), { recursive: true });
    const r2 = await writeCodexAgents(['revisor'], dirs());
    const t2 = await fs.readFile(r2.roles[0]!.configFile, 'utf8');
    expect(t2).toContain('corpo do projeto');
    expect(t2).not.toContain('corpo do cwd');

    await fs.rm(projAgents(project), { recursive: true });
    const r3 = await writeCodexAgents(['revisor'], dirs());
    expect(await fs.readFile(r3.roles[0]!.configFile, 'utf8')).toContain('corpo da conta');
  });

  it('cwd igual ao projeto: lê a pasta uma vez e ainda cai na conta', async () => {
    await putAgent(user, 'pesquisador', 'da conta');
    const r = await writeCodexAgents(['pesquisador'], { ...dirs(), cwd: project });
    expect(r.missing).toEqual([]);
    expect(await fs.readFile(r.roles[0]!.configFile, 'utf8')).toContain('da conta');
  });

  it('nome inválido ou sem fonte vai para `missing`, e nome repetido grava uma vez', async () => {
    await putAgent(user, 'executor', 'ok');
    await putAgent(user, 'a b', 'espaço').catch(() => undefined);
    await putAgent(user, 'x.y', 'ponto').catch(() => undefined);
    const r = await writeCodexAgents(['a b', 'x.y', 'nao-existe', 'executor', 'executor'], dirs());
    expect(r.missing).toEqual(['a b', 'x.y', 'nao-existe']);
    expect(r.roles.map((x) => x.name)).toEqual(['executor']);
    expect((await fs.readdir(outDir)).sort()).toEqual(['executor.toml']);
  });

  it('arquivo velho em outDir some', async () => {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'velho.toml'), 'name = "velho"\n');
    await putAgent(user, 'executor', 'ok');
    await writeCodexAgents(['executor'], dirs());
    expect(await fs.readdir(outDir)).toEqual(['executor.toml']);
    await writeCodexAgents([], dirs());
    expect(await fs.readdir(outDir)).toEqual([]);
  });
});

describe('resolveCodexAgents: a mesma busca, sem gravar', () => {
  it('diz quem tem fonte (sem repetir) e quem falta, e não grava TOML nenhum', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cxresolve-'));
    try {
      const user = path.join(root, 'user-agents');
      await fs.mkdir(user, { recursive: true });
      await fs.writeFile(path.join(user, 'executor.md'), '---\nname: executor\ndescription: d\nmodel: haiku\ntools: Read\n---\nfaz\n');
      const r = await resolveCodexAgents(['executor', 'nao-existe', 'a b', 'executor'], { cwd: path.join(root, 'wt'), projectPath: path.join(root, 'proj'), userAgentsDir: user });
      expect(r).toEqual({ found: ['executor'], missing: ['nao-existe', 'a b'] });
      expect(await fs.readdir(root)).toEqual(['user-agents']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('codexAgentArgs', () => {
  const roles: CodexAgentRole[] = [
    { name: 'executor', description: 'Faz "a coisa"', configFile: 'C:\\Users\\bia\\run\\agents\\executor.toml' },
    { name: 'revisor', description: 'Revisa', configFile: '/run/agents/revisor.toml' },
  ];

  it('gera description e config_file por agent (barras invertidas viram /) e agents.max_depth=1 no fim', () => {
    expect(codexAgentArgs(roles)).toEqual([
      '-c', `agents.executor.description=${tomlString('Faz "a coisa"')}`,
      '-c', 'agents.executor.config_file="C:/Users/bia/run/agents/executor.toml"',
      '-c', 'agents.revisor.description="Revisa"',
      '-c', 'agents.revisor.config_file="/run/agents/revisor.toml"',
      '-c', 'agents.max_depth=1',
    ]);
  });

  it('vazio ou undefined: nada', () => {
    expect(codexAgentArgs([])).toEqual([]);
    expect(codexAgentArgs(undefined)).toEqual([]);
  });

  it('role com nome inválido é ignorado; só inválidos, nada (nem max_depth)', () => {
    const bad: CodexAgentRole = { name: 'a b=c', description: 'x', configFile: '/x.toml' };
    const args = codexAgentArgs([bad, roles[1]!]);
    expect(args).toEqual([
      '-c', 'agents.revisor.description="Revisa"',
      '-c', 'agents.revisor.config_file="/run/agents/revisor.toml"',
      '-c', 'agents.max_depth=1',
    ]);
    expect(codexAgentArgs([bad])).toEqual([]);
  });
});

describe('buildCodexArgs com agents', () => {
  const base = { cwd: '/proj', sandbox: 'read-only' as const, network: 'loopback' as const, platform: 'linux' as const, secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };
  const agents: CodexAgentRole[] = [
    { name: 'executor', description: 'Executa', configFile: '/run/agents/executor.toml' },
    { name: 'revisor', description: 'Revisa', configFile: '/run/agents/revisor.toml' },
  ];
  const agentConfigs = (args: string[]) => args.filter((a) => a.startsWith('agents.'));

  it('na primeira execução os argumentos de agents aparecem', () => {
    const args = buildCodexArgs({ ...base, agents });
    expect(agentConfigs(args)).toEqual([
      'agents.executor.description="Executa"',
      'agents.executor.config_file="/run/agents/executor.toml"',
      'agents.revisor.description="Revisa"',
      'agents.revisor.config_file="/run/agents/revisor.toml"',
      'agents.max_depth=1',
    ]);
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
  });

  it('no resume (threadId) também, antes do thread e do "-"', () => {
    const id = '01a1babd-2221-7471-bc6f-23be3a417793';
    const args = buildCodexArgs({ ...base, agents, threadId: id });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(agentConfigs(args)).toHaveLength(5);
    expect(args.indexOf('agents.max_depth=1')).toBeLessThan(args.indexOf(id));
    expect(args.at(-2)).toBe(id);
    expect(args.at(-1)).toBe('-');
  });

  it('sem agents (ausente ou vazio) não há nenhum `agents.`', () => {
    expect(buildCodexArgs(base).some((a) => a.startsWith('agents.'))).toBe(false);
    expect(buildCodexArgs({ ...base, agents: [] }).some((a) => a.startsWith('agents.'))).toBe(false);
    expect(buildCodexArgs({ ...base, threadId: 'abc' }).some((a) => a.startsWith('agents.'))).toBe(false);
  });
});

describe('ficha do Codex com agents', () => {
  const ctx: FichaContext = {
    company: 'Acme',
    projectName: 'site',
    projectPath: '/proj',
    managerNames: [],
    fichaPath: '.myco/staff/cris.md',
    memoryPath: '.myco/staff/cris.memory.md',
    mycoUrl: 'http://localhost:3777',
  };
  const person: StaffProfile = {
    id: 'cris',
    projectId: 'p',
    name: 'Cris',
    role: 'Dev',
    portrait: null,
    reportsTo: [],
    mission: 'Cuidar do site.',
    firstTask: '',
    autonomy: 'manual',
    agents: ['executor'],
    skills: [],
    mcps: null,
    knowledge: [],
    rules: [],
    doneWhen: 'Testes passando.',
    model: 'gpt-6-sol',
    effort: 'high',
    canHire: false,
    playbook: 'review-gate',
    worktree: false,
    servers: [],
    browser: false,
    engine: 'codex',
    sessions: [],
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };

  it('com agents gravados, o roteiro delega por spawn_agent e a seção lista os agents e os que faltam', () => {
    const text = renderFicha(person, { ...ctx, codexAgents: { available: ['executor', 'revisor'], missing: ['pesquisador'] } });
    expect(text).toContain('## Agents indicados');
    expect(text).toContain('Agents: executor, revisor.');
    expect(text).toContain('Não encontrados no projeto: pesquisador');
    expect(text).toContain('## Roteiro: Portão de revisão');
    expect(text).toContain('1. Planeje e delegue as tarefas ao agent `executor`.');
    expect(text).toContain('spawn_agent');
    expect(text).toContain('fork_turns');
    expect(text).toContain('wait_agent');
    expect(text).not.toContain('subagent_type');
    expect(text).not.toContain('run_in_background');
    expect(text).not.toContain('trabalha sozinho');
  });

  it('sem `codexAgents`, o roteiro vira "trabalha sozinho" e não há spawn_agent nem seção de agents', () => {
    const text = renderFicha(person, ctx);
    expect(text).toContain('trabalha sozinho');
    expect(text).not.toContain('spawn_agent');
    expect(text).not.toContain('## Agents indicados');
  });

  it('só agents que faltam: a seção avisa, e o roteiro segue sozinho', () => {
    const text = renderFicha(person, { ...ctx, codexAgents: { available: [], missing: ['executor'] } });
    expect(text).toContain('Agents: nenhum em especial.');
    expect(text).toContain('Não encontrados no projeto: executor');
    expect(text).toContain('trabalha sozinho');
    expect(text).not.toContain('spawn_agent');
  });
});
