import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerInfo, StaffProfile } from '../../shared/model';
import { MYCO_HOME } from '../config';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { findSecret } from '../chat/secrets';
import { CODEX_EXTRA_MCP_NAME, CODEX_RESERVED_MCP_NAMES, type CodexExtraMcp } from '../chat/codexArgs';
import { cleanEnv, withoutMycoToken } from '../auth';
import { DEFAULT_SECRETS_DIR, getSecret, type VaultOptions } from '../secretVault';
import { isMcpRef, knownFromRefs, MCP_NAME, resolveLegacyMcp, type KnownMcpNames, type McpScopeName } from '../mcpAccessRefs';
import { mcpLaunchCommand, parseLauncherEntry, quotedCommand } from './mcpLaunch';
import { MCP_TOOLS_FILE, mcpFingerprint, testedToolsMany, toolsKey, type McpTool } from './mcpTools';
import { codexMcpAccess, mcpAccessFile, validMcpName, type McpAccessFile, type McpAccessMap } from './mcpAccess';
import { SSH_MCP_NAME, TOOLS as SSH_TOOLS } from './sshMcp';
import { GIT_MCP_NAME, TOOLS as GIT_TOOLS } from './gitMcp';
import { writeAtomic } from './store';

// MCPs que vão para a conversa de um funcionário, de dois escopos (como as skills; a ficha guarda `global:<nome>` ou `project:<nome>`, ver mcpAccessRefs.ts):
//   global  = ~/.claude.json (mcpServers): vale também no Claude Code fora do Claudio’s Club. Os MCPs que o Club cadastra ficam aqui como
//             uma entrada que chama o lançador (mcpLaunch.ts) com o nome do servidor: os valores ficam no cofre, e comando, URL e nomes
//             de chave no registro da biblioteca (~/.myco/mcps.json, sem valor).
//   project = .mcp.json do projeto (vai para o git: sem segredo literal) e o escopo local do projeto em ~/.claude.json
//             (projects[<caminho>].mcpServers; fora do git, `outOfGit`). Mesmo nome nos dois: vale o local, como no Claude Code.
// Cada ref é um servidor; a conversa só sobe um por nome (se a ficha marcar os dois, o do Projeto).
// Para o navegador vão só nomes e origem: a configuração de um servidor costuma ter chaves de API.
// A edição e o cadastro estão em mcpLibrary.ts; a migração do modelo antigo, em mcpMigration.ts.

/** O registro das definições dos MCPs do Claudio’s Club (comando, URL, nomes de chave; sem valor): fica fora de qualquer projeto, como as skills. */
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
  /** `global:<nome>` ou `project:<nome>`. */
  ref: string;
  name: string;
  scope: McpScopeName;
  /** Onde está: ~/.claude.json (`user`), .mcp.json (`mcpjson`) ou o escopo local do projeto (`local`). */
  from: 'user' | 'mcpjson' | 'local';
  info: McpServerInfo;
  /** O que o Codex e a impressão do teste leem: a entrada como está, ou a definição do registro quando é do Club. */
  config: ServerConfig;
  /** A entrada como está no arquivo: é o que o Claude recebe (a do Club é refeita com o lançador de agora, ver buildMcpConfig). */
  entry: ServerConfig;
  /** Entrada do Club (chama o lançador): o nome do servidor no registro e a definição, de onde buildMcpConfig tira os nomes de env e cabeçalho do cofre. */
  club?: { name: string; def: ClubEntry };
}

const keysOf = (def: ClubEntry) => ({ env: def.env ?? [], headers: def.headers ?? [] });

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

/**
 * A aprovação dos servidores do .mcp.json deste projeto, como o Claude Code guarda no ~/.claude.json (em `projects[<caminho>]`, pela mesma
 * chave de `local`): `enableAllProjectMcpServers`, `enabledMcpjsonServers` e `disabledMcpjsonServers`.
 */
export interface McpJsonApproval {
  all: boolean;
  enabled: Set<string>;
  disabled: Set<string>;
}

/** A aprovação do projeto no ~/.claude.json (vazia se o arquivo não entendeu, o que nega tudo: é o lado seguro). */
function approvalOf(projects: Record<string, Record<string, unknown>> | undefined, projectPath: string): McpJsonApproval {
  const out: McpJsonApproval = { all: false, enabled: new Set(), disabled: new Set() };
  const key = pathKey(projectPath);
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  for (const [p, entry] of Object.entries(projects ?? {})) {
    if (pathKey(p) !== key) continue;
    if (entry.enableAllProjectMcpServers === true) out.all = true;
    for (const n of names(entry.enabledMcpjsonServers)) out.enabled.add(n);
    for (const n of names(entry.disabledMcpjsonServers)) out.disabled.add(n);
  }
  return out;
}

/**
 * Aprovado no Claude Code: `disabledMcpjsonServers` vence; senão, vale `enableAllProjectMcpServers` ou o nome em `enabledMcpjsonServers`.
 * Sem isso o Claude não carrega o servidor do .mcp.json do projeto: o Codex segue o mesmo critério (ver codexMcpServers).
 */
export function mcpJsonApproved(a: McpJsonApproval, name: string): boolean {
  return !a.disabled.has(name) && (a.all || a.enabled.has(name));
}

async function collect(projectPath: string, claudeConfigFile: string, clubFile: string): Promise<Map<string, Found>> {
  return (await collectWithApproval(projectPath, claudeConfigFile, clubFile)).found;
}

/** A definição do registro como configuração de servidor (o que a impressão do teste e o Codex leem). */
function defConfig(def: ClubEntry): ServerConfig {
  const config: ServerConfig = { type: def.type };
  if (def.url) config.url = def.url;
  if (def.command) config.command = def.command;
  if (def.args) config.args = def.args;
  return config;
}

/**
 * A entrada do Club (que chama o lançador) deste mcpServers, ou null: o `--server` está no registro e o `--club` é o nosso. Só então os valores
 * estão no cofre; qualquer outra entrada (o usuário a escreveu, ou aponta para outro registro) vale como está, com o que o arquivo traz.
 */
export function clubDefOf(entry: Record<string, unknown>, club: { servers: Record<string, ClubEntry> } | null, clubFile: string): { name: string; def: ClubEntry } | null {
  const ref = parseLauncherEntry(entry);
  if (!ref || ref.club === undefined || pathKey(ref.club) !== pathKey(clubFile) || !club) return null;
  return Object.prototype.hasOwnProperty.call(club.servers, ref.server) ? { name: ref.server, def: club.servers[ref.server]! } : null;
}

/** Os servidores achados e a aprovação do projeto, num só passe pelo ~/.claude.json (quem precisa da aprovação, o Codex, pede este). */
async function collectWithApproval(projectPath: string, claudeConfigFile: string, clubFile: string): Promise<{ found: Map<string, Found>; approval: McpJsonApproval }> {
  const found = new Map<string, Found>();
  const put = (from: Found['from'], name: string, entry: ServerConfig, club?: Found['club']) => {
    // Nome que a ficha não consegue marcar (ver parseMcpRef) não entra.
    if (!MCP_NAME.test(name) || name === '__proto__') return;
    const scope: McpScopeName = from === 'user' ? 'global' : 'project';
    const config = club ? defConfig(club.def) : entry;
    const transport = config.type ?? (config.url ? 'http' : config.command ? 'stdio' : null);
    const info: McpServerInfo = { name, ref: `${scope}:${name}`, scope, source: scope === 'global' ? 'user' : 'project', transport, ...(from === 'local' && { outOfGit: true }) };
    found.set(info.ref, { ref: info.ref, name, scope, from, info, config, entry, club });
  };
  const add = (from: Found['from'], servers: Record<string, ServerConfig> | undefined, club?: { servers: Record<string, ClubEntry> } | null) => {
    for (const [name, entry] of Object.entries(servers ?? {})) put(from, name, entry, club ? (clubDefOf(entry, club, clubFile) ?? undefined) : undefined);
  };

  const user = ClaudeJson.safeParse(await readJson(claudeConfigFile));
  const project = McpJson.safeParse(await readJson(path.join(projectPath, '.mcp.json')));
  // Registro ilegível = nenhuma entrada do Club vale como tal (a tela avisa ao salvar; aqui não derruba a conversa).
  const club = await readClub(clubFile).catch(() => null);
  if (user.success) add('user', user.data.mcpServers, club);
  if (project.success) add('mcpjson', project.data.mcpServers);
  // O local vem depois: mesmo nome no .mcp.json e no escopo local vale o local (a precedência do Claude Code).
  if (user.success) {
    const key = pathKey(projectPath);
    for (const [p, entry] of Object.entries(user.data.projects ?? {})) {
      if (pathKey(p) === key) add('local', entry.mcpServers);
    }
  }
  return { found, approval: approvalOf(user.success ? user.data.projects : undefined, projectPath) };
}

/**
 * Os nomes de MCP que existem agora (Global e Projeto), para converter nome antigo da ficha (ver resolveLegacyMcp). Arquivo que existe e não
 * é JSON lança McpError: converter no escuro mandaria um nome do projeto para a Global. Arquivo que não existe = nenhum nome.
 */
export async function knownMcpNames(projectPath: string, claudeConfigFile: string): Promise<KnownMcpNames> {
  const read = async (file: string): Promise<Record<string, unknown> | null> => {
    const raw = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw new McpError(`não consegui ler ${path.basename(file)}`);
    });
    if (raw === null) return null;
    const v = tryJson(raw.replace(/^﻿/, ''));
    if (!isObj(v)) throw new McpError(`${path.basename(file)} não é um JSON válido`);
    return v;
  };
  const names = (servers: unknown): string[] => (isObj(servers) ? Object.keys(servers).filter((n) => MCP_NAME.test(n)) : []);
  const user = await read(claudeConfigFile);
  const mcpjson = await read(path.join(projectPath, '.mcp.json'));
  const key = pathKey(projectPath);
  const local = isObj(user?.projects) ? Object.entries(user.projects).filter(([p]) => pathKey(p) === key).flatMap(([, e]) => names(isObj(e) ? e.mcpServers : null)) : [];
  return { globalNames: names(user?.mcpServers), projectNames: [...new Set([...names(mcpjson?.mcpServers), ...local])] };
}

/**
 * Os servidores que a ficha leva, um por nome. `mcps` null = todos os achados. Nome antigo (sem escopo) vale como na conversão da ficha
 * (Projeto se existe lá, senão Global). Ref que não existe agora fica de fora. O mesmo nome em Global e Projeto: um só sobe, o do Projeto.
 */
function loadedOf(found: Map<string, Found>, mcps: string[] | null): Found[] {
  const known = knownFromRefs([...found.keys()]);
  const refs = mcps === null ? [...found.keys()] : mcps.map((m) => (isMcpRef(m) ? m : resolveLegacyMcp(m, known)));
  const byName = new Map<string, Found>();
  for (const ref of new Set(refs)) {
    const f = found.get(ref);
    if (!f) continue;
    const prev = byName.get(f.name);
    if (prev) {
      if (mcps !== null) console.warn(`[staff] MCP ${f.name}: marcado na Global e no Projeto; só o do Projeto sobe nesta conversa`);
      if (f.scope === 'project') byName.set(f.name, f);
      continue;
    }
    byName.set(f.name, f);
  }
  return [...byName.values()];
}

/** As ferramentas do último teste de cada servidor achado, por ref (só os que ainda batem com o teste; ver mcpTools.ts). */
async function toolsOf(found: Map<string, Found>, projectPath: string, toolsFile: string): Promise<Map<string, McpTool[]>> {
  const keyOf = (f: Found) => toolsKey(f.scope, projectPath, f.name);
  const tested = await testedToolsMany(
    toolsFile,
    [...found.values()].map((f) => ({ key: keyOf(f), fingerprint: mcpFingerprint(f.config) })),
  );
  const out = new Map<string, McpTool[]>();
  for (const [ref, f] of found) {
    const tools = tested.get(keyOf(f));
    if (tools) out.set(ref, tools);
  }
  return out;
}

export async function listMcpServers(projectPath: string, claudeConfigFile: string, clubFile = CLUB_MCP_FILE, toolsFile = MCP_TOOLS_FILE): Promise<McpServerInfo[]> {
  const found = await collect(projectPath, claudeConfigFile, clubFile);
  const tools = await toolsOf(found, projectPath, toolsFile).catch(() => new Map<string, McpTool[]>());
  return [...found.values()]
    .map((f) => {
      const list = tools.get(f.ref);
      return list ? { ...f.info, tools: { total: list.length, write: list.filter((t) => !t.readOnly).length } } : f.info;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1));
}

/**
 * O acesso aos MCPs da ficha (`mcpAccess`) para esta sessão, no formato que o hook mcp-write-guard lê (ver mcpAccessFile). Só o motor
 * Claude (o Codex trata o acesso no próprio lançamento). Um MCP com regra que não está no projeto agora segue no arquivo, sem lista de leitura.
 */
export async function mcpWriteFileFor(
  projectPath: string,
  profile: Pick<StaffProfile, 'engine' | 'mcpAccess'> & { mcps?: string[] | null },
  claudeConfigFile: string,
  o: { clubFile?: string; toolsFile?: string } = {},
): Promise<McpAccessFile> {
  if ((profile.engine ?? 'claude') !== 'claude' || !profile.mcpAccess || !Object.keys(profile.mcpAccess).length) return {};
  const found = await collect(projectPath, claudeConfigFile, o.clubFile ?? CLUB_MCP_FILE);
  // Arquivo ilegível = sem lista de leitura: o hook só deixa passar o que está nela, então errar aqui não libera nada.
  const byRef = await toolsOf(found, projectPath, o.toolsFile ?? MCP_TOOLS_FILE).catch(() => new Map<string, McpTool[]>());
  // O acesso é por nome e a conversa só sobe um servidor por nome: a lista de leitura é a do que a ficha leva (sem lista, o que o Claude carrega).
  const tools = new Map<string, McpTool[]>();
  for (const f of loadedOf(found, profile.mcps ?? null)) {
    const list = byRef.get(f.ref);
    if (list) tools.set(f.name, list);
  }
  // O myco-ssh é do Club: a lista de leitura vem do próprio código (a anotação de cada ferramenta), não de um teste; sobrescreve o que vier de fora.
  tools.set(SSH_MCP_NAME, SSH_TOOLS.map((t) => ({ name: t.name, readOnly: t.annotations.readOnlyHint })));
  // O myco-git também: leitura (status, diff, log) é o que `readonly` e `ask` deixam passar.
  tools.set(GIT_MCP_NAME, GIT_TOOLS.map((t) => ({ name: t.name, readOnly: t.annotations.readOnlyHint })));
  return mcpAccessFile(profile.mcpAccess, tools);
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
 * Configuração para `--mcp-config` só com os servidores escolhidos na ficha (`mcps`: refs; nome antigo vale como na conversão). Só entra no
 * `--mcp-config` quando a ficha tem lista (`--strict-mcp-config`): com `mcps` null a conversa não usa este arquivo e o Claude Code carrega
 * sozinho os do ~/.claude.json, então copiá-los subiria o mesmo servidor duas vezes (ver launch.ts). Os do Club não levam valor: o comando é
 * o lançador (mcpLaunch.ts), que tira env e cabeçalhos do cofre ao subir; aqui só se confere que os valores existem e se refaz a entrada
 * com o lançador de agora.
 */
export async function buildMcpConfig(
  projectPath: string,
  mcps: string[],
  claudeConfigFile: string,
  o: { clubFile?: string; vault?: VaultOptions } = {},
): Promise<{ mcpServers: Record<string, ServerConfig> }> {
  const clubFile = o.clubFile ?? CLUB_MCP_FILE;
  const vaultDir = o.vault?.dir ?? DEFAULT_SECRETS_DIR;
  const found = await collect(projectPath, claudeConfigFile, clubFile);
  const mcpServers: Record<string, ServerConfig> = {};
  for (const f of loadedOf(found, mcps)) {
    if (!f.club) {
      mcpServers[f.name] = f.entry;
      continue;
    }
    const r = await resolveClub(f.club.name, {}, keysOf(f.club.def), o.vault);
    if ('missing' in r) {
      // Sem o valor, o servidor sobe quebrado e a conversa só erra depois: deixa de fora e avisa no log (sem valor).
      console.warn(`[staff] MCP ${f.name}: não achei o valor de ${r.missing} no cofre; fora desta conversa (cadastre de novo)`);
      continue;
    }
    const cfg = clubEntry(f.club.name, f.club.def, { clubFile, vaultDir });
    if (!cfg) {
      console.warn(`[staff] MCP ${f.name}: caminho com aspas, % ou $ (ou caractere de controle), ou sem URL; fora desta conversa`);
      continue;
    }
    mcpServers[f.name] = cfg;
  }
  return { mcpServers };
}

/**
 * A entrada de mcpServers de um MCP do Club, sem valor (a do ~/.claude.json e a do mcp.json da conversa). stdio: o lançador com `--server`.
 * http/sse com cabeçalho: `headersHelper`, o comando que o Claude Code roda antes de conectar (sai o JSON dos cabeçalhos). Sem cabeçalho,
 * `{type, url}`. null se a linha de comando não pode ser citada com segurança (aspas duplas, `%`, `$`, crase ou controle no caminho) ou se
 * http/sse não tem URL. `o.launcher` troca o lançador (testes e a migração); o padrão é o de agora (mcpLaunchCommand).
 */
export function clubEntry(name: string, def: ClubEntry, o: { clubFile: string; vaultDir: string; launcher?: { command: string; args: string[] } }): ServerConfig | null {
  const launch = o.launcher ?? mcpLaunchCommand();
  if (def.type === 'stdio') {
    return { type: 'stdio', command: launch.command, args: [...launch.args, '--server', name, '--club', o.clubFile, '--vault', o.vaultDir] };
  }
  if (!def.url) return null;
  if ((def.headers ?? []).length === 0) return { type: def.type, url: def.url };
  const helper = quotedCommand([launch.command, ...launch.args, '--headers', '--server', name, '--club', o.clubFile, '--vault', o.vaultDir]);
  if (helper === null) return null;
  return { type: def.type, url: def.url, headersHelper: helper };
}

/**
 * Por que um MCP da ficha ficou fora da conversa do Codex (a ficha diz, em pt-br; ver codexMcpSection). Nenhum motivo leva valor.
 */
export type CodexMcpMotivo =
  | 'nome'
  | 'politica'
  | 'aprovacao'
  | 'sse'
  | 'transporte'
  | 'indisponivel'
  | 'cofre'
  | 'caminho'
  | 'variavel'
  | 'url-segredo';

export interface CodexMcpResult {
  /** Os MCPs que entram na conversa (ver codexExtraMcpArgs). Nenhum valor de env ou cabeçalho aqui: eles vão no arquivo de lançamento ou ficam no cofre. */
  servers: CodexExtraMcp[];
  /** Os que entram só com as ferramentas de leitura porque "pede antes" não tem como perguntar no Codex (a ficha avisa). */
  asked: string[];
  /** Os que a ficha pediu e não entraram, com o motivo. Nível `off` explícito não entra aqui: ele só fica de fora. */
  out: Array<{ name: string; motivo: CodexMcpMotivo }>;
  /** O arquivo de lançamento gravado (com os valores expandidos, modo 0o600), ou null se não há entrada que precise dele. */
  snapshotFile: string | null;
}

/** Uma entrada do arquivo de lançamento da conversa (ver mcpLaunch.ts, `snapshotSpec`): o que o lançador sobe, já com as variáveis expandidas. */
type SnapshotEntry = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> } | { type: 'http'; headers: Record<string, string> };

/**
 * `${VAR}` e `${VAR:-padrão}`, a sintaxe que o Claude Code aceita no mcp.json. Vazia conta como definida, exceto no `:-` (aí vale o padrão).
 * Variável que falta sem padrão devolve o nome (nunca o valor). Expande só no que o Codex recebe (comando, argumentos, ambiente, URL e cabeçalhos).
 */
const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
export function expandVars(text: string, env: NodeJS.ProcessEnv): { value: string } | { missing: string } {
  const miss: { name?: string } = {};
  const value = text.replace(VAR_REF, (_, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && (v !== '' || fallback === undefined)) return v;
    if (fallback !== undefined) return fallback;
    miss.name ??= name;
    return '';
  });
  return miss.name === undefined ? { value } : { missing: miss.name };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * O MCP do usuário, do projeto ou deste projeto, com as variáveis expandidas. `invalid`: algum campo não tem o formato que o Codex lê
 * (argumento ou valor que não é texto). `missing`: uma variável falta e não tem padrão.
 */
function expandConfig(
  cfg: ServerConfig,
  env: NodeJS.ProcessEnv,
): { value: { command: string | null; args: string[]; env: Record<string, string>; url: string | null; headers: Record<string, string> } } | { missing: string } | { invalid: true } {
  const strs = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
  const map = (v: unknown): Record<string, string> | null => {
    if (v === undefined) return {};
    if (!isObj(v) || !Object.values(v).every((x) => typeof x === 'string')) return null;
    return v as Record<string, string>;
  };
  const args = strs(cfg.args);
  const envIn = map(cfg.env);
  const headersIn = map(cfg.headers);
  if (!args || !envIn || !headersIn) return { invalid: true };
  if ((cfg.command !== undefined && typeof cfg.command !== 'string') || (cfg.url !== undefined && typeof cfg.url !== 'string')) return { invalid: true };
  const miss: { name?: string } = {};
  const ex = (s: string): string => {
    const r = expandVars(s, env);
    if ('missing' in r) {
      miss.name ??= r.missing;
      return '';
    }
    return r.value;
  };
  const exMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, ex(v)]));
  const value = {
    command: typeof cfg.command === 'string' ? ex(cfg.command) : null,
    args: args.map(ex),
    env: exMap(envIn),
    url: typeof cfg.url === 'string' ? ex(cfg.url) : null,
    headers: exMap(headersIn),
  };
  return miss.name === undefined ? { value } : { missing: miss.name };
}

/**
 * Chave na URL (no caminho ou na query): a linha de comando do Codex não leva segredo. A mesma checagem de `secretIn`, mas sem o .mcp.json
 * inteiro. Limite: segredo que não casa com um padrão conhecido no caminho passa (ver findSecret).
 */
function urlSecret(url: string): string | null {
  const direct = findSecret(url);
  if (direct) return direct.label;
  if (!URL.canParse(url)) return null;
  for (const [k, v] of new URL(url).searchParams) {
    const label = isLiteralSecret(k, v);
    if (label) return label;
  }
  return null;
}

/**
 * Os MCPs da ficha que entram na conversa do Codex, no mesmo critério do Claude (`buildMcpConfig` e `mcpWriteFileFor`, pelas mesmas refs): a
 * entrada do Club (Global) pelo lançador do pacote, e a Global comum e a do Projeto pelo arquivo de lançamento (`o.snapshotFile`, gravado aqui
 * só se houver entrada; senão é apagado). `names` null = sem lista na ficha: entram todos os da Global e do Projeto (o Codex não carrega nada
 * sozinho, ao contrário do Claude Code).
 * `o.launcher` é o `node` + pacote do lançador (ver mcpLaunchBundle); null = nenhum MCP que precise dele, e a ficha diz que está indisponível.
 * Nenhum valor de env ou cabeçalho sai em `servers`: a biblioteca fica no cofre, e o resto no arquivo de lançamento (que a sandbox nega).
 */
export async function codexMcpServers(
  projectPath: string,
  names: string[] | null,
  claudeConfigFile: string,
  o: {
    access?: McpAccessMap;
    snapshotFile: string;
    launcher: { command: string; args: string[] } | null;
    clubFile?: string;
    vault?: VaultOptions;
    toolsFile?: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CodexMcpResult> {
  const clubFile = o.clubFile ?? CLUB_MCP_FILE;
  const vaultDir = o.vault?.dir ?? DEFAULT_SECRETS_DIR;
  // O mesmo ambiente que o Claude e o Codex recebem (sem CLAUDE*/ANTHROPIC*, sem MYCO_TOKEN): a variável do processo do Club não entra
  // no MCP do projeto por acaso.
  const env = o.env ?? withoutMycoToken(cleanEnv());
  const launcher = o.launcher;
  const { found, approval } = await collectWithApproval(projectPath, claudeConfigFile, clubFile);
  // Sem teste (ou arquivo estragado), a lista de leitura fica vazia: `readonly` e `ask` ficam de fora (ver codexMcpAccess).
  const tools = await toolsOf(found, projectPath, o.toolsFile ?? MCP_TOOLS_FILE).catch(() => new Map<string, McpTool[]>());
  const servers: CodexExtraMcp[] = [];
  const asked: string[] = [];
  const out: CodexMcpResult['out'] = [];
  const snapshot = new Map<string, SnapshotEntry>();
  for (const f of loadedOf(found, names)) {
    const name = f.name;
    if (CODEX_RESERVED_MCP_NAMES.has(name)) continue;
    if (!CODEX_EXTRA_MCP_NAME.test(name) || !validMcpName(name)) {
      out.push({ name, motivo: 'nome' });
      continue;
    }
    // `off` explícito: fica de fora sem aviso (a ficha não precisa dizer o que ela mesma proibiu).
    if (o.access && Object.prototype.hasOwnProperty.call(o.access, name) && o.access[name] === 'off') continue;
    // Servidor do .mcp.json do projeto: só entra aprovado no Claude Code (ver approvalOf). Vale com ou sem a lista da ficha. O do escopo local
    // (fora do git) não precisa: é do usuário, não vem do repositório.
    if (f.from === 'mcpjson' && !mcpJsonApproved(approval, name)) {
      out.push({ name, motivo: 'aprovacao' });
      continue;
    }
    const leitura = tools.get(f.ref)?.filter((t) => t.readOnly).map((t) => t.name) ?? null;
    const acc = codexMcpAccess(o.access, name, [], leitura);
    if (!acc.attached) {
      out.push({ name, motivo: 'politica' });
      continue;
    }
    const access = acc.enabledTools ? { enabledTools: acc.enabledTools } : {};
    // `pede antes` só vira leitura: o aviso da ficha vale só para o que entrou (por isso entra aqui, não antes).
    const add = (server: CodexExtraMcp) => {
      servers.push(server);
      if (acc.askAsReadonly) asked.push(name);
    };
    const cfg = f.config;
    const type = cfg.type ?? (cfg.url ? 'http' : cfg.command ? 'stdio' : null);
    if (type === 'sse') {
      out.push({ name, motivo: 'sse' });
      continue;
    }
    if (type !== 'stdio' && type !== 'http') {
      out.push({ name, motivo: 'transporte' });
      continue;
    }
    if (f.club) {
      // Entrada do Club: confere o cofre como o Claude (buildMcpConfig), sem sair valor no log. `--server` é o nome no registro (a chave no
      // ~/.claude.json pode ser outra).
      const server = f.club.name;
      const r = await resolveClub(server, {}, keysOf(f.club.def), o.vault);
      if ('missing' in r) {
        console.warn(`[staff] MCP ${name}: não achei o valor de ${r.missing} no cofre; fora desta conversa do Codex (cadastre de novo)`);
        out.push({ name, motivo: 'cofre' });
        continue;
      }
      if (type === 'stdio') {
        if (!cfg.command) {
          out.push({ name, motivo: 'transporte' });
          continue;
        }
        if (!launcher) {
          out.push({ name, motivo: 'indisponivel' });
          continue;
        }
        add({ name, command: launcher.command, args: [...launcher.args, '--server', server, '--club', clubFile, '--vault', vaultDir], ...access });
        continue;
      }
      if (!cfg.url) {
        out.push({ name, motivo: 'transporte' });
        continue;
      }
      if (keysOf(f.club.def).headers.length === 0) {
        add({ name, url: cfg.url, ...access });
        continue;
      }
      if (!launcher) {
        out.push({ name, motivo: 'indisponivel' });
        continue;
      }
      const helper = quotedCommand([launcher.command, ...launcher.args, '--headers', '--server', server, '--club', clubFile, '--vault', vaultDir]);
      if (helper === null) {
        out.push({ name, motivo: 'caminho' });
        continue;
      }
      add({ name, url: cfg.url, headersHelper: helper, ...access });
      continue;
    }
    // Global comum ou Projeto: os valores estão no próprio arquivo (com `${VAR}`), então expande agora, do ambiente do Club.
    const vars = expandConfig(cfg, env);
    if ('invalid' in vars) {
      out.push({ name, motivo: 'transporte' });
      continue;
    }
    if ('missing' in vars) {
      console.warn(`[staff] MCP ${name}: a variável ${vars.missing} não está definida e não tem padrão; fora desta conversa do Codex`);
      out.push({ name, motivo: 'variavel' });
      continue;
    }
    const x = vars.value;
    if (type === 'stdio') {
      if (!x.command) {
        out.push({ name, motivo: 'transporte' });
        continue;
      }
      if (!launcher) {
        out.push({ name, motivo: 'indisponivel' });
        continue;
      }
      // Comando, argumentos e ambiente vão só no arquivo de lançamento: nada disso na linha de comando.
      snapshot.set(name, { type: 'stdio', command: x.command, args: x.args, env: x.env });
      add({ name, command: launcher.command, args: [...launcher.args, '--snapshot', o.snapshotFile, '--server', name], ...access });
      continue;
    }
    if (!x.url) {
      out.push({ name, motivo: 'transporte' });
      continue;
    }
    if (urlSecret(x.url)) {
      out.push({ name, motivo: 'url-segredo' });
      continue;
    }
    if (Object.keys(x.headers).length === 0) {
      add({ name, url: x.url, ...access });
      continue;
    }
    if (!launcher) {
      out.push({ name, motivo: 'indisponivel' });
      continue;
    }
    const helper = quotedCommand([launcher.command, ...launcher.args, '--headers', '--snapshot', o.snapshotFile, '--server', name]);
    if (helper === null) {
      out.push({ name, motivo: 'caminho' });
      continue;
    }
    snapshot.set(name, { type: 'http', headers: x.headers });
    add({ name, url: x.url, headersHelper: helper, ...access });
  }
  let snapshotFile: string | null = null;
  if (snapshot.size) {
    await writeAtomic(o.snapshotFile, JSON.stringify({ servers: Object.fromEntries(snapshot) }, null, 2));
    // Só o dono lê. No Windows o chmod quase não faz nada (só a flag de somente leitura): a proteção real é a sandbox, que nega a pasta ao agente.
    await fs.chmod(o.snapshotFile, 0o600).catch(() => undefined);
    snapshotFile = o.snapshotFile;
  } else await fs.rm(o.snapshotFile, { force: true });
  return { servers, asked, out, snapshotFile };
}
