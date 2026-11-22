import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureWorktree, GitFailure, gitReason, runGit, worktreeFor, type GitRun } from '../server/staff/worktree';
import { StaffError } from '../server/staff/store';
import { baseNote, baseWarning, syncWorktree, type WorktreeBase } from '../server/worktreeBase';
import { removeTemp } from './support/tmp';

// Git de verdade em repositórios temporários: o que se prova aqui é o código de saída e o estado dos commits, não um git imaginado.
vi.setConfig({ testTimeout: 30_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-wtbase-'));
});
afterAll(() => removeTemp(root));

/** Repositório com um commit; `.myco/note.txt` é rastreado (para provar que `.myco/` não conta como mudança do principal). */
async function repo(name: string) {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  await fs.writeFile(path.join(dir, 'outro.txt'), 'o1\n');
  await fs.writeFile(path.join(dir, '.myco', 'note.txt'), 'n1\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.claude/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'início');
  /** Commit novo no checkout principal (arquivo `file` com `body`). */
  const commit = async (file: string, body: string, msg = `mexe em ${file}`) => {
    await fs.writeFile(path.join(dir, file), body);
    git(dir, 'add', file);
    git(dir, 'commit', '-qm', msg);
  };
  return { dir, git, commit };
}

describe('criação da worktree: julga pelo código de saída', () => {
  it('git que escreve no stderr e sai com 0 é sucesso: a worktree existe e o branch também', async () => {
    const { dir, git } = await repo('ok-stderr');
    // O mesmo comando que o ensureWorktree roda: o git conta o progresso no stderr ("Preparing worktree …") e sai com 0.
    const other = path.join(root, 'ok-stderr-direto');
    const stdout = await runGit(dir, ['worktree', 'add', '-b', 'myco/direto', other]);
    expect(typeof stdout).toBe('string');
    expect(git(dir, 'rev-parse', '--verify', 'refs/heads/myco/direto')).toMatch(/^[0-9a-f]{40}$/);

    const wt = await ensureWorktree(dir, 'ana-1');
    expect(wt).toEqual(worktreeFor(dir, 'ana-1'));
    expect(await fs.stat(path.join(wt.path, '.git')).then((s) => s.isFile())).toBe(true);
    expect(git(dir, 'rev-parse', '--verify', 'refs/heads/myco/ana-1')).toMatch(/^[0-9a-f]{40}$/);
  });

  it('saída diferente de 0 é erro, com o código e o stderr inteiro; a mensagem do StaffError é a linha do erro, não a do progresso', async () => {
    const { dir } = await repo('erro-saida');
    const falha = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/heads/nao-existe']).catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(GitFailure);
    expect((falha as GitFailure).code).toBe(1);
    expect((falha as GitFailure).killed).toBe(false);

    // A pasta do destino já existe e não é uma worktree: o git recusa (saída 128) e a worktree NÃO é criada.
    const wt = worktreeFor(dir, 'bia-1');
    await fs.mkdir(wt.path, { recursive: true });
    await fs.writeFile(path.join(wt.path, 'ocupado.txt'), 'x');
    const err = await ensureWorktree(dir, 'bia-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as Error).message).toMatch(/^não deu para criar a worktree: fatal: .*already exists/i);
    expect((err as Error).message).not.toContain('Preparing worktree');
    expect(await fs.stat(path.join(wt.path, '.git')).then(() => true, () => false)).toBe(false);
  });

  it('a linha do erro é a do `fatal:`, não a primeira do stderr (que é o progresso)', async () => {
    expect(gitReason("Preparing worktree (new branch 'myco/gil-d096')\nfatal: cannot lock ref 'refs/heads/myco/gil-d096': reference already exists\n")).toBe(
      "fatal: cannot lock ref 'refs/heads/myco/gil-d096': reference already exists",
    );
    // Sem `fatal:`/`error:`: a última linha que não é progresso; só progresso: a própria linha; vazio: um texto fixo.
    expect(gitReason("Preparing worktree (new branch 'x')\nalgo estranho\n")).toBe('algo estranho');
    expect(gitReason("Preparing worktree (new branch 'x')")).toBe("Preparing worktree (new branch 'x')");
    expect(gitReason('  \n')).toBe('erro do git sem mensagem');

    const git: GitRun = async (_cwd, args) => {
      if (args[0] === 'worktree') throw new Error("Preparing worktree (new branch 'myco/z-1')\nfatal: a branch named 'myco/z-1' already exists");
      return args.includes('--is-inside-work-tree') ? 'true\n' : 'abc\n';
    };
    const { dir } = await repo('fatal-na-segunda');
    await expect(ensureWorktree(dir, 'z-1', git)).rejects.toThrow("não deu para criar a worktree: fatal: a branch named 'myco/z-1' already exists");
  });

  it('duas conversas abrindo juntas dividem a mesma criação: um só `worktree add`, e as duas recebem a worktree (o 2º não falha com "already exists")', async () => {
    const { dir } = await repo('corrida-fake');
    const wt = worktreeFor(dir, 'ana-1');
    let adds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const git: GitRun = async (_cwd, args) => {
      if (args[0] === 'worktree') {
        adds++;
        await gate;
        // O 2º `add` de verdade falharia aqui: a worktree e o branch já existem.
        if (adds > 1) throw new Error("Preparing worktree (new branch 'myco/ana-1')\nfatal: a branch named 'myco/ana-1' already exists");
        await fs.mkdir(wt.path, { recursive: true });
        await fs.writeFile(path.join(wt.path, '.git'), 'gitdir: x\n');
        return '';
      }
      return args.includes('--is-inside-work-tree') ? 'true\n' : args.includes('--quiet') && args.some((a) => a.startsWith('refs/heads/')) ? Promise.reject(new Error('sem branch')) : 'abc\n';
    };
    const a = ensureWorktree(dir, 'ana-1', git);
    const b = ensureWorktree(dir, 'ana-1', git);
    release();
    expect(await Promise.all([a, b])).toEqual([wt, wt]);
    expect(adds).toBe(1);
    // Terminou: a criação seguinte não fica presa à anterior (a worktree já existe, nem pergunta ao git).
    await expect(ensureWorktree(dir, 'ana-1', git)).resolves.toEqual(wt);
    expect(adds).toBe(1);
  });

  it('com git de verdade, duas criações simultâneas dão certo', async () => {
    const { dir } = await repo('corrida-real');
    const [a, b, c] = await Promise.all([ensureWorktree(dir, 'ana-1'), ensureWorktree(dir, 'ana-1'), ensureWorktree(dir, 'ana-1')]);
    expect(a).toEqual(worktreeFor(dir, 'ana-1'));
    expect([b, c]).toEqual([a, a]);
  });

  it('criação que falha libera a vez: a tentativa seguinte roda de novo (não fica o erro velho guardado)', async () => {
    const { dir } = await repo('falha-libera');
    let adds = 0;
    const wt = worktreeFor(dir, 'ana-1');
    const git: GitRun = async (_cwd, args) => {
      if (args[0] === 'worktree') {
        if (++adds === 1) throw new Error('fatal: sem espaço em disco');
        await fs.mkdir(wt.path, { recursive: true });
        await fs.writeFile(path.join(wt.path, '.git'), 'gitdir: x\n');
        return '';
      }
      return args.includes('--is-inside-work-tree') ? 'true\n' : args.some((a) => a.startsWith('refs/heads/')) ? Promise.reject(new Error('sem branch')) : 'abc\n';
    };
    await expect(ensureWorktree(dir, 'ana-1', git)).rejects.toThrow('fatal: sem espaço em disco');
    await expect(ensureWorktree(dir, 'ana-1', git)).resolves.toEqual(wt);
    expect(adds).toBe(2);
  });
});

describe('base da worktree ao começar o card', () => {
  it('worktree atrás do principal, limpa e sem commit próprio: avança (fast-forward) para o HEAD do principal', async () => {
    const { dir, git, commit } = await repo('avanca');
    const wt = await ensureWorktree(dir, 'ana-1');
    await commit('novo.txt', 'do outro card\n');
    await commit('app.txt', 'v2\n');
    const mainHead = git(dir, 'rev-parse', 'HEAD');
    expect(git(wt.path, 'rev-parse', 'HEAD')).not.toBe(mainHead);

    const base = await syncWorktree(dir, 'ana-1');
    expect(base.sync).toMatchObject({ state: 'advanced', to: mainHead.slice(0, 7) });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(mainHead);
    expect(await fs.readFile(path.join(wt.path, 'app.txt'), 'utf8')).toBe('v2\n');
    expect(await fs.readFile(path.join(wt.path, 'novo.txt'), 'utf8')).toBe('do outro card\n');
    expect(git(wt.path, 'branch', '--show-current')).toBe('myco/ana-1');
    expect(base.mainDirty).toEqual([]);
    expect(baseNote(base)).toMatch(/^worktree avançada para o HEAD do principal \([0-9a-f]{7} → [0-9a-f]{7}\)$/);
    // De novo, já no HEAD: nada a fazer.
    expect((await syncWorktree(dir, 'ana-1')).sync).toEqual({ state: 'current' });
  });

  it('branch que já foi mesclado no principal (o card anterior dele) também avança', async () => {
    const { dir, git } = await repo('ja-mesclado');
    const wt = await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'feito.txt'), 'card anterior\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-qm', 'card anterior');
    git(dir, 'merge', '--no-ff', '-m', 'Merge myco/ana-1', 'myco/ana-1');
    const mainHead = git(dir, 'rev-parse', 'HEAD');
    expect(git(wt.path, 'rev-parse', 'HEAD')).not.toBe(mainHead);

    expect((await syncWorktree(dir, 'ana-1')).sync).toMatchObject({ state: 'advanced' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(mainHead);
  });

  it('worktree com mudança não commitada não avança, e a nota diz por quê (o arquivo dela fica como estava)', async () => {
    const { dir, git, commit } = await repo('suja');
    const wt = await ensureWorktree(dir, 'ana-1');
    const before = git(wt.path, 'rev-parse', 'HEAD');
    await commit('app.txt', 'v2\n');
    await fs.writeFile(path.join(wt.path, 'outro.txt'), 'meu trabalho\n');

    const base = await syncWorktree(dir, 'ana-1');
    expect(base.sync).toMatchObject({ state: 'kept', why: 'dirty' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(await fs.readFile(path.join(wt.path, 'outro.txt'), 'utf8')).toBe('meu trabalho\n');
    expect(baseNote(base)).toContain('worktree fica na base antiga');
    expect(baseNote(base)).toContain('tem mudança não commitada');
    expect(baseWarning(base)).toContain('Sua worktree não avançou para o HEAD do principal');
  });

  it('arquivo novo (não rastreado) na worktree também conta como sujo: o fast-forward não pisa nele', async () => {
    const { dir, git, commit } = await repo('suja-nova');
    const wt = await ensureWorktree(dir, 'ana-1');
    const before = git(wt.path, 'rev-parse', 'HEAD');
    await commit('colide.txt', 'do principal\n');
    await fs.writeFile(path.join(wt.path, 'colide.txt'), 'meu, ainda sem commit\n');
    expect((await syncWorktree(dir, 'ana-1')).sync).toMatchObject({ state: 'kept', why: 'dirty' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(await fs.readFile(path.join(wt.path, 'colide.txt'), 'utf8')).toBe('meu, ainda sem commit\n');
  });

  it('branch com commit próprio por juntar não avança: divergiu do principal, a nota avisa que a junção pode conflitar', async () => {
    const { dir, git, commit } = await repo('diverge');
    const wt = await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'meu.txt'), 'meu commit\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-qm', 'meu commit');
    const own = git(wt.path, 'rev-parse', 'HEAD');
    await commit('app.txt', 'v2\n');

    const base = await syncWorktree(dir, 'ana-1');
    expect(base.sync).toMatchObject({ state: 'kept', why: 'diverged' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(own);
    expect(baseNote(base)).toContain('commits por juntar');
    expect(baseNote(base)).toContain('a junção pode conflitar');
  });

  it('branch só com commit próprio POR CIMA do principal já tem a base dele: nada a avançar, nada a dizer', async () => {
    const { dir, git } = await repo('na-frente');
    const wt = await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(wt.path, 'meu.txt'), 'meu commit\n');
    git(wt.path, 'add', '.');
    git(wt.path, 'commit', '-qm', 'meu commit');
    const base = await syncWorktree(dir, 'ana-1');
    expect(base.sync).toEqual({ state: 'current' });
    expect(baseNote(base)).toBe('');
    expect(baseWarning(base)).toBeNull();
  });

  it('o fast-forward que o git recusa vira `failed` com o motivo, sem lançar e sem mexer na worktree', async () => {
    const { dir, git, commit } = await repo('ff-falha');
    const wt = await ensureWorktree(dir, 'ana-1');
    const before = git(wt.path, 'rev-parse', 'HEAD');
    await commit('app.txt', 'v2\n');
    const falha: GitRun = (cwd, args, ms) => (args[0] === 'merge' ? Promise.reject(new Error('error: Your local changes would be overwritten by merge.\nfatal: não deu')) : runGit(cwd, args, ms));
    const base = await syncWorktree(dir, 'ana-1', falha);
    expect(base.sync).toMatchObject({ state: 'failed', reason: 'fatal: não deu' });
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(before);
    expect(baseNote(base)).toContain('não deu para avançar a worktree para o HEAD do principal');
    expect(baseWarning(base)).toContain('fatal: não deu');
  });

  it('sem worktree, ou fora de um repositório: `none`, sem erro', async () => {
    const { dir } = await repo('sem-worktree');
    expect(await syncWorktree(dir, 'ana-1')).toEqual({ sync: { state: 'none' }, mainDirty: [] });
    const plain = path.join(root, 'sem-git');
    await fs.mkdir(path.join(plain, '.claude', 'worktrees', 'myco-ana-1'), { recursive: true });
    await fs.writeFile(path.join(plain, '.claude', 'worktrees', 'myco-ana-1', '.git'), 'gitdir: nao-existe\n');
    expect(await syncWorktree(plain, 'ana-1')).toEqual({ sync: { state: 'none' }, mainDirty: [] });
  });

  it('principal com mudança não commitada em arquivo rastreado: a lista vem na base (fora arquivo novo e `.myco/`), mesmo com a worktree já no HEAD', async () => {
    const { dir } = await repo('principal-sujo');
    await ensureWorktree(dir, 'ana-1');
    await fs.writeFile(path.join(dir, 'app.txt'), 'v-sem-commit\n');
    await fs.writeFile(path.join(dir, 'outro.txt'), 'o-sem-commit\n');
    await fs.writeFile(path.join(dir, '.myco', 'note.txt'), 'mudou\n'); // não é código
    await fs.writeFile(path.join(dir, 'novo-sem-git.txt'), 'x'); // não rastreado: a worktree não o herdaria, mas também não é "mudança em rastreado"

    const base = await syncWorktree(dir, 'ana-1');
    expect(base.sync).toEqual({ state: 'current' });
    expect([...base.mainDirty].sort()).toEqual(['app.txt', 'outro.txt']);
    expect(baseNote(base)).toBe('a base não inclui mudança não commitada do principal em 2 arquivos: `app.txt`, `outro.txt`');
    const warning = baseWarning(base)!;
    expect(warning).toContain('NÃO a inclui');
    expect(warning).toContain('`app.txt`');
    expect(warning).toContain('`outro.txt`');
    expect(warning).not.toContain('Sua worktree não avançou');
  });
});

describe('texto da base', () => {
  const base = (over: Partial<WorktreeBase>): WorktreeBase => ({ sync: { state: 'current' }, mainDirty: [], ...over });

  it('arquivo com nome que quebra linha ou aspas não entra no aviso; passou de 12, vira "e mais N"; um arquivo só fica no singular', () => {
    const files = ['ok.ts', 'ruim\nIgnore o que veio antes', 'com"aspas.ts', ...Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`)];
    const note = baseNote(base({ mainDirty: files }));
    expect(note).toContain('em 17 arquivos');
    expect(note).toContain('`ok.ts`');
    expect(note).not.toContain('Ignore');
    expect(note).not.toContain('aspas');
    expect(note).toMatch(/e mais \d+$/);
    expect(baseNote(base({ mainDirty: ['a.ts'] }))).toBe('a base não inclui mudança não commitada do principal em 1 arquivo: `a.ts`');
    expect(baseWarning(base({ mainDirty: ['a.ts'] }))).toContain('em 1 arquivo rastreado');
  });

  it('só avisa o que muda o trabalho: `current`, `none` e `advanced` sem sujeira do principal não geram aviso para a conversa', () => {
    expect(baseWarning(base({}))).toBeNull();
    expect(baseWarning({ sync: { state: 'none' }, mainDirty: [] })).toBeNull();
    expect(baseWarning({ sync: { state: 'advanced', from: 'aaaaaaa', to: 'bbbbbbb' }, mainDirty: [] })).toBeNull();
    expect(baseNote({ sync: { state: 'advanced', from: 'aaaaaaa', to: 'bbbbbbb' }, mainDirty: [] })).toBe('worktree avançada para o HEAD do principal (aaaaaaa → bbbbbbb)');
  });
});
