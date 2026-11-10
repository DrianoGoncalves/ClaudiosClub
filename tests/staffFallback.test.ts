import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { readProfile, saveProfile, StaffInputSchema } from '../server/staff/store';

// Motor secundário (fallback) na ficha: o que o servidor aceita ao contratar e ao editar. Só o dado; nada o usa ainda.

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-staff-fallback-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const project = (): Project => ({
  id: 'proj-id',
  path: projectPath,
  name: 'proj',
  exists: true,
  worktreeOf: null,
  hasClaudeMd: false,
  agentCount: 0,
  skillCount: 0,
  sessionCount: 0,
  lastActivityAt: null,
});
const adapter = { listProjects: async () => [project()] } as unknown as ToolAdapter;
const noUsage = async (): Promise<AccountUsage> => ({ tapInstalled: true, limits: [], updatedAt: null });
const service = (over: Partial<StaffServiceOptions> = {}) =>
  new StaffService(adapter, { runDir: path.join(root, 'run'), claudeConfigFile: path.join(root, 'claude.json'), mycoUrl: 'http://127.0.0.1:4848', readUsage: noUsage, codexEnabled: async () => true, ...over });

const base = { name: 'Cris', role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };
const MESMO = 'o motor secundário tem que ser diferente do principal';
const SERVIDORES = 'o motor secundário Codex não aceita servidores na ficha: tire os servidores ou use o Claude como secundário';

describe('ficha: motor secundário (fallback)', () => {
  it('aceita um secundário válido (Claude com Codex) e o devolve na leitura', async () => {
    const svc = service();
    const fallback = { engine: 'codex', model: 'gpt-6-sol', effort: 'high' };
    const hired = (await svc.hire('proj-id', { ...base, name: 'Aceita', fallback }, true))!.profile;
    expect(hired.fallback).toEqual(fallback);
    expect((await readProfile(projectPath, hired.id))?.fallback).toEqual(fallback);
  });

  it('recusa o mesmo motor do principal (ficha sem engine conta como Claude)', async () => {
    const svc = service();
    await expect(svc.hire('proj-id', { ...base, name: 'Mesmo Claude', fallback: { engine: 'claude', model: 'sonnet' } }, true)).rejects.toThrow(MESMO);
    await expect(svc.hire('proj-id', { ...base, name: 'Mesmo Codex', engine: 'codex', fallback: { engine: 'codex', model: 'gpt-6-sol' } }, true)).rejects.toThrow(MESMO);
  });

  it('modelo segue a regra do principal: recusa vazio, espaço, controle, mais de 60 ou caractere fora de \\w.[]-', () => {
    const aceita = (model: string) => StaffInputSchema.safeParse({ ...base, fallback: { engine: 'claude', model } }).success;
    expect(aceita('')).toBe(false);
    expect(aceita('gpt 6')).toBe(false);
    expect(aceita('son\tnet')).toBe(false);
    expect(aceita('son\u0007net')).toBe(false);
    expect(aceita('a;b')).toBe(false);
    expect(aceita('a'.repeat(61))).toBe(false);
    expect(aceita('a'.repeat(60))).toBe(true);
    expect(aceita('claude-sonnet-5-5[1m]')).toBe(true);
    expect(aceita('gpt-6.1-sol')).toBe(true);
  });

  it('recusa effort que o motor não aceita: no Claude o ultra não vale; no Codex vale', async () => {
    expect(StaffInputSchema.safeParse({ ...base, fallback: { engine: 'codex', model: 'gpt-6-sol', effort: 'turbo' } }).success).toBe(false);
    const svc = service();
    // Principal Codex, para o secundário Claude não cair na regra de "mesmo motor" antes da do ultra.
    await expect(
      svc.hire('proj-id', { ...base, name: 'Ultra Claude', engine: 'codex', fallback: { engine: 'claude', model: 'sonnet', effort: 'ultra' } }, true),
    ).rejects.toThrow('O esforço ultra só existe no Codex');
    const codex = (await svc.hire('proj-id', { ...base, name: 'Ultra Codex', fallback: { engine: 'codex', model: 'gpt-6-sol', effort: 'ultra' } }, true))!.profile;
    expect(codex.fallback?.effort).toBe('ultra');
  });

  it('recusa Codex como secundário quando a ficha tem servidores (contratar e editar)', async () => {
    const svc = service();
    const fallback = { engine: 'codex', model: 'gpt-6-sol' };
    await expect(svc.hire('proj-id', { ...base, name: 'Com servidor', servers: ['vps1'], fallback }, true)).rejects.toThrow(SERVIDORES);
    const ficha = (await svc.hire('proj-id', { ...base, name: 'Edita servidor', servers: ['vps1'] }, true))!.profile;
    await expect(svc.update('proj-id', ficha.id, { ...base, name: 'Edita servidor', servers: ['vps1'], fallback })).rejects.toThrow(SERVIDORES);
    expect((await readProfile(projectPath, ficha.id))?.fallback).toBeUndefined();
  });

  it('editar: o mesmo motor também é recusado, e a ficha fica como estava', async () => {
    const svc = service();
    const ficha = (await svc.hire('proj-id', { ...base, name: 'Edita mesmo' }, true))!.profile;
    await expect(svc.update('proj-id', ficha.id, { ...base, name: 'Edita mesmo', fallback: { engine: 'claude', model: 'sonnet' } })).rejects.toThrow(MESMO);
    expect((await readProfile(projectPath, ficha.id))?.fallback).toBeUndefined();
  });

  it('editar: sem a chave o secundário fica; a troca vale; null tira', async () => {
    const svc = service();
    const fallback = { engine: 'codex', model: 'gpt-6-sol', effort: 'low' };
    const ficha = (await svc.hire('proj-id', { ...base, name: 'Edita fallback', fallback }, true))!.profile;
    await svc.update('proj-id', ficha.id, { ...base, name: 'Edita fallback' });
    expect((await readProfile(projectPath, ficha.id))?.fallback).toEqual(fallback);
    await svc.update('proj-id', ficha.id, { ...base, name: 'Edita fallback', fallback: { engine: 'codex', model: 'gpt-6-sol-2' } });
    expect((await readProfile(projectPath, ficha.id))?.fallback).toEqual({ engine: 'codex', model: 'gpt-6-sol-2' });
    await svc.update('proj-id', ficha.id, { ...base, name: 'Edita fallback', fallback: null });
    expect((await readProfile(projectPath, ficha.id))?.fallback).toBeUndefined();
  });

  it('secundário inválido no arquivo some na leitura, e a ficha segue', async () => {
    const svc = service();
    const ficha = (await svc.hire('proj-id', { ...base, name: 'Arquivo ruim' }, true))!.profile;
    await saveProfile(projectPath, { ...ficha, fallback: { engine: 'outro', model: 'x' } } as never);
    const lida = await readProfile(projectPath, ficha.id);
    expect(lida?.name).toBe('Arquivo ruim');
    expect(lida?.fallback).toBeUndefined();
  });
});
