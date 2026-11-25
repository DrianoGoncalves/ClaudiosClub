import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allocateCardPort,
  cardWorktreeAvailable,
  cardWorktreeFor,
  CardWorktreeError,
  ensureCardWorktree,
  listCardWorktrees,
  MIN_FREE_BYTES,
  removeCardWorktree,
  rescueRefFor,
} from '../server/cardWorktree';
import { removeTemp } from './support/tmp';

// A worktree de um card (server/cardWorktree.ts): criação do HEAD do principal, junção de node_modules, remoção sem seguir a junção, resgate do cancelado, fallback e porta. Git de verdade.
// Cada teste cria worktrees (git worktree add) e a máquina cheia passa dos 5 s.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-cardwt-'));
});
afterAll(async () => {
  await removeTemp(root);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
let n = 0;

/** Projeto git com um commit, `node_modules` (com um arquivo-sentinela) ignorado e um arquivo versionado. */
async function repo(opts: { ignoreDeps?: boolean } = {}) {
  const dir = path.join(root, `p${++n}`);
  await fs.mkdir(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Teste');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'core.autocrlf', 'false');
  await fs.writeFile(path.join(dir, 'node_modules', 'dep', 'sentinela.txt'), 'não pode sumir\n');
  await fs.writeFile(path.join(dir, '.gitignore'), `${opts.ignoreDeps === false ? '' : 'node_modules/\n'}.claude/\n`);
  await fs.writeFile(path.join(dir, 'app.txt'), 'v1\n');
  git(dir, 'add', '.gitignore', 'app.txt');
  git(dir, 'commit', '-qm', 'início');
  return dir;
}

describe('nome e caminho', () => {
  it('pasta myco-card-<id> em .claude/worktrees e branch myco-card/<id>', () => {
    const wt = cardWorktreeFor('/p', 't-250de1');
    expect(wt.path).toBe(path.join('/p', '.claude', 'worktrees', 'myco-card-t-250de1'));
    expect(wt.branch).toBe('myco-card/t-250de1');
  });

  it('id que não serve de nome de pasta é recusado (nada de separador nem ..)', () => {
    for (const bad of ['../x', 'a/b', 'a b', '', 'a'.repeat(61), '-x', 'x\\y']) expect(() => cardWorktreeFor('/p', bad)).toThrow(CardWorktreeError);
  });
});

describe('criação', () => {
  it('nasce do HEAD do principal de agora, no branch do card', async () => {
    const dir = await repo();
    await fs.writeFile(path.join(dir, 'novo.txt'), 'x\n');
    git(dir, 'add', 'novo.txt');
    git(dir, 'commit', '-qm', 'segundo');
    const wt = await ensureCardWorktree(dir, 't-aaa111');
    expect(wt.path).toBe(path.join(dir, '.claude', 'worktrees', 'myco-card-t-aaa111'));
    expect(existsSync(path.join(wt.path, '.git'))).toBe(true);
    expect(wt.base).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('myco-card/t-aaa111');
    expect(existsSync(path.join(wt.path, 'novo.txt'))).toBe(true);
  });

  it('é idempotente (reinício, retomada): a segunda chamada reencontra a pasta e o que está nela', async () => {
    const dir = await repo();
    const a = await ensureCardWorktree(dir, 't-bbb222');
    await fs.writeFile(path.join(a.path, 'rascunho.txt'), 'sem commit\n');
    const b = await ensureCardWorktree(dir, 't-bbb222');
    expect(b.path).toBe(a.path);
    expect(await fs.readFile(path.join(b.path, 'rascunho.txt'), 'utf8')).toBe('sem commit\n');
    expect(git(dir, 'branch', '--list', 'myco-card/t-bbb222').length).toBeGreaterThan(0);
  });

  it('duas criações juntas dividem uma só (o segundo `worktree add` falharia)', async () => {
    const dir = await repo();
    const [a, b] = await Promise.all([ensureCardWorktree(dir, 't-ccc333'), ensureCardWorktree(dir, 't-ccc333')]);
    expect(a.path).toBe(b.path);
    expect(git(dir, 'worktree', 'list', '--porcelain').split('worktree ').filter((l) => l.includes('myco-card-t-ccc333'))).toHaveLength(1);
  });

  it('dois cards, duas pastas, cada um no seu branch', async () => {
    const dir = await repo();
    const a = await ensureCardWorktree(dir, 't-d1');
    const b = await ensureCardWorktree(dir, 't-d2');
    expect(a.path).not.toBe(b.path);
    expect(await listCardWorktrees(dir)).toEqual(expect.arrayContaining(['t-d1', 't-d2']));
  });

  it('pasta incompleta (o Club caiu no meio do `worktree add`) é refeita', async () => {
    const dir = await repo();
    const wt = cardWorktreeFor(dir, 't-eee555');
    await fs.mkdir(wt.path, { recursive: true });
    await fs.writeFile(path.join(wt.path, 'lixo.txt'), 'meio\n');
    const made = await ensureCardWorktree(dir, 't-eee555');
    expect(existsSync(path.join(made.path, '.git'))).toBe(true);
    expect(existsSync(path.join(made.path, 'lixo.txt'))).toBe(false);
  });

  it('branch velho sem commit do card (já todo no principal) NÃO é reaproveitado: o card nasce do HEAD de agora', async () => {
    const dir = await repo();
    git(dir, 'branch', 'myco-card/t-old1'); // sobra de uma tentativa antiga: aponta para um commit que o principal já passou
    await fs.writeFile(path.join(dir, 'depois.txt'), 'x\n');
    git(dir, 'add', 'depois.txt');
    git(dir, 'commit', '-qm', 'o principal andou');
    const wt = await ensureCardWorktree(dir, 't-old1');
    expect(wt.base).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(existsSync(path.join(wt.path, 'depois.txt'))).toBe(true);
  });

  it('branch que sobrou sem pasta é reaproveitado, com os commits dele', async () => {
    const dir = await repo();
    const a = await ensureCardWorktree(dir, 't-fff666');
    await fs.writeFile(path.join(a.path, 'feito.txt'), 'feito\n');
    git(a.path, 'add', 'feito.txt');
    git(a.path, 'commit', '-qm', 'feito');
    // A pasta some (apagada por fora), o branch fica.
    await fs.rm(a.path, { recursive: true, force: true });
    const again = await ensureCardWorktree(dir, 't-fff666');
    expect(await fs.readFile(path.join(again.path, 'feito.txt'), 'utf8')).toBe('feito\n');
  });
});

describe('junção das dependências', () => {
  it('node_modules ignorado vira junção para o do projeto e o git do card não a vê como mudança', async () => {
    const dir = await repo();
    const wt = await ensureCardWorktree(dir, 't-g1');
    expect(wt.linked).toEqual(['node_modules']);
    expect((await fs.lstat(path.join(wt.path, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(wt.path, 'node_modules', 'dep', 'sentinela.txt'), 'utf8')).toBe('não pode sumir\n');
    expect(git(wt.path, 'status', '--porcelain')).toBe('');
  });

  it('node_modules que o git não ignora NÃO é ligado (apareceria como mudança do card)', async () => {
    const dir = await repo({ ignoreDeps: false });
    const wt = await ensureCardWorktree(dir, 't-g2');
    expect(wt.linked).toEqual([]);
    expect(existsSync(path.join(wt.path, 'node_modules'))).toBe(false);
  });
});

describe('remoção', () => {
  it('apaga a pasta e o branch SEM seguir a junção: o node_modules do projeto continua inteiro', async () => {
    const dir = await repo();
    const wt = await ensureCardWorktree(dir, 't-h1');
    expect(wt.linked).toContain('node_modules');
    const r = await removeCardWorktree(dir, 't-h1');
    expect(r).toEqual({ removed: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(dir, 'branch', '--list', 'myco-card/t-h1')).toBe('');
    expect(await fs.readFile(path.join(dir, 'node_modules', 'dep', 'sentinela.txt'), 'utf8')).toBe('não pode sumir\n');
  });

  it('junção que o próprio card criou, no fundo da árvore, também sai sem levar o destino', async () => {
    const dir = await repo();
    const alvo = path.join(root, `alvo-${++n}`);
    await fs.mkdir(alvo, { recursive: true });
    await fs.writeFile(path.join(alvo, 'precioso.txt'), 'x\n');
    const wt = await ensureCardWorktree(dir, 't-h2');
    await fs.mkdir(path.join(wt.path, 'sub', 'fundo'), { recursive: true });
    await fs.symlink(alvo, path.join(wt.path, 'sub', 'fundo', 'atalho'), 'junction');
    expect((await removeCardWorktree(dir, 't-h2')).removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(await fs.readFile(path.join(alvo, 'precioso.txt'), 'utf8')).toBe('x\n');
  });

  it('card junto ao principal: o branch só sai se está todo nele; com commit por juntar, fica', async () => {
    const dir = await repo();
    const wt = await ensureCardWorktree(dir, 't-h3');
    await fs.writeFile(path.join(wt.path, 'so-no-card.txt'), 'x\n');
    git(wt.path, 'add', 'so-no-card.txt');
    git(wt.path, 'commit', '-qm', 'no card');
    const r = await removeCardWorktree(dir, 't-h3');
    expect(r).toEqual({ removed: true, branchKept: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(git(dir, 'branch', '--list', 'myco-card/t-h3')).toContain('myco-card/t-h3');
  });

  it('cancelado (`discard`): pasta e branch somem, e o que havia (commitado ou não) fica em refs/myco/cancelled/<id>', async () => {
    const dir = await repo();
    const wt = await ensureCardWorktree(dir, 't-h4');
    await fs.writeFile(path.join(wt.path, 'meio.txt'), 'sem commit\n');
    const r = await removeCardWorktree(dir, 't-h4', { discard: true });
    expect(r.removed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(dir, 'branch', '--list', 'myco-card/t-h4')).toBe('');
    expect(git(dir, 'show', `${rescueRefFor('t-h4')}:meio.txt`)).toBe('sem commit');
  });

  it('refazer a remoção do que já saiu não falha (a limpeza pendente do tick)', async () => {
    const dir = await repo();
    await ensureCardWorktree(dir, 't-h5');
    expect((await removeCardWorktree(dir, 't-h5')).removed).toBe(true);
    expect((await removeCardWorktree(dir, 't-h5')).removed).toBe(true);
  });
});

describe('quando não dá (o card edita no principal, com o motivo)', () => {
  it('pasta que não é repositório git', async () => {
    const dir = path.join(root, `sem-git-${++n}`);
    await fs.mkdir(dir, { recursive: true });
    expect(await cardWorktreeAvailable(dir)).toEqual({ ok: false, reason: 'o projeto não é um repositório git' });
  });

  it('repositório sem nenhum commit', async () => {
    const dir = path.join(root, `sem-commit-${++n}`);
    await fs.mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    expect(await cardWorktreeAvailable(dir)).toEqual({ ok: false, reason: 'o repositório ainda não tem nenhum commit' });
  });

  it('pouco espaço em disco: abaixo do piso (e de cinco vezes os arquivos versionados)', async () => {
    const dir = await repo();
    const r = await cardWorktreeAvailable(dir, undefined, async () => MIN_FREE_BYTES - 1);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/pouco espaço em disco/);
    expect(await cardWorktreeAvailable(dir, undefined, async () => MIN_FREE_BYTES * 4)).toEqual({ ok: true });
    // Não conseguir ler o espaço não barra.
    expect(await cardWorktreeAvailable(dir, undefined, async () => null)).toEqual({ ok: true });
  });
});

describe('porta do servidor de tela', () => {
  it('uma da faixa, estável para o mesmo card, fora das que outro card já tem e das ocupadas', async () => {
    const free = async () => true;
    const a = (await allocateCardPort('t-p1', [], free))!;
    expect(a).toBeGreaterThanOrEqual(43000);
    expect(a).toBeLessThanOrEqual(43999);
    expect(await allocateCardPort('t-p1', [], free)).toBe(a);
    const other = (await allocateCardPort('t-p1', [a], free))!;
    expect(other).not.toBe(a);
    const busy = (await allocateCardPort('t-p1', [], async (p) => p !== a && p !== other))!;
    expect([a, other]).not.toContain(busy);
  });

  it('faixa toda tomada: null', async () => {
    expect(await allocateCardPort('t-p2', [], async () => false)).toBeNull();
  });
});
