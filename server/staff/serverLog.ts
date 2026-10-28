import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ServerAccess } from '../../shared/model';

// Registro de acesso aos servidores: cada comando de acesso remoto (ssh, scp, sftp, rsync, a skill
// vps) que um funcionário rodou, tirado dos transcripts dele. Não depende de hook nem de o
// funcionário lembrar de anotar: o que passou pelo Bash ou pelo PowerShell está no transcript.

const REMOTE = /(^|[\s;&|(`'"])(ssh|scp|sftp|rsync)(\.exe)?\s|\bvps\.ps1\b/i;
const MAX_COMMAND = 300;

interface Parsed {
  mtimeMs: number;
  size: number;
  entries: ServerAccess[];
}
const cache = new Map<string, Parsed>();

/** Os acessos de uma lista de transcripts, do mais recente para o mais antigo. */
export async function readServerLog(files: string[], connections: string[], limit = 100): Promise<ServerAccess[]> {
  const all: ServerAccess[] = [];
  for (const file of files) {
    const st = await fs.stat(file).catch(() => null);
    if (!st) continue;
    const hit = cache.get(file);
    const entries = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit.entries : await parse(file);
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries });
    all.push(...entries);
  }
  return all
    .map((e) => ({ ...e, connection: e.connection ?? guessConnection(e.command, connections) }))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

async function parse(file: string): Promise<ServerAccess[]> {
  const byTool = new Map<string, ServerAccess>();
  const out: ServerAccess[] = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    // Só as linhas que podem interessar: comando com cara de acesso remoto ou o resultado de um.
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let j: { type?: string; timestamp?: string; sessionId?: string; message?: { content?: unknown } };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(j.message?.content) ? (j.message!.content as Array<Record<string, unknown>>) : [];
    for (const b of content) {
      if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) {
        const command = String((b.input as { command?: unknown } | undefined)?.command ?? '');
        if (!REMOTE.test(command)) continue;
        const entry: ServerAccess = {
          at: j.timestamp ?? '',
          sessionId: j.sessionId ?? '',
          connection: connectionOf(command),
          command: command.replace(/\s+/g, ' ').trim().slice(0, MAX_COMMAND),
          ok: null,
        };
        byTool.set(String(b.id), entry);
        out.push(entry);
      } else if (b.type === 'tool_result') {
        const entry = byTool.get(String(b.tool_use_id));
        if (entry) entry.ok = b.is_error !== true;
      }
    }
  }
  return out;
}

/** Opções do ssh/scp que levam um valor depois (o valor não é o destino). */
const WITH_VALUE = new Set(['-F', '-i', '-o', '-p', '-P', '-l', '-J', '-L', '-R', '-D', '-E', '-c', '-m', '-O', '-S', '-W', '-b', '-e', '-Q', '-w', '-B', '-I']);

/**
 * O destino do primeiro ssh/scp/sftp/rsync do comando, lido dos argumentos dele (o comando pode ter
 * outros antes e depois): `ssh -F "<arquivo>" producao "..."` → producao; `scp x deploy@vps:/tmp` → vps.
 */
function connectionOf(command: string): string | null {
  const start = /(^|[\s;&|(])(ssh|scp|sftp|rsync)(?:\.exe)?\s/i.exec(command);
  if (!start) return null;
  const tool = start[2]!.toLowerCase();
  // Só até o fim desse comando (o próximo ; | & ou quebra de linha fora de aspas).
  const rest = command.slice(start.index + start[0].length);
  const tokens: string[] = [];
  for (const m of rest.matchAll(/"([^"]*)"|'([^']*)'|([;&|\n])|(\S+)/g)) {
    if (m[3]) break;
    tokens.push(m[1] ?? m[2] ?? m[4] ?? '');
  }
  const host = (t: string) => t.replace(/^[^@]*@/, '').replace(/:.*$/, '');
  // Variável ($host, @opts do PowerShell) não dá para saber: fica sem conexão. "C:" é unidade.
  const valid = (h: string) => /^[A-Za-z0-9][\w.-]{0,62}$/.test(h) && !/^[a-z]$/i.test(h);
  const literal = (t: string) => !t.includes('$') && !t.startsWith('@');
  if (tool !== 'ssh') {
    // Cópia: o servidor é o lado `conexão:caminho`.
    const remote = tokens.find((t) => literal(t) && /^[^\\/]*:/.test(t) && valid(host(t)));
    return remote ? host(remote) : null;
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (WITH_VALUE.has(t)) i++;
    else if (!t.startsWith('-')) return literal(t) && valid(host(t)) ? host(t) : null;
  }
  return null;
}

/** Sem `-F` (um apelido do ~/.ssh/config, a skill vps): a conexão da ficha citada no comando. */
function guessConnection(command: string, connections: string[]): string | null {
  return connections.find((c) => new RegExp(`(^|[\\s@:"'])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s:"']|$)`).test(command)) ?? null;
}
