import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findSecret } from '../server/chat/secrets';
import { createGitMcp, writeGitPolicy, type GitPolicy } from '../server/staff/gitMcp';
import { createSafeTools, githubRepoOf, resetBreaker, validBranchName } from '../server/staff/gitSafe';

// MCP de git (t-eaffcd) contra repositórios git de verdade, em pasta temporária: commit só dos caminhos pedidos, hooks desligados, config hostil recusada,
// push só para branch que não é main/master (nunca force), host só github.com, PR só com os argumentos fixos e as recusas por autonomia e acesso.

// Dezenas de chamadas ao git por teste: sob carga passam dos 5 s padrão.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let seq = 0;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-gitmcp-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const write = (dir: string, rel: string, text: string) => fs.writeFile(path.join(dir, rel), text);
const fwd = (p: string) => p.replace(/\\/g, '/');
const ORIGIN = 'https://github.com/acme/demo.git';

const CODEX_AUTO: GitPolicy = { engine: 'codex', access: 'free', autonomy: 'auto', review: false };

/** Repositório com a.ts, b.ts e c.ts commitados na `main` e o origin do GitHub (nunca alcançado: o push de teste é redirecionado a um remoto local). */
async function repo(origin: string | null = ORIGIN) {
  const dir = path.join(root, `r${++seq}`);
  await fs.mkdir(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const f of ['a.ts', 'b.ts', 'c.ts']) await write(dir, f, `export const v = 1; // ${f}\n`);
  git(dir, 'add', '--', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

/** Um remoto local (bare), o destino real dos pushes de teste. */
async function bare() {
  const dir = path.join(root, `remote${++seq}.git`);
  execFileSync('git', ['init', '--bare', '-q', dir]);
  return dir;
}

/**
 * O MCP com o git seguro de verdade (hooks desligados, ambiente controlado), registrando cada chamada ao git. `remote`: o push do `origin` do GitHub é
 * redirecionado a esse remoto local (o `pushInsteadOf` vai só na linha de comando do push, não na config do repositório); o gh é falso e guarda os argumentos.
 * `dir` é o projeto; `workDir`, a pasta da conversa (a worktree; padrão: o próprio projeto).
 */
async function server(dir: string, policy: GitPolicy | null = CODEX_AUTO, remote?: string, workDir: string = dir) {
  const runDir = path.join(root, `run${++seq}`);
  await fs.mkdir(path.join(runDir, 'nohooks'), { recursive: true });
  if (policy) await writeGitPolicy(runDir, policy);
  const safe = createSafeTools({ hooksDir: path.join(runDir, 'nohooks'), allowProtocols: 'file:https:ssh' });
  const gitCalls: string[][] = [];
  const ghCalls: Array<{ args: string[]; input?: string }> = [];
  const mcp = createGitMcp({
    projectPath: dir,
    root: workDir,
    runDir,
    sleep: async () => {},
    tools: {
      git: (cwd, args, opts) => {
        gitCalls.push(args);
        const redirect = args[0] === 'push' && remote ? ['-c', `url.${fwd(remote)}.pushInsteadOf=${ORIGIN}`] : [];
        return safe.git(cwd, [...redirect, ...args], opts);
      },
      gh: async (args, input) => {
        ghCalls.push({ args, input });
        return 'https://github.com/acme/demo/pull/7\n';
      },
    },
  });
  const call = async (name: string, args: unknown = {}) => {
    const r = await mcp.callTool(name as never, args);
    return { text: r.content[0]!.text, error: r.isError === true };
  };
  const pushes = () => gitCalls.filter((a) => a[0] === 'push');
  return { mcp, call, gitCalls, ghCalls, pushes, runDir };
}

const hook = async (dir: string, name: string) => {
  const marker = path.join(dir, `.git`, `ran-${name}`);
  const file = path.join(dir, '.git', 'hooks', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\necho ran > '${fwd(marker)}'\nexit 0\n`, { mode: 0o755 });
  return marker;
};

describe('git_commit: só os caminhos pedidos', () => {
  it('commita o caminho informado e deixa de fora o que outro deixou staged (que continua staged)', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    await write(dir, 'b.ts', 'export const v = 3;\n');
    await write(dir, 'novo.ts', 'export const n = 1;\n');
    git(dir, 'add', 'b.ts'); // staged por outra conversa
    const s = await server(dir);
    const r = await s.call('git_commit', { mensagem: 'muda a', caminhos: ['a.ts', 'novo.ts'] });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/^commit [0-9a-f]+ \(2 arquivos\): muda a/);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').split(/\r?\n/).filter(Boolean).sort()).toEqual(['a.ts', 'novo.ts']);
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('b.ts'); // o índice do outro ficou como estava
    expect(git(dir, 'status', '--porcelain').split(/\r?\n/).filter(Boolean).sort()).toEqual(['M  b.ts']);
    expect(Number(git(dir, 'rev-list', '--count', 'HEAD').trim())).toBe(2);
  });

  it('aceita pasta, e deixa .env e conflito de fora, dizendo por quê', async () => {
    const dir = await repo();
    await fs.mkdir(path.join(dir, 'src'));
    await write(dir, 'src/x.ts', 'export const x = 1;\n');
    await write(dir, 'src/.env', 'API=1\n');
    const s = await server(dir);
    const r = await s.call('git_commit', { mensagem: 'pasta', caminhos: ['src'] });
    expect(r.text).toContain('(1 arquivo)');
    expect(r.text).toContain('ficou de fora: src/.env');
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('src/x.ts');
    const solo = await s.call('git_commit', { mensagem: 'só o env', caminhos: ['src/.env'] });
    expect(solo.error).toBe(true);
    expect(solo.text).toContain('nada a commitar');
  });

  it('recusa caminho absoluto, com "..", dentro de .git, vazio e lista vazia; recusa mensagem vazia', async () => {
    const dir = await repo();
    const s = await server(dir);
    for (const caminhos of [['C:/x/a.ts'], ['/etc/passwd'], ['../fora.ts'], ['a/../../b'], ['.git/config'], ['x/.GIT/hooks'], [''], [], 'a.ts', undefined]) {
      const r = await s.call('git_commit', { mensagem: 'm', caminhos });
      expect(r.error, JSON.stringify(caminhos)).toBe(true);
    }
    expect((await s.call('git_commit', { mensagem: '  ', caminhos: ['a.ts'] })).error).toBe(true);
    expect(Number(git(dir, 'rev-list', '--count', 'HEAD').trim())).toBe(1);
  });

  it('segredo nas linhas novas: recusa sem commitar e sem repetir o segredo', async () => {
    const dir = await repo();
    const token = `sk-ant-api03-${randomBytes(60).toString('base64url')}`;
    expect(findSecret(token)).not.toBeNull(); // o detector enxerga este formato
    await write(dir, 'a.ts', `export const k = '${token}';\n`);
    const s = await server(dir);
    const r = await s.call('git_commit', { mensagem: 'com chave', caminhos: ['a.ts'] });
    expect(r.error).toBe(true);
    expect(r.text).toContain('a.ts');
    expect(r.text).not.toContain(token);
    expect(Number(git(dir, 'rev-list', '--count', 'HEAD').trim())).toBe(1);
  });

  it('numa worktree (arquivo .git): o commit vai para o branch dela, e o checkout principal não muda', async () => {
    const dir = await repo();
    const wt = path.join(root, `wt${++seq}`);
    git(dir, 'worktree', 'add', '-q', '-b', 'myco/ana', wt);
    await write(wt, 'a.ts', 'export const v = 9;\n');
    const s = await server(dir, CODEX_AUTO, undefined, wt);
    const r = await s.call('git_commit', { mensagem: 'na worktree', caminhos: ['a.ts'] });
    expect(r.error).toBe(false);
    expect(git(wt, 'log', '-1', '--format=%s').trim()).toBe('na worktree');
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('base');
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('myco/ana');
  });
});

describe('hooks do git não rodam', () => {
  it('commit e push: nenhum hook do repositório roda (o controle prova que o hook funciona)', async () => {
    const dir = await repo();
    const remote = await bare();
    const names = ['pre-commit', 'commit-msg', 'post-commit', 'pre-push'];
    const markers = await Promise.all(names.map((n) => hook(dir, n)));
    // Controle: o mesmo hook roda num commit comum.
    await write(dir, 'c.ts', 'export const v = 7;\n');
    git(dir, 'commit', '-q', '-am', 'controle');
    expect(existsSync(markers[0]!)).toBe(true);
    expect(existsSync(markers[2]!)).toBe(true);
    await Promise.all(markers.map((m) => fs.rm(m, { force: true })));

    await write(dir, 'a.ts', 'export const v = 5;\n');
    const s = await server(dir, CODEX_AUTO, remote);
    expect((await s.call('git_commit', { mensagem: 'pela ferramenta', caminhos: ['a.ts'] })).error).toBe(false);
    git(dir, 'checkout', '-q', '-b', 'myco/ana');
    expect((await s.call('git_push', {})).error).toBe(false);
    for (const m of markers) expect(existsSync(m), m).toBe(false);
  });
});

describe('o repositório da pasta de trabalho é o do projeto', () => {
  /** Uma "worktree" cujo arquivo .git foi reescrito para o gitdir de OUTRO repositório (o ataque: um repo falso com só chaves permitidas na config). */
  async function forged() {
    const dir = await repo();
    const fake = await repo(); // um repositório válido e com origin do GitHub: nenhuma outra conferência o acusa
    const wt = path.join(root, `wt${++seq}`);
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${fwd(path.join(fake, '.git'))}\n`);
    return { dir, fake, wt, fakeHead: git(fake, 'rev-parse', 'HEAD').trim() };
  }

  it('.git da pasta aponta para fora do projeto: toda ferramenta recusa, sem commitar, sem push e sem gh', async () => {
    const { dir, fake, wt, fakeHead } = await forged();
    const remote = await bare();
    await write(wt, 'a.ts', 'export const v = 2;\n');
    const s = await server(dir, CODEX_AUTO, remote, wt);
    for (const [name, args] of [
      ['git_status', {}],
      ['git_diff', {}],
      ['git_log', {}],
      ['git_commit', { mensagem: 'm', caminhos: ['a.ts'] }],
      ['git_push', { branch: 'myco/ana' }],
      ['git_pr_criar', { titulo: 't', branch: 'myco/ana' }],
    ] as const) {
      const r = await s.call(name, args);
      expect(r.error, name).toBe(true);
      expect(r.text, name).toContain('não é o do projeto');
    }
    expect(s.pushes()).toEqual([]);
    expect(s.ghCalls).toEqual([]);
    expect(git(fake, 'rev-parse', 'HEAD').trim()).toBe(fakeHead);
    expect(git(remote, 'for-each-ref').trim()).toBe('');
  });

  it('a recusa vem antes da config: a do repositório falso nem é lida', async () => {
    const { dir, fake, wt } = await forged();
    git(fake, 'config', '--local', 'core.sshCommand', 'evil'); // se a config fosse lida primeiro, a recusa citaria esta chave
    const r = await (await server(dir, CODEX_AUTO, undefined, wt)).call('git_status');
    expect(r.error).toBe(true);
    expect(r.text).toContain('não é o do projeto');
    expect(r.text).not.toContain('sshcommand');
  });

  it('projeto cujo .git é arquivo (ele mesmo uma worktree): a referência vem do git; o próprio projeto vale e o repositório falso segue recusado', async () => {
    const main = await repo();
    const proj = path.join(root, `proj${++seq}`);
    git(main, 'worktree', 'add', '-q', '-b', 'myco/proj', proj);
    expect((await (await server(proj)).call('git_status')).error).toBe(false);
    const fake = await repo();
    const wt = path.join(root, `wt${++seq}`);
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${fwd(path.join(fake, '.git'))}\n`);
    const r = await (await server(proj, CODEX_AUTO, undefined, wt)).call('git_status');
    expect(r.error).toBe(true);
    expect(r.text).toContain('não é o do projeto');
  });

  it('um repositório que não é o do projeto, mesmo clonado dele (outro .git): recusa', async () => {
    const dir = await repo();
    const clone = path.join(root, `clone${++seq}`);
    execFileSync('git', ['clone', '-q', dir, clone]);
    const s = await server(dir, CODEX_AUTO, undefined, clone);
    const r = await s.call('git_status');
    expect(r.error).toBe(true);
    expect(r.text).toContain('não é o do projeto');
  });

  it('pasta que não é repositório: recusa com a mensagem clara', async () => {
    const dir = await repo();
    const plain = path.join(root, `plain${++seq}`);
    await fs.mkdir(plain);
    const r = await (await server(dir, CODEX_AUTO, undefined, plain)).call('git_status');
    expect(r.error).toBe(true);
    expect(r.text).toContain('não é um repositório git');
  });

  it('controle: a worktree de verdade do projeto e o próprio projeto seguem valendo', async () => {
    const dir = await repo();
    const wt = path.join(root, `wt${++seq}`);
    git(dir, 'worktree', 'add', '-q', '-b', 'myco/bia', wt);
    expect((await (await server(dir, CODEX_AUTO, undefined, wt)).call('git_status')).error).toBe(false);
    expect((await (await server(dir)).call('git_status')).error).toBe(false);
  });
});

describe('config local do repositório que viraria código com as credenciais do dono', () => {
  const HOSTILE: Array<[string, string]> = [
    ['core.fsmonitor', 'true'],
    ['core.hooksPath', '.githooks'],
    ['core.sshCommand', 'evil'],
    ['core.pager', 'evil'],
    ['credential.helper', '!evil'],
    ['filter.x.clean', 'evil'],
    ['diff.x.textconv', 'evil'],
    ['alias.st', '!evil'],
    ['url.https://evil/.insteadOf', 'https://github.com/'],
    ['include.path', '../x.cfg'],
    ['remote.origin.vcs', 'evil'],
    ['submodule.s.update', '!evil'],
  ];

  it.each(HOSTILE)('%s: toda ferramenta recusa, citando a chave', async (key, value) => {
    const dir = await repo();
    git(dir, 'config', '--local', key, value);
    const s = await server(dir);
    for (const [name, args] of [['git_status', {}], ['git_diff', {}], ['git_log', {}], ['git_commit', { mensagem: 'm', caminhos: ['a.ts'] }], ['git_push', { branch: 'x' }]] as const) {
      const r = await s.call(name, args);
      expect(r.error, name).toBe(true);
      expect(r.text.toLowerCase(), name).toContain(key.toLowerCase().split('.').slice(0, 1)[0]!);
    }
    expect(s.pushes()).toEqual([]);
  });

  it('as chaves de um repositório comum passam (identidade, remote, branch)', async () => {
    const dir = await repo();
    git(dir, 'config', 'branch.main.remote', 'origin');
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main');
    expect((await (await server(dir)).call('git_status')).error).toBe(false);
  });
});

describe('leitura: status, diff e log (sem argumento livre)', () => {
  it('mostram o estado; um caminho que parece opção do git é só caminho', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    const s = await server(dir, { engine: 'claude', access: 'readonly', autonomy: 'plan', review: false });
    expect((await s.call('git_status')).text).toContain('a.ts');
    expect((await s.call('git_diff', { caminhos: ['a.ts'] })).text).toContain('+export const v = 2;');
    expect((await s.call('git_log', { n: 5 })).text).toMatch(/base$/m);
    const sneaky = await s.call('git_diff', { caminhos: ['--output=pwned.txt'] });
    expect(existsSync(path.join(dir, 'pwned.txt'))).toBe(false);
    expect(sneaky.error).toBe(false);
  });
});

describe('autonomia, acesso e conversa de revisão (conferidos a cada chamada)', () => {
  const policy = (over: Partial<GitPolicy>): GitPolicy => ({ ...CODEX_AUTO, ...over });

  it('Codex em aceitar edições: commit local vale; push e PR recusados com a mensagem clara e sem chamar o git de push nem o gh', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    const s = await server(dir, policy({ autonomy: 'acceptEdits' }));
    expect((await s.call('git_commit', { mensagem: 'ok', caminhos: ['a.ts'] })).error).toBe(false);
    git(dir, 'checkout', '-q', '-b', 'myco/ana');
    const push = await s.call('git_push', {});
    expect(push.error).toBe(true);
    expect(push.text).toBe('push exige autonomia auto ou sem travas; o dono muda na ficha');
    const pr = await s.call('git_pr_criar', { titulo: 't' });
    expect(pr.error).toBe(true);
    expect(pr.text).toBe('abrir PR exige autonomia auto ou sem travas; o dono muda na ficha');
    expect(s.pushes()).toEqual([]);
    expect(s.ghCalls).toEqual([]);
  });

  it('Codex em pede-tudo e em plano: só leitura; commit, push e PR recusados', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    for (const autonomy of ['manual', 'plan'] as const) {
      const s = await server(dir, policy({ autonomy }));
      expect((await s.call('git_status')).error).toBe(false);
      for (const [name, args] of [['git_commit', { mensagem: 'm', caminhos: ['a.ts'] }], ['git_push', {}], ['git_pr_criar', { titulo: 't' }]] as const) {
        expect((await s.call(name, args)).error, `${autonomy} ${name}`).toBe(true);
      }
    }
    expect(Number(git(dir, 'rev-list', '--count', 'HEAD').trim())).toBe(1);
  });

  it('acesso readonly, ask (no Codex), revisão e política ausente: só leitura', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    const cases: Array<[string, GitPolicy | null]> = [
      ['readonly', policy({ access: 'readonly' })],
      ['ask no Codex', policy({ access: 'ask' })],
      ['revisão', policy({ review: true })],
      ['sem política', null],
      ['política em branco', policy({ autonomy: 'nada' as never })],
    ];
    for (const [label, p] of cases) {
      const s = await server(dir, p);
      expect((await s.call('git_log')).error, `${label}: leitura`).toBe(false);
      expect((await s.call('git_commit', { mensagem: 'm', caminhos: ['a.ts'] })).error, `${label}: commit`).toBe(true);
      expect((await s.call('git_push', {})).error, `${label}: push`).toBe(true);
    }
    expect(Number(git(dir, 'rev-list', '--count', 'HEAD').trim())).toBe(1);
  });

  it('a política é relida a cada chamada: baixar a autonomia vale na próxima, sem reabrir o MCP', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    await write(dir, 'b.ts', 'export const v = 2;\n');
    const s = await server(dir, CODEX_AUTO);
    expect((await s.call('git_commit', { mensagem: 'um', caminhos: ['a.ts'] })).error).toBe(false);
    await writeGitPolicy(s.runDir, policy({ autonomy: 'plan' }));
    expect((await s.call('git_commit', { mensagem: 'dois', caminhos: ['b.ts'] })).error).toBe(true);
    await fs.rm(path.join(s.runDir, 'git-policy.json'));
    expect((await s.call('git_commit', { mensagem: 'dois', caminhos: ['b.ts'] })).error).toBe(true);
  });

  it('Claude: aceitar edições vale (o pedido de permissão é do Claude Code); só leitura no plano e na revisão', async () => {
    const dir = await repo();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    const claude: GitPolicy = { engine: 'claude', access: 'free', autonomy: 'acceptEdits', review: false };
    expect((await (await server(dir, claude)).call('git_commit', { mensagem: 'c', caminhos: ['a.ts'] })).error).toBe(false);
    await write(dir, 'b.ts', 'export const v = 2;\n');
    expect((await (await server(dir, { ...claude, autonomy: 'plan' })).call('git_commit', { mensagem: 'c', caminhos: ['b.ts'] })).error).toBe(true);
    expect((await (await server(dir, { ...claude, review: true })).call('git_commit', { mensagem: 'c', caminhos: ['b.ts'] })).error).toBe(true);
  });
});

describe('git_push: origin no GitHub, branch que não é main/master, nunca force', () => {
  it('envia o HEAD ao remoto no branch pedido, com o refspec fixo e sem nenhuma opção de force', async () => {
    const dir = await repo();
    const remote = await bare();
    await write(dir, 'a.ts', 'export const v = 2;\n');
    const s = await server(dir, CODEX_AUTO, remote);
    await s.call('git_commit', { mensagem: 'x', caminhos: ['a.ts'] });
    const r = await s.call('git_push', { branch: 'myco/ana' });
    expect(r.error, r.text).toBe(false);
    expect(r.text).toMatch(/^push ok: origin\/myco\/ana @ [0-9a-f]+$/);
    expect(git(remote, 'rev-parse', 'refs/heads/myco/ana').trim()).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect(s.pushes()).toEqual([['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', 'HEAD:refs/heads/myco/ana']]);
    expect(s.pushes().flat().join(' ')).not.toMatch(/force|--delete|--mirror|--all|--tags|\+|:\s*$/);
  });

  it('o branch atual (que não é main) é o padrão', async () => {
    const dir = await repo();
    const remote = await bare();
    git(dir, 'checkout', '-q', '-b', 'feature/x');
    const s = await server(dir, CODEX_AUTO, remote);
    expect((await s.call('git_push', {})).text).toContain('origin/feature/x');
    expect(git(remote, 'rev-parse', '--verify', 'refs/heads/feature/x').trim()).toBe(git(dir, 'rev-parse', 'HEAD').trim());
  });

  it('main e master (qualquer caixa) e o branch padrão do origin: recusados, sem tocar o remoto', async () => {
    const dir = await repo();
    const remote = await bare();
    git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const s = await server(dir, CODEX_AUTO, remote);
    // O branch atual é a main: sem `branch`, recusa e pede um nome novo.
    const atual = await s.call('git_push', {});
    expect(atual.error).toBe(true);
    expect(atual.text).toContain('main');
    expect(atual.text).toContain('nome novo');
    for (const branch of ['main', 'master', 'MAIN', 'Master', 'develop']) {
      const r = await s.call('git_push', { branch });
      expect(r.error, branch).toBe(true);
      expect(r.text, branch).toContain('não é permitido');
    }
    expect(s.pushes()).toEqual([]);
    expect(git(remote, 'for-each-ref').trim()).toBe('');
  });

  it('nome de branch que escapa do refspec, vira opção ou apaga: recusado antes do git', async () => {
    const dir = await repo();
    const remote = await bare();
    const s = await server(dir, CODEX_AUTO, remote);
    for (const branch of ['refs/heads/main', 'heads/main', '--force', '-f', '+x', 'a:b', 'x y', 'x..y', 'x//y', 'x.lock', 'x/', '', ':main', '^x', 'x~1', 'x\n', 'a'.repeat(300), 42, null, ['main']]) {
      const r = await s.call('git_push', { branch });
      expect(r.error, JSON.stringify(branch)).toBe(true);
    }
    expect(s.pushes()).toEqual([]);
    expect(git(remote, 'for-each-ref').trim()).toBe('');
  });

  it('sem force: o remoto com commits que este não tem recusa o push e continua como estava', async () => {
    const dir = await repo();
    const remote = await bare();
    // Outro clone publica um commit em myco/ana antes.
    const other = path.join(root, `other${++seq}`);
    git(dir, 'push', '-q', remote, 'HEAD:refs/heads/myco/ana');
    execFileSync('git', ['clone', '-q', '-b', 'myco/ana', remote, other]);
    git(other, 'config', 'user.email', 'o@o');
    git(other, 'config', 'user.name', 'o');
    await write(other, 'o.ts', 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'do outro');
    git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/myco/ana');
    const theirs = git(remote, 'rev-parse', 'refs/heads/myco/ana').trim();

    await write(dir, 'a.ts', 'export const v = 8;\n');
    const s = await server(dir, CODEX_AUTO, remote);
    await s.call('git_commit', { mensagem: 'meu', caminhos: ['a.ts'] });
    const r = await s.call('git_push', { branch: 'myco/ana' });
    expect(r.error).toBe(true);
    expect(r.text).toContain('sem force');
    expect(git(remote, 'rev-parse', 'refs/heads/myco/ana').trim()).toBe(theirs);
  });

  it('host fora do github.com (ou URL com usuário e senha, ou outro esquema): recusado antes do push, sem repetir a senha', async () => {
    for (const url of [
      'https://gitlab.com/acme/demo.git',
      'git@gitlab.com:acme/demo.git',
      'https://github.com.evil.com/acme/demo.git',
      'https://evil.com/github.com/acme/demo.git',
      'https://user:segredo123@github.com/acme/demo.git',
      'https://token@github.com/acme/demo.git',
      'http://github.com/acme/demo.git',
      'ext::sh -c evil',
      'file:///tmp/x.git',
    ]) {
      const dir = await repo(url);
      const s = await server(dir);
      const push = await s.call('git_push', { branch: 'myco/ana' });
      expect(push.error, url).toBe(true);
      expect(push.text, url).not.toContain('segredo123');
      const pr = await s.call('git_pr_criar', { titulo: 't', branch: 'myco/ana' });
      expect(pr.error, url).toBe(true);
      expect(s.pushes(), url).toEqual([]);
      expect(s.ghCalls, url).toEqual([]);
    }
  });

  describe('origin com mais de uma pushurl (o push vai para todas)', () => {
    const twoPush = async (...urls: string[]) => {
      const dir = await repo();
      for (const u of urls) git(dir, 'config', '--add', 'remote.origin.pushurl', u);
      expect(git(dir, 'remote', 'get-url', '--push', '--all', 'origin').split(/\r?\n/).filter(Boolean)).toEqual(urls); // o controle: o git as lista todas
      return dir;
    };

    it.each([
      ['a 2ª fora do GitHub', [ORIGIN, 'https://gitlab.com/acme/demo.git']],
      ['a 1ª fora do GitHub', ['https://gitlab.com/acme/demo.git', ORIGIN]],
      ['a 2ª com usuário e senha na URL', [ORIGIN, 'https://user:segredo123@github.com/acme/demo.git']],
      ['a 3ª em outro esquema', [ORIGIN, 'https://github.com/acme/espelho.git', 'ext::sh -c evil']],
    ])('%s: push e PR recusados antes de qualquer chamada de rede, sem repetir a senha', async (_label, urls) => {
      const dir = await twoPush(...urls);
      const remote = await bare();
      const s = await server(dir, CODEX_AUTO, remote);
      const push = await s.call('git_push', { branch: 'myco/ana' });
      expect(push.error).toBe(true);
      expect(push.text).toContain('não é um repositório do github.com');
      expect(push.text).not.toContain('segredo123');
      const pr = await s.call('git_pr_criar', { titulo: 't', branch: 'myco/ana' });
      expect(pr.error).toBe(true);
      expect(s.pushes()).toEqual([]);
      expect(s.ghCalls).toEqual([]);
      expect(git(remote, 'for-each-ref').trim()).toBe('');
    });

    it('todas no GitHub: vale, e a PR vai para o repositório da primeira', async () => {
      const dir = await twoPush(ORIGIN, 'https://github.com/acme/espelho.git');
      const s = await server(dir);
      const pr = await s.call('git_pr_criar', { titulo: 't', branch: 'myco/ana' });
      expect(pr.error, pr.text).toBe(false);
      expect(s.ghCalls[0]!.args).toContain('github.com/acme/demo');
    });
  });

  it('sem o remote origin: recusa', async () => {
    const dir = await repo(null);
    const r = await (await server(dir)).call('git_push', { branch: 'x' });
    expect(r.error).toBe(true);
    expect(r.text).toContain('origin');
  });

  it('falha de rede: tenta de novo com espera crescente (até 3 vezes) e para na rejeição do servidor', async () => {
    resetBreaker();
    const dir = await repo();
    const runDir = path.join(root, `run${++seq}`);
    await fs.mkdir(path.join(runDir, 'nohooks'), { recursive: true });
    await writeGitPolicy(runDir, CODEX_AUTO);
    const safe = createSafeTools({ hooksDir: path.join(runDir, 'nohooks') });
    const waits: number[] = [];
    let tries = 0;
    let failure = 'fatal: unable to access: Could not resolve host: github.com';
    const mcp = createGitMcp({
      projectPath: dir,
      root: dir,
      runDir,
      sleep: async (ms) => void waits.push(ms),
      tools: {
        git: async (cwd, args, opts) => {
          if (args[0] !== 'push') return safe.git(cwd, args, opts);
          tries++;
          throw new Error(failure);
        },
        gh: async () => '',
      },
    });
    const r = await mcp.callTool('git_push', { branch: 'myco/ana' });
    expect(r.isError).toBe(true);
    expect(tries).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
    // Rejeição do servidor não se repete.
    resetBreaker();
    tries = 0;
    failure = ' ! [rejected] HEAD -> myco/ana (non-fast-forward)';
    expect((await mcp.callTool('git_push', { branch: 'myco/ana' })).isError).toBe(true);
    expect(tries).toBe(1);
    resetBreaker();
  });
});

describe('git_pr_criar: argumentos fixos e a PR fica aberta', () => {
  it('chama o gh só com o repositório do origin, `--chave=valor` e o corpo por stdin; sem merge', async () => {
    const dir = await repo();
    const s = await server(dir);
    const r = await s.call('git_pr_criar', { titulo: '--web  Título\ncom quebra', corpo: 'Descrição\n\n- item', branch: 'myco/ana', draft: true });
    expect(r.error, r.text).toBe(false);
    expect(r.text).toBe('PR aberta (merge só pelo dono): https://github.com/acme/demo/pull/7');
    expect(s.ghCalls).toEqual([
      { args: ['pr', 'create', '-R', 'github.com/acme/demo', '--head=myco/ana', '--base=main', '--title=--web Título com quebra', '--body-file=-', '--draft'], input: 'Descrição\n\n- item' },
    ]);
  });

  it('a base padrão é o branch padrão do origin; head main/master, base igual ao head ou inválida: recusado', async () => {
    const dir = await repo();
    git(dir, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    const s = await server(dir);
    await s.call('git_pr_criar', { titulo: 't', branch: 'myco/ana' });
    expect(s.ghCalls[0]!.args).toContain('--base=develop');
    for (const args of [{ titulo: 't', branch: 'main' }, { titulo: 't', branch: 'master' }, { titulo: 't' }, { titulo: 't', branch: 'x', base: 'x' }, { titulo: 't', branch: 'x', base: '--delete' }, { titulo: '', branch: 'x' }, { titulo: 't', branch: 'x', corpo: 7 }]) {
      expect((await s.call('git_pr_criar', args)).error, JSON.stringify(args)).toBe(true);
    }
    expect(s.ghCalls.length).toBe(1);
  });

  it('o gh recusa: o motivo vem sem detalhe interno', async () => {
    const dir = await repo();
    const runDir = path.join(root, `run${++seq}`);
    await writeGitPolicy(runDir, CODEX_AUTO);
    await fs.mkdir(path.join(runDir, 'nohooks'), { recursive: true });
    const safe = createSafeTools({ hooksDir: path.join(runDir, 'nohooks') });
    const mcp = createGitMcp({ projectPath: dir, root: dir, runDir, tools: { git: safe.git, gh: async () => Promise.reject(new Error('a pull request for branch "x" already exists')) } });
    const r = await mcp.callTool('git_pr_criar', { titulo: 't', branch: 'x' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('already exists');
  });
});

describe('githubRepoOf e validBranchName', () => {
  it('só as três formas do GitHub, sem usuário e senha', () => {
    expect(githubRepoOf('https://github.com/acme/demo.git')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(githubRepoOf('https://github.com/acme/demo')).toEqual({ owner: 'acme', repo: 'demo' });
    expect(githubRepoOf('git@github.com:acme/my.repo.git')).toEqual({ owner: 'acme', repo: 'my.repo' });
    expect(githubRepoOf('ssh://git@github.com/acme/demo.git')).toEqual({ owner: 'acme', repo: 'demo' });
    for (const bad of ['https://github.com/acme', 'https://github.com/../demo', 'https://github.com/./x.git', 'https://x@github.com/a/b', 'git@github.com:a/b/c', 'https://github.com/a/b/c.git', 'https://github.com/a b/c']) {
      expect(githubRepoOf(bad), bad).toBeNull();
    }
  });

  it('nomes de branch', () => {
    for (const ok of ['myco/ana', 'feature-1', 'rel_1.5.0', 'a']) expect(validBranchName(ok), ok).toBe(true);
    for (const bad of ['', '-x', '.x', 'a..b', 'a//b', 'a/', 'a.lock', 'refs/x', 'HEADS/x', 'a b', 'a:b', 'a\\b']) expect(validBranchName(bad), bad).toBe(false);
  });
});

describe('ferramentas e argumentos fora da lista', () => {
  it('tools/list tem as seis; reset, rebase, checkout, clean, config, merge, shell e force não existem', async () => {
    const dir = await repo();
    const s = await server(dir);
    const list = (await s.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['git_status', 'git_diff', 'git_log', 'git_commit', 'git_push', 'git_pr_criar']);
    const props = list.result.tools.flatMap((t) => Object.keys(t.inputSchema.properties ?? {}));
    for (const p of props) expect(p).not.toMatch(/force|args|cmd|command|remote|url|cwd|repo|ref|delete|tags/i);
    for (const name of ['git_reset', 'git_rebase', 'git_checkout', 'git_clean', 'git_config', 'git_merge', 'git_pr_merge', 'git_exec', 'bash', '__proto__', 'constructor']) {
      const r = (await s.mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } })) as { error?: { code: number } };
      expect(r.error?.code, name).toBe(-32602);
    }
  });

  it('argumentos a mais são ignorados: força, remote e url do pedido não chegam ao git', async () => {
    const dir = await repo();
    const remote = await bare();
    const s = await server(dir, CODEX_AUTO, remote);
    await s.call('git_push', { branch: 'myco/ana', force: true, remote: 'https://evil.com/x.git', url: 'https://evil.com/x.git', delete: true, refspec: '+main:main', args: ['--force'] });
    expect(s.pushes()).toEqual([['push', '--no-verify', '--no-recurse-submodules', '--no-follow-tags', 'origin', 'HEAD:refs/heads/myco/ana']]);
  });
});
