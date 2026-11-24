import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolAdapter } from '../server/adapters/types';
import { cardWorktreeFor, ensureCardWorktree } from '../server/cardWorktree';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile } from '../server/staff/store';
import type { AccountUsage, Project } from '../shared/model';
import { removeTemp } from './support/tmp';

// t-250de1: a conversa NOVA de trabalho do card abre na worktree do card, nos DOIS motores (Claude e Codex), pelo mesmo `chatSpawn(place)`; a pasta fica gravada na sessão (reabrir, retomar e o
// reinício seguem nela); a conversa de revisão e a conversa sem card seguem onde sempre abriram.

const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-card-spawn-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-card-spawn-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(path.join(projectPath, '.myco'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', projectPath, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Teste');
  git('config', 'user.email', 't@t');
  await fs.writeFile(path.join(projectPath, 'a.txt'), 'a\n');
  await fs.writeFile(path.join(projectPath, '.gitignore'), '.claude/\n');
  git('add', '.');
  git('commit', '-qm', 'início');
});
afterAll(() => removeTemp(root, home));

const project = (): Project => ({ id: 'proj-id', path: projectPath, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });
const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };

describe('a conversa do card abre na worktree do card (Claude e Codex)', () => {
  it.each([
    ['Claude', undefined, 'Carla'],
    ['Codex', 'codex' as const, 'Cris'],
  ])('%s: cwd = a pasta do card, gravado na sessão; reabrir segue nela; sem `place` abre onde sempre abriu', async (_motor, engine, name) => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name, ...(engine && { engine }) }, true))!.profile;
    const card = await ensureCardWorktree(projectPath, `t-spawn-${name.toLowerCase()}`);
    const place = { path: card.path, branch: card.branch };

    const spawn = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, undefined, place))!;
    expect(spawn.cwd).toBe(card.path);
    if (engine === 'codex') {
      expect(spawn.engine).toBe('codex');
      expect(spawn.codex).toBeTruthy();
    } else {
      expect(spawn.engine).toBeUndefined();
      expect(spawn.args).toContain(spawn.sessionId);
    }
    // A pasta fica na entrada da sessão: é o que `sessionCwd` devolve ao reabrir, retomar e reiniciar.
    const saved = (await readProfile(projectPath, p.id))!.sessions.find((s) => s.id === spawn.sessionId);
    expect(saved?.cwd).toBe(card.path);
    const reopened = (await svc.chatSpawn('proj-id', spawn.sessionId, p.id))!;
    expect(reopened.sessionId).toBe(spawn.sessionId);
    expect(reopened.cwd).toBe(card.path);

    // Sem `place` (conversa direta, sem card): a pasta do projeto, como sempre (a ficha não pede worktree própria).
    const direct = (await svc.chatSpawn('proj-id', null, p.id))!;
    expect(direct.cwd).toBe(projectPath);
    // A worktree própria da ficha não foi criada para a conversa do card.
    await expect(fs.stat(path.join(projectPath, '.claude', 'worktrees', `myco-${p.id}`))).rejects.toThrow();
  });

  it('conversa de revisão (só leitura) com `place`: não vai para a worktree do card (revisor lê pelo caminho que o pedido cita)', async () => {
    const svc = service();
    const p = (await svc.hire('proj-id', { ...base, name: 'Rita' }, true))!.profile;
    const place = cardWorktreeFor(projectPath, 't-spawn-rita');
    const spawn = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, true, undefined, place))!;
    expect(spawn.cwd).toBe(projectPath);
  });
});
