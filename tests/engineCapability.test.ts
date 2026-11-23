import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexRun, CodexRunner } from '../server/adapters/codex';
import { codexWindowsSandboxArgs } from '../server/chat/codexArgs';
import {
  CAPABILITY_FAIL_TTL_MS,
  CAPABILITY_FAILURE_HOLD_MS,
  CAPABILITY_OK_TTL_MS,
  CapabilityError,
  CodexCapability,
  isSandboxFailure,
} from '../server/engineCapability';
import { removeTemp } from './support/tmp';

// A conferência antes de rodar o Codex: a sonda da sandbox no Windows (com cache), a barra depois de falha real e os agents da ficha.
// O runner é falso: nada roda o `codex` de verdade.

const OK: CodexRun = { code: 0, stdout: 'myco-ok\n', stderr: '' };

/** Um runner que devolve `state.result` e guarda as chamadas. */
function fakeRun(first: Partial<CodexRun> = {}) {
  const calls: string[][] = [];
  const state: { result: CodexRun } = { result: { ...OK, ...first } };
  const run: CodexRunner = async (args) => {
    calls.push(args);
    return state.result;
  };
  return { run, calls, state };
}

/** O erro que a chamada lançou; se não lançou, falha o teste. */
async function err(p: Promise<unknown>): Promise<CapabilityError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error('deveria ter recusado');
}

const base = { cwd: 'C:\\Users\\x\\wt', profileArgs: ['-c', 'permissions.mycodeny.filesystem={}'], version: '0.167.0' };

describe('isSandboxFailure: as mensagens reais do Codex no Windows', () => {
  it('reconhece as três mensagens que a sandbox dá quando duas conversas se atropelam', () => {
    expect(isSandboxFailure('Failed to create unified exec process: delete C:\\Users\\x\\.codex\\sandbox_users.json')).toBe(true);
    expect(isSandboxFailure('Windows sandbox setup is missing or out of date; rerun the sandbox setup with elevation')).toBe(true);
    expect(isSandboxFailure('orchestrator_helper_incomplete: setup helper exited successfully before setup completed')).toBe(true);
  });

  it('sem diferenciar maiúsculas, e uma saída comum não casa', () => {
    expect(isSandboxFailure('SANDBOX SETUP IS MISSING')).toBe(true);
    expect(isSandboxFailure('setup marker ausente')).toBe(true);
    expect(isSandboxFailure('erro de rede: ECONNRESET')).toBe(false);
  });
});

describe('CodexCapability.sandbox: outra conversa viva (só Windows)', () => {
  it('no Windows, outra conversa do Codex rodando barra, sem sondar', async () => {
    const { run, calls } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => ['outra'], now: () => 0 });
    const e = await err(cap.sandbox({ ...base, version: '0.167.0', exceptSession: 'eu' }));
    expect(e.reason).toBe('sandbox');
    expect(e.message).toBe('outra conversa do Codex está rodando agora; no Windows duas ao mesmo tempo derrubam a sandbox uma da outra');
    expect(calls).toHaveLength(0);
  });

  it('a própria conversa (exceptSession) não conta: a sonda roda', async () => {
    const { run, calls } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => ['eu'], now: () => 0 });
    await cap.sandbox({ ...base, version: '0.167.0', exceptSession: 'eu' });
    expect(calls).toHaveLength(1);
  });

  it('fora do Windows, outra conversa viva não barra e não há sonda', async () => {
    const { run, calls } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'linux', liveCodex: () => ['outra'], now: () => 0 });
    await cap.sandbox({ ...base, version: '0.167.0' });
    expect(calls).toHaveLength(0);
  });
});

describe('CodexCapability.sandbox: a sonda', () => {
  it('no Windows, roda `codex sandbox` com o perfil, o -C e o elevated; ok com myco-ok e código 0 passa', async () => {
    const { run, calls } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    await cap.sandbox({ ...base, version: '0.167.0' });
    expect(calls).toEqual([
      ['sandbox', '-C', base.cwd, '-P', 'mycodeny', ...base.profileArgs, ...codexWindowsSandboxArgs('win32'), 'cmd', '/c', 'echo myco-ok'],
    ]);
  });

  it('sonda falha (código ≠ 0): recusa com o stderr; sem myco-ok na saída também recusa', async () => {
    const falha = fakeRun({ code: 1, stdout: '', stderr: 'Windows sandbox setup is missing' });
    const cap = new CodexCapability(falha.run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    const e = await err(cap.sandbox({ ...base, version: '0.167.0' }));
    expect(e.reason).toBe('sandbox');
    expect(e.message).toBe('a sandbox do Codex não abriu: Windows sandbox setup is missing');

    const semOk = fakeRun({ code: 0, stdout: 'outra coisa', stderr: '' });
    const cap2 = new CodexCapability(semOk.run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    expect((await err(cap2.sandbox({ ...base, version: '0.167.0' }))).message).toMatch(/^a sandbox do Codex não abriu: saída 0$/);
  });

  it('a mensagem da sonda é cortada em 200 caracteres', async () => {
    const { run } = fakeRun({ code: 1, stdout: '', stderr: 'x'.repeat(500) });
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    const e = await err(cap.sandbox({ ...base, version: '0.167.0' }));
    expect(e.message).toBe(`a sandbox do Codex não abriu: ${'x'.repeat(200)}`);
  });

  it('cache da sonda: a 2ª chamada igual não roda; mudar version, args ou cwd roda de novo', async () => {
    const { run, calls } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    await cap.sandbox({ ...base, version: '0.167.0' });
    await cap.sandbox({ ...base, version: '0.167.0' });
    expect(calls).toHaveLength(1);
    await cap.sandbox({ ...base, version: '0.168.0' });
    expect(calls).toHaveLength(2);
    await cap.sandbox({ ...base, version: '0.168.0', profileArgs: ['-c', 'outro=1'] });
    expect(calls).toHaveLength(3);
    await cap.sandbox({ ...base, version: '0.168.0', profileArgs: ['-c', 'outro=1'], cwd: 'C:\\Users\\x\\outra' });
    expect(calls).toHaveLength(4);
  });

  it('cache de sucesso expira em CAPABILITY_OK_TTL_MS; o de falha, em CAPABILITY_FAIL_TTL_MS (e depois relança a mesma mensagem)', async () => {
    let now = 1_000_000;
    const ok = fakeRun();
    const cap = new CodexCapability(ok.run, { platform: 'win32', liveCodex: () => [], now: () => now });
    await cap.sandbox(base);
    now += CAPABILITY_OK_TTL_MS - 1;
    await cap.sandbox(base);
    expect(ok.calls).toHaveLength(1);
    now += 2;
    await cap.sandbox(base);
    expect(ok.calls).toHaveLength(2);

    const bad = fakeRun({ code: 1, stderr: 'boom' });
    let t = 5_000_000;
    const cap2 = new CodexCapability(bad.run, { platform: 'win32', liveCodex: () => [], now: () => t });
    const msg = 'a sandbox do Codex não abriu: boom';
    expect((await err(cap2.sandbox(base))).message).toBe(msg);
    t += CAPABILITY_FAIL_TTL_MS - 1;
    expect((await err(cap2.sandbox(base))).message).toBe(msg);
    expect(bad.calls).toHaveLength(1);
    bad.state.result = OK;
    t += 2; // passou do prazo da falha: sonda de novo, e agora passa
    await cap2.sandbox(base);
    expect(bad.calls).toHaveLength(2);
  });
});

describe('CodexCapability.reportFailure: a barra depois de falha real', () => {
  it('barra por CAPABILITY_FAILURE_HOLD_MS sem sondar e, depois do hold, volta a sondar', async () => {
    const { run, calls } = fakeRun();
    let now = 0;
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => [], now: () => now });
    await cap.sandbox(base);
    expect(calls).toHaveLength(1);

    cap.reportFailure('Failed to create unified exec process: delete sandbox_users.json');
    now += 1_000;
    const e = await err(cap.sandbox(base));
    expect(e.reason).toBe('sandbox');
    expect(e.message).toBe('a sandbox do Codex falhou numa conversa há pouco: Failed to create unified exec process: delete sandbox_users.json');
    expect(calls).toHaveLength(1); // barrou sem sondar

    now += CAPABILITY_FAILURE_HOLD_MS - 1_000 - 1;
    await expect(cap.sandbox(base)).rejects.toThrow('falhou numa conversa há pouco');
    expect(calls).toHaveLength(1);

    now += 2;
    await cap.sandbox(base);
    expect(calls).toHaveLength(2);
  });

  it('a mensagem guardada também é cortada em 200 caracteres', async () => {
    const { run } = fakeRun();
    const cap = new CodexCapability(run, { platform: 'win32', liveCodex: () => [], now: () => 0 });
    cap.reportFailure('y'.repeat(300));
    const e = await err(cap.sandbox(base));
    expect(e.message).toBe(`a sandbox do Codex falhou numa conversa há pouco: ${'y'.repeat(200)}`);
  });
});

describe('CodexCapability.agents: os agents da ficha', () => {
  let root: string;
  let user: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-capagents-'));
    user = path.join(root, 'user-agents');
    await fs.mkdir(user, { recursive: true });
    await fs.writeFile(path.join(user, 'executor.md'), '---\nname: executor\ndescription: d\nmodel: haiku\ntools: Read\n---\nfaz\n');
  });
  afterAll(() => removeTemp(root));

  const dirs = () => ({ cwd: path.join(root, 'wt'), projectPath: path.join(root, 'proj'), userAgentsDir: user });
  const cap = () => new CodexCapability(fakeRun().run);

  it('sem multi_agent, com agents da ficha: recusa (reason agents)', async () => {
    const e = await err(cap().agents({ wanted: ['executor'], presets: [], multiAgent: false, dirs: dirs() }));
    expect(e.reason).toBe('agents');
    expect(e.message).toBe('este Codex não tem subagents (multi_agent): os agents da ficha não rodariam');
  });

  it('com multi_agent mas um agent sem fonte: recusa com o nome dele', async () => {
    const e = await err(cap().agents({ wanted: ['executor', 'pesquisador'], presets: [], multiAgent: true, dirs: dirs() }));
    expect(e.reason).toBe('agents');
    expect(e.message).toBe('o Codex não tem os agents da ficha: pesquisador');
  });

  it('preset (nativo) não reprova, mesmo sem arquivo; agent com fonte passa', async () => {
    await expect(cap().agents({ wanted: ['general-purpose', 'executor'], presets: ['general-purpose'], multiAgent: true, dirs: dirs() })).resolves.toBeUndefined();
  });

  it('sem agents, passa mesmo sem multi_agent', async () => {
    await expect(cap().agents({ wanted: [], presets: [], multiAgent: false, dirs: dirs() })).resolves.toBeUndefined();
  });
});
