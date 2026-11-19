import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AGENT_PRESETS, type AgentPreset } from '../../shared/agentPresets';
import { AgentInput, readAgentSource, saveAgent, type AgentSource } from '../adapters/claude/agentWrite';
import { parseFrontmatter } from '../adapters/claude/frontmatter';
import { writeAtomic } from './store';

// O playbookAgents só cria o agent que falta: o que já está em `.claude/agents` nunca muda sozinho. Quando um pronto muda (o executor passou
// de Haiku/low para Sonnet/medium), esta migração atualiza só o arquivo que ainda é igual ao pronto antigo, ou seja, que ninguém editou. O
// personalizado fica como está e vai no relatório, com o que difere. Cada projeto é migrado uma vez (registro em `recordFile`).

/** Os prontos como eram antes da mudança (cópia literal: editar o pronto novo não pode mudar o que conta como "antigo"). */
const LEGACY_PRESETS: AgentPreset[] = [
  {
    label: 'Executor (Haiku)',
    name: 'executor',
    description: 'Executa tarefas bem especificadas que o orquestrador delegar: editar os arquivos indicados, aplicar mudanças repetitivas, rodar comandos de verificação.',
    model: 'haiku',
    effort: 'low',
    tools: 'Read, Grep, Glob, Edit, Write, Bash, PowerShell',
    prompt: [
      'Você é um executor. Faça exatamente a tarefa recebida, sem ampliar o escopo.',
      '- Leia só o necessário para a tarefa.',
      '- Se algo estiver ambíguo ou fora do combinado, pare e diga o que falta em vez de adivinhar.',
      '- Não chame outros agents nem divida a tarefa: se ela for grande demais, devolva dizendo isso.',
      '- Commit, push, instalar dependências, apagar arquivos ou mexer fora dos arquivos combinados só se a tarefa pedir.',
      '- Antes de responder, rode a verificação que a tarefa pedir (ou a mais simples que prove que funciona).',
      '- Responda curto: o que mudou, com arquivo:linha, e o que você verificou (comando e resultado). Não cole arquivos inteiros nem diffs longos.',
      '- Se não conseguiu, diga o motivo e onde parou, em uma ou duas linhas.',
    ].join('\n'),
  },
];

/** As chaves que o pronto grava; qualquer outra (color, hooks…) é de quem editou. */
const PRESET_KEYS = new Set(['name', 'description', 'tools', 'model', 'effort']);

export interface PresetMigration {
  /** Agents atualizados para o pronto novo (o arquivo anterior foi para a pasta de backup). */
  updated: string[];
  /** Os que ficaram como estavam, cada um com o motivo (personalizado e no que difere, ou link). */
  kept: string[];
}

/** A ferramenta PowerShell só entra no arquivo no Windows (ver saveAgent): comparar sem ela. */
const toolSet = (tools: string[] | null): string => (tools ?? []).filter((t) => !/^PowerShell\b/.test(t)).join(',');

/** Em que o arquivo difere do pronto (vazio = igual). */
async function differences(source: AgentSource, preset: AgentPreset): Promise<string[]> {
  const diff: string[] = [];
  if (source.description !== preset.description) diff.push('description');
  if (source.model !== preset.model) diff.push('model');
  if (source.effort !== preset.effort) diff.push('effort');
  if (toolSet(source.tools) !== toolSet(preset.tools.split(',').map((t) => t.trim()))) diff.push('tools');
  if (source.prompt !== preset.prompt.trim()) diff.push('prompt');
  const text = await fs.readFile(source.filePath, 'utf8').catch(() => '');
  const extra = Object.keys(parseFrontmatter(text).data).filter((k) => !PRESET_KEYS.has(k));
  if (extra.length) diff.push(`chaves extras: ${extra.join(', ')}`);
  return diff;
}

/** Atualiza, em `dir` (`<projeto>/.claude/agents`), os agents que ainda são iguais ao pronto antigo. `backupDir` guarda o arquivo anterior. */
export async function migrateAgentPresets(dir: string, backupDir: string): Promise<PresetMigration> {
  const out: PresetMigration = { updated: [], kept: [] };
  for (const legacy of LEGACY_PRESETS) {
    const current = AGENT_PRESETS.find((p) => p.name === legacy.name);
    const source = await readAgentSource(dir, legacy.name);
    if (!current || !source) continue;
    const fromLegacy = await differences(source, legacy);
    if (!fromLegacy.length) {
      // Link: o arquivo é de outro lugar (outro projeto, a conta), que não é nosso para regravar.
      if (source.linked) {
        out.kept.push(`${legacy.name} (é um link: não atualizado)`);
        continue;
      }
      await saveAgent(
        dir,
        AgentInput.parse({
          originalName: legacy.name,
          name: current.name,
          description: current.description,
          model: current.model,
          effort: current.effort,
          tools: current.tools.split(',').map((t) => t.trim()).filter(Boolean),
          prompt: current.prompt,
        }),
        backupDir,
      );
      out.updated.push(legacy.name);
      continue;
    }
    // Já está no pronto novo (migrado antes ou criado depois da mudança): nada a dizer.
    if (!(await differences(source, current)).length) continue;
    out.kept.push(`${legacy.name} (personalizado: difere do pronto antigo em ${fromLegacy.join(', ')})`);
  }
  return out;
}

/**
 * Roda `migrateAgentPresets` em cada projeto que ainda não está no registro (`recordFile`: `{ <id do projeto>: PresetMigration }`) e
 * devolve só o que migrou agora. Projeto que deu erro não entra no registro: tenta de novo no próximo boot.
 */
export async function migrateProjectAgents(o: {
  projects: Array<{ id: string; path: string }>;
  recordFile: string;
  backupDir: string;
}): Promise<Record<string, PresetMigration>> {
  let record: Record<string, PresetMigration> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(o.recordFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) record = parsed as Record<string, PresetMigration>;
  } catch {
    // sem registro (ou ilegível): começa vazio
  }
  const done: Record<string, PresetMigration> = {};
  for (const p of o.projects) {
    if (Object.hasOwn(record, p.id)) continue;
    try {
      done[p.id] = await migrateAgentPresets(path.join(p.path, '.claude', 'agents'), path.join(o.backupDir, p.id));
    } catch (err) {
      console.warn(`[agents] ${p.id}: migração dos prontos não concluída:`, err);
    }
  }
  if (Object.keys(done).length) {
    await fs.mkdir(path.dirname(o.recordFile), { recursive: true });
    await writeAtomic(o.recordFile, JSON.stringify({ ...record, ...done }, null, 2) + '\n');
  }
  return done;
}
