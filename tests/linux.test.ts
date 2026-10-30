import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentInput, saveAgent } from '../server/adapters/claude/agentWrite';
import { browserStatus, EXTENSION_ID } from '../server/browser';
import { killTree } from '../server/chat/registry';
import { openLoginTerminal } from '../server/auth';

// Caminhos e processos do Linux/macOS (o que o Windows não exercita): grupo de processos, navegador no ~/.config e
// a ferramenta PowerShell fora do Windows.
const unix = process.platform !== 'win32';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!unix)('encerrar a árvore no Unix', () => {
  it('killTree leva o grupo inteiro: o processo líder e o que ele abriu', async () => {
    // Como o ChatProcess: líder do próprio grupo, com um filho que não termina sozinho.
    const leader = spawn('sh', ['-c', 'sleep 300 & sleep 300; wait'], { detached: true, stdio: 'ignore' });
    leader.unref();
    const pid = leader.pid!;
    const childPid = Number(execFileSync('sh', ['-c', `pgrep -P ${pid} sleep || true`], { encoding: 'utf8' }).trim().split('\n')[0]);
    expect(childPid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(true);
    await killTree(pid);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(pid)).toBe(false);
    expect(alive(childPid)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'linux')('navegador no Linux', () => {
  let home: string;
  let oldHome: string | undefined;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(async () => {
    process.env.HOME = oldHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('acha a extensão no perfil do Chromium e a ponte no NativeMessagingHosts', async () => {
    const profile = path.join(home, '.config', 'chromium', 'Default', 'Extensions', EXTENSION_ID);
    await fs.mkdir(profile, { recursive: true });
    const hosts = path.join(home, '.config', 'chromium', 'NativeMessagingHosts');
    await fs.mkdir(hosts, { recursive: true });
    await fs.writeFile(path.join(hosts, 'com.anthropic.claude_code_browser_extension.json'), '{}');
    const status = await browserStatus(true);
    expect(status.extension).toBe(true);
    expect(status.bridge).toBe(true);
  });

  it('sem extensão nem ponte: diz false, não null', async () => {
    const status = await browserStatus(true);
    expect(status.extension).toBe(false);
    expect(status.bridge).toBe(false);
  });
});

describe('ferramenta PowerShell', () => {
  it('fora do Windows sai da lista de ferramentas do agente', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ps-'));
    try {
      const input = AgentInput.parse({
        name: 'executor',
        description: 'Executa tarefas.',
        tools: ['Read', 'Bash', 'PowerShell'],
        prompt: 'Faça a tarefa.',
      });
      const dir = path.join(root, '.claude', 'agents');
      const a = await saveAgent(dir, input, path.join(root, 'bk'));
      const raw = await fs.readFile(path.join(dir, 'executor.md'), 'utf8');
      if (process.platform === 'win32') expect(raw).toContain('PowerShell');
      else expect(raw).not.toContain('PowerShell');
      expect(a.name).toBe('executor');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('login num terminal no Linux', () => {
  it('abre o primeiro terminal que existe no PATH, com o login dentro', async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-term-'));
    const oldPath = process.env.PATH;
    try {
      const out = path.join(bin, 'args.txt');
      // Terminal de mentira: grava os argumentos que recebeu.
      await fs.writeFile(path.join(bin, 'xterm'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`, { mode: 0o755 });
      process.env.PATH = bin;
      const r = openLoginTerminal();
      expect(r).toEqual({ ok: true, command: 'claude auth login --claudeai', error: null });
      for (let i = 0; i < 50; i++) {
        if (await fs.stat(out).then(() => true, () => false)) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      const args = await fs.readFile(out, 'utf8');
      expect(args).toContain('claude auth login --claudeai');
    } finally {
      process.env.PATH = oldPath;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });

  it('sem terminal instalado: erro claro, sem abrir nada', async () => {
    const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-noterm-'));
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = bin;
      const r = openLoginTerminal();
      expect(r.ok).toBe(false);
      expect(r.error).toContain('nenhum terminal');
    } finally {
      process.env.PATH = oldPath;
      await fs.rm(bin, { recursive: true, force: true });
    }
  });
});
