import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDeps } from '../scripts/deps';
import { removeTemp } from './support/tmp';

// Seção "Dependências usadas" da página de início: a lista vem do package.json do projeto e do que está em node_modules.
// Só leitura: nunca lança, e o que não dá para ler vira null (ou lista vazia).

let root: string;

async function write(rel: string, data: unknown): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-deps-'));
  await write('package.json', {
    name: 'app',
    dependencies: { alpha: '^1.0.0', '@codemirror/view': '^6.0.0', ghost: '^2.0.0', long: '~1.0.0' },
    devDependencies: { tester: '~3.0.0' },
  });
  // Instalado com licença em texto, com espaços e quebra de linha na descrição.
  await write('node_modules/alpha/package.json', { name: 'alpha', version: '1.2.3', license: 'MIT', description: '  Um   pacote\n  pequeno ' });
  // Escopo (@codemirror/view) e licença como objeto { type }.
  await write('node_modules/@codemirror/view/package.json', { name: '@codemirror/view', version: '6.5.0', license: { type: 'MIT' }, description: 'Editor' });
  await write('node_modules/long/package.json', { name: 'long', version: '1.0.4', license: 'ISC', description: 'x'.repeat(300) });
  // Sem descrição nem licença de texto: fica null.
  await write('node_modules/tester/package.json', { name: 'tester', version: '3.0.1', license: ['Apache-2.0'] });
  // "ghost" não está em node_modules.
  await write('node_modules/.package-lock.json', {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/alpha': {},
      'node_modules/@codemirror/view': {},
      'node_modules/long': {},
      'node_modules/tester': {},
      'node_modules/alpha/node_modules/beta': {},
    },
  });
});

afterEach(async () => {
  await removeTemp(root);
});

describe('listDeps', () => {
  it('pacote instalado: versão, faixa pedida, licença e descrição (com espaços normalizados)', () => {
    const { deps } = listDeps(root);
    expect(deps.find((d) => d.name === 'alpha')).toEqual({
      name: 'alpha',
      wanted: '^1.0.0',
      version: '1.2.3',
      license: 'MIT',
      description: 'Um pacote pequeno',
      dev: false,
    });
  });

  it('pacote não instalado: version null, licença e descrição null, a faixa pedida continua', () => {
    const ghost = listDeps(root).deps.find((d) => d.name === 'ghost');
    expect(ghost).toEqual({ name: 'ghost', wanted: '^2.0.0', version: null, license: null, description: null, dev: false });
  });

  it('scoped (@codemirror/view) sai com o nome inteiro; licença { type } vira o texto', () => {
    const view = listDeps(root).deps.find((d) => d.name === '@codemirror/view');
    expect(view).toMatchObject({ version: '6.5.0', license: 'MIT', description: 'Editor' });
  });

  it('licença que não é texto nem { type } (lista) vira null', () => {
    const tester = listDeps(root).deps.find((d) => d.name === 'tester');
    expect(tester).toMatchObject({ version: '3.0.1', license: null, description: null, dev: true });
  });

  it('descrição longa é cortada em 140 caracteres no máximo, com reticências', () => {
    const long = listDeps(root).deps.find((d) => d.name === 'long');
    expect(long?.description).toHaveLength(140);
    expect(long?.description?.endsWith('…')).toBe(true);
  });

  it('dependências do app primeiro, depois as de desenvolvimento; cada grupo ordenado por nome', () => {
    const { deps } = listDeps(root);
    expect(deps.map((d) => [d.name, d.dev])).toEqual([
      ['@codemirror/view', false],
      ['alpha', false],
      ['ghost', false],
      ['long', false],
      ['tester', true],
    ]);
  });

  it('installedTotal conta as chaves node_modules/... do .package-lock.json; sem o arquivo, null', async () => {
    expect(listDeps(root).installedTotal).toBe(5);
    await fs.rm(path.join(root, 'node_modules', '.package-lock.json'));
    expect(listDeps(root).installedTotal).toBeNull();
  });

  it('package.json ilegível, lock ilegível ou pacote instalado com package.json quebrado: não lança', async () => {
    await write('node_modules/alpha/package.json', '{ quebrado');
    expect(listDeps(root).deps.find((d) => d.name === 'alpha')?.version).toBeNull();

    await write('package.json', '{ isto não é json');
    expect(listDeps(root)).toEqual({ deps: [], installedTotal: 5 });

    await write('node_modules/.package-lock.json', '{ quebrado');
    expect(listDeps(root)).toEqual({ deps: [], installedTotal: null });

    // Pasta sem nada (nem package.json, nem node_modules): também não lança.
    expect(listDeps(path.join(root, 'nao-existe'))).toEqual({ deps: [], installedTotal: null });
  });
});

describe('página de início', () => {
  it('a seção é recolhida e escondida até chegar o dado; fica entre o checklist e o Defender; sem innerHTML', async () => {
    const html = await fs.readFile(path.join(__dirname, '..', 'scripts', 'start.html'), 'utf8');
    expect(html).toContain('<details class="log deps" id="deps-box" hidden>');
    expect(html.indexOf('id="deps-box"')).toBeGreaterThan(html.indexOf('id="steps"'));
    expect(html.indexOf('id="deps-box"')).toBeLessThan(html.indexOf('id="defender"'));
    expect(html).toContain('renderDeps(st && st.deps)');
    const fn = html.slice(html.indexOf('const NPM_PAGE'), html.indexOf('function render(st'));
    expect(fn).toContain('function renderDeps');
    expect(fn).not.toMatch(/innerHTML|insertAdjacentHTML/);
    // Link para a página do npm: cada parte do nome sai com encodeURIComponent; aba nova, sem acesso à página de origem.
    expect(fn).toContain("split('/').map((part) => encodeURIComponent(part).replace(/^%40/, '@')).join('/')");
    expect(fn).toContain("a.rel = 'noopener noreferrer';");
  });
});
