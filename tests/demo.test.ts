import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverProjects } from '../server/adapters/claude/projects';
import { createDemo } from '../server/demo';
import { listProjectStaff } from '../server/staff/store';
import type { Task } from '../shared/model';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-demo-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const readTasks = async (dir: string) => JSON.parse(await fs.readFile(path.join(dir, '.myco', 'tasks.json'), 'utf8')) as Task[];

describe('projeto demo', () => {
  it('copia o app e monta a equipe com hierarquia e as tarefas', async () => {
    const dir = path.join(root, 'um', 'cafe-demo');
    const out = await createDemo({ targetDir: dir, git: false });
    expect(out.created).toBe(true);
    expect(await fs.readFile(path.join(dir, 'pedidos.js'), 'utf8')).toContain('calcularTotal');

    // As fichas passam pela mesma validação de quem é contratado pelo MyCo.
    const staff = await listProjectStaff(dir, out.projectId);
    expect(staff.map((s) => s.name)).toEqual(['Lia', 'Caio', 'Bruno', 'Fernanda', 'Duda', 'Taís', 'Rui']);
    const ids = new Set(staff.map((s) => s.id));
    expect(staff.flatMap((s) => s.reportsTo).every((id) => ids.has(id))).toBe(true);
    expect(staff.find((s) => s.name === 'Duda')?.reportsTo).toEqual(['fernanda-demo']);
    expect(staff.filter((s) => !s.reportsTo.length).map((s) => s.role)).toEqual(['Orquestrador(a)']);
    expect(staff.every((s) => !s.browser && !s.servers.length && s.autonomy !== 'bypassPermissions')).toBe(true);

    const tasks = await readTasks(dir);
    expect(tasks.every((t) => t.staffId && ids.has(t.staffId) && t.requestedBy === 'lia-demo')).toBe(true);
    expect(tasks.map((t) => t.status)).toContain('done');
    // Imagens do escritório ficam fora do git do demo.
    expect(await fs.readFile(path.join(dir, '.myco', '.gitignore'), 'utf8')).toContain('staff/*.webp');
  });

  it('criar de novo não sobrescreve o que mudou', async () => {
    const dir = path.join(root, 'dois', 'cafe-demo');
    await createDemo({ targetDir: dir, git: false });
    await fs.writeFile(path.join(dir, 'pedidos.js'), '// editado');
    const again = await createDemo({ targetDir: dir, git: false });
    expect(again.created).toBe(false);
    expect(await fs.readFile(path.join(dir, 'pedidos.js'), 'utf8')).toBe('// editado');
  });

  it('modelo faltando: falha sem deixar demo pela metade', async () => {
    const dir = path.join(root, 'tres', 'cafe-demo');
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await expect(createDemo({ targetDir: dir, templateDir: path.join(root, 'nao-existe'), git: false })).rejects.toThrow();
    expect(await fs.readdir(path.dirname(dir))).toEqual([]);
  });

  it('entra na lista de projetos só depois de criado', async () => {
    const loc = { home: path.join(root, 'claude'), configFile: path.join(root, 'claude.json') };
    const dir = path.join(root, 'quatro', 'cafe-demo');
    const list = () => discoverProjects(loc, { includeTemp: true, extraPaths: [dir] });
    expect(await list()).toEqual([]);
    await createDemo({ targetDir: dir, git: false });
    expect((await list()).map((r) => r.path)).toEqual([path.resolve(dir)]);
  });
});
