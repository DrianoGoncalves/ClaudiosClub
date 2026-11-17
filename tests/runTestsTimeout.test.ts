import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAlive } from '../server/chat/registry';
import { runTests, TEST_TIMEOUT_MS } from '../server/taskCode';

// t-686f25: `runTests` com `shell: true` no Windows. O `child.kill()` mata só o `cmd`; o vitest (neto) segue, segura os pipes e o `close` só
// vem quando ele acaba (t-d48343 levou 657 s com limite de 600 s). No tempo esgotado a árvore toda tem de sair.

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-runtests-'));
  // Imprime o próprio pid e fica vivo: faz o papel do vitest que não sai.
  await fs.writeFile(path.join(dir, 'longo.js'), 'console.log(process.pid); setInterval(() => {}, 1000);\n');
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const gone = async (pid: number) => {
  for (let i = 0; i < 50 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
};

describe('runTests: tempo esgotado', () => {
  it('o limite continua em 10 min', () => {
    expect(TEST_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('encerra a árvore (o processo que o shell abriu também) e devolve no tempo, como falha', async () => {
    const started = Date.now();
    const run = await runTests(dir, `"${process.execPath}" longo.js`, 3000);
    const pid = Number(run.output.split(/\s/)[0]);
    expect(Number.isInteger(pid) && pid > 0, `o filho não imprimiu o pid: ${JSON.stringify(run.output)}`).toBe(true);
    try {
      expect(run.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(20_000); // sem a árvore morta, o `close` esperaria o filho (que não acaba sozinho)
      expect(await gone(pid)).toBe(true);
    } finally {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    }
  }, 60_000);

  it('teste que termina antes do limite não é cortado', async () => {
    const run = await runTests(dir, `"${process.execPath}" -e "console.log('ok')"`, 60_000);
    expect(run).toMatchObject({ ok: true, output: 'ok' });
  }, 60_000);
});
