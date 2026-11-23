import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import setupGlobalTmp from './support/globalTmp';
import { removeTemp, removeTempSync } from './support/tmp';
import { RUN_MAX_AGE_MS, startTestRun, sweepTemp, TEST_RUN_PREFIX } from './support/tmpSweep';

let root: string;
const HOUR = 60 * 60_000;
const DEAD = 2_000_000_001; // pid que o teste declara morto
const ALIVE = 2_000_000_002; // pid que o teste declara vivo
const isAlive = (pid: number) => pid === ALIVE;

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

describe('limpeza do TEMP: só o que é da bateria', () => {
  it('apaga as pastas legadas de teste com mais de 1 hora; worktree, outro myco-* e pasta de outro programa ficam intocados', async () => {
    const legadas = [
      await entry('myco-marks-0kfbYZ', 2 * HOUR),
      await entry('myco-srv-12buQ1', 2 * HOUR),
      await entry('myco-deny1-1BQIrE', 2 * HOUR),
      await entry('myco-deny-err-AbC123', 2 * HOUR),
      await entry('myco-update-0Q9VAc', 5 * HOUR),
      await entry('myco-scope-rdulfg', 5 * HOUR),
      await entry('myco-override-fVgsKH', 5 * HOUR),
      await entry('myco-gitmcp-d2oGgd', 5 * HOUR),
      await entry('myco-gitmcp-launch-d2oGgd', 5 * HOUR),
      await entry('myco-gitmcp-e2e-d2oGgd', 5 * HOUR),
      await entry('mcp-tree-3BAzO7', 5 * HOUR),
      await entry('myco-copy-home-13044-1795268164549', 5 * HOUR),
      await entry('myco-mcpaccess-home-11124-1795267478832', 5 * HOUR),
      await entry('myco-staff-home-10712-1795267303508', 5 * HOUR),
      await entry('myco-gitmcp-home-4321-1795267303508', 5 * HOUR),
    ];
    // Uma worktree de verdade (o .git é um arquivo), parada há dias, num `myco-*` qualquer: o caso que sumiu do TEMP do Denzel.
    const worktree = await entry('myco-rel-wt', 30 * HOUR);
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: C:/projeto/.git/worktrees/myco-rel-wt\n');
    const ficam = [
      worktree,
      await entry('myco-marks-novo12', 5 * 60_000), // legada, mas de uma rodada em andamento (menos de 1 h)
      await entry('myco-backup', 30 * HOUR),
      await entry('myco-marks', 30 * HOUR), // o prefixo sem o formato do mkdtemp
      await entry('myco-marks-abc12345', 30 * HOUR), // 8 caracteres: não é do mkdtemp
      await entry('myco-staff-home-abc-123', 30 * HOUR),
      await entry('myco-gpt-abc123', 30 * HOUR), // os temporários do servidor (o próprio servidor os varre)
      await entry('myco-codex-abc123', 30 * HOUR),
      await entry('myco-index-abc123', 30 * HOUR),
      await entry('meu-mcp-tree-3BAzO7', 30 * HOUR), // a marca é no começo do nome
      await entry('claude', 30 * HOUR),
      await entry('jinx-1234', 30 * HOUR),
      await entry('tsx-didog', 30 * HOUR),
      await entry('node-compile-cache', 30 * HOUR),
      await entry('playwright-artifacts-1', 30 * HOUR),
    ];
    await fs.writeFile(path.join(root, 'myco-marks-arquivo'), 'x'); // arquivo solto: não é pasta
    await fs.writeFile(path.join(root, 'mcp-tree-ArqSol'), 'x');
    const antigo = new Date(Date.now() - 30 * HOUR);
    await fs.utimes(path.join(root, 'mcp-tree-ArqSol'), antigo, antigo);

    expect(await sweepTemp({ root, isAlive })).toEqual({ removed: legadas.length, failed: 0 });
    for (const d of legadas) expect(await exists(d)).toBe(false);
    for (const d of ficam) expect(await exists(d)).toBe(true);
    expect(await exists(path.join(worktree, '.git'))).toBe(true);
    expect(await exists(path.join(root, 'mcp-tree-ArqSol'))).toBe(true);
  });

  it('rodada da bateria: a de processo morto sai na hora; a de processo vivo fica (até um dia); a sem pid segue a idade de 1 hora', async () => {
    const morta = await entry(`${TEST_RUN_PREFIX}${DEAD}-aaaaaa`, 5 * 60_000);
    const viva = await entry(`${TEST_RUN_PREFIX}${ALIVE}-bbbbbb`, 5 * HOUR);
    const vivaPresaHaDias = await entry(`${TEST_RUN_PREFIX}${ALIVE}-cccccc`, RUN_MAX_AGE_MS + HOUR);
    const semPidVelha = await entry(`${TEST_RUN_PREFIX}dddddd`, 2 * HOUR);
    const semPidNova = await entry(`${TEST_RUN_PREFIX}eeeeee`, 5 * 60_000);
    const arquivo = path.join(root, `${TEST_RUN_PREFIX}arquivo.txt`);
    await fs.writeFile(arquivo, 'x');

    expect(await sweepTemp({ root, isAlive })).toEqual({ removed: 3, failed: 0 });
    for (const d of [morta, vivaPresaHaDias, semPidVelha]) expect(await exists(d)).toBe(false);
    for (const d of [viva, semPidNova, arquivo]) expect(await exists(d)).toBe(true);
    await removeTemp(viva, semPidNova);
  });

  it('pasta presa não reprova nem para a varredura: conta como não apagada e segue para as outras', async () => {
    const presa = await entry('myco-update-presa0', 4 * HOUR);
    const livre = await entry('myco-update-livre0', 4 * HOUR);
    const remove = async (dir: string) => {
      if (dir === presa) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      await fs.rm(dir, { recursive: true, force: true });
    };
    expect(await sweepTemp({ root, remove, isAlive })).toEqual({ removed: 1, failed: 1 });
    expect(await exists(presa)).toBe(true);
    expect(await exists(livre)).toBe(false);
    await removeTemp(presa);
  });

  it('o TEMP ilegível devolve zero em vez de lançar', async () => {
    await expect(sweepTemp({ root: path.join(root, 'nao-existe') })).resolves.toEqual({ removed: 0, failed: 0 });
  });

  it('o limite de idade é o pedido: 30 minutos de folga deixam passar uma pasta legada de 45 minutos', async () => {
    const quarenta = await entry('myco-scope-45min0', 45 * 60_000);
    expect(await sweepTemp({ root, minAgeMs: 30 * 60_000, now: Date.now(), isAlive })).toMatchObject({ removed: 1 });
    expect(await exists(quarenta)).toBe(false);
  });

  it('sem isAlive injetado, o processo vivo (este) segura a rodada e um pid que não existe a libera', async () => {
    const minha = await entry(`${TEST_RUN_PREFIX}${process.pid}-fffff0`, 5 * 60_000);
    const alheia = await entry(`${TEST_RUN_PREFIX}2000000003-fffff1`, 5 * 60_000);
    expect(await sweepTemp({ root })).toEqual({ removed: 1, failed: 0 });
    expect(await exists(minha)).toBe(true);
    expect(await exists(alheia)).toBe(false);
    await removeTemp(minha);
  });
});

describe('a rodada da bateria: pasta própria no lugar do TEMP', () => {
  it('aponta TEMP/TMP/TMPDIR para a pasta da rodada; no fim devolve o de antes, apaga a pasta (e o que os testes deixaram nela) e varre só o que é de teste', async () => {
    const env: NodeJS.ProcessEnv = { TEMP: 'C:\\antes\\temp', TMP: 'C:\\antes\\tmp' }; // TMPDIR não existia
    const tmpRoot = await fs.mkdtemp(path.join(root, 'tmp-'));
    const run = startTestRun(env, tmpRoot, { isAlive });
    expect(path.dirname(run.dir)).toBe(tmpRoot);
    expect(path.basename(run.dir).startsWith(`${TEST_RUN_PREFIX}${process.pid}-`)).toBe(true);
    expect([env.TEMP, env.TMP, env.TMPDIR]).toEqual([run.dir, run.dir, run.dir]);

    const lixo = await entry('myco-update-deixado', 0, run.dir); // o que um teste deixou para trás
    const mortaDeOutraBateria = await entry(`${TEST_RUN_PREFIX}${DEAD}-zzzzzz`, 5 * 60_000, tmpRoot);
    const legada = await entry('myco-marks-0kfbYZ', 3 * HOUR, tmpRoot);
    const worktree = await entry('myco-rel-wt', 3 * HOUR, tmpRoot);
    const outro = await entry('myco-backup', 3 * HOUR, tmpRoot);

    expect(await run.finish()).toEqual({ removed: 2, failed: 0, runDirLeft: false, left: [] });
    expect(env).toEqual({ TEMP: 'C:\\antes\\temp', TMP: 'C:\\antes\\tmp' });
    for (const d of [lixo, run.dir, mortaDeOutraBateria, legada]) expect(await exists(d)).toBe(false);
    for (const d of [worktree, outro]) expect(await exists(d)).toBe(true);
  });

  it('pasta da rodada presa: finish não lança e diz o que restou nela', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(root, 'tmp-'));
    const run = startTestRun({}, tmpRoot, {
      remove: async () => {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      },
    });
    await entry('myco-gitmcp-preso00', 0, run.dir);
    expect(await run.finish()).toEqual({ removed: 0, failed: 0, runDirLeft: true, left: ['myco-gitmcp-preso00'] });
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
