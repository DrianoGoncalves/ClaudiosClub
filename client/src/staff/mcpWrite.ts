import type { McpServerInfo, McpWritePolicy } from '../../../shared/model';
import type { MsgKey } from '../i18n';

// Escrita por MCP na ficha (ver server/staff/mcpTools.ts): livre (ausente), pede antes ou bloqueada.

export type McpWriteChoice = 'free' | McpWritePolicy;

export const MCP_WRITE_OPTIONS: Array<{ value: McpWriteChoice; label: MsgKey }> = [
  { value: 'free', label: 'staff.mcpWriteFree' },
  { value: 'ask', label: 'staff.mcpWriteAsk' },
  { value: 'deny', label: 'staff.mcpWriteDeny' },
];

/** A linha embaixo do seletor: quantas ferramentas contam como escrita, ou que sem teste a regra vale para todas. */
export function mcpWriteHint(info: Pick<McpServerInfo, 'tools'>): { key: MsgKey; params?: Record<string, number> } {
  if (!info.tools) return { key: 'staff.mcpWriteUntested' };
  return { key: 'staff.mcpWriteCount', params: { write: info.tools.write, total: info.tools.total } };
}

/** Troca a escolha de um MCP; `free` tira do mapa. */
export function setMcpWrite(policy: Record<string, McpWritePolicy>, name: string, choice: McpWriteChoice): Record<string, McpWritePolicy> {
  const next = { ...policy };
  if (choice === 'free') delete next[name];
  else next[name] = choice;
  return next;
}

/**
 * O que vai no pedido: só os MCPs ligados na ficha (`on` null = todos). Mapa vazio vai como `{}` (limpa a política salva).
 * Quem não mostra a lista (Codex, contratação simples, lista que não carregou) não manda o campo: fica o que a ficha tinha.
 */
export function mcpWriteToSend(policy: Record<string, McpWritePolicy>, on: ReadonlySet<string> | null): Record<string, McpWritePolicy> {
  return Object.fromEntries(Object.entries(policy).filter(([name]) => on === null || on.has(name)));
}
