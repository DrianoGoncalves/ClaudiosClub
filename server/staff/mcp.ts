import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerInfo } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { findSecret } from '../chat/secrets';

// MCPs que o Claude Code carrega num projeto: .mcp.json do projeto, os "locais" do projeto e
// os do usuário, ambos em ~/.claude.json. Para o navegador vão só nomes e origem: a configuração
// de um servidor costuma ter chaves de API.

const Servers = z.record(z.object({ type: z.string().optional(), command: z.string().optional(), url: z.string().optional() }).passthrough());
const McpJson = z.object({ mcpServers: Servers.optional() });
const ClaudeJson = z.object({
  mcpServers: Servers.optional(),
  projects: z.record(z.object({ mcpServers: Servers.optional() }).passthrough()).optional(),
});

type ServerConfig = z.infer<typeof Servers>[string];

interface Found {
  info: McpServerInfo;
  config: ServerConfig;
}

async function readJson(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  return raw === null ? null : tryJson(raw.replace(/^﻿/, ''));
}

async function collect(projectPath: string, claudeConfigFile: string): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  const add = (source: McpServerInfo['source'], servers: Record<string, ServerConfig> | undefined) => {
    for (const [name, config] of Object.entries(servers ?? {})) {
      // A origem mais específica vence: local > projeto > usuário.
      found.set(name, { info: { name, source, transport: config.type ?? (config.url ? 'http' : config.command ? 'stdio' : null) }, config });
    }
  };

  const user = ClaudeJson.safeParse(await readJson(claudeConfigFile));
  const project = McpJson.safeParse(await readJson(path.join(projectPath, '.mcp.json')));
  if (user.success) add('user', user.data.mcpServers);
  if (project.success) add('project', project.data.mcpServers);
  if (user.success) {
    const key = pathKey(projectPath);
    for (const [p, entry] of Object.entries(user.data.projects ?? {})) {
      if (pathKey(p) === key) add('local', entry.mcpServers);
    }
  }
  return found;
}

export async function listMcpServers(projectPath: string, claudeConfigFile: string): Promise<McpServerInfo[]> {
  return [...(await collect(projectPath, claudeConfigFile)).values()]
    .map((f) => f.info)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface McpSecret {
  server: string;
  /** Tipo, em português ("uma chave da API da Anthropic"); o valor nunca sai daqui. */
  label: string;
}

/** Nomes de variável ou cabeçalho que guardam segredo. */
const SECRET_NAME = /(?:^|[_-])(?:api[_-]?key|key|token|secret|password|passwd|pat)$|^authorization$/i;

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
    if (typeof value !== 'string' || value.includes('${')) continue;
    const hit = findSecret(value) ?? (name ? findSecret(`${name}=${value}`) : null);
    if (hit) return hit.label;
    if (name && SECRET_NAME.test(name) && value.trim().length >= 8) return 'uma chave';
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

/** Configuração para `--mcp-config` só com os servidores escolhidos na ficha. */
export async function buildMcpConfig(
  projectPath: string,
  names: string[],
  claudeConfigFile: string,
): Promise<{ mcpServers: Record<string, ServerConfig> }> {
  const found = await collect(projectPath, claudeConfigFile);
  const mcpServers: Record<string, ServerConfig> = {};
  for (const name of names) {
    const f = found.get(name);
    if (f) mcpServers[name] = f.config;
  }
  return { mcpServers };
}
