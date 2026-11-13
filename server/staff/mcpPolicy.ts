// Política de MCP por ferramenta da ficha (`mcpPolicy`, ver shared/model.ts). Funções puras: o Claude recebe as regras
// (--disallowedTools e permissions.ask do settings); o Codex, o `disabled_tools` e o MCP que não entra.

import type { McpPolicy } from '../../shared/model';

/** Quanto maior, mais fechado. Entre servidor e ferramenta, e entre gestor e subfuncionário, vale o maior. */
const RANK: Record<McpPolicy, number> = { allow: 0, ask: 1, off: 2 };

/** A chave da extensão Claude in Chrome: vale também para o `myco-chrome` do Codex (é o mesmo Chrome do usuário). */
export const CHROME_EXTENSION_KEY = 'mcp__claude-in-chrome';

/** Chave do servidor de uma chave de política: `mcp__srv` fica igual; `mcp__srv__ferramenta` vira `mcp__srv`. */
export function mcpServerKey(key: string): string {
  const i = key.indexOf('__', 5);
  return i === -1 ? key : key.slice(0, i);
}

/**
 * O que a política manda ao Claude. `deny` vai para --disallowedTools (a ferramenta sai da sessão, mesmo com permissão local);
 * `ask` vai para permissions.ask do settings (pergunta sempre). `allow` não gera nada: não libera além da autonomia.
 * O `ask` de uma ferramenta some se o servidor dela está `off`, porque o deny do servidor já a cobre.
 */
export function mcpPolicyRules(policy?: Record<string, McpPolicy>): { deny: string[]; ask: string[] } {
  const deny = new Set<string>();
  const ask = new Set<string>();
  for (const [key, level] of Object.entries(policy ?? {})) {
    if (level === 'off') deny.add(key);
    else if (level === 'ask' && policy?.[mcpServerKey(key)] !== 'off') ask.add(key);
  }
  return { deny: [...deny].sort(), ask: [...ask].sort() };
}

/**
 * A política do subfuncionário nunca fica mais solta que a de quem o contratou: em cada chave, vale a mais restritiva, e a chave
 * que só o gestor tem entra. Sem nenhuma das duas, undefined (a ficha fica sem política).
 */
export function capMcpPolicy(requested?: Record<string, McpPolicy>, hirer?: Record<string, McpPolicy>): Record<string, McpPolicy> | undefined {
  if (!requested && !hirer) return undefined;
  const out: Record<string, McpPolicy> = {};
  for (const key of new Set([...Object.keys(requested ?? {}), ...Object.keys(hirer ?? {})])) {
    const levels = [requested?.[key], hirer?.[key]].filter((v): v is McpPolicy => v !== undefined);
    out[key] = levels.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
  }
  return out;
}

/** O que a política faz com um MCP do Codex (`myco-ssh`, `myco-chrome`). `askedAsOff`: as chaves `ask` que viraram `off`, para a ficha. */
export interface CodexMcpPolicy {
  /** O servidor fica fora da conversa (`off`, ou `ask`, que no Codex vira `off`). */
  disabled: boolean;
  /** Ferramentas que saem, pelo nome curto (sem `mcp__servidor__`): vai para `disabled_tools`. */
  disabledTools: string[];
  askedAsOff: string[];
}

/**
 * Traduz a política para um MCP do Codex. `aliases`: chaves de servidor de outro nome que valem para este MCP (só no nível do
 * servidor: as ferramentas da extensão do Claude não têm o mesmo nome que as do `myco-chrome`).
 */
export function codexMcpPolicy(policy: Record<string, McpPolicy> | undefined, serverName: string, aliases: string[] = []): CodexMcpPolicy {
  const prefix = `mcp__${serverName}__`;
  let disabled = false;
  const askedAsOff: string[] = [];
  for (const key of [`mcp__${serverName}`, ...aliases]) {
    const level = policy?.[key];
    if (level === 'off' || level === 'ask') disabled = true;
    if (level === 'ask') askedAsOff.push(key);
  }
  const disabledTools = new Set<string>();
  for (const [key, level] of Object.entries(policy ?? {})) {
    if (!key.startsWith(prefix)) continue;
    if (level === 'off' || level === 'ask') disabledTools.add(key.slice(prefix.length));
    if (level === 'ask') askedAsOff.push(key);
  }
  return { disabled, disabledTools: [...disabledTools].sort(), askedAsOff: askedAsOff.sort() };
}
