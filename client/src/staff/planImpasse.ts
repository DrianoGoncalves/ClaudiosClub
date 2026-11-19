import { AGENT_PRESETS, PLAYBOOK_AGENTS } from '../../../shared/agentPresets';
import type { Autonomy, Engine, McpServerInfo, Playbook } from '../../../shared/model';
import { accessOf, browserAccess, type McpAccessMap } from './mcpAccessField';

// Impasse "Só planeja" × o que a ficha marca: em plan o agent herda o modo e não grava (no Codex roda na mesma sandbox, só leitura), então um agent que edita só
// gasta consumo; e o MCP (o navegador incluso) em "Livre" não tem trava de escrita: em plan quem segura é o próprio modelo. A ficha só avisa, não impede salvar.

/** Ferramentas que gravam em arquivo ou rodam comando (aceita a forma com regra, `Bash(git:*)`). */
const WRITING_TOOL = /^(Edit|MultiEdit|Write|NotebookEdit|Bash|PowerShell)(\(|$)/;

/** O agent edita: alguma ferramenta dele grava ou roda comando. Sem lista de ferramentas (`null`) ele herda todas as de quem chama, então também edita. */
export const toolsEdit = (tools: readonly string[] | null | undefined): boolean => !tools || tools.some((tool) => WRITING_TOOL.test(tool.trim()));

export interface PlanImpasseCtx {
  autonomy: Autonomy;
  engine: Engine;
  /** Agents marcados na lista da ficha (só o Claude tem a lista; no Codex a ficha sai sem eles). */
  agents: readonly string[];
  /** Os agents do projeto e da conta, com as ferramentas de cada um. Mesmo nome nos dois: vale o do projeto (como no Claude Code); sem `scope`, vale o primeiro. */
  agentFiles: ReadonlyArray<{ name: string; tools: string[] | null; scope?: 'user' | 'project' }>;
  playbook: '' | Playbook;
  /** Os MCPs que a ficha oferece e os marcados (só o Claude: o Codex não usa a lista). */
  mcps: readonly McpServerInfo[] | null;
  mcpOn: ReadonlySet<string>;
  /** O acesso por MCP; o do navegador vem das chaves dele (ver `browserAccess`). */
  mcpAccess: McpAccessMap;
  /** O navegador está marcado na ficha. */
  browser: boolean;
  /** "Permitir que o GPT use meu Chrome" nas Configurações: sem ele o Codex não sobe o navegador. */
  codexBrowser: boolean;
}

export interface PlanImpasse {
  /** Os agents que editam e a ficha em plan marca (na lista ou pelo roteiro). */
  agents: string[];
  /** Os de `agents` que o roteiro chama: desmarcar na lista não os tira do aviso (o roteiro segue chamando, mesmo o que o projeto nem tem), só trocar o roteiro. */
  playbookAgents: string[];
  /** Os MCPs marcados em "Livre" que podem escrever. */
  mcps: string[];
  /** O navegador está ligado e em "Livre". */
  browser: boolean;
}

/**
 * O que a ficha marca e não combina com "Só planeja"; null = nada a avisar (outra autonomia, ou nada que edite). O roteiro conta nos dois motores (os agents dele
 * são criados ao abrir a conversa e, no Codex, vão como subagents), a lista de agents e a de MCPs só no Claude. O agent sem arquivo ainda (o pronto que o roteiro
 * cria) vale pelas ferramentas do pronto. MCP testado sem nenhuma ferramenta de escrita não tem o que travar; o não testado entra (não se sabe). O navegador
 * tem o mesmo seletor dos MCPs e vem ligado e Livre por padrão: entra quando está marcado e Livre (no Codex, só com o Chrome do GPT ligado nas Configurações).
 */
export function planImpasse(ctx: PlanImpasseCtx): PlanImpasse | null {
  if (ctx.autonomy !== 'plan') return null;
  const claude = ctx.engine !== 'codex';
  // O projeto antes da conta: o primeiro de cada nome é o que vale.
  const files = new Map<string, string[] | null>();
  for (const a of [...ctx.agentFiles].sort((x, y) => Number(y.scope === 'project') - Number(x.scope === 'project'))) if (!files.has(a.name)) files.set(a.name, a.tools);
  const presets = new Map(AGENT_PRESETS.map((p) => [p.name, p.tools.split(',').map((tool) => tool.trim())]));
  const edits = (name: string): boolean => (files.has(name) ? toolsEdit(files.get(name)) : presets.has(name) && toolsEdit(presets.get(name)));
  const called = ctx.playbook ? PLAYBOOK_AGENTS[ctx.playbook] : [];
  const named = [...(claude ? ctx.agents : []), ...called];
  const agents = [...new Set(named)].filter(edits);
  const playbookAgents = agents.filter((name) => called.includes(name));
  const mcps = claude ? (ctx.mcps ?? []).filter((m) => ctx.mcpOn.has(m.name) && accessOf(ctx.mcpAccess, m.name) === 'free' && m.tools?.write !== 0).map((m) => m.name) : [];
  const browser = ctx.browser && (claude || ctx.codexBrowser) && browserAccess(ctx.mcpAccess) === 'free';
  return agents.length || mcps.length || browser ? { agents, playbookAgents, mcps, browser } : null;
}
