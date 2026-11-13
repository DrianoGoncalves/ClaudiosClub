import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerInfo, StaffProfile } from '../../shared/model';
import { MYCO_HOME } from '../config';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { findSecret } from '../chat/secrets';
import { DEFAULT_SECRETS_DIR, getSecret, type VaultOptions } from '../secretVault';
import { mcpLaunchCommand } from './mcpLaunch';
import { MCP_TOOLS_FILE, mcpFingerprint, mcpWriteRules, testedToolsMany, toolsKey, type McpTool } from './mcpTools';

// MCPs que vão para a conversa de um funcionário, de quatro origens (da mais específica para a mais geral):
//   local   = só este projeto, em ~/.claude.json (projects[<caminho>].mcpServers)
//   project = .mcp.json do projeto (vai para o git: sem segredo literal)
//   club    = biblioteca do Claudio’s Club (~/.myco/mcps.json, sem segredo: os valores ficam no cofre)
//   user    = todos os projetos, em ~/.claude.json (mcpServers)
// Quando o mesmo nome aparece em mais de uma, vence a mais específica (local > project > club > user).
// Para o navegador vão só nomes e origem: a configuração de um servidor costuma ter chaves de API.
// A edição e o cadastro estão em mcpLibrary.ts.

/** A biblioteca do Claudio’s Club: fica fora de qualquer projeto, como as skills. */
export const CLUB_MCP_FILE = path.join(MYCO_HOME, 'mcps.json');

export class McpError extends Error {}

const Servers = z.record(z.string(), z.object({ type: z.string().optional(), command: z.string().optional(), url: z.string().optional() }).passthrough());
const McpJson = z.object({ mcpServers: Servers.optional() });
const ClaudeJson = z.object({
  mcpServers: Servers.optional(),
  projects: z.record(z.string(), z.object({ mcpServers: Servers.optional() }).passthrough()).optional(),
});

/** Entrada da biblioteca. Env e cabeçalhos guardam só os nomes: os valores estão no cofre (clubSecretId). */
export const ClubEntry = z.object({
  type: z.enum(['http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  headers: z.array(z.string()).optional(),
});
export type ClubEntry = z.infer<typeof ClubEntry>;
const ClubJson = z.object({ servers: z.record(z.string(), ClubEntry).optional() }).passthrough();

type ServerConfig = z.infer<typeof Servers>[string];

interface Found {
  info: McpServerInfo;
  config: ServerConfig;
  /** Só na biblioteca: os nomes de env e cabeçalho que buildMcpConfig tira do cofre. */
  club?: { env: string[]; headers: string[] };
}

/** O id do valor no cofre: `mcp:club:<nome>:env|header:<chave>`. */
export const clubSecretId = (name: string, kind: 'env' | 'header', key: string) => `mcp:club:${name}:${kind}:${key}`;

async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  return raw === null ? null : tryJson(raw.replace(/^﻿/, ''));
}

/**
 * O arquivo da biblioteca, inteiro (para preservar o que não é nosso). null se não existe; lança McpError
 * se existe e está estragado: quem grava não pode sobrescrever o que não entendeu.
 */
export async function readClub(file: string): Promise<{ doc: Record<string, unknown>; servers: Record<string, ClubEntry> } | null> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = ClubJson.safeParse(tryJson(raw.replace(/^﻿/, '')));
  if (!parsed.success) throw new McpError('o arquivo da biblioteca (mcps.json) está com JSON inválido: corrija antes, não mexi nele');
  return { doc: parsed.data as Record<string, unknown>, servers: parsed.data.servers ?? {} };
}

async function collect(projectPath: string, claudeConfigFile: string, clubFile: string): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const put = (source: McpServerInfo['source'], name: string, config: ServerConfig, club?: Found['club']) => {
    found.set(name, { info: { name, source, transport: config.type ?? (config.url ? 'http' : config.command ? 'stdio' : null) }, config, club });
  };
  const add = (source: McpServerInfo['source'], servers: Record<string, ServerConfig> | undefined) => {
    for (const [name, config] of Object.entries(servers ?? {})) put(source, name, config);
  };

  const user = ClaudeJson.safeParse(await readJson(claudeConfigFile));
  const project = McpJson.safeParse(await readJson(path.join(projectPath, '.mcp.json')));
  // Biblioteca ilegível = nenhum MCP dela (a tela avisa ao salvar; aqui não derruba a conversa).
  const club = await readClub(clubFile).catch(() => null);
  if (user.success) add('user', user.data.mcpServers);
  for (const [name, c] of Object.entries(club?.servers ?? {})) {
    const config: ServerConfig = { type: c.type };
    if (c.url) config.url = c.url;
    if (c.command) config.command = c.command;
    if (c.args) config.args = c.args;
    put('club', name, config, {
      env: c.env ?? [],
      headers: c.headers ?? [],
    });
  }
  if (project.success) add('project', project.data.mcpServers);
  if (user.success) {
    const key = pathKey(projectPath);
    for (const [p, entry] of Object.entries(user.data.projects ?? {})) {
      if (pathKey(p) === key) add('local', entry.mcpServers);
    }
  }
  return found;
}

/** As ferramentas do último teste de cada servidor achado (só os que ainda batem com o teste; ver mcpTools.ts). */
async function toolsOf(found: Map<string, Found>, projectPath: string, toolsFile: string): Promise<Map<string, McpTool[]>> {
  const keyOf = (name: string, f: Found) => toolsKey(f.info.source, projectPath, name);
  const tested = await testedToolsMany(
    toolsFile,
    [...found].map(([name, f]) => ({ key: keyOf(name, f), fingerprint: mcpFingerprint(f.config) })),
  );
  const out = new Map<string, McpTool[]>();
  for (const [name, f] of found) {
    const tools = tested.get(keyOf(name, f));
    if (tools) out.set(name, tools);
  }
  return out;
}

export async function listMcpServers(projectPath: string, claudeConfigFile: string, clubFile = CLUB_MCP_FILE, toolsFile = MCP_TOOLS_FILE): Promise<McpServerInfo[]> {
  const found = await collect(projectPath, claudeConfigFile, clubFile);
  const tools = await toolsOf(found, projectPath, toolsFile).catch(() => new Map<string, McpTool[]>());
  return [...found.values()]
    .map((f) => {
      const list = tools.get(f.info.name);
      return list ? { ...f.info, tools: { total: list.length, write: list.filter((t) => !t.readOnly).length } } : f.info;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * As regras da política de escrita da ficha (`mcpWrite`) para esta sessão: `deny` vai ao `--disallowedTools`, `ask` ao
 * `permissions.ask` do `--settings`. Só o motor Claude (o Codex não tem MCPs). MCP que não está no projeto fica de fora.
 */
export async function mcpWriteRulesFor(
  projectPath: string,
  profile: Pick<StaffProfile, 'engine' | 'mcpWrite'>,
  claudeConfigFile: string,
  o: { clubFile?: string; toolsFile?: string } = {},
): Promise<{ deny: string[]; ask: string[] }> {
  if ((profile.engine ?? 'claude') !== 'claude' || !profile.mcpWrite || !Object.keys(profile.mcpWrite).length) return { deny: [], ask: [] };
  const found = await collect(projectPath, claudeConfigFile, o.clubFile ?? CLUB_MCP_FILE);
  // Arquivo ilegível = sem lista: a regra vale para o servidor inteiro (nunca libera por erro de leitura).
  const tools = await toolsOf(found, projectPath, o.toolsFile ?? MCP_TOOLS_FILE).catch(() => new Map<string, McpTool[]>());
  const servers = new Map<string, McpTool[] | null>([...found.keys()].map((name) => [name, tools.get(name) ?? null]));
  return mcpWriteRules(profile.mcpWrite, servers);
}

export interface McpSecret {
  server: string;
  /** Tipo, em português ("uma chave da API da Anthropic"); o valor nunca sai daqui. */
  label: string;
}

/** Nomes de variável ou cabeçalho que guardam segredo. */
const SECRET_NAME = /(?:^|[_-])(?:api[_-]?key|key|token|secret|password|passwd|pat)$|^authorization$/i;

/**
 * Tipo do segredo literal (não `${VARIAVEL}`) num valor com este nome, ou null. Usado para achar chave no
 * .mcp.json, para recusar segredo literal no que vai para o git e para mascarar a lista da biblioteca.
 */
export function isLiteralSecret(name: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('${')) return null;
  const hit = findSecret(value) ?? (name ? findSecret(`${name}=${value}`) : null);
  if (hit) return hit.label;
  if (name && SECRET_NAME.test(name) && value.trim().length >= 8) return 'uma chave';
  return null;
}

/**
 * Chaves escritas direto no .mcp.json (em env, headers, args ou url de cada servidor). O jeito
 * certo é `${VARIAVEL}` no arquivo e o valor no ambiente, e isso não conta.
 */
export function findMcpJsonSecrets(json: unknown): McpSecret[] {
  const parsed = McpJson.safeParse(json);
  if (!parsed.success) return [];
  const out: McpSecret[] = [];
  for (const [server, config] of Object.entries(parsed.data.mcpServers ?? {})) {
    const label = secretIn(config);
    if (label) out.push({ server, label });
  }
  return out;
}

function secretIn(config: ServerConfig): string | null {
  const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v as Record<string, unknown>) : []);
  const pairs: Array<[string, unknown]> = [
    ...record(config.env),
    ...record(config.headers),
    ...(Array.isArray(config.args) ? config.args.map((a): [string, unknown] => ['', a]) : []),
    ['url', config.url],
    // https://mcp.exemplo.com/?api_key=… também é chave escrita no arquivo.
    ...(typeof config.url === 'string' && URL.canParse(config.url) ? [...new URL(config.url).searchParams] : []),
  ];
  for (const [name, value] of pairs) {
    const label = isLiteralSecret(name, value);
    if (label) return label;
  }
  return null;
}

const WARN_TTL_MS = 5 * 60_000;
const warnCache = new Map<string, { mtimeMs: number; at: number; out: McpSecret[] }>();

/**
 * Chaves escritas no .mcp.json do projeto, se ele não está fora do git (é o arquivo que o time
 * versiona). Relido quando o arquivo muda (ou a cada 5 min, se o .gitignore mudou).
 */
export async function mcpJsonWarnings(projectPath: string, now = Date.now()): Promise<McpSecret[]> {
  const file = path.join(projectPath, '.mcp.json');
  const st = await fs.stat(file).catch(() => null);
  if (!st) return [];
  const hit = warnCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && now - hit.at < WARN_TTL_MS) return hit.out;
  const found = findMcpJsonSecrets(await readJson(file));
  const out = found.length && !(await gitIgnored(projectPath, '.mcp.json')) ? found : [];
  warnCache.set(file, { mtimeMs: st.mtimeMs, at: now, out });
  return out;
}

/** `git check-ignore`: 0 = ignorado; 1 = não; outro (sem git) = não. */
function gitIgnored(dir: string, file: string): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('git', ['-C', dir, 'check-ignore', '-q', file], { windowsHide: true, timeout: 5_000 }, (err) => resolve(!err)),
  );
}

/**
 * Pega os valores de um MCP da biblioteca no cofre. `missing` = um valor não está (ou o cofre não abre):
 * quem chama decide (buildMcpConfig deixa o servidor de fora, com aviso no log; o teste mostra o erro).
 */
export async function resolveClub(
  name: string,
  base: Record<string, unknown>,
  keys: { env: string[]; headers: string[] },
  vault?: VaultOptions,
): Promise<{ config: Record<string, unknown> } | { missing: string }> {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const fetchAll = async (kind: 'env' | 'header', list: string[], into: Record<string, string>) => {
    for (const key of list) {
      const value = await getSecret(clubSecretId(name, kind, key), vault).catch(() => null);
      if (value === null) return key;
      into[key] = value;
    }
    return null;
  };
  const missing = (await fetchAll('env', keys.env, env)) ?? (await fetchAll('header', keys.headers, headers));
  if (missing) return { missing };
  return { config: { ...base, ...(keys.env.length > 0 ? { env } : {}), ...(keys.headers.length > 0 ? { headers } : {}) } };
}

/**
 * Configuração para `--mcp-config` só com os servidores escolhidos na ficha. Os da biblioteca não levam valor: o comando é o
 * lançador (mcpLaunch.ts), que tira env e cabeçalhos do cofre ao subir. Aqui só se confere que os valores existem.
 */
export async function buildMcpConfig(
  projectPath: string,
  names: string[],
  claudeConfigFile: string,
  o: { clubFile?: string; vault?: VaultOptions } = {},
): Promise<{ mcpServers: Record<string, ServerConfig> }> {
  const clubFile = o.clubFile ?? CLUB_MCP_FILE;
  const vaultDir = o.vault?.dir ?? DEFAULT_SECRETS_DIR;
  const found = await collect(projectPath, claudeConfigFile, clubFile);
  const mcpServers: Record<string, ServerConfig> = {};
  for (const name of names) {
    const f = found.get(name);
    if (!f) continue;
    if (!f.club) {
      mcpServers[name] = f.config;
      continue;
    }
    const r = await resolveClub(name, {}, f.club, o.vault);
    if ('missing' in r) {
      // Sem o valor, o servidor sobe quebrado e a conversa só erra depois: deixa de fora e avisa no log (sem valor).
      console.warn(`[staff] MCP ${name}: não achei o valor de ${r.missing} no cofre; fora desta conversa (cadastre de novo)`);
      continue;
    }
    const cfg = clubConfig(name, f.config, f.club, { clubFile, vaultDir });
    if (!cfg) {
      console.warn(`[staff] MCP ${name}: caminho com aspas, % ou $ (ou caractere de controle); fora desta conversa`);
      continue;
    }
    mcpServers[name] = cfg;
  }
  return { mcpServers };
}

/**
 * A entrada do mcp.json de um servidor da biblioteca, sem valor. stdio: o lançador com `--server`. http/sse com cabeçalho:
 * `headersHelper`, o comando que o Claude Code roda antes de conectar (sai o JSON dos cabeçalhos). Sem cabeçalho, como estava.
 * null se a linha de comando não pode ser citada com segurança (aspas duplas, `%`, `$`, crase ou controle no caminho).
 */
function clubConfig(name: string, config: ServerConfig, keys: { env: string[]; headers: string[] }, o: { clubFile: string; vaultDir: string }): ServerConfig | null {
  const launch = mcpLaunchCommand();
  if (config.type === 'stdio') {
    return { type: 'stdio', command: launch.command, args: [...launch.args, '--server', name, '--club', o.clubFile, '--vault', o.vaultDir] };
  }
  if (keys.headers.length === 0) return config;
  const parts = [launch.command, ...launch.args, '--headers', '--server', name, '--club', o.clubFile, '--vault', o.vaultDir];
  if (parts.some((p) => /["%$`\u0000-\u001f\u007f]/.test(p))) return null;
  return { type: config.type, url: config.url, headersHelper: parts.map((p) => `"${p}"`).join(' ') };
}
