import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFullSuiteCommand, isHeavyCommand } from '../scripts/hooks/heavy-lock.mjs';
import type { StaffProfile, TestRun } from '../shared/model';
import { TaskService } from '../server/tasks';
import { runTests } from '../server/taskCode';
import { ISOLATED_MAX, TestScan, failureBlock, isolateFailures, testFileOf, type Rerun } from '../server/testFailures';
import { removeTemp } from './support/tmp';

// Falhas da suíte no pedido de revisão (t-a7dc60): a lista dos arquivos que falham (lida da saída inteira, não do fim), a nova rodada isolada, e o destaque do
// que falha isolado e toca a entrega. A saída do vitest abaixo é a real (vitest 5.1, CI=1, sem TTY).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-failures-'));
});
afterAll(() => removeTemp(root));

const VITEST_OUT = [
  ' RUN  v5.1.0 C:/proj',
  '',
  ' ❯ tests/b.test.ts (0 test)',
  ' ❯ tests/d.test.ts (1 test | 1 failed) 13ms',
  '   ❯ g (1)',
  '     × falha > com seta 11ms',
  ' ❯ tests/a.test.ts (3 tests | 2 failed) 15ms',
  '   × um 11ms',
  '   × dois 1ms',
  '',
  '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/b.test.ts [ tests/b.test.ts ]',
  "Error: Cannot find module './nao-existe' imported from C:/proj/tests/b.test.ts",
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/a.test.ts > um',
  'AssertionError: expected 1 to be 2 // Object.is equality',
  ' FAIL  tests/a.test.ts > dois',
  'AssertionError: expected 1 to be 3 // Object.is equality',
  ' FAIL  tests/d.test.ts > g > falha > com seta',
  'AssertionError: expected 1 to be 2 // Object.is equality',
  '',
  ' Test Files  3 failed | 1 passed (4)',
  '      Tests  3 failed | 2 passed (5)',
].join('\n');

const run = (over: Partial<TestRun> = {}): TestRun => ({ command: 'npm test', ok: false, output: '', ms: 1000, at: '2026-11-19T12:00:00Z', ...over });

describe('TestScan: a lista vem da saída inteira', () => {
  it('conta as falhas por arquivo (teste a teste; arquivo que nem carregou conta 1) e o total de arquivos', () => {
    const scan = new TestScan();
    scan.feed(VITEST_OUT);
    scan.end();
    expect(scan.result()).toEqual({
      files: 4,
      failedFiles: [
        { file: 'tests/a.test.ts', failed: 2 },
        { file: 'tests/b.test.ts', failed: 1 },
        { file: 'tests/d.test.ts', failed: 1 },
      ],
    });
  });

  it('pedaços que cortam a linha no meio, cores ANSI e o fim sem quebra de linha dão o mesmo resultado', () => {
    const colored = VITEST_OUT.replace(/ FAIL /g, ' \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m ').replace('Test Files', '\u001b[2m Test Files\u001b[22m');
    const scan = new TestScan();
    for (let i = 0; i < colored.length; i += 7) scan.feed(colored.slice(i, i + 7)); // pedaços de 7 caracteres: cortam todas as linhas
    scan.end();
    expect(scan.result().failedFiles).toHaveLength(3);
    expect(scan.result().files).toBe(4);
  });

  it('sem falha na saída (outro executor, suíte limpa): nada de lista; "FAIL" dentro de texto qualquer não conta', () => {
    const scan = new TestScan();
    scan.feed('Tests passed\nlog: FAIL tests/x.test.ts > a\nFAILED tests/y.test.ts > b\n');
    scan.end();
    expect(scan.result()).toEqual({});
  });

  it('nome de arquivo que não é caminho de teste seguro fica fora (iria para a linha de comando)', () => {
    expect(testFileOf('tests/a.test.ts')).toBe('tests/a.test.ts');
    expect(testFileOf('tests\\win\\a.test.ts')).toBe('tests/win/a.test.ts');
    for (const bad of ['../fora/a.test.ts', 'tests/../../a.test.ts', '-rf.test.ts', 'tests/a.test.ts;rm', 'tests/a$(x).test.ts', 'C:/x/a.test.ts', '/etc/passwd.ts', 'tests/a.test.ts"', 'readme.md']) {
      expect(testFileOf(bad), bad).toBeNull();
    }
    const scan = new TestScan();
    scan.feed(' FAIL  ../../etc/x.test.ts > a\n FAIL  -rf.test.ts > b\n FAIL  tests/ok.test.ts > c\n');
    scan.end();
    expect(scan.result().failedFiles).toEqual([{ file: 'tests/ok.test.ts', failed: 1 }]);
  });
});

describe('runTests com processo de verdade: 28 falhas, e o fim da saída não tem a lista', () => {
  it('a lista de arquivos vem completa mesmo quando o começo da saída sai dos 6 mil caracteres guardados', async () => {
    const dir = path.join(root, 'saida-grande');
    await fs.mkdir(dir, { recursive: true });
    // 14 arquivos × 2 falhas, cada uma com uma pilha longa depois: o fim (6 mil caracteres) só alcança o último arquivo.
    const lines: string[] = [];
    for (let f = 1; f <= 14; f++) {
      for (let t = 1; t <= 2; t++) lines.push(` FAIL  tests/f${f}.test.ts > teste ${t}`, 'AssertionError: x', ...Array.from({ length: 12 }, (_, i) => ` ❯ server/arquivo.ts:${i}:1 ${'.'.repeat(60)}`), '');
    }
    lines.push(' Test Files  14 failed | 30 passed (44)', '      Tests  28 failed | 90 passed (118)');
    // `exitCode`, não `exit`: o `exit` logo depois de uma escrita grande num pipe pode cortar a saída.
    await fs.writeFile(path.join(dir, 'saida.js'), `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}); process.exitCode = 1;`);
    const out = await runTests(dir, 'node saida.js');
    expect(out.ok).toBe(false);
    expect(out.output).not.toContain('tests/f1.test.ts'); // o começo ficou fora do fim guardado
    expect(out.files).toBe(44);
    expect(out.failedFiles).toHaveLength(14);
    expect(out.failedFiles!.reduce((n, f) => n + f.failed, 0)).toBe(28);
  });

  it('suíte que passa não guarda lista; a que falha sem formato do vitest também não', async () => {
    const dir = path.join(root, 'sem-lista');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ok.js'), "console.log(' FAIL  tests/a.test.ts > x'); process.exit(0);");
    await fs.writeFile(path.join(dir, 'ruim.js'), "console.log('algo quebrou'); process.exit(1);");
    expect((await runTests(dir, 'node ok.js')).failedFiles).toBeUndefined();
    expect((await runTests(dir, 'node ruim.js')).failedFiles).toBeUndefined();
  });
});

/** Projeto com tests/a (importa server/x → server/y), tests/b (importa server/z), tests/c e tests/d sem importação do projeto. */
async function project(name: string, testScript: string | null = 'vitest run') {
  const dir = path.join(root, name);
  const write = async (f: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), text);
  };
  await write('package.json', JSON.stringify({ scripts: testScript ? { test: testScript } : {} }));
  await write('tests/a.test.ts', "import { x } from '../server/x';\nimport { it } from 'vitest';\nit('a', () => x);\n");
  await write('tests/b.test.ts', "import { z } from '../server/z.js';\nit('b', () => z);\n");
  await write('tests/c.test.ts', "import { it } from 'vitest';\nit('c', () => {});\n");
  await write('tests/d.test.ts', "const m = await import('../server/lib/index');\n");
  await write('server/x.ts', "export { y as x } from './y';\n");
  await write('server/y.ts', 'export const y = 1;\n');
  await write('server/z.ts', 'export const z = 1;\n');
  await write('server/lib/index.ts', 'export const lib = 1;\n');
  return dir;
}

/** Um `rerun` falso: devolve o que o vitest devolveria para os arquivos pedidos (`failing` falham). */
function fakeRerun(failing: Record<string, number>) {
  const calls: Array<{ cwd: string; command: string; timeoutMs: number; queueAs: string }> = [];
  const rerun: Rerun = async (cwd, command, timeoutMs, queueAs) => {
    calls.push({ cwd, command, timeoutMs, queueAs });
    const asked = command.replace('npm test -- ', '').split(' ');
    const failedFiles = asked.filter((f) => failing[f]).map((f) => ({ file: f, failed: failing[f]! }));
    return { command, ok: failedFiles.length === 0, output: '', ms: 3400, at: '2026-11-19T12:01:00Z', files: asked.length, ...(failedFiles.length && { failedFiles }) };
  };
  return { rerun, calls };
}

describe('isolateFailures: passa isolado, falha isolado, toca a entrega', () => {
  const failedRun = (files: Array<[string, number]>) => run({ failedFiles: files.map(([file, failed]) => ({ file, failed })), files: 20 });

  it('roda UMA vez só os arquivos que falharam; classifica cada um e destaca o que falha isolado e importa a entrega (indireto também)', async () => {
    const dir = await project('classifica');
    const { rerun, calls } = fakeRerun({ 'tests/a.test.ts': 2, 'tests/b.test.ts': 1 });
    const iso = await isolateFailures(dir, failedRun([['tests/a.test.ts', 3], ['tests/b.test.ts', 1], ['tests/c.test.ts', 5]]), ['server/y.ts'], rerun);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: dir, command: 'npm test -- tests/a.test.ts tests/b.test.ts tests/c.test.ts', queueAs: 'npm test' });
    expect(iso!.command).toBe(calls[0]!.command);
    expect(iso!.files).toEqual([
      { file: 'tests/a.test.ts', failed: 3, status: 'fail', isolatedFailed: 2, touches: 'server/y.ts' }, // a → x → y: indireto
      { file: 'tests/b.test.ts', failed: 1, status: 'fail', isolatedFailed: 1 }, // falha isolado, mas importa server/z (fora da entrega)
      { file: 'tests/c.test.ts', failed: 5, status: 'pass' },
    ]);
  });

  it('o próprio teste da entrega e o `.js` do import à moda ESM (aponta para o `.ts`) e `index` contam', async () => {
    const dir = await project('toca');
    const { rerun } = fakeRerun({ 'tests/a.test.ts': 1, 'tests/b.test.ts': 1, 'tests/d.test.ts': 1 });
    const iso = await isolateFailures(dir, failedRun([['tests/a.test.ts', 1], ['tests/b.test.ts', 1], ['tests/d.test.ts', 1]]), ['tests/a.test.ts', 'server/z.ts', 'server/lib/index.ts'], rerun);
    const touches = Object.fromEntries(iso!.files.map((f) => [f.file, f.touches]));
    expect(touches).toEqual({ 'tests/a.test.ts': 'tests/a.test.ts', 'tests/b.test.ts': 'server/z.ts', 'tests/d.test.ts': 'server/lib/index.ts' });
  });

  it('sem lista de arquivos da tarefa: falha isolado, mas sem como dizer se toca', async () => {
    const dir = await project('sem-lista-entrega');
    const { rerun } = fakeRerun({ 'tests/a.test.ts': 1 });
    const iso = await isolateFailures(dir, failedRun([['tests/a.test.ts', 1]]), [], rerun);
    expect(iso!.files[0]).toEqual({ file: 'tests/a.test.ts', failed: 1, status: 'fail', isolatedFailed: 1 });
  });

  it('o comando da nova rodada nunca é a suíte inteira, e espera a vez na fila como a suíte', async () => {
    const dir = await project('fila');
    const { rerun, calls } = fakeRerun({});
    await isolateFailures(dir, failedRun([['tests/a.test.ts', 1]]), [], rerun);
    expect(isFullSuiteCommand(calls[0]!.command)).toBe(false); // só os arquivos que falharam
    expect(isHeavyCommand(calls[0]!.command)).toBe(true); // mas toda rodada de testes espera a vez
    expect(calls[0]!.queueAs).toBe('npm test');
    expect(isHeavyCommand(calls[0]!.queueAs)).toBe(true);
  });

  it('muito arquivo: leva só os ISOLATED_MAX primeiros (mais falhas primeiro); o resto fica sem resultado isolado', async () => {
    const dir = await project('limite');
    const many: Array<[string, number]> = [];
    for (let i = 1; i <= 15; i++) {
      many.push([`tests/m${i}.test.ts`, 20 - i]);
      await fs.writeFile(path.join(dir, `tests/m${i}.test.ts`), 'export {};\n');
    }
    const { rerun, calls } = fakeRerun({});
    const iso = await isolateFailures(dir, failedRun(many), [], rerun);
    expect(calls[0]!.command.replace('npm test -- ', '').split(' ')).toHaveLength(ISOLATED_MAX);
    expect(iso!.files).toHaveLength(15);
    expect(iso!.files.filter((f) => f.status === 'pass')).toHaveLength(ISOLATED_MAX);
    expect(iso!.files.filter((f) => f.status === 'unknown').map((f) => f.file)).toEqual(['tests/m13.test.ts', 'tests/m14.test.ts', 'tests/m15.test.ts']);
  });

  it('o `test` do projeto não é `vitest run` simples: não roda (um `&&` ou flag mudaria o que `npm test -- arquivo` faz)', async () => {
    for (const [i, script] of ['vitest run --coverage', 'vitest run && tsc', 'jest', null].entries()) {
      const dir = await project(`outro-${i}`, script);
      const { rerun, calls } = fakeRerun({});
      const iso = await isolateFailures(dir, failedRun([['tests/a.test.ts', 1]]), [], rerun);
      expect(calls, String(script)).toHaveLength(0);
      expect(iso).toMatchObject({ skipped: expect.stringContaining('não dá para rodar só os arquivos'), files: [{ file: 'tests/a.test.ts', status: 'unknown' }] });
    }
    // E um comando que não é `npm test` (composer, phpunit) também não.
    const { rerun, calls } = fakeRerun({});
    expect(await isolateFailures(await project('composer'), run({ command: 'composer test', failedFiles: [{ file: 'tests/a.test.ts', failed: 1 }] }), [], rerun)).toMatchObject({ skipped: expect.any(String) });
    expect(calls).toHaveLength(0);
  });

  it('nada a fazer: suíte que passou, ou sem lista de falhas (outro executor): undefined, sem rodar nada', async () => {
    const dir = await project('nada');
    const { rerun, calls } = fakeRerun({});
    expect(await isolateFailures(dir, run({ ok: true }), [], rerun)).toBeUndefined();
    expect(await isolateFailures(dir, run({ output: 'quebrou' }), [], rerun)).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('arquivo que não existe mais não vai para a linha de comando; sem nenhum que exista, não roda', async () => {
    const dir = await project('sumiu');
    const { rerun, calls } = fakeRerun({});
    expect(await isolateFailures(dir, failedRun([['tests/some.test.ts', 1]]), [], rerun)).toMatchObject({ skipped: expect.stringContaining('não existem mais') });
    expect(calls).toHaveLength(0);
    await isolateFailures(dir, failedRun([['tests/some.test.ts', 1], ['tests/c.test.ts', 1]]), [], rerun);
    expect(calls[0]!.command).toBe('npm test -- tests/c.test.ts');
  });

  it('a nova rodada que cai (erro, ou terminou sem ler os arquivos pedidos): sem resultado isolado, nunca "passa"', async () => {
    const dir = await project('cai');
    const boom = await isolateFailures(dir, failedRun([['tests/c.test.ts', 1]]), [], async () => {
      throw new Error('timeout');
    });
    expect(boom).toMatchObject({ skipped: expect.stringContaining('timeout'), files: [{ status: 'unknown' }] });
    // Saiu com erro sem lista (processo morto): não prova que passou.
    const dead = await isolateFailures(dir, failedRun([['tests/c.test.ts', 1]]), [], async (_c, command) => run({ command, ok: false, output: 'killed', files: 1 }));
    expect(dead!.files[0]!.status).toBe('unknown');
    // Leu mais ou menos arquivos do que o pedido (filtro que casou outra coisa): também não prova.
    const odd = await isolateFailures(dir, failedRun([['tests/c.test.ts', 1]]), [], async (_c, command) => run({ command, ok: true, output: '', files: 3 }));
    expect(odd!.files[0]!.status).toBe('unknown');
  });
});

describe('failureBlock: o texto do pedido de revisão', () => {
  const iso = (files: NonNullable<TestRun['isolated']>['files'], extra: Partial<NonNullable<TestRun['isolated']>> = {}): TestRun['isolated'] => ({ command: 'npm test -- a b', ms: 41_000, files, ...extra });
  const base = run({
    files: 187,
    failedFiles: [
      { file: 'tests/codexEngine.test.ts', failed: 5 },
      { file: 'tests/tasks.test.ts', failed: 3 },
      { file: 'tests/selfUpdate.test.ts', failed: 1 },
      { file: 'tests/x.test.ts', failed: 1 },
    ],
  });
  const withIso = run({
    ...base,
    isolated: iso([
      { file: 'tests/codexEngine.test.ts', failed: 5, status: 'fail', isolatedFailed: 5 },
      { file: 'tests/tasks.test.ts', failed: 3, status: 'fail', isolatedFailed: 3, touches: 'server/tasks.ts' },
      { file: 'tests/selfUpdate.test.ts', failed: 1, status: 'pass' },
      { file: 'tests/x.test.ts', failed: 1, status: 'unknown' },
    ]),
  });

  it('lista os arquivos com o número de falhas, o resultado isolado de cada um e o destaque do que toca a entrega (primeiro)', () => {
    const text = failureBlock(withIso, true);
    expect(text).toContain('Arquivos com falha: 4 de 187 (10 falhas no total).');
    expect(text).toContain('Nova rodada, uma vez, só dos arquivos que falharam (`npm test -- a b`, 41 s):');
    const rows = text.split('\n').filter((l) => l.startsWith('- '));
    expect(rows[0]).toBe('- `tests/tasks.test.ts`: 3 falhas na suíte; falha também isolado (3); ⚠ importa `server/tasks.ts` (direta ou indiretamente), que é desta entrega: confira primeiro');
    expect(rows[1]).toBe('- `tests/codexEngine.test.ts`: 5 falhas na suíte; falha também isolado (5); não importa arquivo desta entrega (provavelmente anterior a ela)');
    expect(rows[2]).toContain('`tests/x.test.ts`: 1 falha na suíte; sem resultado isolado');
    expect(rows[3]).toContain('`tests/selfUpdate.test.ts`: 1 falha na suíte; passa isolado (instável na suíte inteira');
    expect(text).toContain('Resumo: falham também isolados: 2 (tocam a entrega: 1); passam isolados: 1; sem resultado isolado: 1. Só o que falha isolado e toca a entrega aponta regressão dela.');
  });

  it('o arquivo de teste que é da própria entrega é dito assim; sem lista de arquivos da tarefa, o texto não afirma que "não toca"', () => {
    const own = run({ ...base, isolated: iso([{ file: 'tests/tasks.test.ts', failed: 3, status: 'fail', isolatedFailed: 3, touches: 'tests/tasks.test.ts' }]) });
    expect(failureBlock(own, true)).toContain('⚠ é um arquivo desta entrega: confira primeiro');
    const text = failureBlock(withIso, false);
    expect(text).toContain('a tarefa não tem lista de arquivos: não dá para dizer se toca a entrega');
    expect(text).not.toContain('não importa arquivo desta entrega');
  });

  it('sem a nova rodada: diz o motivo (ou que não houve) e mantém a lista', () => {
    const skipped = failureBlock(run({ ...base, isolated: { skipped: 'o comando de testes do projeto não é `npm test` com `vitest run`', files: [] } }), true);
    expect(skipped).toContain('Nova rodada só desses arquivos não feita: o comando de testes do projeto não é `npm test` com `vitest run`.');
    expect(skipped).toContain('- `tests/codexEngine.test.ts`: 5 falhas na suíte');
    expect(skipped).not.toContain('Resumo:');
    expect(failureBlock(base, true)).toContain('- `tests/tasks.test.ts`: 3 falhas na suíte');
    expect(failureBlock(run({ output: 'x' }), true)).toBe(''); // sem lista: o chamador cai no fim da saída
  });

  it('lista longa: os 25 primeiros e a contagem do resto', () => {
    const failedFiles = Array.from({ length: 30 }, (_, i) => ({ file: `tests/t${i}.test.ts`, failed: 1 }));
    const text = failureBlock(run({ failedFiles }), true);
    expect(text.split('\n').filter((l) => l.startsWith('- `'))).toHaveLength(25);
    expect(text).toContain('- … e mais 5 arquivos');
  });
});

describe('o pedido de revisão e o aviso ao gestor (TaskService)', () => {
  const people: Record<string, StaffProfile> = {
    'ana-1': { id: 'ana-1', name: 'Ana', role: 'Back-end', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'rev-1': { id: 'rev-1', name: 'Rui', role: 'Revisor', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
    'gio-1': { id: 'gio-1', name: 'Giovana', role: 'Orquestradora', autonomy: 'acceptEdits', worktree: false } as StaffProfile,
  };

  /** A tarefa da Ana pedida pela Giovana, que revisa o Rui; a suíte "roda" com `suite`, e a nova rodada com `again`. */
  async function flow(name: string, suite: TestRun, again: (command: string) => TestRun) {
    const dir = await project(name);
    const sent: string[] = [];
    const told: string[] = [];
    const ran: Array<{ command: string; timeoutMs?: number; queueAs?: string }> = [];
    const svc = new TaskService({
      projectPath: async () => dir,
      projectIds: async () => ['p'],
      readProfile: async (_p, id) => people[id] ?? null,
      send: async (_p, _staff, text) => (sent.push(text), `s-${sent.length}`),
      sendTo: async (_p, session) => session,
      branchFor: async () => null,
      isWorking: () => false,
      isSessionWorking: () => false,
      lastText: () => 'Pronto.',
      notify: async (_p, _staff, text) => void told.push(text),
      hasAsk: () => false,
      answerAsk: () => false,
      awaitingLimit: async () => false,
      apiUrl: 'http://127.0.0.1:4848',
      runTests: async (_cwd, command, timeoutMs, queueAs) => {
        ran.push({ command, timeoutMs, queueAs });
        return command === 'npm test' ? suite : again(command);
      },
    });
    const file = path.join(dir, '.myco', 'tasks.json');
    const t = (await svc.create('p', { title: 'Corrigir o X', description: 'Pedido', acceptance: 'O X funciona.', staffId: 'ana-1', reviewerId: 'rev-1' }, 'gio-1'))!;
    await svc.start('p', t.id); // s-1
    const all = JSON.parse(await fs.readFile(file, 'utf8')) as Array<Record<string, unknown>>;
    all.find((x) => x.id === t.id)!.changedFiles = ['server/y.ts'];
    await fs.writeFile(file, JSON.stringify(all));
    return { svc, sent, told, ran, id: t.id };
  }

  const suite = run({
    files: 187,
    output: 'fim da saída sem lista',
    failedFiles: [
      { file: 'tests/a.test.ts', failed: 3 },
      { file: 'tests/c.test.ts', failed: 4 },
    ],
  });
  const again = (command: string): TestRun => ({ command, ok: false, output: '', ms: 2000, at: '2026-11-19T12:02:00Z', files: 2, failedFiles: [{ file: 'tests/a.test.ts', failed: 3 }] });

  it('a entrega com a suíte vermelha roda a nova rodada só dos arquivos que falharam, e o pedido de revisão e o aviso ao gestor trazem a lista e o destaque', async () => {
    const f = await flow('fluxo', suite, again);
    await f.svc.onTurnDone('s-1');
    expect(f.ran.map((r) => r.command)).toEqual(['npm test', 'npm test -- tests/a.test.ts tests/c.test.ts']);
    expect(f.ran[1]).toMatchObject({ queueAs: 'npm test', timeoutMs: 180_000 });

    const review = f.sent.at(-1)!;
    expect(review).toContain('[Revisão da tarefa "Corrigir o X"]');
    expect(review).toContain('FALHARAM. Não rode a suíte de novo');
    expect(review).toContain('Arquivos com falha: 2 de 187 (7 falhas no total).');
    expect(review).toContain('- `tests/a.test.ts`: 3 falhas na suíte; falha também isolado (3); ⚠ importa `server/y.ts` (direta ou indiretamente), que é desta entrega: confira primeiro');
    expect(review).toContain('- `tests/c.test.ts`: 4 falhas na suíte; passa isolado');
    expect(review).not.toContain('fim da saída sem lista'); // com a lista, o rabo da saída não aparece
    expect(f.told.join('\n')).toContain('Arquivos com falha: 2 de 187'); // o gestor recebe o mesmo

    const saved = (await f.svc.list('p'))![0]!;
    expect(saved.tests?.isolated).toMatchObject({ command: 'npm test -- tests/a.test.ts tests/c.test.ts', files: [{ file: 'tests/a.test.ts', status: 'fail' }, { file: 'tests/c.test.ts', status: 'pass' }] });
  });

  it('suíte verde: não há nova rodada; suíte vermelha sem lista (outro executor): o fim da saída, como era', async () => {
    const green = await flow('verde', run({ ok: true, ms: 5000 }), again);
    await green.svc.onTurnDone('s-1');
    expect(green.ran.map((r) => r.command)).toEqual(['npm test']);
    expect(green.sent.at(-1)).toContain('passaram em 5 s. Não rode de novo.');

    const plain = await flow('sem-formato', run({ output: 'quebrou de um jeito que ninguém lê' }), again);
    await plain.svc.onTurnDone('s-1');
    expect(plain.ran.map((r) => r.command)).toEqual(['npm test']);
    expect(plain.sent.at(-1)).toContain('FALHARAM. Fim da saída:\nquebrou de um jeito que ninguém lê');
  });

  it('suíte cortada no tempo-limite: o pedido de revisão e o aviso ao gestor dizem TEMPO ESGOTADO (não FALHARAM) e o card guarda a marca', async () => {
    const f = await flow('tempo-esgotado', run({ ms: 1_800_000, output: 'cortada', timedOut: true, limitMs: 1_800_000 }), again);
    await f.svc.onTurnDone('s-1');
    expect(f.ran.map((r) => r.command)).toEqual(['npm test']); // sem lista de falhas: não há o que rodar de novo
    for (const text of [f.sent.at(-1)!, f.told.join('\n')]) {
      expect(text).toContain('TEMPO ESGOTADO, cortados aos 30 min sem terminar');
      expect(text).toContain('Isto NÃO é falha de teste');
      expect(text).not.toContain('FALHARAM');
    }
    expect((await f.svc.list('p'))![0]!.tests).toMatchObject({ ok: false, timedOut: true, limitMs: 1_800_000 });
  });

  it('cortada no tempo-limite depois de alguns arquivos já terem falhado: o aviso diz as duas coisas, sem chamar a rodada de falha', async () => {
    const f = await flow('tempo-esgotado-lista', run({ ms: 1_800_000, timedOut: true, limitMs: 1_800_000, files: undefined, failedFiles: [{ file: 'tests/a.test.ts', failed: 3 }] }), again);
    await f.svc.onTurnDone('s-1');
    const review = f.sent.at(-1)!;
    expect(review).toContain('TEMPO ESGOTADO');
    expect(review).toContain('Antes do corte, estes arquivos já tinham falhado:');
    expect(review).toContain('Arquivos com falha: 1');
    expect(review).not.toContain('FALHARAM');
  });

  it('a nova rodada que dá erro não derruba a entrega: o pedido sai com a lista da suíte', async () => {
    const f = await flow('erro-rodada', suite, () => {
      throw new Error('sem rede');
    });
    await f.svc.onTurnDone('s-1');
    const review = f.sent.at(-1)!;
    expect(review).toContain('Arquivos com falha: 2 de 187');
    expect(review).toContain('Nova rodada só desses arquivos não feita: a nova rodada não rodou: sem rede.');
    expect((await f.svc.list('p'))![0]!.status).toBe('review');
  });
});
