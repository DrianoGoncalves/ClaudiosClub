import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { GitOpts, GitRun } from '../autoCommit';

// O git e o gh do MCP de git (gitMcp.ts), que rodam FORA da sandbox do Codex, com as credenciais do dono. Tudo que o repositório poderia
// transformar em execução de código (hooks, fsmonitor, filtros, helpers de credencial, ssh, alias, pager, editor, diff externo) fica de fora:
//   - ambiente por lista de permitidos (nada de GIT_*, MYCO_TOKEN, CLAUDE*, ANTHROPIC*, GH_HOST de fora);
//   - `-c` na linha de comando (vale mais que qualquer arquivo de config): hooks numa pasta vazia, sem fsmonitor, sem gc em segundo plano;
//   - a config LOCAL do repositório (e a da worktree) só pode ter as chaves de `LOCAL_OK`: qualquer outra recusa a chamada, citando a chave.
// A config global e a do sistema são do dono (é delas que vêm a identidade e o helper de credencial) e valem como estão.

export class GitMcpError extends Error {}

/** Branches em que nunca se dá push (comparação sem diferenciar maiúsculas), além do branch padrão do `origin`. */
export const PROTECTED_BRANCHES = ['main', 'master'];

/** Variáveis do ambiente do MCP que seguem para o git e o gh (nome em minúsculas). O resto sai. */
const ENV_KEEP = new Set(
  [
    'PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
    'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ALLUSERSPROFILE', 'COMPUTERNAME', 'USERDOMAIN',
    'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'SSH_AUTH_SOCK', 'GH_TOKEN', 'GITHUB_TOKEN',
  ].map((k) => k.toLowerCase()),
);

export interface SafeEnvOptions {
  /** O ambiente de onde sai a lista de permitidos (os testes trocam; padrão process.env). */
  parentEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Protocolos que o git aceita (`GIT_ALLOW_PROTOCOL`). Padrão `https:ssh`; os testes de push num remoto local acrescentam `file`. */
  allowProtocols?: string;
}

/** O ambiente do git e do gh: só a lista de permitidos, a pasta pessoal refeita pelo sistema e as travas. */
export function safeEnv(o: SafeEnvOptions = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(o.parentEnv ?? process.env)) if (v !== undefined && ENV_KEEP.has(k.toLowerCase())) out[k] = v;
  // O MCP pode nascer com um ambiente enxuto (o Codex filtra o dos MCPs): o Git Credential Manager e o gh precisam da pasta pessoal.
  const home = o.home ?? os.homedir();
  out.HOME ??= home;
  if ((o.platform ?? process.platform) === 'win32') {
    out.USERPROFILE ??= home;
    out.APPDATA ??= path.join(home, 'AppData', 'Roaming');
    out.LOCALAPPDATA ??= path.join(home, 'AppData', 'Local');
  }
  return {
    ...out,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: o.allowProtocols ?? 'https:ssh',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_HOST: 'github.com',
    NO_COLOR: '1',
  };
}

/** As chaves que a config local de um repositório pode ter (como `git config --list` as escreve: seção e variável em minúsculas). */
const LOCAL_OK: RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|symlinks|autocrlf|eol|safecrlf|precomposeunicode|longpaths)$/,
  /^extensions\.worktreeconfig$/,
  /^remote\..+\.(url|fetch|pushurl)$/,
  /^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base)$/,
  /^user\.(name|email|signingkey)$/,
  /^submodule\..+\.(url|active|branch)$/,
];

/**
 * Recusa o repositório cuja config local (ou da worktree) tem chave fora de `LOCAL_OK`: `filter.*`, `credential.*`, `core.fsmonitor`,
 * `core.sshCommand`, `url.*.insteadOf`, `include*`, `alias.*`, `diff.*.command`, `remote.*.vcs`… viram código rodando com as credenciais do dono.
 */
export async function assertSafeConfig(run: GitRun, cwd: string): Promise<void> {
  const raw = await run(cwd, ['config', '--list', '--show-scope', '-z']);
  // Com `-z`, cada entrada é `escopo NUL chave NL valor NUL` (chave sem valor: sem o NL).
  const parts = raw.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i]!;
    if (scope !== 'local' && scope !== 'worktree') continue;
    const entry = parts[i + 1]!;
    const nl = entry.indexOf('\n');
    const key = (nl < 0 ? entry : entry.slice(0, nl)).toLowerCase();
    if (!LOCAL_OK.some((re) => re.test(key))) {
      throw new GitMcpError(`a config do repositório tem "${key.slice(0, 80)}" (escopo ${scope}), que pode rodar código com as suas credenciais: recuso. O dono precisa tirá-la do .git/config.`);
    }
  }
}

export interface SafeToolsOptions extends SafeEnvOptions {
  /** Pasta vazia dos hooks (`core.hooksPath`): nenhum hook roda. */
  hooksDir: string;
  gitBin?: string;
  ghBin?: string;
}

/** O que vai antes de todo comando do git. */
const gitOverrides = (hooksDir: string): string[] => [
  '-c', `core.hooksPath=${hooksDir.replace(/\\/g, '/')}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.pager=cat',
  '-c', 'gc.auto=0',
  '-c', 'maintenance.auto=false',
  '-c', 'diff.ignoreSubmodules=all',
  '-c', 'status.ignoreSubmodules=all',
];

/** O git e o gh com as travas acima. O `GitRun` serve também ao `commitPaths`/`inspectRepo` do autoCommit. */
export function createSafeTools(o: SafeToolsOptions): { git: GitRun; gh: (args: string[], input?: string) => Promise<string> } {
  const exec = (bin: string, args: string[], cwd: string, opts: GitOpts = {}): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { cwd, env: { ...safeEnv(o), ...opts.env }, windowsHide: true, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error([stderr, stdout].map((s) => s.trim()).filter(Boolean).join('\n') || err.message));
          else resolve(stdout);
        },
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input ?? '');
    });
  const overrides = gitOverrides(o.hooksDir);
  return {
    git: (cwd, args, opts) => exec(o.gitBin ?? 'git', [...overrides, '-C', cwd, ...args], cwd, opts),
    // O gh roda numa pasta sem repositório (a vazia dos hooks): com `-R` e `--head` ele não precisa do git do projeto, e a config local não o alcança.
    gh: (args, input) => exec(o.ghBin ?? 'gh', args, o.hooksDir, { input, timeoutMs: 60_000 }),
  };
}

const NAME = '[A-Za-z0-9_.-]{1,100}';
const GITHUB_URLS = [
  new RegExp(`^https://github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?$`),
  new RegExp(`^ssh://git@github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`),
];

/** `owner/repo` de uma URL do GitHub (https, `git@github.com:` ou `ssh://git@github.com/`, sem usuário e senha na URL), ou null para qualquer outra. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  for (const re of GITHUB_URLS) {
    const m = re.exec(url.trim());
    if (m && !/^\.+$/.test(m[1]!) && !/^\.+$/.test(m[2]!)) return { owner: m[1]!, repo: m[2]! };
  }
  return null;
}

/** Nome de branch aceito para o push: letras, números, `.`, `_`, `-` e `/`; sem `..`, sem `//`, sem prefixo de ref e sem `.lock` no fim. */
export function validBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !/[./]$/.test(name) &&
    !/\.lock(\/|$)/.test(name) &&
    !/^(refs|heads|tags|remotes)\//i.test(name)
  );
}

export const isProtectedBranch = (name: string, defaultBranch: string | null): boolean =>
  [...PROTECTED_BRANCHES, ...(defaultBranch ? [defaultBranch] : [])].some((p) => p.toLowerCase() === name.toLowerCase());

/** Falha de rede que vale tentar de novo (DNS, conexão, timeout, 5xx); rejeição do servidor, autenticação e o resto não. */
export const isTransientGitError = (err: unknown): boolean =>
  /could not resolve host|no such host|connection (timed out|reset|refused)|timed out|i\/o timeout|handshake timeout|rpc failed|early eof|unexpected disconnect|remote end hung up|http 5\d\d|returned error: 5\d\d|temporary failure|network is unreachable/i.test(
    (err as Error)?.message ?? '',
  );

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
}

/** Disjuntor do processo: depois de 3 falhas de rede seguidas, recusa por 60 s (o MCP vive uma conversa; o estado não passa disso). */
const breaker = { fails: 0, openUntil: 0 };
const BREAKER_MS = 60_000;
export const resetBreaker = (): void => {
  breaker.fails = 0;
  breaker.openUntil = 0;
};

/**
 * Chamada de rede (push, gh): até 3 tentativas com espera exponencial (1 s, 2 s) e jitter, só para falha de rede. Rejeição do servidor e
 * erro de autenticação voltam na hora. `now` entra por parâmetro para os testes.
 */
export async function withNetworkRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}, now: () => number = Date.now): Promise<T> {
  if (now() < breaker.openUntil) throw new GitMcpError('a rede falhou várias vezes seguidas: tente de novo em cerca de 1 minuto');
  const attempts = o.attempts ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = o.rand ?? Math.random;
  for (let i = 1; ; i++) {
    try {
      const out = await fn();
      breaker.fails = 0;
      return out;
    } catch (err) {
      if (!isTransientGitError(err)) throw err;
      if (++breaker.fails >= 3) breaker.openUntil = now() + BREAKER_MS;
      if (i >= attempts) throw err;
      await sleep((o.baseMs ?? 1000) * 2 ** (i - 1) * (0.8 + rand() * 0.4));
    }
  }
}
