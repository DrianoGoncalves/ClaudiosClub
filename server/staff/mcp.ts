import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServerInfo } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';

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
