import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountUsage, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import type { CodexRun, CodexRunner } from '../server/adapters/codex';
import type { CodexEnvStatus } from '../server/codexEnv';
import type { CodexModelsResult } from '../server/codexModels';
import { CodexProcess } from '../server/chat/codexProcess';
import { CapabilityError, CodexCapability } from '../server/engineCapability';
import { StaffError } from '../server/staff/store';
import { StaffService, type StaffServiceOptions } from '../server/staff/service';
import { removeTemp } from './support/tmp';

// A conferência do Codex antes de uma troca de motor (StaffService.assertOverrideRunnable com `codexCapability`) e a falha real de sandbox
// que a conversa avisa (CodexProcess.onSandboxFailure). O runner do `codex` é falso: nada roda de verdade.

const OK: CodexRun = { code: 0, stdout: 'myco-ok\n', stderr: '' };
const ENV: CodexEnvStatus = { error: null, version: '0.167.0', networkProxy: true, multiAgent: true, notice: null };
const SECUNDARIO = { engine: 'codex', model: 'gpt-6-sol' } as const;
const SANDBOX_QUEBRADA = 'Failed to create unified exec process: orchestrator_helper_incomplete: setup helper exited successfully before setup completed';

/** Um runner que devolve `result` e guarda as chamadas (args de cada `codex`). */
function runner(result: CodexRun = OK) {
  const calls: string[][] = [];
  const run: CodexRunner = async (args) => {
    calls.push(args);
    return result;
  };
  return { run, calls };
}

/** Quem recusou (o erro lançado); se não recusou, falha o teste. */
async function recusa(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('deveria ter recusado');
}

let root: string;
let projectPath: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-capability-'));
  projectPath = path.join(root, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
});
afterAll(() => removeTemp(root));

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
  new StaffService(adapter, {
    runDir: path.join(root, 'run'),
    claudeConfigFile: path.join(root, 'claude.json'),
    mycoUrl: 'http://127.0.0.1:4848',
    readUsage: noUsage,
    codexEnabled: async () => true,
    codexEnv: async () => ENV,
    ...over,
  });
const base = { role: 'Dev', mission: 'Implementar', autonomy: 'acceptEdits', launch: false };

describe('troca para o Codex: a capacidade antes de abrir (StaffService.assertOverrideRunnable)', () => {
  it('sandbox: outra conversa do Codex viva no Windows recusa com o motivo sandbox, sem sondar', async () => {
    const r = runner();
    const cap = new CodexCapability(r.run, { platform: 'win32', liveCodex: () => ['outra-conversa'] });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Viva' }, true))!.profile;
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO));
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e).toBeInstanceOf(StaffError);
    expect((e as CapabilityError).reason).toBe('sandbox');
    expect(r.calls).toHaveLength(0);
  });

  it('exceptSession: a própria conversa não conta como outra viva', async () => {
    const r = runner();
    const cap = new CodexCapability(r.run, { platform: 'win32', liveCodex: () => ['minha-conversa'] });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Propria' }, true))!.profile;
    await expect(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO, 'minha-conversa')).resolves.toBeUndefined();
    await expect(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO)).rejects.toMatchObject({ reason: 'sandbox' });
  });

  it('sandbox: a sonda que falha recusa com o motivo sandbox e o que o Codex disse', async () => {
    const r = runner({ code: 1, stdout: '', stderr: 'orchestrator_helper_incomplete' });
    const cap = new CodexCapability(r.run, { platform: 'win32' });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Sonda' }, true))!.profile;
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO));
    expect((e as CapabilityError).reason).toBe('sandbox');
    expect(e.message).toContain('orchestrator_helper_incomplete');
  });

  it('sandbox: a falha que a conversa avisou segura a próxima conferência', async () => {
    const r = runner();
    const cap = new CodexCapability(r.run, { platform: 'win32' });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Falha' }, true))!.profile;
    cap.reportFailure(SANDBOX_QUEBRADA);
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO));
    expect((e as CapabilityError).reason).toBe('sandbox');
    expect(e.message).toContain('falhou numa conversa');
  });

  it('sandbox: sem worktree criada, a sonda roda na pasta do projeto e a worktree não é criada', async () => {
    const r = runner();
    const cap = new CodexCapability(r.run, { platform: 'win32' });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Worktree', worktree: true }, true))!.profile;
    await expect(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO)).resolves.toBeUndefined();
    const cwd = r.calls[0]![r.calls[0]!.indexOf('-C') + 1];
    expect(cwd).toBe(projectPath);
    await expect(fs.stat(path.join(projectPath, '.claude', 'worktrees', `myco-${p.id}`))).rejects.toThrow();
  });

  it('agents: agent da ficha que não existe recusa com o motivo agents e o nome', async () => {
    const cap = new CodexCapability(runner().run, { platform: 'win32' });
    const svc = service({ codexCapability: cap });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Agent', agents: ['agente-inexistente-xyz'] }, true))!.profile;
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO));
    expect((e as CapabilityError).reason).toBe('agents');
    expect(e.message).toContain('agente-inexistente-xyz');
  });

  it('agents: um Codex sem subagents (multi_agent) recusa a ficha que tem agents', async () => {
    const cap = new CodexCapability(runner().run, { platform: 'win32' });
    const svc = service({ codexCapability: cap, codexEnv: async () => ({ ...ENV, multiAgent: false }) });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Sem Multi', agents: ['agente-inexistente-xyz'] }, true))!.profile;
    expect(await recusa(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO))).toMatchObject({ reason: 'agents' });
  });

  it('model: modelo fora do catálogo recusa com o motivo model, com a mesma mensagem de antes', async () => {
    const catalogo = { models: [{ slug: 'gpt-6-sol' }], reason: null } as unknown as CodexModelsResult;
    const cap = new CodexCapability(runner().run, { platform: 'win32' });
    const svc = service({ codexCapability: cap, codexCatalog: async () => catalogo });
    const p = (await svc.hire('proj-id', { ...base, name: 'Cap Modelo' }, true))!.profile;
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, { engine: 'codex', model: 'gpt-6.1-sol' }));
    expect((e as CapabilityError).reason).toBe('model');
    expect(e.message).toMatch(/não está no catálogo do Codex/);
  });

  it('sem capability: o modelo recusa como antes (StaffError simples, sem motivo), e agents e sandbox não são conferidos', async () => {
    const catalogo = { models: [{ slug: 'gpt-6-sol' }], reason: null } as unknown as CodexModelsResult;
    const svc = service({ codexCatalog: async () => catalogo });
    const p = (await svc.hire('proj-id', { ...base, name: 'Sem Cap', agents: ['agente-inexistente-xyz'] }, true))!.profile;
    const e = await recusa(svc.assertOverrideRunnable('proj-id', p.id, { engine: 'codex', model: 'gpt-6.1-sol' }));
    expect(e).toBeInstanceOf(StaffError);
    expect(e).not.toBeInstanceOf(CapabilityError);
    await expect(svc.assertOverrideRunnable('proj-id', p.id, SECUNDARIO)).resolves.toBeUndefined();
  });
});

/** Um `codex` falso: `emit` simula o stdout (uma linha JSON por evento), `close` o fim da execução. */
function fakeCodex() {
  const runs: Array<{ emit: (ev: object) => void; close: (code?: number | null) => void }> = [];
  const spawnImpl = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, pid: 6100 + runs.length });
    stdin.on('data', () => {});
    runs.push({
      emit: (ev) => void stdout.write(JSON.stringify(ev) + '\n'),
      close: (code = 0) => void child.emit('close', code),
    });
    return child as never;
  };
  return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
}
const tick = () => new Promise((r) => setTimeout(r, 15));
const profile = { cwd: '/proj', sessionId: 'sb-1', permissionMode: 'default', secrets: { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' } };

describe('CodexProcess: falha real de sandbox avisa a capacidade', () => {
  it('comando que falhou com a sandbox quebrada chama onSandboxFailure com a saída', async () => {
    const f = fakeCodex();
    const seen: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSandboxFailure: (t) => seen.push(t) });
    chat.start();
    chat.send('rode algo');
    await tick();
    f.last().emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'dir', aggregated_output: SANDBOX_QUEBRADA, exit_code: null, status: 'failed' } });
    await tick();
    expect(seen).toEqual([SANDBOX_QUEBRADA]);
    // A conversa mostra o comando como sempre, com a falha.
    expect(chat.snapshot().items.find((i) => i.kind === 'tool')).toMatchObject({ kind: 'tool', isError: true });
    f.last().emit({ type: 'turn.completed', usage: {} });
    f.last().close(0);
    await tick();
  });

  it('comando que falhou por outro motivo não chama onSandboxFailure', async () => {
    const f = fakeCodex();
    const seen: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSandboxFailure: (t) => seen.push(t) });
    chat.start();
    chat.send('leia um arquivo');
    await tick();
    f.last().emit({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: 'cat nao-existe.txt', aggregated_output: 'No such file or directory', exit_code: 1, status: 'failed' } });
    f.last().emit({ type: 'turn.completed', usage: {} });
    await tick();
    f.last().close(0);
    await tick();
    expect(seen).toEqual([]);
  });

  it('turno que termina com erro de sandbox chama onSandboxFailure pelo turn.failed', async () => {
    const f = fakeCodex();
    const seen: string[] = [];
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl, onSandboxFailure: (t) => seen.push(t) });
    chat.start();
    chat.send('oi');
    await tick();
    f.last().emit({ type: 'turn.failed', error: { message: SANDBOX_QUEBRADA } });
    await tick();
    f.last().close(1);
    await tick();
    expect(seen).toEqual([SANDBOX_QUEBRADA]);
  });
});
