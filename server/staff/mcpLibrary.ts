import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpScope, McpServerView, McpType } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { deleteSecret, hasSecret, moveSecret, setSecret, VaultError, type VaultOptions } from '../secretVault';
import { CLUB_MCP_FILE, clubSecretId, isLiteralSecret, McpError, readClub, resolveClub, type ClubEntry } from './mcp';
import { testMcpConfig, type McpTestResult } from './mcpTest';
import { writeAtomic } from './store';

// Biblioteca de MCPs: cadastro e edição nos quatro escopos, inclusive os que já existem fora do Claudio’s Club.
//   club    -> ~/.myco/mcps.json (sem segredo) + valores no cofre (secretVault), por `mcp:club:<nome>:…`
//   user    -> ~/.claude.json, mcpServers
//   local   -> ~/.claude.json, projects[<projeto>].mcpServers
//   project -> <projeto>/.mcp.json (vai para o git: segredo literal é recusado; use ${VARIAVEL})
// Os valores de ~/.claude.json e do .mcp.json ficam no próprio arquivo (é lá que o Claude Code os lê).
// A tela nunca recebe valor de env/cabeçalho: só o nome e se está preenchido. Argumentos e URL com segredo
// saem mascarados (`••••`). Quem manda de volta um campo mascarado mantém o valor atual.

/** O marcador que substitui um segredo na lista (argumento ou pedaço da URL). */
export const MASK = '••••';
const KEEP_BACKUPS = 10;
const SCOPE_ORDER: McpScope[] = ['club', 'user', 'project', 'local'];
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const PROJECT_ID = /^[A-Za-z0-9-]{1,80}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const notReserved = (s: string) => !RESERVED.has(s);

const Name = z.string().regex(NAME, 'nome: letras, números, _ . - (até 64)').refine(notReserved, 'nome reservado');
const Value = z
  .string()
  .min(1, 'valor vazio: para apagar, use remover')
  .max(4096, 'valor grande demais (até 4096)')
  .refine((v) => !/[\r\n\0]/.test(v), 'valor com quebra de linha');
const EnvKey = z.string().regex(ENV_KEY, 'nome de variável inválido (letras, números e _)').refine(notReserved, 'nome reservado');
const HeaderKey = z.string().regex(HEADER_KEY, 'nome de cabeçalho inválido (letras, números e -)').refine(notReserved, 'nome reservado');
const Scope = z.enum(['club', 'user', 'project', 'local'], { errorMap: () => ({ message: 'escopo: club, user, project ou local' }) });
const ProjectId = z.string().regex(PROJECT_ID, 'projeto inválido').optional();

const SaveInput = z.object({
  scope: Scope,
  projectId: ProjectId,
  /** O nome atual, para editar (e renomear); ausente = MCP novo. */
  originalName: Name.optional(),
  name: Name,
  type: z.enum(['http', 'sse', 'stdio'], { errorMap: () => ({ message: 'tipo: http, sse ou stdio' }) }),
  url: z.string().trim().max(2048, 'URL grande demais').optional(),
  command: z.string().trim().max(500, 'comando grande demais').optional(),
  args: z.array(z.string().max(2000)).max(100, 'argumentos demais (até 100)').optional(),
  /** null = manter o valor atual; string = trocar. */
  env: z.record(EnvKey, Value.nullable()).default({}),
  headers: z.record(HeaderKey, Value.nullable()).default({}),
  removeKeys: z.object({ env: z.array(EnvKey).max(100).optional(), headers: z.array(HeaderKey).max(100).optional() }).optional(),
});
type SaveBody = z.infer<typeof SaveInput>;
const RefInput = z.object({ scope: Scope, projectId: ProjectId, name: Name });

export interface McpLibraryOptions {
  /** ~/.claude.json (ou o de teste). */
  claudeConfigFile: string;
  /** ~/.myco/mcps.json (padrão). */
  clubFile?: string;
  /** Pasta dos backups do ~/.claude.json (padrão ~/.myco/backups). */
  backupDir: string;
  /** O adapter resolve o projectId para a pasta; nunca vem caminho do cliente. null = não existe. */
  resolveProject: (projectId: string) => Promise<string | null>;
  /** Cofre (padrão: o do sistema, DPAPI no Windows). */
  vault?: VaultOptions;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const strRecord = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

function parseInput<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new McpError(r.error.issues[0]?.message ?? 'dados inválidos');
  return r.data;
}

const requireBrowser = (fromBrowser: boolean) => {
  if (!fromBrowser) throw new McpError('a biblioteca de MCP só é alterada pelo Claudio’s Club');
};

// ---- máscara ----

/** `https://usuario:SENHA@host`: a senha fica na parte antes do @. */
const AUTH_SECRET = /^([a-z][\w+.-]*:\/\/[^/@?#\s]*?):([^/@?#\s]+)@/i;

/** Senha na URL vira `••••`, e segredo na query vira `…?••••`. Devolve a URL e se mascarou. */
export function maskUrl(raw: string): { url: string; masked: boolean } {
  let url = raw;
  let masked = false;
  const auth = AUTH_SECRET.exec(url);
  if (auth) {
    url = `${auth[1]}:${MASK}@${url.slice(auth[0].length)}`;
    masked = true;
  }
  const q = url.indexOf('?');
  if (q >= 0) {
    const params = new URLSearchParams(url.slice(q + 1).split('#')[0] ?? '');
    if ([...params].some(([k, v]) => isLiteralSecret(k, v))) {
      url = `${url.slice(0, q)}?${MASK}`;
      masked = true;
    }
  }
  return { url, masked };
}

/** Argumento com segredo (valor solto depois de um flag, ou `--flag=valor`) vira `••••`. */
export function maskArgs(args: string[]): { args: string[]; masked: boolean } {
  let masked = false;
  const out = args.map((a, i) => {
    const eq = /^(--?[A-Za-z][\w-]*)=([\s\S]*)$/.exec(a);
    const prev = args[i - 1] ?? '';
    const flag = eq ? eq[1]! : prev.startsWith('-') ? prev : '';
    if (!isLiteralSecret(flag.replace(/^-+/, ''), eq ? eq[2] : a)) return a;
    masked = true;
    return eq ? `${eq[1]}=${MASK}` : MASK;
  });
  return { args: out, masked };
}

// ---- como o que foi mandado de volta vira o valor a gravar ----

/** Campo mascarado na volta = manter o atual. */
function keepCommand(sent: string, current: string | undefined): string {
  if (!sent.includes(MASK)) return sent;
  if (current === undefined) throw new McpError('o comando veio mascarado e não há o atual: informe o comando');
  return current;
}

function keepArgs(sent: string[] | undefined, current: string[] | undefined): string[] {
  if (sent === undefined) return current ?? [];
  if (!sent.includes(MASK)) return sent;
  if (current === undefined) throw new McpError('os argumentos vieram mascarados e não há os atuais: informe os argumentos');
  return current;
}

/** URL mascarada: a senha e a query voltam como estavam; o resto é o que veio. */
function keepUrl(sent: string, current: string | undefined): string {
  if (!sent.includes(MASK)) return sent;
  if (current === undefined) throw new McpError('a URL veio mascarada e não há a atual: informe a URL');
  let out = sent;
  if (out.includes(`:${MASK}@`)) {
    const pass = AUTH_SECRET.exec(current)?.[2];
    if (pass === undefined) throw new McpError('a URL veio mascarada e não há a senha atual: informe a URL');
    out = out.replace(`:${MASK}@`, () => `:${pass}@`);
  }
  const q = out.indexOf('?');
  if (q >= 0 && out.slice(q).includes(MASK)) {
    const cq = current.indexOf('?');
    if (cq < 0) throw new McpError('a URL veio mascarada e não há a query atual: informe a URL');
    out = out.slice(0, q) + current.slice(cq);
  }
  if (out.includes(MASK)) throw new McpError('a URL veio mascarada de um jeito que não dá para refazer: informe a URL');
  return out;
}

function validateUrl(url: string): void {
  // Com ${VARIAVEL} não dá para conferir: vale o esquema.
  if (url.includes('${')) {
    if (!/^https?:\/\//i.test(url)) throw new McpError('URL inválida (use http:// ou https://)');
    return;
  }
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new McpError('URL inválida (use http:// ou https://)');
}

/** Chaves: `current` (o que existe) + o que veio (null mantém, string troca) − o que sai. */
function mergeKeys(current: string[], sent: Record<string, string | null>, remove: string[]): { keys: string[]; set: Record<string, string> } {
  for (const k of remove) if (typeof sent[k] === 'string') throw new McpError(`${k}: ou troca o valor ou remove, não os dois`);
  const keys = current.filter((k) => !remove.includes(k));
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(sent)) {
    if (remove.includes(k)) continue;
    if (v === null) {
      if (!current.includes(k)) throw new McpError(`informe o valor de ${k}`);
      continue;
    }
    set[k] = v;
    if (!keys.includes(k)) keys.push(k);
  }
  return { keys, set };
}

/** Valores finais de um arquivo: o trocado, ou o que já estava. */
function valuesOf(m: { keys: string[]; set: Record<string, string> }, cur: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of m.keys) {
    const v = has(m.set, k) ? m.set[k] : cur[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Segredo literal onde não pode: no .mcp.json (vai para o git); na biblioteca, URL e argumentos (o cofre só guarda env e cabeçalho). */
function checkLiteral(input: SaveBody, where: 'club' | 'project'): void {
  const bad = (label: string, what: string): never => {
    throw new McpError(
      where === 'project'
        ? `${label} em ${what} de ${input.name}: o .mcp.json vai para o git. Troque por \${VARIAVEL} e ponha o valor no ambiente`
        : `${label} em ${what} de ${input.name}: a URL, os argumentos e o comando não vão para o cofre. Ponha o valor num cabeçalho ou numa variável de ambiente`,
    );
  };
  if (where === 'project') {
    for (const [k, v] of Object.entries(input.env)) {
      const label = v ? isLiteralSecret(k, v) : null;
      if (label) bad(label, `"${k}"`);
    }
    for (const [k, v] of Object.entries(input.headers)) {
      const label = v ? isLiteralSecret(k, v) : null;
      if (label) bad(label, `o cabeçalho "${k}"`);
    }
  }
  if (input.url && !input.url.includes(MASK) && maskUrl(input.url).masked) bad('um segredo', 'a URL');
  if (input.command && !input.command.includes(MASK) && maskArgs(input.command.split(' ')).masked) bad('um segredo', 'o comando');
  if (input.args && !input.args.includes(MASK) && maskArgs(input.args).masked) bad('um segredo', 'os argumentos');
}

function checkShape(input: SaveBody): void {
  if (input.type === 'stdio') {
    if (!input.command) throw new McpError('informe o comando (stdio)');
    if (input.url) throw new McpError('servidor stdio não tem URL');
    if (Object.keys(input.headers).length || input.removeKeys?.headers?.length) throw new McpError('cabeçalhos só valem para http e sse');
  } else {
    if (!input.url) throw new McpError('informe a URL');
    if (Object.keys(input.env).length || input.removeKeys?.env?.length) throw new McpError('variáveis de ambiente só valem para stdio');
  }
}

// ---- leitura para a tela ----

interface Row {
  name: string;
  scope: McpScope;
  projectId?: string;
  type: McpType;
  url?: string;
  command?: string;
  args?: string[];
  env: Array<{ key: string; set: boolean }>;
  headers: Array<{ key: string; set: boolean }>;
}

/** O que a tela recebe: sem valor, com segredo mascarado. */
export function toView(r: Row): McpServerView {
  const view: McpServerView = {
    name: r.name,
    scope: r.scope,
    type: r.type,
    env: r.type === 'stdio' ? r.env : [],
    headers: r.type === 'stdio' ? [] : r.headers,
  };
  if (r.projectId) view.projectId = r.projectId;
  if (r.url) view.url = maskUrl(r.url).url;
  if (r.command) {
    const c = maskArgs(r.command.split(' '));
    view.command = c.args.join(' ');
    if (c.masked) view.argsMasked = true;
  }
  if (r.type === 'stdio' && r.args?.length) {
    const m = maskArgs(r.args);
    view.args = m.args;
    if (m.masked) view.argsMasked = true;
  }
  return view;
}

const typeOf = (e: Obj): McpType | null => {
  const t = str(e.type) ?? (str(e.url) ? 'http' : str(e.command) ? 'stdio' : undefined);
  return t === 'http' || t === 'sse' || t === 'stdio' ? t : null;
};

/** Os escopos em arquivo: onde fica a lista de MCP de cada um. */
type FileScope = 'user' | 'local' | 'project';
function sectionOf(scope: FileScope, dir: string | null): (doc: Obj, create: boolean) => Obj | null {
  const under = (parent: Obj, key: string, create: boolean): Obj | null => {
    if (isObj(parent[key])) return parent[key] as Obj;
    if (!create) return null;
    const made: Obj = {};
    parent[key] = made;
    return made;
  };
  if (scope === 'local') {
    return (doc, create) => {
      const projects = under(doc, 'projects', create);
      if (!projects) return null;
      const key = Object.keys(projects).find((k) => pathKey(k) === pathKey(dir!)) ?? dir!;
      const entry = under(projects, key, create);
      return entry ? under(entry, 'mcpServers', create) : null;
    };
  }
  return (doc, create) => under(doc, 'mcpServers', create);
}

function fileOf(claudeConfigFile: string, scope: FileScope, dir: string | null): string {
  return scope === 'project' ? path.join(dir!, '.mcp.json') : claudeConfigFile;
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
}

function parseStrict(file: string, raw: string): Obj {
  const v = tryJson(raw.replace(/^﻿/, ''));
  if (!isObj(v)) throw new McpError(`${path.basename(file)} não é um JSON válido: não mexi nele (corrija o arquivo)`);
  return v;
}

async function readDoc(file: string): Promise<Obj | null> {
  const raw = await readText(file);
  if (raw === null) return null;
  const v = tryJson(raw.replace(/^﻿/, ''));
  return isObj(v) ? v : null;
}

/** Cópia do ~/.claude.json antes de gravar (só os 10 mais recentes). Tem tokens: fica 0600. */
async function backupClaude(dir: string, raw: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let name = `claude.json.${stamp}`;
  for (let n = 2; await exists(path.join(dir, name)); n++) name = `claude.json.${stamp}.${n}`;
  await fs.writeFile(path.join(dir, name), raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const all = (await fs.readdir(dir)).filter((f) => f.startsWith('claude.json.')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await fs.rm(path.join(dir, f), { force: true });
}

/**
 * Lê, muda e grava um arquivo de MCP. Relê o arquivo logo antes de gravar (o Claude Code grava o
 * ~/.claude.json o tempo todo): se mudou, refaz a mudança sobre o conteúdo novo. Grava atomicamente e
 * mantém a permissão do arquivo. Só mexe em mcpServers (ou projects[<caminho>].mcpServers).
 */
async function editFile(o: McpLibraryOptions, scope: FileScope, dir: string | null, change: (servers: Obj) => void): Promise<void> {
  const file = fileOf(o.claudeConfigFile, scope, dir);
  const section = sectionOf(scope, dir);
  for (let attempt = 1; ; attempt++) {
    const raw = await readText(file);
    const doc = raw === null ? {} : parseStrict(file, raw);
    change(section(doc, true)!);
    if ((await readText(file)) !== raw) {
      if (attempt >= 3) throw new McpError('o arquivo mudou enquanto eu gravava: tente de novo');
      continue;
    }
    const mode = raw !== null && process.platform !== 'win32' ? (await fs.stat(file)).mode & 0o777 : null;
    if (raw !== null && scope !== 'project') await backupClaude(o.backupDir, raw);
    await writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    if (mode !== null) await fs.chmod(file, mode);
    return;
  }
}

function fileEntry(input: SaveBody, old: Obj | null): Obj {
  const MANAGED = new Set(['type', 'url', 'command', 'args', 'env', 'headers']);
  // Campos que a tela não edita (oauth, timeout, o que vier) ficam como estavam.
  const extra = Object.fromEntries(Object.entries(old ?? {}).filter(([k]) => !MANAGED.has(k)));
  if (input.type === 'stdio') {
    const command = keepCommand(input.command ?? '', str(old?.command));
    const args = keepArgs(input.args, strs(old?.args));
    const cur = strRecord(old?.env);
    const env = valuesOf(mergeKeys(Object.keys(cur), input.env, input.removeKeys?.env ?? []), cur);
    return { ...extra, type: 'stdio', command, ...(args.length > 0 ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) };
  }
  const url = keepUrl(input.url ?? '', str(old?.url));
  validateUrl(url);
  const cur = strRecord(old?.headers);
  const headers = valuesOf(mergeKeys(Object.keys(cur), input.headers, input.removeKeys?.headers ?? []), cur);
  return { ...extra, type: input.type, url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
}

/** Os MCP de um arquivo, para a tela (sem valores). */
async function fileViews(file: string, section: (doc: Obj, create: boolean) => Obj | null, scope: McpScope, projectId?: string): Promise<McpServerView[]> {
  const doc = await readDoc(file);
  const servers = doc ? section(doc, false) : null;
  if (!servers) return [];
  const out: McpServerView[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!isObj(raw)) continue;
    const type = typeOf(raw);
    if (!type) continue;
    const keys = (rec: Record<string, string>) => Object.keys(rec).map((key) => ({ key, set: rec[key] !== '' }));
    out.push(
      toView({
        name,
        scope,
        projectId,
        type,
        url: str(raw.url),
        command: str(raw.command),
        args: strs(raw.args),
        env: keys(strRecord(raw.env)),
        headers: keys(strRecord(raw.headers)),
      }),
    );
  }
  return out;
}

// ---- a biblioteca ----

export function createMcpLibrary(o: McpLibraryOptions) {
  const clubFile = o.clubFile ?? CLUB_MCP_FILE;
  const vault = o.vault;

  async function projectDir(projectId: string | undefined): Promise<string> {
    if (!projectId) throw new McpError('escolha o projeto');
    const dir = await o.resolveProject(projectId);
    if (!dir) throw new McpError('projeto não encontrado');
    return dir;
  }

  async function clubViews(): Promise<McpServerView[]> {
    const cur = await readClub(clubFile).catch(() => null);
    if (!cur) return [];
    const out: McpServerView[] = [];
    for (const [name, e] of Object.entries(cur.servers)) {
      const env = await Promise.all((e.env ?? []).map(async (key) => ({ key, set: await hasSecret(clubSecretId(name, 'env', key), vault) })));
      const headers = await Promise.all((e.headers ?? []).map(async (key) => ({ key, set: await hasSecret(clubSecretId(name, 'header', key), vault) })));
      out.push(toView({ name, scope: 'club', type: e.type, url: e.url, command: e.command, args: e.args, env, headers }));
    }
    return out;
  }

  async function list(projectIdRaw: unknown): Promise<{ servers: McpServerView[] }> {
    const projectId = typeof projectIdRaw === 'string' && projectIdRaw ? projectIdRaw : undefined;
    if (projectId && !PROJECT_ID.test(projectId)) throw new McpError('projeto inválido');
    const servers: McpServerView[] = [...(await clubViews())];
    servers.push(...(await fileViews(o.claudeConfigFile, sectionOf('user', null), 'user')));
    if (projectId) {
      const dir = await projectDir(projectId);
      servers.push(...(await fileViews(path.join(dir, '.mcp.json'), sectionOf('project', dir), 'project', projectId)));
      servers.push(...(await fileViews(o.claudeConfigFile, sectionOf('local', dir), 'local', projectId)));
    }
    servers.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name));
    return { servers };
  }

  async function saveClub(input: SaveBody): Promise<void> {
    const cur = (await readClub(clubFile)) ?? { doc: {} as Obj, servers: {} as Record<string, ClubEntry> };
    const oldName = input.originalName;
    const old = oldName !== undefined && has(cur.servers, oldName) ? cur.servers[oldName] : undefined;
    if (oldName !== undefined && !old) throw new McpError('MCP não encontrado na biblioteca');
    if (input.name !== oldName && has(cur.servers, input.name)) throw new McpError(`já existe um MCP ${input.name} na biblioteca`);
    checkLiteral(input, 'club');

    const isStdio = input.type === 'stdio';
    const command = isStdio ? keepCommand(input.command ?? '', old?.command) : undefined;
    const args = isStdio ? keepArgs(input.args, old?.args) : undefined;
    const url = isStdio ? undefined : keepUrl(input.url ?? '', old?.url);
    if (url !== undefined) validateUrl(url);
    const envM = mergeKeys(isStdio ? (old?.env ?? []) : [], input.env, input.removeKeys?.env ?? []);
    const hdrM = mergeKeys(isStdio ? [] : (old?.headers ?? []), input.headers, input.removeKeys?.headers ?? []);
    const entry: ClubEntry = isStdio
      ? { type: 'stdio', command, ...(args && args.length > 0 ? { args } : {}), env: envM.keys, headers: [] }
      : { type: input.type, url, env: [], headers: hdrM.keys };

    const renamed = oldName !== undefined && oldName !== input.name;
    const oldEnv = old?.env ?? [];
    const oldHdr = old?.headers ?? [];
    try {
      // O que sobrou do nome antigo vai para o novo; depois, os valores trocados.
      if (renamed) {
        for (const k of envM.keys) if (!has(envM.set, k) && oldEnv.includes(k)) await moveSecret(clubSecretId(oldName!, 'env', k), clubSecretId(input.name, 'env', k), vault);
        for (const k of hdrM.keys) if (!has(hdrM.set, k) && oldHdr.includes(k)) await moveSecret(clubSecretId(oldName!, 'header', k), clubSecretId(input.name, 'header', k), vault);
      }
      for (const [k, v] of Object.entries(envM.set)) await setSecret(clubSecretId(input.name, 'env', k), v, vault);
      for (const [k, v] of Object.entries(hdrM.set)) await setSecret(clubSecretId(input.name, 'header', k), v, vault);
    } catch (err) {
      throw new McpError(`não deu para guardar o valor no cofre: ${err instanceof VaultError ? err.message : 'erro ao gravar'}`);
    }

    const servers = { ...cur.servers };
    if (renamed) delete servers[oldName!];
    servers[input.name] = entry;
    await writeClub(cur.doc, servers);

    // Valores que não pertencem mais ao nome antigo saem do cofre.
    if (oldName !== undefined) {
      for (const k of oldEnv) if (renamed || !envM.keys.includes(k)) await deleteSecret(clubSecretId(oldName, 'env', k), vault);
      for (const k of oldHdr) if (renamed || !hdrM.keys.includes(k)) await deleteSecret(clubSecretId(oldName, 'header', k), vault);
    }
  }

  async function writeClub(doc: Obj, servers: Record<string, ClubEntry>): Promise<void> {
    await writeAtomic(clubFile, JSON.stringify({ ...doc, servers }, null, 2) + '\n');
  }

  async function removeClub(name: string): Promise<void> {
    const cur = await readClub(clubFile);
    if (!cur || !has(cur.servers, name)) throw new McpError('MCP não encontrado na biblioteca');
    const e = cur.servers[name]!;
    const servers = { ...cur.servers };
    delete servers[name];
    await writeClub(cur.doc, servers);
    for (const k of e.env ?? []) await deleteSecret(clubSecretId(name, 'env', k), vault);
    for (const k of e.headers ?? []) await deleteSecret(clubSecretId(name, 'header', k), vault);
  }

  async function save(body: unknown, fromBrowser: boolean): Promise<{ server: McpServerView }> {
    requireBrowser(fromBrowser);
    const input = parseInput(SaveInput, body);
    checkShape(input);
    if (input.scope === 'club') {
      await saveClub(input);
    } else {
      const dir = input.scope === 'user' ? null : await projectDir(input.projectId);
      if (input.scope === 'project') checkLiteral(input, 'project');
      await editFile(o, input.scope, dir, (servers) => {
        const oldName = input.originalName;
        const prev = oldName !== undefined && has(servers, oldName) ? servers[oldName] : undefined;
        if (oldName !== undefined && !isObj(prev)) throw new McpError('MCP não encontrado neste escopo');
        if (input.name !== oldName && has(servers, input.name)) throw new McpError(`já existe um MCP ${input.name} neste escopo`);
        const entry = fileEntry(input, isObj(prev) ? prev : null);
        if (oldName !== undefined && oldName !== input.name) delete servers[oldName];
        servers[input.name] = entry;
      });
    }
    const { servers } = await list(input.scope === 'user' || input.scope === 'club' ? undefined : input.projectId);
    const saved = servers.find((s) => s.scope === input.scope && s.name === input.name);
    if (!saved) throw new McpError('gravado, mas não consegui ler de volta');
    return { server: saved };
  }

  async function remove(body: unknown, fromBrowser: boolean): Promise<{ ok: true }> {
    requireBrowser(fromBrowser);
    const input = parseInput(RefInput, body);
    if (input.scope === 'club') {
      await removeClub(input.name);
    } else {
      const dir = input.scope === 'user' ? null : await projectDir(input.projectId);
      await editFile(o, input.scope, dir, (servers) => {
        if (!has(servers, input.name) || !isObj(servers[input.name])) throw new McpError('MCP não encontrado neste escopo');
        delete servers[input.name];
      });
    }
    return { ok: true };
  }

  /** Testa com o config resolvido (segredos incluídos); o erro não traz valor. */
  async function test(body: unknown, fromBrowser: boolean): Promise<McpTestResult> {
    requireBrowser(fromBrowser);
    const input = parseInput(RefInput, body);
    const dir = input.projectId ? await projectDir(input.projectId) : null;
    let cfg: Obj;
    if (input.scope === 'club') {
      const cur = await readClub(clubFile);
      const e = cur && has(cur.servers, input.name) ? cur.servers[input.name] : undefined;
      if (!e) throw new McpError('MCP não encontrado na biblioteca');
      const base: Obj = { type: e.type };
      if (e.url) base.url = e.url;
      if (e.command) base.command = e.command;
      if (e.args) base.args = e.args;
      const r = await resolveClub(input.name, base, { env: e.env ?? [], headers: e.headers ?? [] }, vault);
      if ('missing' in r) throw new McpError(`o valor de ${r.missing} não está no cofre: cadastre de novo`);
      cfg = r.config;
    } else {
      if ((input.scope === 'local' || input.scope === 'project') && !dir) throw new McpError('escolha o projeto');
      const doc = await readDoc(fileOf(o.claudeConfigFile, input.scope, dir));
      const servers = doc ? sectionOf(input.scope, dir)(doc, false) : null;
      const e = servers && has(servers, input.name) ? servers[input.name] : undefined;
      if (!isObj(e)) throw new McpError('MCP não encontrado neste escopo');
      cfg = e;
    }
    return testMcpConfig(cfg, { cwd: dir ?? undefined });
  }

  return { list, save, remove, test };
}

export type McpLibrary = ReturnType<typeof createMcpLibrary>;
