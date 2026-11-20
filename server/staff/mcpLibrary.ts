import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpScope, McpServerView, McpType } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { pathKey } from '../adapters/claude/paths';
import { DEFAULT_SECRETS_DIR, deleteSecret, hasSecret, moveSecret, setSecret, VaultError, type VaultOptions } from '../secretVault';
import { clubDefOf, CLUB_MCP_FILE, clubEntry, clubSecretId, isLiteralSecret, McpError, readClub, resolveClub, type ClubEntry } from './mcp';
import { testMcpConfig, type McpTestResult } from './mcpTest';
import { MCP_TOOLS_FILE, mcpFingerprint, saveTestedTools, toolsKey } from './mcpTools';
import { writeAtomic } from './store';

// Biblioteca de MCPs: cadastro e edição nos dois escopos, como as skills (Global e Projeto), inclusive os que já existem fora do Claudio’s Club.
//   global  -> ~/.claude.json, mcpServers (o Claude Code do usuário também enxerga). O que a tela cadastra vai para lá como uma entrada
//              que chama o lançador (mcpLaunch.ts) com o nome do servidor ("do Club", `managed`): nenhum valor literal no ~/.claude.json.
//              env e cabeçalhos ficam no cofre (secretVault, por `mcp:club:<nome>:…`), e comando, URL e nomes de chave no registro
//              ~/.myco/mcps.json (sem valor), que o lançador lê. A entrada que o usuário escreveu (valores no próprio arquivo) aparece igual;
//              salvar pela tela a converte para "do Club" (os valores têm de ser digitados de novo). http/sse sem cabeçalho fica `{type, url}`.
//   project -> <projeto>/.mcp.json (vai para o git: segredo literal é recusado; use ${VARIAVEL}) e, para o que já está lá, o escopo local
//              (~/.claude.json, projects[<projeto>].mcpServers: fora do git, `outOfGit`). MCP novo de projeto vai para o .mcp.json.
// A tela nunca recebe valor de env/cabeçalho: só o nome e se está preenchido. Argumentos e URL com segredo
// saem mascarados (`••••`). Quem manda de volta um campo mascarado mantém o valor atual.

/** O marcador que substitui um segredo na lista (argumento ou pedaço da URL). */
export const MASK = '••••';
const KEEP_BACKUPS = 10;
const SCOPE_ORDER: McpScope[] = ['global', 'project'];
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
const Scope = z.enum(['global', 'project'], { error: 'escopo: global ou project' });
const ProjectId = z.string().regex(PROJECT_ID, 'projeto inválido').optional();

const SaveInput = z.object({
  scope: Scope,
  projectId: ProjectId,
  /** O nome atual, para editar (e renomear); ausente = MCP novo. */
  originalName: Name.optional(),
  name: Name,
  type: z.enum(['http', 'sse', 'stdio'], { error: 'tipo: http, sse ou stdio' }),
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
  /** Onde fica a lista de ferramentas do último teste (padrão ~/.myco/mcp-tools.json; ver mcpTools.ts). */
  toolsFile?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const strRecord = (v: unknown): Record<string, string> =>
  isObj(v) ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** zod 4 embrulha o erro de chave de record em "Invalid key in record": a mensagem da chave fica dentro dele. */
function firstMessage(issue: z.ZodError['issues'][number] | undefined): string | undefined {
  if (issue?.code === 'invalid_key' && issue.issues[0]) return issue.issues[0].message;
  return issue?.message;
}

function parseInput<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new McpError(firstMessage(r.error.issues[0]) ?? 'dados inválidos');
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

/**
 * Segredo literal onde não pode: no Projeto (o .mcp.json vai para o git, e o escopo local não ganha valor novo); na Global, URL e argumentos
 * (o cofre só guarda env e cabeçalho, e o ~/.claude.json e o registro não levam valor).
 */
function checkLiteral(input: Pick<SaveBody, 'name' | 'env' | 'headers' | 'url' | 'command' | 'args'>, where: 'global' | 'project'): void {
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
  outOfGit?: boolean;
  managed?: boolean;
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
  if (r.outOfGit) view.outOfGit = true;
  if (r.managed) view.managed = true;
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

export async function readDoc(file: string): Promise<Obj | null> {
  const raw = await readText(file);
  if (raw === null) return null;
  const v = tryJson(raw.replace(/^﻿/, ''));
  return isObj(v) ? v : null;
}

/** Cópia do ~/.claude.json antes de gravar (só os 10 mais recentes). Tem tokens: fica 0600. Devolve o caminho da cópia. */
async function backupClaude(dir: string, raw: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let name = `claude.json.${stamp}`;
  for (let n = 2; await exists(path.join(dir, name)); n++) name = `claude.json.${stamp}.${n}`;
  await fs.writeFile(path.join(dir, name), raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const all = (await fs.readdir(dir)).filter((f) => f.startsWith('claude.json.')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await fs.rm(path.join(dir, f), { force: true });
  return path.join(dir, name);
}

/**
 * Lê, muda e grava um arquivo de MCP. Relê o arquivo logo antes de gravar (o Claude Code grava o
 * ~/.claude.json o tempo todo): se mudou, refaz a mudança sobre o conteúdo novo (`change` pode rodar mais de uma vez: tem de refazer tudo do
 * zero sobre o que recebe). Grava atomicamente e mantém a permissão do arquivo. Só mexe em mcpServers (ou projects[<caminho>].mcpServers).
 * Devolve o caminho do backup do ~/.claude.json (null: arquivo novo, ou .mcp.json, que não tem backup).
 */
export async function editFile(o: Pick<McpLibraryOptions, 'claudeConfigFile' | 'backupDir'>, scope: FileScope, dir: string | null, change: (servers: Obj) => void): Promise<string | null> {
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
    const backup = raw !== null && scope !== 'project' ? await backupClaude(o.backupDir, raw) : null;
    await writeAtomic(file, JSON.stringify(doc, null, 2) + '\n');
    if (mode !== null) await fs.chmod(file, mode);
    return backup;
  }
}

/** Campos da entrada que a tela gerencia; o resto (oauth, timeout, o que vier) fica como estava ao salvar. */
const MANAGED_FIELDS = new Set(['type', 'url', 'command', 'args', 'env', 'headers', 'headersHelper']);
export const extraOf = (old: Obj | null | undefined): Obj => Object.fromEntries(Object.entries(old ?? {}).filter(([k]) => !MANAGED_FIELDS.has(k)));

function fileEntry(input: SaveBody, old: Obj | null): Obj {
  const extra = extraOf(old);
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

/** A entrada de um arquivo como linha da tela, com o que o arquivo traz (valor de env e cabeçalho nunca sai: só se está preenchido). */
function fileRow(name: string, raw: Obj, base: Pick<Row, 'scope' | 'projectId' | 'outOfGit'>): Row | null {
  const type = typeOf(raw);
  if (!type) return null;
  const keys = (rec: Record<string, string>) => Object.keys(rec).map((key) => ({ key, set: rec[key] !== '' }));
  return { ...base, name, type, url: str(raw.url), command: str(raw.command), args: strs(raw.args), env: keys(strRecord(raw.env)), headers: keys(strRecord(raw.headers)) };
}

/** Os MCP de um arquivo, para a tela (sem valores). */
async function fileRows(file: string, section: (doc: Obj, create: boolean) => Obj | null, base: Pick<Row, 'scope' | 'projectId' | 'outOfGit'>): Promise<Row[]> {
  const doc = await readDoc(file);
  const servers = doc ? section(doc, false) : null;
  if (!servers) return [];
  const out: Row[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const row = isObj(raw) ? fileRow(name, raw, base) : null;
    if (row) out.push(row);
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

  /** As entradas do ~/.claude.json como linhas da Global. A do Club vem da definição do registro (os valores estão no cofre). */
  async function globalViews(): Promise<McpServerView[]> {
    const doc = await readDoc(o.claudeConfigFile);
    const servers = doc ? sectionOf('user', null)(doc, false) : null;
    if (!servers) return [];
    const club = await readClub(clubFile).catch(() => null);
    const out: McpServerView[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (!isObj(raw)) continue;
      const c = clubDefOf(raw, club, clubFile);
      if (!c) {
        const row = fileRow(name, raw, { scope: 'global' });
        if (row) out.push(toView(row));
        continue;
      }
      const e = c.def;
      const env = await Promise.all((e.env ?? []).map(async (key) => ({ key, set: await hasSecret(clubSecretId(c.name, 'env', key), vault) })));
      const headers = await Promise.all((e.headers ?? []).map(async (key) => ({ key, set: await hasSecret(clubSecretId(c.name, 'header', key), vault) })));
      out.push(toView({ name, scope: 'global', managed: true, type: e.type, url: e.url, command: e.command, args: e.args, env, headers }));
    }
    return out;
  }

  /** `.mcp.json` e o escopo local do projeto, numa lista só. Mesmo nome nos dois: vale o local (a precedência do Claude Code). */
  async function projectViews(projectId: string, dir: string): Promise<McpServerView[]> {
    const rows = new Map<string, Row>();
    for (const r of await fileRows(path.join(dir, '.mcp.json'), sectionOf('project', dir), { scope: 'project', projectId })) rows.set(r.name, r);
    for (const r of await fileRows(o.claudeConfigFile, sectionOf('local', dir), { scope: 'project', projectId, outOfGit: true })) rows.set(r.name, r);
    return [...rows.values()].map(toView);
  }

  async function list(projectIdRaw: unknown): Promise<{ servers: McpServerView[] }> {
    const projectId = typeof projectIdRaw === 'string' && projectIdRaw ? projectIdRaw : undefined;
    if (projectId && !PROJECT_ID.test(projectId)) throw new McpError('projeto inválido');
    const servers: McpServerView[] = [...(await globalViews())];
    if (projectId) servers.push(...(await projectViews(projectId, await projectDir(projectId))));
    servers.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name));
    return { servers };
  }

  /** Onde está um MCP do Projeto: o escopo local vale primeiro (a precedência do Claude Code), depois o .mcp.json. */
  async function findProject(dir: string, name: string): Promise<{ scope: 'local' | 'project'; entry: Obj } | null> {
    for (const scope of ['local', 'project'] as const) {
      const doc = await readDoc(fileOf(o.claudeConfigFile, scope, dir));
      const servers = doc ? sectionOf(scope, dir)(doc, false) : null;
      const e = servers && has(servers, name) ? servers[name] : undefined;
      if (isObj(e)) return { scope, entry: e };
    }
    return null;
  }

  async function writeClub(doc: Obj, servers: Record<string, ClubEntry>): Promise<void> {
    await writeAtomic(clubFile, JSON.stringify({ ...doc, servers }, null, 2) + '\n');
  }

  /** Tira a definição do registro e os valores dela do cofre. Sem a definição, nada. */
  async function dropDef(name: string): Promise<void> {
    const cur = await readClub(clubFile);
    if (!cur || !has(cur.servers, name)) return;
    const e = cur.servers[name]!;
    const servers = { ...cur.servers };
    delete servers[name];
    await writeClub(cur.doc, servers);
    for (const k of e.env ?? []) await deleteSecret(clubSecretId(name, 'env', k), vault);
    for (const k of e.headers ?? []) await deleteSecret(clubSecretId(name, 'header', k), vault);
  }

  /**
   * Global: a entrada vai para o ~/.claude.json chamando o lançador (stdio, ou http/sse com cabeçalho), com os valores no cofre e a definição
   * no registro; http/sse sem cabeçalho vai como `{type, url}`. Entrada que o usuário escreveu (valores no próprio arquivo) vira "do Club" ao
   * salvar: o que o pedido manda manter (`null`) só vale para valores que já estão no cofre, os do arquivo têm de ser digitados de novo.
   */
  async function saveGlobal(input: SaveBody): Promise<void> {
    const oldName = input.originalName;
    // ~/.claude.json estragado: recusa antes de gravar qualquer valor no cofre ou no registro (editFile também recusaria, mas só no fim).
    const rawDoc = await readText(o.claudeConfigFile);
    const doc = rawDoc === null ? null : parseStrict(o.claudeConfigFile, rawDoc);
    const servers = doc ? sectionOf('user', null)(doc, false) : null;
    const oldRaw = oldName !== undefined && servers && has(servers, oldName) ? servers[oldName] : undefined;
    if (oldName !== undefined && !isObj(oldRaw)) throw new McpError('MCP não encontrado neste escopo');
    if (input.name !== oldName && servers && has(servers, input.name)) throw new McpError(`já existe um MCP ${input.name} neste escopo`);
    checkLiteral(input, 'global');

    const cur = (await readClub(clubFile)) ?? { doc: {} as Obj, servers: {} as Record<string, ClubEntry> };
    const oldClub = isObj(oldRaw) ? clubDefOf(oldRaw, cur, clubFile) : null;
    const oldDefName = oldClub?.name;
    const old = oldClub?.def;
    // Entrada que o Club não gerencia: comando, argumentos e URL mantidos vêm do próprio arquivo.
    const oldFile = isObj(oldRaw) && !oldClub ? oldRaw : null;

    const isStdio = input.type === 'stdio';
    const command = isStdio ? keepCommand(input.command ?? '', old?.command ?? str(oldFile?.command)) : undefined;
    const args = isStdio ? keepArgs(input.args, old?.args ?? (oldFile ? strs(oldFile.args) : undefined)) : undefined;
    const url = isStdio ? undefined : keepUrl(input.url ?? '', old?.url ?? str(oldFile?.url));
    if (url !== undefined) validateUrl(url);
    // O que foi mantido do arquivo antigo também não pode levar segredo literal: iria para o registro e para o ~/.claude.json.
    checkLiteral({ name: input.name, env: {}, headers: {}, url, command, args }, 'global');
    const envM = mergeKeys(isStdio ? (old?.env ?? []) : [], input.env, input.removeKeys?.env ?? []);
    const hdrM = mergeKeys(isStdio ? [] : (old?.headers ?? []), input.headers, input.removeKeys?.headers ?? []);
    const def: ClubEntry = isStdio
      ? { type: 'stdio', command, ...(args && args.length > 0 ? { args } : {}), env: envM.keys, headers: [] }
      : { type: input.type, url, env: [], headers: hdrM.keys };
    const needsDef = isStdio || hdrM.keys.length > 0;
    // Antes de gravar qualquer valor: se a entrada não dá para montar, nada é mexido.
    const entry = clubEntry(input.name, def, { clubFile, vaultDir: vault?.dir ?? DEFAULT_SECRETS_DIR });
    if (!entry) throw new McpError('o caminho do lançador tem aspas, % ou $: não dá para gravar a entrada');

    const renamed = oldDefName !== undefined && oldDefName !== input.name;
    const oldEnv = old?.env ?? [];
    const oldHdr = old?.headers ?? [];
    if (needsDef) {
      try {
        // O que sobrou do nome antigo vai para o novo; depois, os valores trocados.
        if (renamed) {
          for (const k of envM.keys) if (!has(envM.set, k) && oldEnv.includes(k)) await moveSecret(clubSecretId(oldDefName!, 'env', k), clubSecretId(input.name, 'env', k), vault);
          for (const k of hdrM.keys) if (!has(hdrM.set, k) && oldHdr.includes(k)) await moveSecret(clubSecretId(oldDefName!, 'header', k), clubSecretId(input.name, 'header', k), vault);
        }
        for (const [k, v] of Object.entries(envM.set)) await setSecret(clubSecretId(input.name, 'env', k), v, vault);
        for (const [k, v] of Object.entries(hdrM.set)) await setSecret(clubSecretId(input.name, 'header', k), v, vault);
      } catch (err) {
        throw new McpError(`não deu para guardar o valor no cofre: ${err instanceof VaultError ? err.message : 'erro ao gravar'}`);
      }
      const next = { ...cur.servers };
      if (renamed) delete next[oldDefName!];
      next[input.name] = def;
      await writeClub(cur.doc, next);
    }

    await editFile(o, 'user', null, (srv) => {
      const prev = oldName !== undefined && has(srv, oldName) ? srv[oldName] : undefined;
      if (oldName !== undefined && !isObj(prev)) throw new McpError('MCP não encontrado neste escopo');
      if (input.name !== oldName && has(srv, input.name)) throw new McpError(`já existe um MCP ${input.name} neste escopo`);
      if (oldName !== undefined && oldName !== input.name) delete srv[oldName];
      srv[input.name] = { ...extraOf(isObj(prev) ? prev : null), ...entry };
    });

    if (oldDefName !== undefined) {
      // Virou http/sse sem cabeçalho: a definição e os valores saem. Senão, saem só os valores que não pertencem mais ao nome antigo.
      if (!needsDef) await dropDef(oldDefName);
      else {
        for (const k of oldEnv) if (renamed || !envM.keys.includes(k)) await deleteSecret(clubSecretId(oldDefName, 'env', k), vault);
        for (const k of oldHdr) if (renamed || !hdrM.keys.includes(k)) await deleteSecret(clubSecretId(oldDefName, 'header', k), vault);
      }
    }
  }

  /** Projeto: onde o MCP já está (local ou .mcp.json); MCP novo vai para o .mcp.json. Valor novo com segredo literal é recusado nos dois. */
  async function saveProject(input: SaveBody, dir: string): Promise<void> {
    const oldName = input.originalName;
    const here = oldName !== undefined ? await findProject(dir, oldName) : null;
    if (oldName !== undefined && !here) throw new McpError('MCP não encontrado neste escopo');
    if (input.name !== oldName && (await findProject(dir, input.name))) throw new McpError(`já existe um MCP ${input.name} neste escopo`);
    checkLiteral(input, 'project');
    await editFile(o, here?.scope ?? 'project', dir, (servers) => {
      const prev = oldName !== undefined && has(servers, oldName) ? servers[oldName] : undefined;
      if (oldName !== undefined && !isObj(prev)) throw new McpError('MCP não encontrado neste escopo');
      const entry = fileEntry(input, isObj(prev) ? prev : null);
      if (oldName !== undefined && oldName !== input.name) delete servers[oldName];
      servers[input.name] = entry;
    });
  }

  async function save(body: unknown, fromBrowser: boolean): Promise<{ server: McpServerView }> {
    requireBrowser(fromBrowser);
    const input = parseInput(SaveInput, body);
    checkShape(input);
    if (input.scope === 'global') await saveGlobal(input);
    else await saveProject(input, await projectDir(input.projectId));
    const { servers } = await list(input.scope === 'project' ? input.projectId : undefined);
    const saved = servers.find((s) => s.scope === input.scope && s.name === input.name);
    if (!saved) throw new McpError('gravado, mas não consegui ler de volta');
    return { server: saved };
  }

  async function remove(body: unknown, fromBrowser: boolean): Promise<{ ok: true }> {
    requireBrowser(fromBrowser);
    const input = parseInput(RefInput, body);
    if (input.scope === 'global') {
      const club = await readClub(clubFile).catch(() => null);
      const dropped: { name?: string } = {};
      await editFile(o, 'user', null, (servers) => {
        const e = has(servers, input.name) ? servers[input.name] : undefined;
        if (!isObj(e)) throw new McpError('MCP não encontrado neste escopo');
        dropped.name = clubDefOf(e, club, clubFile)?.name;
        delete servers[input.name];
      });
      // Só a entrada do Club leva a definição e os valores junto; outra com o mesmo nome no registro é de outra coisa e fica.
      if (dropped.name !== undefined) await dropDef(dropped.name);
    } else {
      const dir = await projectDir(input.projectId);
      const here = await findProject(dir, input.name);
      if (!here) throw new McpError('MCP não encontrado neste escopo');
      await editFile(o, here.scope, dir, (servers) => {
        if (!has(servers, input.name) || !isObj(servers[input.name])) throw new McpError('MCP não encontrado neste escopo');
        delete servers[input.name];
      });
    }
    return { ok: true };
  }

  /**
   * Testa com o config resolvido (segredos incluídos); o erro não traz valor. Deu certo: a lista (com o que é só leitura) fica
   * guardada para a política de escrita das fichas (mcpTools.ts). Falha ao guardar não derruba o teste.
   */
  async function test(body: unknown, fromBrowser: boolean): Promise<McpTestResult> {
    requireBrowser(fromBrowser);
    const input = parseInput(RefInput, body);
    const dir = input.scope === 'project' || input.projectId ? await projectDir(input.projectId) : null;
    let cfg: Obj;
    if (input.scope === 'global') {
      const doc = await readDoc(o.claudeConfigFile);
      const servers = doc ? sectionOf('user', null)(doc, false) : null;
      const e = servers && has(servers, input.name) ? servers[input.name] : undefined;
      if (!isObj(e)) throw new McpError('MCP não encontrado neste escopo');
      const c = clubDefOf(e, await readClub(clubFile).catch(() => null), clubFile);
      if (!c) cfg = e;
      else {
        const base: Obj = { type: c.def.type };
        if (c.def.url) base.url = c.def.url;
        if (c.def.command) base.command = c.def.command;
        if (c.def.args) base.args = c.def.args;
        const r = await resolveClub(c.name, base, { env: c.def.env ?? [], headers: c.def.headers ?? [] }, vault);
        if ('missing' in r) throw new McpError(`o valor de ${r.missing} não está no cofre: cadastre de novo`);
        cfg = r.config;
      }
    } else {
      const here = await findProject(dir!, input.name);
      if (!here) throw new McpError('MCP não encontrado neste escopo');
      cfg = here.entry;
    }
    const result = await testMcpConfig(cfg, { cwd: dir ?? undefined });
    if (result.ok) {
      const readOnly = new Set(result.readOnly);
      const tools = result.tools.map((name) => ({ name, readOnly: readOnly.has(name) }));
      await saveTestedTools(o.toolsFile ?? MCP_TOOLS_FILE, toolsKey(input.scope, dir, input.name), mcpFingerprint(cfg), tools).catch((err: Error) =>
        console.warn(`[mcp] ${input.name}: não deu para guardar a lista de ferramentas (${err.message})`),
      );
    }
    return result;
  }

  return { list, save, remove, test };
}

export type McpLibrary = ReturnType<typeof createMcpLibrary>;
