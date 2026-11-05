import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientChanged, clientMissing } from '../scripts/lib';
import { QUICK_EXITS_BEFORE_REBUILD, startSteps, supervise, takeFlag, type SupervisorDeps } from '../scripts/supervisor';

// O vigia: código novo só entra pelo botão. Queda sobe a mesma versão; mudança de arquivo não reinicia nada.

type Exit = { code: number | null; restart?: boolean; stop?: boolean; ranMs?: number };

/** Vigia de mentira: cada subida consome uma saída da lista (com o que acontece nela). */
function fake(exits: Exit[], versions: string[][] = [['v1'], ['v2'], ['v3']]) {
  let clock = 0;
  let stop = false;
  let restart = false;
  const calls = { prepare: 0, repair: 0, runs: [] as string[][], logs: [] as string[] };
  const deps: SupervisorDeps = {
    shouldStop: () => stop,
    takeRestartRequest: () => {
      const r = restart;
      restart = false;
      return r;
    },
    prepare: async () => versions[calls.prepare++] ?? ['vN'],
    repair: async () => {
      calls.repair++;
    },
    run: async (args) => {
      calls.runs.push(args);
      const e = exits.shift() ?? { code: 0, stop: true };
      clock += e.ranMs ?? 60_000;
      restart = !!e.restart;
      stop = !!e.stop;
      return e.code;
    },
    log: (l) => calls.logs.push(l),
    sleep: async () => {},
    now: () => clock,
  };
  return { deps, calls };
}

describe('vigia (scripts/supervisor.ts)', () => {
  it('queda: sobe de novo a mesma versão, sem gerar pacote', async () => {
    const { deps, calls } = fake([{ code: 1 }, { code: -1073741818 }, { code: 0, stop: true }]);
    await supervise(deps);
    expect(calls.prepare).toBe(1);
    expect(calls.repair).toBe(2);
    expect(calls.runs).toEqual([['v1'], ['v1'], ['v1']]);
    expect(calls.logs[0]).toMatch(/saiu \(código 1\).*mesma versão/);
  });

  it('botão Reiniciar: subida completa, com o código atual', async () => {
    const { deps, calls } = fake([{ code: 0, restart: true }, { code: 0, stop: true }]);
    await supervise(deps);
    expect(calls.prepare).toBe(2);
    expect(calls.runs).toEqual([['v1'], ['v2']]);
    expect(calls.logs[0]).toMatch(/reinício pedido pelo config/);
  });

  it('Parar: não religa', async () => {
    const { deps, calls } = fake([{ code: 0, stop: true, restart: true }]);
    await supervise(deps);
    expect(calls.runs).toHaveLength(1);
    expect(calls.prepare).toBe(1);
  });

  it(`${QUICK_EXITS_BEFORE_REBUILD} quedas seguidas na subida: desiste da versão no ar e gera a do disco`, async () => {
    const quick = { code: 1, ranMs: 1_000 };
    const { deps, calls } = fake([quick, quick, quick, { code: 0, stop: true }]);
    await supervise(deps);
    expect(calls.runs).toEqual([['v1'], ['v1'], ['v1'], ['v2']]);
    expect(calls.prepare).toBe(2);
  });

  it('queda depois de um tempo no ar zera a contagem (não gera)', async () => {
    const quick = { code: 1, ranMs: 1_000 };
    const { deps, calls } = fake([quick, quick, { code: 1, ranMs: 120_000 }, quick, quick, { code: 0, stop: true }]);
    await supervise(deps);
    expect(calls.prepare).toBe(1);
  });

  it('mudança de arquivo com o servidor no ar não reinicia', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-vigia-'));
    const file = path.join(dir, 'index.ts');
    fs.writeFileSync(file, 'v1');
    let stop = false;
    let exit: (code: number) => void = () => {};
    const runs: string[][] = [];
    let prepares = 0;
    const done = supervise({
      shouldStop: () => stop,
      takeRestartRequest: () => false,
      prepare: async () => (prepares++, ['v1']),
      repair: async () => {},
      run: (args) => {
        runs.push(args);
        return new Promise((resolve) => (exit = resolve));
      },
      log: () => {},
      sleep: async () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(file, `v${i + 2}`);
      fs.utimesSync(file, new Date(), new Date(Date.now() + i * 1000));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(runs).toHaveLength(1);
    expect(prepares).toBe(1);
    stop = true;
    exit(0);
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('subida completa x queda (startSteps)', () => {
  let root: string;
  const built = () => path.join(root, 'dist', 'client', 'index.html');
  const touch = (f: string, at: number) => fs.utimesSync(f, at / 1000, at / 1000);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-steps-'));
    fs.mkdirSync(path.join(root, 'client'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'client', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'client', 'App.tsx'), 'x');
    fs.writeFileSync(path.join(root, 'dist', 'client', 'assets', 'a.js'), '');
    fs.writeFileSync(built(), '<script src="/assets/a.js"></script>');
    const old = Date.now() - 60_000;
    touch(path.join(root, 'client', 'App.tsx'), old);
    touch(built(), old + 1000);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const io = () => {
    const builds = { n: 0 };
    const steps = startSteps({
      clientChanged: () => clientChanged(root),
      clientMissing: () => clientMissing(root),
      buildClient: () => void builds.n++,
      serverArgs: async () => ['dist/server.mjs'],
    });
    return { steps, builds };
  };

  it('cliente em dia: nem o botão gera', async () => {
    const { steps, builds } = io();
    expect(clientChanged(root)).toBe(false);
    expect(await steps.prepare()).toEqual(['dist/server.mjs']);
    expect(builds.n).toBe(0);
  });

  it('cliente mudou: o botão gera; a queda, não', async () => {
    touch(path.join(root, 'client', 'App.tsx'), Date.now());
    const { steps, builds } = io();
    await steps.repair();
    expect(builds.n).toBe(0);
    await steps.prepare();
    expect(builds.n).toBe(1);
  });

  it('build do cliente sumiu (ou pela metade): até a queda gera, senão não há tela', async () => {
    fs.rmSync(path.join(root, 'dist', 'client', 'assets', 'a.js'));
    const { steps, builds } = io();
    expect(clientMissing(root)).toBe(true);
    await steps.repair();
    expect(builds.n).toBe(1);
  });

  it('pedido de reinício: consumido uma vez', () => {
    const flag = path.join(root, 'daemon.restart');
    expect(takeFlag(flag)).toBe(false);
    fs.writeFileSync(flag, '');
    expect(takeFlag(flag)).toBe(true);
    expect(takeFlag(flag)).toBe(false);
  });
});
