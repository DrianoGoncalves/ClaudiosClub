import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readAgentSource, type AgentSource } from '../adapters/claude/agentWrite';
import { pathKey } from '../adapters/claude/paths';
import { CODEX_AGENT_NAME, tomlString, type CodexAgentRole } from '../chat/codexArgs';
import { writeAtomic } from './store';

// Os agents da ficha (`.claude/agents/<nome>.md`) viram subagents nativos do Codex: um TOML por agent, numa pasta da conversa em run/
// (a sandbox a nega: o agente não lê nem troca o TOML). O Codex os acha por `-c agents.<nome>.*` (ver `codexAgentArgs`).

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * O `model_reasoning_effort` do agent no Codex. O effort explícito do agent vale; senão sai do modelo do Claude (haiku → low, sonnet → medium,
 * opus/fable/mythos → high); modelo desconhecido ou ausente, null (o filho herda o esforço do pai). O `model` NUNCA vai para o TOML: o filho
 * herda o modelo Codex do pai (o alias do Claude não vale no Codex e um slug fixo pode dar model_not_found).
 */
export function codexEffortOf(a: { model: string | null; effort: string | null }): string | null {
  const effort = a.effort?.trim().toLowerCase();
  if (effort && EFFORTS.includes(effort)) return effort;
  const model = a.model ?? '';
  if (/haiku/i.test(model)) return 'low';
  if (/sonnet/i.test(model)) return 'medium';
  if (/opus|fable|mythos/i.test(model)) return 'high';
  return null;
}

const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'bash', 'powershell']);

/** O agent não tem ferramenta de escrita nem de terminal (`tools` ausente ou com `*` = todas, então não). */
export function isReadOnlyAgent(tools: string[] | null): boolean {
  if (!tools || tools.some((t) => t.trim() === '*')) return false;
  return !tools.some((t) => WRITE_TOOLS.has(t.replace(/\(.*$/, '').trim().toLowerCase()));
}

const READ_ONLY_NOTE =
  '\n\nNo Codex você roda na mesma sandbox de quem te chamou e consegue escrever; mesmo assim, só leia: não altere, crie nem apague arquivos e não rode comando que mude algo.';

/** O TOML do agent para o Codex: só as chaves que ele lê, sem `model` nem `sandbox_mode` (este não restringe). */
export function renderCodexAgentToml(a: AgentSource): string {
  const effort = codexEffortOf(a);
  const instructions = a.prompt + (isReadOnlyAgent(a.tools) ? READ_ONLY_NOTE : '');
  return (
    [
      `name = ${tomlString(a.name)}`,
      `description = ${tomlString(a.description ?? a.name)}`,
      `developer_instructions = ${tomlString(instructions)}`,
      ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    ].join('\n') + '\n'
  );
}

/**
 * Grava um TOML por agent em `outDir` (apagado e recriado: nada de arquivo velho) e devolve os roles para o Codex. A fonte é a do Claude Code:
 * pasta do cwd, depois a do projeto (se for outra) e por fim a da conta. Nome inválido ou sem fonte vai em `missing`.
 */
export async function writeCodexAgents(
  names: string[],
  dirs: { cwd: string; projectPath: string; userAgentsDir: string; outDir: string },
): Promise<{ roles: CodexAgentRole[]; missing: string[] }> {
  await rm(dirs.outDir, { recursive: true, force: true });
  await mkdir(dirs.outDir, { recursive: true });
  const roles: CodexAgentRole[] = [];
  const missing: string[] = [];
  const projectDirs = [path.join(dirs.cwd, '.claude', 'agents')];
  if (pathKey(dirs.projectPath) !== pathKey(dirs.cwd)) projectDirs.push(path.join(dirs.projectPath, '.claude', 'agents'));
  for (const name of [...new Set(names)]) {
    if (!CODEX_AGENT_NAME.test(name)) {
      missing.push(name);
      continue;
    }
    let source: AgentSource | null = null;
    for (const dir of [...projectDirs, dirs.userAgentsDir]) {
      source = await readAgentSource(dir, name).catch(() => null);
      if (source) break;
    }
    if (!source) {
      missing.push(name);
      continue;
    }
    const configFile = path.join(dirs.outDir, `${name}.toml`);
    await writeAtomic(configFile, renderCodexAgentToml(source));
    roles.push({ name, description: source.description ?? name, configFile });
  }
  return { roles, missing };
}
