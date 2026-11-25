import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { prepareCodexRun, prepareRun, type LaunchContext } from '../server/staff/launch';
import { ensurePlaybookAgents } from '../server/staff/playbookAgents';
import { removeTemp } from './support/tmp';

// Agents marcados na ficha (`profile.agents`), com ou sem roteiro, precisam chegar à worktree: `.claude/agents` está no .gitignore, então a cópia não os tem
// e só o `--agents` (Claude) ou o TOML da conversa (Codex) os entrega. Só o roteiro cria preset; o da ficha que não existe em lugar nenhum é ignorado.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-profagents-'));
});
afterAll(() => removeTemp(root));

const profile = (over: Partial<StaffProfile> = {}) =>
  ({ id: 'ana-1', projectId: 'p', name: 'Ana', role: 'Dev', mission: 'x', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: [], mcpAccess: {}, knowledge: [], rules: [], doneWhen: '', reportsTo: [], engine: 'claude', model: null, effort: null, canHire: false, playbook: null, worktree: true, servers: [], sshWrite: [], browser: false, portrait: null, sessions: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over }) as unknown as StaffProfile;

interface Env { project: string; wt: string; user: string; launch: LaunchContext }
let n = 0;
/** Projeto com os agents dados em `.claude/agents`, a conta com os dados em `user`, e uma worktree vazia (como a cópia do git, sem a pasta ignorada). */
async function env(o: { project?: string[]; user?: string[]; wt?: string[] } = {}): Promise<Env> {
  const base = path.join(root, `e${n++}`);
  const project = path.join(base, 'proj');
  const wt = path.join(project, '.claude', 'worktrees', 'myco-ana-1');
  const user = path.join(base, 'user-agents');
  const put = async (dir: string, names: string[]) => {
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) await fs.writeFile(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} de teste\nmodel: haiku\ntools: Read, Grep\n---\n\nprompt do ${name}\n`);
  };
  await fs.mkdir(wt, { recursive: true });
  await put(path.join(project, '.claude', 'agents'), o.project ?? []);
  await put(path.join(wt, '.claude', 'agents'), o.wt ?? []);
  await put(user, o.user ?? []);
  const launch: LaunchContext = { company: 'Co', projectName: 'p', projectPath: project, managerNames: [], mycoUrl: 'http://127.0.0.2:1', runDir: path.join(base, 'run'), claudeConfigFile: path.join(project, 'claude.json'), userAgentsDir: user };
  return { project, wt, user, launch };
}
const projectAgents = (e: Env) => fs.readdir(path.join(e.project, '.claude', 'agents')).then((l) => l.sort());
const inlineOf = async (file: string | null) => (file ? Object.keys(JSON.parse(await fs.readFile(file, 'utf8'))).sort() : null);

describe('Claude: agents da ficha em worktree', () => {
  it('sem roteiro: agents.json traz os da ficha que existem no projeto e faltam na worktree; o da conta e o inexistente ficam de fora, sem criar arquivo', async () => {
    const e = await env({ project: ['executor', 'pesquisador'], user: ['revisor'] });
    const run = await prepareRun(profile({ agents: ['executor', 'pesquisador', 'revisor', 'fantasma'] }), e.launch, 'sess-sem-roteiro', e.wt);
    expect(await inlineOf(run.agentsFile)).toEqual(['executor', 'pesquisador']);
    const agents = JSON.parse(await fs.readFile(run.agentsFile!, 'utf8'));
    expect(agents.executor).toMatchObject({ description: 'executor de teste', prompt: 'prompt do executor', tools: ['Read', 'Grep'], model: 'haiku' });
    expect(await projectAgents(e)).toEqual(['executor.md', 'pesquisador.md']); // nada criado (nem o fantasma, nem o da conta)
    await expect(fs.stat(path.join(e.wt, '.claude', 'agents', 'fantasma.md'))).rejects.toThrow();
  });

  it('o que a worktree já tem não vai de novo; sem nenhum faltando, não há agents.json', async () => {
    const e = await env({ project: ['executor', 'pesquisador'], wt: ['executor', 'pesquisador'] });
    const run = await prepareRun(profile({ agents: ['executor', 'pesquisador'] }), e.launch, 'sess-wt-tem', e.wt);
    expect(run.agentsFile).toBeNull();
  });

  it('sem worktree (cwd = projeto): nada por --agents, o claude lê a pasta do projeto sozinho', async () => {
    const e = await env({ project: ['executor'] });
    const run = await prepareRun(profile({ agents: ['executor'] }), e.launch, 'sess-sem-wt', e.project);
    expect(run.agentsFile).toBeNull();
  });

  it('com roteiro: os do roteiro seguem criados e inline, e os da ficha somam; o preset só nasce para o roteiro', async () => {
    const e = await env({ project: ['pesquisador', 'escritor'] });
    const run = await prepareRun(profile({ playbook: 'review-gate', agents: ['pesquisador', 'escritor', 'fantasma'] }), e.launch, 'sess-roteiro', e.wt);
    expect(await inlineOf(run.agentsFile)).toEqual(['escritor', 'executor', 'pesquisador', 'revisor']);
    expect(await projectAgents(e)).toEqual(['escritor.md', 'executor.md', 'pesquisador.md', 'revisor.md']);
  });

  it('um agent da ficha que é preset conhecido, mas não existe, não é criado sem roteiro', async () => {
    const e = await env();
    const r = await ensurePlaybookAgents({ playbook: null, agents: ['executor', 'revisor'] }, { projectPath: e.project, cwd: e.wt, userAgentsDir: e.user, backupDir: path.join(e.project, 'bak') });
    expect(r).toEqual({ created: [], inline: {} });
    expect(await projectAgents(e)).toEqual([]);
  });
});

describe('Codex: a mesma regra (paridade)', () => {
  it('sem roteiro, em worktree: os da ficha viram TOML (projeto e conta), o inexistente fica de fora, e nada é criado', async () => {
    const e = await env({ project: ['executor', 'pesquisador'], user: ['revisor'] });
    const run = await prepareCodexRun(profile({ engine: 'codex', agents: ['executor', 'pesquisador', 'revisor', 'fantasma'] }), e.launch, 'sess-codex-sem-roteiro', e.wt);
    expect(run.agents.map((a) => a.name).sort()).toEqual(['executor', 'pesquisador', 'revisor']);
    for (const a of run.agents) expect(await fs.readFile(a.configFile, 'utf8')).toContain(`name = "${a.name}"`);
    expect(await projectAgents(e)).toEqual(['executor.md', 'pesquisador.md']);
  });
});
