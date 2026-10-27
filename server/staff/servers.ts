import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerInfo } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';

// Servidores que um funcionário de infra pode acessar. Só nomes e destinos: o MyCo nunca lê
// chaves, senhas nem o caminho delas. A autenticação fica no ssh-agent / ~/.ssh/config, fora da IA.
//   - `Host` do ~/.ssh/config (vale para todos os projetos)
//   - conexões do .vps/config.json do projeto (a skill `vps`)

export async function listServers(projectPath: string, sshConfig = path.join(os.homedir(), '.ssh', 'config')): Promise<ServerInfo[]> {
  const [ssh, vps] = await Promise.all([readSshHosts(sshConfig), readVpsConnections(projectPath)]);
  const out = new Map<string, ServerInfo>();
  for (const s of [...vps, ...ssh]) if (!out.has(s.name)) out.set(s.name, s);
  return [...out.values()];
}

/** Apelidos `Host` do ~/.ssh/config, sem curingas. Lê só as linhas `Host`. */
export async function readSshHosts(file: string): Promise<ServerInfo[]> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const out: ServerInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    for (const name of m[1]!.split(/\s+/)) {
      // Curingas não são servidores; hosts de git (github.com…) também não.
      if (/[*?!]/.test(name) || GIT_HOSTS.test(name)) continue;
      out.push({ name, source: 'ssh-config', host: name, remoteRoot: null });
    }
  }
  return out;
}

const SAFE_NAME = /^[\w.-]{1,60}$/;
const GIT_HOSTS = /^(github\.com|gitlab\.com|bitbucket\.org|ssh\.dev\.azure\.com)$/i;

/** Conexões da skill `vps` (só nome, host e pasta remota; usuário, porta e chave ficam de fora). */
export async function readVpsConnections(projectPath: string): Promise<ServerInfo[]> {
  const raw = await fs.readFile(path.join(projectPath, '.vps', 'config.json'), 'utf8').catch(() => null);
  const parsed = tryJson((raw ?? '').replace(/^﻿/, '')) as { connections?: Record<string, { host?: unknown; remoteRoot?: unknown }> } | null;
  const out: ServerInfo[] = [];
  for (const [name, c] of Object.entries(parsed?.connections ?? {})) {
    if (!SAFE_NAME.test(name) || typeof c?.host !== 'string') continue;
    out.push({ name, source: 'vps', host: c.host, remoteRoot: typeof c.remoteRoot === 'string' ? c.remoteRoot : null });
  }
  return out;
}
