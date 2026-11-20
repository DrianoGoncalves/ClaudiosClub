// MCPs da ficha com escopo, como as skills (skillRefs.ts) e como o servidor grava (server/mcpAccessRefs.ts): `global:<nome>` (~/.claude.json, vale
// também no Claude Code fora do Club) e `project:<nome>` (.mcp.json e o escopo local do projeto). `mcps: null` na ficha continua sendo "todos".

import type { McpServerInfo } from '../../../shared/model';
import type { MsgKey } from '../i18n';

export type McpScopeName = 'global' | 'project';

export const MCP_SCOPE_LABEL = { global: 'staff.mcpScopeGlobal', project: 'staff.mcpScopeProject' } as const satisfies Record<McpScopeName, MsgKey>;

/** Já tem escopo (ref). */
export const isMcpRef = (s: string): boolean => s.startsWith('global:') || s.startsWith('project:');

/** O escopo e o nome de uma ref; `null` para o nome antigo, sem escopo. */
export function parseMcpRef(raw: string): { scope: McpScopeName; name: string } | null {
  if (!isMcpRef(raw)) return null;
  const i = raw.indexOf(':');
  return { scope: raw.slice(0, i) as McpScopeName, name: raw.slice(i + 1) };
}

/** O nome sem o escopo (o nome antigo já é só o nome). */
export const mcpName = (raw: string): string => parseMcpRef(raw)?.name ?? raw;

/** Nome antigo: Projeto se existe lá; senão Global. Igual ao servidor (resolveLegacyMcp). */
export function normalizeMcps(mcps: readonly string[], list: readonly Pick<McpServerInfo, 'ref' | 'scope' | 'name'>[]): string[] {
  const out: string[] = [];
  for (const m of mcps) {
    const ref = isMcpRef(m) ? m : list.some((s) => s.scope === 'project' && s.name === m) ? `project:${m}` : `global:${m}`;
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** Marcar um MCP desmarca o de mesmo nome no outro escopo: só um deles sobe na conversa (o Projeto), então a ficha não guarda os dois. */
export function toggleMcp(on: ReadonlySet<string>, ref: string): Set<string> {
  const next = new Set(on);
  if (next.delete(ref)) return next;
  const name = mcpName(ref);
  for (const r of on) if (mcpName(r) === name) next.delete(r);
  next.add(ref);
  return next;
}

/** O que a ficha guarda: `null` = todos (nada fica de fora); senão as refs marcadas. */
export const mcpsToSave = (list: readonly Pick<McpServerInfo, 'ref'>[], on: ReadonlySet<string>): string[] | null =>
  list.length > 0 && list.every((m) => on.has(m.ref)) ? null : [...on];
