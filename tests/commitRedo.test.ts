import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DIFF_FILE_MAX } from '../server/commitLeft';
import { TaskConflictError, TaskError, TaskForbiddenError, readTasks } from '../server/tasks';
import { COMMIT_REDOS_MAX } from '../shared/model';
import { commits, dirty, filesOf, git, project, write, type Project } from './support/commitRepo';
import { removeTemp } from './support/tmp';

// Refazer o commit das sobras pelo botão (t-50cd4f): o preview (arquivos, diff, digest) e o POST, que revalida tudo na fila de commits do projeto. Repositórios git de verdade, em pasta temporária.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-commitredo-'));
});
afterAll(() => removeTemp(root));

const preview = (p: Project, id: string) => p.svc.previewLeftovers('p', id, true);
const redo = (p: Project, id: string, digest: string) => p.svc.redoLeftovers('p', id, { digest }, true);
const NO_DIGEST = '0'.repeat(32);
const head = (p: Project) => git(p.dir, 'rev-parse', 'HEAD').trim();

/**
 * "Tela A" fica pronta levando `mine` e deixa `left` de fora, porque "Tela B" (aberta) também os alterou. `prep` escreve os arquivos antes. `free()` solta os arquivos (B segue aberta, em outro
 * arquivo); `cancel()` cancela a B.
 */
async function scenario(name: string, left: string[], prep: (p: Project) => Promise<void>, mine: string[] = ['a.ts']) {
  const p = await project(root, name);
  await p.on();
  await prep(p);
  const b = await p.task('Tela B', { changedFiles: left, status: 'review' });
  const a = await p.task('Tela A', { changedFiles: [...mine, ...left], status: 'review' });
  const t = await p.finish(a);
  return { p, a, b, t, free: () => p.edit(b, { changedFiles: ['x.ts'] }), cancel: () => p.edit(b, { status: 'cancelled' }) };
}
/** O caso de sempre: a.ts entra, b.ts fica de fora; b.ts já está livre (`release` falso: a Tela B segue tocando b.ts, para o teste cancelá-la). */
async function ready(name: string, release = true) {
  const s = await scenario(name, ['b.ts'], async (p) => {
    await write(p.dir, 'a.ts', 'export const a = 2;\n');
    await write(p.dir, 'b.ts', 'export const b = 2;\n');
  });
  if (release) await s.free();
  return s;
}

describe('preview', () => {
  it('waiting: lista o card que trava e os arquivos, sem diff e sem botão', async () => {
    const s = await scenario('pv-waiting', ['b.ts'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
    });
    const pv = (await preview(s.p, s.a))!;
    expect(pv).toMatchObject({ taskId: s.a, state: 'waiting', canRedo: false, digest: '', sha: s.t.commit!.sha, dropped: [] });
    expect(pv.blockers).toEqual([{ id: s.b, title: 'Tela B', status: 'review', paths: ['b.ts'] }]);
    expect(pv.files).toEqual([{ path: 'b.ts', why: 'shared', by: [s.b], redo: true, status: 'M', diff: '' }]);
  });

  it('ready: arquivo, motivo, diff do que o commit levaria, digest e HEAD', async () => {
    const s = await ready('pv-ready');
    const pv = (await preview(s.p, s.a))!;
    expect(pv).toMatchObject({ state: 'ready', canRedo: true, head: head(s.p).slice(0, 7), blockers: [], dropped: [] });
    expect(pv.digest).toMatch(/^[0-9a-f]{32}$/);
    expect(pv.files).toHaveLength(1);
    expect(pv.files[0]).toMatchObject({ path: 'b.ts', why: 'shared', by: [], redo: true, status: 'M' });
    expect(pv.files[0]!.diff).toContain('-export const v = 1; // b.ts');
    expect(pv.files[0]!.diff).toContain('+export const b = 2;');
  });

  it('arquivo novo (sem rastreio) sai como A com o conteúdo, e apagado como D', async () => {
    const s = await scenario('pv-novo-apagado', ['n.ts', 'c.ts'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'n.ts', 'export const n = 1;\nexport const m = 2;\n');
      await fs.rm(path.join(p.dir, 'c.ts'));
    });
    await s.free();
    const pv = (await preview(s.p, s.a))!;
    const n = pv.files.find((f) => f.path === 'n.ts')!;
    expect(n.status).toBe('A');
    expect(n.diff).toContain('+++ b/n.ts');
    expect(n.diff).toContain('+export const n = 1;');
    expect(n.diff).toContain('@@ -0,0 +1,2 @@');
    const c = pv.files.find((f) => f.path === 'c.ts')!;
    expect(c.status).toBe('D');
    expect(c.diff).toContain('-export const v = 1; // c.ts');
  });

  it('card cancelado que tocou o arquivo: não trava, mas o preview marca cancelledBy', async () => {
    const s = await ready('pv-cancelado', false);
    await s.cancel();
    const pv = (await preview(s.p, s.a))!;
    expect(pv).toMatchObject({ state: 'ready', canRedo: true });
    expect(pv.files[0]!.cancelledBy).toEqual([s.b]);
  });

  it('NUNCA devolve diff de arquivo barrado pelo bloqueio de segredos, qualquer que seja o motivo gravado', async () => {
    const secrets = ['.env', 'server.key', '.ssh/config', 'id_rsa', 'credentials-prod.json'];
    const s = await scenario('pv-segredo', ['b.ts', ...secrets], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
      await fs.mkdir(path.join(p.dir, '.ssh'), { recursive: true });
      for (const f of secrets) await write(p.dir, f, 'TOPSECRET=hunter2\n');
    });
    await s.free();
    // O commit automático os marcou como `blocked`; o aviso gravado diz outra coisa (shared): o preview confere pelo caminho, não pelo motivo gravado.
    const all = JSON.parse(await fs.readFile(s.p.file, 'utf8')) as Array<Record<string, any>>;
    const mine = all.find((x) => x.id === s.a)!;
    mine.commit.left = mine.commit.left.map((l: { path: string }) => ({ path: l.path, why: 'shared', by: s.b }));
    await fs.writeFile(s.p.file, JSON.stringify(all));
    const pv = (await preview(s.p, s.a))!;
    const text = JSON.stringify(pv);
    expect(text).not.toContain('TOPSECRET');
    expect(text).not.toContain('hunter2');
    for (const f of secrets) expect(pv.files.find((x) => x.path === f)).toMatchObject({ why: 'blocked', redo: false, diff: '' });
    expect(pv.files.find((x) => x.path === 'b.ts')).toMatchObject({ redo: true });
    expect(pv.files.find((x) => x.path === 'b.ts')!.diff).toContain('+export const b = 2;');
    expect(pv.canRedo).toBe(true);
  });

  it('só segredo sobrando: o preview existe, mas sem botão e sem digest', async () => {
    const s = await scenario('pv-so-segredo', ['.env'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, '.env', 'SECRET=2\n');
    });
    await s.free();
    const pv = (await preview(s.p, s.a))!;
    expect(pv).toMatchObject({ state: 'ready', canRedo: false, digest: '' });
    expect(pv.files).toEqual([{ path: '.env', why: 'blocked', by: [], redo: false, status: 'M', diff: '' }]);
  });

  it('diff comprido é cortado em 64 KB por arquivo e em 400 KB no todo (o que passa sai sem diff, marcado)', async () => {
    const names = Array.from({ length: 9 }, (_, i) => `big${i}.ts`);
    const line = `${'x'.repeat(98)}\n`;
    const s = await scenario('pv-teto', names, async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      for (const f of names) await write(p.dir, f, line.repeat(620)); // ~62 KB: cabe no teto do arquivo
    });
    await s.free();
    const pv = (await preview(s.p, s.a))!;
    expect(pv.files).toHaveLength(9);
    expect(pv.files.slice(0, 7).every((f) => f.diff.length > 60_000 && f.diff.length <= DIFF_FILE_MAX && !f.diffTruncated)).toBe(true);
    expect(pv.files.slice(7).map((f) => [f.diff, f.diffTruncated])).toEqual([
      ['', true],
      ['', true],
    ]);
    // Um arquivo maior que o teto do arquivo: cortado, e marcado.
    await write(s.p.dir, 'big0.ts', line.repeat(2000));
    expect((await preview(s.p, s.a))!.files[0]).toMatchObject({ diffTruncated: true });
    expect((await preview(s.p, s.a))!.files[0]!.diff.length).toBeLessThanOrEqual(DIFF_FILE_MAX);
  });

  it('binário (rastreado ou novo): sem diff, marcado binary', async () => {
    const s = await scenario('pv-binario', ['b.ts', 'img.bin'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', Buffer.from([0x89, 0x50, 0, 0, 1, 2, 3]));
      await write(p.dir, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 0]));
    });
    await s.free();
    const pv = (await preview(s.p, s.a))!;
    expect(pv.files.map((f) => [f.path, f.binary, f.diff])).toEqual([
      ['b.ts', true, ''],
      ['img.bin', true, ''],
    ]);
  });

  it('só lê: HEAD, índice, arquivos e tasks.json ficam como estavam', async () => {
    const s = await ready('pv-leitura');
    const before = { head: head(s.p), status: git(s.p.dir, 'status', '--porcelain'), tasks: await fs.readFile(s.p.file, 'utf8') };
    await preview(s.p, s.a);
    await preview(s.p, s.a);
    expect({ head: head(s.p), status: git(s.p.dir, 'status', '--porcelain'), tasks: await fs.readFile(s.p.file, 'utf8') }).toEqual(before);
  });

  it('sobras já sem mudança no git: sem estado, sem botão, e diz quais sumiram', async () => {
    const s = await ready('pv-limpo');
    git(s.p.dir, 'commit', '-q', '-m', 'à mão', '--', 'b.ts');
    expect(await preview(s.p, s.a)).toMatchObject({ canRedo: false, digest: '', files: [], dropped: ['b.ts'] });
  });

  it('tarefa que voltou para o trabalho (o commit não é mais da entrega): o botão não vale', async () => {
    const s = await ready('pv-reaberta');
    await s.p.edit(s.a, { status: 'doing' });
    expect(await preview(s.p, s.a)).toMatchObject({ state: 'ready', canRedo: false, digest: '' });
  });

  it('só a tela: 403 antes de ler qualquer coisa; tarefa inexistente: null', async () => {
    const s = await ready('pv-tela');
    await expect(s.p.svc.previewLeftovers('p', s.a, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(s.p.svc.previewLeftovers('p', 't-000000', false)).rejects.toBeInstanceOf(TaskForbiddenError);
    expect(await preview(s.p, 't-000000')).toBeNull();
  });
});

describe('refazer: o commit complementar', () => {
  it('commita só as sobras, com a mensagem "Sobras de <título> (<id>)", e preserva sha, for e files do original', async () => {
    const s = await ready('ok');
    const original = s.t.commit!;
    const pv = (await preview(s.p, s.a))!;
    await write(s.p.dir, 'c.ts', 'export const c = 2;\n'); // sujo, de ninguém que o Club conheça: fica de fora
    const out = (await redo(s.p, s.a, pv.digest))!;
    expect(commits(s.p.dir)).toBe(3);
    expect(git(s.p.dir, 'log', '-1', '--format=%s').trim()).toBe(`Sobras de Tela A (${s.a})`);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(dirty(s.p.dir)).toEqual([' M c.ts']); // nada de lixo no índice
    expect(out).toMatchObject({ ok: true, sha: git(s.p.dir, 'rev-parse', '--short', 'HEAD').trim(), files: ['b.ts'], left: [] });

    const t = await s.p.get(s.a);
    expect(t.commit).toMatchObject({ sha: original.sha, for: original.for, at: original.at, files: ['a.ts'], status: 'committed', left: [], alert: false, note: original.note });
    expect(t.commit!.redos).toEqual([{ at: expect.any(String), sha: out.sha, files: ['b.ts'] }]);
    expect(out.commit).toEqual(t.commit);
    expect(t.history.at(-1)).toMatchObject({ by: 'auto', note: `commit complementar ${out.sha}: 1 arquivo das sobras do commit ${original.sha}` });
    // O aviso passou: nada na caixa, nada na tarefa.
    expect((await s.p.listedTask(s.a)).commitLeft).toBeUndefined();
  });

  it('o índice que você deixou é preservado: o staged de outro arquivo segue staged, e não entra no commit', async () => {
    const s = await ready('indice');
    await write(s.p.dir, 'c.ts', 'export const c = 2;\n');
    git(s.p.dir, 'add', 'c.ts');
    const pv = (await preview(s.p, s.a))!;
    await redo(s.p, s.a, pv.digest);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(git(s.p.dir, 'diff', '--cached', '--name-only').trim()).toBe('c.ts');
  });

  it('só leva o que está em `left` da tarefa: arquivo sujo da própria tarefa que não está nas sobras não entra', async () => {
    const s = await ready('so-left');
    await write(s.p.dir, 'a.ts', 'export const a = 99;\n'); // da Tela A, mas já commitado: voltou a ficar sujo depois
    const pv = (await preview(s.p, s.a))!;
    await redo(s.p, s.a, pv.digest);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(dirty(s.p.dir)).toEqual([' M a.ts']);
  });

  it('as sobras que o botão não leva ficam em `left` com o motivo de agora; o resto entra, o status segue partial e o ack se mantém', async () => {
    const s = await scenario('resto', ['b.ts', '.env', 'c.ts'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
      await write(p.dir, '.env', 'SECRET=2\n');
      await write(p.dir, 'c.ts', 'export const c = 2;\n');
      git(p.dir, 'add', 'c.ts'); // staged...
      await write(p.dir, 'c.ts', 'export const c = 3;\n'); // ...com mudança nova por cima (MM)
    });
    await s.free();
    await s.p.svc.ackCommit(`commit:p:${s.a}`);
    const pv = (await preview(s.p, s.a))!;
    expect(pv.files.map((f) => [f.path, f.why, f.redo])).toEqual([
      ['b.ts', 'shared', true],
      ['.env', 'blocked', false],
      ['c.ts', 'staged', false],
    ]);
    const out = (await redo(s.p, s.a, pv.digest))!;
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
    expect(out.left).toEqual([
      { path: '.env', why: 'blocked' },
      { path: 'c.ts', why: 'staged' },
    ]);
    const t = await s.p.get(s.a);
    expect(t.commit).toMatchObject({ status: 'partial', alert: true, ack: true, left: out.left });
    expect(dirty(s.p.dir)).toEqual(['MM c.ts', ' M .env'].sort());
  });

  it('card cancelado: o dono viu o diff e confirmou, e o arquivo vai inteiro', async () => {
    const s = await ready('cancelado', false);
    await s.cancel();
    const pv = (await preview(s.p, s.a))!;
    expect(pv.files[0]!.cancelledBy).toEqual([s.b]);
    await redo(s.p, s.a, pv.digest);
    expect(filesOf(s.p.dir)).toEqual(['b.ts']);
  });

  it('sem commit original (status none): o complementar vira o sha, e o original não existe para preservar', async () => {
    const s = await scenario('none', ['b.ts'], async (p) => {
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
    }, []);
    expect(s.t.commit).toMatchObject({ status: 'none', sha: null, alert: true });
    await s.free();
    const pv = (await preview(s.p, s.a))!;
    const out = (await redo(s.p, s.a, pv.digest))!;
    const t = await s.p.get(s.a);
    expect(t.commit).toMatchObject({ status: 'committed', sha: out.sha, files: [], left: [], alert: false, note: null });
    expect(t.commit!.redos).toHaveLength(1);
  });

  it('o complementar é só mais um commit: a barra de `commit.for` do commit automático não o impede nem é afetada', async () => {
    const s = await ready('for');
    const forBefore = s.t.commit!.for;
    await redo(s.p, s.a, (await preview(s.p, s.a))!.digest);
    expect((await s.p.get(s.a)).commit!.for).toBe(forBefore);
    // Sobras novas na MESMA entrega (um arquivo da tarefa voltou a ficar de fora): outro refazer é possível, e os registros se somam.
    const all = JSON.parse(await fs.readFile(s.p.file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((x) => x.id === s.a)!.commit, { status: 'partial', alert: true, left: [{ path: 'c.ts', why: 'shared' }] });
    await fs.writeFile(s.p.file, JSON.stringify(all));
    await write(s.p.dir, 'c.ts', 'export const c = 2;\n');
    await redo(s.p, s.a, (await preview(s.p, s.a))!.digest);
    expect((await s.p.get(s.a)).commit!.redos!.map((r) => r.files)).toEqual([['b.ts'], ['c.ts']]);
    expect(commits(s.p.dir)).toBe(4);
  });

  it('o registro guarda no máximo COMMIT_REDOS_MAX complementares (os mais novos)', async () => {
    const s = await ready('teto');
    const old = Array.from({ length: COMMIT_REDOS_MAX }, (_, i) => ({ at: '2026-11-21T00:00:00.000Z', sha: `old${i}`, files: ['z.ts'] }));
    const all = JSON.parse(await fs.readFile(s.p.file, 'utf8')) as Array<Record<string, any>>;
    all.find((x) => x.id === s.a)!.commit.redos = old;
    await fs.writeFile(s.p.file, JSON.stringify(all));
    await redo(s.p, s.a, (await preview(s.p, s.a))!.digest);
    const redos = (await s.p.get(s.a)).commit!.redos!;
    expect(redos).toHaveLength(COMMIT_REDOS_MAX);
    expect(redos[0]!.sha).toBe('old1');
    expect(redos.at(-1)!.files).toEqual(['b.ts']);
  });

  it('reinício: um serviço novo vê o registro gravado, sem aviso e sem estado', async () => {
    const s = await ready('reinicio-redo');
    const out = (await redo(s.p, s.a, (await preview(s.p, s.a))!.digest))!;
    const fresh = s.p.restart();
    const t = await s.p.listedTask(s.a, fresh);
    expect(t.commit).toMatchObject({ status: 'committed', alert: false });
    expect(t.commit!.redos![0]!.sha).toBe(out.sha);
    expect(t.commitLeft).toBeUndefined();
  });

  it('dois cliques ao mesmo tempo: um commit só, o outro leva 409', async () => {
    const s = await ready('duplo');
    const { digest } = (await preview(s.p, s.a))!;
    const r = await Promise.allSettled([redo(s.p, s.a, digest), redo(s.p, s.a, digest)]);
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(TaskConflictError);
    expect(commits(s.p.dir)).toBe(3);
    expect((await s.p.get(s.a)).commit!.redos).toHaveLength(1);
  });

  it('na mesma fila do commit automático: um commit automático de outra tarefa e o refazer, juntos, terminam os dois', async () => {
    const s = await ready('fila');
    const { digest } = (await preview(s.p, s.a))!;
    await write(s.p.dir, 'd.ts', 'export const d = 2;\n');
    const other = await s.p.task('Tela D', { changedFiles: ['d.ts'], status: 'review' });
    const [r] = await Promise.all([redo(s.p, s.a, digest), s.p.svc.update('p', other, { status: 'done' }, true)]);
    await s.p.svc.commitsSettled();
    expect(r).toMatchObject({ ok: true });
    expect(commits(s.p.dir)).toBe(4);
    expect(dirty(s.p.dir)).toEqual([]);
  });
});

describe('refazer: o que recusa (409) e nada commita', () => {
  const refused = async (p: Project, id: string, digest: string, match: RegExp) => {
    const before = head(p);
    const err = await redo(p, id, digest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskConflictError);
    expect((err as Error).message).toMatch(match);
    expect(head(p)).toBe(before);
    return err as Error;
  };

  it('algum card aberto ainda toca os arquivos: recusa e diz qual card e qual arquivo (tudo ou nada)', async () => {
    const s = await scenario('rec-aberto', ['b.ts', 'c.ts'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, 'b.ts', 'export const b = 2;\n');
      await write(p.dir, 'c.ts', 'export const c = 2;\n');
    });
    await refused(s.p, s.a, NO_DIGEST, new RegExp(`${s.b}.*b\\.ts`));
    // Soltar só um dos dois cards não basta: b.ts está livre, mas c.ts não, e o refazer é do conjunto.
    const c = await s.p.task('Tela C', { changedFiles: ['c.ts'], status: 'doing' });
    await s.p.edit(s.b, { changedFiles: ['x.ts'] });
    await refused(s.p, s.a, NO_DIGEST, new RegExp(`${c}.*c\\.ts`));
    expect(dirty(s.p.dir)).toEqual([' M b.ts', ' M c.ts']);
  });

  it('o card volta a tocar o arquivo depois do preview: recusa (o servidor confere na hora, não confia na tela)', async () => {
    const s = await ready('rec-volta');
    const { digest } = (await preview(s.p, s.a))!;
    await s.p.edit(s.b, { changedFiles: ['b.ts'] });
    await refused(s.p, s.a, digest, /ainda há card aberto/);
  });

  it('sem mudança no git (você desfez ou commitou à mão): recusa', async () => {
    const s = await ready('rec-limpo');
    const { digest } = (await preview(s.p, s.a))!;
    git(s.p.dir, 'checkout', '--', 'b.ts');
    await refused(s.p, s.a, digest, /já não têm mudança/);
  });

  it('o arquivo mudou depois que a tela mostrou o diff: recusa pelo digest', async () => {
    const s = await ready('rec-digest');
    const { digest } = (await preview(s.p, s.a))!;
    await write(s.p.dir, 'b.ts', 'export const b = 3; // mudou depois do preview\n');
    await refused(s.p, s.a, digest, /mudaram desde que você viu o diff/);
    // Com o preview novo, vai.
    await redo(s.p, s.a, (await preview(s.p, s.a))!.digest);
    expect(git(s.p.dir, 'show', 'HEAD:b.ts')).toContain('mudou depois do preview');
  });

  it('um commit seu entrou no meio (o HEAD mudou): o digest não vale mais', async () => {
    const s = await ready('rec-head');
    const { digest } = (await preview(s.p, s.a))!;
    await write(s.p.dir, 'c.ts', 'export const c = 2;\n');
    git(s.p.dir, 'commit', '-q', '-m', 'meu', '--', 'c.ts');
    await refused(s.p, s.a, digest, /mudaram desde que você viu o diff/);
  });

  it('digest de preview de outro momento ou inventado: recusa', async () => {
    const s = await ready('rec-inventado');
    await refused(s.p, s.a, NO_DIGEST, /mudaram desde que você viu o diff/);
  });

  it('sem nada que o botão leve (só segredo): recusa e manda resolver no git', async () => {
    const s = await scenario('rec-segredo', ['.env'], async (p) => {
      await write(p.dir, 'a.ts', 'export const a = 2;\n');
      await write(p.dir, '.env', 'SECRET=2\n');
    });
    await s.free();
    await refused(s.p, s.a, NO_DIGEST, /nenhum arquivo de fora pode ir pelo botão.*\.env/);
    expect(dirty(s.p.dir)).toEqual([' M .env']);
  });

  it('o card não está pronto, ou o commit é de outra entrega: recusa', async () => {
    const s = await ready('rec-entrega');
    const { digest } = (await preview(s.p, s.a))!;
    const all = JSON.parse(await fs.readFile(s.p.file, 'utf8')) as Array<Record<string, any>>;
    all.find((x) => x.id === s.a)!.commit.for = '2020-01-01T00:00:00.000Z';
    await fs.writeFile(s.p.file, JSON.stringify(all));
    await refused(s.p, s.a, digest, /não é da entrega atual/);
    await s.p.edit(s.a, { status: 'doing' });
    await refused(s.p, s.a, digest, /não é da entrega atual/);
  });

  it('aviso sem sobras (commit que falhou, ou já resolvido): recusa', async () => {
    const s = await ready('rec-sem-sobra');
    git(s.p.dir, 'commit', '-q', '-m', 'à mão', '--', 'b.ts');
    await refused(s.p, s.a, NO_DIGEST, /já não têm mudança/);
    const all = JSON.parse(await fs.readFile(s.p.file, 'utf8')) as Array<Record<string, any>>;
    Object.assign(all.find((x) => x.id === s.a)!.commit, { status: 'failed', sha: null, left: [], note: 'x' });
    await fs.writeFile(s.p.file, JSON.stringify(all));
    await refused(s.p, s.a, NO_DIGEST, /não tem arquivos de fora/);
  });

  it('repositório no meio de um merge: recusa com o motivo do git', async () => {
    const s = await ready('rec-merge');
    const { digest } = (await preview(s.p, s.a))!;
    await fs.writeFile(path.join(s.p.dir, '.git', 'MERGE_HEAD'), `${head(s.p)}\n`);
    await refused(s.p, s.a, digest, /merge/);
    await fs.rm(path.join(s.p.dir, '.git', 'MERGE_HEAD'));
    await redo(s.p, s.a, (await preview(s.p, s.a))!.digest);
    expect(commits(s.p.dir)).toBe(3);
  });

  it('hook que falha: 409 com a linha do git, e a tarefa fica exatamente como estava (nada gravado, nenhuma linha de histórico)', async () => {
    const s = await ready('rec-hook');
    const { digest } = (await preview(s.p, s.a))!;
    const hook = path.join(s.p.dir, '.git', 'hooks', 'pre-commit');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\necho "lint falhou: faltou ponto e vírgula" >&2\nexit 1\n', { mode: 0o755 });
    const before = await s.p.get(s.a);
    await refused(s.p, s.a, digest, /o git recusou o commit.*lint falhou/);
    expect(await s.p.get(s.a)).toEqual(before);
    expect(dirty(s.p.dir)).toEqual([' M b.ts']);
    await fs.rm(hook);
    expect((await redo(s.p, s.a, digest))!.ok).toBe(true); // tirado o hook, o mesmo digest vale (nada mudou)
  });
});

describe('refazer: só a tela, e nada vem do corpo', () => {
  it('sem ser a tela: 403 antes de ler o projeto ou o corpo; projeto/tarefa inexistente com a tela: null', async () => {
    const s = await ready('tela');
    await expect(s.p.svc.redoLeftovers('p', s.a, { digest: NO_DIGEST }, false)).rejects.toBeInstanceOf(TaskForbiddenError);
    await expect(s.p.svc.redoLeftovers('p', s.a, 'lixo', false)).rejects.toBeInstanceOf(TaskForbiddenError); // 403 vem antes do 400
    expect(await redo(s.p, 't-000000', NO_DIGEST)).toBeNull();
    expect(commits(s.p.dir)).toBe(2);
  });

  it('o corpo só aceita o digest: caminho, lista de arquivos ou qualquer outro campo é 400, e nada é commitado', async () => {
    const s = await ready('corpo');
    const { digest } = (await preview(s.p, s.a))!;
    await write(s.p.dir, 'c.ts', 'export const c = 2;\n');
    const bad: unknown[] = [
      { digest, paths: ['c.ts'] },
      { digest, files: ['c.ts'] },
      { digest, path: 'c.ts' },
      { digest, extra: 1 },
      { paths: ['c.ts'] },
      {},
      { digest: 'xyz' },
      { digest: digest.toUpperCase() },
      { digest: 123 },
      { digest: [digest] },
      null,
      'texto',
    ];
    for (const body of bad) await expect(s.p.svc.redoLeftovers('p', s.a, body, true)).rejects.toBeInstanceOf(TaskError);
    expect(commits(s.p.dir)).toBe(2);
    expect(dirty(s.p.dir)).toEqual([' M b.ts', ' M c.ts']);
  });
});
