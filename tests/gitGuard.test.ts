import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, promises as fs, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { guard } from '../scripts/hooks/git-guard-lib.mjs';
import { removeTemp, tempDirs } from './support/tmp';

// t-0ccbff: git que descarta mudança não commitada (ou move o HEAD por cima dela) é barrado no checkout principal do projeto, nos dois motores.
// A regra (git-guard-lib.mjs) rodada com repositórios de verdade (principal, worktree própria, repositório temporário), o hook (git-guard.mjs) rodado
// como o Claude Code e o Codex o chamam, e a ligação no staffSettings (Claude) e no codexHeavyArgs (Codex).

// MYCO_HOME de teste: o staffSettings e o lançamento não tocam nos dados de quem roda os testes; sem hooks.json na conta do Codex (com ele a flag de confiança não sai).
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-gitguard-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  process.env.CODEX_HOME = nodePath.join(dir, 'codex-home');
  delete process.env.MYCO_SESSION_ID;
  return dir;
});

const { buildCodexArgs, codexHeavyArgs } = await import('../server/chat/codexArgs');
const { staffSettings, prepareRun, prepareCodexRun, GIT_GUARD_MATCHER } = await import('../server/staff/launch');

// Cada caso abre de 2 a 4 `git` e alguns repetem isso por comando: sob carga passa dos 5 s padrão.
vi.setConfig({ testTimeout: 60_000 });

const hookFile = fileURLToPath(new URL('../scripts/hooks/git-guard.mjs', import.meta.url));
const tmp = tempDirs();
const root = tmp.sync('myco-gitguard-');
const fwd = (p: string) => p.replace(/\\/g, '/');
/** O projeto (o checkout principal), a worktree própria do funcionário (dentro dele), um repositório qualquer, um projeto sem git e uma pasta que não existe. */
const proj = fwd(path.join(root, 'proj'));
const wt = `${proj}/.claude/worktrees/myco-ana`;
const scratch = fwd(path.join(root, 'scratch'));
const nogit = fwd(path.join(root, 'nogit'));
const gone = fwd(path.join(root, 'nao-existe'));
const q = (p: string) => `"${p}"`;

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });

beforeAll(() => {
  for (const d of [proj, scratch]) {
    mkdirSync(path.join(d, 'sub'), { recursive: true });
    sh(d, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(d, 'a.txt'), 'a\n');
    writeFileSync(path.join(d, 'sub', 'b.txt'), 'b\n');
    sh(d, 'add', '.');
    sh(d, 'commit', '-q', '-m', 'um');
  }
  sh(proj, 'branch', 'feature');
  sh(proj, 'worktree', 'add', '-q', '-b', 'wt-ana', wt);
  sh(proj, 'config', 'alias.nuke', 'reset --hard');
  sh(proj, 'config', 'alias.shnuke', '!git reset --hard');
  mkdirSync(nogit, { recursive: true });
}, 60_000);
afterAll(() => removeTemp(home));

type Verdict = ReturnType<typeof guard>;
const event = (tool: string, command: unknown, cwd: string) => ({ tool_name: tool, tool_input: { command }, cwd, hook_event_name: 'PreToolUse' });
/** `project`: a pasta do projeto (o hook recebe como argumento); `null` = o hook foi chamado sem ela. */
const run = (command: unknown, cwd = proj, tool = 'Bash', project: string | null = proj): Verdict => guard(event(tool, command, cwd), project ?? undefined);
const decision = (v: Verdict) => v?.hookSpecificOutput.permissionDecision ?? null;
const reason = (v: Verdict) => v?.hookSpecificOutput.permissionDecisionReason ?? '';
const TOOLS = ['Bash', 'PowerShell'];

describe('git-guard: o que barra no checkout principal (Bash e PowerShell)', () => {
  const BLOCKED = [
    // reset
    'git reset --hard', 'git reset --hard HEAD~1', 'git reset --merge', 'git reset --keep', 'git reset HEAD --hard', 'git reset --har',
    // checkout
    'git checkout -- a.txt', 'git checkout .', 'git checkout -f', 'git checkout --force feature', 'git checkout feature -- a.txt', 'git checkout HEAD a.txt', 'git checkout a.txt',
    'git checkout -p', 'git checkout --ours a.txt', 'git checkout -fb nova',
    // restore (sem --staged restaura a árvore de trabalho)
    'git restore a.txt', 'git restore .', 'git restore --worktree a.txt', 'git restore --staged --worktree a.txt', 'git restore -SW a.txt', 'git restore --source=HEAD~1 a.txt', 'git restore -p a.txt',
    // clean
    'git clean -f', 'git clean -fd', 'git clean -fdx', 'git clean -xdf', 'git clean -d', 'git clean --force', 'git clean -ffdx', 'git clean -i',
    // stash
    'git stash', 'git stash push', 'git stash push -- a.txt', 'git stash save x', 'git stash -u', 'git stash -m x', 'git stash drop', 'git stash clear', 'git stash pop', 'git stash apply', 'git stash branch x', 'git stash create',
    // switch
    'git switch -f feature', 'git switch --force feature', 'git switch --discard-changes feature',
    // rm
    'git rm a.txt', 'git rm -rf sub', 'git rm -f a.txt',
    // sobrescrevem a árvore de trabalho por outro caminho
    'git checkout-index -f -a', 'git checkout-index --force a.txt', 'git checkout-index -af', 'git read-tree -u --reset HEAD', 'git read-tree -u -m HEAD', 'git read-tree -mu HEAD',
  ];

  it.each(BLOCKED)('%s: deny, nas duas ferramentas', (command) => {
    for (const tool of TOOLS) {
      const v = run(command, proj, tool);
      expect(decision(v), `${tool}: ${command}`).toBe('deny');
      expect(reason(v)).toMatch(/^\[MyCo\] Barrado: "git /);
      expect(reason(v)).toContain('checkout principal');
    }
  });

  it('numa subpasta do projeto é o mesmo checkout: barra', () => {
    expect(decision(run('git reset --hard', `${proj}/sub`))).toBe('deny');
    expect(decision(run('git clean -fd', `${proj}/sub`))).toBe('deny');
  });
});

describe('git-guard: as formas de chamar (Bash e PowerShell, direto, com -C, encadeado, dentro de outro comando)', () => {
  const enc = Buffer.from('git reset --hard', 'utf16le').toString('base64');
  // [forma, comando, pasta onde a conversa está, ferramenta]
  const WRAPPED: Array<[string, string, string, string?]> = [
    ['-C do principal', `git -C ${q(proj)} reset --hard`, scratch],
    ['-C de uma subpasta do principal', `git -C ${q(proj)}/sub reset --hard`, scratch],
    ['-C relativo', 'git -C .. reset --hard', `${proj}/sub`],
    ['-C duas vezes', `git -C ${q(scratch)} -C ${q(proj)} reset --hard`, scratch],
    ['--git-dir e --work-tree', `git --git-dir=${q(`${proj}/.git`)} --work-tree=${q(proj)} reset --hard`, scratch],
    ['--git-dir e --work-tree relativos, de uma subpasta (R1)', 'git --git-dir=../.git --work-tree=.. reset --hard', `${proj}/sub`],
    ['--git-dir e --work-tree relativos, depois de um -C (R1)', 'git -C sub --git-dir=../.git --work-tree=.. reset --hard', proj],
    ['--git-dir e --work-tree em duas palavras, relativos (R1)', 'git --git-dir ../.git --work-tree .. reset --hard', `${proj}/sub`],
    ['--work-tree do principal numa pasta de outro repositório (reescreve os arquivos dele)', `git --work-tree=${q(proj)} reset --hard`, scratch],
    ['--git-dir de outro repositório com a pasta no principal (a árvore é a pasta)', `git --git-dir=${q(`${scratch}/.git`)} reset --hard`, proj],
    ['GIT_DIR de outro repositório com a pasta no principal', `GIT_DIR=${q(`${scratch}/.git`)} git reset --hard`, proj],
    ['GIT_WORK_TREE sozinho: o índice do principal é zerado', `GIT_WORK_TREE=${q(scratch)} git reset --hard`, proj],
    ['GIT_DIR e GIT_WORK_TREE relativos (R1)', 'GIT_DIR=../.git GIT_WORK_TREE=.. git reset --hard', `${proj}/sub`],
    ['$env:GIT_DIR e $env:GIT_WORK_TREE relativos (R1)', "$env:GIT_DIR='../.git'; $env:GIT_WORK_TREE='..'; git reset --hard", `${proj}/sub`, 'PowerShell'],
    ['alias dado na linha (-c alias.x=…)', 'git -c alias.zap="reset --hard" zap', proj],
    ['alias de shell dado na linha', 'git -c "alias.zap=!git reset --hard" zap', proj],
    ['GIT_DIR no prefixo', `GIT_DIR=${q(`${proj}/.git`)} git reset --hard`, scratch],
    ['$env:GIT_DIR (PowerShell)', `$env:GIT_DIR='${proj}/.git'; git reset --hard`, scratch, 'PowerShell'],
    ['cd ;', `cd ${q(proj)}; git reset --hard`, scratch],
    ['cd &&', `cd ${q(proj)} && git clean -fd`, scratch],
    ['cd /d (cmd)', `cd /d ${q(proj)} && git reset --hard`, scratch],
    ['Set-Location', `Set-Location ${q(proj)}; git reset --hard`, scratch, 'PowerShell'],
    ['Set-Location -Path', `Set-Location -Path ${q(proj)}; git reset --hard`, scratch, 'PowerShell'],
    ['sl', `sl ${q(proj)}; git checkout -- a.txt`, scratch, 'PowerShell'],
    ['pushd', `pushd ${q(proj)}; git reset --hard`, scratch],
    ['popd volta para o principal', `pushd ${q(wt)}; popd; git reset --hard`, proj],
    ['o cd de um subshell não vaza', `(cd ${q(wt)}; git status); git reset --hard`, proj],
    ['cd para pasta que não existe: o comando seguinte roda onde estava', `cd ${q(gone)}; git reset --hard`, proj],
    ['da worktree para o principal: -C', `git -C ${q(proj)} reset --hard`, wt],
    ['da worktree para o principal: cd', `cd ${q(proj)}; git clean -fd`, wt],
    ['; depois de leitura', 'git status; git reset --hard', proj],
    ['&&', 'git status && git reset --hard', proj],
    ['||', 'git status || git reset --hard', proj],
    ['pipe', 'git status | git reset --hard', proj],
    ['&', 'git status & git reset --hard', proj],
    ['quebra de linha', 'git status\ngit reset --hard', proj],
    ['subshell', '(git reset --hard)', proj],
    ['substituição $()', 'echo $(git reset --hard)', proj],
    ['$() dentro de aspa dupla', 'echo "$(git reset --hard)"', proj],
    ['bloco { }', '{ git reset --hard }', proj],
    ['ForEach-Object (PowerShell)', '1 | ForEach-Object { git reset --hard }', proj, 'PowerShell'],
    ['if then (sh)', 'if true; then git reset --hard; fi', proj],
    ['continuação de linha (crase)', 'git reset `\n--hard', proj, 'PowerShell'],
    ['continuação de linha (barra)', 'git reset \\\n--hard', proj],
    ['bash -c', 'bash -c "git reset --hard"', proj],
    ['sh -c com aspa simples', "sh -c 'git clean -fd'", proj],
    ['bash -lc', 'bash -lc "git stash"', proj],
    ['cmd /c', 'cmd /c git reset --hard', proj],
    ['cmd /c com aspas', 'cmd /c "git reset --hard"', proj],
    ['powershell -Command', 'powershell -NoProfile -Command "git reset --hard"', proj],
    ['pwsh -c', 'pwsh -c "git clean -fd"', proj],
    ['powershell com o texto direto', 'powershell "git reset --hard"', proj],
    ['powershell -enc', `powershell -NoProfile -enc ${enc}`, proj, 'PowerShell'],
    ['pwsh -EncodedCommand', `pwsh -EncodedCommand ${enc}`, proj],
    ['bash dentro de powershell', 'powershell -c "bash -c \'git reset --hard\'"', proj],
    ['env', 'env git reset --hard', proj],
    ['env com variável', 'env GIT_PAGER=cat git reset --hard', proj],
    ['time', 'time git reset --hard', proj],
    ['sudo', 'sudo git clean -fd', proj],
    ['command', 'command git reset --hard', proj],
    ['xargs', 'xargs git reset --hard', proj],
    ['xargs com o -- sozinho', 'echo a.txt | xargs -I{} git checkout -- {}', proj],
    ['Start-Process', "Start-Process git -ArgumentList 'reset','--hard'", proj, 'PowerShell'],
    ['Start-Process -NoNewWindow -Wait', "Start-Process -FilePath git -ArgumentList 'clean','-fd' -NoNewWindow -Wait", proj, 'PowerShell'],
    ['iex', 'iex "git reset --hard"', proj, 'PowerShell'],
    ['texto no pipe para o iex', '"git reset --hard" | iex', proj, 'PowerShell'],
    ['Invoke-Expression', "Invoke-Expression 'git reset --hard'", proj, 'PowerShell'],
    ['eval', 'eval "git reset --hard"', proj],
    ['caminho até o git (Unix)', '/usr/bin/git reset --hard', proj],
    ['caminho até o git (Windows)', '"C:\\Program Files\\Git\\cmd\\git.exe" reset --hard', proj],
    ['& com caminho (PowerShell)', "& 'C:\\Program Files\\Git\\cmd\\git.exe' reset --hard", proj, 'PowerShell'],
    ['git.exe', 'git.exe reset --hard', proj, 'PowerShell'],
    ['GIT maiúsculo', 'GIT reset --hard', proj, 'PowerShell'],
    ['opções globais antes do subcomando', 'git --no-pager -c core.autocrlf=false reset --hard', proj],
    ['alias do git', 'git nuke', proj],
    ['alias de shell do git', 'git shnuke', proj],
    ['alias com -C', `git -C ${q(proj)} nuke`, scratch],
    ['mensagem de commit antes, comando depois', 'git commit -m "limpa" && git reset --hard', proj],
  ];

  it.each(WRAPPED)('%s: deny', (_forma, command, cwd, tool = 'Bash') => {
    const v = run(command, cwd, tool);
    expect(decision(v), command).toBe('deny');
    expect(reason(v)).toMatch(/^\[MyCo\] Barrado: "git /);
  });

  it('pasta que o texto não deixa resolver (variável, curinga): barra e diz o que fazer', () => {
    for (const [command, cwd] of [
      ['cd $alvo; git reset --hard', proj],
      ['cd $alvo; git reset --hard', scratch],
      ['git -C $alvo reset --hard', scratch],
      ['git -C %ALVO% clean -fd', scratch],
      ['git -C /tmp/*/x reset --hard', scratch],
      ['cd ~outro; git reset --hard', scratch],
      ['$env:GIT_DIR="$x/.git"; git reset --hard', scratch],
    ] as const) {
      const v = run(command, cwd);
      expect(decision(v), command).toBe('deny');
      expect(reason(v)).toContain('não deu para resolver');
      expect(reason(v)).toContain('caminho literal');
      expect(reason(v)).toContain('worktree');
    }
  });

  it('aspa escapada dentro do bash -c não esconde o comando de depois', () => {
    expect(decision(run('bash -c "git commit -m \\"a b\\"; git reset --hard"'))).toBe('deny');
    expect(decision(run('bash -c "git commit -m \\"a b\\"; git status"'))).toBeNull();
  });

  it('aninhamento além do limite com git: barra (não dá para conferir)', () => {
    const v = run(`${'eval '.repeat(7)}git reset --hard`);
    expect(decision(v)).toBe('deny');
    expect(reason(v)).toContain('aninhado demais');
    expect(decision(run(`${'eval '.repeat(7)}echo oi`))).toBeNull(); // sem git, passa
  });
});

describe('git-guard: o que passa', () => {
  const SAFE = [
    // leitura
    'git status', 'git status --short', 'git diff', 'git diff --stat HEAD', 'git log --oneline -5', 'git show HEAD', 'git branch', 'git ls-files',
    // desfaz só o índice, ou nada na árvore
    'git restore --staged a.txt', 'git restore -S a.txt', 'git restore --staged --source=HEAD a.txt', 'git reset a.txt', 'git reset HEAD a.txt', 'git reset -- a.txt', 'git reset --soft HEAD~1', 'git reset --mixed HEAD',
    'git rm --cached a.txt', 'git rm -r --cached sub', 'git rm -n a.txt', 'git clean -n', 'git clean -nd', 'git clean --dry-run -d', 'git stash list', 'git stash show -p',
    // troca de branch (a árvore vai junto, o git recusa se houver conflito) e branch novo
    'git checkout feature', 'git checkout main', 'git checkout HEAD', 'git checkout -b nova', 'git checkout -b nova main', 'git checkout -', 'git switch feature', 'git switch -c nova', 'git switch -',
    // só o índice
    'git checkout-index -a', 'git read-tree HEAD', 'git read-tree --reset HEAD',
    // escrita comum
    'git add -A', 'git commit -m "x"', 'git branch -D velho', 'git fetch', 'git merge --no-ff feature', 'git rebase main',
    // o texto do git destrutivo que não é comando
    'git commit -m "docs: git reset --hard e git clean -fd"', 'git log --grep="git reset --hard"', 'echo "git reset --hard"', 'echo git checkout -- a.txt', 'Write-Output "git stash"',
    "git commit -F - <<'EOF'\nexplica o incidente\ngit reset --hard apagou o trabalho\nEOF",
    "git commit -m @'\nexplica\ngit reset --hard\n'@",
    // sem git
    'ls', 'npm test', 'Get-ChildItem', 'cd sub',
  ];

  it.each(SAFE)('%s: passa no principal', (command) => {
    for (const tool of TOOLS) expect(decision(run(command, proj, tool)), `${tool}: ${command}`).toBeNull();
  });

  // O mesmo comando destrutivo, onde ele não tira nada de ninguém: a worktree própria e qualquer outro repositório.
  const DESTRUCTIVE = ['git reset --hard', 'git clean -fd', 'git checkout -- a.txt', 'git checkout .', 'git restore a.txt', 'git stash', 'git switch -f feature', 'git rm a.txt'];

  it.each(DESTRUCTIVE)('%s: na worktree própria do funcionário, passa (nas duas ferramentas)', (command) => {
    for (const tool of TOOLS) expect(decision(run(command, wt, tool)), `${tool}: ${command}`).toBeNull();
  });

  it.each(DESTRUCTIVE)('%s: num repositório que não é o do projeto, passa', (command) => {
    expect(decision(run(command, scratch))).toBeNull();
  });

  it('chegar a outro repositório pelo comando passa: -C, cd, --git-dir', () => {
    for (const command of [
      `git -C ${q(wt)} reset --hard`,
      `git -C ${q(scratch)} clean -fd`,
      `cd ${q(wt)}; git reset --hard`,
      `cd ${q(scratch)} && git reset --hard`,
      `Set-Location ${q(scratch)}; git clean -fd`,
      `pushd ${q(wt)}; git reset --hard`,
      `git --git-dir=${q(`${scratch}/.git`)} --work-tree=${q(scratch)} reset --hard`,
    ]) {
      expect(decision(run(command, proj)), command).toBeNull();
    }
    expect(decision(run('git -C .. reset --hard', `${scratch}/sub`)), 'git -C .. a partir do repositório temporário').toBeNull();
    // GIT_DIR sem GIT_WORK_TREE: a árvore de trabalho é a pasta onde o comando roda (aqui, o próprio repositório temporário).
    expect(decision(run(`GIT_DIR=${q(`${scratch}/.git`)} git reset --hard`, scratch))).toBeNull();
    expect(decision(run('git --git-dir=.git reset --hard', scratch))).toBeNull();
  });

  it('pasta da conversa que não existe: o git falha sozinho, passa', () => {
    expect(decision(run('git reset --hard', gone))).toBeNull();
  });

  it('projeto que não é repositório git: libera tudo (não há o que proteger)', () => {
    for (const cwd of [nogit, proj, scratch, wt]) {
      for (const tool of TOOLS) expect(decision(run('git reset --hard', cwd, tool, nogit)), `${tool} em ${cwd}`).toBeNull();
    }
    expect(decision(run(`git -C ${q(proj)} clean -fd`, nogit, 'Bash', nogit))).toBeNull();
    expect(decision(run('cd $x; git reset --hard', nogit, 'Bash', nogit))).toBeNull();
  });

  it('sem a pasta do projeto: o comando destrutivo é barrado (falha fechada), o resto não precisa dela', () => {
    for (const project of [null, '']) {
      const v = run('git reset --hard', scratch, 'Bash', project);
      expect(decision(v)).toBe('deny');
      expect(reason(v)).toContain('não deu para conferir');
      expect(decision(run('git status', scratch, 'Bash', project))).toBeNull();
      expect(decision(run('npm test', scratch, 'Bash', project))).toBeNull();
    }
  });
});

// R1 (reprovação 1): `--git-dir` e `--work-tree` relativos contam a partir da pasta de depois dos `-C`, não do work-tree. Aqui cada comando roda no git de verdade, num repositório
// com `a.txt` modificada: se o git a reescreve, o hook tem de negar (o premissa do caso é conferida: o git de fato destrói).
describe('git-guard: --git-dir e --work-tree relativos, conferidos contra o git de verdade (R1)', () => {
  const orc = fwd(path.join(root, 'orc'));
  const orc2 = fwd(path.join(root, 'orc2'));
  const DIRTY = 'TRABALHO-NAO-COMMITADO\n';
  beforeAll(() => {
    for (const [d, text] of [[orc, 'a\n'], [orc2, 'OUTRO\n']] as const) {
      mkdirSync(path.join(d, 'sub'), { recursive: true });
      sh(d, 'init', '-q', '-b', 'main');
      writeFileSync(path.join(d, 'a.txt'), text);
      writeFileSync(path.join(d, 'sub', 'b.txt'), 'b\n');
      sh(d, 'add', '.');
      sh(d, 'commit', '-q', '-m', 'um');
    }
  }, 60_000);

  type Case = { name: string; cwd: string; args: string[]; env?: Record<string, string> };
  const CASES: Case[] = [
    { name: 'relativos a partir de uma subpasta', cwd: `${orc}/sub`, args: ['--git-dir=../.git', '--work-tree=..', 'reset', '--hard'] },
    { name: 'relativos depois de um -C', cwd: orc, args: ['-C', 'sub', '--git-dir=../.git', '--work-tree=..', 'reset', '--hard'] },
    { name: 'relativos depois de um -C .', cwd: `${orc}/sub`, args: ['-C', '.', '--git-dir=../.git', '--work-tree=..', 'reset', '--hard'] },
    { name: 'valores em duas palavras', cwd: `${orc}/sub`, args: ['--git-dir', '../.git', '--work-tree', '..', 'reset', '--hard'] },
    { name: 'só --work-tree relativo (o git-dir vem da pasta)', cwd: `${orc}/sub`, args: ['--work-tree=..', 'reset', '--hard'] },
    { name: 'GIT_DIR e GIT_WORK_TREE relativos', cwd: `${orc}/sub`, args: ['reset', '--hard'], env: { GIT_DIR: '../.git', GIT_WORK_TREE: '..' } },
    { name: '--git-dir de outro repositório: a árvore é a pasta (o principal)', cwd: orc, args: [`--git-dir=${orc2}/.git`, 'reset', '--hard'] },
    { name: '--work-tree do principal numa pasta de outro repositório', cwd: orc2, args: [`--work-tree=${orc}`, 'reset', '--hard'] },
    { name: '--work-tree relativo do principal, a partir do irmão', cwd: orc2, args: ['--work-tree=../orc', 'reset', '--hard'] },
  ];
  const quote = (a: string) => `"${a}"`;
  const commandOf = (c: Case) => [...Object.entries(c.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`), 'git', ...c.args.map(quote)].join(' ');
  /** Roda o comando no git de verdade com a `a.txt` do principal suja; devolve se ela foi reescrita. */
  const destroys = (c: Case): boolean => {
    sh(orc, 'reset', '-q', '--hard');
    writeFileSync(path.join(orc, 'a.txt'), DIRTY);
    try {
      execFileSync('git', c.args, { cwd: c.cwd, env: { ...process.env, ...c.env }, stdio: 'pipe', windowsHide: true });
    } catch {
      // o git pode recusar depois de mexer
    }
    return readFileSync(path.join(orc, 'a.txt'), 'utf8') !== DIRTY;
  };

  it.each(CASES)('$name: o git destrói a mudança e o hook nega, nas duas ferramentas', (c) => {
    expect(destroys(c), 'premissa: o git reescreve a a.txt suja').toBe(true);
    for (const tool of TOOLS) expect(decision(run(commandOf(c), c.cwd, tool, orc)), `${tool}: ${commandOf(c)}`).toBe('deny');
  });

  it('o que não toca no principal passa: o repositório de outro com a árvore dele', () => {
    for (const [command, cwd] of [
      [`git --git-dir=${q(`${orc2}/.git`)} reset --hard`, orc2],
      [`git --git-dir=${q(`${orc2}/.git`)} --work-tree=${q(orc2)} reset --hard`, orc],
      ['git --git-dir=../.git --work-tree=.. reset --hard', `${orc2}/sub`],
      ['git -C sub --git-dir=../.git --work-tree=.. reset --hard', orc2],
    ] as const) {
      for (const tool of TOOLS) expect(decision(run(command, cwd, tool, orc)), `${tool}: ${command} em ${cwd}`).toBeNull();
    }
  });
});

describe('git-guard: a mensagem de recusa', () => {
  it('curta, em pt-BR, diz o que foi barrado, por quê e a saída (pedir ao usuário ou worktree própria)', () => {
    const text = reason(run('git reset --hard'));
    expect(text).toBe(
      '[MyCo] Barrado: "git reset --hard" no checkout principal do projeto: descarta o trabalho não commitado de outras conversas. Peça ao usuário para rodar ou use uma worktree própria (git worktree add).',
    );
    expect(text.length).toBeLessThan(220);
    expect(reason(run('git clean -fd'))).toContain('"git clean -fd"');
    expect(reason(run('git checkout -- a.txt'))).toContain('"git checkout -- a.txt"');
  });

  it('o rótulo do comando é cortado: texto enorme não vira mensagem enorme', () => {
    const text = reason(run(`git checkout -- ${'x'.repeat(500)}`));
    expect(text.length).toBeLessThan(300);
  });
});

describe('git-guard: o hook rodado como o Claude Code e o Codex o chamam', () => {
  const hook = (input: unknown, project: string | undefined = proj) =>
    spawnSync(process.execPath, [hookFile, ...(project === undefined ? [] : [project])], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true });

  it('deny: só os campos que o Codex aceita, saída 0 e nada no stderr', () => {
    const r = hook(event('Bash', 'git reset --hard', proj));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringMatching(/^\[MyCo\] Barrado: "git reset --hard"/),
      },
    });
  });

  it('passa sem responder: leitura, comando sem git, outra ferramenta', () => {
    for (const input of [event('Bash', 'git status', proj), event('Bash', 'npm test', proj), event('PowerShell', 'Get-ChildItem', proj), { tool_name: 'Read', tool_input: { command: 'git reset --hard' }, cwd: proj }]) {
      const r = hook(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('falha fechada: entrada ilegível, sem nome de ferramenta, comando que não é texto', () => {
    for (const input of ['não é json', '', '{}', { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Bash', tool_input: { command: 42 } }, { tool_name: 'PowerShell', tool_input: { command: null } }, null]) {
      const r = hook(input as never);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, JSON.stringify(input)).toBe('deny');
    }
  });

  it('o evento do Codex (tool_name Bash, com turn_id, cwd e permission_mode) e o do Claude (PowerShell) dão o mesmo veredito', () => {
    const codex = (command: string, cwd: string) => ({ session_id: 'thr-1', turn_id: 't1', hook_event_name: 'PreToolUse', model: 'gpt-5', permission_mode: 'bypassPermissions', cwd, tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command } });
    const claude = (command: string, cwd: string) => ({ session_id: 's1', transcript_path: '/x', hook_event_name: 'PreToolUse', permission_mode: 'default', cwd, tool_name: 'PowerShell', tool_use_id: 'toolu_1', tool_input: { command } });
    for (const [command, cwd, denied] of [['git reset --hard', proj, true], ['git reset --hard', wt, false], ['git status', proj, false], [`git -C ${q(proj)} clean -fd`, scratch, true]] as const) {
      expect(hook(codex(command, cwd)).stdout !== '', `Codex: ${command}`).toBe(denied);
      expect(hook(claude(command, cwd)).stdout !== '', `Claude: ${command}`).toBe(denied);
    }
  });
});

describe('git-guard: ligado nos dois motores', () => {
  const profile = {
    id: 'ana-1', projectId: 'proj-id', name: 'Ana', role: 'Dev', mission: 'Codar', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: [], knowledge: [], rules: [],
    doneWhen: '', reportsTo: [], model: null, effort: null, canHire: false, playbook: null, worktree: false, servers: [], sshWrite: [], browser: false, portrait: null, sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const ctx = () => ({
    company: 'Co', projectName: 'proj', projectPath: proj, managerNames: [], mycoUrl: 'http://127.0.0.2:1', runDir: path.join(root, 'run'),
    claudeConfigFile: path.join(root, 'claude.json'), userAgentsDir: path.join(root, 'user-agents'), servers: [],
  });
  const secrets = { projectPath: proj, home: path.join(root, 'sem-home'), mycoHome: path.join(root, 'sem-home', '.myco') };
  type Group = { matcher?: string; hooks: Array<{ command?: string; args?: string[]; onFailure?: string; timeout?: number }> };
  const gitGroup = (groups: Group[]) => groups.find((g) => g.hooks[0]?.args?.[0]?.endsWith('git-guard.mjs'));

  it('Claude: o hook no Bash e no PowerShell, com a pasta do projeto, falha fechada; sem o projeto, sem o hook', () => {
    const on = staffSettings(undefined, undefined, { hooksDir: '/run/c1/hooks', projectPath: proj });
    expect(GIT_GUARD_MATCHER).toBe('Bash|PowerShell');
    expect(gitGroup(on.hooks.PreToolUse as Group[])).toMatchObject({ matcher: GIT_GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join('/run/c1/hooks', 'git-guard.mjs'), proj], timeout: 10, onFailure: 'block' }] });
    expect(gitGroup(on.hooks.PostToolUse as Group[])).toBeUndefined();
    expect(gitGroup(staffSettings().hooks.PreToolUse as Group[])).toBeUndefined();
  });

  it('Claude: o lançamento copia o hook e a regra para a pasta da conversa e o settings aponta para a cópia, com o projeto', async () => {
    const r = await prepareRun({ ...profile, engine: 'claude' } as never, ctx() as never, 'sess-c', proj);
    const hooks = path.join(root, 'run', 'sess-c', 'hooks');
    for (const f of ['git-guard.mjs', 'git-guard-lib.mjs']) expect(await fs.readFile(path.join(hooks, f), 'utf8')).toBe(await fs.readFile(fileURLToPath(new URL(`../scripts/hooks/${f}`, import.meta.url)), 'utf8'));
    const settings = JSON.parse(await fs.readFile(r.settingsFile, 'utf8'));
    expect(gitGroup(settings.hooks.PreToolUse)).toMatchObject({ hooks: [{ args: [path.join(hooks, 'git-guard.mjs'), proj], onFailure: 'block' }] });
  });

  it('Codex: o lançamento copia o hook e a regra e devolve o hook e o projeto; os args levam um segundo grupo no PreToolUse (a fila segue sozinha no Post)', async () => {
    const r = await prepareCodexRun({ ...profile, engine: 'codex' } as never, ctx() as never, 'sess-x', proj);
    const hooks = path.join(root, 'run', 'sess-x', 'hooks');
    expect(r.heavyGuard?.git).toEqual({ hook: path.join(hooks, 'git-guard.mjs'), projectPath: proj });
    for (const f of ['git-guard.mjs', 'git-guard-lib.mjs']) await expect(fs.stat(path.join(hooks, f))).resolves.toBeTruthy();
    for (const platform of ['win32', 'linux'] as const) {
      const args = buildCodexArgs({ cwd: proj, sandbox: 'workspace', network: 'loopback', secrets, heavyGuard: r.heavyGuard, platform });
      const pre = args.find((a) => a.startsWith('hooks.PreToolUse='))!;
      const post = args.find((a) => a.startsWith('hooks.PostToolUse='))!;
      expect(args).toContain('--dangerously-bypass-hook-trust');
      expect(pre.match(/matcher="Bash"/g)).toHaveLength(2);
      expect(pre).toContain(`${fwd(path.join(hooks, 'git-guard.mjs'))}\\" \\"${proj}\\"`);
      expect(pre).toContain(platform === 'win32' ? 'command="& \\"' : 'command="\\"');
      expect(post.match(/matcher="Bash"/g)).toHaveLength(1);
      expect(post).toContain('heavy-guard.mjs');
      expect(post).not.toContain('git-guard');
    }
  });

  it('paridade: a cópia do Claude (settings) e a do Codex (hook + projeto) dão o mesmo veredito, com o evento de cada motor', async () => {
    const c = await prepareRun({ ...profile, engine: 'claude' } as never, ctx() as never, 'sess-p1', proj);
    const x = await prepareCodexRun({ ...profile, engine: 'codex' } as never, ctx() as never, 'sess-p2', proj);
    const claudeHook = gitGroup(JSON.parse(await fs.readFile(c.settingsFile, 'utf8')).hooks.PreToolUse)!.hooks[0]!;
    const codexHook = x.heavyGuard!.git!;
    const viaClaude = (command: string, cwd: string) =>
      spawnSync(claudeHook.command!, claudeHook.args!, { input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', permission_mode: 'default', cwd, tool_name: 'Bash', tool_use_id: 't', tool_input: { command } }), encoding: 'utf8', windowsHide: true }).stdout;
    const viaCodex = (command: string, cwd: string) =>
      spawnSync(process.execPath, [codexHook.hook, codexHook.projectPath], { input: JSON.stringify({ session_id: 'thr', turn_id: 't1', hook_event_name: 'PreToolUse', cwd, tool_name: 'Bash', tool_use_id: 'e', tool_input: { command } }), encoding: 'utf8', windowsHide: true }).stdout;
    for (const [command, cwd, denied] of [
      ['git reset --hard', proj, true],
      ['git checkout -- a.txt', proj, true],
      ['git stash', proj, true],
      ['bash -c "git clean -fd"', proj, true],
      [`cd ${q(proj)}; git reset --hard`, scratch, true],
      ['git reset --hard', wt, false],
      ['git status', proj, false],
      ['git restore --staged a.txt', proj, false],
      ['git checkout feature', proj, false],
    ] as const) {
      const a = viaClaude(command, cwd);
      const b = viaCodex(command, cwd);
      expect(a !== '', `Claude: ${command}`).toBe(denied);
      expect(b, `Codex: ${command}`).toBe(a);
    }
  });

  it('Codex: conta com hooks.json: nem hook nem flag (nenhum dos dois roda), e o aviso é chamado', async () => {
    const dir = path.join(root, 'conta-com-hooks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'hooks.json'), '{"hooks":{}}');
    const guardOf = { hook: '/h/heavy-guard.mjs', lockDir: '/h/lock', ownerPid: 1, git: { hook: '/h/git-guard.mjs', projectPath: proj } };
    const off: Array<string | null> = [];
    const args = buildCodexArgs({ cwd: proj, sandbox: 'workspace', network: 'loopback', secrets, heavyGuard: guardOf, env: { CODEX_HOME: dir }, onHeavyGuardOff: (f: string | null) => off.push(f) });
    expect(args.join(' ')).not.toMatch(/dangerously|hooks\.|git-guard/);
    expect(off).toHaveLength(1);
    expect(off[0]).toContain('hooks.json');
  });

  it('codexHeavyArgs: cada hook sai sozinho se os caminhos dele não cabem entre aspas; sem nenhum, a flag não fica sozinha', () => {
    const base = { hook: '/h/heavy-guard.mjs', lockDir: '/h/lock', ownerPid: 1 };
    const withGit = { ...base, git: { hook: '/h/git-guard.mjs', projectPath: '/p/proj' } };
    const only = (a: string[]) => ({ pre: a.find((s) => s.startsWith('hooks.PreToolUse=')) ?? '', post: a.find((s) => s.startsWith('hooks.PostToolUse=')) ?? '' });
    // só a fila (sem o git): a saída de antes da t-0ccbff
    expect(only(codexHeavyArgs(base)).pre.match(/matcher=/g)).toHaveLength(1);
    // os dois
    const both = codexHeavyArgs(withGit);
    expect(both[0]).toBe('--dangerously-bypass-hook-trust');
    expect(only(both).pre).toContain('git-guard.mjs');
    expect(only(both).pre).toContain('/p/proj');
    expect(only(both).pre).toContain('timeout=60');
    // o projeto com `$` (não cabe): fica a fila, sem o git
    const noGit = codexHeavyArgs({ ...withGit, git: { hook: '/h/git-guard.mjs', projectPath: '/p/pro$j' } });
    expect(only(noGit).pre).not.toContain('git-guard');
    expect(only(noGit).pre).toContain('heavy-guard.mjs');
    // a fila não cabe: fica o git, sem o Post (que é só da fila)
    const noHeavy = codexHeavyArgs({ ...withGit, lockDir: '/h/lo"ck' });
    expect(noHeavy[0]).toBe('--dangerously-bypass-hook-trust');
    expect(only(noHeavy).pre).toContain('git-guard.mjs');
    expect(only(noHeavy).pre).not.toContain('heavy-guard');
    expect(only(noHeavy).post).toBe('');
    // nenhum cabe: nada
    expect(codexHeavyArgs({ ...withGit, lockDir: '/h/lo"ck', git: { hook: '/h/git`guard.mjs', projectPath: '/p' } })).toEqual([]);
    expect(codexHeavyArgs(null)).toEqual([]);
  });
});
