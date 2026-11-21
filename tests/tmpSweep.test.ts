import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import setupGlobalTmp from './support/globalTmp';
import { removeTemp, removeTempSync } from './support/tmp';
import { startTestRun, sweepTemp, TEST_RUN_PREFIX } from './support/tmpSweep';

let root: string;
const HOUR = 60 * 60_000;

/** Uma pasta com um arquivo dentro, com a data de modificação `agoMs` atrás. */
async function entry(name: string, agoMs: number, dir = root): Promise<string> {
  const full = path.join(dir, name);
  await fs.mkdir(path.join(full, 'sub'), { recursive: true });
  await fs.writeFile(path.join(full, 'sub', 'a.txt'), 'x');
  const when = new Date(Date.now() - agoMs);
  await fs.utimes(full, when, when);
  return full;
}
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-sweep-'));
});
afterAll(() => removeTemp(root));

describe('limpeza do TEMP: só a marca própria da bateria', () => {
  it('apaga as rodadas de teste com mais de 1 hora; nenhum outro myco-* nem pasta de outro programa é tocado', async () => {
    const velhas = [await entry(`${TEST_RUN_PREFIX}aaaaaa`, 2 * HOUR), await entry(`${TEST_RUN_PREFIX}bbbbbb`, 30 * HOUR)];
    // Uma worktree de verdade (o .git é um arquivo), parada há dias, num `myco-*` qualquer: o caso que sumiu do TEMP do Denzel.
    const worktree = await entry('myco-rel-wt', 9 * HOUR);
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: C:/projeto/.git/worktrees/myco-rel-wt\n');
    const ficam = [
      worktree,
      await entry(`${TEST_RUN_PREFIX}cccccc`, 5 * 60_000), // rodada em andamento (outra bateria)
      await entry('myco-marks-abc123', 9 * HOUR), // o formato do mkdtemp dos testes, mas sem a marca da rodada
      await entry('myco-update-abc123', 9 * HOUR),
      await entry('myco-staff-home-1234-1795000000000', 9 * HOUR),
      await entry('myco-backup', 9 * HOUR),
      await entry('mcp-tree-xyz789', 9 * HOUR),
      await entry('claude', 9 * HOUR),
      await entry('jinx-1234', 9 * HOUR),
      await entry('tsx-didog', 9 * HOUR),
      await entry('node-compile-cache', 9 * HOUR),
      await entry('playwright-artifacts-1', 9 * HOUR),
      await entry(`meu-${TEST_RUN_PREFIX}aaaaaa`, 9 * HOUR), // a marca é no começo do nome
    ];
    await fs.writeFile(path.join(root, `${TEST_RUN_PREFIX}arquivo.txt`), 'x'); // arquivo solto com a marca: não é pasta de rodada
    const antigo = new Date(Date.now() - 9 * HOUR);
    await fs.utimes(path.join(root, `${TEST_RUN_PREFIX}arquivo.txt`), antigo, antigo);

    expect(await sweepTemp({ root })).toEqual({ removed: 2, failed: 0 });
    for (const d of velhas) expect(await exists(d)).toBe(false);
    for (const d of ficam) expect(await exists(d)).toBe(true);
    expect(await exists(path.join(worktree, '.git'))).toBe(true);
    expect(await exists(path.join(root, `${TEST_RUN_PREFIX}arquivo.txt`))).toBe(true);
  });

  it('pasta presa não reprova nem para a varredura: conta como não apagada e segue para as outras', async () => {
    const presa = await entry(`${TEST_RUN_PREFIX}presa00`, 4 * HOUR);
    const livre = await entry(`${TEST_RUN_PREFIX}livre00`, 4 * HOUR);
    const remove = async (dir: string) => {
      if (dir === presa) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      await fs.rm(dir, { recursive: true, force: true });
    };
    expect(await sweepTemp({ root, remove })).toEqual({ removed: 1, failed: 1 });
    expect(await exists(presa)).toBe(true);
    expect(await exists(livre)).toBe(false);
    await removeTemp(presa);
  });

  it('o TEMP ilegível devolve zero em vez de lançar', async () => {
    await expect(sweepTemp({ root: path.join(root, 'nao-existe') })).resolves.toEqual({ removed: 0, failed: 0 });
  });

  it('o limite de idade é o pedido: 30 minutos de folga deixam passar uma rodada de 45 minutos', async () => {
    const quarenta = await entry(`${TEST_RUN_PREFIX}45min00`, 45 * 60_000);
    expect(await sweepTemp({ root, minAgeMs: 30 * 60_000, now: Date.now() })).toMatchObject({ removed: 1 });
    expect(await exists(quarenta)).toBe(false);
  });
});

describe('a rodada da bateria: pasta própria no lugar do TEMP', () => {
  it('aponta TEMP/TMP/TMPDIR para a pasta da rodada; no fim devolve o de antes, apaga a pasta (e o que os testes deixaram nela) e varre só as rodadas antigas', async () => {
    const env: NodeJS.ProcessEnv = { TEMP: 'C:\\antes\\temp', TMP: 'C:\\antes\\tmp' }; // TMPDIR não existia
    const tmpRoot = await fs.mkdtemp(path.join(root, 'tmp-'));
    const run = startTestRun(env, tmpRoot);
    expect(path.dirname(run.dir)).toBe(tmpRoot);
    expect(path.basename(run.dir).startsWith(TEST_RUN_PREFIX)).toBe(true);
    expect([env.TEMP, env.TMP, env.TMPDIR]).toEqual([run.dir, run.dir, run.dir]);

    const lixo = await entry('myco-update-deixado', 0, run.dir); // o que um teste deixou para trás
    const velha = await entry(`${TEST_RUN_PREFIX}zzzzzz`, 3 * HOUR, tmpRoot); // rodada de uma bateria que morreu
    const worktree = await entry('myco-rel-wt', 3 * HOUR, tmpRoot);
    const outro = await entry('myco-marks-abc123', 3 * HOUR, tmpRoot);

    expect(await run.finish()).toEqual({ removed: 1, failed: 0, runDirLeft: false });
    expect(env).toEqual({ TEMP: 'C:\\antes\\temp', TMP: 'C:\\antes\\tmp' });
    expect(await exists(lixo)).toBe(false);
    expect(await exists(run.dir)).toBe(false);
    expect(await exists(velha)).toBe(false);
    expect(await exists(worktree)).toBe(true);
    expect(await exists(outro)).toBe(true);
  });

  it('pasta da rodada presa: finish não lança e diz que ela ficou', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(root, 'tmp-'));
    const run = startTestRun({}, tmpRoot, {
      remove: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    });
    expect(await run.finish()).toEqual({ removed: 0, failed: 0, runDirLeft: true });
    expect(await exists(run.dir)).toBe(true);
  });

  it('o os.tmpdir() do processo segue o TEMP da rodada (é por isso que os testes caem na pasta dela)', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(root, 'tmp-'));
    const antes = os.tmpdir();
    const run = startTestRun(process.env, tmpRoot);
    try {
      expect(os.tmpdir()).toBe(run.dir);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-qualquer-'));
      expect(path.dirname(dir)).toBe(run.dir);
    } finally {
      await run.finish();
    }
    expect(os.tmpdir()).toBe(antes);
    expect(await exists(run.dir)).toBe(false);
  });

  it('o globalSetup abre a rodada e o teardown a fecha, sem lançar', async () => {
    const antes = os.tmpdir();
    const teardown = setupGlobalTmp();
    const dentro = os.tmpdir();
    try {
      expect(path.basename(dentro).startsWith(TEST_RUN_PREFIX)).toBe(true);
      expect(path.dirname(dentro)).toBe(antes);
    } finally {
      await teardown();
    }
    expect(os.tmpdir()).toBe(antes);
    expect(await exists(dentro)).toBe(false);
  });
});

describe('removeTemp e removeTempSync', () => {
  it('apagam a árvore e não lançam com pasta que não existe nem com argumento vazio', async () => {
    const a = await entry('myco-rm-a', 0);
    const b = await entry('myco-rm-b', 0);
    await removeTemp(a, undefined, path.join(root, 'nao-existe'));
    removeTempSync(b, undefined, path.join(root, 'nao-existe'));
    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(false);
  });
});
