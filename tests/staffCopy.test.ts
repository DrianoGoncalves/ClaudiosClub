import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, StaffProfile, Task } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { readConfig, setArchived } from '../server/config';
import { staffMayPost } from '../server/apiPolicy';
import { TaskService } from '../server/tasks';
import { StaffBusyError, StaffError, StaffOpenTasksError, StaffService, type StaffServiceOptions } from '../server/staff/service';
import { fichaFile, listVersions, memoryDir, memoryFile, profileFile, readPortrait, readProfile, saveProfile, StaffInputSchema } from '../server/staff/store';
import { ALLOCATION_FIELDS, PERSON_FIELDS, PERSON_PORTRAIT, REQUEST_FIELDS } from '../shared/person';

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
      personId: null,
      archived: false,
      reportsTo: ['chefe-0000'],
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
    // A origem não muda, só ganha o personId do grupo (o da cópia).
    expect(await readProfile(origin, 'ana-1a2b')).toEqual({ ...ana, personId: p.personId, sshWrite: [] });
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

  it('withMemory true copia a pasta de detalhe da memória (<id>.memory/); withMemory false não copia', async () => {
    const dirOrigem = memoryDir(origin, 'ana-1a2b');
    await fs.mkdir(dirOrigem, { recursive: true });
    await fs.writeFile(path.join(dirOrigem, 'deploy.md'), 'Passo 1\n');
    try {
      const sem = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: false }, true))!.profile;
      expect(await existe(memoryDir(dest, sem.id))).toBe(false);
      const com = (await service().copyFrom('dest', { fromProjectId: 'orig', staffId: 'ana-1a2b', withMemory: true }, true))!.profile;
      expect(await fs.readFile(path.join(memoryDir(dest, com.id), 'deploy.md'), 'utf8')).toBe('Passo 1\n');
    } finally {
      await fs.rm(dirOrigem, { recursive: true, force: true });
    }
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

// ---- mesma pessoa entre projetos: personId, edição nas cópias, ligar/desligar e apagar ----

const DATA_PNG = (texto: string) => `data:image/png;base64,${Buffer.from(texto).toString('base64')}`;
const existe = (p: string) => fs.access(p).then(() => true, () => false);

const perfil = (over: Partial<StaffProfile> & Pick<StaffProfile, 'id' | 'projectId' | 'name'>): StaffProfile => ({
  role: 'Revisora',
  portrait: null,
  reportsTo: [],
  mission: 'Revisar',
  firstTask: '',
  autonomy: 'plan',
  agents: ['Explore'],
  skills: ['lint'],
  mcps: null,
  knowledge: [],
  rules: ['Regra antiga'],
  doneWhen: 'Achados',
  model: 'opus',
  effort: 'high',
  canHire: false,
  playbook: null,
  worktree: false,
  servers: [],
  browser: true,
  sessions: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  ...over,
});

/** Corpo completo da edição (o que o questionário manda); `over` troca só o que interessa. */
const corpo = (over: Record<string, unknown> = {}) => ({
  name: 'Ana Souza',
  role: 'Revisora',
  reportsTo: [],
  mission: 'Revisar',
  autonomy: 'plan',
  agents: ['Explore'],
  skills: ['lint'],
  mcps: null,
  knowledge: [],
  rules: ['Regra antiga'],
  doneWhen: 'Achados',
  model: 'opus',
  effort: 'high',
  canHire: false,
  playbook: null,
  worktree: false,
  servers: [],
  browser: true,
  ...over,
});

/** Quatro empresas (a, b, c, d) em pastas novas, cada uma com .myco/staff. */
async function mundo() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-pessoa-'));
  const dirs: Record<'a' | 'b' | 'c' | 'd', string> = { a: path.join(base, 'a'), b: path.join(base, 'b'), c: path.join(base, 'c'), d: path.join(base, 'd') };
  for (const dir of Object.values(dirs)) await fs.mkdir(path.join(dir, '.myco', 'staff'), { recursive: true });
  const adapterM = {
    listProjects: async (): Promise<Project[]> => (['a', 'b', 'c', 'd'] as const).map((id) => project({ id, path: dirs[id], name: `Empresa ${id.toUpperCase()}` })),
  } as unknown as ToolAdapter;
  return { base, dirs, adapter: adapterM };
}

type Mundo = Awaited<ReturnType<typeof mundo>>;
const servico = (w: Mundo, over: Partial<Pick<StaffServiceOptions, 'isWorking' | 'tasksOf' | 'releaseTasks'>> = {}) =>
  new StaffService(w.adapter, { runDir: path.join(w.base, 'run'), claudeConfigFile: path.join(w.base, '.claude.json'), mycoUrl: 'x', ...over });

/** Uma tarefa completa (o quadro grava o JSON inteiro; aqui só o que o teste precisa muda). */
const tarefa = (over: Partial<Task> & Pick<Task, 'id' | 'status'>): Task => ({
  title: 'Tarefa',
  description: '',
  staffId: null,
  sessionId: null,
  plan: null,
  branch: null,
  pr: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  history: [],
  ...over,
});

/** O quadro de tarefas do projeto `d` do mundo (o mesmo que o servidor usa, com envio falso). */
const tarefasDe = (w: Mundo) =>
  new TaskService({
    projectPath: async () => w.dirs.d,
    projectIds: async () => ['d'],
    readProfile: async (_p, id) => readProfile(w.dirs.d, id),
    send: async () => 's-novo',
    branchFor: async () => null,
  });

describe('mesma pessoa entre projetos', () => {
  let w: Mundo;
  beforeEach(async () => {
    w = await mundo();
  });
  afterEach(async () => {
    await fs.rm(w.base, { recursive: true, force: true }).catch(() => undefined);
  });

  it('a cópia herda o personId; a origem sem vínculo ganha um (sem versão nova); a cópia da cópia herda', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza' }));
    const svc = servico(w);
    const c1 = (await svc.copyFrom('b', { fromProjectId: 'a', staffId: 'ana-1a2b' }, true))!.profile;
    expect(c1.personId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readProfile(w.dirs.a, 'ana-1a2b'))!.personId).toBe(c1.personId);
    expect(await listVersions(w.dirs.a, 'ana-1a2b')).toEqual([]);
    const c2 = (await svc.copyFrom('c', { fromProjectId: 'b', staffId: c1.id }, true))!.profile;
    expect(c2.personId).toBe(c1.personId);
    const c3 = (await svc.copyFrom('c', { fromProjectId: 'a', staffId: 'ana-1a2b' }, true))!.profile;
    expect(c3.personId).toBe(c1.personId);
    expect(await readProfile(w.dirs.b, c1.id)).toEqual(c1);
  });

  it('lista com personId, arquivado (mesma regra do quadro) e gestores', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana', personId: 'grupo-1', reportsTo: ['chefe-a'] }));
    await saveProfile(w.dirs.a, perfil({ id: 'chefe-a', projectId: 'a', name: 'Chefe' }));
    await setArchived({ kind: 'session', id: 'staff:chefe-a', archived: true });
    try {
      const { people } = await servico(w).directory();
      expect(people.find((p) => p.staffId === 'ana-1a2b')).toMatchObject({ personId: 'grupo-1', archived: false, reportsTo: ['chefe-a'] });
      expect(people.find((p) => p.staffId === 'chefe-a')).toMatchObject({ personId: null, archived: true, reportsTo: [] });
    } finally {
      await setArchived({ kind: 'session', id: 'staff:chefe-a', archived: false });
    }
  });

  it('a edição leva os campos da pessoa e o retrato às cópias, sem pedir (applyToCopies é ignorado); reportsTo, servidores, memória e a outra pessoa ficam', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza', personId: 'grupo-1', reportsTo: ['chefe-a'], servers: ['prod'] }));
    await saveProfile(w.dirs.a, perfil({ id: 'chefe-a', projectId: 'a', name: 'Chefe' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana Souza', personId: 'grupo-1', reportsTo: ['chefe-b'], servers: ['outro'] }));
    await saveProfile(w.dirs.b, perfil({ id: 'chefe-b', projectId: 'b', name: 'Chefe B' }));
    await fs.writeFile(memoryFile(w.dirs.b, 'copia-b'), 'Memória da cópia\n');
    await saveProfile(w.dirs.c, perfil({ id: 'outra-c', projectId: 'c', name: 'Outra', personId: 'outro-grupo' }));
    const svc = servico(w);

    const r = await svc.update('a', 'ana-1a2b', corpo({ name: 'Ana Nova', role: 'Gerente', rules: ['Nova regra'], model: 'sonnet', effort: 'low', playbook: 'review-gate', servers: ['prod', 'x'], reportsTo: ['chefe-a'], applyToCopies: false, portraitDataUrl: DATA_PNG('png-novo') }));
    expect(r!.copiesUpdated).toBe(1);
    const copia = (await readProfile(w.dirs.b, 'copia-b'))!;
    // Roteiro (playbook) propaga; os campos da pessoa iguais na origem seguem iguais.
    expect(copia).toMatchObject({ name: 'Ana Nova', role: 'Gerente', rules: ['Nova regra'], model: 'sonnet', effort: 'low', playbook: 'review-gate', mission: 'Revisar', doneWhen: 'Achados' });
    expect(copia.reportsTo).toEqual(['chefe-b']);
    expect(copia.servers).toEqual(['outro']);
    expect(copia.personId).toBe('grupo-1');
    expect(copia.sessions).toEqual([]);
    expect((await readPortrait(w.dirs.b, copia))?.bytes.toString()).toBe('png-novo');
    expect(await fs.readFile(memoryFile(w.dirs.b, 'copia-b'), 'utf8')).toBe('Memória da cópia\n');
    expect(await listVersions(w.dirs.b, 'copia-b')).toHaveLength(1);
    expect((await readProfile(w.dirs.c, 'outra-c'))!.name).toBe('Outra');

    // Retrato removido na origem: some na cópia (e o arquivo).
    const r2 = await svc.update('a', 'ana-1a2b', corpo({ name: 'Ana Nova', role: 'Gerente', rules: ['Nova regra'], model: 'sonnet', effort: 'low', playbook: 'review-gate', reportsTo: ['chefe-a'], portraitDataUrl: null }));
    expect(r2!.copiesUpdated).toBe(1);
    expect((await readProfile(w.dirs.b, 'copia-b'))!.portrait).toBeNull();
    expect(await existe(path.join(w.dirs.b, '.myco', 'staff', 'copia-b.png'))).toBe(false);

    // Nada da pessoa mudou (só o gestor): a cópia não ganha versão nova nem conta.
    const r3 = await svc.update('a', 'ana-1a2b', corpo({ name: 'Ana Nova', role: 'Gerente', rules: ['Nova regra'], model: 'sonnet', effort: 'low', playbook: 'review-gate', reportsTo: [] }));
    expect(r3!.copiesUpdated).toBe(0);
    expect((await readProfile(w.dirs.b, 'copia-b'))!.name).toBe('Ana Nova');
    expect(await listVersions(w.dirs.b, 'copia-b')).toHaveLength(2);

    await expect(svc.update('a', 'ana-1a2b', corpo({ reportsTo: ['chefe-a'], applyToCopies: 'sim' }))).rejects.toThrow('applyToCopies tem que ser true ou false');
  });

  it('o estilo de comunicação vai com a pessoa: a cópia leva, a edição propaga e null tira nas cópias também', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza', personality: 'tiozao' }));
    const svc = servico(w);
    const c = (await svc.copyFrom('b', { fromProjectId: 'a', staffId: 'ana-1a2b' }, true))!.profile;
    expect(c.personality).toBe('tiozao');
    await svc.update('a', 'ana-1a2b', corpo({ personality: 'caveman' }));
    expect((await readProfile(w.dirs.b, c.id))!.personality).toBe('caveman');
    await svc.update('a', 'ana-1a2b', corpo({ personality: null }));
    expect((await readProfile(w.dirs.b, c.id))!.personality).toBeNull();
  });

  it('agents e skills (da alocação) não vão às cópias; a própria ficha muda', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza', personId: 'grupo-1' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana Souza', personId: 'grupo-1' }));
    const r = await servico(w).update('a', 'ana-1a2b', corpo({ agents: ['Plan', 'Explore'], skills: ['deploy'] }));
    expect(r!.copiesUpdated).toBe(0);
    expect(r!.agents).toEqual(['Plan', 'Explore']);
    expect(r!.skills).toEqual(['deploy']);
    const copia = (await readProfile(w.dirs.b, 'copia-b'))!;
    expect(copia.agents).toEqual(['Explore']);
    expect(copia.skills).toEqual(['lint']);
    expect(await listVersions(w.dirs.b, 'copia-b')).toEqual([]);
  });

  it('restaurar uma versão leva os campos da pessoa restaurados às cópias, e o vínculo da ficha fica', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza', personId: 'grupo-1' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana Souza', personId: 'grupo-1' }));
    const svc = servico(w);
    await svc.update('a', 'ana-1a2b', corpo({ name: 'Ana Nova', rules: ['Regra nova'] }));
    expect((await readProfile(w.dirs.b, 'copia-b'))!.name).toBe('Ana Nova');

    const [anterior] = await listVersions(w.dirs.a, 'ana-1a2b');
    const volta = await svc.restore('a', 'ana-1a2b', anterior!.version);
    expect(volta).toMatchObject({ name: 'Ana Souza', rules: ['Regra antiga'], personId: 'grupo-1' });
    expect(await readProfile(w.dirs.b, 'copia-b')).toMatchObject({ name: 'Ana Souza', rules: ['Regra antiga'] });
    expect((await readProfile(w.dirs.a, 'ana-1a2b'))!.personId).toBe('grupo-1');
  });

  it('falha numa cópia não para as outras e não entra na conta', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana Souza', personId: 'grupo-1' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana Souza', personId: 'grupo-1' }));
    await saveProfile(w.dirs.c, perfil({ id: 'copia-c', projectId: 'c', name: 'Ana Souza', personId: 'grupo-1' }));
    // Histórico da cópia em c travado (um arquivo no lugar da pasta): a versão anterior não grava e essa cópia falha.
    await fs.writeFile(path.join(w.dirs.c, '.myco', 'staff', 'copia-c.history'), 'não é pasta');
    const r = await servico(w).update('a', 'ana-1a2b', corpo({ name: 'Ana Nova' }));
    expect(r!.copiesUpdated).toBe(1);
    expect((await readProfile(w.dirs.b, 'copia-b'))!.name).toBe('Ana Nova');
    expect((await readProfile(w.dirs.c, 'copia-c'))!.name).toBe('Ana Souza');
  });

  it('ligar: a mesma ficha é 400; sem navegador recusa; ficha inexistente é 404 (null)', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana' }));
    const svc = servico(w);
    await expect(svc.link({ from: { projectId: 'a', staffId: 'ana-1a2b' }, to: { projectId: 'a', staffId: 'ana-1a2b' } }, true)).rejects.toThrow('é a mesma ficha');
    await expect(svc.link({ from: { projectId: 'a', staffId: 'ana-1a2b' }, to: { projectId: 'b', staffId: 'x' } }, false)).rejects.toThrow('só pelo Claudio’s Club');
    expect(await svc.link({ from: { projectId: 'a', staffId: 'ana-1a2b' }, to: { projectId: 'b', staffId: 'ninguem' } }, true)).toBeNull();
  });

  it('ligar duas fichas sem vínculo cria um grupo novo; quem já tem grupo passa o seu', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana' }));
    await saveProfile(w.dirs.c, perfil({ id: 'x-c', projectId: 'c', name: 'X' }));
    const svc = servico(w);
    const { personId } = (await svc.link({ from: { projectId: 'a', staffId: 'ana-1a2b' }, to: { projectId: 'b', staffId: 'copia-b' } }, true))!;
    expect(personId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await readProfile(w.dirs.a, 'ana-1a2b'))!.personId).toBe(personId);
    expect((await readProfile(w.dirs.b, 'copia-b'))!.personId).toBe(personId);
    // Destino sem vínculo, origem no grupo: o id do grupo da origem vale.
    const r2 = await svc.link({ from: { projectId: 'a', staffId: 'ana-1a2b' }, to: { projectId: 'c', staffId: 'x-c' } }, true);
    expect(r2!.personId).toBe(personId);
    expect((await readProfile(w.dirs.c, 'x-c'))!.personId).toBe(personId);
  });

  it('fundir grupos: o grupo de origem inteiro migra para o do destino', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana', personId: 'grupo-2' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana', personId: 'grupo-1' }));
    await saveProfile(w.dirs.c, perfil({ id: 'x-c', projectId: 'c', name: 'X', personId: 'grupo-2' }));
    await saveProfile(w.dirs.c, perfil({ id: 'y-c', projectId: 'c', name: 'Y', personId: 'grupo-2' }));
    await saveProfile(w.dirs.d, perfil({ id: 'z-d', projectId: 'd', name: 'Z' }));
    const svc = servico(w);
    // Origem em grupo-2 (X), destino em grupo-1: o grupo-2 inteiro passa para grupo-1.
    const r = await svc.link({ from: { projectId: 'c', staffId: 'x-c' }, to: { projectId: 'b', staffId: 'copia-b' } }, true);
    expect(r!.personId).toBe('grupo-1');
    for (const [dir, id] of [[w.dirs.a, 'ana-1a2b'], [w.dirs.b, 'copia-b'], [w.dirs.c, 'x-c'], [w.dirs.c, 'y-c']] as const) {
      expect((await readProfile(dir, id))!.personId).toBe('grupo-1');
    }
    // Quem não tinha grupo, e a origem sem vínculo: o grupo do destino.
    await svc.link({ from: { projectId: 'd', staffId: 'z-d' }, to: { projectId: 'a', staffId: 'ana-1a2b' } }, true);
    expect((await readProfile(w.dirs.d, 'z-d'))!.personId).toBe('grupo-1');
  });

  it('desligar tira o vínculo só dessa ficha (some do JSON); as outras continuam', async () => {
    await saveProfile(w.dirs.a, perfil({ id: 'ana-1a2b', projectId: 'a', name: 'Ana', personId: 'grupo-1' }));
    await saveProfile(w.dirs.b, perfil({ id: 'copia-b', projectId: 'b', name: 'Ana', personId: 'grupo-1' }));
    const svc = servico(w);
    expect(await svc.unlink({ projectId: 'b', staffId: 'copia-b' }, true)).toEqual({ ok: true });
    expect(JSON.parse(await fs.readFile(profileFile(w.dirs.b, 'copia-b'), 'utf8')).personId).toBeUndefined();
    expect((await readProfile(w.dirs.a, 'ana-1a2b'))!.personId).toBe('grupo-1');
    expect(await svc.unlink({ projectId: 'b', staffId: 'ninguem' }, true)).toBeNull();
    await expect(svc.unlink({ projectId: 'b', staffId: 'copia-b' }, false)).rejects.toThrow('só pelo Claudio’s Club');
  });

  it('apagar: arquivos somem, quem reportava a ela perde o gestor (orphaned), o arquivado sai do config', async () => {
    const st = path.join(w.dirs.d, '.myco', 'staff');
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe', portrait: 'boss.png' }));
    await saveProfile(w.dirs.d, perfil({ id: 'sub1', projectId: 'd', name: 'Sub 1', reportsTo: ['boss'] }));
    await saveProfile(w.dirs.d, perfil({ id: 'sub2', projectId: 'd', name: 'Sub 2', reportsTo: ['boss', 'other'] }));
    await saveProfile(w.dirs.d, perfil({ id: 'other', projectId: 'd', name: 'Outro' }));
    await fs.writeFile(path.join(st, 'boss.png'), 'png-boss');
    await fs.writeFile(memoryFile(w.dirs.d, 'boss'), 'memória do chefe\n');
    await fs.mkdir(path.join(st, 'boss.history'));
    await fs.writeFile(path.join(st, 'boss.history', '2026-10-01T00-00-00-000Z.json'), '{}');
    await setArchived({ kind: 'session', id: 'staff:boss', archived: true });

    const svc = servico(w);
    expect(await svc.deleteStaff('d', 'boss', true)).toEqual({ ok: true, orphaned: ['sub1'] });
    for (const f of ['boss.json', 'boss.md', 'boss.memory.md', 'boss.png', 'boss.history']) expect(await existe(path.join(st, f))).toBe(false);
    expect((await readProfile(w.dirs.d, 'sub1'))!.reportsTo).toEqual([]);
    expect((await readProfile(w.dirs.d, 'sub2'))!.reportsTo).toEqual(['other']);
    expect(await listVersions(w.dirs.d, 'sub1')).toHaveLength(1);
    expect((await readConfig()).archived.sessions).not.toContain('staff:boss');
    expect(await svc.deleteStaff('d', 'boss', true)).toBeNull();
  });

  it('apagar leva a pasta de detalhe da memória (<id>.memory/) com o que tiver dentro', async () => {
    const st = path.join(w.dirs.d, '.myco', 'staff');
    await saveProfile(w.dirs.d, perfil({ id: 'detalhe', projectId: 'd', name: 'Detalhe' }));
    await fs.mkdir(memoryDir(w.dirs.d, 'detalhe'), { recursive: true });
    await fs.writeFile(path.join(memoryDir(w.dirs.d, 'detalhe'), 'deploy.md'), 'Passo 1\n');
    expect(await servico(w).deleteStaff('d', 'detalhe', true)).toEqual({ ok: true, orphaned: [] });
    for (const f of ['detalhe.json', 'detalhe.memory', path.join('detalhe.memory', 'deploy.md')]) expect(await existe(path.join(st, f))).toBe(false);
  });

  it('apagar recusa (409) se a conversa dela está trabalhando, e recusa sem navegador', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    await expect(servico(w, { isWorking: (p, id) => p === 'd' && id === 'boss' }).deleteStaff('d', 'boss', true)).rejects.toThrow(StaffBusyError);
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(true);
    await expect(servico(w).deleteStaff('d', 'boss', false)).rejects.toThrow('só pelo Claudio’s Club');
  });

  it('apagar recusa (409) com tarefa aberta da ficha (executora ou revisora); com só tarefas prontas, apaga', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    await saveProfile(w.dirs.d, perfil({ id: 'outra', projectId: 'd', name: 'Outra' }));
    const abertas = servico(w, {
      tasksOf: async () => [
        { staffId: 'boss', reviewerId: null, status: 'doing' },
        { staffId: 'outra', reviewerId: 'boss', status: 'review' },
        { staffId: 'boss', reviewerId: null, status: 'done' },
      ],
    });
    await expect(abertas.deleteStaff('d', 'boss', true)).rejects.toThrow(StaffBusyError);
    await expect(abertas.deleteStaff('d', 'boss', true)).rejects.toThrow('Chefe tem 2 tarefa(s) aberta(s) no quadro');
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(true);

    const prontas = servico(w, {
      tasksOf: async () => [
        { staffId: 'boss', reviewerId: null, status: 'done' },
        { staffId: 'boss', reviewerId: 'outra', status: 'done' },
        { staffId: 'outra', reviewerId: null, status: 'todo' },
      ],
    });
    expect(await prontas.deleteStaff('d', 'boss', true)).toEqual({ ok: true, orphaned: [] });
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(false);
  });

  it('apagar com tarefa aberta sem force: 409 com code open-tasks e openTasks (só as abertas); sem corpo ou force false, igual', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    const release = vi.fn(async () => 0);
    const svc = servico(w, {
      tasksOf: async () => [
        { staffId: 'boss', reviewerId: null, status: 'doing' },
        { staffId: 'outra', reviewerId: 'boss', status: 'review' },
        { staffId: 'boss', reviewerId: null, status: 'done' },
      ],
      releaseTasks: release,
    });
    const corpos: unknown[] = [undefined, {}, { force: false }];
    for (const corpo of corpos) {
      const err = await svc.deleteStaff('d', 'boss', true, corpo).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StaffOpenTasksError);
      expect(err).toBeInstanceOf(StaffBusyError);
      expect((err as StaffOpenTasksError).code).toBe('open-tasks');
      expect((err as StaffOpenTasksError).openTasks).toBe(2);
      expect((err as StaffOpenTasksError).message).toContain('Chefe tem 2 tarefa(s) aberta(s) no quadro');
    }
    expect(release).not.toHaveBeenCalled();
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(true);
  });

  it('apagar com force: as tarefas abertas ficam sem responsável, fora da fila, a fazer, sem revisor; history; as concluídas não mudam', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    await saveProfile(w.dirs.d, perfil({ id: 'outra', projectId: 'd', name: 'Outra' }));
    await fs.writeFile(
      path.join(w.dirs.d, '.myco', 'tasks.json'),
      JSON.stringify([
        tarefa({ id: 't-fazendo', title: 'Fazendo', status: 'doing', staffId: 'boss', sessionId: 's-1', reviewerId: 'outra' }),
        tarefa({ id: 't-planejando', title: 'Planejando', status: 'planning', staffId: 'boss', sessionId: 's-2' }),
        tarefa({ id: 't-fila', title: 'Na fila', status: 'todo', staffId: 'boss', queuedAt: '2026-10-03T00:00:00.000Z', queuedForce: true }),
        tarefa({ id: 't-revisor', title: 'Revisada pela Outra', status: 'todo', staffId: 'outra', reviewerId: 'boss' }),
        tarefa({ id: 't-pronta', title: 'Pronta', status: 'done', staffId: 'boss' }),
      ]),
    );
    const tasksSvc = tarefasDe(w);
    const svc = servico(w, { tasksOf: async (p) => (await tasksSvc.list(p)) ?? [], releaseTasks: (p, s) => tasksSvc.releaseStaff(p, s) });

    await expect(svc.deleteStaff('d', 'boss', true)).rejects.toMatchObject({ code: 'open-tasks', openTasks: 4 });
    expect(await svc.deleteStaff('d', 'boss', true, { force: true })).toEqual({ ok: true, orphaned: [] });
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(false);

    const por = Object.fromEntries((await tasksSvc.list('d'))!.map((t) => [t.id, t]));
    expect(por['t-fazendo']).toMatchObject({ status: 'todo', staffId: null, reviewerId: 'outra', sessionId: null, queuedAt: null, queuedForce: false });
    expect(por['t-fazendo']!.history.at(-1)).toMatchObject({ status: 'todo', by: 'auto', note: 'responsável excluído' });
    expect(por['t-planejando']).toMatchObject({ status: 'todo', staffId: null });
    expect(por['t-planejando']!.history.at(-1)).toMatchObject({ status: 'todo', note: 'responsável excluído' });
    expect(por['t-fila']).toMatchObject({ status: 'todo', staffId: null, queuedAt: null, queuedForce: false });
    expect(por['t-revisor']).toMatchObject({ status: 'todo', staffId: 'outra', reviewerId: null });
    expect(por['t-revisor']!.history.at(-1)).toMatchObject({ note: 'revisor excluído' });
    expect(por['t-pronta']).toMatchObject({ status: 'done', staffId: 'boss' });
    expect(por['t-pronta']!.history).toEqual([]);
  });

  it('tarefa solta reatribuída pode ser começada do zero: sem conversa, plano nem mensagens guardadas da pessoa que saiu; revisão mantém a conversa', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    await saveProfile(w.dirs.d, perfil({ id: 'outra', projectId: 'd', name: 'Outra' }));
    const guardada = { id: 'm1', at: '2026-10-03T00:00:00.000Z', text: 'ajuste para a conversa antiga', reason: 'espera Chefe terminar a conversa em que está' };
    await fs.writeFile(
      path.join(w.dirs.d, '.myco', 'tasks.json'),
      JSON.stringify([
        tarefa({ id: 't-plano', title: 'Com plano', status: 'doing', staffId: 'boss', sessionId: 's-velha', plan: 'plano antigo', held: [guardada] }),
        tarefa({ id: 't-a-fazer', title: 'A fazer', status: 'todo', staffId: 'boss', sessionId: 's-velha-2' }),
        tarefa({ id: 't-revisao', title: 'Em revisão', status: 'review', staffId: 'boss', sessionId: 's-rev' }),
      ]),
    );
    const tasksSvc = tarefasDe(w);
    expect(await tasksSvc.releaseStaff('d', 'boss')).toBe(3);

    const por = Object.fromEntries((await tasksSvc.list('d'))!.map((t) => [t.id, t]));
    expect(por['t-plano']).toMatchObject({ status: 'todo', staffId: null, sessionId: null, plan: null, held: [] });
    expect(por['t-a-fazer']).toMatchObject({ status: 'todo', staffId: null, sessionId: null });
    expect(por['t-revisao']).toMatchObject({ status: 'review', staffId: null, sessionId: 's-rev' });

    // Reatribuída a outra pessoa: começa do zero (antes, "a tarefa já começou" barrava).
    await tasksSvc.update('d', 't-plano', { staffId: 'outra' });
    expect(await tasksSvc.start('d', 't-plano')).toMatchObject({ staffId: 'outra', sessionId: 's-novo', status: 'planning' });
  });

  it('tarefa sem responsável: tick não lança nem começa nada, e o resumo e o quadro leem normal', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'outra', projectId: 'd', name: 'Outra' }));
    await fs.writeFile(
      path.join(w.dirs.d, '.myco', 'tasks.json'),
      JSON.stringify([
        tarefa({ id: 't-orfa', title: 'Em andamento sem dono', status: 'doing', staffId: null, sessionId: 's-orfa' }),
        tarefa({ id: 't-solta', title: 'Sem dono, a fazer', status: 'todo', staffId: null }),
      ]),
    );
    const enviados: string[] = [];
    const tasksSvc = new TaskService({
      projectPath: async () => w.dirs.d,
      projectIds: async () => ['d'],
      readProfile: async (_p, id) => readProfile(w.dirs.d, id),
      send: async (_p, _s, text) => (enviados.push(text), 's-novo'),
      sendTo: async (_p, _s, _st, text) => (enviados.push(text), 's-orfa'),
      branchFor: async () => null,
      isWorking: () => false,
    });
    const agora = new Date(Date.now() + 3_600_000);
    await expect(tasksSvc.tick(agora)).resolves.toBeUndefined();
    expect(await tasksSvc.summary()).toEqual({ d: { open: 2, review: 0 } });
    expect(enviados).toEqual([]);
    const tasks = (await tasksSvc.list('d'))!;
    expect(tasks.map((t) => [t.id, t.status, t.staffId, t.sessionId])).toEqual([
      ['t-orfa', 'doing', null, 's-orfa'],
      ['t-solta', 'todo', null, null],
    ]);
  });

  it('conversa trabalhando + force: continua 409 (sem code), não solta tarefa e não apaga', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    const release = vi.fn(async () => 0);
    const svc = servico(w, {
      isWorking: (p, id) => p === 'd' && id === 'boss',
      tasksOf: async () => [{ staffId: 'boss', reviewerId: null, status: 'doing' }],
      releaseTasks: release,
    });
    const err = await svc.deleteStaff('d', 'boss', true, { force: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffBusyError);
    expect(err).not.toBeInstanceOf(StaffOpenTasksError);
    expect((err as { code?: string }).code).toBeUndefined();
    expect(release).not.toHaveBeenCalled();
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(true);
  });

  it('corpo inválido (force não booleano) recusa com 400 (StaffError) e não apaga', async () => {
    await saveProfile(w.dirs.d, perfil({ id: 'boss', projectId: 'd', name: 'Chefe' }));
    await expect(servico(w).deleteStaff('d', 'boss', true, { force: 'sim' })).rejects.toThrow(StaffError);
    expect(await existe(profileFile(w.dirs.d, 'boss'))).toBe(true);
  });

  it('o que é da pessoa e o que é do projeto: cada campo do pedido em exatamente uma lista', () => {
    const listas = [...PERSON_FIELDS, PERSON_PORTRAIT, ...ALLOCATION_FIELDS, ...REQUEST_FIELDS];
    expect(new Set(listas).size).toBe(listas.length);
    // `mcpPolicy` e `mcpWrite` são só da entrada da tela antiga: viram `mcpAccess` (ver mcpAccessOfInput) e não são campo da pessoa nem do projeto.
    const legados = ['mcpPolicy', 'mcpWrite'];
    expect([...listas].sort()).toEqual(Object.keys(StaffInputSchema.shape).filter((k) => !legados.includes(k)).sort());
  });

  it('as rotas novas não entram na lista de funcionário (só navegador)', () => {
    for (const p of ['/api/staff-link', '/api/staff-unlink', '/api/projects/d/staff/boss/delete']) expect(staffMayPost(p)).toBe(false);
  });
});
