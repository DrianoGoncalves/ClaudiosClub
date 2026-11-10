import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGuide, GuideExistsError, guideStatus, hasGuide } from '../server/projectGuide';

describe('guia do projeto (SPEC.md)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-guia-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('sem SPEC.md e fora de git: não existe, não é git, não é ignorado', async () => {
    expect(await guideStatus(dir)).toEqual({ path: 'SPEC.md', exists: false, isGit: false, ignored: false });
    expect(await hasGuide(dir)).toBe(false);
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
