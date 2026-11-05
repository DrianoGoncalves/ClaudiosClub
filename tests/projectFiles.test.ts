import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanRel, createProjectEntry, deleteProjectEntry, parseDeleteBody, isSecretRel, listProjectTree, MAX_FILE_BYTES, parseCreateBody, parseWriteBody, ProjectFileError, readProjectFile, readProjectImageFile, writeProjectFile } from '../server/projectFiles';

let base: string;
let root: string;
let outside: string;

/** Erro com o status HTTP esperado (ou o próprio erro se o status não bater). */
async function statusOf(p: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    if (err instanceof ProjectFileError) return err.status;
    throw err;
  }
}

// Symlink no Windows exige privilégio (ou modo de desenvolvedor): se não der, os testes de link são pulados.
async function probeSymlink(): Promise<boolean> {
  const target = path.join(os.tmpdir(), `myco-probe-${process.pid}.txt`);
  const link = path.join(os.tmpdir(), `myco-probe-link-${process.pid}.txt`);
  try {
    await fs.writeFile(target, 'x');
    await fs.symlink(target, link, 'file');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(link, { force: true }).catch(() => {});
    await fs.rm(target, { force: true }).catch(() => {});
  }
}
const canLink = await probeSymlink();

beforeAll(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-files-'));
  root = path.join(base, 'projeto');
  outside = path.join(base, 'fora');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'));
  await fs.mkdir(path.join(root, 'Assets'));
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, '.vps'));
  await fs.mkdir(path.join(root, 'keys'));
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, 'README.md'), '# oi\n');
  await fs.writeFile(path.join(root, 'b.txt'), 'b');
  await fs.writeFile(path.join(root, 'A.md'), 'a');
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const x = 1;\r\nexport const y = 2;\r\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
  await fs.writeFile(path.join(root, '.git', 'config'), 'x');
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=abc');
  await fs.writeFile(path.join(root, '.ENV.local'), 'TOKEN=abc');
  await fs.writeFile(path.join(root, '.env.example'), 'TOKEN=');
  await fs.writeFile(path.join(root, 'keys', 'server.pem'), 'x');
  await fs.writeFile(path.join(root, 'credentials-prod.json'), '{}');
  await fs.writeFile(path.join(root, 'id_ed25519'), 'x');
  await fs.writeFile(path.join(root, '.vps', 'notes.txt'), 'x');
  await fs.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x03]));
  await fs.writeFile(path.join(root, 'grande.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 'a'));
  await fs.writeFile(path.join(root, 'limite.txt'), Buffer.alloc(MAX_FILE_BYTES, 'a'));
  await fs.writeFile(path.join(outside, 'segredo.txt'), 'fora do projeto');
});

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('caminhos', () => {
  it('normaliza e recusa absoluto, NUL e ..', () => {
    expect(cleanRel('src//app.ts')).toBe('src/app.ts');
    expect(cleanRel('./src/./app.ts')).toBe('src/app.ts');
    expect(cleanRel('src\\app.ts')).toBe('src/app.ts');
    expect(() => cleanRel('../segredo.txt')).toThrow(ProjectFileError);
    expect(() => cleanRel('src/../../segredo.txt')).toThrow(ProjectFileError);
    expect(() => cleanRel('/etc/passwd')).toThrow(ProjectFileError);
    expect(() => cleanRel('C:\\Windows\\win.ini')).toThrow(ProjectFileError);
    expect(() => cleanRel('a\0b')).toThrow(ProjectFileError);
  });

  it('read e tree respondem 403 para traversal e absoluto', async () => {
    expect(await statusOf(readProjectFile(root, '../fora/segredo.txt'))).toBe(403);
    expect(await statusOf(readProjectFile(root, path.join(outside, 'segredo.txt')))).toBe(403);
    expect(await statusOf(readProjectFile(root, 'src/../../fora/segredo.txt'))).toBe(403);
    expect(await statusOf(listProjectTree(root, '..'))).toBe(403);
    expect(await statusOf(listProjectTree(root, path.resolve(root, '..')))).toBe(403);
  });

  it.runIf(canLink)('symlink de arquivo que sai do projeto: 403 no read e fora da lista', async () => {
    await fs.symlink(path.join(outside, 'segredo.txt'), path.join(root, 'atalho.txt'), 'file');
    expect(await statusOf(readProjectFile(root, 'atalho.txt'))).toBe(403);
    const { entries } = await listProjectTree(root, '');
    expect(entries.some((e) => e.name === 'atalho.txt')).toBe(false);
  });

  it.runIf(canLink)('symlink de pasta que sai do projeto não é seguido', async () => {
    await fs.symlink(outside, path.join(root, 'link-pasta'), 'junction');
    expect(await statusOf(listProjectTree(root, 'link-pasta'))).toBe(403);
    expect((await listProjectTree(root, '')).entries.some((e) => e.name === 'link-pasta')).toBe(false);
  });

  it.runIf(canLink)('symlink para dentro do projeto continua funcionando', async () => {
    await fs.symlink(path.join(root, 'README.md'), path.join(root, 'leia-me.md'), 'file');
    const f = await readProjectFile(root, 'leia-me.md');
    expect(f.content).toBe('# oi\n');
  });
});

describe('segredos', () => {
  it('reconhece os padrões de segredo, inclusive variações de caixa', () => {
    for (const p of ['.env', '.env.local', '.ENV.production', 'x/y/.env', 'a.pem', 'a.KEY', 'a.p12', 'a.pfx', 'x.keystore', 'id_rsa', 'id_ed25519.pub', 'credentials.json', 'credentials-prod.json', '.vps/notes.txt', '.ssh/config', 'deep/.ssh/x']) {
      expect(isSecretRel(p), p).toBe(true);
    }
    for (const p of ['.env.example', 'config/.env.sample', 'README.md', 'src/environment.ts', 'my_id_rsa.md', 'credentials.md']) {
      expect(isSecretRel(p), p).toBe(false);
    }
  });

  it('segredo bloqueado no read; .env.example liberado', async () => {
    expect(await statusOf(readProjectFile(root, '.env'))).toBe(403);
    expect(await statusOf(readProjectFile(root, '.ENV.local'))).toBe(403);
    expect(await statusOf(readProjectFile(root, 'keys/server.pem'))).toBe(403);
    expect(await statusOf(readProjectFile(root, 'credentials-prod.json'))).toBe(403);
    expect(await statusOf(readProjectFile(root, 'id_ed25519'))).toBe(403);
    expect(await statusOf(readProjectFile(root, '.vps/notes.txt'))).toBe(403);
    expect((await readProjectFile(root, '.env.example')).content).toBe('TOKEN=');
  });

  it('segredo listado como locked, mas o .env.example não é locked', async () => {
    const { entries } = await listProjectTree(root, '');
    expect(entries.find((e) => e.name === '.env')?.locked).toBe(true);
    expect(entries.find((e) => e.name === '.env.example')?.locked).toBeUndefined();
    const vps = await listProjectTree(root, '.vps');
    expect(vps.entries).toEqual([{ name: 'notes.txt', path: '.vps/notes.txt', type: 'file', size: 1, locked: true }]);
  });

  it('gravar segredo dá 403, mesmo que o arquivo exista', async () => {
    const st = await fs.stat(path.join(root, '.env'));
    expect(await statusOf(writeProjectFile(root, { path: '.env', content: 'X=1', baseMtimeMs: st.mtimeMs }))).toBe(403);
    expect(await fs.readFile(path.join(root, '.env'), 'utf8')).toBe('TOKEN=abc');
  });
});

describe('leitura', () => {
  it('devolve conteúdo, mtime e tamanho', async () => {
    const f = await readProjectFile(root, 'README.md');
    const st = await fs.stat(path.join(root, 'README.md'));
    expect(f).toEqual({ path: 'README.md', content: '# oi\n', mtimeMs: st.mtimeMs, size: 5 });
  });

  it('binário (NUL nos primeiros 8 KB) dá 415', async () => {
    expect(await statusOf(readProjectFile(root, 'bin.dat'))).toBe(415);
  });

  it('arquivo maior que 1 MB dá 413; exatamente 1 MB passa', async () => {
    expect(await statusOf(readProjectFile(root, 'grande.txt'))).toBe(413);
    expect(await statusOf(readProjectFile(root, 'limite.txt'))).toBe('ok');
  });

  it('inexistente, pasta ou fora de UTF-8 dão 404, 404 e 415', async () => {
    expect(await statusOf(readProjectFile(root, 'nao-existe.md'))).toBe(404);
    expect(await statusOf(readProjectFile(root, 'src'))).toBe(404);
    await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(await statusOf(readProjectFile(root, 'latin1.txt'))).toBe(415);
  });
});

describe('lista de pastas', () => {
  it('pastas primeiro, depois nome sem diferenciar maiúsculas; oculta node_modules e .git', async () => {
    const { entries } = await listProjectTree(root, '');
    const names = entries.map((e) => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
    const dirs = entries.filter((e) => e.type === 'dir').map((e) => e.name);
    const files = entries.filter((e) => e.type === 'file').map((e) => e.name);
    expect(dirs).toEqual(['Assets', 'docs', 'keys', 'src', '.vps'].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' })));
    expect(entries.slice(0, dirs.length).every((e) => e.type === 'dir')).toBe(true);
    expect(files.indexOf('A.md')).toBeLessThan(files.indexOf('b.txt'));
    expect(files.indexOf('b.txt')).toBeLessThan(files.indexOf('README.md'));
  });

  it('traz caminho relativo com "/", tamanho e não oculta .vps', async () => {
    const src = await listProjectTree(root, 'src/');
    expect(src.entries).toEqual([{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 'export const x = 1;\r\nexport const y = 2;\r\n'.length }]);
    expect((await listProjectTree(root, '')).entries.some((e) => e.name === '.vps')).toBe(true);
  });

  it('pasta oculta e arquivo no lugar de pasta dão 404', async () => {
    expect(await statusOf(listProjectTree(root, 'node_modules/pkg'))).toBe(404);
    expect(await statusOf(listProjectTree(root, 'README.md'))).toBe(404);
  });
});

describe('gravação', () => {
  beforeAll(async () => {
    // Data antiga e fixa: qualquer gravação de agora muda o mtime e o teste fica determinístico.
    await fs.writeFile(path.join(root, 'docs', 'nota.md'), 'antes\r\n');
    await fs.utimes(path.join(root, 'docs', 'nota.md'), 1_600_000_000, 1_600_000_000);
  });

  it('409 com o mtime atual quando o arquivo mudou no disco', async () => {
    const f = await readProjectFile(root, 'docs/nota.md');
    const err = await writeProjectFile(root, { path: 'docs/nota.md', content: 'x', baseMtimeMs: f.mtimeMs - 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectFileError);
    expect((err as ProjectFileError).status).toBe(409);
    expect((err as ProjectFileError).extra).toEqual({ mtimeMs: f.mtimeMs });
    expect(await fs.readFile(path.join(root, 'docs', 'nota.md'), 'utf8')).toBe('antes\r\n');
  });

  it('grava com o mtime certo, atualiza o mtime e preserva o fim de linha do content', async () => {
    const f = await readProjectFile(root, 'docs/nota.md');
    const { mtimeMs } = await writeProjectFile(root, { path: 'docs/nota.md', content: 'depois\r\nlinha 2\r\n', baseMtimeMs: f.mtimeMs });
    expect(mtimeMs).not.toBe(f.mtimeMs);
    expect(await fs.readFile(path.join(root, 'docs', 'nota.md'), 'utf8')).toBe('depois\r\nlinha 2\r\n');
    expect((await readProjectFile(root, 'docs/nota.md')).mtimeMs).toBe(mtimeMs);
    // Com o mtime antigo, agora é conflito de novo.
    expect(await statusOf(writeProjectFile(root, { path: 'docs/nota.md', content: 'x', baseMtimeMs: f.mtimeMs }))).toBe(409);
    // Não sobrou temporário na pasta.
    expect((await fs.readdir(path.join(root, 'docs'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('não cria nem apaga: inexistente dá 404, pasta dá 404, e fora do projeto dá 403', async () => {
    expect(await statusOf(writeProjectFile(root, { path: 'novo.md', content: 'x', baseMtimeMs: 0 }))).toBe(404);
    expect(await statusOf(writeProjectFile(root, { path: 'docs', content: 'x', baseMtimeMs: 0 }))).toBe(404);
    expect(await statusOf(writeProjectFile(root, { path: '../fora/segredo.txt', content: 'x', baseMtimeMs: 0 }))).toBe(403);
    expect(await fs.readFile(path.join(outside, 'segredo.txt'), 'utf8')).toBe('fora do projeto');
  });

  it('content acima de 1 MB dá 413', async () => {
    const f = await readProjectFile(root, 'docs/nota.md');
    const big = 'a'.repeat(MAX_FILE_BYTES + 1);
    expect(await statusOf(writeProjectFile(root, { path: 'docs/nota.md', content: big, baseMtimeMs: f.mtimeMs }))).toBe(413);
  });

  it('valida o corpo: tipos errados dão 400', () => {
    expect(() => parseWriteBody(null)).toThrow(ProjectFileError);
    expect(() => parseWriteBody({ path: 1, content: '', baseMtimeMs: 1 })).toThrow(ProjectFileError);
    expect(() => parseWriteBody({ path: 'a', content: 2, baseMtimeMs: 1 })).toThrow(ProjectFileError);
    expect(() => parseWriteBody({ path: 'a', content: '', baseMtimeMs: '1' })).toThrow(ProjectFileError);
    expect(parseWriteBody({ path: 'a', content: 'b', baseMtimeMs: 1 })).toEqual({ path: 'a', content: 'b', baseMtimeMs: 1 });
  });
});

describe('criação', () => {
  it('cria arquivo vazio e pasta, com pastas intermediárias, e devolve o caminho limpo', async () => {
    expect(await createProjectEntry(root, { path: './novos//a.md', kind: 'file' })).toEqual({ path: 'novos/a.md' });
    expect(await fs.readFile(path.join(root, 'novos', 'a.md'), 'utf8')).toBe('');
    expect(await createProjectEntry(root, { path: 'novos\\x\\y', kind: 'dir' })).toEqual({ path: 'novos/x/y' });
    expect((await fs.stat(path.join(root, 'novos', 'x', 'y'))).isDirectory()).toBe(true);
  });

  it('nunca sobrescreve: arquivo ou pasta que já existe dá 409', async () => {
    expect(await statusOf(createProjectEntry(root, { path: 'README.md', kind: 'file' }))).toBe(409);
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# oi\n');
    expect(await statusOf(createProjectEntry(root, { path: 'src', kind: 'dir' }))).toBe(409);
    expect(await statusOf(createProjectEntry(root, { path: 'src', kind: 'file' }))).toBe(409);
    // Arquivo no lugar de pasta intermediária.
    expect(await statusOf(createProjectEntry(root, { path: 'README.md/x.txt', kind: 'file' }))).toBe(409);
  });

  it('segredo, .git, node_modules, .. e fora do projeto dão 403', async () => {
    for (const p of ['.env', 'src/.env.local', 'keys/novo.pem', '.git/hooks/x', '.git', 'node_modules/y', '.vps/a.txt', '../fora/novo.txt', 'src/../../fora/x', path.join(outside, 'x.txt')]) {
      expect(await statusOf(createProjectEntry(root, { path: p, kind: 'file' })), p).toBe(403);
    }
    expect(await statusOf(createProjectEntry(root, { path: '.ssh', kind: 'dir' }))).toBe(403);
    await expect(fs.stat(path.join(outside, 'novo.txt'))).rejects.toThrow();
    expect(await createProjectEntry(root, { path: 'cfg/.env.example', kind: 'file' })).toEqual({ path: 'cfg/.env.example' });
  });

  it('nome vazio, inválido no Windows ou corpo errado dá 400', async () => {
    for (const p of ['', '.', './/', 'a<b.txt', 'x/a:b','x/what?.md', 'pipe|.txt', 'ponto.', 'espaco ', 'CON', 'nul.txt', 'src/com1', `a${'\x01'}b`, 'x'.repeat(256)]) {
      expect(await statusOf(createProjectEntry(root, { path: p, kind: 'file' })), JSON.stringify(p)).toBe(400);
    }
    expect(() => parseCreateBody(null)).toThrow(ProjectFileError);
    expect(() => parseCreateBody({ path: 1, kind: 'file' })).toThrow(ProjectFileError);
    expect(() => parseCreateBody({ path: 'a', kind: 'link' })).toThrow(ProjectFileError);
    expect(parseCreateBody({ path: 'a', kind: 'dir', extra: 1 })).toEqual({ path: 'a', kind: 'dir' });
  });

  it.runIf(canLink)('pasta-link que sai do projeto: 403 e nada é criado fora', async () => {
    await fs.symlink(outside, path.join(root, 'link-fora'), 'junction');
    expect(await statusOf(createProjectEntry(root, { path: 'link-fora/novo.txt', kind: 'file' }))).toBe(403);
    expect(await statusOf(createProjectEntry(root, { path: 'link-fora/sub/novo', kind: 'dir' }))).toBe(403);
    expect(await fs.readdir(outside)).toEqual(['segredo.txt']);
  });
});

describe('exclusão', () => {
  const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

  it('apaga arquivo e pasta (recursivo) e devolve quantos itens saíram', async () => {
    await fs.mkdir(path.join(root, 'lixo', 'a', 'b'), { recursive: true });
    await fs.writeFile(path.join(root, 'lixo', 'x.txt'), 'x');
    await fs.writeFile(path.join(root, 'lixo', 'a', 'b', 'y.txt'), 'y');
    await fs.writeFile(path.join(root, 'solto.txt'), 's');
    expect(await deleteProjectEntry(root, './solto.txt')).toEqual({ path: 'solto.txt', removed: 1 });
    expect(await exists(path.join(root, 'solto.txt'))).toBe(false);
    expect(await deleteProjectEntry(root, 'lixo\\')).toEqual({ path: 'lixo', removed: 5 });
    expect(await exists(path.join(root, 'lixo'))).toBe(false);
  });

  it('arquivo só-leitura também sai', async () => {
    await fs.writeFile(path.join(root, 'ro.txt'), 'r');
    await fs.chmod(path.join(root, 'ro.txt'), 0o444);
    await deleteProjectEntry(root, 'ro.txt');
    expect(await exists(path.join(root, 'ro.txt'))).toBe(false);
  });

  it('nunca a raiz; segredo, .git, node_modules, .myco e fora do projeto dão 403', async () => {
    for (const p of ['', '.', './/']) expect(await statusOf(deleteProjectEntry(root, p)), JSON.stringify(p)).toBe(400);
    await fs.mkdir(path.join(root, '.myco'), { recursive: true });
    for (const p of ['.env', '.ENV.local', 'keys/server.pem', '.git', '.git/config', 'node_modules', 'node_modules/pkg', '.vps', '.myco', '.MYCO/staff', '../fora/segredo.txt', 'src/../../fora', path.join(outside, 'segredo.txt')]) {
      expect(await statusOf(deleteProjectEntry(root, p)), p).toBe(403);
    }
    for (const p of ['.env', '.git/config', 'node_modules/pkg/index.js', 'keys/server.pem', '.myco']) expect(await exists(path.join(root, p)), p).toBe(true);
    expect(await exists(path.join(outside, 'segredo.txt'))).toBe(true);
  });

  it('pasta com segredo dentro: 403 e nada sai', async () => {
    await fs.mkdir(path.join(root, 'cfg2', 'sub'), { recursive: true });
    await fs.writeFile(path.join(root, 'cfg2', 'a.txt'), 'a');
    await fs.writeFile(path.join(root, 'cfg2', 'sub', '.env'), 'TOKEN=1');
    expect(await statusOf(deleteProjectEntry(root, 'cfg2'))).toBe(403);
    expect(await exists(path.join(root, 'cfg2', 'a.txt'))).toBe(true);
  });

  it('acima do limite de itens ou de bytes: 413 e nada sai', async () => {
    await fs.mkdir(path.join(root, 'muito'));
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(root, 'muito', `${i}.txt`), 'x'.repeat(10));
    expect(await statusOf(deleteProjectEntry(root, 'muito', { maxEntries: 4 }))).toBe(413);
    expect(await statusOf(deleteProjectEntry(root, 'muito', { maxBytes: 49 }))).toBe(413);
    expect((await fs.readdir(path.join(root, 'muito'))).length).toBe(5);
    expect(await deleteProjectEntry(root, 'muito', { maxEntries: 5, maxBytes: 50 })).toEqual({ path: 'muito', removed: 6 });
  });

  it('não encontrado: 404; corpo errado: 400', async () => {
    expect(await statusOf(deleteProjectEntry(root, 'nao-existe.txt'))).toBe(404);
    expect(await statusOf(deleteProjectEntry(root, 'nao-existe/x.txt'))).toBe(404);
    expect(() => parseDeleteBody(null)).toThrow(ProjectFileError);
    expect(() => parseDeleteBody({ path: 1 })).toThrow(ProjectFileError);
    expect(parseDeleteBody({ path: 'a', x: 1 })).toEqual({ path: 'a' });
  });

  it.runIf(canLink)('link nunca é seguido: apaga só o link (arquivo, pasta e link dentro da pasta)', async () => {
    await fs.mkdir(path.join(outside, 'alvo'), { recursive: true });
    await fs.writeFile(path.join(outside, 'alvo', 'importante.txt'), 'fica');
    await fs.symlink(path.join(outside, 'alvo'), path.join(root, 'link-dir'), 'junction');
    await fs.symlink(path.join(outside, 'segredo.txt'), path.join(root, 'link-arq.txt'), 'file');
    await fs.mkdir(path.join(root, 'com-link'));
    await fs.symlink(path.join(outside, 'alvo'), path.join(root, 'com-link', 'dentro'), 'junction');

    expect(await deleteProjectEntry(root, 'link-dir')).toEqual({ path: 'link-dir', removed: 1 });
    expect(await deleteProjectEntry(root, 'link-arq.txt')).toEqual({ path: 'link-arq.txt', removed: 1 });
    expect(await deleteProjectEntry(root, 'com-link')).toEqual({ path: 'com-link', removed: 2 });
    for (const p of ['link-dir', 'link-arq.txt', 'com-link']) expect(await exists(path.join(root, p)), p).toBe(false);
    expect(await fs.readFile(path.join(outside, 'alvo', 'importante.txt'), 'utf8')).toBe('fica');
    expect(await fs.readFile(path.join(outside, 'segredo.txt'), 'utf8')).toBe('fora do projeto');
  });

  it.runIf(canLink)('pasta-link que sai do projeto no meio do caminho: 403 e nada sai lá fora', async () => {
    await fs.symlink(outside, path.join(root, 'saida'), 'junction');
    expect(await statusOf(deleteProjectEntry(root, 'saida/segredo.txt'))).toBe(403);
    expect(await fs.readFile(path.join(outside, 'segredo.txt'), 'utf8')).toBe('fora do projeto');
  });
});

describe('readProjectImageFile', () => {
  it('devolve os bytes e o tipo de uma imagem do projeto', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
    await fs.writeFile(path.join(root, 'logo.PNG'), png);
    const img = await readProjectImageFile(root, 'logo.PNG');
    expect(img.type).toBe('image/png');
    expect(img.bytes.equals(png)).toBe(true);
  });

  it('só imagens: texto e SVG dão 415, segredo e fora do projeto dão 403, inexistente 404', async () => {
    await fs.writeFile(path.join(root, 'nota.txt'), 'oi');
    expect(await statusOf(readProjectImageFile(root, 'nota.txt'))).toBe(415);
    expect(await statusOf(readProjectImageFile(root, 'icone.svg'))).toBe(415);
    expect(await statusOf(readProjectImageFile(root, '.ssh/foto.png'))).toBe(403);
    expect(await statusOf(readProjectImageFile(root, '../fora.png'))).toBe(403);
    expect(await statusOf(readProjectImageFile(root, 'nao-existe.png'))).toBe(404);
  });

  it.runIf(canLink)('link com nome de imagem: para fora ou segredo dá 403, para texto dá 415', async () => {
    await fs.writeFile(path.join(root, 'texto.txt'), 'oi');
    await fs.writeFile(path.join(root, '.env'), 'SEGREDO=1');
    await fs.symlink(path.join(outside, 'segredo.txt'), path.join(root, 'fora.png'), 'file');
    await fs.symlink(path.join(root, '.env'), path.join(root, 'env.png'), 'file');
    await fs.symlink(path.join(root, 'texto.txt'), path.join(root, 'texto.png'), 'file');
    expect(await statusOf(readProjectImageFile(root, 'fora.png'))).toBe(403);
    expect(await statusOf(readProjectImageFile(root, 'env.png'))).toBe(403);
    expect(await statusOf(readProjectImageFile(root, 'texto.png'))).toBe(415);
  });
});
