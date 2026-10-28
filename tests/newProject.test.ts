import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverProjects } from '../server/adapters/claude/projects';
import { addExtraProject, readExtraProjects } from '../server/config';
import { openProject, parseNewProject, usualParent } from '../server/newProject';
import type { Project } from '../shared/model';

let root: string;
// Fora da pasta temporária de propósito não dá em teste: o "tmp" do teste é outra pasta.
const fakeTmp = path.join(os.tmpdir(), 'myco-nao-e-o-tmp');
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-newproj-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('novo projeto', () => {
  it('recusa nome de pasta que quebra caminho ou não funciona no Windows', () => {
    const base = { mode: 'create', parent: root };
    for (const name of ['..', '../fora', 'a/b', 'a\\b', 'CON', 'nul.txt', 'termina.', 'c:x', '"x"', '']) {
      expect(() => parseNewProject({ ...base, name }), name).toThrow();
    }
    expect(() => parseNewProject({ ...base, name: 'loja', parent: 'relativo' })).toThrow('caminho completo');
    expect(parseNewProject({ ...base, name: 'Loja da Ana' })).toMatchObject({ git: true, workspaceId: null });
  });

  it('cria a pasta (com git), não sobrescreve, e abre uma que já existe', async () => {
    const created = await openProject(parseNewProject({ mode: 'create', parent: root, name: 'loja' }), fakeTmp);
    expect(created).toEqual({ path: path.join(root, 'loja'), created: true });
    expect((await fs.stat(path.join(root, 'loja', '.git'))).isDirectory()).toBe(true);
    await expect(openProject(parseNewProject({ mode: 'create', parent: root, name: 'loja' }), fakeTmp)).rejects.toThrow('já existe');
    await expect(openProject(parseNewProject({ mode: 'create', parent: path.join(root, 'nao-existe'), name: 'x' }), fakeTmp)).rejects.toThrow('não existe');

    expect(await openProject(parseNewProject({ mode: 'existing', path: path.join(root, 'loja') }), fakeTmp)).toEqual({ path: path.join(root, 'loja'), created: false });
    await expect(openProject(parseNewProject({ mode: 'existing', path: path.join(root, 'sumiu') }), fakeTmp)).rejects.toThrow('não encontrada');
    // Na pasta temporária de verdade, o quadro esconderia o projeto.
    await expect(openProject(parseNewProject({ mode: 'existing', path: root }))).rejects.toThrow('temporária');
  });

  it('a pasta entra na lista de projetos pelo config, uma vez só', async () => {
    const file = path.join(root, 'cfg', 'config.json');
    const dir = path.join(root, 'loja');
    await addExtraProject(dir, file);
    await addExtraProject(path.join(dir, '.'), file); // o mesmo caminho escrito de outro jeito
    expect(await readExtraProjects(file)).toEqual([dir]);
    const loc = { home: path.join(root, 'claude'), configFile: path.join(root, 'claude.json') };
    const refs = await discoverProjects(loc, { includeTemp: true, extraPaths: () => readExtraProjects(file) });
    expect(refs.map((r) => r.path)).toEqual([dir]);
  });

  it('pasta sugerida: a mãe da maioria dos projetos', () => {
    const p = (projectPath: string, extra: Partial<Project> = {}) => ({ path: projectPath, exists: true, worktreeOf: null, ...extra }) as Project;
    const list = [p('C:/www/a'), p('C:/www/b'), p('C:/outros/c'), p('C:/sumiu/d', { exists: false }), p('C:/sumiu/e', { exists: false })];
    expect(usualParent(list)).toBe(path.dirname('C:/www/a'));
    expect(usualParent([], 'C:/Users/x')).toBe('C:/Users/x');
  });
});
