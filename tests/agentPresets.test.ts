import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS, PLAYBOOK_AGENTS } from '../shared/agentPresets';
import { AgentInput, type AgentSource } from '../server/adapters/claude/agentWrite';
import { codexEffortOf, renderCodexAgentToml } from '../server/staff/codexAgents';
import { PLAYBOOK_STEPS } from '../server/staff/ficha';

// Os prontos do "Novo agent" e o que o roteiro chama: o executor implementa (Sonnet), o rápido faz o mecânico (Haiku).

const preset = (name: string) => AGENT_PRESETS.find((p) => p.name === name)!;
const asSource = (p: (typeof AGENT_PRESETS)[number]): AgentSource => ({
  name: p.name,
  description: p.description,
  model: p.model,
  effort: p.effort,
  tools: p.tools.split(',').map((t) => t.trim()),
  prompt: p.prompt,
  filePath: `/proj/.claude/agents/${p.name}.md`,
  linked: false,
});

describe('prontos de agent', () => {
  it('executor: Sonnet em esforço médio, com ferramentas de escrita', () => {
    expect(preset('executor')).toMatchObject({ model: 'sonnet', effort: 'medium', label: 'Executor (Sonnet)' });
    expect(preset('executor').tools).toMatch(/Edit.*Write.*Bash/);
  });

  it('executor-rapido: Haiku em esforço baixo, com as mesmas ferramentas e o recado de devolver o que pede julgamento', () => {
    const fast = preset('executor-rapido');
    expect(fast).toMatchObject({ model: 'haiku', effort: 'low', tools: preset('executor').tools });
    expect(fast.prompt).toMatch(/^Você é um executor rápido/);
    expect(fast.prompt).toMatch(/julgamento/);
    // Herda as regras do executor (não amplia o escopo, não delega, responde curto), sem repetir a 1ª linha.
    expect(fast.prompt).toContain('- Não chame outros agents');
    expect(fast.prompt.match(/Você é um executor/g)).toHaveLength(1);
  });

  it('os dois devolvem alterações, verificações e pendências', () => {
    for (const name of ['executor', 'executor-rapido']) expect(preset(name).prompt).toMatch(/o que você verificou.*o que ficou pendente/);
  });

  it('pesquisador e revisor ficam como estavam', () => {
    expect(preset('pesquisador')).toMatchObject({ model: 'haiku', effort: 'low', tools: 'Read, Grep, Glob' });
    expect(preset('revisor')).toMatchObject({ model: 'sonnet', effort: 'high', tools: 'Read, Grep, Glob' });
  });

  it('todo pronto passa na validação do arquivo de agent', () => {
    for (const p of AGENT_PRESETS) {
      expect(() => AgentInput.parse({ ...p, tools: p.tools.split(',').map((t) => t.trim()) })).not.toThrow();
    }
  });

  it('o roteiro só chama agents que existem como pronto; o planejador leva o executor-rapido', () => {
    const names = new Set(AGENT_PRESETS.map((p) => p.name));
    for (const agents of Object.values(PLAYBOOK_AGENTS)) for (const a of agents) expect(names.has(a)).toBe(true);
    expect(PLAYBOOK_AGENTS['plan-big-execute-small']).toEqual(['pesquisador', 'executor', 'executor-rapido', 'revisor']);
    expect(PLAYBOOK_AGENTS['review-gate']).toEqual(['executor', 'revisor']);
  });

  it('o passo "escolha quem faz" do roteiro diz o novo modelo, nos dois motores', () => {
    const step = PLAYBOOK_STEPS['plan-big-execute-small'].steps.find((s) => typeof s !== 'string' && /Escolha quem faz/.test(s.claude));
    expect(step).toBeTruthy();
    if (typeof step === 'string' || !step) return;
    expect(step.claude).toContain('`executor-rapido` (Haiku)');
    expect(step.claude).toContain('`executor` (Sonnet)');
    expect(step.claude).not.toContain('model: "sonnet"'); // o padrão já é Sonnet: subir é para o opus
    expect(step.codex).toContain('`executor-rapido` (esforço baixo)');
    expect(step.codex).toContain('`executor` (esforço médio)');
    expect(step.codex).not.toMatch(/Haiku|Sonnet|model:/);
  });
});

describe('Codex: só o esforço', () => {
  it('o esforço dos prontos vem do effort do arquivo: executor médio, rápido baixo', () => {
    expect(codexEffortOf(preset('executor'))).toBe('medium');
    expect(codexEffortOf(preset('executor-rapido'))).toBe('low');
    expect(codexEffortOf(preset('revisor'))).toBe('high');
  });

  it('o TOML leva model_reasoning_effort e nunca o modelo (o filho herda o do pai)', () => {
    const toml = (name: string) => renderCodexAgentToml(asSource(preset(name)));
    expect(toml('executor')).toContain('model_reasoning_effort = "medium"');
    expect(toml('executor-rapido')).toContain('model_reasoning_effort = "low"');
    for (const name of ['executor', 'executor-rapido']) {
      expect(toml(name)).not.toMatch(/^model =/m);
      expect(toml(name)).not.toMatch(/sonnet|haiku/i);
    }
  });
});

describe('hook de entrega', () => {
  const hook = fileURLToPath(new URL('../scripts/hooks/delivery-check.mjs', import.meta.url));
  const run = (stage: string, input: unknown) => execFileSync(process.execPath, [hook, stage], { input: JSON.stringify(input) }).toString();

  it('o executor-rapido também roda em primeiro plano e a entrega dele pede conferência', () => {
    expect(JSON.parse(run('pre', { tool_input: { subagent_type: 'executor-rapido', run_in_background: true } })).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(run('pre', { tool_input: { subagent_type: 'executor-rapido', run_in_background: false } })).toBe('');
    const post = JSON.parse(run('post', { tool_input: { subagent_type: 'executor-rapido' } }));
    expect(post.hookSpecificOutput.additionalContext).toMatch(/diff vazio = não foi feito/);
    expect(post.hookSpecificOutput.additionalContext).toContain('`executor` no lugar do `executor-rapido`');
  });
});
