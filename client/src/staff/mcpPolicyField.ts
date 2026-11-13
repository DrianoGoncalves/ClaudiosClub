import type { McpPolicy } from '../../../shared/model';
import type { MsgKey } from '../i18n';

/** Política por ferramenta MCP da ficha (`StaffProfile.mcpPolicy`): chave `mcp__servidor` ou `mcp__servidor__ferramenta`. */
export type McpPolicyMap = Record<string, McpPolicy>;

/** Os três níveis, do mais solto ao mais fechado, e o texto de cada um no seletor. */
export const MCP_LEVELS = ['allow', 'ask', 'off'] as const satisfies readonly McpPolicy[];
export const MCP_LEVEL_LABEL = {
  allow: 'staff.mcpLevelAllow',
  ask: 'staff.mcpLevelAsk',
  off: 'staff.mcpLevelOff',
} as const satisfies Record<McpPolicy, MsgKey>;

/**
 * Chave do servidor na política, ou null se o nome não cabe nela. O servidor só aceita letras, números, "-" e "_" (a chave vai
 * para a linha de comando) e usa "__" para separar a ferramenta: nome com "__", ou começando/terminando em "_", embaralharia a chave.
 */
export function serverPolicyKey(name: string): string | null {
  return name.length <= 100 && /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(name) && !name.includes('__') ? `mcp__${name}` : null;
}

/** Nível de uma chave; sem regra = Permitir (que não libera nada além da autonomia, então é o mesmo que não ter regra). */
export const levelOf = (policy: McpPolicyMap, key: string): McpPolicy => policy[key] ?? 'allow';

/** Troca o nível de uma chave. Permitir tira a chave: não há o que guardar. */
export function withLevel(policy: McpPolicyMap, key: string, level: McpPolicy): McpPolicyMap {
  const { [key]: _old, ...rest } = policy;
  return level === 'allow' ? rest : { ...rest, [key]: level };
}

/** As chaves por ferramenta (`mcp__servidor__ferramenta`) de um servidor, em ordem. */
export const toolKeysOf = (keys: readonly string[], serverKey: string): string[] =>
  keys.filter((k) => k.startsWith(`${serverKey}__`) && k.length > serverKey.length + 2).sort();

/** O nome curto da ferramenta numa chave dela. */
export const toolNameOf = (key: string, serverKey: string): string => key.slice(serverKey.length + 2);

const canon = (p: McpPolicyMap) => JSON.stringify(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** O que o pedido leva: só quando difere do salvo (ausente mantém; `{}` limpa). Sem ficha salva, sem política = não manda nada. */
export function mcpPolicyToSend(policy: McpPolicyMap, saved: McpPolicyMap | undefined): { mcpPolicy?: McpPolicyMap } {
  return canon(policy) === canon(saved ?? {}) ? {} : { mcpPolicy: policy };
}
