import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project, StaffProfile } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { setArchived } from '../server/config';
import { staffMayPost } from '../server/apiPolicy';
import { StaffError, StaffService } from '../server/staff/service';
import { fichaFile, memoryFile, readPortrait, readProfile, saveProfile } from '../server/staff/store';

// O config (arquivados) grava em MYCO_HOME: aponta para uma pasta temporária antes de o config.ts carregar.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-copy-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
let origin: string;
let dest: string;
const PNG = Buffer.from('bytes-do-retrato');

const project = (over: Partial<Project>): Project => ({
  id: 'x',
  path: '',
  name: 'x',
  exists: true,
  worktreeOf: null,
  hasClaudeMd: false,
  agentCount: 0,
  skillCount: 0,
  sessionCount: 0,
  lastActivityAt: null,
  ...over,
});

const ana: StaffProfile = {
  id: 'ana-1a2b',
  projectId: 'orig',
  name: 'Ana Souza',
  role: 'Revisora',
  portrait: 'ana-1a2b.png',
  reportsTo: ['chefe-0000'],
  mission: 'Revisar mudanças',
  firstTask: 'Revise o último commit',
  autonomy: 'plan',
  agents: ['Explore'],
  skills: ['lint'],
  mcps: ['docs'],
  knowledge: ['docs/arq.md'],
  rules: ['Não altere arquivos'],
  doneWhen: 'Lista de achados',
  model: 'opus',
  effort: 'high',
  lastModel: 'sonnet',
  lastEffort: 'low',
  canHire: false,
  playbook: null,
  worktree: false,
  servers: ['prod'],
  browser: true,
  routines: [{ id: 'diaria', name: 'Diária', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue', enabled: true }],
  hiredBy: 'chefe-0000',
  temporary: true,
  ended: null,
  sessions: [{ id: '11111111-2222-4333-8444-555555555555', startedAt: '2026-10-01T00:00:00.000Z', cwd: '/x' }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const bia: StaffProfile = { ...ana, id: 'bia-3c4d', projectId: 'orig', name: 'Bia Lima', role: 'Dev', portrait: null, sessions: [], servers: [], reportsTo: [], routines: undefined, hiredBy: undefined, temporary: undefined, ended: undefined, lastModel: undefined, lastEffort: undefined };

const adapter = () =>
  ({
    listProjects: async (): Promise<Project[]> => [
      project({ id: 'orig', path: origin, name: 'Loja (apelido)' }),
      project({ id: 'dest', path: dest, name: 'Blog' }),
      // Pasta que não existe: a leitura falha e o projeto fica de fora sem derrubar a lista.
      project({ id: 'quebrado', path: path.join(root, 'nao-existe'), name: 'Quebrado' }),
      project({ id: 'sumido', path: dest, name: 'Sumido', exists: false }),
    ],
  }) as unknown as ToolAdapter;

const service = () => new StaffService(adapter(), { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, '.claude.json'), mycoUrl: 'x' });

describe('fichas entre projetos', () => {
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-copy-'));
    origin = path.join(root, 'orig');
    dest = path.join(root, 'dest');
    await fs.mkdir(origin, { recursive: true });
    await fs.mkdir(dest, { recursive: true });
    await saveProfile(origin, ana);
    await saveProfile(origin, bia);
    await fs.writeFile(path.join(origin, '.myco', 'staff', 'ana-1a2b.png'), PNG);
    await fs.writeFile(memoryFile(origin, 'ana-1a2b'), 'Nota antiga: usar a convenção X\n');
    await fs.mkdir(path.join(dest, '.myco', 'staff'), { recursive: true });
    await fs.writeFile(path.join(dest, '.myco', 'staff', 'corrompida-0000.json'), '{ isto não é json');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  it('lista as fichas de todos os projetos conhecidos, com só os campos da lista', async () => {
    const { people } = await service().directory();
    expect(people.map((p) => `${p.projectId}/${p.staffId}`).sort()).toEqual(['orig/ana-1a2b', 'orig/bia-3c4d']);
    const a = people.find((p) => p.staffId === 'ana-1a2b')!;
    expect(a).toEqual({
      projectId: 'orig',
      projectName: 'Loja (apelido)',
      staffId: 'ana-1a2b',
      name: 'Ana Souza',
      role: 'Revisora',
      mission: 'Revisar mudanças',
      hasPortrait: true,
      updatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(people.find((p) => p.staffId === 'bia-3c4d')!.hasPortrait).toBe(false);
  });

  it('copia para o destino com id novo, retrato, e zera o que é do projeto de origem', async () => {
    const r = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: false }, true))!;
    const p = r.profile;
    expect(p.id).not.toBe('ana-1a2b');
    expect(p.id).toMatch(/^ana-souza-[0-9a-f]{4}$/);
    expect(p.projectId).toBe('dest');
    expect([p.name, p.role, p.mission, p.rules, p.autonomy, p.model, p.effort, p.agents, p.skills, p.mcps, p.knowledge, p.browser]).toEqual([
      'Ana Souza',
      'Revisora',
      'Revisar mudanças',
      ['Não altere arquivos'],
      'plan',
      'opus',
      'high',
      ['Explore'],
      ['lint'],
      ['docs'],
      ['docs/arq.md'],
      true,
    ]);
    // Zerado (ou ausente): vínculos, servidores, conversas, última escolha do chat, rotinas, situação de temporário, primeira tarefa.
    expect(p.reportsTo).toEqual([]);
    expect(p.servers).toEqual([]);
    expect(p.sessions).toEqual([]);
    expect(p.lastModel).toBeUndefined();
    expect(p.lastEffort).toBeUndefined();
    expect(p.routines).toBeUndefined();
    expect(p.hiredBy).toBeUndefined();
    expect(p.temporary).toBeUndefined();
    expect(p.ended).toBeUndefined();
    expect(p.firstTask).toBe('');
    // Gravado no disco do destino, com o .md gerado.
    expect(await readProfile(dest, p.id)).toEqual(p);
    expect(await fs.readFile(fichaFile(dest, p.id), 'utf8')).toContain('Ana Souza');
    // A origem não muda.
    expect(await readProfile(origin, 'ana-1a2b')).toEqual(ana);
  });

  it('copia o retrato (mesmos bytes) para o destino', async () => {
    const p = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b' }, true))!.profile;
    const img = await readPortrait(dest, p);
    expect(img?.bytes.equals(PNG)).toBe(true);
    expect(img?.type).toBe('image/png');
  });

  it('withMemory false: memória padrão; withMemory true: a de origem com a linha de procedência no topo', async () => {
    const semMemoria = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: false }, true))!.profile;
    const texto = await fs.readFile(memoryFile(dest, semMemoria.id), 'utf8');
    expect(texto.startsWith('# Memória de Ana Souza — Revisora')).toBe(true);
    expect(texto).not.toContain('Nota antiga');

    const comMemoria = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: true }, true))!.profile;
    const copiada = await fs.readFile(memoryFile(dest, comMemoria.id), 'utf8');
    expect(copiada).toMatch(/^Copiada de Loja \(apelido\) em .+\n\nNota antiga: usar a convenção X\n$/);
  });

  it('400 quando a origem é o próprio projeto', async () => {
    await expect(service().copyFrom('dest', { fromProjectId: 'dest', staffId: 'ana-1a2b' }, true)).rejects.toThrow(StaffError);
    await expect(service().copyFrom('dest', { fromProjectId: 'dest', staffId: 'ana-1a2b' }, true)).rejects.toThrow('a origem é este mesmo projeto');
  });

  it('404 (null) quando a origem não existe ou a ficha não está nela', async () => {
    expect(await service().copyFrom('dest', { fromProjectId: 'nao-existe', staffId: 'ana-1a2b' }, true)).toBeNull();
    expect(await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ninguem-0000' }, true)).toBeNull();
    expect(await service().copyFrom('nao-existe', { fromProjectId: 'orig', staffId: 'ana-1a2b' }, true)).toBeNull();
  });

  it('recusa sem o navegador e valida o corpo', async () => {
    await expect(service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b' }, false)).rejects.toThrow('só pelo Claudio’s Club');
    expect(staffMayPost('/api/projects/dest/staff/copy')).toBe(false);
    await expect(service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: 'sim' }, true)).rejects.toThrow(StaffError);
    await expect(service().copyFrom('dest', { fromProjectId: '../etc', staffId: 'ana-1a2b' }, true)).rejects.toThrow('projeto de origem inválido');
    await expect(service().copyFrom('dest', { staffId: 'ana-1a2b' }, true)).rejects.toThrow(StaffError);
  });

  it('reportsTo válido vai para a ficha nova; gestor que não está no destino recusa e não cria nada', async () => {
    const chefe: StaffProfile = { ...bia, id: 'chefe-dest', projectId: 'dest', name: 'Chefe Dest', role: 'Gestora', portrait: null, sessions: [], servers: [], reportsTo: [] };
    await saveProfile(dest, chefe);

    const ok = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'bia-3c4d', reportsTo: ['chefe-dest'] }, true))!.profile;
    expect(ok.reportsTo).toEqual(['chefe-dest']);
    expect(await readProfile(dest, ok.id)).toEqual(ok);

    const antes = await fs.readdir(path.join(dest, '.myco', 'staff'));
    // Id de funcionário que só existe na origem, id inexistente e id fora do limite: todos recusam.
    await expect(service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'bia-3c4d', reportsTo: ['ana-1a2b'] }, true)).rejects.toThrow('gestor não encontrado neste projeto');
    await expect(service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'bia-3c4d', reportsTo: ['nao-existe-0000'] }, true)).rejects.toThrow(StaffError);
    await expect(service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'bia-3c4d', reportsTo: ['x'.repeat(41)] }, true)).rejects.toThrow(StaffError);
    expect(await fs.readdir(path.join(dest, '.myco', 'staff'))).toEqual(antes);
  });

  it('projeto arquivado continua na lista de fichas (arquivar só esconde do quadro)', async () => {
    await setArchived({ kind: 'project', id: 'orig', archived: true });
    try {
      const { people } = await service().directory();
      expect(people.filter((p) => p.projectId === 'orig').map((p) => p.staffId).sort()).toEqual(['ana-1a2b', 'bia-3c4d']);
    } finally {
      await setArchived({ kind: 'project', id: 'orig', archived: false });
    }
  });
});
