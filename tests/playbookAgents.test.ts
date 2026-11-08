import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { readAgentSource } from '../server/adapters/claude/agentWrite';
import { buildClaudeArgs } from '../server/staff/ficha';
import { staffSettings } from '../server/staff/launch';
import { ensurePlaybookAgents } from '../server/staff/playbookAgents';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-pb-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function dirs(name: string) {
  const projectPath = path.join(root, name);
  const userAgentsDir = path.join(root, `${name}-user`);
  await fs.mkdir(projectPath, { recursive: true });
  return { projectPath, cwd: projectPath, userAgentsDir, backupDir: path.join(root, `${name}-bak`) };
}

describe('agents do roteiro', () => {
  it('cria no projeto os que faltam, com o modelo do pronto', async () => {
    const d = await dirs('a');
    const r = await ensurePlaybookAgents({ playbook: 'review-gate' }, d);
    expect(r).toEqual({ created: ['executor', 'revisor'], inline: {} });
    const executor = await readAgentSource(path.join(d.projectPath, '.claude', 'agents'), 'executor');
    expect(executor).toMatchObject({ model: 'haiku', tools: expect.arrayContaining(['Edit', 'Bash']) });
    expect((await readAgentSource(path.join(d.projectPath, '.claude', 'agents'), 'revisor'))?.model).toBe('sonnet');
    // Na segunda vez não cria nada.
    expect((await ensurePlaybookAgents({ playbook: 'review-gate' }, d)).created).toEqual([]);
  });

  it('não mexe no que já existe no projeto nem duplica o da conta', async () => {
    const d = await dirs('b');
    const own = path.join(d.projectPath, '.claude', 'agents', 'executor.md');
    await fs.mkdir(path.dirname(own), { recursive: true });
    await fs.writeFile(own, '---\nname: executor\ndescription: o meu executor, do jeito do projeto\nmodel: sonnet\n---\n\nmeu\n');
    await fs.mkdir(d.userAgentsDir, { recursive: true });
    await fs.writeFile(path.join(d.userAgentsDir, 'pesquisador.md'), '---\nname: pesquisador\ndescription: pesquisador da conta inteira\n---\n\nda conta\n');
    const r = await ensurePlaybookAgents({ playbook: 'scout-then-build' }, d);
    expect(r.created).toEqual([]);
    expect(await fs.readFile(own, 'utf8')).toContain('model: sonnet');
    expect(await readAgentSource(path.join(d.projectPath, '.claude', 'agents'), 'pesquisador')).toBeNull();
  });

  it('sem roteiro, nada; numa worktree, os que faltam lá vão por --agents', async () => {
    const d = await dirs('c');
    expect(await ensurePlaybookAgents({ playbook: null }, d)).toEqual({ created: [], inline: {} });
    const wt = path.join(root, 'c-wt');
    await fs.mkdir(wt, { recursive: true });
    const r = await ensurePlaybookAgents({ playbook: 'plan-big-execute-small' }, { ...d, cwd: wt });
    expect(r.created).toEqual(['pesquisador', 'executor', 'revisor']);
    expect(r.inline.executor).toMatchObject({ model: 'haiku', prompt: expect.stringMatching(/^Você é um executor/), tools: expect.any(Array) });
  });
});

describe('consultor-gpt (Codex ligado)', () => {
  it('só nasce com o Codex ligado; desligado, o roteiro fica como era', async () => {
    const off = await dirs('codex-off');
    expect((await ensurePlaybookAgents({ playbook: 'review-gate' }, { ...off, codex: false })).created).toEqual(['executor', 'revisor']);
    expect(await readAgentSource(path.join(off.projectPath, '.claude', 'agents'), 'consultor-gpt')).toBeNull();

    const on = await dirs('codex-on');
    const r = await ensurePlaybookAgents({ playbook: 'review-gate' }, { ...on, codex: true });
    expect(r.created).toEqual(['executor', 'revisor', 'consultor-gpt']);
    const agent = await readAgentSource(path.join(on.projectPath, '.claude', 'agents'), 'consultor-gpt');
    expect(agent).toMatchObject({ model: 'haiku', tools: ['Bash'] });
    // Só leitura que nega .vps e ~/.ssh, sem config do usuário nem conectores, sem forçar modelo nem liberar nada;
    // o prompt vai por stdin, em heredoc entre aspas simples.
    const cmd = agent!.prompt.split('\n').find((l) => l.includes('codex exec'))!;
    for (const part of [
      'codex exec --ignore-user-config',
      '-c features.apps=false',
      `-c 'default_permissions="mycodeny"'`,
      `-c 'permissions.mycodeny.extends=":read-only"'`,
      `-c 'permissions.mycodeny.filesystem={":project_roots"={".vps"="deny"},"~/.ssh"="deny"}'`,
      '--ephemeral --skip-git-repo-check -C "$PWD" -c model_reasoning_effort="high" -o "$out" -',
      "<<'PROMPT_GPT'",
    ]) {
      expect(cmd).toContain(part);
    }
    expect(cmd).not.toMatch(/ -m |--full-auto|--dangerously|--sandbox| -s /);
    expect(agent!.prompt.match(/codex exec/g)).toHaveLength(1);
    expect(agent!.prompt).toMatch(/veio do GPT/);
    // Ligar depois num projeto que já tem o roteiro cria só o que faltava.
    const later = await ensurePlaybookAgents({ playbook: 'review-gate' }, { ...off, codex: true });
    expect(later.created).toEqual(['consultor-gpt']);
  });

  it('sem roteiro não cria nada; numa worktree vai por --agents', async () => {
    const d = await dirs('codex-wt');
    expect(await ensurePlaybookAgents({ playbook: null }, { ...d, codex: true })).toEqual({ created: [], inline: {} });
    const wt = path.join(root, 'codex-wt-away');
    await fs.mkdir(wt, { recursive: true });
    const r = await ensurePlaybookAgents({ playbook: 'scout-then-build' }, { ...d, cwd: wt, codex: true });
    expect(r.inline['consultor-gpt']).toMatchObject({ model: 'haiku', tools: ['Bash'], prompt: expect.stringMatching(/^Você é o consultor-gpt/) });
  });
});

describe('hooks do Claudio’s Club', () => {
  const hook = fileURLToPath(new URL('../scripts/hooks/delivery-check.mjs', import.meta.url));
  const run = (stage: string, input: unknown) => execFileSync(process.execPath, [hook, stage], { input: JSON.stringify(input) }).toString();

  it('o roteiro roda em primeiro plano, sempre com o agent pelo nome; a entrega do executor pede conferência', () => {
    const deny = (reason: RegExp) => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(reason) },
    });
    expect(JSON.parse(run('pre', { tool_input: { subagent_type: 'executor', run_in_background: true } }))).toEqual(deny(/run_in_background: false/));
    // Sem o parâmetro, o Claude Code põe em segundo plano: também volta.
    expect(JSON.parse(run('pre', { tool_input: { subagent_type: 'pesquisador' } }))).toEqual(deny(/run_in_background: false/));
    expect(run('pre', { tool_input: { subagent_type: 'executor', run_in_background: false } })).toBe('');
    expect(run('pre', { tool_input: { subagent_type: 'Explore', run_in_background: true } })).toBe('');
    // O consultor-gpt (Codex ligado) é do roteiro como os outros: a resposta dele precisa voltar na conversa.
    expect(JSON.parse(run('pre', { tool_input: { subagent_type: 'consultor-gpt', run_in_background: true } }))).toEqual(deny(/run_in_background: false/));
    expect(run('pre', { tool_input: { subagent_type: 'consultor-gpt', run_in_background: false } })).toBe('');
    // Sem subagent_type vira fork ou general-purpose, no modelo de quem chama.
    expect(JSON.parse(run('pre', { tool_input: { prompt: 'faça' } }))).toEqual(deny(/subagent_type/));
    expect(JSON.parse(run('post', { tool_input: { subagent_type: 'executor' } })).hookSpecificOutput.additionalContext).toMatch(/diff vazio = não foi feito/);
    // Ainda rodando em segundo plano: nada a conferir agora.
    expect(run('post', { tool_input: { subagent_type: 'executor' }, tool_response: { status: 'async_launched' } })).toBe('');
    expect(run('post', { tool_input: { subagent_type: 'revisor' } })).toBe('');
    expect(run('post', 'lixo')).toBe('');
    expect(run('pre', 'lixo')).toBe('');
  });

  it('vão para o claude por --settings, com o node chamado direto', () => {
    const s = staffSettings();
    expect(s.hooks.PreToolUse[0]).toMatchObject({ matcher: 'Agent|Task', hooks: [{ type: 'command', command: process.execPath, args: [hook, 'pre'] }] });
    const p = { name: 'Ana', role: 'Dev', autonomy: 'acceptEdits', model: null, effort: null, browser: false, mcps: null, servers: [] } as unknown as StaffProfile;
    const args = buildClaudeArgs(p, {
      sessionId: 's',
      resume: false,
      systemPromptFile: 'sys.md',
      mcpConfigPath: null,
      settingsFile: 'settings.json',
      agentsFile: 'agents.json',
      firstPrompt: null,
    });
    expect(args.join(' ')).toContain('--settings settings.json --agents agents.json');
  });
});
