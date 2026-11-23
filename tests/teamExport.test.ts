import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { StaffError, StaffService } from '../server/staff/service';
import { createProfile, listProjectStaff, saveProfile, StaffInputSchema } from '../server/staff/store';
import { buildTeamExport, planTeamImport, safeSkillPath, type TeamFile } from '../server/staff/teamExport';
import { removeTemp } from './support/tmp';

// A biblioteca de skills e o config ficam em MYCO_HOME: aponta para uma pasta temporária antes de os módulos carregarem.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-team-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

// Campos que o arquivo leva por ficha (allowlist de server/staff/teamExport.ts).
const ALLOWED = ['ref', 'name', 'role', 'mission', 'rules', 'doneWhen', 'autonomy', 'engine', 'model', 'effort', 'personality', 'playbook', 'worktree', 'agents', 'skills', 'mcps', 'mcpAccess', 'reportsTo', 'routines'];
const SKILL_MD = '---\nname: revisar-a11y\ndescription: Use para revisar acessibilidade\n---\n\n1. Contraste\n2. Foco\n';
const MARCA = 'marca-interna-9x7';
const KEY = 'sk-ant-api03-q8Zr2LpX9vBn4TkW7mYc5sHd1FgJ'; //teste

let root: string;
let origin: string;
let dest: string;
/** A pasta das skills Globais de teste (`~/.claude/skills` de verdade fica fora dos testes). */
let GLOBAL: string;
let chefeId: string;
let anaId: string;
const originIds = () => [chefeId, anaId];

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

const adapter = () =>
  ({
    listProjects: async (): Promise<Project[]> => [project({ id: 'orig', path: origin, name: 'Loja' }), project({ id: 'dest', path: dest, name: 'Blog' })],
    getUserScope: async () => ({ agents: [], skills: [{ name: 'revisar-a11y', dirPath: path.join(GLOBAL, 'revisar-a11y') }] }),
    getProjectInventory: async () => ({ agents: [], skills: [] }),
  }) as unknown as ToolAdapter;

const service = () => new StaffService(adapter(), { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, '.claude.json'), mycoUrl: 'x', globalSkillsDir: GLOBAL });

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-team-'));
  origin = path.join(root, 'origem');
  dest = path.join(root, 'destino');
  await fs.mkdir(origin, { recursive: true });
  await fs.mkdir(dest, { recursive: true });
  // O destino tem o MCP "docs" (o "sumido" não existe lá e sai com aviso).
  await fs.writeFile(path.join(dest, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'node', args: ['docs.js'] } } }));
  // Skill Global que a Ana usa, com um arquivo em subpasta.
  GLOBAL = path.join(root, 'global');
  await fs.mkdir(path.join(GLOBAL, 'revisar-a11y', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(GLOBAL, 'revisar-a11y', 'SKILL.md'), SKILL_MD);
  await fs.writeFile(path.join(GLOBAL, 'revisar-a11y', 'scripts', 'checar.sh'), 'echo ok\n');

  const chefe = await createProfile(origin, 'orig', StaffInputSchema.parse({ name: 'Lia Chefe', role: 'Gestora', mission: 'Coordenar a equipe' }), new Date('2026-10-01T00:00:00Z'));
  const ana = await createProfile(
    origin,
    'orig',
    StaffInputSchema.parse({
      name: 'Ana Souza',
      role: 'Revisora',
      mission: 'Revisar mudanças',
      rules: ['Não altere arquivos'],
      doneWhen: 'Lista de achados',
      autonomy: 'plan',
      agents: ['Explore'],
      skills: ['revisar-a11y'],
      mcps: ['docs', 'sumido'],
      mcpAccess: { docs: 'ask', github: 'off' },
      model: 'opus',
      effort: 'high',
      personality: 'professor',
      playbook: 'review-gate',
      reportsTo: [chefe.id],
    }),
    new Date('2026-10-02T00:00:00Z'),
  );
  chefeId = chefe.id;
  anaId = ana.id;
  // Campos do projeto e da máquina, que não podem sair no arquivo.
  await saveProfile(origin, {
    ...ana,
    personId: 'pessoa-1',
    servers: ['srv-marca-9x7'],
    sshWrite: ['srv-marca-9x7'],
    knowledge: ['conhecimento-marca.md'],
    firstTask: `Tarefa ${MARCA}`,
    hiredBy: chefe.id,
    temporary: true,
    canHire: true,
    browser: true,
    lastModel: 'sonnet',
    lastEffort: 'low',
    portrait: 'ana.png',
    sessions: [{ id: '11111111-2222-4333-8444-555555555555', startedAt: '2026-10-01T00:00:00.000Z', cwd: `/x/${MARCA}` }],
    routines: [{ id: 'diaria', name: 'Diária', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue', enabled: true }],
  });
  // Encerrada: não entra na exportação sem ids.
  const velho = await createProfile(origin, 'orig', StaffInputSchema.parse({ name: 'Velho Encerrado', role: 'Dev', mission: 'Fazer X' }), new Date('2026-09-01T00:00:00Z'));
  await saveProfile(origin, { ...velho, ended: { at: '2026-10-05T00:00:00.000Z', reason: 'fim' } });
});

afterAll(() => removeTemp(root, home));

describe('equipe em arquivo (exportar e importar)', () => {
  it('exporta só a allowlist, sem id, conversa, servidor, conhecimento, memória ou vínculo de cofre', async () => {
    const file = await service().exportTeam('orig', null);
    const json = JSON.stringify(file);
    // Sem ids: as ativas (a encerrada fica de fora).
    expect(file!.staff.map((s) => s.name)).toEqual(['Lia Chefe', 'Ana Souza']);
    for (const s of file!.staff) {
      // `mcpAccess` só sai quando a ficha tem acesso aos MCPs.
      expect(Object.keys(s).sort()).toEqual(ALLOWED.filter((k) => k !== 'mcpAccess' || 'mcpAccess' in s).sort());
      for (const r of s.routines) expect(Object.keys(r).sort()).toEqual(['id', 'message', 'mode', 'name', 'schedule']);
    }
    for (const bad of [...originIds(), 'pessoa-1', 'srv-marca-9x7', 'conhecimento-marca.md', MARCA, '11111111-2222-4333-8444-555555555555', 'sonnet', 'Velho', 'ana.png', 'hiredBy', 'clubSecretId', 'ftpSecretId']) {
      expect(json).not.toContain(bad);
    }
  });

  it('ida e volta: campos permitidos voltam, com ids novos, rotinas desligadas e a skill da biblioteca', async () => {
    const file = await service().exportTeam('orig', null);
    // Sem a skill Global (depois de exportar), a importação a grava de novo, com a subpasta.
    await fs.rm(path.join(GLOBAL, 'revisar-a11y'), { recursive: true, force: true });
    const res = await service().importTeam('dest', file, true);
    expect(await fs.readFile(path.join(GLOBAL, 'revisar-a11y', 'scripts', 'checar.sh'), 'utf8')).toBe('echo ok\n');
    expect(res!.created).toHaveLength(2);
    expect(res!.created).not.toContain(chefeId);
    expect(res!.created).not.toContain(anaId);

    const back = await listProjectStaff(dest, 'dest');
    const chefe2 = back.find((p) => p.name === 'Lia Chefe')!;
    const ana2 = back.find((p) => p.name === 'Ana Souza')!;
    expect(ana2).toMatchObject({
      role: 'Revisora',
      mission: 'Revisar mudanças',
      rules: ['Não altere arquivos'],
      doneWhen: 'Lista de achados',
      autonomy: 'plan',
      agents: ['Explore'],
      // Nome antigo no arquivo: vira ref Global ao importar (a skill vem no arquivo).
      skills: ['global:revisar-a11y'],
      // Nome antigo do MCP no arquivo: vira ref pelo que existe no destino (`docs` está no .mcp.json dele); o que não existe sai.
      mcps: ['project:docs'],
      // A política de MCP vai e volta igual: sem ela a ficha importada ficaria mais permissiva.
      mcpAccess: { docs: 'ask', github: 'off' },
      model: 'opus',
      effort: 'high',
      personality: 'professor',
      playbook: 'review-gate',
      reportsTo: [chefe2.id],
      servers: [],
      knowledge: [],
      sessions: [],
      canHire: false,
      browser: false,
      firstTask: '',
    });
    expect(ana2.hiredBy ?? null).toBeNull();
    expect(ana2.temporary).toBeFalsy();
    // Rotina entra desligada, mesmo que o arquivo diga que está ligada.
    expect(ana2.routines).toEqual([{ id: 'diaria', name: 'Diária', schedule: '0 9 * * *', message: 'Bom dia', mode: 'continue', enabled: false }]);
    expect(await fs.readFile(path.join(GLOBAL, 'revisar-a11y', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(await fs.readFile(path.join(GLOBAL, 'revisar-a11y', 'scripts', 'checar.sh'), 'utf8')).toBe('echo ok\n');
    expect(res!.warnings.some((w) => w.includes('MCP global:sumido'))).toBe(true);
    expect(res!.warnings.some((w) => w.includes('desligadas'))).toBe(true);
  });

  it('vínculo para fora do conjunto sai na exportação; no import, gestor que não veio é descartado', async () => {
    const onlyAna = await service().exportTeam('orig', anaId);
    expect(onlyAna!.staff[0]!.reportsTo).toEqual([]);

    const handmade = structuredClone(onlyAna) as TeamFile;
    handmade.staff[0]!.reportsTo = ['p9'];
    const plan = await planTeamImport(handmade, { localMcps: ['project:docs'], globalDir: GLOBAL });
    expect(plan.staff[0]!.reportsTo).toEqual([]);
    expect(plan.warnings.some((w) => w.includes('gestor que não veio'))).toBe(true);
  });

  it('MCPs na importação: a ref vale pelo que existe aqui, o nome antigo vira ref (Projeto se existe lá, senão Global) e null (todos) segue', async () => {
    const onlyAna = await service().exportTeam('orig', anaId);
    const h = structuredClone(onlyAna) as TeamFile;
    h.staff[0]!.mcps = ['docs', 'global:n8n', 'project:docs', 'project:fora', 'fora2'];
    const plan = await planTeamImport(h, { localMcps: ['project:docs', 'global:n8n'], globalDir: GLOBAL });
    // `docs` (antigo) e `project:docs` são o mesmo: um só. O que não existe aqui sai, com aviso por ref.
    expect(plan.staff[0]!.input.mcps).toEqual(['project:docs', 'global:n8n']);
    expect(plan.warnings.filter((w) => w.includes('não existe neste projeto')).map((w) => w.replace(/^.*MCP (\S+) .*$/, '$1'))).toEqual(['project:fora', 'global:fora2']);
    h.staff[0]!.mcps = null;
    expect((await planTeamImport(h, { localMcps: [], globalDir: GLOBAL })).staff[0]!.input.mcps).toBeNull();
  });

  it('tudo ou nada: um arquivo com problema não cria ficha nem skill', async () => {
    const before = (await listProjectStaff(dest, 'dest')).length;
    const bad = structuredClone(await service().exportTeam('orig', null)) as TeamFile;
    bad.skills.push({ name: 'nova-skill', files: [{ path: 'SKILL.md', content: '---\nname: nova-skill\ndescription: x\n---\n' }] });
    bad.skills[0]!.files.push({ path: '../fora.sh', content: 'echo fora' });
    await expect(service().importTeam('dest', bad, true)).rejects.toThrow('caminho recusado');
    expect(await listProjectStaff(dest, 'dest')).toHaveLength(before);
    await expect(fs.access(path.join(GLOBAL, 'nova-skill'))).rejects.toThrow();
    await expect(fs.access(path.join(GLOBAL, 'fora.sh'))).rejects.toThrow();
  });

  it('recusa caminho com .., absoluto ou com drive, e aceita o relativo', async () => {
    for (const p of ['../x.sh', 'a/../../x', '/etc/passwd', '\\\\rede\\x', 'C:/x.sh', 'a//b', './x']) expect(safeSkillPath(p)).toBeNull();
    expect(safeSkillPath('scripts/ok.sh')).toBe('scripts/ok.sh');
    expect(safeSkillPath('scripts\\ok.sh')).toBe('scripts/ok.sh');

    const file = await service().exportTeam('orig', anaId);
    for (const bad of ['../x.sh', '/abs.sh', 'C:/x.sh']) {
      const f = structuredClone(file) as TeamFile;
      f.skills[0]!.files.push({ path: bad, content: 'x' });
      await expect(planTeamImport(f, { localMcps: [], globalDir: GLOBAL })).rejects.toThrow('caminho recusado');
    }
  });

  it('skill com o mesmo nome na Global e outro conteúdo: recusa o arquivo inteiro, sem gravar nada', async () => {
    const file = await service().exportTeam('orig', anaId);
    const dir = path.join(GLOBAL, 'revisar-a11y');
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'versão local, não mexer');
    const antes = (await listProjectStaff(dest, 'dest')).length;
    await expect(service().importTeam('dest', file, true)).rejects.toThrow('já existe na Global com outro conteúdo');
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('versão local, não mexer');
    expect((await listProjectStaff(dest, 'dest')).length).toBe(antes);
    await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_MD);
  });

  it('skill igual à da Global: não é gravada de novo, a ficha entra e o aviso diz isso', async () => {
    const file = await service().exportTeam('orig', anaId);
    const res = await service().importTeam('dest', file, true);
    expect(res!.warnings.some((w) => w.includes('revisar-a11y') && w.includes('mesmo conteúdo'))).toBe(true);
    expect(await fs.readFile(path.join(GLOBAL, 'revisar-a11y', 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });

  it('segredo no texto recusa, sem mostrar o valor (na importação e na exportação)', async () => {
    const file = await service().exportTeam('orig', anaId);
    const bad = structuredClone(file) as TeamFile;
    bad.staff[0]!.mission = `Use ${KEY}`;
    const err = await planTeamImport(bad, { localMcps: [], globalDir: GLOBAL }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaffError);
    expect((err as Error).message).toContain('chave de API da Anthropic');
    expect((err as Error).message).not.toContain(KEY);

    const [ana] = (await listProjectStaff(origin, 'orig')).filter((p) => p.id === anaId);
    await expect(buildTeamExport([{ ...ana!, mission: `Use ${KEY}` }], { globalSkills: [] })).rejects.toThrow('chave de API da Anthropic');
  });

  it('importar só pela tela; formato errado, versão nova e ciclo de gestor recusam o arquivo inteiro', async () => {
    const file = await service().exportTeam('orig', null);
    await expect(service().importTeam('dest', file, false)).rejects.toThrow('só pelo Claudio’s Club');
    await expect(planTeamImport({ ...file, format: 'outro' }, { localMcps: [], globalDir: GLOBAL })).rejects.toThrow('não é um arquivo de equipe');
    await expect(planTeamImport({ ...file, version: 2 }, { localMcps: [], globalDir: GLOBAL })).rejects.toThrow('versão do arquivo não suportada');
    const ciclo = structuredClone(file) as TeamFile;
    ciclo.staff[0]!.reportsTo = ['p1'];
    ciclo.staff[1]!.reportsTo = ['p0'];
    await expect(planTeamImport(ciclo, { localMcps: [], globalDir: GLOBAL })).rejects.toThrow('ciclo');
  });

  it('autonomia acima de acceptEdits vira manual na importação, com aviso do valor que veio', async () => {
    const file = structuredClone(await service().exportTeam('orig', null)) as TeamFile;
    file.staff[0]!.autonomy = 'bypassPermissions';
    file.staff[1]!.autonomy = 'auto';
    const plan = await planTeamImport(file, { localMcps: [], globalDir: GLOBAL });
    expect(plan.staff.map((p) => p.input.autonomy)).toEqual(['manual', 'manual']);
    expect(plan.warnings.some((w) => w.includes('autonomia bypassPermissions no arquivo'))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('autonomia auto no arquivo'))).toBe(true);

    // acceptEdits não é mais permissiva que o limite: entra como veio, sem aviso.
    file.staff[0]!.autonomy = 'plan';
    file.staff[1]!.autonomy = 'acceptEdits';
    const ok = await planTeamImport(file, { localMcps: [], globalDir: GLOBAL });
    expect(ok.staff[1]!.input.autonomy).toBe('acceptEdits');
    expect(ok.warnings.some((w) => w.includes('autonomia'))).toBe(false);
  });

  it('skill com arquivo grande demais é recusada', async () => {
    const big = structuredClone(await service().exportTeam('orig', anaId)) as TeamFile;
    big.skills[0]!.files.push({ path: 'grande.txt', content: 'x'.repeat(201 * 1024) });
    await expect(planTeamImport(big, { localMcps: [], globalDir: GLOBAL })).rejects.toThrow('grande demais');
  });
});
