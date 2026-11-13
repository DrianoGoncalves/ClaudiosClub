// Acesso por MCP da ficha (`mcpAccess`, ver shared/model.ts). Funções puras, sem I/O. Um só campo vale para os dois motores:
//   Claude: `off` sai da sessão (--disallowedTools); `readonly` e `ask` vão ao arquivo do hook (mcp-write.json, lido por
//           scripts/hooks/mcp-write-guard.mjs): só passam as ferramentas de leitura do último teste (readOnlyHint); o resto é
//           bloqueado (`readonly`) ou pede antes (`ask`, em bypass vira bloqueio).
//   Codex:  `off` não entra; `readonly` e `ask` entram só com as ferramentas de leitura (`enabled_tools`), porque o Codex não pergunta.
// Ordem de restrição: free < ask < readonly < off. Entre fontes (ficha, gestor, tela antiga), vale a mais restrita, sempre.

import { claudeName, type McpTool } from './mcpTools';
import type { McpAccess } from '../../shared/model';

export type McpAccessMap = Record<string, McpAccess>;
/** Uma entrada do arquivo do hook: o nível (sem `free`) e as ferramentas de leitura do último teste (nome como o MCP declara). */
export interface McpAccessEntry {
  policy: Exclude<McpAccess, 'free'>;
  readOnly: string[];
}
export type McpAccessFile = Record<string, McpAccessEntry>;

/** Quanto maior, mais fechado. */
const RANK: Record<McpAccess, number> = { free: 0, ask: 1, readonly: 2, off: 3 };

/**
 * A extensão do Claude in Chrome e o `myco-chrome` do Codex são o mesmo Chrome do usuário: na aplicação (não na gravação), o nível
 * efetivo do Chrome é o mais restritivo dos dois, nos dois motores.
 */
export const CHROME_KEYS = ['claude-in-chrome', 'myco-chrome'] as const;

const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** Nome de MCP na ficha: 1 a 100 caracteres e não é nome reservado de objeto. Checado na entrada crua (ver store.ts). */
export const validMcpName = (k: string): boolean => k.length >= 1 && k.length <= 100 && !RESERVED.has(k);
const isLevel = (v: unknown): v is McpAccess => v === 'off' || v === 'readonly' || v === 'ask' || v === 'free';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** O mais restrito dos dois níveis (ausente = free). */
export function stricterAccess(a: McpAccess | undefined, b: McpAccess | undefined): McpAccess {
  const x = a ?? 'free';
  const y = b ?? 'free';
  return RANK[y] > RANK[x] ? y : x;
}

/** Sem `free` (mapa vazio = campo ausente). É o que a gravação leva. */
export function cleanMcpAccess(m: McpAccessMap | undefined): McpAccessMap | undefined {
  const entries = Object.entries(m ?? {}).filter(([, v]) => v !== 'free');
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Junta mapas pela mais restrita; as chaves dos dois entram. Serve ao subfuncionário (o pedido não afrouxa o gestor) e ao PATCH
 * da tela antiga (ela só aperta). `Object.fromEntries` põe a chave como propriedade própria (sem mexer no protótipo).
 */
export function mergeMcpAccess(...maps: Array<McpAccessMap | undefined>): McpAccessMap | undefined {
  const out = new Map<string, McpAccess>();
  for (const m of maps) for (const [k, v] of Object.entries(m ?? {})) out.set(k, stricterAccess(out.get(k), v));
  return cleanMcpAccess(Object.fromEntries(out));
}

/** Chave do servidor de uma chave de política legada: `mcp__srv` fica igual; `mcp__srv__ferramenta` vira `mcp__srv`. */
export function mcpServerKey(key: string): string {
  const i = key.indexOf('__', 5);
  return i === -1 ? key : key.slice(0, i);
}

/**
 * Lê o acesso como está no arquivo (ou no pedido da tela antiga) e devolve o `mcpAccess`. Fail-closed por entrada: valor inválido
 * vira `off`; chave que não é nome de MCP sai (não há a qual MCP aplicar). As três fontes se juntam pela mais restrita:
 *   mcpAccess: o valor vale (inválido vira off);
 *   mcpPolicy (legado, `mcp__srv`): allow → free, ask → ask, off → off, o resto → off;
 *   mcpPolicy (legado, `mcp__srv__ferramenta`): só `ask` (→ srv no mínimo ask) e o resto (→ srv off). Não dá para desligar uma ferramenta
 *     só no modelo novo, então o servidor inteiro sai (fail-closed); `allow` não faz nada;
 *   mcpWrite (legado): deny → readonly; o resto → ask.
 */
export function readMcpAccess(raw: { mcpAccess?: unknown; mcpPolicy?: unknown; mcpWrite?: unknown }): McpAccessMap | undefined {
  const out = new Map<string, McpAccess>();
  const put = (name: string, level: McpAccess) => {
    if (validMcpName(name)) out.set(name, stricterAccess(out.get(name), level));
  };
  if (isRecord(raw.mcpAccess)) for (const [name, v] of Object.entries(raw.mcpAccess)) put(name, isLevel(v) ? v : 'off');
  if (isRecord(raw.mcpPolicy)) {
    for (const [key, v] of Object.entries(raw.mcpPolicy)) {
      if (!key.startsWith('mcp__')) continue;
      const server = mcpServerKey(key);
      const name = server.slice('mcp__'.length);
      if (server === key) {
        if (v === 'ask') put(name, 'ask');
        else if (v !== 'allow') put(name, 'off');
      } else {
        if (v !== 'allow') put(name, v === 'ask' ? 'ask' : 'off');
      }
    }
  }
  if (isRecord(raw.mcpWrite)) for (const [name, v] of Object.entries(raw.mcpWrite)) put(name, v === 'deny' ? 'readonly' : 'ask');
  return cleanMcpAccess(Object.fromEntries(out));
}

/**
 * O `mcpAccess` que a gravação leva, a partir do pedido. Com `mcpAccess` no pedido, ele vale (os legados saem). Sem ele, os legados
 * (tela antiga) se juntam pela mais restrita com `current` (a ficha que já existe, no PATCH; no create, undefined). Sem nada no pedido,
 * fica `current`.
 */
export function mcpAccessOfInput(
  input: { mcpAccess?: unknown; mcpPolicy?: unknown; mcpWrite?: unknown },
  current?: McpAccessMap,
): McpAccessMap | undefined {
  if (input.mcpAccess !== undefined) return cleanMcpAccess(input.mcpAccess as McpAccessMap);
  return mergeMcpAccess(current, readMcpAccess({ mcpPolicy: input.mcpPolicy, mcpWrite: input.mcpWrite }));
}

/** O nível efetivo do Chrome: o mais restrito das duas chaves dele. */
export function chromeLevel(access: McpAccessMap | undefined): McpAccess {
  return CHROME_KEYS.reduce<McpAccess>((a, k) => stricterAccess(a, access?.[k]), 'free');
}

/** O acesso com o alias do Chrome aplicado: se alguma das chaves não é free, as duas recebem o nível efetivo. */
export function withChromeAlias(access: McpAccessMap | undefined): McpAccessMap {
  const out = new Map<string, McpAccess>(Object.entries(access ?? {}));
  const level = chromeLevel(access);
  if (level !== 'free') for (const k of CHROME_KEYS) out.set(k, level);
  return Object.fromEntries(out);
}

/**
 * O que o Claude recebe pelo --disallowedTools: os MCPs `off` com nome seguro (letras, números, `_` e `-`) viram `mcp__<nome>` e saem
 * da sessão. Nome fora disso fica só no hook (que nega tudo do servidor).
 */
export function mcpOffDenyRules(access: McpAccessMap | undefined): string[] {
  return Object.entries(withChromeAlias(access))
    .filter(([name, level]) => level === 'off' && /^[A-Za-z0-9_-]{1,100}$/.test(name))
    .map(([name]) => `mcp__${name}`)
    .sort();
}

/**
 * O arquivo que o hook lê (`mcp-write.json`): por MCP com nível (sem `free`), o nível com o alias do Chrome e as ferramentas de leitura do
 * último teste. `off` não precisa de lista. Sem teste (fora de `tools`), a lista fica vazia e vale para o servidor inteiro. Ferramenta de
 * leitura cujo nome, normalizado como o Claude Code faz, é igual ao de outra do mesmo MCP sai da lista: o hook não separa as duas, e a de
 * escrita passaria como se fosse de leitura.
 */
export function mcpAccessFile(access: McpAccessMap | undefined, tools: Map<string, McpTool[]>): McpAccessFile {
  const out: McpAccessFile = {};
  for (const [name, level] of Object.entries(withChromeAlias(access))) {
    if (level === 'free') continue;
    const all = tools.get(name) ?? [];
    const readOnly =
      level === 'off'
        ? []
        : all.filter((t) => t.readOnly && all.filter((u) => claudeName(u.name) === claudeName(t.name)).length === 1).map((t) => t.name);
    out[name] = { policy: level, readOnly };
  }
  return out;
}

/** O que o motor do Codex faz com um MCP: se entra, quais ferramentas a conversa vê, e se um `ask` virou só leitura (a ficha avisa). */
export interface CodexMcpAccess {
  attached: boolean;
  /** Ferramentas que a conversa vê (`enabled_tools`). Ausente = todas as do MCP (sem regra). */
  enabledTools?: string[];
  askAsReadonly: boolean;
}

/**
 * Traduz o acesso para um MCP do Codex. `aliases`: chaves de outro nome que valem para este MCP (o Chrome). `readOnly`: ferramentas de
 * leitura conhecidas (null = sem lista). `readonly` e `ask` entram só com a lista: sem ela, o servidor inteiro fica de fora, como no Claude
 * sem teste. O Codex não pergunta, então `ask` vira só leitura.
 */
export function codexMcpAccess(
  access: McpAccessMap | undefined,
  serverName: string,
  aliases: string[],
  readOnly: string[] | null,
): CodexMcpAccess {
  const level = [serverName, ...aliases].reduce<McpAccess>((a, k) => stricterAccess(a, access?.[k]), 'free');
  if (level === 'off') return { attached: false, askAsReadonly: false };
  if (level === 'free') return { attached: true, askAsReadonly: false };
  if (!readOnly?.length) return { attached: false, askAsReadonly: false };
  return { attached: true, enabledTools: [...readOnly], askAsReadonly: level === 'ask' };
}
