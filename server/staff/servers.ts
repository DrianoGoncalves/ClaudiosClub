import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ProjectConnection, ServerInfo } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { StaffError, writeAtomic } from './store';

// Conexões SSH de cada projeto, cadastradas no Claudio’s Club: `<projeto>/.vps/config.json` (o formato da
// skill vps; a pasta fica fora do git com um `.gitignore` "*"). Na ficha, o funcionário só ganha o
// nome das conexões que pode usar; quem conecta é o `ssh` com o `.vps/ssh_config` que o Claudio’s Club gera
// daqui. O Claudio’s Club nunca lê o conteúdo da chave, só confere que o arquivo existe.
//
// O ssh_config é gerado a partir do que você digitou: cada campo passa por uma validação estrita
// (sem espaço, aspas nem quebra de linha), senão um "host" com quebra de linha viraria um
// `ProxyCommand` rodando qualquer comando nesta máquina.

const NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}$/;
const USER = /^[A-Za-z_][\w.-]{0,31}$/;
const REMOTE_DIR = /^\/[\w.@+/-]{0,300}$/;
// `%` é expandido pelo ssh (%h, %u…), aspas fechariam o valor e controle quebra a linha.
const BAD_PATH_CHARS = /[\u0000-\u001f"%]/;

export const ConnectionInput = z.object({
  name: z.string().trim().regex(NAME, 'nome: letras, números, ponto, hífen ou _ (até 40), começando por letra ou número'),
  host: z
    .string()
    .trim()
    .refine((v) => HOSTNAME.test(v) || IPV6.test(v), 'host inválido: use o domínio ou o IP do servidor'),
  port: z.number().int('porta inválida').min(1, 'porta inválida').max(65535, 'porta inválida').default(22),
  user: z.string().trim().regex(USER, 'usuário inválido'),
  identityFile: z
    .string()
    .trim()
    .min(1, 'informe o caminho da chave SSH')
    .max(400)
    .refine((v) => !BAD_PATH_CHARS.test(v), 'caminho da chave inválido (sem aspas, % ou quebra de linha)')
    .refine((v) => !/\.pub$/i.test(v), 'aponte a chave privada, não a .pub'),
  // Vazio = sem pasta (o funcionário pergunta ou procura).
  remoteRoot: z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && !v.trim()) ? null : v),
    z
      .string()
      .trim()
      .transform((v) => v.replace(/\/+$/, '') || '/')
      .refine((v) => REMOTE_DIR.test(v), 'pasta remota: caminho absoluto (/var/www/app), sem espaços nem aspas')
      .nullable(),
  ),
});

type Entry = Omit<ProjectConnection, 'complete' | 'keyFound'>;

const vpsDir = (projectPath: string) => path.join(projectPath, '.vps');
const configFile = (projectPath: string) => path.join(vpsDir(projectPath), 'config.json');
/** O ssh_config que os funcionários usam: `ssh -F "<este arquivo>" <conexão>`. */
export function sshConfigFile(projectPath: string): string {
  return path.join(vpsDir(projectPath), 'ssh_config');
}

/** `~/x` → caminho absoluto, com barras normais (o ssh do Windows aceita). */
export function expandKeyPath(p: string, home = os.homedir()): string {
  const abs = /^~[\\/]/.test(p) ? path.join(home, p.slice(2)) : path.resolve(p);
  return abs.replace(/\\/g, '/');
}

interface VpsFile {
  default?: string;
  connections?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
}

async function readFile(projectPath: string): Promise<VpsFile> {
  const raw = await fs.readFile(configFile(projectPath), 'utf8').catch(() => null);
  const data = tryJson((raw ?? '').replace(/^﻿/, ''));
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as VpsFile) : {};
}

/** Uma entrada do arquivo, validada; null = nome ou host que não dá para usar. */
function parseEntry(name: string, c: Record<string, unknown>): Entry | null {
  const port = Number(c.port ?? 22);
  const full = ConnectionInput.safeParse({ ...c, name, port });
  if (full.success) return full.data;
  // Escrita à mão (ou pela skill vps com um apelido do ~/.ssh/config): aparece para completar.
  const partial = ConnectionInput.pick({ name: true, host: true, port: true }).safeParse({ name, host: c.host, port });
  const root = ConnectionInput.shape.remoteRoot.safeParse(c.remoteRoot);
  return partial.success ? { ...partial.data, user: null, identityFile: null, remoteRoot: root.success ? root.data : null } : null;
}

/** As conexões do projeto, para a tela de cadastro (com caminho da chave, sem o conteúdo). */
export async function readConnections(projectPath: string): Promise<ProjectConnection[]> {
  const file = await readFile(projectPath);
  const out: ProjectConnection[] = [];
  for (const [name, c] of Object.entries(file.connections ?? {})) {
    const e = c && typeof c === 'object' ? parseEntry(name, c) : null;
    if (!e) continue;
    const keyFound = e.identityFile ? await isFile(expandKeyPath(e.identityFile)) : false;
    out.push({ ...e, complete: !!(e.user && e.identityFile), keyFound });
  }
  return out;
}

/** O que vai para a ficha: só as completas, sem usuário nem chave. */
export async function listServers(projectPath: string): Promise<ServerInfo[]> {
  return (await readConnections(projectPath)).filter((c) => c.complete).map((c) => ({ name: c.name, source: 'vps', host: c.host, remoteRoot: c.remoteRoot }));
}

/** Os arquivos de chave das conexões `names` (para bloquear a leitura deles na sessão). */
export async function keyFilesOf(projectPath: string, names: string[]): Promise<string[]> {
  const conns = await readConnections(projectPath);
  return conns.filter((c) => c.identityFile && names.includes(c.name)).map((c) => expandKeyPath(c.identityFile!));
}

/** Cria ou troca uma conexão (`originalName`: a que está sendo editada, para renomear). */
export async function saveConnection(projectPath: string, body: unknown, originalName?: string): Promise<ProjectConnection> {
  const parsed = ConnectionInput.safeParse(body);
  if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'conexão inválida');
  const c = parsed.data;
  if (!(await isFile(expandKeyPath(c.identityFile)))) throw new StaffError('chave não encontrada nesse caminho');
  const file = await readFile(projectPath);
  const conns = { ...(file.connections ?? {}) };
  if (c.name !== originalName && conns[c.name]) throw new StaffError(`já existe uma conexão ${c.name}`);
  // Campos que a skill vps usa e o Claudio’s Club não edita (localSubfolder…) ficam.
  const prev = (originalName && conns[originalName]) || conns[c.name] || {};
  if (originalName) delete conns[originalName];
  conns[c.name] = { ...prev, host: c.host, port: c.port, user: c.user, identityFile: c.identityFile, remoteRoot: c.remoteRoot };
  const def = !file.default || file.default === originalName ? c.name : file.default;
  await writeVps(projectPath, { ...file, default: def, connections: conns });
  return (await readConnections(projectPath)).find((x) => x.name === c.name)!;
}

export async function removeConnection(projectPath: string, name: string): Promise<boolean> {
  const file = await readFile(projectPath);
  if (!file.connections?.[name]) return false;
  const conns = { ...file.connections };
  delete conns[name];
  const next: VpsFile = { ...file, connections: conns };
  if (file.default === name) {
    const first = Object.keys(conns)[0];
    if (first) next.default = first;
    else delete next.default;
  }
  await writeVps(projectPath, next);
  return true;
}

async function writeVps(projectPath: string, file: VpsFile): Promise<void> {
  await ensureVpsGitignore(projectPath);
  await writeAtomic(configFile(projectPath), JSON.stringify(file, null, 2) + '\n');
  await writeSshConfig(projectPath);
}

/** `.vps/` fora do git, como a skill vps deixa. */
async function ensureVpsGitignore(projectPath: string): Promise<void> {
  const file = path.join(vpsDir(projectPath), '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current !== null && /^\*\s*$/m.test(current)) return;
  await fs.mkdir(vpsDir(projectPath), { recursive: true });
  await fs.writeFile(file, '*\n', 'utf8');
}

/**
 * O ssh_config das conexões completas. Sem repasse do agente nem de portas (túneis), sem pedir
 * senha (BatchMode), só a chave indicada, e a identidade do servidor guardada na primeira conexão:
 * se ela mudar depois, o ssh recusa.
 */
export function renderSshConfig(conns: ProjectConnection[]): string {
  const blocks = conns
    .filter((c) => c.complete)
    .map((c) =>
      [
        `Host ${c.name}`,
        `  HostName ${c.host}`,
        `  Port ${c.port}`,
        `  User ${c.user}`,
        `  IdentityFile "${expandKeyPath(c.identityFile!)}"`,
        '  IdentitiesOnly yes',
        '  BatchMode yes',
        '  ForwardAgent no',
        '  ClearAllForwardings yes',
        '  StrictHostKeyChecking accept-new',
        '  ConnectTimeout 10',
      ].join('\n'),
    );
  return ['# Gerado pelo Claudio’s Club a partir de config.json (refeito a cada mudança): não edite.', ...blocks].join('\n\n') + '\n';
}

/** Regrava o ssh_config; devolve o caminho, ou null sem conexão completa (e apaga o antigo). */
export async function writeSshConfig(projectPath: string): Promise<string | null> {
  const conns = await readConnections(projectPath);
  const file = sshConfigFile(projectPath);
  if (!conns.some((c) => c.complete)) {
    await fs.rm(file, { force: true });
    return null;
  }
  await ensureVpsGitignore(projectPath);
  await writeAtomic(file, renderSshConfig(conns));
  return file;
}

type Run = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }>;

const runSsh: Run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout: 25_000 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, stdout, stderr, missing: e?.code === 'ENOENT' });
    }),
  );

/** Conecta e roda um `echo` no servidor; devolve se deu certo e, se não, o porquê em palavras. */
export async function testConnection(projectPath: string, name: string, run: Run = runSsh): Promise<{ ok: boolean; message: string }> {
  const conn = (await readConnections(projectPath)).find((c) => c.name === name);
  if (!conn) throw new StaffError('conexão não encontrada');
  if (!conn.complete) throw new StaffError('complete a conexão (usuário e chave) antes de testar');
  if (!conn.keyFound) return { ok: false, message: 'a chave não foi encontrada nesse caminho' };
  const config = await writeSshConfig(projectPath);
  const r = await run('ssh', ['-F', config!, name, 'echo myco-ok']);
  if (r.missing) return { ok: false, message: 'o ssh não está instalado nesta máquina (no Windows: recurso opcional "Cliente OpenSSH")' };
  if (r.code === 0 && r.stdout.includes('myco-ok')) return { ok: true, message: `conectou em ${conn.user}@${conn.host}` };
  return { ok: false, message: explainSshError(r.stderr, conn.port) };
}

/** A saída de erro do ssh, em palavras. */
export function explainSshError(stderr: string, port = 22): string {
  const s = stderr;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) {
    return 'a identidade do servidor mudou desde a última conexão: confirme com quem cuida dele antes de seguir (pode ser um ataque)';
  }
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s)) return 'o arquivo da chave está aberto demais: só o seu usuário pode ter acesso a ele';
  if (/invalid format|error in libcrypto|not a private key/i.test(s)) return 'o arquivo não é uma chave privada válida';
  if (/passphrase/i.test(s)) return 'a chave tem senha: carregue-a no ssh-agent (ssh-add) para o Claudio’s Club usar sem pedir';
  if (/Permission denied/i.test(s)) return 'o servidor recusou a chave: confira o usuário e se a chave pública está no authorized_keys';
  if (/Could not resolve hostname|Name or service not known|No such host/i.test(s)) return 'host não encontrado: confira o endereço';
  if (/Connection refused/i.test(s)) return `conexão recusada na porta ${port}`;
  if (/timed out|Connection timeout/i.test(s)) return `o servidor não respondeu na porta ${port}`;
  const last = s.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return last ? `a conexão falhou: ${last.slice(0, 200)}` : 'a conexão falhou';
}

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);
