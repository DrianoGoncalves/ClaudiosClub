import type { McpAccess, McpServerInfo } from '../../../shared/model';
import type { MsgKey } from '../i18n';

// Acesso por MCP na ficha (`StaffProfile.mcpAccess`, ver server/staff/mcpAccess.ts): um seletor só por MCP, nos dois motores.

/** Nome do MCP na ficha → acesso. Sem a chave = `free`. */
export type McpAccessMap = Record<string, McpAccess>;

/** Do mais solto ao mais fechado, e o texto de cada um no seletor. */
export const MCP_ACCESS_LEVELS = ['free', 'ask', 'readonly', 'off'] as const satisfies readonly McpAccess[];
export const MCP_ACCESS_LABEL = {
  free: 'staff.mcpAccessFree',
  ask: 'staff.mcpAccessAsk',
  readonly: 'staff.mcpAccessReadonly',
  off: 'staff.mcpAccessOff',
} as const satisfies Record<McpAccess, MsgKey>;

const RANK: Record<McpAccess, number> = { free: 0, ask: 1, readonly: 2, off: 3 };

/** O Claude in Chrome e o `myco-chrome` (Codex) são o mesmo navegador: a ficha tem um seletor só, e vale o mais restritivo dos dois. */
export const BROWSER_KEYS = ['claude-in-chrome', 'myco-chrome'] as const;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** O servidor só aceita nome de 1 a 100 caracteres e que não seja nome reservado de objeto; os outros ficam sem seletor. */
export const hasAccessKey = (name: string): boolean => name.length >= 1 && name.length <= 100 && !RESERVED.has(name);

/** Sem regra = Livre. */
export const accessOf = (map: McpAccessMap, name: string): McpAccess => map[name] ?? 'free';

/** Troca o acesso de um MCP. Livre tira a chave: o servidor não grava `free`. */
export function withAccess(map: McpAccessMap, name: string, level: McpAccess): McpAccessMap {
  const { [name]: _old, ...rest } = map;
  return level === 'free' ? rest : { ...rest, [name]: level };
}

/** O acesso do navegador na ficha: o mais restritivo das duas chaves dele. */
export const browserAccess = (map: McpAccessMap): McpAccess => BROWSER_KEYS.reduce<McpAccess>((a, k) => (RANK[accessOf(map, k)] > RANK[a] ? accessOf(map, k) : a), 'free');

/** Troca o acesso do navegador: as duas chaves recebem o mesmo nível (as duas, para o seletor não esconder uma mais fechada). */
export const withBrowserAccess = (map: McpAccessMap, level: McpAccess): McpAccessMap => BROWSER_KEYS.reduce((m, k) => withAccess(m, k, level), map);

const clean = (m: McpAccessMap): McpAccessMap => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 'free'));
const canon = (m: McpAccessMap) => JSON.stringify(Object.entries(clean(m)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * O que o pedido leva: só quando difere do salvo (ausente mantém; `{}` limpa). O mapa inteiro, inclusive as chaves que a tela não mostra
 * (MCP desmarcado, `myco-ssh`): o servidor troca o mapa todo, então omitir uma chave a apagaria.
 */
export function accessToSend(map: McpAccessMap, saved: McpAccessMap | undefined): { mcpAccess?: McpAccessMap } {
  return canon(map) === canon(saved ?? {}) ? {} : { mcpAccess: clean(map) };
}

/** Uma linha de dica: a chave do texto e o que entra nela. */
export interface AccessHint {
  key: MsgKey;
  params?: Record<string, number>;
}

/** "Pede antes" vira "Só leitura" no GPT e no modo sem travas (não há quem confirme). */
const ASK_NOTE: AccessHint = { key: 'staff.mcpAccessAskNote' };

/**
 * A dica de um MCP, só quando o acesso limita a escrita (Pede antes ou Só leitura): quantas ferramentas contam como escrita, ou o que
 * acontece sem teste (nenhuma é conhecida como leitura). Livre e Desligado não precisam de dica.
 */
export function mcpAccessHints(level: McpAccess, info: Pick<McpServerInfo, 'tools'>): AccessHint[] {
  if (level !== 'ask' && level !== 'readonly') return [];
  const count: AccessHint = info.tools
    ? { key: 'staff.mcpAccessCount', params: { write: info.tools.write, total: info.tools.total } }
    : { key: level === 'ask' ? 'staff.mcpAccessUntestedAsk' : 'staff.mcpAccessUntestedReadonly' };
  return level === 'ask' ? [count, ASK_NOTE] : [count];
}

/** A dica do navegador: ele não tem teste, então nenhuma ação conta como leitura. */
export function browserAccessHints(level: McpAccess): AccessHint[] {
  if (level === 'ask') return [{ key: 'staff.browserAccessAsk' }, ASK_NOTE];
  if (level === 'readonly') return [{ key: 'staff.browserAccessReadonly' }];
  return [];
}
