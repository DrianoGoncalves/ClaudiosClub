import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELATED_MAX_CHARS, scopedTestCommand } from '../server/taskCode';
import { tempDirs } from './support/tmp';

// Testes da entrega e da mescla em camadas: só os ligados aos arquivos mudados (vitest related, 2 processos); a suíte inteira fica no CI do PR (SPEC "Desempenho" 9).

const tmp = tempDirs();
afterEach(() => {
  delete process.env.MYCO_FULL_TESTS;
});

async function project(pkg: Record<string, unknown> | null, extra: Record<string, string> = {}) {
  const dir = await tmp('myco-scoped-');
  if (pkg) await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  for (const [f, c] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.writeFile(path.join(dir, f), c);
  }
  return dir;
}
const vitestPkg = { scripts: { test: 'vitest run' }, devDependencies: { vitest: '^5.1.0' } };
const code = { 'server/a.ts': 'export const a = 1;\n', 'tests/a.test.ts': '' };

describe('scopedTestCommand', () => {
  it('vitest com a lista: só os relacionados, sem repetir arquivo, barras normalizadas e no máximo 2 processos', async () => {
    const dir = await project(vitestPkg, code);
    expect(await scopedTestCommand(dir, ['server\\a.ts', 'tests/a.test.ts', 'server/a.ts'])).toBe('npx vitest related server/a.ts tests/a.test.ts --run --passWithNoTests --maxWorkers=2');
  });

  it('mudança na configuração (dependências, tsconfig, config do vitest, .env): a suíte inteira', async () => {
    const dir = await project(vitestPkg, code);
    for (const cfg of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'client/vite.config.mts', '.env.local']) {
      expect(await scopedTestCommand(dir, ['server/a.ts', cfg])).toBe('npm test');
    }
  });

  it('sem arquivo de código que exista aqui (só docs/CSS, só remoções, caminho de outro pacote): a suíte inteira, em vez de passar sem rodar nada', async () => {
    const dir = await project(vitestPkg, code);
    expect(await scopedTestCommand(dir, ['README.md', 'client/src/styles.css'])).toBe('npm test');
    expect(await scopedTestCommand(dir, ['server/removido.ts'])).toBe('npm test');
    expect(await scopedTestCommand(dir, ['packages/outro/src/x.ts'])).toBe('npm test');
    expect(await scopedTestCommand(dir, ['README.md', 'server/a.ts'])).toBe('npx vitest related README.md server/a.ts --run --passWithNoTests --maxWorkers=2');
  });

  it('sem lista (ou vazia): a suíte do projeto', async () => {
    const dir = await project(vitestPkg);
    expect(await scopedTestCommand(dir, [])).toBe('npm test');
    expect(await scopedTestCommand(dir, undefined)).toBe('npm test');
  });

  it('nome que o shell interpretaria, que sobe pasta ou que parece opção: a suíte do projeto', async () => {
    const dir = await project(vitestPkg);
    for (const bad of ['a b.ts', 'a;rm -rf x.ts', 'a&&b.ts', '$(x).ts', '../fora.ts', 'src/../../x.ts', '--config=x', 'a|b.ts', '"a".ts']) {
      expect(await scopedTestCommand(dir, ['ok.ts', bad])).toBe('npm test');
    }
  });

  it('lista grande demais para a linha de comando: a suíte do projeto', async () => {
    const dir = await project(vitestPkg, code);
    const many = ['server/a.ts', ...Array.from({ length: Math.ceil(RELATED_MAX_CHARS / 20) + 10 }, (_, i) => `server/arquivo-${i}.ts`)];
    expect(await scopedTestCommand(dir, many)).toBe('npm test');
  });

  it('sem vitest (jest, mocha) ou outra stack: o comando de testes do projeto, como antes', async () => {
    expect(await scopedTestCommand(await project({ scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }), ['a.ts'])).toBe('npm test');
    expect(await scopedTestCommand(await project(null, { 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }), ['a.php'])).toBe('composer test');
    expect(await scopedTestCommand(await project({ scripts: {} }), ['a.ts'])).toBeNull();
  });

  it('MYCO_FULL_TESTS=1 força a suíte inteira', async () => {
    const dir = await project(vitestPkg, code);
    process.env.MYCO_FULL_TESTS = '1';
    expect(await scopedTestCommand(dir, ['server/a.ts'])).toBe('npm test');
  });
});
