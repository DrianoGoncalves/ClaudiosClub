import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { updateConfig } from '../server/config';
import { StaffService } from '../server/staff/service';

// codexReview até o `perguntar_gpt`: com a flag ligada, o funcionário do Claude abre a conversa com o MCP do GPT no mcp.json e a ficha
// manda usá-lo; desligada, ou no motor Codex, nada disso. A config e os agents da conta ficam em pastas temporárias.
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

/** Contrata alguém com roteiro, abre a conversa e devolve o que a sessão vê: mcp.json (se houver), ficha e agents do projeto. */
async function open(name: string, engine?: 'codex') {
  const s = svc();
  const { profile } = (await s.hire('proj-id', { name, role: 'Dev', mission: 'Entregar', playbook: 'plan-big-execute-small', mcps: null, ...(engine && { engine, model: 'gpt-6-sol' }), launch: false }, true))!;
  const spawn = (await s.chatSpawn('proj-id', null, profile.id))!;
  const ficha = await fs.readFile(path.join(proj, '.myco', 'staff', `${profile.id}.md`), 'utf8');
  const mcpFile = path.join(root, 'run', spawn.sessionId, 'mcp.json');
  const mcp = JSON.parse(await fs.readFile(mcpFile, 'utf8').catch(() => 'null')) as { mcpServers: Record<string, { command: string; args: string[] }> } | null;
  const agents = await fs.readdir(path.join(proj, '.claude', 'agents')).catch(() => [] as string[]);
  return { ficha, mcp, args: spawn.args, agents };
}

describe('codexReview até o perguntar_gpt', () => {
  it('desligado (padrão): sem MCP do GPT, roteiro como sempre', async () => {
    const r = await open('Ana');
    expect(r.mcp).toBeNull();
    expect(r.args).not.toContain('--mcp-config');
    expect(r.ficha).not.toContain('perguntar_gpt');
  });

  it('ligado: o mcp.json leva o myco-gpt (somando aos MCPs do projeto) e a ficha manda perguntar ao GPT; nada de agent novo', async () => {
    await updateConfig({ codexReview: true });
    const r = await open('Bia');
    const gpt = r.mcp!.mcpServers['myco-gpt']!;
    expect(gpt.args).toEqual(expect.arrayContaining(['--project', proj, '--root', proj, '--myco-home', path.join(homes, 'myco')]));
    // Ficha sem lista de MCPs (todos): o do GPT só se soma (sem --strict-mcp-config).
    expect(r.args).toEqual(expect.arrayContaining(['--mcp-config']));
    expect(r.args).not.toContain('--strict-mcp-config');
    expect(r.ficha).toContain('pergunte também ao GPT pela ferramenta `mcp__myco-gpt__perguntar_gpt`');
    expect(r.agents).not.toContain('consultor-gpt.md');
  });

  it('ligado, mas no motor Codex: nada de MCP (o Codex não tem) nem linha do roteiro', async () => {
    const r = await open('Caio', 'codex');
    expect(r.mcp).toBeNull();
    expect(r.ficha).not.toContain('perguntar_gpt');
  });

  it('desligar de novo: a conversa seguinte volta sem o MCP', async () => {
    await updateConfig({ codexReview: false });
    const r = await open('Duda');
    expect(r.mcp).toBeNull();
    expect(r.ficha).not.toContain('perguntar_gpt');
  });
});
