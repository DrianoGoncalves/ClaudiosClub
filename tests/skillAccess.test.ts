import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertSkills, listSkillDirs, parseSkillRef, planSkills, resolveLegacySkill, skillPlanOf, type SkillSource } from '../server/skillAccess';
import { prepareCodexRun, prepareRun, type LaunchContext } from '../server/staff/launch';
import { renderFicha } from '../server/staff/ficha';
import type { StaffProfile } from '../shared/model';

// MYCO_HOME de teste: a conversa grava em run/ e nada vai para o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-skill-access-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
/** Global (`~/.claude/skills`): `x` e `so-global`. */
let GLOBAL: string;
/** Projeto (`<proj>/.claude/skills`): `x` (mesmo nome da Global) e `y` (só do projeto). */
let PROJ: string;
const RUN = () => path.join(root, 'mycohome', 'run');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-skill-access-'));
  GLOBAL = path.join(root, 'conta', 'skills');
  PROJ = path.join(root, 'proj');
  await skill(path.join(GLOBAL, 'x'), 'x', 'Global x: faz X');
  await skill(path.join(GLOBAL, 'so-global'), 'so-global', 'Só na Global');
  await skill(path.join(PROJ, '.claude', 'skills', 'x'), 'x', 'Projeto x: faz X do projeto');
  await skill(path.join(PROJ, '.claude', 'skills', 'y'), 'y', 'Projeto y: faz Y');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

/** Uma pasta de skill com SKILL.md (frontmatter com nome e descrição) e um arquivo extra. */
async function skill(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: "${description}"\n---\n\nPasso de ${name}.\n`);
  await fs.writeFile(path.join(dir, 'extra.txt'), `arquivo de ${name}`);
}

const globalSkills = (): SkillSource[] => [
  { name: 'x', dir: path.join(GLOBAL, 'x') },
  { name: 'so-global', dir: path.join(GLOBAL, 'so-global') },
];
/** As do projeto, como o service entrega (ver LaunchContext.projectSkills). */
const projectList = (): SkillSource[] => [
  { name: 'x', dir: path.join(PROJ, '.claude', 'skills', 'x') },
  { name: 'y', dir: path.join(PROJ, '.claude', 'skills', 'y') },
];
/** As do projeto, lidas da pasta de verdade (listSkillDirs). */
const projectSkills = async (): Promise<SkillSource[]> => listSkillDirs(path.join(PROJ, '.claude', 'skills'));

const profile = (over: Partial<StaffProfile> = {}) =>
  ({
    id: 'ana-1',
    projectId: 'proj-id',
    name: 'Ana',
    role: 'Dev',
    mission: 'Testar skills',
    firstTask: '',
    autonomy: 'acceptEdits',
    agents: [],
    skills: [],
    mcps: null,
    mcpAccess: {},
    knowledge: [],
    rules: [],
    doneWhen: '',
    reportsTo: [],
    engine: 'claude',
    model: null,
    effort: null,
    canHire: false,
    playbook: null,
    worktree: false,
    servers: [],
    sshWrite: [],
    browser: false,
    portrait: null,
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

const launch = (over: Partial<LaunchContext> = {}): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath: PROJ,
  managerNames: [],
  mycoUrl: 'http://127.0.0.1:1',
  runDir: RUN(),
  claudeConfigFile: path.join(root, 'claude.json'),
  userAgentsDir: path.join(root, 'agents'),
  globalSkills: globalSkills(),
  projectSkills: projectList(),
  ...over,
});

const settingsOf = async (settingsFile: string) => JSON.parse(await fs.readFile(settingsFile, 'utf8')) as { skillOverrides?: Record<string, string> };

describe('refs de skill e nomes antigos', () => {
  it('lê só `global:` e `project:` com nome válido', () => {
    expect(parseSkillRef('global:vps')).toEqual({ scope: 'global', name: 'vps' });
    expect(parseSkillRef('project:Revisar_A11y')).toEqual({ scope: 'project', name: 'Revisar_A11y' });
    expect(parseSkillRef('vps')).toBeNull();
    expect(parseSkillRef('user:vps')).toBeNull();
    expect(parseSkillRef('global:../x')).toBeNull();
  });

  it('nome antigo: Global primeiro, depois Projeto, senão Global (aviso); uma ref por nome', () => {
    const known = { globalNames: ['both', 'g'], projectNames: ['both', 'p'] };
    expect(resolveLegacySkill('both', known)).toBe('global:both');
    expect(resolveLegacySkill('p', known)).toBe('project:p');
    expect(resolveLegacySkill('sumiu', known)).toBe('global:sumiu');
    expect(convertSkills(['g', 'p', 'sumiu'], known)).toEqual({ skills: ['global:g', 'project:p', 'global:sumiu'], changed: true });
    // Já com escopo fica como está; repetido vira um só.
    expect(convertSkills(['project:p', 'g', 'global:g'], known)).toEqual({ skills: ['project:p', 'global:g'], changed: true });
    expect(convertSkills(['global:g'], known)).toEqual({ skills: ['global:g'], changed: false });
  });
});

describe('planSkills: o que cada ficha carrega', () => {
  it('A marca `global:x`: x nativa, y fora (off), sem plugin', () => {
    const plan = planSkills(['global:x'], globalSkills(), [{ name: 'x', dir: path.join(PROJ, '.claude/skills/x') }, { name: 'y', dir: path.join(PROJ, '.claude/skills/y') }]);
    expect(plan.off).toEqual(['so-global', 'y']);
    expect(plan.native).toEqual(['global:x']);
    expect(plan.plugin).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it('B marca `project:x` e `project:y`: x vai no plugin (sombra da Global), y nativa, x fora do nativo', async () => {
    const plan = planSkills(['project:x', 'project:y'], globalSkills(), await projectSkills());
    expect(plan.off).toEqual(['so-global', 'x']);
    expect(plan.native).toEqual(['project:y']);
    expect(plan.plugin).toEqual([{ ref: 'project:x', name: 'x', dir: path.join(PROJ, '.claude', 'skills', 'x') }]);
    expect(plan.missing).toEqual([]);
  });

  it('nada marcado: off para tudo, sem plugin', async () => {
    const plan = planSkills([], globalSkills(), await projectSkills());
    expect(plan.off).toEqual(['so-global', 'x', 'y']);
    expect(plan.native).toEqual([]);
    expect(plan.plugin).toEqual([]);
  });

  it('ref marcada que não existe vai para missing (também a do escopo errado)', () => {
    const plan = planSkills(['global:y', 'project:nada', 'sem-escopo'], globalSkills(), []);
    expect(plan.missing).toEqual(['global:y', 'project:nada', 'sem-escopo']);
    expect(plan.present).toEqual([]);
  });

  it('com Global e projeto marcados para o mesmo nome: nativa a Global e o projeto vai no plugin', async () => {
    const plan = planSkills(['global:x', 'project:x'], globalSkills(), await projectSkills());
    expect(plan.native).toEqual(['global:x']);
    expect(plan.plugin.map((p) => p.ref)).toEqual(['project:x']);
    expect(plan.off).toEqual(['so-global', 'y']);
  });
});

describe('lançamento do Claude: settings e plugin', () => {
  it('A (`global:x`): sem off para x, com off para y, sem plugin', async () => {
    const r = await prepareRun(profile({ skills: ['global:x'] }), launch(), 'sess-a', PROJ);
    expect((await settingsOf(r.settingsFile)).skillOverrides).toEqual({ y: 'off', 'so-global': 'off' });
    expect(r.pluginDir).toBeNull();
  });

  it('B (`project:x`, `project:y`): off para x, plugin com `x` do projeto, y nativa', async () => {
    const r = await prepareRun(profile({ skills: ['project:x', 'project:y'] }), launch(), 'sess-b', PROJ);
    expect((await settingsOf(r.settingsFile)).skillOverrides).toEqual({ x: 'off', 'so-global': 'off' });
    expect(r.pluginDir).not.toBeNull();
    const pluginSkills = await fs.readdir(path.join(r.pluginDir!, 'skills'));
    expect(pluginSkills).toEqual(['x']);
    expect(await fs.readFile(path.join(r.pluginDir!, 'skills', 'x', 'extra.txt'), 'utf8')).toBe('arquivo de x');
    expect(await fs.readFile(path.join(r.pluginDir!, 'skills', 'x', 'SKILL.md'), 'utf8')).toContain('Projeto x');
  });

  it('ficha sem nada: off para tudo, plugin nulo e a pasta do plugin antigo apagada', async () => {
    const ctx = launch();
    const first = await prepareRun(profile({ skills: ['project:x'] }), ctx, 'sess-c', PROJ);
    expect(first.pluginDir).not.toBeNull();
    const again = await prepareRun(profile({ skills: [] }), ctx, 'sess-c', PROJ);
    expect(again.pluginDir).toBeNull();
    await expect(fs.stat(path.join(RUN(), 'sess-c', 'myco-plugin'))).rejects.toThrow();
    expect((await settingsOf(again.settingsFile)).skillOverrides).toEqual({ x: 'off', y: 'off', 'so-global': 'off' });
  });

  it('nome antigo sem prefixo é convertido na leitura da ficha (Global antes do projeto)', async () => {
    // `x` existe na Global e no projeto: nome antigo vira `global:x`, então é nativo e não entra no plugin.
    const r = await prepareRun(profile({ skills: ['x', 'y'] }), launch(), 'sess-legado', PROJ);
    expect((await settingsOf(r.settingsFile)).skillOverrides).toEqual({ 'so-global': 'off' });
    expect(r.pluginDir).toBeNull();
  });

  it('numa worktree, a skill do projeto da worktree conta (união com a pasta do projeto)', async () => {
    const wt = path.join(root, 'wt');
    await skill(path.join(wt, '.claude', 'skills', 'so-wt'), 'so-wt', 'Só na worktree');
    const r = await prepareRun(profile({ skills: ['project:so-wt'] }), launch(), 'sess-wt', wt);
    // `so-wt` só existe na worktree: marcada, é nativa (não vai ao plugin nem ao off).
    expect((await settingsOf(r.settingsFile)).skillOverrides).toEqual({ x: 'off', y: 'off', 'so-global': 'off' });
    expect(r.pluginDir).toBeNull();
  });
});

describe('Codex: a ficha lista só as marcadas, com o caminho do SKILL.md', () => {
  it('A lista só `x` (Global) com o caminho dela; B lista x e y do projeto', async () => {
    const a = await prepareCodexRun(profile({ engine: 'codex', skills: ['global:x'] }), launch(), 'codex-a', PROJ);
    expect(a.instructions).toContain('## Skills indicadas');
    expect(a.instructions).toContain(`- x: Global x: faz X (arquivo: ${path.join(GLOBAL, 'x', 'SKILL.md')})`);
    expect(a.instructions).not.toContain('- y:');
    expect(a.instructions).not.toContain('so-global');

    const b = await prepareCodexRun(profile({ engine: 'codex', skills: ['project:x', 'project:y'] }), launch(), 'codex-b', PROJ);
    expect(b.instructions).toContain(`- x: Projeto x: faz X do projeto (arquivo: ${path.join(PROJ, '.claude', 'skills', 'x', 'SKILL.md')})`);
    expect(b.instructions).toContain(`- y: Projeto y: faz Y (arquivo: ${path.join(PROJ, '.claude', 'skills', 'y', 'SKILL.md')})`);
    expect(b.instructions).not.toContain('so-global');
  });

  it('sem skill marcada que exista, a seção não aparece', async () => {
    const none = await prepareCodexRun(profile({ engine: 'codex', skills: [] }), launch(), 'codex-none', PROJ);
    expect(none.instructions).not.toContain('## Skills indicadas');
  });

  it('a descrição vai cortada em 300 caracteres', async () => {
    const dir = path.join(root, 'longa');
    await skill(dir, 'longa', 'a'.repeat(500));
    const plan = await skillPlanOf(['global:longa'], { globalSkills: [{ name: 'longa', dir }], projectSkills: [] });
    expect(plan.present[0]!.description.length).toBe(300);
    expect(plan.present[0]!.description.endsWith('…')).toBe(true);
  });

  it('a ficha do Claude mostra o nome da Global nativa e o `myco:` só para o que o plugin carrega', async () => {
    const plan = await skillPlanOf(['global:x', 'project:x', 'project:y'], { globalSkills: globalSkills(), projectSkills: await projectSkills() });
    const md = renderFicha(profile({ skills: ['global:x', 'project:x', 'project:y'] }), { company: 'Co', projectName: 'proj', projectPath: PROJ, managerNames: [], fichaPath: 'f', memoryPath: 'm', mycoUrl: 'u', skillPlan: plan });
    expect(md).toContain('Skills: x, `myco:x` (só sua), y.');
  });
});
