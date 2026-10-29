import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReviewPrompt, CodexAdapter, type CodexRun, type CodexRunner, withoutSecretFiles } from '../server/adapters/codex';

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-test-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const section = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${line}\n`;
const input = (diff: string) => ({ title: 'Corrigir o total', request: 'Multiplicar pela quantidade', diff, truncated: false });

/** Codex falso: `login status` responde `login`; cada `exec` usa a próxima resposta da lista. */
function fakeCodex(login: Partial<CodexRun>, answers: Array<{ text?: string; run?: Partial<CodexRun> }>) {
  const calls: string[][] = [];
  const runner: CodexRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'login') return { code: 0, stdout: '', stderr: '', ...login };
    const next = answers.shift() ?? {};
    const out = args[args.indexOf('-o') + 1]!;
    if (next.text) await fs.writeFile(out, next.text);
    return { code: next.text ? 0 : 1, stdout: '', stderr: 'erro de rede', ...next.run };
  };
  return { runner, calls };
}

describe('segunda opinião do Codex', () => {
  it('tira os arquivos de segredo do diff e recusa mandar o que tem cara de segredo', () => {
    const diff = section('src/total.js', 'return preco * qtd;') + section('.env', 'TOKEN=abc') + section('deploy/id_rsa', 'chave');
    const clean = withoutSecretFiles(diff);
    expect(clean.skipped).toEqual(['.env', 'deploy/id_rsa']);
    expect(clean.diff).toContain('src/total.js');
    expect(clean.diff).not.toContain('TOKEN=abc');
    const { prompt } = buildReviewPrompt(input(diff));
    expect(prompt).toContain('Pedido: Corrigir o total');
    expect(prompt).toContain('Arquivos de segredo ficaram de fora do diff: .env, deploy/id_rsa.');
    // Senha no meio do código (gerada aqui, não fica no repositório): nada vai para o Codex.
    const leaked = section('src/db.js', `const DB_PASSWORD="${randomBytes(9).toString('base64url')}";`);
    expect(() => buildReviewPrompt(input(leaked))).toThrow(/não mandei ao Codex/);
  });

  it('sem o CLI ou sem login, fica indisponível e diz por quê', async () => {
    const missing = new CodexAdapter(fakeCodex({ code: null, spawnError: Object.assign(new Error('x'), { code: 'ENOENT' }) }, []).runner);
    expect(await missing.check()).toEqual({ available: false, reason: expect.stringMatching(/não está instalado/) });
    // Pelo cmd do Windows, comando inexistente sai com 9009.
    expect((await new CodexAdapter(fakeCodex({ code: 9009 }, []).runner).check()).reason).toMatch(/não está instalado/);
    const logout = new CodexAdapter(fakeCodex({ code: 1 }, []).runner);
    expect((await logout.check()).reason).toMatch(/sem login/);
  });

  it('roda numa pasta vazia, só leitura e sem sessão; tenta de novo uma vez e abre o disjuntor', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const ok = fakeCodex({}, [{}, { text: 'Nada relevante.' }]);
    const codex = new CodexAdapter(ok.runner, { tmpRoot: tmp, sleep });
    expect(await codex.review(input(section('src/a.js', 'x')))).toBe('Nada relevante.');
    const exec = ok.calls.find((c) => c[0] === 'exec')!;
    expect(exec).toEqual(expect.arrayContaining(['-', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-C', '-o']));
    expect(waits).toHaveLength(1);
    // A pasta temporária some depois.
    expect(await fs.readdir(tmp)).toEqual([]);

    // Três revisões falhando seguidas: a quarta nem chama o Codex.
    let now = 1_000;
    const broken = fakeCodex({}, []);
    const flaky = new CodexAdapter(broken.runner, { tmpRoot: tmp, sleep, now: () => now });
    for (let i = 0; i < 3; i++) await expect(flaky.review(input(section('src/a.js', 'x')))).rejects.toThrow(/o Codex falhou/);
    const before = broken.calls.length;
    await expect(flaky.review(input(section('src/a.js', 'x')))).rejects.toThrow(/várias vezes seguidas/);
    expect(broken.calls.length).toBe(before);
    now += 11 * 60_000;
    await expect(flaky.review(input(section('src/a.js', 'x')))).rejects.toThrow(/o Codex falhou/);
  });
});
