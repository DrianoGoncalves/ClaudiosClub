// MCPs da ficha com escopo, como as skills (ver skillAccess.ts). `global:<nome>` é a Global (`mcpServers` do ~/.claude.json: a que o Claude Code
// do usuário também vê) e `project:<nome>` é a do projeto (`.mcp.json` e o escopo local do projeto, que não vai para o git). `mcps: null`
// na ficha continua sendo "todos". Nome antigo, sem prefixo, é convertido ao salvar, ao abrir a conversa e no boot (ver resolveLegacyMcp).
// Funções puras, sem I/O: quem chama lê os arquivos.

export type McpScopeName = 'global' | 'project';

export interface McpRef {
  scope: McpScopeName;
  name: string;
}

/** Os nomes que existem agora, para converter nome antigo (ver resolveLegacyMcp). */
export interface KnownMcpNames {
  globalNames: string[];
  projectNames: string[];
}

/** O mesmo critério de nome da biblioteca (NAME em mcpLibrary.ts) e do lançador (NAME em mcpLaunch.ts). */
export const MCP_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

export const formatMcpRef = (scope: McpScopeName, name: string): string => `${scope}:${name}`;

/** A ref `global:<nome>` ou `project:<nome>`; `null` se não tem escopo ou o nome não é válido. */
export function parseMcpRef(raw: string): McpRef | null {
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const scope = raw.slice(0, i);
  const name = raw.slice(i + 1);
  if ((scope !== 'global' && scope !== 'project') || !MCP_NAME.test(name) || RESERVED.has(name)) return null;
  return { scope, name };
}

/** Já tem escopo (ref), mesmo que o nome seja inválido: a ref não é convertida de novo. Nome de MCP não tem `:`, então não há ambiguidade. */
export const isMcpRef = (s: string): boolean => s.startsWith('global:') || s.startsWith('project:');

/**
 * Nome antigo (sem prefixo): Projeto se existe lá (`.mcp.json` ou escopo local); senão Global (a ficha avisa se nem lá existe). É o inverso das
 * skills de propósito: até aqui o nome valia pelo mais específico (local > projeto > Club > usuário), e a conversão não pode trocar o que a
 * ficha carregava.
 */
export function resolveLegacyMcp(name: string, known: KnownMcpNames): string {
  if (known.projectNames.includes(name)) return formatMcpRef('project', name);
  return formatMcpRef('global', name);
}

/**
 * Converte os nomes antigos da lista (cada um vira uma ref; refs já com escopo ficam). Repetido vira um só. `null` (todos) não muda.
 * `changed`: a lista mudou (para regravar só quando precisa).
 */
export function convertMcps(mcps: string[] | null, known: KnownMcpNames): { mcps: string[] | null; changed: boolean } {
  if (mcps === null) return { mcps, changed: false };
  const out: string[] = [];
  let changed = false;
  for (const m of mcps) {
    const next = isMcpRef(m) ? m : resolveLegacyMcp(m, known);
    if (next !== m) changed = true;
    if (out.includes(next)) {
      changed = true;
      continue;
    }
    out.push(next);
  }
  return { mcps: out, changed };
}

/** Os nomes que existem, a partir das refs (a lista de MCPs do projeto): para converter nome antigo onde só se tem as refs. */
export function knownFromRefs(refs: readonly string[]): KnownMcpNames {
  const out: KnownMcpNames = { globalNames: [], projectNames: [] };
  for (const r of refs) {
    const p = parseMcpRef(r);
    if (p) (p.scope === 'global' ? out.globalNames : out.projectNames).push(p.name);
  }
  return out;
}

/** O mesmo nome em Global e Projeto na mesma ficha: um só sobe na conversa (o Projeto), então a ficha não pode marcar os dois. */
export function duplicateMcpNames(mcps: readonly string[] | null): string[] {
  const seen = new Map<string, McpScopeName>();
  const dup = new Set<string>();
  for (const m of mcps ?? []) {
    const p = parseMcpRef(m);
    if (!p) continue;
    const prev = seen.get(p.name);
    if (prev && prev !== p.scope) dup.add(p.name);
    seen.set(p.name, p.scope);
  }
  return [...dup];
}
