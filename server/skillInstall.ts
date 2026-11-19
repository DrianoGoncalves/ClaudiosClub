import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter, str } from './adapters/claude/frontmatter';
import { isInside, NAME as SKILL_NAME } from './adapters/claude/skillWrite';
import { github, GitHubError, GitHubRateLimited, validRef, validRepo, type GitHubClient, type GitHubTree, type TreeEntry } from './adapters/github/client';
import { findSecret } from './chat/secrets';
import { MYCO_HOME } from './config';
import { SkillError } from './skillLibrary';
import { writeAtomic } from './staff/store';

// Skill de repositório PÚBLICO do GitHub (`https://github.com/dono/repo/tree/<ref>/<pasta>`): prévia, instalação,
// verificação de atualização, atualização e volta. Nada daqui executa código: lê o repositório, confere e grava a pasta.
// A instalação não marca a skill em ficha (isso é de quem usa). Atualizar e voltar guardam a versão anterior num backup
// fora da pasta de skills (uma cópia com SKILL.md dentro de ~/.claude/skills viraria skill).

export const LIMITS = {
  files: 300,
  fileBytes: 1_048_576,
  totalBytes: 5_242_880,
  skillBytes: 131_072,
  pathChars: 200,
  chooseSkills: 50,
  describeSkills: 30,
  diffBytes: 200 * 1024,
} as const;

const ORIGIN = '.myco-origin.json';
const BACKUP_ROOT = path.join(MYCO_HOME, 'backups', 'skills-github');
const LCS_CELLS = 4_000_000;
const DAY_MS = 24 * 60 * 60_000;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[\x00-\x1f\x7f\\:<>"|?*]/;
const EXECUTABLE_EXT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|exe|dll|so|dylib|com|msi|py|js|mjs|cjs|ts|rb|pl|php|jar|vbs|wsf|scr)$/i;

/** Trocar a skill (atualizar, voltar, instalar sobre o que mudou) pede confirmação: `modified` (mexida aqui) ou `changed` (a prévia não vale mais). */
export class SkillConflictError extends Error {
  code: 'modified' | 'changed';
  constructor(message: string, code: 'modified' | 'changed') {
    super(message);
    this.code = code;
  }
}

/** Conta ou projeto. A biblioteca não é escopo (virou Global); as rotas recusam o nome `library` (ver index.ts, `refuseLibrary`). */
export type SkillScopeName = 'user' | 'project';
/** Onde a skill mora: a pasta de skills do escopo (o servidor monta; o navegador só manda o id). */
export interface InstallTarget {
  scope: SkillScopeName;
  owner: string;
  root: string;
}
/** Trocas para teste: o cliente do GitHub e a pasta dos backups. */
export interface SkillDeps {
  gh?: GitHubClient;
  backupRoot?: string;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/, 'sha do commit inválido');
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, 'digest inválido');
const SCOPE = z.enum(['library', 'user', 'project']);
const PROJECT_ID = z.string().max(200).nullable().optional();

export const GitHubPreviewInput = z.object({ url: z.string().trim().min(1).max(500), path: z.string().max(300).optional() });
export const GitHubInstallInput = z.object({
  scope: SCOPE,
  projectId: PROJECT_ID,
  url: z.string().trim().min(1).max(500),
  path: z.string().max(300),
  ref: z.string().min(1).max(200),
  sha: SHA,
  digest: DIGEST,
  name: z.string().max(64).optional(),
});
/** Várias skills do MESMO repositório (`url` é de todas): cada item leva o ref, o sha e o digest da própria prévia. */
export const GitHubInstallBatchInput = GitHubInstallInput.pick({ scope: true, projectId: true, url: true }).extend({
  items: z
    .array(GitHubInstallInput.pick({ path: true, ref: true, sha: true, digest: true, name: true }))
    .min(1, 'escolha ao menos uma skill')
    .max(LIMITS.chooseSkills, `até ${LIMITS.chooseSkills} skills por vez`),
});
export const GitHubStatusQuery = z.object({ scope: SCOPE, projectId: PROJECT_ID });
export const GitHubSkillInput = z.object({ scope: SCOPE, projectId: PROJECT_ID, name: z.string().min(1).max(64) });
export const GitHubUpdateInput = GitHubSkillInput.extend({ sha: SHA, digest: DIGEST, overwriteLocal: z.boolean().optional() });

const SHA40 = /^[0-9a-f]{40}$/;
const HASH64 = /^[0-9a-f]{64}$/;

/**
 * O que fica em `<pasta>/.myco-origin.json`. Fora de todo hash e digest. Como uma skill (e o metadado dela) pode ser
 * mexida por um agente do projeto ou da conta, tudo aqui é conferido antes de ser usado (ver originValid).
 */
const OriginSchema = z.object({
  v: z.literal(1),
  url: z.string().max(500),
  owner: z.string(),
  repo: z.string(),
  path: z.string().max(300),
  ref: z.string().min(1).max(200),
  sha: z.string().regex(SHA40),
  treeSha: z.string().regex(SHA40),
  installedAt: z.string(),
  files: z.record(z.string(), z.string().regex(HASH64)),
  checkedSha: z.string().regex(SHA40).optional(),
  previous: z.object({ sha: z.string().regex(SHA40), backup: z.string().max(1000) }).optional(),
});
export type OriginMeta = z.infer<typeof OriginSchema>;

/** Dono, repositório, ref, pasta, URL e lista de arquivos têm de ser do jeito que o GitHub aceita e a regra de caminho aprova. */
function originValid(m: OriginMeta): boolean {
  if (!validRepo(m.owner, m.repo) || !validRef(m.ref)) return false;
  if (m.path && badPath(m.path)) return false;
  try {
    const u = parseGitHubUrl(m.url);
    if (u.owner !== m.owner || u.repo !== m.repo) return false;
  } catch {
    return false;
  }
  const names = Object.keys(m.files);
  return names.includes('SKILL.md') && names.every((p) => !badPath(p) && p.split('/').pop() !== ORIGIN);
}

export interface PackFile {
  path: string;
  size: number;
  sha256: string;
  binary: boolean;
  executable: boolean;
  bytes: Buffer;
}
export interface PreviewFile {
  path: string;
  size: number;
  sha256: string;
  binary: boolean;
  executable: boolean;
}
export interface Alert {
  level: 'info' | 'warn' | 'danger';
  code: string;
  message: string;
  file?: string;
}
interface Package {
  name: string;
  skillMd: string;
  frontmatter: Record<string, unknown>;
  files: PackFile[];
  alerts: Alert[];
  totalBytes: number;
  digest: string;
}
export interface PreviewSource {
  owner: string;
  repo: string;
  ref: string;
  sha: string;
  path: string;
  treeSha: string;
  url: string;
}
export interface DiffItem {
  path: string;
  status: 'added' | 'removed' | 'changed';
  binary: boolean;
  patch?: string | null;
  tooLarge?: boolean;
  before?: { size: number; sha256: string };
  after?: { size: number; sha256: string };
}

export interface ParsedUrl {
  owner: string;
  repo: string;
  kind: 'root' | 'tree' | 'blob';
  /** Depois de `tree/` ou `blob/`: ref e caminho juntos (o ref pode ter `/`). */
  rest: string[];
}

const badUrl = () => new SkillError('use um link do GitHub: https://github.com/dono/repositorio/tree/<branch>/<pasta> (ou o link do SKILL.md)');

/** Só `https://github.com/{dono}/{repo}[.git][/tree|/blob/{resto}]`: sem usuário, senha ou porta. Query e # ficam de fora. */
export function parseGitHubUrl(text: string): ParsedUrl {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    throw badUrl();
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || (host !== 'github.com' && host !== 'www.github.com') || u.username || u.password || u.port) throw badUrl();
  const parts = u.pathname.replace(/\/+$/, '').split('/').slice(1).map(decodeSegment);
  const [owner, rawRepo, kind, ...rest] = parts;
  if (!owner || !rawRepo) throw badUrl();
  const repo = rawRepo.replace(/\.git$/, '');
  if (!validRepo(owner, repo)) throw badUrl();
  if (parts.length === 2) return { owner, repo, kind: 'root', rest: [] };
  if (kind !== 'tree' && kind !== 'blob') throw badUrl();
  if (kind === 'blob' && rest[rest.length - 1] !== 'SKILL.md') throw new SkillError('o link de arquivo tem de terminar em SKILL.md (ou use o link da pasta)');
  return { owner, repo, kind, rest };
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw badUrl();
  }
}

/** Caminho (dentro do repositório ou da pasta da skill) que vira pasta no disco: sem `..`, `\`, `:`, nome reservado. Devolve o motivo ou null. */
export function badPath(p: string): string | null {
  if (p.length > LIMITS.pathChars) return 'caminho longo demais (até 200 caracteres)';
  if (p.startsWith('/') || BAD_CHARS.test(p)) return 'caminho com caractere ou começo não permitido';
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return 'caminho com segmento vazio, . ou ..';
    if (/[. ]$/.test(seg)) return 'nome termina em ponto ou espaço';
    if (WIN_RESERVED.test(seg)) return 'nome reservado do Windows';
  }
  return null;
}

function checkFolder(p: string): void {
  const why = p ? badPath(p) : null;
  if (why) throw new SkillError(`pasta inválida: ${why}`);
}

const nameOf = (folder: string, repo: string) => folder.split('/').pop() || repo;
const joinRepoPath = (folder: string, rel: string) => (folder ? `${folder}/${rel}` : rel);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const exists = (p: string) => fs.lstat(p).then(() => true, () => false);
const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;

/** Nome da pasta pelo escopo: o regex do skillWrite. `synced` é da conta. */
function nameOk(scope: SkillScopeName, name: string): boolean {
  if (scope === 'user' && name.toLowerCase() === 'synced') return false;
  return SKILL_NAME.test(name);
}

/** O que está dentro da pasta (relativo a ela). `null` = fora da pasta. */
function under(folder: string, p: string): string | null {
  if (!folder) return p;
  return p.startsWith(`${folder}/`) ? p.slice(folder.length + 1) : null;
}

/** Sha da árvore da pasta (`treeSha`); na raiz, a árvore do commit. Pasta que não existe: null. */
function treeShaOf(tree: GitHubTree, folder: string): string | null {
  if (!folder) return tree.sha;
  return tree.entries.find((e) => e.type === 'tree' && e.path === folder)?.sha ?? null;
}

/** Árvore grande demais (cortada pelo GitHub) não serve: o v1 não monta a skill com ela. */
function full(tree: GitHubTree): GitHubTree {
  if (tree.truncated) throw new SkillError('repositório grande demais para o v1 (a árvore do GitHub veio cortada)');
  return tree;
}

const isBinary = (bytes: Buffer): boolean => {
  if (bytes.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
};

function digestOf(files: Array<{ path: string; sha256: string }>): string {
  const h = createHash('sha256');
  for (const f of files) h.update(`${f.path}\n${f.sha256}\n`);
  return h.digest('hex');
}

/**
 * Monta o pacote da pasta no commit. Recusa antes de baixar (modo, caminho, colisão, limites pelos tamanhos da árvore);
 * baixa com limite no stream e confere o sha1 de cada arquivo; procura segredo em todo texto. Não grava nada.
 */
async function buildPackage(gh: GitHubClient, o: { owner: string; repo: string; sha: string }, folder: string, tree: GitHubTree, name: string): Promise<Package> {
  full(tree);
  const inside = tree.entries.flatMap((e) => {
    const rel = under(folder, e.path);
    return rel === null ? [] : [{ e, rel }];
  });
  for (const { e, rel } of inside) {
    if (e.type === 'tree') continue;
    if (e.mode === '120000') throw new SkillError(`${rel} é um link simbólico: não instalo link`);
    if (e.mode === '160000' || e.type === 'commit') throw new SkillError(`${rel} é um submódulo: não instalo`);
    if (e.type !== 'blob') throw new SkillError(`${rel}: tipo de entrada não suportado`);
  }
  const files = inside.filter((x) => x.e.type === 'blob');
  if (files.length > LIMITS.files) throw new SkillError(`a skill tem mais de ${LIMITS.files} arquivos`);
  if (!files.some((x) => x.rel === 'SKILL.md')) throw new SkillError('essa pasta não tem SKILL.md');

  const seen = new Map<string, string>();
  const plan: Array<{ e: TreeEntry; rel: string; size: number }> = [];
  let declared = 0;
  for (const { e, rel } of inside.filter((x) => x.e.type === 'blob')) {
    const why = badPath(rel);
    if (why) throw new SkillError(`${why}: ${rel}`);
    if (rel.split('/').pop() === ORIGIN) throw new SkillError(`${ORIGIN} é reservado para o registro da instalação: ${rel}`);
    const key = rel.toLowerCase().normalize('NFC');
    const clash = seen.get(key);
    if (clash) throw new SkillError(`${rel} e ${clash} viram o mesmo arquivo no Windows ou no macOS`);
    seen.set(key, rel);
    if (e.size === undefined) throw new SkillError(`${rel}: tamanho desconhecido no GitHub`);
    const cap = rel === 'SKILL.md' ? LIMITS.skillBytes : LIMITS.fileBytes;
    if (e.size > cap) throw new SkillError(`${rel} passa do limite de ${cap / 1024} KB`);
    declared += e.size;
    plan.push({ e, rel, size: e.size });
  }
  if (declared > LIMITS.totalBytes) throw new SkillError('a skill passa de 5 MB no total');

  const out: PackFile[] = [];
  for (const { e, rel, size } of plan) {
    const bytes = await gh.blob(o.owner, o.repo, o.sha, joinRepoPath(folder, rel), e.sha, size);
    const binary = isBinary(bytes);
    if (!binary) {
      const secret = findSecret(bytes.toString('utf8'));
      if (secret) throw new SkillError(`${secret.label} em ${rel}: tire e use uma variável de ambiente`);
    }
    out.push({
      path: rel,
      size: bytes.length,
      sha256: sha256(bytes),
      binary,
      executable: e.mode === '100755' || bytes.subarray(0, 2).toString('latin1') === '#!',
      bytes,
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const md = out.find((f) => f.path === 'SKILL.md');
  if (!md || md.binary) throw new SkillError('o SKILL.md não é texto');
  const skillMd = md.bytes.toString('utf8');
  const frontmatter = parseFrontmatter(skillMd).data;
  return {
    name,
    skillMd,
    frontmatter,
    files: out,
    alerts: alertsOf(out, skillMd, frontmatter, name),
    totalBytes: out.reduce((n, f) => n + f.size, 0),
    digest: digestOf(out),
  };
}

const FRONTMATTER_ALERTS: Record<string, Omit<Alert, 'file'>> = {
  hooks: { level: 'danger', code: 'hooks', message: 'o frontmatter tem `hooks`: roda comando sozinho em eventos do Claude Code' },
  'allowed-tools': { level: 'warn', code: 'allowed-tools', message: '`allowed-tools` libera ferramentas sem perguntar' },
  shell: { level: 'warn', code: 'shell', message: '`shell` escolhe o shell dos comandos da skill' },
  model: { level: 'info', code: 'model', message: '`model` troca o modelo quando a skill roda' },
  context: { level: 'info', code: 'context', message: '`context` muda o contexto em que a skill roda' },
  agent: { level: 'info', code: 'agent', message: '`agent` troca o agente que roda a skill' },
};

/** Alertas que não recusam: script e binário, poder do frontmatter, shell embutido, BOM e nome diferente da pasta. */
function alertsOf(files: PackFile[], skillMd: string, fm: Record<string, unknown>, name: string): Alert[] {
  const out: Alert[] = [];
  for (const f of files) {
    if (f.binary) out.push({ level: 'warn', code: 'binary', message: `${f.path} é binário: não dá para conferir se tem segredo nele`, file: f.path });
    if (f.executable || EXECUTABLE_EXT.test(f.path)) {
      out.push({ level: 'warn', code: 'executable', message: `${f.path} é script ou programa: roda na sua máquina se alguma skill ou comando chamar`, file: f.path });
    }
  }
  for (const [key, alert] of Object.entries(FRONTMATTER_ALERTS)) if (fm[key] !== undefined) out.push({ ...alert, file: 'SKILL.md' });
  if (/(^|[\s(])!`[^`\n]+`/.test(skillMd) || /^```!/m.test(skillMd)) {
    out.push({ level: 'danger', code: 'inline-shell', message: 'o texto tem comando que roda ao chamar a skill (!`...` ou bloco ```!)', file: 'SKILL.md' });
  }
  if (skillMd.charCodeAt(0) === 0xfeff) out.push({ level: 'warn', code: 'bom', message: 'SKILL.md com BOM UTF-8: o Codex ignora a skill', file: 'SKILL.md' });
  const declared = str(fm.name);
  if (declared && declared !== name) out.push({ level: 'info', code: 'name-mismatch', message: `o nome no frontmatter (${declared}) é diferente da pasta (${name})`, file: 'SKILL.md' });
  return out;
}

const publicFile = (f: PackFile): PreviewFile => ({ path: f.path, size: f.size, sha256: f.sha256, binary: f.binary, executable: f.executable });

/** Acha o ref e a pasta: tenta o prefixo mais curto do `rest` (até 4 segmentos); 404/422 = próximo corte. */
async function resolveFromRest(gh: GitHubClient, u: ParsedUrl): Promise<{ ref: string; sha: string; remainder: string[] }> {
  if (u.rest.length === 0) return { ...(await gh.resolveRef(u.owner, u.repo, null)), remainder: [] };
  for (let i = 1; i <= Math.min(4, u.rest.length); i++) {
    try {
      return { ...(await gh.resolveRef(u.owner, u.repo, u.rest.slice(0, i).join('/'))), remainder: u.rest.slice(i) };
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) continue;
      throw err;
    }
  }
  throw new SkillError('não achei essa branch, tag ou commit no repositório');
}

export interface ChooseResult {
  kind: 'choose';
  source: { owner: string; repo: string; ref: string; sha: string };
  skills: Array<{ path: string; name: string; description: string }>;
}
export interface PreviewOk {
  kind: 'preview';
  source: PreviewSource;
  name: string;
  skillMd: string;
  frontmatter: Record<string, unknown>;
  files: PreviewFile[];
  alerts: Alert[];
  totalBytes: number;
  digest: string;
}

/**
 * A prévia: resolve ref → sha, lê a árvore e monta o pacote (sem gravar). Pasta sem SKILL.md direto: lista as skills
 * de dentro (`choose`), sem descer dentro de outra skill. `path` (do `choose`) troca a pasta da URL.
 */
export async function previewSkill(input: { url: string; path?: string | undefined }, deps: SkillDeps = {}): Promise<PreviewOk | ChooseResult> {
  const gh = deps.gh ?? github;
  const u = parseGitHubUrl(input.url);
  const found = await resolveFromRest(gh, u);
  const folder = input.path !== undefined ? input.path : u.kind === 'blob' ? found.remainder.slice(0, -1).join('/') : found.remainder.join('/');
  checkFolder(folder);
  const { owner, repo } = u;
  const { ref, sha } = found;
  const tree = full(await gh.tree(owner, repo, sha));
  const treeSha = treeShaOf(tree, folder);
  if (treeSha === null) throw new SkillError('essa pasta não existe no repositório');
  if (!tree.entries.some((e) => e.type === 'blob' && e.path === joinRepoPath(folder, 'SKILL.md'))) {
    return choose(gh, { owner, repo, ref, sha }, tree, folder);
  }
  const pkg = await buildPackage(gh, { owner, repo, sha }, folder, tree, nameOf(folder, repo));
  return {
    kind: 'preview',
    source: { owner, repo, ref, sha, path: folder, treeSha, url: `https://github.com/${owner}/${repo}` },
    name: pkg.name,
    skillMd: pkg.skillMd,
    frontmatter: pkg.frontmatter,
    files: pkg.files.map(publicFile),
    alerts: pkg.alerts,
    totalBytes: pkg.totalBytes,
    digest: pkg.digest,
  };
}

async function choose(gh: GitHubClient, src: { owner: string; repo: string; ref: string; sha: string }, tree: GitHubTree, folder: string): Promise<ChooseResult> {
  const found: Array<{ rel: string; entry: TreeEntry }> = [];
  for (const e of tree.entries) {
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) continue;
    const rel = under(folder, e.path);
    if (rel && rel.endsWith('/SKILL.md')) found.push({ rel: rel.slice(0, -'/SKILL.md'.length), entry: e });
  }
  if (found.length === 0) throw new SkillError('nenhuma pasta com SKILL.md');
  // Mais rasas primeiro: uma skill dentro de outra skill fica de fora (o SKILL.md de dentro não é uma skill à parte).
  found.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const kept: typeof found = [];
  for (const f of found) if (!kept.some((k) => f.rel.startsWith(`${k.rel}/`))) kept.push(f);
  if (kept.length > LIMITS.chooseSkills) throw new SkillError(`mais de ${LIMITS.chooseSkills} skills nesta pasta: aponte o link para uma delas`);
  const skills: Array<{ path: string; name: string; description: string }> = [];
  for (const [i, f] of kept.entries()) {
    const skillPath = joinRepoPath(folder, f.rel);
    skills.push({
      path: skillPath,
      name: f.rel.split('/').pop() ?? f.rel,
      description: i < LIMITS.describeSkills ? await describe(gh, src, skillPath, f.entry) : '',
    });
  }
  return { kind: 'choose', source: src, skills };
}

/** A descrição do SKILL.md escolhido (para a lista). Falha = '': não derruba a lista. */
async function describe(gh: GitHubClient, src: { owner: string; repo: string; sha: string }, dir: string, entry: TreeEntry): Promise<string> {
  if (entry.size === undefined || entry.size > LIMITS.skillBytes) return '';
  try {
    const text = (await gh.blob(src.owner, src.repo, src.sha, `${dir}/SKILL.md`, entry.sha, entry.size)).toString('utf8');
    return str(parseFrontmatter(text).data.description) ?? '';
  } catch {
    return '';
  }
}

export interface InstallInput {
  target: InstallTarget;
  url: string;
  path: string;
  /** O ref da prévia: sem ele o metadado não sabe qual branch acompanhar. */
  ref: string;
  sha: string;
  digest: string;
  name?: string | undefined;
}

/**
 * Instala: baixa de novo NO sha da prévia, refaz as validações e só grava se o digest for o mesmo. Não sobrescreve
 * skill existente. Grava numa pasta de staging no mesmo volume e renomeia para o destino.
 */
export async function installSkill(i: InstallInput, deps: SkillDeps = {}): Promise<{ name: string; sha: string; digest: string }> {
  const gh = deps.gh ?? github;
  const u = parseGitHubUrl(i.url);
  checkFolder(i.path);
  if (!validRef(i.ref)) throw new SkillError('ref inválido');
  const name = i.name ?? nameOf(i.path, u.repo);
  if (!nameOk(i.target.scope, name)) throw new SkillError(`nome inválido para este escopo: ${name}`);
  const root = await ensureRoot(i.target.root);
  const dest = path.join(root, name);
  if (await exists(dest)) throw new SkillError(`já existe a skill ${name}`);
  const tree = full(await gh.tree(u.owner, u.repo, i.sha));
  const pkg = await buildPackage(gh, { owner: u.owner, repo: u.repo, sha: i.sha }, i.path, tree, name);
  if (pkg.digest !== i.digest) throw new SkillConflictError('a skill mudou desde a prévia: confira de novo', 'changed');
  const treeSha = treeShaOf(tree, i.path);
  if (treeSha === null) throw new SkillError('essa pasta não existe no repositório');
  const meta: OriginMeta = {
    v: 1,
    url: i.url.trim(),
    owner: u.owner,
    repo: u.repo,
    path: i.path,
    ref: i.ref,
    sha: i.sha,
    treeSha,
    installedAt: new Date().toISOString(),
    files: hashesOf(pkg),
  };
  const stage = await newStage(i.target);
  try {
    await writePackage(stage.dir, pkg.files, meta);
    await fs.rename(stage.dir, dest);
  } catch (err) {
    await fs.rm(stage.dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { name, sha: i.sha, digest: pkg.digest };
}

export interface InstallBatchInput {
  target: InstallTarget;
  /** O link do repositório: o mesmo para todos os itens. */
  url: string;
  items: Array<Omit<InstallInput, 'target' | 'url'>>;
}
/** Uma skill do lote: instalada, ou o motivo. `code` só quando a tela age diferente: `changed`/`modified` = refazer a prévia, `rate-limited` = esperar até `resetAt`. */
export type BatchItemResult =
  | { path: string; status: 'installed'; name: string; sha: string; digest: string }
  | { path: string; status: 'error'; error: string; code?: 'changed' | 'modified' | 'rate-limited'; resetAt?: string };

/**
 * Instala as skills uma depois da outra pelo `installSkill` (mesmo sha, digest, staging e recusas da instalação individual):
 * o que falha vira o resultado daquele item e os outros seguem. O cache e o disjuntor do adaptador valem para todos
 * (limite de consultas atingido: os itens seguintes são recusados na hora, sem ir à rede).
 */
export async function installBatch(i: InstallBatchInput, deps: SkillDeps = {}): Promise<BatchItemResult[]> {
  if (i.items.length > LIMITS.chooseSkills) throw new SkillError(`até ${LIMITS.chooseSkills} skills por vez`);
  const out: BatchItemResult[] = [];
  for (const item of i.items) {
    try {
      out.push({ path: item.path, status: 'installed', ...(await installSkill({ target: i.target, url: i.url, ...item }, deps)) });
    } catch (err) {
      out.push(batchError(item.path, err));
    }
  }
  return out;
}

/** O que a rota individual responderia ao mesmo erro, como resultado do item (o que não se espera: `erro interno`, sem detalhe). */
function batchError(path: string, err: unknown): BatchItemResult {
  if (err instanceof SkillConflictError) return { path, status: 'error', error: err.message, code: err.code };
  if (err instanceof GitHubRateLimited) return { path, status: 'error', error: err.message, code: 'rate-limited', resetAt: err.resetAt };
  if (err instanceof SkillError || err instanceof GitHubError) return { path, status: 'error', error: err.message };
  if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') return { path, status: 'error', error: 'já existe um arquivo com esse nome' };
  console.error(err);
  return { path, status: 'error', error: 'erro interno' };
}

const hashesOf = (pkg: Package): Record<string, string> => Object.fromEntries(pkg.files.map((f) => [f.path, f.sha256]));

/** A pasta de skills existe, não é link e fica onde se espera (o realpath é o caminho esperado; sem caixa no Windows). */
async function ensureRoot(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const st = await fs.lstat(root);
  if (st.isSymbolicLink()) throw new SkillError('a pasta de skills é um link (symlink ou junction): não instalo por ele');
  const real = await fs.realpath(root);
  const expected = path.join(await fs.realpath(path.dirname(root)), path.basename(root));
  const same = process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected;
  if (!same) throw new SkillError('a pasta de skills fica atrás de um link: não instalo por ele');
  return root;
}

/** Pasta de staging no MESMO volume (fora da raiz de skills): `<pai>/.myco-staging/<rand>`. */
async function newStage(target: InstallTarget): Promise<{ root: string; dir: string }> {
  const root = path.join(path.dirname(target.root), '.myco-staging');
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, randomUUID());
  await fs.mkdir(dir); // sem `recursive`: nunca reaproveita uma pasta que já existe
  return { root, dir };
}

async function writePackage(dir: string, files: PackFile[], meta: OriginMeta): Promise<void> {
  for (const f of files) {
    const file = path.join(dir, ...f.path.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, f.bytes, { flag: 'wx' });
  }
  await fs.writeFile(path.join(dir, ORIGIN), JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' });
}

export async function readOrigin(dir: string): Promise<OriginMeta | null> {
  const file = path.join(dir, ORIGIN);
  const st = await fs.lstat(file).catch(() => null);
  if (!st?.isFile()) return null;
  try {
    const parsed = OriginSchema.safeParse(JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')));
    return parsed.success && originValid(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

/** sha256 de cada arquivo da pasta (menos o metadado da raiz). Link ou coisa que não é arquivo vira 'link'. */
async function hashDir(root: string, rel = '', out = new Map<string, string>()): Promise<Map<string, string>> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && e.name === ORIGIN) continue;
    if (e.isDirectory()) await hashDir(root, p, out);
    else if (e.isFile()) out.set(p, sha256(await fs.readFile(path.join(root, p))));
    else out.set(p, 'link');
  }
  return out;
}

/** `modified` = algum arquivo com sha diferente, faltando ou sobrando (ou um link). Sem metadado, a skill não é da origem. */
export async function skillOriginStatus(dir: string): Promise<{ meta: OriginMeta | null; modified: boolean }> {
  const meta = await readOrigin(dir);
  if (!meta) return { meta: null, modified: false };
  const now = await hashDir(dir);
  const has = (p: string) => Object.prototype.hasOwnProperty.call(meta.files, p);
  const modified = Object.entries(meta.files).some(([p, h]) => now.get(p) !== h) || [...now.keys()].some((p) => !has(p));
  return { meta, modified };
}

/** As pastas com `.myco-origin.json` de um escopo (sem hashear: para a checagem diária). */
async function originsIn(target: InstallTarget): Promise<Array<{ name: string; dir: string; meta: OriginMeta }>> {
  const entries = await fs.readdir(target.root, { withFileTypes: true }).catch(() => []);
  const out: Array<{ name: string; dir: string; meta: OriginMeta }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || !nameOk(target.scope, e.name)) continue;
    const dir = path.join(target.root, e.name);
    const meta = await readOrigin(dir);
    if (meta) out.push({ name: e.name, dir, meta });
  }
  return out;
}

/** As skills com origem no GitHub de um escopo, para a lista de ficha/tela (com modificada ou não). */
export async function githubSkillsIn(target: InstallTarget) {
  const out = [];
  for (const { name, dir } of await originsIn(target)) {
    const { meta, modified } = await skillOriginStatus(dir);
    if (meta) out.push({ name, origin: { url: meta.url, ref: meta.ref, sha: meta.sha, installedAt: meta.installedAt }, modified });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** A pasta da skill para atualizar ou voltar: sem link (pasta ou SKILL.md) e dentro da raiz do escopo. */
async function skillDirOf(target: InstallTarget, name: string): Promise<string> {
  if (!nameOk(target.scope, name)) throw new SkillError('nome de skill inválido');
  const dir = path.join(target.root, name);
  const st = await fs.lstat(dir).catch(() => null);
  if (!st) throw new SkillError('skill não encontrada');
  if (st.isSymbolicLink()) throw new SkillError('a pasta da skill é um link (symlink ou junction): não atualizo por ele');
  if (!st.isDirectory()) throw new SkillError('skill não encontrada');
  const md = await fs.lstat(path.join(dir, 'SKILL.md')).catch(() => null);
  if (!md) throw new SkillError('essa pasta não tem SKILL.md');
  if (!md.isFile()) throw new SkillError('o SKILL.md é um link: não atualizo por ele');
  if (!isInside(await fs.realpath(target.root), await fs.realpath(dir))) throw new SkillError('a skill não fica dentro da pasta de skills do escopo');
  return dir;
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

export type CheckUpdateResult =
  | { upToDate: true; sha?: string }
  | {
      upToDate: false;
      name: string;
      /** De onde veio a versão nova (do metadado): a tela mostra antes da aprovação. */
      source: { url: string; owner: string; repo: string; ref: string; path: string };
      ref: string;
      fromSha: string;
      toSha: string;
      digest: string;
      localModified: boolean;
      diff: DiffItem[];
      frontmatter: Array<{ key: string; before: unknown; after: unknown }>;
      alerts: Alert[];
    };

/**
 * Verifica se há versão nova (ref → sha). Mesmo sha = em dia. Sha novo com a mesma árvore da pasta = em dia também
 * (o repo mudou, a skill não): só anota o `checkedSha`. Senão baixa, valida e devolve o diff contra a versão GRAVADA hoje.
 */
export async function checkUpdate(i: { target: InstallTarget; name: string }, deps: SkillDeps = {}): Promise<CheckUpdateResult> {
  const gh = deps.gh ?? github;
  const dir = await skillDirOf(i.target, i.name);
  const meta = await readOrigin(dir);
  if (!meta) throw new SkillError('essa skill não veio do GitHub');
  const latest = await gh.resolveRef(meta.owner, meta.repo, meta.ref);
  if (latest.sha === meta.sha) return { upToDate: true };
  const tree = full(await gh.tree(meta.owner, meta.repo, latest.sha));
  const treeSha = treeShaOf(tree, meta.path);
  if (treeSha === null) throw new SkillError('a pasta sumiu na versão nova do repositório');
  if (treeSha === meta.treeSha) {
    await writeOrigin(dir, { ...meta, checkedSha: latest.sha });
    return { upToDate: true, sha: latest.sha };
  }
  const pkg = await buildPackage(gh, { owner: meta.owner, repo: meta.repo, sha: latest.sha }, meta.path, tree, i.name);
  const local = await skillOriginStatus(dir);
  return {
    upToDate: false,
    name: i.name,
    source: { url: meta.url, owner: meta.owner, repo: meta.repo, ref: meta.ref, path: meta.path },
    ref: meta.ref,
    fromSha: meta.sha,
    toSha: latest.sha,
    digest: pkg.digest,
    localModified: local.modified,
    diff: await diffPackage(dir, pkg.files),
    frontmatter: frontmatterDiff(await readText(path.join(dir, 'SKILL.md')), pkg.skillMd),
    alerts: pkg.alerts,
  };
}

async function writeOrigin(dir: string, meta: OriginMeta): Promise<void> {
  await writeAtomic(path.join(dir, ORIGIN), JSON.stringify(meta, null, 2) + '\n');
}

/** Diff de TODOS os arquivos: adicionado, removido ou mudado. Texto leva patch; binário leva só tamanho e hash. */
async function diffPackage(dir: string, files: PackFile[]): Promise<DiffItem[]> {
  const before = await hashDir(dir);
  const after = new Map(files.map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: DiffItem[] = [];
  for (const p of paths) {
    const oldHash = before.get(p);
    const nf = after.get(p);
    if (oldHash === undefined && nf) out.push(diffItem(p, 'added', null, nf));
    else if (oldHash !== undefined && !nf) out.push(diffItem(p, 'removed', await readOld(dir, p, oldHash), null));
    else if (nf && oldHash !== nf.sha256) out.push(diffItem(p, 'changed', await readOld(dir, p, oldHash), nf));
  }
  return out;
}

async function readOld(dir: string, p: string, hash: string | undefined): Promise<Buffer | null> {
  if (hash === undefined || hash === 'link') return null;
  return fs.readFile(path.join(dir, p));
}

function diffItem(p: string, status: DiffItem['status'], before: Buffer | null, after: PackFile | null): DiffItem {
  const binary = (before !== null && isBinary(before)) || (after?.binary ?? false);
  if (binary) {
    return {
      path: p,
      status,
      binary: true,
      ...(before && { before: { size: before.length, sha256: sha256(before) } }),
      ...(after && { after: { size: after.size, sha256: after.sha256 } }),
    };
  }
  const text = unifiedDiff(before?.toString('utf8') ?? '', after ? after.bytes.toString('utf8') : '');
  return { path: p, status, binary: false, patch: text.patch, tooLarge: text.tooLarge };
}

/** Patch unificado por linhas (LCS simples, 3 linhas de contexto). Grande demais (células ou bytes): sem patch. */
export function unifiedDiff(oldText: string, newText: string): { patch: string | null; tooLarge: boolean } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > LCS_CELLS) return { patch: null, tooLarge: true };
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  const at = (i: number, j: number) => dp[i * w + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: ' ', s: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ t: '-', s: a[i] ?? '' });
      i++;
    } else {
      ops.push({ t: '+', s: b[j] ?? '' });
      j++;
    }
  }
  for (; i < n; i++) ops.push({ t: '-', s: a[i] ?? '' });
  for (; j < m; j++) ops.push({ t: '+', s: b[j] ?? '' });

  const CTX = 3;
  const changed: number[] = [];
  ops.forEach((o, k) => {
    if (o.t !== ' ') changed.push(k);
  });
  if (changed.length === 0) return { patch: '', tooLarge: false };
  const ranges: Array<[number, number]> = [];
  for (const k of changed) {
    const s = Math.max(0, k - CTX);
    const e = Math.min(ops.length - 1, k + CTX);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = e;
    else ranges.push([s, e]);
  }
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let po = 0;
  let pn = 0;
  ops.forEach((o, k) => {
    oldAt[k] = po;
    newAt[k] = pn;
    if (o.t !== '+') po++;
    if (o.t !== '-') pn++;
  });
  let out = '';
  for (const [s, e] of ranges) {
    let oc = 0;
    let nc = 0;
    for (let k = s; k <= e; k++) {
      const t = ops[k]?.t;
      if (t !== '+') oc++;
      if (t !== '-') nc++;
    }
    out += `@@ -${(oldAt[s] ?? 0) + 1},${oc} +${(newAt[s] ?? 0) + 1},${nc} @@\n`;
    for (let k = s; k <= e; k++) {
      const o = ops[k];
      if (o) out += `${o.t}${o.s}\n`;
    }
    if (out.length > LIMITS.diffBytes) return { patch: null, tooLarge: true };
  }
  return { patch: out, tooLarge: false };
}

/** As chaves do frontmatter que mudaram (antes e depois). */
function frontmatterDiff(oldMd: string | null, newMd: string): Array<{ key: string; before: unknown; after: unknown }> {
  const a = oldMd === null ? {} : parseFrontmatter(oldMd).data;
  const b = parseFrontmatter(newMd).data;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .map((k) => ({ key: k, before: a[k] ?? null, after: b[k] ?? null }));
}

/** Troca a skill pela versão `sha` (confirmada pelo digest da prévia). Backup da atual antes; `modified` exige `overwriteLocal`. */
export async function applyUpdate(
  i: { target: InstallTarget; name: string; sha: string; digest: string; overwriteLocal?: boolean | undefined },
  deps: SkillDeps = {},
): Promise<{ name: string; sha: string; digest: string; backup: string }> {
  const gh = deps.gh ?? github;
  const dir = await skillDirOf(i.target, i.name);
  const meta = await readOrigin(dir);
  if (!meta) throw new SkillError('essa skill não veio do GitHub');
  if (i.sha === meta.sha) throw new SkillError('a skill já está nessa versão');
  const local = await skillOriginStatus(dir);
  if (local.modified && i.overwriteLocal !== true) {
    throw new SkillConflictError('a skill foi mexida aqui depois da instalação: confirme para trocar mesmo assim (a versão atual fica num backup)', 'modified');
  }
  const tree = full(await gh.tree(meta.owner, meta.repo, i.sha));
  const pkg = await buildPackage(gh, { owner: meta.owner, repo: meta.repo, sha: i.sha }, meta.path, tree, i.name);
  if (pkg.digest !== i.digest) throw new SkillConflictError('a versão nova mudou desde a prévia: confira de novo', 'changed');
  const treeSha = treeShaOf(tree, meta.path);
  if (treeSha === null) throw new SkillError('a pasta sumiu na versão nova do repositório');
  const backup = await backupCopy(dir, i.target, i.name, deps);
  const next: OriginMeta = { ...meta, sha: i.sha, treeSha, installedAt: new Date().toISOString(), files: hashesOf(pkg), previous: { sha: meta.sha, backup } };
  delete next.checkedSha;
  const stage = await newStage(i.target);
  try {
    await writePackage(stage.dir, pkg.files, next);
  } catch (err) {
    await fs.rm(stage.dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await swap(dir, stage.dir, stage.root);
  return { name: i.name, sha: i.sha, digest: pkg.digest, backup };
}

/** Volta à versão anterior (a de `previous.backup`). A atual vai para um backup, então volta de novo se quiser. */
export async function rollback(i: { target: InstallTarget; name: string }, deps: SkillDeps = {}): Promise<{ name: string; sha: string }> {
  const dir = await skillDirOf(i.target, i.name);
  const meta = await readOrigin(dir);
  if (!meta) throw new SkillError('essa skill não veio do GitHub');
  if (!meta.previous) throw new SkillError('essa skill não tem versão anterior para voltar');
  const old = await checkedBackup(meta.previous.backup, i.target, i.name, deps);
  const current = await backupCopy(dir, i.target, i.name, deps);
  const stage = await newStage(i.target);
  try {
    await fs.cp(meta.previous.backup, stage.dir, { recursive: true, dereference: false });
    await writeOrigin(stage.dir, { ...old, previous: { sha: meta.sha, backup: current } });
  } catch (err) {
    await fs.rm(stage.dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await swap(dir, stage.dir, stage.root);
  return { name: i.name, sha: old.sha };
}

/**
 * A cópia da versão anterior, só se for mesmo uma cópia nossa: dentro da pasta de backups (realpath), com o nome do escopo e
 * da skill, e com exatamente os arquivos que o metadado dela registra (nem a mais, nem a menos, nada mudado, nada link).
 * Uma cópia de versão que tinha mudanças locais não bate com o registro e não volta por aqui (o caminho fica na mensagem).
 */
async function checkedBackup(backup: string, target: InstallTarget, name: string, deps: SkillDeps): Promise<OriginMeta> {
  const realRoot = await fs.realpath(deps.backupRoot ?? BACKUP_ROOT).catch(() => null);
  const realBackup = await fs.realpath(backup).catch(() => null);
  const st = await fs.lstat(backup).catch(() => null);
  const inside = !!realRoot && !!realBackup && isInside(realRoot, realBackup) && !!st?.isDirectory();
  if (!inside || !path.basename(backup).startsWith(`${target.scope}-${safe(target.owner)}-${name}-`)) {
    throw new SkillError('a cópia da versão anterior não está na pasta de backups do Club: não volto por ela');
  }
  const old = await readOrigin(backup);
  if (!old) throw new SkillError('a cópia da versão anterior não está mais na pasta de backups');
  const now = await hashDir(backup);
  const exact = now.size === Object.keys(old.files).length && Object.entries(old.files).every(([p, h]) => now.get(p) === h);
  if (!exact) {
    throw new SkillError(`o backup da versão anterior não bate com o registro dele (foi mexido, ou a versão tinha mudanças locais): não volto por ele. Cópia em ${backup}`);
  }
  return old;
}

async function backupCopy(dir: string, target: InstallTarget, name: string, deps: SkillDeps): Promise<string> {
  const dest = path.join(deps.backupRoot ?? BACKUP_ROOT, `${target.scope}-${safe(target.owner)}-${name}-${stamp()}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(dir, dest, { recursive: true, errorOnExist: true, dereference: false });
  return dest;
}

/** Troca em três passos: a atual vai para o staging, a nova entra no lugar; se a entrada falha, a atual volta. */
async function swap(dir: string, stageDir: string, stageRoot: string): Promise<void> {
  const old = path.join(stageRoot, `${randomUUID()}-old`);
  try {
    await fs.rename(dir, old);
  } catch (err) {
    // Sem trocar nada (no Windows, arquivo aberto dá EPERM/EBUSY): o staging não fica órfão.
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY') throw new SkillError('a skill está em uso (feche as conversas que a usam e tente de novo)');
    throw err;
  }
  try {
    await fs.rename(stageDir, dir);
  } catch (err) {
    await fs.rename(old, dir).catch(() => undefined);
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(old, { recursive: true, force: true }).catch(() => undefined);
}

export interface CheckStatus {
  latestSha: string;
  hasUpdate: boolean;
  checkedAt: string;
}
interface ChecksFile {
  lastRun: number;
  results: Record<string, CheckStatus>;
}

/**
 * Selo de atualização: no máximo uma varredura por dia (`lastRun` em checks.json). Agrupa por repositório e ref (um
 * resolveRef por grupo), compara o treeSha da pasta e grava. Nunca baixa conteúdo nem aplica. Para no primeiro limite
 * de consultas e tenta no próximo dia.
 */
export class UpdateChecker {
  private readonly gh: GitHubClient;
  private readonly targets: () => Promise<InstallTarget[]>;
  private readonly now: () => number;
  private readonly file: string;
  private running: Promise<boolean> | null = null;

  constructor(o: { gh?: GitHubClient; targets: () => Promise<InstallTarget[]>; now?: () => number; file?: string }) {
    this.gh = o.gh ?? github;
    this.targets = o.targets;
    this.now = o.now ?? Date.now;
    this.file = o.file ?? path.join(MYCO_HOME, 'cache', 'github', 'checks.json');
  }

  /** Roda se passou um dia desde a última varredura. Devolve se rodou. */
  runIfDue(): Promise<boolean> {
    if (!this.running) {
      this.running = this.read()
        .then(async (state) => {
          if (this.now() - state.lastRun < DAY_MS) return false;
          await this.run();
          return true;
        })
        .finally(() => {
          this.running = null;
        });
    }
    return this.running;
  }

  async run(): Promise<void> {
    const state = await this.read();
    const results = { ...state.results };
    const groups = new Map<string, { owner: string; repo: string; ref: string; skills: Array<{ target: InstallTarget; name: string; meta: OriginMeta }> }>();
    for (const target of await this.targets()) {
      for (const { name, meta } of await originsIn(target)) {
        const key = `${meta.owner}/${meta.repo}@${meta.ref}`;
        const g = groups.get(key) ?? { owner: meta.owner, repo: meta.repo, ref: meta.ref, skills: [] };
        g.skills.push({ target, name, meta });
        groups.set(key, g);
      }
    }
    let stopped = false;
    for (const g of groups.values()) {
      if (stopped) break;
      try {
        const latest = await this.gh.resolveRef(g.owner, g.repo, g.ref);
        let tree: GitHubTree | null = null;
        for (const s of g.skills) {
          let hasUpdate = false;
          if (latest.sha !== s.meta.sha) {
            if (!tree) tree = await this.gh.tree(g.owner, g.repo, latest.sha);
            if (tree.truncated) continue;
            const ts = treeShaOf(tree, s.meta.path);
            if (ts === null) continue;
            hasUpdate = ts !== s.meta.treeSha;
          }
          results[`${s.target.scope}:${s.target.owner}:${s.name}`] = { latestSha: latest.sha, hasUpdate, checkedAt: new Date(this.now()).toISOString() };
        }
      } catch (err) {
        if (err instanceof GitHubRateLimited) stopped = true;
      }
    }
    await writeAtomic(this.file, JSON.stringify({ lastRun: this.now(), results }, null, 2) + '\n').catch(() => undefined);
  }

  /** O selo de uma skill (o último resultado gravado), ou null se ainda não foi checada. */
  async statusOf(scope: SkillScopeName, owner: string, name: string): Promise<{ available: boolean; latestSha: string; checkedAt: string } | null> {
    const c = (await this.read()).results[`${scope}:${owner}:${name}`];
    return c ? { available: c.hasUpdate, latestSha: c.latestSha, checkedAt: c.checkedAt } : null;
  }

  private async read(): Promise<ChecksFile> {
    const raw = await fs.readFile(this.file, 'utf8').then(
      (t) => {
        try {
          return JSON.parse(t) as Partial<ChecksFile> | null;
        } catch {
          return null;
        }
      },
      () => null,
    );
    return {
      lastRun: typeof raw?.lastRun === 'number' ? raw.lastRun : 0,
      results: raw?.results && typeof raw.results === 'object' ? raw.results : {},
    };
  }
}
