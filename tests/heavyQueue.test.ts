import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { acquire, currentHolder, isHeavyCommand, LOCK_FILE, release } from '../scripts/hooks/heavy-lock.mjs';
import { isAlive } from '../server/chat/registry';

// t-aafb19: uma validação pesada (suíte completa, tsc do projeto) por vez na máquina. A lógica (heavy-lock.mjs), o hook do terminal
// (heavy-guard.mjs, rodado de verdade), o runTests do servidor e a ligação no staffSettings.

// MYCO_HOME de teste: nada aqui toca a fila de quem está rodando os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-heavy-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  // Sem hooks.json na conta do Codex de quem roda os testes (com ele a flag de confiança não sai, ver codexHeavyArgs).
  process.env.CODEX_HOME = nodePath.join(dir, 'codex-home');
  delete process.env.MYCO_SESSION_ID;
  return dir;
});

const { buildCodexArgs, codexHeavyArgs, CODEX_HEAVY_LEASE_S } = await import('../server/chat/codexArgs');
const { itemFromCodex } = await import('../server/chat/codexEvents');
const { heavyLockDir, withHeavyLock } = await import('../server/heavyQueue');
const { runTests } = await import('../server/taskCode');
const { staffSettings, HEAVY_GUARD_MATCHER } = await import('../server/staff/launch');

const guard = fileURLToPath(new URL('../scripts/hooks/heavy-guard.mjs', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp: string;
let n = 0;
/** Uma pasta de trava só deste teste. */
const lockDir = () => path.join(tmp, `lock-${n++}`);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-heavy-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

/** Escreve uma trava de outro dono. */
async function hold(dir: string, rec: Record<string, unknown>) {
  await fs.mkdir(dir, { recursive: true });
  const now = Date.now();
  await fs.writeFile(path.join(dir, LOCK_FILE), JSON.stringify({ key: 'outra', owner: 'outra-conversa', pid: process.pid, label: 'npm test', since: now, expiresAt: now + 60_000, ...rec }));
}

describe('o que é validação pesada', () => {
  it.each([
    'npm test',
    'npm t',
    'npm run test',
    'npm run test:unit',
    'npm run typecheck',
    'npm test -- --run',
    'npm test -- --reporter verbose',
    'npm test 2>&1 | Select-Object -Last 30',
    'npm test > saida.txt',
    'CI=1 npm test',
    'cd C:\\proj && npm test',
    'npm test; echo done',
    'timeout 600 npm test',
    '& npm test',
    'npx vitest',
    'npx vitest run',
    'npx -y vitest run',
    'npx vitest run -t "nome do teste"',
    'npx vitest run --reporter dot',
    'npx vitest run --testTimeout=60000 --coverage',
    'vitest run',
    '.\\node_modules\\.bin\\vitest.cmd run',
    './node_modules/.bin/vitest run',
    'node node_modules/vitest/vitest.mjs run',
    'npm exec -- vitest run',
    'pnpm exec vitest run',
    'yarn test',
    'yarn typecheck',
    'bun test',
    'npx tsc --noEmit',
    'tsc -p client/tsconfig.json',
    'tsc --build',
    'node node_modules/typescript/bin/tsc -p tsconfig.json',
    'bash -c "npm test"',
    'cmd /c npm test',
    'powershell -NoProfile -Command "npx vitest run"',
    'composer test',
    'vendor/bin/phpunit',
    'jest',
  ])('pesado: %s', (cmd) => {
    expect(isHeavyCommand(cmd)).toBe(true);
  });

  it.each([
    'npx vitest run tests/foo.test.ts',
    'npx vitest run tests/a.test.ts tests/b.test.ts --testTimeout=60000',
    'npx vitest run --reporter dot tests/x.test.ts',
    'npx vitest run foo',
    'npm test -- tests/foo.test.ts',
    'npm run test -- --reporter verbose tests/a.test.ts',
    'vitest related src/a.ts',
    'vitest list',
    'npx vitest --version',
    'npx vitest run --help',
    'tsc --version',
    'tsc a.ts',
    'jest src/foo.test.js',
    'vendor/bin/phpunit tests/FooTest.php',
    'composer test tests/FooTest.php',
    'npm run build',
    'npm install',
    'npm run dev',
    'node server/index.ts',
    'git commit -m "npm test"',
    'echo npx vitest run',
    'grep -r "vitest run" docs',
    'ls',
    '',
  ])('leve: %s', (cmd) => {
    expect(isHeavyCommand(cmd)).toBe(false);
  });

  it('o que não é texto não é pesado', () => {
    expect(isHeavyCommand(42)).toBe(false);
    expect(isHeavyCommand(null)).toBe(false);
    expect(isHeavyCommand(undefined)).toBe(false);
  });
});

describe('a trava', () => {
  it('livre: pega na hora e solta só com a mesma chave', async () => {
    const dir = lockDir();
    const got = await acquire({ dir, key: 'a', pid: process.pid, label: 'testes', leaseMs: 60_000, maxWaitMs: 1000 });
    expect(got).toMatchObject({ acquired: true, holder: null });
    expect(await currentHolder(dir)).toMatchObject({ key: 'a', label: 'testes', pid: process.pid });
    await release(dir, 'outra-chave');
    expect(await currentHolder(dir)).not.toBeNull();
    await release(dir, 'a');
    expect(await currentHolder(dir)).toBeNull();
  });

  it('ocupada por quem está vivo e dentro do prazo: espera e, passando do limite, devolve quem segura', async () => {
    const dir = lockDir();
    await hold(dir, {});
    const seen: string[] = [];
    const t0 = Date.now();
    const got = await acquire({ dir, key: 'b', pid: process.pid, leaseMs: 60_000, maxWaitMs: 300, pollMs: 50, onWait: (h) => seen.push(h.label) });
    expect(got).toMatchObject({ acquired: false, holder: { key: 'outra', label: 'npm test' } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(seen).toEqual(['npm test']); // o aviso sai uma vez
    expect((await currentHolder(dir))?.key).toBe('outra'); // a trava de quem estava lá não foi mexida
  });

  it('órfã: o processo dono morreu', async () => {
    const dir = lockDir();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    await hold(dir, { pid: Number(dead.stdout.toString()) }); // prazo longe: só o pid decide
    const t0 = Date.now();
    const got = await acquire({ dir, key: 'c', pid: process.pid, leaseMs: 60_000, maxWaitMs: 5000 });
    expect(got.acquired).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await currentHolder(dir))?.key).toBe('c');
  });

  it('órfã: o prazo passou, com o processo ainda vivo', async () => {
    const dir = lockDir();
    await hold(dir, { expiresAt: Date.now() - 1 });
    const got = await acquire({ dir, key: 'd', pid: process.pid, leaseMs: 60_000, maxWaitMs: 5000 });
    expect(got.acquired).toBe(true);
    expect((await currentHolder(dir))?.key).toBe('d');
  });

  it('órfã: arquivo que não é uma trava e já não está sendo escrito', async () => {
    const dir = lockDir();
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, LOCK_FILE);
    await fs.writeFile(file, 'lixo{');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(file, old, old);
    expect((await acquire({ dir, key: 'e', pid: process.pid, leaseMs: 60_000, maxWaitMs: 5000 })).acquired).toBe(true);
  });

  it('arquivo ilegível recém-criado vale como trava (está sendo escrito)', async () => {
    const dir = lockDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, LOCK_FILE), '{"key":');
    const got = await acquire({ dir, key: 'f', pid: process.pid, leaseMs: 60_000, maxWaitMs: 200, pollMs: 50 });
    expect(got.acquired).toBe(false);
  });

  it('espera acaba quando quem segura solta', async () => {
    const dir = lockDir();
    await acquire({ dir, key: 'g1', pid: process.pid, leaseMs: 60_000, maxWaitMs: 1000 });
    const second = acquire({ dir, key: 'g2', pid: process.pid, leaseMs: 60_000, maxWaitMs: 10_000, pollMs: 50 });
    await sleep(200);
    expect((await currentHolder(dir))?.key).toBe('g1');
    await release(dir, 'g1');
    expect((await second).acquired).toBe(true);
    expect((await currentHolder(dir))?.key).toBe('g2');
  });

  it('muitas esperas juntas: uma por vez (cada uma confere que está sozinha)', async () => {
    const dir = lockDir();
    let inside = 0;
    let worst = 0;
    await Promise.all(
      ['h1', 'h2', 'h3', 'h4'].map(async (key) => {
        const got = await acquire({ dir, key, pid: process.pid, leaseMs: 60_000, maxWaitMs: 30_000, pollMs: 30 });
        expect(got.acquired).toBe(true);
        inside++;
        worst = Math.max(worst, inside);
        await sleep(60);
        inside--;
        await release(dir, key);
      }),
    );
    expect(worst).toBe(1);
  }, 40_000);
});

/** Roda o hook de verdade. `done` resolve quando ele sai; `stdout` é tudo o que ele escreveu. */
function runGuard(dir: string, stage: 'pre' | 'post', ev: unknown, env: Record<string, string | undefined> = {}) {
  const child = spawn(process.execPath, [guard, dir, stage], { env: { ...process.env, MYCO_SESSION_ID: undefined, ...env } as NodeJS.ProcessEnv });
  let stdout = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stdin.end(typeof ev === 'string' ? ev : JSON.stringify(ev));
  const t0 = Date.now();
  const done = new Promise<{ stdout: string; ms: number }>((resolve) => child.on('close', () => resolve({ stdout, ms: Date.now() - t0 })));
  return { child, done };
}
const call = (session: string, id: string, command: unknown, extra: Record<string, unknown> = {}) => ({
  session_id: session,
  tool_name: 'PowerShell',
  tool_use_id: id,
  tool_input: { command, ...extra },
});

describe('hook do terminal (heavy-guard.mjs)', () => {
  it('duas suítes completas pedidas juntas rodam em sequência; teste de um arquivo passa direto', async () => {
    const dir = lockDir();
    const first = runGuard(dir, 'pre', call('conv-a', 'toolu_a', 'npx vitest run'));
    expect((await first.done).stdout).toBe(''); // livre: pega e não diz nada
    expect(await currentHolder(dir)).toMatchObject({ key: 'toolu_a', owner: 'conv-a', label: 'npx vitest run' });

    const second = runGuard(dir, 'pre', call('conv-b', 'toolu_b', 'npm test'));
    let secondDone = false;
    void second.done.then(() => (secondDone = true));
    await sleep(1500);
    expect(secondDone, 'a segunda suíte tinha de esperar a primeira').toBe(false);
    expect((await currentHolder(dir))?.key).toBe('toolu_a');

    // Teste de um arquivo (e comando que não é teste) passa direto, com a fila ocupada.
    for (const [id, command] of [['toolu_c', 'npx vitest run tests/foo.test.ts'], ['toolu_d', 'git status']] as const) {
      const light = await runGuard(dir, 'pre', call('conv-c', id, command)).done;
      expect(light.stdout).toBe('');
      expect(light.ms).toBeLessThan(1400);
    }

    // A primeira acaba (hook de saída): a segunda entra e conta que esperou.
    expect((await runGuard(dir, 'post', call('conv-a', 'toolu_a', 'npx vitest run')).done).stdout).toBe('');
    const out = JSON.parse((await second.done).stdout);
    expect(out.systemMessage).toMatch(/^\[MyCo\] Esperei \d+ s a vez: outra validação pesada rodava \(npx vitest run\)/);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', additionalContext: out.systemMessage });
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined(); // nunca libera por conta própria (a permissão é de quem decide)
    expect((await currentHolder(dir))?.key).toBe('toolu_b');
  }, 30_000);

  it('a chamada negada ou interrompida (sem hook de saída) não prende a conversa: a próxima do mesmo dono reaproveita a trava', async () => {
    const dir = lockDir();
    await runGuard(dir, 'pre', call('conv-a', 'toolu_1', 'npm test')).done;
    const again = await runGuard(dir, 'pre', call('conv-a', 'toolu_2', 'npm test')).done;
    expect(again.ms).toBeLessThan(2000);
    expect((await currentHolder(dir))?.key).toBe('toolu_2');
  });

  it('subagent é outro dono: não reaproveita a trava da conversa', async () => {
    const dir = lockDir();
    await runGuard(dir, 'pre', { ...call('conv-a', 'toolu_1', 'npm test') }).done;
    const sub = runGuard(dir, 'pre', { ...call('conv-a', 'toolu_2', 'npm test'), agent_id: 'agente-1' });
    let done = false;
    void sub.done.then(() => (done = true));
    await sleep(1300);
    expect(done).toBe(false);
    sub.child.kill();
  });

  it('o dono vem do MYCO_SESSION_ID do ambiente da conversa, quando existe', async () => {
    const dir = lockDir();
    await runGuard(dir, 'pre', call('id-do-claude', 'toolu_1', 'npm test'), { MYCO_SESSION_ID: 'id-do-club' }).done;
    expect((await currentHolder(dir))?.owner).toBe('id-do-club');
  });

  it('trava órfã (processo morto) não faz esperar', async () => {
    const dir = lockDir();
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    await hold(dir, { pid: Number(dead.stdout.toString()) });
    const out = await runGuard(dir, 'pre', call('conv-a', 'toolu_1', 'npm test')).done;
    expect(out.ms).toBeLessThan(2000);
    expect((await currentHolder(dir))?.key).toBe('toolu_1');
  });

  it('PostToolUse de outra chamada não solta a trava de quem segura', async () => {
    const dir = lockDir();
    await runGuard(dir, 'pre', call('conv-a', 'toolu_1', 'npm test')).done;
    await runGuard(dir, 'post', call('conv-b', 'toolu_outra', 'npm test')).done;
    expect((await currentHolder(dir))?.key).toBe('toolu_1');
  });

  it('em segundo plano: nega (o PostToolUse sairia no começo e soltaria a trava com a suíte rodando)', async () => {
    const dir = lockDir();
    const out = JSON.parse((await runGuard(dir, 'pre', call('conv-a', 'toolu_1', 'npm test', { run_in_background: true })).done).stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/^\[MyCo\] .*primeiro plano/);
    expect(await currentHolder(dir)).toBeNull();
    // Teste de um arquivo em segundo plano não é da fila.
    expect((await runGuard(dir, 'pre', call('conv-a', 'toolu_2', 'npx vitest run tests/a.test.ts', { run_in_background: true })).done).stdout).toBe('');
  });

  it('entrada que não é do terminal, ilegível ou sem comando: não responde e não trava nada', async () => {
    const dir = lockDir();
    for (const ev of ['', 'não é json', { tool_name: 'Read', tool_input: { command: 'npm test' } }, { tool_name: 'Bash', tool_input: {} }, { tool_name: 'Bash', tool_input: { command: 7 } }]) {
      expect((await runGuard(dir, 'pre', ev).done).stdout).toBe('');
    }
    expect(await currentHolder(dir)).toBeNull();
  });

  it('pasta da trava que não dá para criar: o comando segue (sem fila, como antes)', async () => {
    const file = path.join(tmp, 'arquivo-no-lugar-da-pasta');
    await fs.writeFile(file, 'x');
    const out = await runGuard(path.join(file, 'filho'), 'pre', call('conv-a', 'toolu_1', 'npm test')).done;
    expect(out.stdout).toBe('');
  });
});

describe('runTests e a fila (servidor)', () => {
  /** Um projeto cujo `npm test` anota quando começa e quando acaba. */
  async function project(name: string, ms = 600) {
    const dir = path.join(tmp, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, scripts: { test: 'node t.js' } }));
    await fs.writeFile(
      path.join(dir, 't.js'),
      `const fs = require('fs'); const log = ${JSON.stringify(path.join(tmp, `${name}.log`))};
fs.appendFileSync(log, 'start ' + Date.now() + '\\n'); setTimeout(() => { fs.appendFileSync(log, 'end ' + Date.now() + '\\n'); }, ${ms});\n`,
    );
    return { dir, log: path.join(tmp, `${name}.log`) };
  }
  const spans = async (log: string) => {
    const [s, e] = (await fs.readFile(log, 'utf8')).trim().split('\n').map((l) => Number(l.split(' ')[1]));
    return { start: s!, end: e! };
  };

  it('duas suítes completas pedidas juntas rodam em sequência', async () => {
    const a = await project('seq-a');
    const b = await project('seq-b');
    const [ra, rb] = await Promise.all([runTests(a.dir, 'npm test'), runTests(b.dir, 'npm test')]);
    expect([ra.ok, rb.ok]).toEqual([true, true]);
    const [sa, sb] = [await spans(a.log), await spans(b.log)];
    const [first, second] = sa.start < sb.start ? [sa, sb] : [sb, sa];
    expect(second.start, 'a segunda começou antes de a primeira acabar').toBeGreaterThanOrEqual(first.end);
    expect(await currentHolder(heavyLockDir())).toBeNull(); // as duas soltaram
  }, 60_000);

  it('a espera pela vez não conta no limite de tempo dos testes', async () => {
    const a = await project('prazo', 10);
    await acquire({ dir: heavyLockDir(), key: 'outra-suite', pid: process.pid, leaseMs: 60_000, maxWaitMs: 1000 });
    const run = runTests(a.dir, 'npm test', 4000); // esperando 4 s+ pela vez: se o relógio já corresse, o limite estouraria antes de começar
    await sleep(4200);
    await release(heavyLockDir(), 'outra-suite');
    const res = await run;
    expect(res.ok, res.output).toBe(true);
  }, 60_000);

  it('comando que não é a suíte inteira passa direto, sem tocar na fila', async () => {
    const a = await project('leve');
    await acquire({ dir: heavyLockDir(), key: 'ocupada', pid: process.pid, leaseMs: 60_000, maxWaitMs: 1000 });
    try {
      const t0 = Date.now();
      const res = await runTests(a.dir, `"${process.execPath}" -e "console.log('ok')"`);
      expect(res).toMatchObject({ ok: true, output: 'ok' });
      expect(Date.now() - t0).toBeLessThan(4000);
    } finally {
      await release(heavyLockDir(), 'ocupada');
    }
  });

  it('dentro da conversa que tem a trava, roda sem esperar (a suíte dela testa o runTests)', async () => {
    const a = await project('aninhada', 200);
    await hold(heavyLockDir(), { owner: 'conv-x' });
    vi.stubEnv('MYCO_SESSION_ID', 'conv-x');
    try {
      const t0 = Date.now();
      expect((await runTests(a.dir, 'npm test')).ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(40_000); // sem a regra, esperaria os 60 s da trava dela (e, em produção, até o prazo dela)
      expect((await currentHolder(heavyLockDir()))?.owner).toBe('conv-x'); // a trava dela segue lá
    } finally {
      vi.unstubAllEnvs();
      await release(heavyLockDir(), 'outra');
    }
  }, 90_000);

  it('a suíte que o servidor abriu leva a chave da trava que segura no ambiente', async () => {
    const dir = path.join(tmp, 'ambiente');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'ambiente', scripts: { test: 'node env.js' } }));
    await fs.writeFile(path.join(dir, 'env.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'ambiente.env'))}, process.env.MYCO_HEAVY_HELD || '');\n`);
    expect((await runTests(dir, 'npm test')).ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'ambiente.env'), 'utf8')).toMatch(/^server:\d+:[0-9a-f-]{36}$/);
  }, 60_000);

  it('quem nasce dentro da suíte do servidor e chama o runTests (a chave no ambiente é a da trava de agora) não espera por ela', async () => {
    const a = await project('interna', 100);
    await hold(heavyLockDir(), { key: 'server:1:dona', owner: null, pid: process.pid });
    vi.stubEnv('MYCO_HEAVY_HELD', 'server:1:dona');
    try {
      const t0 = Date.now();
      expect((await runTests(a.dir, 'npm test')).ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(40_000); // sem a regra, esperaria os 60 s da trava dela
      expect((await currentHolder(heavyLockDir()))?.key).toBe('server:1:dona');
    } finally {
      vi.unstubAllEnvs();
      await release(heavyLockDir(), 'server:1:dona');
    }
  }, 90_000);

  it('a chave de outra execução no ambiente (a trava já mudou de mãos) não dispensa a fila', async () => {
    await hold(heavyLockDir(), {});
    vi.stubEnv('MYCO_HEAVY_HELD', 'server:1:velha');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t0 = Date.now();
      await withHeavyLock('npm test', async () => 'rodou', { label: 'teste', leaseMs: 60_000, maxWaitMs: 300 });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    } finally {
      vi.unstubAllEnvs();
      warn.mockRestore();
      await release(heavyLockDir(), 'outra');
    }
  });

  it('tempo esgotado: a árvore do processo sai e a trava solta (a fila não fica presa)', async () => {
    const dir = path.join(tmp, 'trava-presa');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'presa', scripts: { test: 'node longo.js' } }));
    await fs.writeFile(path.join(dir, 'longo.js'), `require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'presa.pid'))}, String(process.pid)); setInterval(() => {}, 1000);\n`);
    const res = await runTests(dir, 'npm test', 5000);
    const pid = Number(await fs.readFile(path.join(tmp, 'presa.pid'), 'utf8'));
    try {
      expect(res.ok).toBe(false);
      expect(await currentHolder(heavyLockDir())).toBeNull();
      for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
      expect(isAlive(pid)).toBe(false);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 60_000);

  it('passou do limite de espera: roda sem trava e não solta a de quem estava na frente', async () => {
    await hold(heavyLockDir(), {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await withHeavyLock('npm test', async () => 'rodou', { label: 'teste', leaseMs: 60_000, maxWaitMs: 150 });
      expect(res).toBe('rodou');
      expect(warn.mock.calls.join(' ')).toMatch(/a fila não andou; roda sem trava/);
      expect((await currentHolder(heavyLockDir()))?.key).toBe('outra');
    } finally {
      warn.mockRestore();
      await release(heavyLockDir(), 'outra');
    }
  });

  it('erro de quem roda solta a trava', async () => {
    await expect(withHeavyLock('npm test', async () => Promise.reject(new Error('quebrou')), { label: 'teste', leaseMs: 60_000 })).rejects.toThrow('quebrou');
    expect(await currentHolder(heavyLockDir())).toBeNull();
  });
});

describe('Codex: a fila no terminal (o mesmo hook, ligado por -c hooks.*)', () => {
  const guardOf = { hook: 'C:\\Users\\x\\.myco\\run\\c1\\hooks\\heavy-guard.mjs', lockDir: 'C:\\Users\\x\\.myco\\run\\heavy', ownerPid: 4242 };
  const secrets = { projectPath: '/proj', home: '/home/x', mycoHome: '/home/x/.myco' };
  const configOf = (args: string[], key: string) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);

  // O node que roda o servidor, por caminho absoluto (nunca o do PATH), com barras normais como os outros caminhos.
  const node = process.execPath.replace(/\\/g, '/');

  it('flag de confiança e os hooks Pre e Post só no Bash, com o pid do servidor e o prazo, e os caminhos entre aspas', () => {
    const args = codexHeavyArgs(guardOf, { platform: 'linux' });
    expect(args[0]).toBe('--dangerously-bypass-hook-trust');
    const pre = configOf(args, 'hooks.PreToolUse')!;
    const post = configOf(args, 'hooks.PostToolUse')!;
    expect(pre).toContain('matcher="Bash"');
    expect(pre).toContain(`command="\\"${node}\\" \\"C:/Users/x/.myco/run/c1/hooks/heavy-guard.mjs\\" \\"C:/Users/x/.myco/run/heavy\\" pre 4242 ${CODEX_HEAVY_LEASE_S}"`);
    expect(pre).toContain('timeout=900'); // acima da espera máxima do hook (13 min)
    expect(post).toContain(`\\" post 4242 ${CODEX_HEAVY_LEASE_S}"`);
    expect(post).toContain('timeout=30');
    expect(CODEX_HEAVY_LEASE_S).toBe(12 * 60);
  });

  it('o node vai por caminho absoluto (nunca `node` do PATH); no Windows com `&`, porque o PowerShell não executa uma string entre aspas sozinha', () => {
    const win = configOf(codexHeavyArgs(guardOf, { platform: 'win32' }), 'hooks.PreToolUse')!;
    expect(win).toContain(`command="& \\"${node}\\" \\"C:/Users/x/`);
    const unix = configOf(codexHeavyArgs(guardOf, { platform: 'linux' }), 'hooks.PreToolUse')!;
    expect(unix).toContain(`command="\\"${node}\\" \\"C:/Users/x/`);
    expect(unix).not.toContain('& ');
    for (const cmd of [win, unix]) expect(cmd).not.toMatch(/command="(& )?node /);
  });

  it('sem a fila: nem hook nem a flag de confiança', () => {
    expect(codexHeavyArgs(null)).toEqual([]);
    expect(codexHeavyArgs(undefined)).toEqual([]);
    // Caminho que não cabe entre aspas no shell: sem fila, e a flag não fica sozinha.
    expect(codexHeavyArgs({ ...guardOf, hook: 'C:\\a"b\\heavy-guard.mjs' })).toEqual([]);
    expect(codexHeavyArgs({ ...guardOf, lockDir: 'C:\\a$b' })).toEqual([]);
    // O node também entra entre aspas no shell: o caminho dele com `$` (ou aspas, `%`, crase) não cabe.
    const saved = process.execPath;
    try {
      process.execPath = 'C:\\a$b\\node.exe';
      expect(codexHeavyArgs(guardOf)).toEqual([]);
    } finally {
      process.execPath = saved;
    }
    expect(process.execPath).toBe(saved);
  });

  it('buildCodexArgs: com a opção, entra (na primeira execução e no resume); sem ela, nunca há --dangerously', () => {
    const base = { cwd: '/proj', sandbox: 'workspace' as const, network: 'loopback' as const, secrets };
    for (const threadId of [null, 'thr-1']) {
      const on = buildCodexArgs({ ...base, threadId, heavyGuard: guardOf });
      expect(on).toContain('--dangerously-bypass-hook-trust');
      expect(on.some((a) => a.startsWith('hooks.PreToolUse='))).toBe(true);
      expect(on.some((a) => a.startsWith('hooks.PostToolUse='))).toBe(true);
      expect(on.at(-1)).toBe('-'); // o prompt segue pelo stdin
      const off = buildCodexArgs({ ...base, threadId });
      expect(off.join(' ')).not.toMatch(/dangerously|hooks\./);
    }
  });

  it('o aviso que o Codex dá da flag não vira aviso na conversa; outro erro continua', () => {
    const warn = { type: 'error', message: '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.' };
    expect(itemFromCodex(warn, 'k', '2026-11-17T00:00:00Z', 'completed')).toBeNull();
    expect(itemFromCodex({ type: 'error', message: 'falhou outra coisa' }, 'k', '2026-11-17T00:00:00Z', 'completed')).toMatchObject({ kind: 'notice', tone: 'warn', text: 'falhou outra coisa' });
  });

  it('o heavy-guard, chamado como o Codex chama (pid do servidor e prazo no argumento), segura a trava em nome desse pid', async () => {
    const dir = lockDir();
    const child = spawn(process.execPath, [guard, dir, 'pre', String(process.pid), '720'], { env: { ...process.env, MYCO_SESSION_ID: 'thr-9' } });
    child.stdin.end(JSON.stringify({ session_id: 'thr-9', turn_id: 't1', tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command: 'npx vitest run' } }));
    await new Promise((r) => child.on('close', r));
    const held = await currentHolder(dir);
    expect(held).toMatchObject({ key: 'exec-1', owner: 'thr-9', pid: process.pid });
    expect(held!.expiresAt - held!.since).toBe(720_000); // a chamada do Codex não traz `timeout`: vale o prazo do argumento
    const done = spawn(process.execPath, [guard, dir, 'post', String(process.pid), '720']);
    done.stdin.end(JSON.stringify({ session_id: 'thr-9', tool_name: 'Bash', tool_use_id: 'exec-1', tool_input: { command: 'npx vitest run' } }));
    await new Promise((r) => done.on('close', r));
    expect(await currentHolder(dir)).toBeNull();
  });
});

describe('o lançamento leva o hook e a lib para a pasta da conversa (o agente não os edita)', () => {
  const profile = {
    id: 'ana-1', projectId: 'proj-id', name: 'Ana', role: 'Dev', mission: 'Codar', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: [], knowledge: [], rules: [],
    doneWhen: '', reportsTo: [], model: null, effort: null, canHire: false, playbook: null, worktree: false, servers: [], sshWrite: [], browser: false, portrait: null, sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const ctx = (proj: string) => ({
    company: 'Co', projectName: 'proj', projectPath: proj, managerNames: [], mycoUrl: 'http://127.0.0.2:1', runDir: path.join(proj, 'run'),
    claudeConfigFile: path.join(proj, 'claude.json'), userAgentsDir: path.join(proj, 'user-agents'), servers: [],
  });

  it('Codex: copia heavy-guard e heavy-lock e devolve a trava da máquina com o pid do servidor', async () => {
    const { prepareCodexRun } = await import('../server/staff/launch');
    const proj = path.join(tmp, 'proj-codex');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun({ ...profile, engine: 'codex' } as never, ctx(proj) as never, 'sess-h', proj);
    expect(run.heavyGuard).toEqual({ hook: path.join(proj, 'run', 'sess-h', 'hooks', 'heavy-guard.mjs'), lockDir: heavyLockDir(), ownerPid: process.pid });
    for (const f of ['heavy-guard.mjs', 'heavy-lock.mjs']) {
      expect(await fs.readFile(path.join(proj, 'run', 'sess-h', 'hooks', f), 'utf8')).toBe(await fs.readFile(fileURLToPath(new URL(`../scripts/hooks/${f}`, import.meta.url)), 'utf8'));
    }
  });

  it('Claude: as mesmas cópias, e o settings aponta para elas', async () => {
    const { prepareRun } = await import('../server/staff/launch');
    const proj = path.join(tmp, 'proj-claude');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareRun({ ...profile, engine: 'claude' } as never, ctx(proj) as never, 'sess-c', proj);
    const hooks = path.join(proj, 'run', 'sess-c', 'hooks');
    for (const f of ['heavy-guard.mjs', 'heavy-lock.mjs']) await expect(fs.stat(path.join(hooks, f))).resolves.toBeTruthy();
    const settings = JSON.parse(await fs.readFile(run.settingsFile, 'utf8'));
    const pre = settings.hooks.PreToolUse.find((g: { hooks: Array<{ args: string[] }> }) => g.hooks[0]?.args[0] === path.join(hooks, 'heavy-guard.mjs'));
    expect(pre.hooks[0].args[1]).toBe(heavyLockDir());
  });
});

describe('staffSettings: a fila no terminal do Claude', () => {
  const settings = staffSettings(undefined, undefined, { hooksDir: '/run/c1/hooks', heavyLockDir: '/maquina/heavy' });
  const hookOf = (groups: Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>) => groups.find((g) => (g.hooks[0]?.args as string[] | undefined)?.[0]?.endsWith('heavy-guard.mjs'));

  it('o hook espera a vez antes do comando (prazo acima da espera máxima dele) e solta depois, também no teste vermelho', () => {
    const pre = hookOf(settings.hooks.PreToolUse);
    expect(pre).toMatchObject({ matcher: HEAVY_GUARD_MATCHER, hooks: [{ type: 'command', command: process.execPath, args: [path.join('/run/c1/hooks', 'heavy-guard.mjs'), '/maquina/heavy', 'pre'], timeout: 900 }] });
    expect(pre?.hooks[0]).not.toHaveProperty('onFailure'); // cortesia de memória, não de segurança: falhar não bloqueia o comando
    for (const post of [settings.hooks.PostToolUse, settings.hooks.PostToolUseFailure]) {
      expect(hookOf(post)).toMatchObject({ matcher: 'Bash|PowerShell', hooks: [{ args: [path.join('/run/c1/hooks', 'heavy-guard.mjs'), '/maquina/heavy', 'post'], timeout: 10 }] });
    }
  });

  it('a pasta da trava, sem opção, é a do servidor (uma por máquina)', () => {
    const pre = hookOf(staffSettings().hooks.PreToolUse);
    expect((pre?.hooks[0]?.args as string[])[1]).toBe(heavyLockDir());
    expect(heavyLockDir()).toBe(path.join(home, 'run', 'heavy'));
  });
});
