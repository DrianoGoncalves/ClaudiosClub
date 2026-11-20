import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { GIT_MCP_NAME, GIT_READ_TOOLS, GIT_WRITE_TOOLS, type Autonomy } from '../../shared/model';
import { commitPaths, inspectRepo, isConflict, statusOf, summarize, type GitRun, type StatusEntry } from '../autoCommit';
import { writeAtomic } from '../atomicWrite';
import { findSecret } from '../chat/secrets';
import { cleanRel, isBlockedRel } from '../projectFiles';
import { ROOT } from '../root';
import {
  GitMcpError,
  assertSafeConfig,
  createSafeTools,
  githubRepoOf,
  isProtectedBranch,
  validBranchName,
  withNetworkRetry,
  type SafeToolsOptions,
} from './gitSafe';

// MCP de git do Claudio’s Club, nos dois motores: um servidor stdio (JSON-RPC por linha) que roda FORA da sandbox do Codex. Lá o `.git` é só leitura
// e não há rede nem as credenciais do dono, então o terminal do Codex não commita nem dá push; este MCP é a porta, com operações fechadas:
//   leitura: git_status, git_diff, git_log
//   escrita: git_commit (só os caminhos pedidos), git_push (origin no GitHub, branch que não é main/master, nunca force), git_pr_criar
// Não existe reset, rebase, checkout, clean, config, merge, argumento livre nem shell. Hooks do repositório não rodam e a config local do repositório
// só vale com as chaves da lista (ver gitSafe.ts). O que a conversa pode fazer vem de `<run>/git-policy.json`, relido a cada chamada.
//
// Sem o SDK oficial de propósito (ver ftpMcp.ts): o protocolo usado é pequeno: initialize, ping, tools/list e tools/call.

export { GIT_MCP_NAME, GIT_READ_TOOLS, GIT_WRITE_TOOLS };
export const GIT_TOOLS_NAMES = ['git_status', 'git_diff', 'git_log', 'git_commit', 'git_push', 'git_pr_criar'] as const;
type ToolName = (typeof GIT_TOOLS_NAMES)[number];

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const OUT_MAX = 60_000;
const COMMIT_FILES_MAX = 500;
const SCAN_FILE_MAX = 2 * 1024 * 1024;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

// ---- política da conversa ----

/** O que o Claudio’s Club grava para o MCP em `<run>/git-policy.json` (na abertura da conversa e a cada troca de autonomia). */
export interface GitPolicy {
  engine: 'claude' | 'codex';
  /** O acesso `myco-git` da ficha (`mcpAccess`); `off` nem sobe o MCP. */
  access: 'free' | 'ask' | 'readonly';
  autonomy: Autonomy;
  /** Conversa de revisão de tarefa: só leitura. */
  review: boolean;
}

export const GIT_POLICY_FILE = 'git-policy.json';

const AUTONOMIES: Autonomy[] = ['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'];

/** Lê a política; qualquer problema (sem arquivo, JSON ruim, valor fora da lista) devolve null, que vale só leitura. */
export async function readGitPolicy(runDir: string): Promise<GitPolicy | null> {
  let raw: unknown;
  try {
    raw = JSON.parse((await fs.readFile(path.join(runDir, GIT_POLICY_FILE), 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const engine = p.engine === 'claude' || p.engine === 'codex' ? p.engine : null;
  const access = p.access === 'free' || p.access === 'ask' || p.access === 'readonly' ? p.access : null;
  const autonomy = AUTONOMIES.find((a) => a === p.autonomy);
  if (!engine || !access || !autonomy || typeof p.review !== 'boolean') return null;
  return { engine, access, autonomy, review: p.review };
}

export async function writeGitPolicy(runDir: string, policy: GitPolicy): Promise<void> {
  await fs.mkdir(runDir, { recursive: true });
  await writeAtomic(path.join(runDir, GIT_POLICY_FILE), JSON.stringify(policy));
}

/** A autonomia mudou numa conversa aberta: o MCP confere a nova já na próxima chamada. Sem política (a conversa não tem o MCP de git), nada. */
export async function updateGitPolicyAutonomy(runDir: string, autonomy: Autonomy): Promise<void> {
  const p = await readGitPolicy(runDir);
  if (p && p.autonomy !== autonomy) await writeGitPolicy(runDir, { ...p, autonomy });
}

export type GitLevel = 'read' | 'commit' | 'all';

/**
 * O que a conversa pode fazer agora. O Claude decide o resto pelo próprio fluxo de permissão (as de escrita nunca vão em `--allowedTools`:
 * pede em "aceitar edições", roda em auto e sem travas). O Codex não pergunta: em "pede tudo" a sandbox é de só leitura, em "aceitar edições"
 * só o commit local (push e PR são ação para fora), e push e PR só em auto e sem travas. `why`: por que não é `all` (a mensagem da recusa).
 */
export function gitGrant(p: GitPolicy | null): { level: GitLevel; why: string } {
  if (!p) return { level: 'read', why: 'a política desta conversa não chegou: só leitura' };
  if (p.review) return { level: 'read', why: 'conversa de revisão: só leitura' };
  if (p.access === 'readonly') return { level: 'read', why: 'o acesso ao myco-git está como só leitura na ficha; o dono muda na ficha' };
  if (p.access === 'ask' && p.engine === 'codex') return { level: 'read', why: 'no Codex o "pede antes" do myco-git vira só leitura (não há como perguntar); o dono muda na ficha' };
  if (p.autonomy === 'plan') return { level: 'read', why: 'em modo plano só leitura; o dono muda a autonomia na ficha' };
  if (p.engine === 'claude') return { level: 'all', why: '' };
  if (p.autonomy === 'manual') return { level: 'read', why: 'em "pede tudo" a sandbox do Codex é só leitura; o dono muda a autonomia na ficha' };
  if (p.autonomy === 'acceptEdits') return { level: 'commit', why: '' };
  return { level: 'all', why: '' };
}

const RANK: Record<GitLevel, number> = { read: 0, commit: 1, all: 2 };

/** A mensagem de recusa de uma ação que pede `want` quando a conversa tem `have`; null = pode. `action`: "commit", "push" ou "abrir PR". */
export function gitRefusal(p: GitPolicy | null, want: GitLevel, action: string): string | null {
  const g = gitGrant(p);
  if (RANK[g.level] >= RANK[want]) return null;
  if (g.level === 'commit') return `${action} exige autonomia auto ou sem travas; o dono muda na ficha`;
  return `${action} não é permitido agora: ${g.why}`;
}

// ---- o servidor ----

export interface GitMcpOptions {
  /** Pasta do projeto principal. */
  projectPath: string;
  /** Pasta da conversa (o projeto ou a worktree): é onde o git roda. Nenhuma ferramenta aceita outra. */
  root: string;
  /** Pasta da conversa em `run/` (política, pasta vazia dos hooks, temporários). */
  runDir: string;
  /** O git e o gh (os testes trocam; padrão: os de gitSafe, sem hooks e com ambiente controlado). */
  tools?: { git: GitRun; gh: (args: string[], input?: string) => Promise<string> };
  /** Opções do git seguro (os testes liberam o protocolo `file` para um remoto local e trocam o gh). */
  safe?: Partial<SafeToolsOptions>;
  /** Espera entre tentativas de rede (os testes não esperam). */
  sleep?: (ms: number) => Promise<void>;
}

const cap = (text: string, max = OUT_MAX): string => (text.length > max ? `${text.slice(0, max)}\n… (cortado em ${max} caracteres)` : text);
const maskUrl = (u: string): string => u.replace(/\/\/[^@/\s]*@/, '//***@').slice(0, 200);

export function createGitMcp(opts: GitMcpOptions) {
  const hooksDir = path.join(opts.runDir, 'nohooks');
  const tools = opts.tools ?? createSafeTools({ hooksDir, ...opts.safe });
  const { git, gh } = tools;
  const root = opts.root;
  const retry = { sleep: opts.sleep };

  /** A política de agora, a conferência da config do repositório e o repositório: o começo de toda ferramenta. */
  async function begin(want: GitLevel, action: string): Promise<void> {
    const refusal = gitRefusal(await readGitPolicy(opts.runDir), want, action);
    if (refusal) throw new GitMcpError(refusal);
    await fs.mkdir(hooksDir, { recursive: true });
    await assertSafeConfig(git, root);
  }

  /** O caminho (arquivo ou pasta) como o git o vê, relativo à pasta da conversa. */
  function relPath(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 400 || CONTROL.test(raw)) throw new GitMcpError('caminho inválido (texto, até 400 caracteres, sem caracteres de controle)');
    let rel: string;
    try {
      rel = cleanRel(raw);
    } catch {
      throw new GitMcpError(`caminho inválido (absoluto, com ".." ou com NUL): ${raw.slice(0, 100)}`);
    }
    if (!rel) throw new GitMcpError('o caminho é a raiz do projeto: informe arquivos ou pastas');
    if (rel.split('/').some((s) => s.toLowerCase() === '.git')) throw new GitMcpError('caminho dentro de .git não vale');
    return rel;
  }

  function relList(raw: unknown, max: number, required: boolean): string[] {
    if (raw === undefined && !required) return [];
    if (!Array.isArray(raw) || (required && raw.length === 0)) throw new GitMcpError('informe "caminhos": uma lista de arquivos ou pastas do projeto');
    if (raw.length > max) throw new GitMcpError(`no máximo ${max} caminhos por chamada`);
    return [...new Set(raw.map(relPath))];
  }

  async function status(): Promise<string> {
    await begin('read', 'git_status');
    const out = await git(root, ['status', '--short', '--branch', '--untracked-files=normal', '--ignore-submodules=all']);
    return cap(out.trim() || '(sem saída: não é um repositório git?)');
  }

  async function diff(args: { caminhos?: unknown; staged?: unknown }): Promise<string> {
    const paths = relList(args.caminhos, 100, false);
    await begin('read', 'git_diff');
    const out = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', ...(args.staged === true ? ['--cached'] : []), ...(paths.length ? ['--', ...paths] : [])], { env: LITERAL });
    return cap(out.trim() || '(sem diferenças)');
  }

  async function log(args: { n?: unknown }): Promise<string> {
    const n = typeof args.n === 'number' && Number.isInteger(args.n) ? Math.min(Math.max(args.n, 1), 50) : 10;
    await begin('read', 'git_log');
    const out = await git(root, ['log', `-n${n}`, '--no-color', '--no-decorate', '--no-show-signature', '--date=short', '--pretty=format:%h %ad %an: %s']);
    return cap(out.trim() || '(sem commits)');
  }

  /** O texto que o commit acrescenta num arquivo (linhas novas), para conferir segredo: os hooks do projeto não rodam aqui. */
  async function addedText(e: StatusEntry): Promise<string> {
    if (e.x === 'D' || e.y === 'D') return '';
    if (e.x === '?') {
      const file = path.join(root, e.path);
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile() || st.size > SCAN_FILE_MAX) return '';
      const text = await fs.readFile(file, 'utf8');
      return text.includes('\0') ? '' : text;
    }
    const d = await git(root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0', '--ignore-submodules=all', '--', e.path], { env: LITERAL }).catch(() => '');
    return d
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
  }

  async function commit(args: { mensagem?: unknown; caminhos?: unknown }): Promise<string> {
    if (typeof args.mensagem !== 'string' || !args.mensagem.trim() || args.mensagem.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(args.mensagem)) {
      throw new GitMcpError('informe "mensagem": texto não vazio, até 4000 caracteres');
    }
    const rels = relList(args.caminhos, 100, true);
    await begin('commit', 'commit');
    const repo = await inspectRepo(root, git);
    if (!repo.ok) throw new GitMcpError(repo.note);
    const found = await statusOf(root, repo.prefix, rels, git);
    const take: string[] = [];
    const left: string[] = [];
    const scan: StatusEntry[] = [];
    for (const e of found.values()) {
      if (isBlockedRel(e.path)) left.push(`${e.path} (barrado: segredo, dependência ou caminho inválido)`);
      else if (isConflict(e)) left.push(`${e.path} (em conflito)`);
      else {
        take.push(e.path);
        scan.push(e);
      }
    }
    if (take.length > COMMIT_FILES_MAX) throw new GitMcpError(`${take.length} arquivos: o limite é ${COMMIT_FILES_MAX} por commit`);
    if (!take.length) {
      throw new GitMcpError(left.length ? `nada a commitar: ${left.slice(0, 5).join(', ')}` : 'nada a commitar: os caminhos não têm mudança no git (já commitados ou desfeitos)');
    }
    for (const e of scan) {
      const hit = findSecret(await addedText(e));
      if (hit) throw new GitMcpError(`${hit.label} nas linhas novas de ${e.path}: tire o segredo antes (o commit sai sem os hooks do projeto, então a conferência é esta). Nada foi commitado.`);
    }
    let made: Awaited<ReturnType<typeof commitPaths>>;
    try {
      made = await commitPaths(root, repo.head, take, args.mensagem.trim(), git);
    } catch (err) {
      throw new GitMcpError(`o git recusou o commit: ${summarize(err)}`);
    }
    if (!made) throw new GitMcpError('os arquivos já estão no HEAD: nada a commitar');
    const subject = args.mensagem.trim().split(/\r?\n/)[0]!.slice(0, 120);
    return [
      `commit ${made.sha} (${take.length} ${take.length === 1 ? 'arquivo' : 'arquivos'}): ${subject}`,
      ...(left.length ? [`ficou de fora: ${left.slice(0, 10).join(', ')}`] : []),
      ...(made.problem ? [`atenção: ${made.problem}`] : []),
    ].join('\n');
  }

  /** O branch padrão do origin (`origin/HEAD`), ou null. */
  async function defaultBranch(): Promise<string | null> {
    const ref = (await git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).catch(() => '')).trim();
    return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null;
  }

  /** O branch do push ou do PR: o pedido, ou o atual. Nunca main/master (nem o padrão do origin) e sempre um nome válido. */
  async function branchOf(raw: unknown, action: string): Promise<string> {
    let name: string;
    if (raw === undefined) {
      name = (await git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
      if (!name) throw new GitMcpError(`o HEAD está destacado: informe "branch" (um nome novo) para ${action}`);
    } else if (typeof raw === 'string') name = raw; // sem trim: espaço e quebra de linha no nome são recusados, não limpos
    else throw new GitMcpError('"branch" precisa ser texto');
    if (!validBranchName(name)) throw new GitMcpError(`nome de branch inválido: ${name.slice(0, 60)} (letras, números, ".", "_", "-" e "/")`);
    if (isProtectedBranch(name, await defaultBranch())) {
      throw new GitMcpError(`${action} em ${name} não é permitido: informe "branch" com um nome novo (diferente de main/master e do branch padrão)`);
    }
    await git(root, ['check-ref-format', `refs/heads/${name}`]).catch(() => {
      throw new GitMcpError(`nome de branch inválido para o git: ${name.slice(0, 60)}`);
    });
    return name;
  }

  /** `owner/repo` do `origin` (a URL de push, já com `insteadOf`): só github.com, e só o remote `origin` que o repositório já tem. */
  async function originRepo(): Promise<{ owner: string; repo: string }> {
    const url = (await git(root, ['remote', 'get-url', '--push', 'origin']).catch(() => '')).trim();
    if (!url) throw new GitMcpError('o repositório não tem o remote "origin"');
    const repo = githubRepoOf(url);
    if (!repo) throw new GitMcpError(`o origin (${maskUrl(url)}) não é um repositório do github.com (https, git@github.com: ou ssh://git@github.com/, sem usuário e senha na URL): só esse é aceito`);
    return repo;
  }

  async function push(args: { branch?: unknown }): Promise<string> {
    await begin('all', 'push');
    const branch = await branchOf(args.branch, 'push');
    await originRepo();
    const sha = (await git(root, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
    if (!sha) throw new GitMcpError('o repositório ainda não tem nenhum commit');
    try {
      // O refspec é sempre HEAD:refs/heads/<branch>, montado aqui: sem `+`, sem `--force`, sem apagar, sem tags, sem submódulos, sem hook de pre-push.
      await withNetworkRetry(() => git(root, ['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', `HEAD:refs/heads/${branch}`], { timeoutMs: 120_000 }), retry);
    } catch (err) {
      const why = summarize(err);
      if (/non-fast-forward|fetch first|rejected/i.test(why)) throw new GitMcpError(`o remoto recusou: ${branch} já tem commits que este não tem (sem force). Use outro nome de branch. ${why}`.slice(0, 400));
      throw new GitMcpError(`o push falhou: ${why}`);
    }
    return `push ok: origin/${branch} @ ${sha}`;
  }

  async function prCriar(args: { titulo?: unknown; corpo?: unknown; base?: unknown; branch?: unknown; draft?: unknown }): Promise<string> {
    if (typeof args.titulo !== 'string' || !args.titulo.trim() || args.titulo.length > 256 || CONTROL.test(args.titulo)) throw new GitMcpError('informe "titulo": texto de uma linha, até 256 caracteres');
    if (args.corpo !== undefined && (typeof args.corpo !== 'string' || args.corpo.length > 20_000)) throw new GitMcpError('"corpo" precisa ser texto de até 20000 caracteres');
    const titulo = args.titulo.replace(/\s+/g, ' ').trim();
    await begin('all', 'abrir PR');
    const head = await branchOf(args.branch, 'abrir PR');
    const { owner, repo } = await originRepo();
    let base: string;
    if (args.base === undefined) base = (await defaultBranch()) ?? 'main';
    else if (typeof args.base === 'string' && validBranchName(args.base)) base = args.base;
    else throw new GitMcpError('"base" inválida (nome de branch: letras, números, ".", "_", "-" e "/")');
    if (base === head) throw new GitMcpError('a base e o branch da PR são o mesmo');
    const body = typeof args.corpo === 'string' && args.corpo.trim() ? args.corpo : titulo;
    // O repositório vem do origin (nunca do pedido) e cada opção vai como `--chave=valor`: um valor que começa com "-" não vira opção.
    const ghArgs = ['pr', 'create', '-R', `github.com/${owner}/${repo}`, `--head=${head}`, `--base=${base}`, `--title=${titulo}`, '--body-file=-', ...(args.draft === true ? ['--draft'] : [])];
    let out: string;
    try {
      out = await withNetworkRetry(() => gh(ghArgs, body), retry);
    } catch (err) {
      throw new GitMcpError(`o gh recusou a PR: ${summarize(err)}`);
    }
    const url = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
    return `PR aberta (merge só pelo dono): ${url.slice(0, 300)}`;
  }

  const handlers: Record<ToolName, (a: Record<string, unknown>) => Promise<string>> = {
    git_status: () => status(),
    git_diff: diff,
    git_log: log,
    git_commit: commit,
    git_push: push,
    git_pr_criar: prCriar,
  };

  async function callTool(name: ToolName, args: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: true }> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError: true as const }) });
    if (args === undefined || args === null) args = {};
    if (typeof args !== 'object' || Array.isArray(args)) return text('argumentos inválidos: esperava um objeto', true);
    try {
      return text(await handlers[name](args as Record<string, unknown>));
    } catch (err) {
      // Erro nosso já vem em palavras; o resto, sem detalhe (pode ter caminho interno).
      return text(err instanceof GitMcpError ? err.message : 'falha inesperada no git', true);
    }
  }

  type Msg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  const reply = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  /** Uma mensagem JSON-RPC; devolve a resposta, ou null (notificação, ou resposta do cliente). */
  async function handle(raw: unknown): Promise<object | null> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(null, -32600, 'Invalid Request');
    const m = raw as Msg;
    if (!('method' in m) && ('result' in m || 'error' in m)) return null; // resposta do cliente: este servidor não pergunta nada
    const isRequest = 'id' in m && m.id !== null && (typeof m.id === 'string' || typeof m.id === 'number');
    if (typeof m.method !== 'string') return isRequest ? fail(m.id, -32600, 'Invalid Request') : null;
    if (!isRequest) return null; // notifications/initialized, cancelled…
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion;
        return reply(m.id, {
          protocolVersion: typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: GIT_MCP_NAME, version: VERSION },
          instructions:
            'Git do Claudio’s Club para esta pasta de trabalho. Leitura: git_status, git_diff, git_log. Escrita: git_commit (só os caminhos informados), git_push (origin no GitHub, branch que não é main/master, nunca force) e git_pr_criar (a PR fica aberta; o merge é do dono). Sem hooks do projeto. Não há reset, rebase, checkout, merge nem comando livre.',
        });
      }
      case 'ping':
        return reply(m.id, {});
      case 'tools/list':
        return reply(m.id, { tools: TOOLS });
      case 'tools/call': {
        const name = m.params?.name;
        if (typeof name !== 'string' || !(GIT_TOOLS_NAMES as readonly string[]).includes(name)) return fail(m.id, -32602, `ferramenta desconhecida: ${String(name).slice(0, 60)}`);
        return reply(m.id, await callTool(name as ToolName, m.params?.arguments));
      }
      default:
        return fail(m.id, -32601, `método não suportado: ${m.method.slice(0, 60)}`);
    }
  }

  return { handle, callTool };
}

const PATHS = { type: 'array', items: { type: 'string' }, description: 'Arquivos ou pastas do projeto (relativos à pasta de trabalho), sem "..".' };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS: Array<{ name: ToolName; description: string; inputSchema: Record<string, unknown>; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }> = [
  {
    name: 'git_status',
    description: 'Branch, distância do remoto e arquivos alterados (staged e não staged) da pasta de trabalho, em formato curto.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
  },
  {
    name: 'git_diff',
    description: 'Diff dos arquivos alterados (sem diff externo nem conversores). Com `staged: true`, o que está no índice. Arquivo novo e sem commit só aparece no git_status.',
    inputSchema: { type: 'object', properties: { caminhos: PATHS, staged: { type: 'boolean', description: 'Só o que está staged.' } } },
    annotations: READ,
  },
  {
    name: 'git_log',
    description: 'Os últimos commits do branch atual (hash, data, autor e assunto). `n` de 1 a 50 (padrão 10).',
    inputSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 50 } } },
    annotations: READ,
  },
  {
    name: 'git_commit',
    description:
      'Commit LOCAL só dos `caminhos` informados (arquivos ou pastas), como estão no disco; o que outra conversa ou o dono deixou staged não entra e continua staged. Sem hooks do projeto: o Club recusa o commit se achar um segredo nas linhas novas. Arquivos de segredo (.env, chaves) e conflitos ficam de fora.',
    inputSchema: { type: 'object', properties: { mensagem: { type: 'string', description: 'A mensagem do commit (até 4000 caracteres).' }, caminhos: PATHS }, required: ['mensagem', 'caminhos'] },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'git_push',
    description:
      'Envia o HEAD para o `origin` (GitHub) no branch `branch` (padrão: o branch atual), sem force e sem apagar nada. Nunca main/master: se o branch atual for um deles, informe um nome novo. Exige autonomia auto ou sem travas.',
    inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'Nome do branch remoto (novo ou seu); nunca main/master.' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'git_pr_criar',
    description:
      'Abre uma PR no GitHub do `origin` (branch já enviado com git_push) para a `base` (padrão: o branch padrão do repositório). A PR fica aberta: o merge é só do dono. Exige autonomia auto ou sem travas.',
    inputSchema: {
      type: 'object',
      properties: {
        titulo: { type: 'string', description: 'Título (uma linha, até 256 caracteres).' },
        corpo: { type: 'string', description: 'Descrição (Markdown, até 20000 caracteres).' },
        base: { type: 'string', description: 'Branch de destino da PR (padrão: o padrão do repositório).' },
        branch: { type: 'string', description: 'Branch de origem da PR (padrão: o atual); o mesmo nome usado no git_push.' },
        draft: { type: 'boolean', description: 'Abrir como rascunho.' },
      },
      required: ['titulo'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

/** Lê `--chave valor` dos argumentos. */
function argOf(argv: string[], key: string): string | undefined {
  const i = argv.indexOf(key);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Sobe o MCP no stdin/stdout (uma mensagem JSON por linha). Log só no stderr. */
export async function runGitMcpStdio(argv: string[], input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const projectPath = argOf(argv, '--project');
  const root = argOf(argv, '--root');
  const runDir = argOf(argv, '--run');
  if (!projectPath || !path.isAbsolute(projectPath) || !root || !path.isAbsolute(root) || !runDir || !path.isAbsolute(runDir)) {
    throw new Error('uso: --project <pasta absoluta> --root <pasta absoluta> --run <pasta absoluta>');
  }
  // A pasta vazia dos hooks e os temporários (o índice temporário do commit) ficam na pasta da conversa, que a sandbox nega.
  const hooksDir = path.join(runDir, 'nohooks');
  await fs.rm(hooksDir, { recursive: true, force: true });
  await fs.mkdir(hooksDir, { recursive: true });
  const tmp = path.join(runDir, 'tmp');
  await fs.mkdir(tmp, { recursive: true });
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = tmp;
  const server = createGitMcp({ projectPath, root, runDir });
  const pending = new Set<Promise<void>>();
  const write = (obj: object | null) => {
    if (obj) output.write(JSON.stringify(obj) + '\n');
  };
  for await (const raw of createInterface({ input, crlfDelay: Infinity })) {
    const line = raw.replace(/^﻿/, ''); // BOM (pipe do PowerShell 5.1)
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Em paralelo: um push lento não segura o ping. Duas escritas ao mesmo tempo no mesmo repositório são arbitradas pelo próprio git (index.lock).
    const p = server.handle(msg).then(write, (err: unknown) => {
      process.stderr.write(`[myco-git] ${err instanceof Error ? err.name : 'erro'}\n`);
      const id = (msg as { id?: unknown })?.id;
      if (id !== undefined) write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    });
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
}

// ---- como o funcionário sobe este MCP ----

/** Pacote gerado pelo build (scripts/bundle.ts). Só o pacote, nunca o .ts pelo tsx: o launch o copia para a pasta da conversa. */
export const GIT_MCP_BUNDLE = path.join(ROOT, 'dist', 'git-mcp.mjs');

/** O pacote existe? (Sem ele o MCP não entra e a ficha diz "indisponível".) */
export const gitBundleExists = (bundle: string = GIT_MCP_BUNDLE): boolean => existsSync(bundle);

/** O servidor que a conversa sobe: `bundle` (a cópia na pasta da conversa), a pasta de trabalho e a pasta da conversa em `run/`. Nenhum segredo. */
export function gitMcpServer(o: { bundle: string; projectPath: string; root: string; runDir: string }): { command: string; args: string[] } {
  return { command: process.execPath, args: [o.bundle, '--project', o.projectPath, '--root', o.root, '--run', o.runDir] };
}
