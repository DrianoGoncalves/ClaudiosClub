import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGuide, GuideExistsError, guideStatus, hasGuide, MAX_SHOWCASE_BYTES, readShowcase, unsafeShowcase } from '../server/projectGuide';
import { ProjectFileError } from '../server/projectFiles';

describe('guia do projeto (SPEC.md)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-guia-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('sem SPEC.md e fora de git: não existe, não é git, não é ignorado; sem vitrine', async () => {
    expect(await guideStatus(dir)).toEqual({
      path: 'SPEC.md',
      exists: false,
      isGit: false,
      ignored: false,
      showcase: { path: 'VITRINE.html', exists: false },
    });
    expect(await hasGuide(dir)).toBe(false);
  });

  it('vitrine: exists diz se o VITRINE.html está lá; a base (showcase.json) aparece só se for válida, em git', async () => {
    await fs.writeFile(path.join(dir, 'VITRINE.html'), '<h1>x</h1>', 'utf8');
    expect((await guideStatus(dir)).showcase).toEqual({ path: 'VITRINE.html', exists: true });
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=teste@teste', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir, windowsHide: true });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).trim();
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(dir, '.myco', 'showcase.json'), JSON.stringify({ sha, at: '2026-11-10T10:00:00.000Z' }), 'utf8');
    expect((await guideStatus(dir)).showcase).toMatchObject({ exists: true, lastCheck: { sha, at: '2026-11-10T10:00:00.000Z' } });
    await fs.writeFile(path.join(dir, '.myco', 'showcase.json'), JSON.stringify({ sha: '1'.repeat(40), at: '2026-11-10T10:00:00.000Z' }), 'utf8');
    expect((await guideStatus(dir)).showcase).not.toHaveProperty('lastCheck');
    expect((await guideStatus(dir)).showcase.exists).toBe(true);
  }, 30_000);

  it('readShowcase: sem o arquivo, null; com ele, os bytes; acima do limite, 413', async () => {
    expect(await readShowcase(dir)).toBeNull();
    await fs.writeFile(path.join(dir, 'VITRINE.html'), '<p>oi</p>', 'utf8');
    expect((await readShowcase(dir))?.toString('utf8')).toBe('<p>oi</p>');
    await fs.writeFile(path.join(dir, 'VITRINE.html'), Buffer.alloc(MAX_SHOWCASE_BYTES + 1));
    await expect(readShowcase(dir)).rejects.toBeInstanceOf(ProjectFileError);
    await expect(readShowcase(dir)).rejects.toMatchObject({ status: 413 });
  });

  it('readShowcase: <link> na vitrine dá 422 (escapa da CSP)', async () => {
    await fs.writeFile(path.join(dir, 'VITRINE.html'), '<link rel="dns-prefetch" href="https://x.test">', 'utf8');
    await expect(readShowcase(dir)).rejects.toMatchObject({ status: 422 });
  });

  it('unsafeShowcase: link, base e meta http-equiv são inseguros; o resto passa', () => {
    expect(unsafeShowcase('<link rel="preconnect" href="https://x.test">')).toBe(true);
    expect(unsafeShowcase('<LINK rel="stylesheet" href="x.css">')).toBe(true);
    expect(unsafeShowcase('<base href="https://x.test/">')).toBe(true);
    expect(unsafeShowcase('<meta http-equiv="refresh" content="0;url=https://x.test">')).toBe(true);
    expect(unsafeShowcase('<meta charset="utf-8">')).toBe(false);
    expect(unsafeShowcase('<meta name="viewport" content="width=device-width">')).toBe(false);
    expect(unsafeShowcase('<p>linkedin e database</p>')).toBe(false);
    expect(unsafeShowcase('<style>p { color: red; }</style>')).toBe(false);
  });

  it('cria o modelo em pt-BR com o aviso do topo e as seções; depois existe', async () => {
    await createGuide(dir);
    const text = await fs.readFile(path.join(dir, 'SPEC.md'), 'utf8');
    expect(text).toContain('A equipe consulta este arquivo em caso de dúvida');
    expect(text).toContain('`.gitignore`');
    for (const section of ['## Visão', '## Problema que resolve', '## Escopo', '## Fora do escopo', '## Princípios e regras inegociáveis', '## Glossário', '## Decisões', '## Dúvidas em aberto']) {
      expect(text).toContain(section);
    }
    expect(await guideStatus(dir)).toMatchObject({ path: 'SPEC.md', exists: true });
  });

  it('criar de novo dá GuideExistsError e não mexe no que já está escrito', async () => {
    await createGuide(dir);
    await fs.writeFile(path.join(dir, 'SPEC.md'), 'texto meu', 'utf8');
    await expect(createGuide(dir)).rejects.toBeInstanceOf(GuideExistsError);
    expect(await fs.readFile(path.join(dir, 'SPEC.md'), 'utf8')).toBe('texto meu');
  });

  it('dentro de git: isGit true; ignorado só quando o .gitignore lista o SPEC.md', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    await createGuide(dir);
    expect(await guideStatus(dir)).toMatchObject({ isGit: true, ignored: false });
    await fs.writeFile(path.join(dir, '.gitignore'), 'SPEC.md\n', 'utf8');
    expect(await guideStatus(dir)).toMatchObject({ isGit: true, ignored: true });
  });
});
