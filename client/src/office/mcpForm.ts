// MCPs da conta e dos projetos (tela em Configurações): tipos do contrato /api/mcp-servers e a lógica
// do formulário. Valores de env/cabeçalho nunca vêm do servidor: chave guardada aparece como "definido";
// campo vazio = manter (null no corpo), preenchido = trocar, e "remover" vai em `removeKeys`.

export type McpScope = 'club' | 'user' | 'project' | 'local';
export type McpType = 'http' | 'sse' | 'stdio';

export const MCP_SCOPES: McpScope[] = ['club', 'user', 'project', 'local'];
export const MCP_TYPES: McpType[] = ['http', 'sse', 'stdio'];

/** Escopos que moram num projeto (.mcp.json e os locais do ~/.claude.json). */
export const isProjectScope = (s: McpScope) => s === 'project' || s === 'local';

export interface McpKey {
  key: string;
  set: boolean;
}

export interface McpServer {
  name: string;
  scope: McpScope;
  projectId?: string;
  type: McpType;
  url?: string;
  command?: string;
  args?: string[];
  env: McpKey[];
  headers: McpKey[];
  /** Os argumentos têm segredo: o servidor não manda; sem mexer, ficam como estão. */
  argsMasked?: boolean;
}

export interface McpSaveBody {
  scope: McpScope;
  projectId?: string;
  originalName?: string;
  name: string;
  type: McpType;
  url?: string;
  command?: string;
  args?: string[];
  env: Record<string, string | null>;
  headers: Record<string, string | null>;
  removeKeys?: { env?: string[]; headers?: string[] };
}

/** Um par chave/valor do formulário. `saved` = a chave já existe no servidor (a chave não se edita, só o valor). */
export interface PairDraft {
  key: string;
  value: string;
  saved: boolean;
  removed: boolean;
}

export interface McpDraft {
  scope: McpScope;
  projectId: string | null;
  originalName?: string;
  name: string;
  type: McpType;
  url: string;
  command: string;
  /** Um argumento por linha (sem aspas para escapar). */
  args: string;
  argsMasked: boolean;
  /** Na edição de argumentos ocultos: só manda `args` se o usuário pediu para trocar. */
  argsTouched: boolean;
  env: PairDraft[];
  headers: PairDraft[];
}

const savedPairs = (keys: McpKey[]): PairDraft[] => keys.map((k) => ({ key: k.key, value: '', saved: k.set, removed: false }));

/** Rascunho novo (sugere o cofre do Club) ou de um servidor existente. */
export function draftFrom(server: McpServer | null, projectId: string | null = null): McpDraft {
  if (!server) {
    return { scope: 'club', projectId, name: '', type: 'http', url: '', command: '', args: '', argsMasked: false, argsTouched: false, env: [], headers: [] };
  }
  return {
    scope: server.scope,
    projectId: server.projectId ?? projectId,
    originalName: server.name,
    name: server.name,
    type: server.type,
    url: server.url ?? '',
    command: server.command ?? '',
    args: (server.args ?? []).join('\n'),
    argsMasked: !!server.argsMasked,
    argsTouched: false,
    env: savedPairs(server.env),
    headers: savedPairs(server.headers),
  };
}

export const NAME_PATTERN = '[A-Za-z0-9_][A-Za-z0-9_.\\-]*';
const NAME_RE = new RegExp(`^${NAME_PATTERN}$`);
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

export type McpProblem = 'name' | 'url' | 'command' | 'project' | 'key' | 'duplicate' | 'newValue';

/** O que impede salvar (null = ok). Chave nova precisa de valor: vazio só faz sentido em chave guardada (= manter). */
export function draftProblem(d: McpDraft): { problem: McpProblem; key?: string } | null {
  if (!NAME_RE.test(d.name.trim())) return { problem: 'name' };
  if (isProjectScope(d.scope) && !d.projectId) return { problem: 'project' };
  if (d.type === 'stdio') {
    if (!d.command.trim()) return { problem: 'command' };
  } else if (!/^https?:\/\/[^\s]+$/i.test(d.url.trim())) return { problem: 'url' };
  for (const list of [pairsOf(d, 'env'), pairsOf(d, 'headers')]) {
    const seen = new Set<string>();
    for (const p of list) {
      if (p.removed) continue;
      const key = p.key.trim();
      if (!KEY_RE.test(key)) return { problem: 'key', key };
      if (seen.has(key.toLowerCase())) return { problem: 'duplicate', key };
      seen.add(key.toLowerCase());
      if (!p.saved && !p.value) return { problem: 'newValue', key };
    }
  }
  return null;
}

/** Pares para o corpo: guardada e vazia = null (manter); com valor = trocar; removida vai para `removed`. */
function pairsBody(pairs: PairDraft[]): { values: Record<string, string | null>; removed: string[] } {
  const values: Record<string, string | null> = {};
  const removed: string[] = [];
  for (const p of pairs) {
    const key = p.key.trim();
    if (p.removed) {
      if (p.saved) removed.push(key);
      continue;
    }
    values[key] = p.value ? p.value : p.saved ? null : '';
  }
  return { values, removed };
}

const argsList = (text: string) =>
  text
    .split(/\r?\n/)
    .map((a) => a.trim())
    .filter(Boolean);

/** No Claude Code, env é de comando local (stdio) e cabeçalhos são de HTTP/SSE. */
export const pairKind = (type: McpType): 'env' | 'headers' => (type === 'stdio' ? 'env' : 'headers');

/** Os pares que valem para o tipo escolhido (os do outro tipo não aparecem nem vão). */
const pairsOf = (d: McpDraft, kind: 'env' | 'headers') => (pairKind(d.type) === kind ? d[kind] : []);

/** Trocar de tipo descarta os pares do outro: os guardados saem, os novos nem vão. */
const pairsFor = (d: McpDraft, kind: 'env' | 'headers') =>
  pairKind(d.type) === kind ? pairsBody(d[kind]) : { values: {}, removed: d[kind].filter((p) => p.saved).map((p) => p.key) };

/** O corpo do POST /api/mcp-servers/save. */
export function saveBody(d: McpDraft): McpSaveBody {
  const env = pairsFor(d, 'env');
  const headers = pairsFor(d, 'headers');
  const removeKeys = {
    ...(env.removed.length && { env: env.removed }),
    ...(headers.removed.length && { headers: headers.removed }),
  };
  return {
    scope: d.scope,
    ...(isProjectScope(d.scope) && d.projectId && { projectId: d.projectId }),
    ...(d.originalName && { originalName: d.originalName }),
    name: d.name.trim(),
    type: d.type,
    ...(d.type === 'stdio'
      ? { command: d.command.trim(), ...((!d.argsMasked || d.argsTouched) && { args: argsList(d.args) }) }
      : { url: d.url.trim() }),
    env: env.values,
    headers: headers.values,
    ...(Object.keys(removeKeys).length && { removeKeys }),
  };
}

/** A linha da lista: URL, ou comando + argumentos (ocultos quando o servidor mascarou). */
export function targetLabel(s: McpServer): string {
  if (s.type !== 'stdio') return s.url ?? '';
  if (s.argsMasked) return `${s.command ?? ''} …`;
  return [s.command ?? '', ...(s.args ?? [])].join(' ').trim();
}

/** Agrupa na ordem da tela; os de projeto só do projeto escolhido. */
export function groupServers(servers: McpServer[]): Record<McpScope, McpServer[]> {
  const out: Record<McpScope, McpServer[]> = { club: [], user: [], project: [], local: [] };
  for (const s of servers) out[s.scope]?.push(s);
  for (const k of MCP_SCOPES) out[k].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
