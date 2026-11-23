import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertStaffSkills, migrateLibraryToGlobal } from '../server/skillMigration';
import type { StaffProfile } from '../shared/model';
import { removeTemp } from './support/tmp';

// MYCO_HOME de teste (o módulo de skills lê a config ao carregar): nada vai para o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-skill-migration-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skill-migration-'));
});
afterAll(() => removeTemp(root, home));

const pasta = async (dir: string, body: string) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), body);
};

describe('biblioteca → Global', () => {
  it('move sem sobrescrever, reporta o conflito e não mexe no que já está na Global; a segunda execução não faz nada', async () => {
    const lib = path.join(root, 'm1', 'biblioteca');
    const global = path.join(root, 'm1', 'global');
    const record = path.join(root, 'm1', 'skills-migracao.json');
    await pasta(path.join(lib, 'vps'), '---\nname: vps\ndescription: VPS\n---\n\nDo Club.\n');
    await pasta(path.join(lib, 'acessibilidade'), '---\nname: acessibilidade\ndescription: a11y\n---\n\nA11y.\n');
    await fs.mkdir(path.join(lib, '.lixeira', 'velha'), { recursive: true });
    // Já existe na Global, com conteúdo próprio: não pode ser trocado.
    await pasta(path.join(global, 'vps'), '---\nname: vps\ndescription: da conta\n---\n\nDa conta.\n');

    const r = await migrateLibraryToGlobal({ libraryDir: lib, globalDir: global, recordFile: record });
    expect(r).toEqual({ moved: ['acessibilidade'], conflicts: ['vps (já existe na Global)'] });
    expect(await fs.readFile(path.join(global, 'acessibilidade', 'SKILL.md'), 'utf8')).toContain('A11y.');
    await expect(fs.stat(path.join(lib, 'acessibilidade'))).rejects.toThrow();
    // O conflito fica na biblioteca e o da Global fica como estava.
    expect(await fs.readFile(path.join(lib, 'vps', 'SKILL.md'), 'utf8')).toContain('Do Club.');
    expect(await fs.readFile(path.join(global, 'vps', 'SKILL.md'), 'utf8')).toContain('Da conta.');
    expect(JSON.parse(await fs.readFile(record, 'utf8'))).toEqual({ moved: ['acessibilidade'], conflicts: ['vps (já existe na Global)'] });

    // Segunda execução: nada se move, mesmo com pasta nova na biblioteca (a migração já foi feita).
    await pasta(path.join(lib, 'nova'), '---\nname: nova\ndescription: n\n---\n\nN.\n');
    expect(await migrateLibraryToGlobal({ libraryDir: lib, globalDir: global, recordFile: record })).toBeNull();
    await expect(fs.stat(path.join(global, 'nova'))).rejects.toThrow();
  });

  it('sem biblioteca, grava o relatório vazio; link na biblioteca fica e vai para o conflito', async () => {
    const lib = path.join(root, 'm2', 'biblioteca');
    const global = path.join(root, 'm2', 'global');
    const record = path.join(root, 'm2', 'skills-migracao.json');
    await fs.mkdir(lib, { recursive: true });
    const alvo = path.join(root, 'm2', 'alvo');
    await pasta(alvo, '---\nname: linkada\ndescription: l\n---\n\nL.\n');
    let linked = true;
    await fs.symlink(alvo, path.join(lib, 'linkada'), 'junction').catch(() => {
      linked = false;
    });
    const r = await migrateLibraryToGlobal({ libraryDir: lib, globalDir: global, recordFile: record });
    if (linked) expect(r).toEqual({ moved: [], conflicts: ['linkada (é um link: não movido)'] });
    else expect(r).toEqual({ moved: [], conflicts: [] });
    // O alvo do link continua onde está.
    expect(await fs.readFile(path.join(alvo, 'SKILL.md'), 'utf8')).toContain('L.');
  });
});

describe('fichas antigas: nome sem escopo vira ref', () => {
  const base = { id: 'ana-1', projectId: 'p', name: 'Ana', role: 'Dev', mission: 'm', firstTask: '', reportsTo: [], skills: [], agents: [] } as unknown as StaffProfile;

  it('1 nome → 1 ref, global antes de projeto, sem ganhar skill; regrava só a que mudou', async () => {
    const saved: Array<{ path: string; p: StaffProfile }> = [];
    const r = await convertStaffSkills({
      projects: [{ id: 'p', path: '/proj' }],
      known: async () => ({ globalNames: ['vps', 'ambos'], projectNames: ['local', 'ambos'] }),
      list: async () => [
        { ...base, id: 'a', skills: ['vps', 'local', 'ambos'] },
        { ...base, id: 'b', skills: ['global:vps'] },
        { ...base, id: 'c', skills: ['sumiu'] },
      ],
      save: async (p, prof) => {
        saved.push({ path: p, p: prof });
      },
    });
    expect(r.changed).toEqual([
      { projectId: 'p', staffId: 'a' },
      { projectId: 'p', staffId: 'c' },
    ]);
    expect(saved.map((s) => s.p.skills)).toEqual([['global:vps', 'project:local', 'global:ambos'], ['global:sumiu']]);
    expect(saved.every((s) => s.path === '/proj')).toBe(true);
  });

  it('projeto que não dá para ler fica de fora e é reportado (não derruba os outros)', async () => {
    const r = await convertStaffSkills({
      projects: [
        { id: 'ruim', path: '/ruim' },
        { id: 'bom', path: '/bom' },
      ],
      known: async (p) => {
        if (p.id === 'ruim') throw new Error('sem acesso');
        return { globalNames: [], projectNames: [] };
      },
      list: async () => [{ ...base, skills: ['x'] }],
      save: async () => undefined,
    });
    expect(r.skipped).toEqual(['ruim']);
    expect(r.changed).toEqual([{ projectId: 'bom', staffId: 'ana-1' }]);
  });
});
