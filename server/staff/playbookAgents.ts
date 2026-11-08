import path from 'node:path';
import { AGENT_PRESETS, PLAYBOOK_AGENTS } from '../../shared/agentPresets';
import type { StaffProfile } from '../../shared/model';
import { AgentInput, readAgentSource, saveAgent, type AgentSource } from '../adapters/claude/agentWrite';
import { pathKey } from '../adapters/claude/paths';

// O roteiro da ficha chama agents pelo nome (executor, pesquisador, revisor). Sem eles no projeto,
// o funcionário não tem para quem delegar. Faltando no projeto e na conta, o Claudio’s Club cria o pronto em
// `<projeto>/.claude/agents`: aparece no quadro e dá para editar. O que já existe não é tocado.

/** Formato de cada agent em `--agents` (o arquivo JSON que o claude aceita). */
export interface InlineAgent {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  effort?: string;
}

export interface PlaybookAgentsResult {
  /** Agents criados agora no projeto. */
  created: string[];
  /**
   * Rodando noutra pasta (a worktree, que não tem os arquivos novos do projeto): os que faltam lá,
   * com a definição do projeto, para ir por `--agents`.
   */
  inline: Record<string, InlineAgent>;
}

export async function ensurePlaybookAgents(
  profile: Pick<StaffProfile, 'playbook'>,
  dirs: { projectPath: string; cwd: string; userAgentsDir: string; backupDir: string },
): Promise<PlaybookAgentsResult> {
  const out: PlaybookAgentsResult = { created: [], inline: {} };
  if (!profile.playbook) return out;
  const projectAgents = path.join(dirs.projectPath, '.claude', 'agents');
  const away = pathKey(dirs.cwd) !== pathKey(dirs.projectPath);
  for (const name of PLAYBOOK_AGENTS[profile.playbook]) {
    if (await readAgentSource(dirs.userAgentsDir, name)) continue; // o da conta vale em todo projeto
    let source = await readAgentSource(projectAgents, name);
    if (!source) {
      source = await createPreset(projectAgents, name, dirs.backupDir);
      if (!source) continue;
      out.created.push(name);
    }
    if (away && !(await readAgentSource(path.join(dirs.cwd, '.claude', 'agents'), name))) out.inline[name] = inline(source);
  }
  return out;
}

async function createPreset(dir: string, name: string, backupDir: string): Promise<AgentSource | null> {
  const preset = AGENT_PRESETS.find((p) => p.name === name);
  if (!preset) return null;
  const input = AgentInput.parse({
    name,
    description: preset.description,
    model: preset.model,
    effort: preset.effort,
    tools: preset.tools.split(',').map((t) => t.trim()).filter(Boolean),
    prompt: preset.prompt,
  });
  // Dois funcionários abrindo juntos: o segundo encontra o arquivo que o primeiro acabou de criar.
  return saveAgent(dir, input, backupDir).catch(() => readAgentSource(dir, name));
}

function inline(a: AgentSource): InlineAgent {
  return {
    description: a.description ?? a.name,
    prompt: a.prompt,
    ...(a.tools?.length && { tools: a.tools }),
    ...(a.model && a.model !== 'inherit' && { model: a.model }),
    ...(a.effort && { effort: a.effort }),
  };
}
