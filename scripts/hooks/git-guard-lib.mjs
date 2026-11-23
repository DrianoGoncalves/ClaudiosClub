// A regra do hook git-guard.mjs: git que descarta mudança não commitada, ou move o HEAD por cima dela, é barrado no checkout PRINCIPAL do projeto
// (o incidente de 21/11: um `git reset --hard` de uma conversa apagou o trabalho não commitado de outras tarefas). Leitura do texto do comando
// (Bash ou PowerShell), sem rodar nada do comando; só `git rev-parse|config` para saber em que repositório ele cai.
//
// O que é o checkout principal: o `--absolute-git-dir` da pasta onde o comando roda é o do projeto, ou a árvore de trabalho que ele escreve (`--work-tree`,
// ou a própria pasta quando `--git-dir`/GIT_DIR é dado) é a dele. `--git-dir` e `--work-tree` relativos contam a partir da pasta de depois dos `-C`. A worktree própria de um funcionário
// (`<projeto>/.claude/worktrees/...`, git-dir em `.git/worktrees/...`) e qualquer outro repositório (um temporário de teste) têm outro git-dir: liberados.
// Projeto que não é repositório git: libera tudo (não há o que proteger). Pasta que o texto não deixa resolver (`$x`, `%x%`, curinga): barra.
//
// Não é barreira completa: string montada (`$g='git'; & $g reset --hard`), interpretador (python, node) e script escapam. É residual documentado
// (ver o relatório da t-0ccbff): o hook pega a forma direta e as variantes óbvias (caminho até o git, `-C`, encadeamento, bash -c, cmd /c,
// powershell -Command e -enc, env, xargs, Start-Process, alias do git).

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_DEPTH = 5;
const GIT_TIMEOUT_MS = 4000;
const WAY = 'Peça ao usuário para rodar ou use uma worktree própria (git worktree add).';

const out = (permissionDecision, reason) => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason: `[MyCo] ${reason}` },
});

/** A mensagem da recusa: o que foi barrado, por quê e a saída. */
function denial(hit) {
  const what = `"${hit.label}"`;
  const risk = 'No checkout principal ele descarta o trabalho não commitado de outras conversas.';
  if (hit.where === 'unresolved') return `Barrado: ${what} numa pasta que não deu para resolver (variável ou curinga; use o caminho literal). ${risk} ${WAY}`;
  if (hit.where === 'error') return `Barrado: ${what}: não deu para conferir em que repositório ele roda (o git não respondeu ou o projeto não foi informado). ${risk} ${WAY}`;
  return `Barrado: ${what} no checkout principal do projeto: descarta o trabalho não commitado de outras conversas. ${WAY}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Texto do comando
// ---------------------------------------------------------------------------------------------------------------------------------

/** Separadores de comando, fora de aspas: quebra de linha, `;`, `&`, `|` (e os duplos), a crase e o que abre ou fecha um grupo. */
const SEPARATORS = new Set([';', '&', '|', '\n', '\r', '(', ')', '{', '}', '`']);

/** Tira o corpo de heredoc (`<<EOF`) e de here-string do PowerShell (`@' ... '@`): é texto, não comando (mensagem de commit). */
function stripLiteralBlocks(text) {
  const out = [];
  let end = null;
  for (const line of text.split(/\r?\n/)) {
    if (end !== null) {
      if (end.ps ? line.trimStart().startsWith(end.token) : line.trim() === end.token) end = null;
      continue;
    }
    out.push(line);
    const ps = /@(['"])\s*$/.exec(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line);
    if (ps) end = { ps: true, token: `${ps[1]}@` };
    else if (heredoc) end = { ps: false, token: heredoc[2] };
  }
  return out.join('\n');
}

/**
 * O texto em itens, em ordem: palavras de um comando (array), `(` e `)` (para o `cd` de um subshell não vazar) e `{ sub }` (o `$(...)` ou crase
 * dentro de aspa dupla, que roda). Aspas simples e duplas agrupam (e saem); `\` não é escape (caminho do Windows).
 */
function commands(text) {
  const items = [];
  let words = [];
  let word = '';
  let has = false;
  let quote = '';
  let raw = '';
  const endWord = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) items.push(words);
    words = [];
  };
  // A continuação de linha (crase no PowerShell, barra no bash) junta as linhas.
  for (const ch of stripLiteralBlocks(text).replace(/(?:`|\\)\r?\n/g, ' ')) {
    if (quote) {
      if (ch === quote) {
        if (quote === '"') for (const m of raw.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) items.push({ sub: m[1] ?? m[2] });
        quote = '';
        raw = '';
      } else {
        word += ch;
        raw += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (SEPARATORS.has(ch)) {
      // `2>&1`, `>&2`, `*>&1`: o `&` é de redirecionamento, não separa comando.
      if (ch === '&' && /(?:^|\D)\d*\*?>$/.test(word)) word += ch;
      else {
        endCommand();
        if (ch === '(' || ch === ')') items.push(ch);
      }
    } else if (/\s/.test(ch)) endWord();
    else {
      word += ch;
      has = true;
    }
  }
  endCommand();
  return items;
}

/** O nome do programa: depois da última barra, minúsculo, sem extensão de executável. */
const nameOf = (w) =>
  String(w)
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|com|ps1)$/, '');

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Prefixos que só repassam o comando (e as palavras de controle do shell que vêm antes dele). */
const PASS_THROUGH = new Set(['time', 'call', 'command', 'exec', 'nohup', 'env', 'sudo', 'doas', 'builtin', 'xargs', 'nice', 'export', 'set', 'then', 'else', 'elif', 'do', 'if', 'while', 'until', '!']);
/** Flags desses prefixos que levam um valor na palavra seguinte (`env -u NOME`, `xargs -n 1`). */
const PASS_VALUE_FLAGS = new Set(['-u', '-g', '-n', '-I', '-P', '-L', '-E', '-a', '-d']);
const CD = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const PUSH = new Set(['pushd', 'push-location']);
const POP = new Set(['popd', 'pop-location']);
const SH = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
const PS = new Set(['powershell', 'pwsh']);
const EVAL = new Set(['eval', 'iex', 'invoke-expression']);
const START = new Set(['start-process', 'saps', 'start']);
/** Parâmetros do PowerShell que levam um valor: não são do git. */
const PS_VALUE_FLAGS = new Set(['-executionpolicy', '-ep', '-workingdirectory', '-wd', '-windowstyle', '-w', '-verb', '-configurationname', '-inputformat', '-outputformat', '-version']);
const PS_COMMAND = /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i;
const PS_ENCODED = /^-e(n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;
const B64 = /^[A-Za-z0-9+/=]{16,}$/;
/** Dá para o comando ser um PowerShell com texto codificado: sem isso e sem a palavra `git`, o hook nem lê o comando. */
export const MAY_BE_GIT = /git|(?:^|\s)[-/]e[a-z]*\s+[A-Za-z0-9+/=]{16,}/i;

// ---------------------------------------------------------------------------------------------------------------------------------
// Pasta e repositório
// ---------------------------------------------------------------------------------------------------------------------------------

/** Pasta que o texto não deixa resolver (variável, curinga). */
const UNRESOLVED = null;

/** `p` a partir de `base`; null quando o texto tem variável (`$x`, `%x%`), curinga ou `~usuario`. */
function resolveDir(base, p) {
  if (base === UNRESOLVED || typeof p !== 'string') return UNRESOLVED;
  if (/[$%*?[]/.test(p) || /^~[^/\\]/.test(p)) return UNRESOLVED;
  let target = p;
  if (target === '~' || /^~[/\\]/.test(target)) target = path.join(os.homedir(), target.slice(1));
  // Git Bash no Windows: /c/Users/x é C:/Users/x.
  if (process.platform === 'win32') target = target.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  return path.resolve(base, target);
}

/** O caminho comparável: real quando existe, barras normais e, no Windows, minúsculo. */
function norm(p) {
  let r = p;
  try {
    r = realpathSync.native(p);
  } catch {
    // não existe: compara como veio
  }
  r = path.resolve(r).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** O ambiente do git do hook: o que o git lê de variável não pode vir do nosso (o `-C`, `--git-dir` e `--work-tree` vão explícitos). */
function gitEnv() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  return env;
}

function spawnGit(args) {
  return spawnSync('git', args, { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true, env: gitEnv() });
}

/** Roda um git no lugar efetivo: a pasta (`-C` já aplicados) e o `--git-dir` e o `--work-tree` do comando, já absolutos (ver `effective`). */
function runGit(eff, args) {
  return spawnGit(['-C', eff.dir, ...(eff.gitDir ? ['--git-dir', eff.gitDir] : []), ...(eff.workTree ? ['--work-tree', eff.workTree] : []), ...args]);
}

/** O git-dir (comparável) que um `rev-parse --absolute-git-dir` dá, null se não é repositório, 'error' se o git não respondeu. */
function gitDirOf(args) {
  // O hook é um processo por chamada, então a memória vale uma chamada (nos testes, o processo todo: os repositórios não mudam de git-dir).
  const key = JSON.stringify(args);
  let got = GITDIR_MEMO.get(key);
  if (got === undefined) {
    const r = spawnGit([...args, 'rev-parse', '--absolute-git-dir']);
    got = r.error ? 'error' : r.status !== 0 ? null : norm(String(r.stdout).trim());
    if (got !== 'error') GITDIR_MEMO.set(key, got);
  }
  return got;
}

/**
 * Onde o git do comando cai: 'main' (o checkout principal do projeto), 'other' (worktree própria, outro repositório, pasta que não é repositório,
 * projeto sem git), 'unresolved' (a pasta não se resolve) ou 'error' (o git não respondeu a tempo ou o hook não sabe qual é o projeto).
 * São dois lugares, e basta um ser o principal: o repositório que o git usa (o `--git-dir`, ou o achado a partir da pasta) e a árvore de trabalho que
 * ele escreve (o `--work-tree`; sem ele, com `--git-dir`/GIT_DIR dado, a própria pasta). `git --work-tree=<principal> reset --hard` numa pasta de outro
 * repositório não toca no índice do principal, mas reescreve os arquivos dele.
 */
function whereIs(eff, project) {
  const pg = project.gitDir();
  if (pg === 'error') return 'error';
  if (pg === null) return 'other';
  if (eff.dir === UNRESOLVED) return 'unresolved';
  const tree = eff.workTree ?? (eff.gitDir ? eff.dir : undefined);
  const probes = [
    ['-C', eff.dir, ...(eff.gitDir ? ['--git-dir', eff.gitDir] : []), ...(eff.workTree ? ['--work-tree', eff.workTree] : [])],
    ...(tree === undefined ? [] : [['-C', tree]]),
  ];
  let error = false;
  for (const probe of probes) {
    const got = gitDirOf(probe);
    if (got === 'error') error = true;
    else if (got === pg) return 'main';
  }
  return error ? 'error' : 'other';
}
const GITDIR_MEMO = new Map();
const PROJECT_MEMO = new Map();

/** O projeto: `gitDir()` é o git-dir dele (comparável), null se não é repositório (ou o git não existe), 'error' sem caminho do projeto. */
function projectOf(projectPath) {
  return {
    gitDir() {
      if (typeof projectPath !== 'string' || projectPath === '') return 'error';
      if (!PROJECT_MEMO.has(projectPath)) {
        const r = spawnGit(['-C', projectPath, 'rev-parse', '--absolute-git-dir']);
        if (r.error) return 'error';
        PROJECT_MEMO.set(projectPath, r.status !== 0 ? null : norm(String(r.stdout).trim()));
      }
      return PROJECT_MEMO.get(projectPath);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// O que cada subcomando do git descarta
// ---------------------------------------------------------------------------------------------------------------------------------

const BLOCK = { block: true };

/** `a` é a forma (também abreviada, como o git aceita) da opção longa `name`. */
const longIs = (a, name) => a.startsWith('--') && a.length > 2 && name.startsWith(a.slice(2).split('=')[0]);
const head = (args) => {
  const i = args.indexOf('--');
  return i === -1 ? args : args.slice(0, i);
};
/** As letras de um grupo de flags curtas (`-fd`) até uma que leva valor (`-bnome`); `next`: o valor é a palavra seguinte. */
function cluster(a, valueLetters) {
  const letters = new Set();
  let next = false;
  for (let k = 1; k < a.length; k++) {
    if (valueLetters.includes(a[k])) {
      next = k === a.length - 1;
      break;
    }
    letters.add(a[k]);
  }
  return { letters, next };
}
const isCluster = (a) => /^-[A-Za-z]/.test(a);

function classifyCheckout(rest) {
  const dd = rest.indexOf('--');
  const opts = dd === -1 ? rest : rest.slice(0, dd);
  let creating = false;
  const pos = [];
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a === '-') pos.push(a); // o branch anterior
    else if (a.startsWith('--')) {
      if (longIs(a, 'force') || longIs(a, 'patch') || longIs(a, 'ours') || longIs(a, 'theirs')) return BLOCK;
      const valued = ['orphan', 'conflict', 'pathspec-from-file'].find((n) => longIs(a, n));
      if (valued === 'orphan') creating = true;
      if (valued && !a.includes('=')) i++;
    } else if (isCluster(a)) {
      const { letters, next } = cluster(a, 'bB');
      if (letters.has('f') || letters.has('p')) return BLOCK;
      if (/[bB]/.test(a)) creating = true;
      if (next) i++;
    } else pos.push(a);
  }
  if (dd !== -1) return BLOCK; // `checkout [<ref>] -- <caminho>` (o `--` sozinho também: `xargs -I{} git checkout -- {}` perde o caminho no corte do `{}`)
  if (creating || pos.length === 0) return null; // `checkout -b nome [<início>]`
  if (pos.length > 1) return BLOCK; // `checkout <ref> <caminho>`
  const a = pos[0];
  if (a === '-') return null;
  if (/^[.:]|[*?[]/.test(a)) return BLOCK; // `.`, `./x`, `:/`, glob: caminho
  return { ref: a }; // um argumento só: branch/tag/commit (troca de branch) ou caminho; o git diz qual
}

function classifySwitch(rest) {
  for (const a of head(rest)) {
    if (a.startsWith('--')) {
      if (longIs(a, 'force') || longIs(a, 'discard-changes')) return BLOCK;
    } else if (isCluster(a) && cluster(a, 'cC').letters.has('f')) return BLOCK;
  }
  return null;
}

function classifyRestore(rest) {
  let staged = false;
  let worktree = false;
  const opts = head(rest);
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    if (a.startsWith('--')) {
      if (longIs(a, 'staged')) staged = true;
      else if (longIs(a, 'worktree')) worktree = true;
      else if (longIs(a, 'source') && !a.includes('=')) i++;
    } else if (isCluster(a)) {
      const { letters, next } = cluster(a, 's');
      if (letters.has('S')) staged = true;
      if (letters.has('W')) worktree = true;
      if (next) i++;
    }
  }
  return staged && !worktree ? null : BLOCK; // sem `--staged`, restaura a árvore de trabalho
}

function classifyClean(rest) {
  for (const a of head(rest)) {
    if (a.startsWith('--') ? longIs(a, 'dry-run') : isCluster(a) && cluster(a, 'e').letters.has('n')) return null;
  }
  return BLOCK;
}

function classifyStash(rest) {
  let action;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a === '-m' || (longIs(a, 'message') && !a.includes('='))) i++;
      continue;
    }
    action = a;
    break;
  }
  if (action === undefined) return BLOCK; // `git stash` sozinho é `push`
  return ['list', 'show', 'store'].includes(action) ? null : BLOCK;
}

function classifyRm(rest) {
  for (const a of head(rest)) {
    if (a.startsWith('--') ? longIs(a, 'cached') || longIs(a, 'dry-run') : isCluster(a) && cluster(a, '').letters.has('n')) return null;
  }
  return BLOCK;
}

function classifyReset(rest) {
  return head(rest).some((a) => ['hard', 'merge', 'keep'].some((n) => longIs(a, n))) ? BLOCK : null;
}

/** `checkout-index -f` sobrescreve o arquivo que existe (sem `-f` o git recusa). */
function classifyCheckoutIndex(rest) {
  return head(rest).some((a) => (a.startsWith('--') ? longIs(a, 'force') : isCluster(a) && cluster(a, '').letters.has('f'))) ? BLOCK : null;
}

/** `read-tree -u` atualiza a árvore de trabalho para a árvore lida (sem `-u`, só o índice). */
function classifyReadTree(rest) {
  return head(rest).some((a) => !a.startsWith('--') && isCluster(a) && cluster(a, '').letters.has('u')) ? BLOCK : null;
}

const CLASSIFY = {
  reset: classifyReset, checkout: classifyCheckout, restore: classifyRestore, clean: classifyClean, stash: classifyStash, switch: classifySwitch, rm: classifyRm,
  'checkout-index': classifyCheckoutIndex, 'read-tree': classifyReadTree,
};

/** Subcomandos que o git não deixa um alias esconder: nem vale perguntar se há alias com esse nome. */
const BUILTIN = new Set([
  ...Object.keys(CLASSIFY),
  'add', 'am', 'apply', 'archive', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-ignore', 'cherry', 'cherry-pick', 'clone', 'commit', 'config', 'count-objects', 'describe',
  'diff', 'diff-index', 'diff-tree', 'difftool', 'fetch', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'grep', 'hash-object', 'help', 'init', 'log', 'ls-files', 'ls-remote', 'ls-tree',
  'maintenance', 'merge', 'merge-base', 'mergetool', 'mv', 'notes', 'pull', 'push', 'range-diff', 'rebase', 'reflog', 'remote', 'repack', 'replace', 'rev-list', 'rev-parse', 'revert',
  'shortlog', 'show', 'show-ref', 'sparse-checkout', 'status', 'submodule', 'symbolic-ref', 'tag', 'update-index', 'update-ref', 'version', 'whatchanged', 'worktree',
]);

// ---------------------------------------------------------------------------------------------------------------------------------
// O comando, segmento a segmento
// ---------------------------------------------------------------------------------------------------------------------------------

function noteEnv(st, name, value) {
  const n = name.toUpperCase();
  if (n === 'GIT_DIR' || n === 'GIT_WORK_TREE') st.env[n] = value;
}

/** As opções do git antes do subcomando: o `-C`, `--git-dir` e `--work-tree` que mudam onde ele cai; `pre` as devolve (alias reexpande com elas). */
function parseGit(args) {
  const g = { pre: [], cdirs: [], gitDir: undefined, workTree: undefined, sub: undefined, rest: [] };
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    const value = args[i + 1] ?? '';
    if (a === '-C') {
      g.cdirs.push(value);
      g.pre.push(a, value);
      i += 2;
    } else if (a === '-c' || ['--namespace', '--super-prefix', '--config-env'].includes(a)) {
      g.pre.push(a, value);
      i += 2;
    } else if (a === '--git-dir' || a === '--work-tree') {
      g[a === '--git-dir' ? 'gitDir' : 'workTree'] = value;
      g.pre.push(a, value);
      i += 2;
    } else {
      if (a.startsWith('--git-dir=')) g.gitDir = a.slice('--git-dir='.length);
      else if (a.startsWith('--work-tree=')) g.workTree = a.slice('--work-tree='.length);
      g.pre.push(a);
      i++;
    }
  }
  g.sub = args[i];
  g.rest = args.slice(i + 1);
  return g;
}

/**
 * O lugar onde o git do comando roda: a pasta atual com os `-C` em sequência e o `--git-dir` e o `--work-tree` (opção ou variável GIT_DIR/GIT_WORK_TREE).
 * Os dois relativos contam a partir dessa pasta (a de depois dos `-C`), como no git: `--git-dir=../.git --work-tree=..` numa subpasta é o checkout acima.
 * Saem absolutos. Texto que não se resolve (variável, curinga) em qualquer um deles deixa a pasta sem resolver.
 */
function effective(g, st) {
  let dir = st.dir;
  for (const c of g.cdirs) dir = resolveDir(dir, c);
  const given = [g.gitDir ?? st.env.GIT_DIR, g.workTree ?? st.env.GIT_WORK_TREE];
  const [gitDir, workTree] = given.map((v) => (v === undefined ? undefined : resolveDir(dir, v)));
  if (given.some((v, i) => v !== undefined && [gitDir, workTree][i] === UNRESOLVED)) dir = UNRESOLVED;
  return { dir, gitDir, workTree };
}

/** O alias `sub` dado por `-c alias.<sub>=<valor>` antes do subcomando (o último vale), ou undefined. */
function inlineAlias(pre, sub) {
  let value;
  for (let i = 0; i < pre.length - 1; i++) if (pre[i] === '-c' && pre[i + 1].startsWith(`alias.${sub}=`)) value = pre[i + 1].slice(`alias.${sub}=`.length).trim();
  return value;
}

const label = (sub, rest) => ['git', sub, ...rest.slice(0, 3)].join(' ').replace(/[\r\n]+/g, ' ').slice(0, 60);

function gitCommand(args, st, depth) {
  const g = parseGit(args);
  if (g.sub === undefined) return null;
  const classify = CLASSIFY[g.sub];
  const verdict = classify ? classify(g.rest) : null;
  if (!verdict) {
    if (BUILTIN.has(g.sub) || depth >= MAX_DEPTH) return null;
    // Nome que não é do git: pode ser um alias (`alias.nuke = reset --hard`, ou `!shell`), da config ou dado na linha (`git -c alias.nuke=… nuke`, que vale mais).
    const eff = effective(g, st);
    let value = inlineAlias(g.pre, g.sub);
    if (value === undefined) {
      if (eff.dir === UNRESOLVED) return null;
      const r = runGit(eff, ['config', '--get', `alias.${g.sub}`]);
      value = r.error || r.status !== 0 ? '' : String(r.stdout).trim();
    }
    if (!value) return null;
    if (value.startsWith('!')) return scan(value.slice(1), { ...st, dir: eff.dir, dirs: [...st.dirs], scopes: [...st.scopes] }, depth + 1);
    const words = commands(value).find(Array.isArray) ?? [];
    return gitCommand([...g.pre, ...words, ...g.rest], st, depth + 1);
  }
  const eff = effective(g, st);
  const where = whereIs(eff, st.project);
  if (where === 'other') return null;
  // `checkout <x>`: troca de branch se `x` é uma ref (branch, tag, commit; ou remota de mesmo nome); senão é caminho.
  if (verdict.ref !== undefined && where === 'main') {
    const r = runGit(eff, ['rev-parse', '--verify', '--quiet', `${verdict.ref}^{commit}`]);
    const remote = r.status === 0 ? r : runGit(eff, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${verdict.ref}^{commit}`]);
    if (!r.error && !remote.error && remote.status === 0) return null;
  }
  return { label: label(g.sub, g.rest), where };
}

/** O primeiro argumento de `cd`/`Set-Location` que é a pasta (`-Path`, `-LiteralPath`; `/d` do cmd e as flags de `cd` ficam de fora). */
function cdTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-(path|literalpath|lp)$/i.test(a)) return args[i + 1];
    if (a === '--') return args[i + 1];
    if (/^(-[LPe@]|\/d|-passthru)$/i.test(a)) continue;
    if (/^-stackname$/i.test(a)) {
      i++;
      continue;
    }
    return a;
  }
  return undefined;
}

/** O texto que um interpretador roda (`bash -c`, `cmd /c`, `powershell -Command`/`-enc`), ou null se o comando não é um. */
function payloadOf(name, args) {
  if (SH.has(name)) {
    // O texto do `-c` é a palavra seguinte; as outras são parâmetros do script. Junta tudo: `\"` dentro do texto (que a leitura de aspas não trata como escape) parte o texto em palavras.
    const i = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return i === -1 ? null : args.slice(i + 1).join(' ');
  }
  if (name === 'cmd') {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return i === -1 ? null : args.slice(i + 1).join(' ');
  }
  if (PS.has(name)) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (PS_COMMAND.test(args[i])) return args.slice(i + 1).join(' ');
      if (PS_ENCODED.test(args[i])) return B64.test(args[i + 1] ?? '') ? Buffer.from(args[i + 1], 'base64').toString('utf16le') : null;
      i += PS_VALUE_FLAGS.has(args[i].toLowerCase()) ? 2 : 1;
    }
    return args.slice(i).join(' ');
  }
  if (EVAL.has(name)) return args.join(' ');
  return null;
}

/** Um comando (as palavras dele): segue os prefixos, entende `cd`, o git, os interpretadores e o `Start-Process git`. */
function segment(words, prev, st, depth) {
  let i = 0;
  let passed = false;
  while (i < words.length) {
    const w = words[i];
    const n = nameOf(w);
    if (ENV_ASSIGNMENT.test(w)) {
      noteEnv(st, w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1));
      i++;
    } else if (PASS_THROUGH.has(n) || w === '.') {
      i++;
      passed = true;
      if (n === 'env' && words[i] === '-C') {
        st.dir = resolveDir(st.dir, words[i + 1]);
        i += 2;
      }
    } else if (passed && w.startsWith('-')) i += PASS_VALUE_FLAGS.has(w) ? 2 : 1;
    else if (n === 'timeout' && /^\d+[smhd]?$/.test(words[i + 1] ?? '')) i += 2;
    else break;
  }
  const first = words[i];
  if (first === undefined) return null;
  const args = words.slice(i + 1);
  // PowerShell: `$env:GIT_DIR = 'x'` e `$env:GIT_DIR='x'`.
  const ps = /^\$env:([A-Za-z_]\w*)(?:=(.*))?$/i.exec(first);
  if (ps) {
    noteEnv(st, ps[1], ps[2] ?? (args[0] === '=' ? (args[1] ?? '') : ''));
    return null;
  }
  const name = nameOf(first);
  if (CD.has(name)) {
    const target = cdTarget(args);
    if (PUSH.has(name)) st.dirs.push(st.dir);
    if (target !== undefined) {
      const next = resolveDir(st.dir, target);
      // Pasta que não existe: o `cd` falha e, com `;`, o comando seguinte roda na pasta de antes. Fica nela (o lado seguro).
      if (next === UNRESOLVED || existsSync(next)) st.dir = next;
    }
    return null;
  }
  if (POP.has(name)) {
    if (st.dirs.length) st.dir = st.dirs.pop();
    return null;
  }
  if (name === 'git') return gitCommand(args, st, depth);
  if (START.has(name)) {
    const at = args.findIndex((a) => nameOf(a) === 'git');
    if (at === -1) return null;
    const gitArgs = [];
    for (let k = at + 1; k < args.length; k++) {
      const a = args[k];
      if (/^-workingdirectory$/i.test(a)) st.dir = resolveDir(st.dir, args[++k]);
      else if (/^-(windowstyle|verb)$/i.test(a)) k++;
      else if (/^-(argumentlist|args|wait|nonewwindow|passthru|usenewenvironment|loadenvironment)$/i.test(a)) continue;
      else gitArgs.push(...a.split(','));
    }
    return gitCommand(gitArgs, st, depth + 1);
  }
  let payload = payloadOf(name, args);
  if (payload === '' && EVAL.has(name) && name !== 'eval') payload = prev.join(' '); // `'git reset --hard' | iex`
  if (payload === null || payload === '') return null;
  return scan(payload, st, depth + 1);
}

/** Lê o texto do comando e devolve o primeiro git destrutivo do checkout principal (`{ label, unresolved }`), ou null. */
function scan(text, st, depth) {
  if (depth > MAX_DEPTH) return /git/i.test(text) ? { label: 'git (comando aninhado demais para conferir)', where: 'error' } : null;
  let prev = [];
  for (const item of commands(text)) {
    let hit = null;
    if (item === '(') st.scopes.push(st.dir);
    else if (item === ')') {
      if (st.scopes.length) st.dir = st.scopes.pop();
    } else if (!Array.isArray(item)) hit = scan(item.sub, st, depth + 1);
    else {
      hit = segment(item, prev, st, depth);
      prev = item;
    }
    if (hit) return hit;
  }
  return null;
}

/**
 * Decide o evento de uma chamada de ferramenta (o JSON que o Claude Code e o Codex mandam no stdin). Devolve a resposta do hook (`deny`) ou null (não responde).
 * `projectPath`: a pasta do projeto, o checkout principal. Lança só em erro inesperado (quem chama responde deny).
 */
export function guard(ev, projectPath) {
  const tool = ev && typeof ev === 'object' ? ev.tool_name : undefined;
  // Sem nome de ferramenta, não dá para provar que não é Bash/PowerShell: bloqueia.
  if (typeof tool !== 'string') return out('deny', 'entrada da ferramenta sem nome: bloqueado por segurança.');
  if (!TOOLS.has(tool)) return null;
  const command = ev.tool_input?.command;
  if (typeof command !== 'string') return out('deny', 'comando sem texto: bloqueado por segurança.');
  if (!MAY_BE_GIT.test(command)) return null;
  const dir = typeof ev.cwd === 'string' && ev.cwd !== '' ? ev.cwd : process.cwd();
  const hit = scan(command, { dir, dirs: [], scopes: [], env: {}, project: projectOf(projectPath) }, 0);
  return hit ? out('deny', denial(hit)) : null;
}

/** Erro inesperado: se a entrada for de outra ferramenta, não responde; se não der para ler, bloqueia. */
export function failClosed(raw) {
  try {
    const t = JSON.parse(raw)?.tool_name;
    if (typeof t === 'string' && !TOOLS.has(t)) return null;
  } catch {
    // entrada ilegível: segue para o bloqueio
  }
  return out('deny', 'não deu para conferir o comando do terminal: bloqueado por segurança.');
}

export const unavailable = () => out('deny', 'entrada do hook indisponível: bloqueado por segurança.');
