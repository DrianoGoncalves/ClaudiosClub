import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { updateConfig } from '../server/config';
import { StaffService } from '../server/staff/service';

// A config (codexReview) e os agents da conta ficam em pastas temporárias, definidas antes de os módulos carregarem.
const homes = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const base = nodePath.join(os.tmpdir(), `myco-consultor-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = nodePath.join(base, 'myco');
  process.env.MYCO_CLAUDE_HOME = nodePath.join(base, 'claude');
  return base;
});

let root: string;
let proj: string;

const project = (): Project => ({ id: 'proj-id', path: proj, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
const svc = () =>
  new StaffService({ listProjects: async () => [project()] } as unknown as ToolAdapter, {
    runDir: path.join(root, 'run'),
    claudeConfigFile: path.join(root, 'claude.json'),
    mycoUrl: 'x',
    readUsage: async () => ({ tapInstalled: true, limits: [], updatedAt: null }),
  });

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-consultor-proj-'));
  proj = path.join(root, 'proj');
  await fs.mkdir(proj, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homes, { recursive: true, force: true });
});

/** Contrata alguém com roteiro, abre a conversa e devolve o que a sessão vê: ficha, prompt de sistema e agents do projeto. */
async function open(name: string) {
  const s = svc();
  const { profile } = (await s.hire('proj-id', { name, role: 'Dev', mission: 'Entregar', playbook: 'plan-big-execute-small', launch: false }, true))!;
  const spawn = (await s.chatSpawn('proj-id', null, profile.id))!;
  const ficha = await fs.readFile(path.join(proj, '.myco', 'staff', `${profile.id}.md`), 'utf8');
  const system = await fs.readFile(path.join(root, 'run', spawn.sessionId, 'system.md'), 'utf8');
  const agents = await fs.readdir(path.join(proj, '.claude', 'agents')).catch(() => [] as string[]);
  return { ficha, system, agents };
}

describe('codexReview até o consultor-gpt', () => {
  it('desligado (padrão): roteiro como sempre, sem consultor-gpt', async () => {
    const r = await open('Ana');
    expect(r.agents.sort()).toEqual(['executor.md', 'pesquisador.md', 'revisor.md']);
    expect(r.ficha).not.toContain('consultor-gpt');
  });

  it('ligado: cria o consultor-gpt no projeto e a ficha manda pedir a opinião dele', async () => {
    await updateConfig({ codexReview: true });
    const r = await open('Bia');
    expect(r.agents).toContain('consultor-gpt.md');
    const agent = await fs.readFile(path.join(proj, '.claude', 'agents', 'consultor-gpt.md'), 'utf8');
    expect(agent).toMatch(/^---\nname: consultor-gpt\n/);
    expect(agent).toContain('codex exec');
    for (const text of [r.ficha, r.system]) {
      expect(text).toContain('peça também a opinião do `consultor-gpt`');
      expect(text).toContain('Agents: pesquisador, executor, revisor, consultor-gpt.');
    }
    // Desligar de novo: a ficha seguinte volta ao roteiro simples (o arquivo já criado fica, como os outros).
    await updateConfig({ codexReview: false });
    expect((await open('Caio')).ficha).not.toContain('consultor-gpt');
  });
});
