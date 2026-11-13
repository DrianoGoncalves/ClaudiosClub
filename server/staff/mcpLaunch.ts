import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { tryJson } from '../adapters/claude/fsutil';
import { ROOT } from '../root';
import { DEFAULT_SECRETS_DIR, type VaultOptions } from '../secretVault';
import { CLUB_MCP_FILE, readClub, resolveClub } from './mcp';

// Lançador dos MCPs da biblioteca do Claudio’s Club (entrada: server/mcp-launch.ts). O mcp.json da sessão leva só este
// comando e o nome do servidor: os valores (env e cabeçalhos) saem do cofre aqui, na hora de subir, e não passam pelo
// arquivo que o agente lê. Comando, argumentos e nomes de env/cabeçalho vêm da biblioteca lida agora, nunca da linha de comando.
//   stdio (padrão): sobe o comando com o ambiente do cofre e repassa sinais e código de saída.
//   --headers: imprime no stdout os cabeçalhos do cofre em JSON (é o `headersHelper` do Claude Code, para http e sse).
// Mesmo padrão do MCP de FTP (ftpMcp.ts).
// Modo --snapshot (o Codex): o MCP não é da biblioteca, é da ficha (projeto ou usuário), e os valores já estão expandidos num arquivo
// JSON da pasta da conversa (`--snapshot <arquivo> --server <nome>`), que a sandbox do Codex nega ao agente. Ver codexMcpServers (mcp.ts).

export const MCP_LAUNCH_BUNDLE = path.join(ROOT, 'dist', 'mcp-launch.mjs');
export const MCP_LAUNCH_ENTRY = path.join(ROOT, 'server', 'mcp-launch.ts');

/** O mesmo critério de nome da biblioteca (NAME em mcpLibrary.ts). */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export class McpLaunchError extends Error {}

export type LaunchSpec = { command: string; args: string[]; env: Record<string, string> } | { headers: Record<string, string> };

/**
 * O que subir para o MCP `name` da biblioteca, com os valores do cofre: stdio → comando, argumentos e ambiente; http/sse →
 * cabeçalhos. Lança erro (sem valor na mensagem) se o nome é inválido, se não está na biblioteca ou se falta um valor no cofre.
 */
export async function launchSpec(name: string, o: { clubFile?: string; vault?: VaultOptions } = {}): Promise<LaunchSpec> {
  if (!NAME.test(name)) throw new McpLaunchError('nome de MCP inválido');
  const lib = await readClub(o.clubFile ?? CLUB_MCP_FILE);
  // hasOwn: `__proto__` e afins passam pelo regex mas não são servidores.
  if (!lib || !Object.prototype.hasOwnProperty.call(lib.servers, name)) throw new McpLaunchError(`o MCP ${name} não está na biblioteca do Claudio’s Club`);
  const entry = lib.servers[name]!;
  const r = await resolveClub(name, {}, { env: entry.env ?? [], headers: entry.headers ?? [] }, o.vault);
  if ('missing' in r) throw new McpLaunchError(`MCP ${name}: não achei o valor de ${r.missing} no cofre (cadastre de novo na biblioteca)`);
  const { env, headers } = r.config as { env?: Record<string, string>; headers?: Record<string, string> };
  if (entry.type === 'stdio') {
    if (!entry.command) throw new McpLaunchError(`MCP ${name}: a biblioteca não tem o comando`);
    return { command: entry.command, args: entry.args ?? [], env: env ?? {} };
  }
  return { headers: headers ?? {} };
}

/**
 * O arquivo de lançamento de uma conversa do Codex (`codex-mcp.json`, ver codexMcpServers): os MCPs da ficha que não são da biblioteca,
 * já com as variáveis expandidas. Só stdio (comando, argumentos e ambiente) e http com cabeçalhos. Chave que não bate com o schema = arquivo estragado.
 */
const SnapshotDoc = z.object({
  servers: z.record(
    z.string(),
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('stdio'), command: z.string(), args: z.array(z.string()), env: z.record(z.string(), z.string()) }),
      z.object({ type: z.literal('http'), headers: z.record(z.string(), z.string()) }),
    ]),
  ),
});

/**
 * O que subir para o MCP `name` a partir do arquivo de lançamento da conversa (`--snapshot`). Mesmas regras de `launchSpec`: nome
 * validado, `hasOwn` (nada de `__proto__`) e erro sem valor na mensagem.
 */
export async function snapshotSpec(name: string, file: string): Promise<LaunchSpec> {
  if (!NAME.test(name)) throw new McpLaunchError('nome de MCP inválido');
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  const doc = raw === null ? null : SnapshotDoc.safeParse(tryJson(raw.replace(/^﻿/, '')));
  if (!doc?.success || !Object.prototype.hasOwnProperty.call(doc.data.servers, name)) {
    throw new McpLaunchError(`o MCP ${name} não está nesta conversa (o arquivo de lançamento falta ou está estragado)`);
  }
  const s = doc.data.servers[name]!;
  if (s.type === 'stdio') return { command: s.command, args: s.args, env: s.env };
  return { headers: s.headers };
}

/** O lançador do Codex: só o pacote do build (`dist/mcp-launch.mjs`), com node. Nunca o .ts pelo tsx: o Codex não sobe código do repo. Null = não existe. */
export function mcpLaunchBundle(): { command: string; args: string[] } | null {
  return existsSync(MCP_LAUNCH_BUNDLE) ? { command: process.execPath, args: [MCP_LAUNCH_BUNDLE] } : null;
}

/**
 * Uma linha de comando citada para `headersHelper` (aspas duplas em cada parte, separadas por espaço). null se alguma parte não pode ir
 * citada com segurança: aspas, `%`, `$`, crase ou caractere de controle (o Claude Code e o Codex passam a linha por um shell).
 */
export function quotedCommand(parts: string[]): string | null {
  if (parts.some((p) => /["%$`\u0000-\u001f\u007f]/.test(p))) return null;
  return parts.map((p) => `"${p}"`).join(' ');
}

export interface LaunchArgs {
  headers: boolean;
  server?: string;
  club: string;
  vault: string;
  /** Arquivo de lançamento da conversa (modo do Codex): quando vem, substitui a biblioteca. */
  snapshot?: string;
}

/** Lê `--server`, `--club`, `--vault`, `--snapshot` e `--headers`. Não há flag de comando: o comando vem sempre da biblioteca ou do arquivo. */
export function parseLaunchArgs(argv: string[]): LaunchArgs {
  return {
    headers: argv.includes('--headers'),
    server: argOf(argv, '--server'),
    club: argOf(argv, '--club') ?? CLUB_MCP_FILE,
    vault: argOf(argv, '--vault') ?? DEFAULT_SECRETS_DIR,
    snapshot: argOf(argv, '--snapshot'),
  };
}

function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Sobe o comando com o ambiente e espera. Sem shell. No Windows, se o programa não é um .exe (ex.: `npx`, que é .cmd),
 * tenta uma vez pelo cmd.exe. Devolve o código de saída do filho (1 se morreu por sinal ou não subiu).
 */
export function runChild(name: string, command: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    let retried = false;
    const start = (cmd: string, argv: string[]) => {
      let started = false;
      const child = spawn(cmd, argv, { stdio: 'inherit', env: { ...process.env, ...env }, windowsHide: true });
      const onInt = () => child.kill('SIGINT');
      const onTerm = () => child.kill('SIGTERM');
      const detach = () => {
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
      };
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      child.once('spawn', () => {
        started = true;
      });
      child.once('error', (err) => {
        detach();
        const code = (err as NodeJS.ErrnoException).code;
        if (!started && !retried && process.platform === 'win32' && (code === 'ENOENT' || code === 'EINVAL')) {
          retried = true;
          start(process.env.ComSpec || 'cmd.exe', ['/d', '/c', command, ...args]);
          return;
        }
        process.stderr.write(`[myco-mcp] não consegui iniciar o MCP ${name}: ${code ?? 'erro'}\n`);
        resolve(1);
      });
      child.once('exit', (code, signal) => {
        detach();
        resolve(signal ? 1 : (code ?? 1));
      });
    };
    start(command, args);
  });
}

/** Entrada da linha de comando (server/mcp-launch.ts). Devolve o código de saída; mensagens só no stderr, sem valor. */
export async function runMcpLaunchCli(argv: string[]): Promise<number> {
  const fail = (msg: string) => {
    process.stderr.write(`[myco-mcp] ${msg}\n`);
    return 1;
  };
  const a = parseLaunchArgs(argv);
  if (!a.server) return fail('uso: --server <nome> --club <mcps.json> --vault <pasta> [--headers] ou --snapshot <arquivo> --server <nome> [--headers]');
  try {
    const spec = a.snapshot ? await snapshotSpec(a.server, a.snapshot) : await launchSpec(a.server, { clubFile: a.club, vault: { dir: a.vault } });
    if (a.headers) {
      if (!('headers' in spec)) return fail(`MCP ${a.server}: não é http nem sse`);
      process.stdout.write(JSON.stringify(spec.headers));
      return 0;
    }
    if (!('command' in spec)) return fail(`MCP ${a.server}: não é stdio`);
    return await runChild(a.server, spec.command, spec.args, spec.env);
  } catch (err) {
    // As mensagens de McpError e McpLaunchError não trazem valor.
    return fail(err instanceof Error ? err.message : 'erro');
  }
}

/** node + o que rodar: o pacote quando o servidor roda empacotado e ele existe; senão o .ts com o tsx (como ftpMcpCommand). */
export function mcpLaunchCommand(bundled = !import.meta.url.endsWith('.ts')): { command: string; args: string[] } {
  if (bundled && existsSync(MCP_LAUNCH_BUNDLE)) return { command: process.execPath, args: [MCP_LAUNCH_BUNDLE] };
  const tsx = pathToFileURL(path.join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return { command: process.execPath, args: ['--import', tsx, MCP_LAUNCH_ENTRY] };
}
