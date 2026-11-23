import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAlive } from '../server/chat/registry';
import { formatLimit, runTests, TEST_TIMEOUT_MS, timeoutNote } from '../server/taskCode';
import { removeTemp } from './support/tmp';

// t-686f25: `runTests` com `shell: true` no Windows. O `child.kill()` mata só o `cmd`; o vitest (neto) segue, segura os pipes e o `close` só
// vem quando ele acaba (t-d48343 levou 657 s com limite de 600 s). No tempo esgotado a árvore toda tem de sair.
// t-4193d0: o limite subiu (a suíte passava dos 10 min) e a rodada cortada no tempo sai marcada (`timedOut`), diferente de falha.

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-runtests-'));
  // Imprime o próprio pid e fica vivo: faz o papel do vitest que não sai.
  await fs.writeFile(path.join(dir, 'longo.js'), 'console.log(process.pid); setInterval(() => {}, 1000);\n');
  await fs.writeFile(path.join(dir, 'falha.js'), "console.log('algo quebrou'); process.exitCode = 1;\n");
});
afterAll(() => removeTemp(dir));

const gone = async (pid: number) => {
  for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
};

describe('runTests: tempo esgotado', () => {
  it('o limite tem folga sobre os 10 min de antes (a suíte completa passava deles) e a mescla usa o mesmo', () => {
    expect(TEST_TIMEOUT_MS).toBe(30 * 60_000);
    expect(TEST_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
    expect([formatLimit(TEST_TIMEOUT_MS), formatLimit(90_000), formatLimit(3000), formatLimit(100)]).toEqual(['30 min', '2 min', '3 s', '1 s']);
  });

  it('encerra a árvore (o processo que o shell abriu também) e devolve no tempo, marcada como tempo esgotado (não como falha)', async () => {
    const started = Date.now();
    const run = await runTests(dir, `"${process.execPath}" longo.js`, 3000);
    const pid = Number(run.output.split(/\s/)[0]);
    expect(Number.isInteger(pid) && pid > 0, `o filho não imprimiu o pid: ${JSON.stringify(run.output)}`).toBe(true);
    try {
      expect(run.ok).toBe(false);
      expect(run).toMatchObject({ timedOut: true, limitMs: 3000 });
      expect(run.output.endsWith(timeoutNote(3000))).toBe(true); // quem só lê a saída (a tela, o revisor) vê que não foi falha
      expect(Date.now() - started).toBeLessThan(20_000); // sem a árvore morta, o `close` esperaria o filho (que não acaba sozinho)
      expect(await gone(pid)).toBe(true);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 60_000);

  it('falha de verdade (sai com código 1 antes do limite) é falha: sem a marca de tempo esgotado', async () => {
    const run = await runTests(dir, `"${process.execPath}" falha.js`, 60_000);
    expect(run).toMatchObject({ ok: false, output: 'algo quebrou' });
    expect(run.timedOut).toBeUndefined();
    expect(run.limitMs).toBeUndefined();
  }, 60_000);

  it('teste que termina antes do limite não é cortado', async () => {
    const run = await runTests(dir, `"${process.execPath}" -e "console.log('ok')"`, 60_000);
    expect(run).toMatchObject({ ok: true, output: 'ok' });
    expect(run.timedOut).toBeUndefined();
  }, 60_000);
});
