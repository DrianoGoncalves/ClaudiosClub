import { AGENT_PRESETS, PLAYBOOK_AGENTS, type AgentPreset } from '../../../shared/agentPresets';
import type { Playbook } from '../../../shared/model';
import { t } from '../i18n';
import { effortLabel } from '../format';

// O que cada agent pronto faz (pensador × executor): o funcionário pensa e confere, os agents fazem o braçal.
// Os prontos e o roteiro de cada um vêm de shared/agentPresets.ts; aqui só o texto e a comparação com o arquivo do projeto.

const ROLE = {
  executor: { text: 'staff.roleExecutor', tag: 'staff.roleTagExecutor' },
  'executor-rapido': { text: 'staff.roleExecutorFast', tag: 'staff.roleTagExecutorFast' },
  pesquisador: { text: 'staff.roleResearcher', tag: 'staff.roleTagResearcher' },
  revisor: { text: 'staff.roleReviewer', tag: 'staff.roleTagReviewer' },
} as const;

type RoleName = keyof typeof ROLE;
const hasRole = (name: string): name is RoleName => Object.hasOwn(ROLE, name);

export const presetOf = (name: string): AgentPreset | undefined => AGENT_PRESETS.find((p) => p.name === name);

/** A frase do papel do agent pronto (ex.: o executor implementa); null para um agent que não é pronto. */
export const roleText = (name: string): string | null => (hasRole(name) ? t(ROLE[name].text) : null);

/** A etiqueta curta do papel ("implementa", "mecânico"…); null para um agent que não é pronto. */
export const roleTag = (name: string): string | null => (hasRole(name) ? t(ROLE[name].tag) : null);

const MODEL_NAMES: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

/** "Sonnet · Medium": modelo e esforço de um agent; sem modelo (ou inherit) vale o de quem chama. */
export function agentBrief(model: string | null | undefined, effort: string | null | undefined): string {
  const name = model && model !== 'inherit' ? (MODEL_NAMES[model] ?? model) : t('staff.callerModel');
  return effort ? `${name} · ${effortLabel(effort)}` : name;
}

export interface PresetDrift {
  preset: AgentPreset;
  /** O modelo do arquivo é outro que o do pronto. */
  model: boolean;
  /** O esforço do arquivo é outro que o do pronto (sem esforço no arquivo também conta). */
  effort: boolean;
}

/**
 * Agent com o nome de um pronto, mas modelo ou esforço diferentes do pronto atual (o executor que ficou no Haiku antigo, por
 * exemplo): o arquivo é de quem o editou e o Claudio’s Club não o troca sozinho. `model` aceita 'inherit' e `effort` '' como "sem valor".
 */
export function presetDrift(name: string, model: string | null | undefined, effort: string | null | undefined): PresetDrift | null {
  const preset = presetOf(name);
  if (!preset) return null;
  const drift = { preset, model: (model && model !== 'inherit' ? model : null) !== preset.model, effort: (effort || null) !== preset.effort };
  return drift.model || drift.effort ? drift : null;
}

export interface RosterRow {
  name: string;
  /** A frase do papel; vazia para um agent que não é pronto. */
  role: string;
  /** Modelo e esforço ("Sonnet · Medium") ou, no Codex, o modelo da conversa e o esforço. */
  brief: string;
  /** Ainda não está no projeto: o Claudio’s Club cria o pronto quando a conversa abre. */
  created: boolean;
}

/**
 * Quem o roteiro chama, com o papel e o modelo de cada um. O que já está no projeto (ou na conta) mostra o arquivo de verdade; o que falta
 * mostra o pronto que será criado. No Codex o modelo do agent não vale: o subagent usa o da conversa, e só o esforço vem do agent.
 */
export function rosterRows(
  playbook: Playbook,
  known: ReadonlyMap<string, { model: string | null; effort: string | null }>,
  codex: boolean,
): RosterRow[] {
  return PLAYBOOK_AGENTS[playbook].map((name) => {
    const have = known.get(name);
    const base = have ?? presetOf(name) ?? { model: null, effort: null };
    const brief = codex
      ? [t('staff.rosterInherit'), base.effort ? t('staff.rosterEffort', { effort: effortLabel(base.effort) }) : null].filter(Boolean).join(' · ')
      : agentBrief(base.model, base.effort);
    return { name, role: roleText(name) ?? '', brief, created: !have };
  });
}
