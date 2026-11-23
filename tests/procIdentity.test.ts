import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLiveSessions } from '../server/adapters/claude/sessions';
import { bootTime, confirmProcess, inspectProcess, startedBeforeBoot } from '../server/procIdentity';
import { removeTemp } from './support/tmp';

describe('bootTime / startedBeforeBoot', () => {
  const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

  it('boot = agora menos o tempo ligado', () => {
    expect(bootTime(NOW, 3600)).toBe(NOW - 3_600_000);
    expect(Math.abs(bootTime() - (Date.now() - os.uptime() * 1000))).toBeLessThan(1000);
  });

  it('antes do boot (com 5 s de folga) é de outra vida do sistema; depois, não', () => {
    const boot = NOW;
    expect(startedBeforeBoot(boot - 3_600_000, boot)).toBe(true);
    expect(startedBeforeBoot(new Date(boot - 3_600_000).toISOString(), boot)).toBe(true);
    expect(startedBeforeBoot(boot - 4_000, boot)).toBe(false);
    expect(startedBeforeBoot(boot + 1, boot)).toBe(false);
    expect(startedBeforeBoot(boot + 3_600_000, boot)).toBe(false);
  });

  it('sem hora, hora vazia ou ilegível: não dá para dizer, não conta como morto', () => {
    for (const v of [undefined, null, '', 'ontem', Number.NaN]) expect(startedBeforeBoot(v, NOW)).toBe(false);
  });
});

describe('confirmProcess', () => {
  const T = Date.UTC(2026, 10, 22, 12, 0, 0);
  const at = (name: string, startedAt: number | null) => async () => ({ name, startedAt });

  it('claude, node e codex (com ou sem .exe, com caminho) são conversa', async () => {
    for (const name of ['claude.exe', 'Claude', 'node', 'NODE.EXE', 'codex.exe', 'C:\\Program Files\\nodejs\\node.exe', '/usr/local/bin/claude'])
      expect(await confirmProcess(10, T, at(name, T)), name).toBe('same');
  });

  it('outra imagem é outro processo, mesmo criada na hora certa', async () => {
    for (const name of ['chrome.exe', 'svchost', 'nodemon', 'claude-helper.exe', 'notnode.exe'])
      expect(await confirmProcess(10, T, at(name, T)), name).toBe('other');
  });

  it('hora de criação: perto da gravada (2 min) é o mesmo; longe é outro; sem hora de um dos lados confia só no nome', async () => {
    expect(await confirmProcess(10, new Date(T).toISOString(), at('claude.exe', T + 47_000))).toBe('same');
    expect(await confirmProcess(10, T, at('claude.exe', T - 60_000))).toBe('same');
    expect(await confirmProcess(10, T, at('claude.exe', T + 600_000))).toBe('other');
    expect(await confirmProcess(10, T, at('claude.exe', T - 3_600_000))).toBe('other');
    expect(await confirmProcess(10, T, at('claude.exe', null))).toBe('same');
    expect(await confirmProcess(10, null, at('claude.exe', T))).toBe('same');
    expect(await confirmProcess(10, '', at('claude.exe', T))).toBe('same');
  });

  it('pid que não existe = gone; falha ao olhar = unknown (nunca same)', async () => {
    expect(await confirmProcess(10, T, async () => null)).toBe('gone');
    expect(
      await confirmProcess(10, T, async () => {
        throw new Error('sem powershell');
      }),
    ).toBe('unknown');
  });
});

describe('inspectProcess (sistema de verdade)', () => {
  it('o próprio processo: nome node e hora de criação perto da de agora menos o tempo de vida', async () => {
    const me = await inspectProcess(process.pid);
    expect(me?.name).toMatch(/node/i);
    expect(me?.startedAt).not.toBeNull();
    expect(Math.abs(me!.startedAt! - (Date.now() - process.uptime() * 1000))).toBeLessThan(60_000);
    expect(await confirmProcess(process.pid, new Date(Date.now() - process.uptime() * 1000).toISOString())).toBe('same');
  }, 60_000);

  it('pid que não existe ou inválido: null (nunca um processo qualquer)', async () => {
    expect(await inspectProcess(2_000_000_000)).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(await inspectProcess(bad)).toBeNull();
  }, 60_000);
});

describe('readLiveSessions: arquivo de sessão de antes do boot', () => {
  let home: string;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-live-'));
    await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  });
  afterAll(() => removeTemp(home));

  const write = (pid: number, startedAt?: number) =>
    fs.writeFile(path.join(home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: `s-${pid}`, status: 'busy', ...(startedAt !== undefined && { startedAt }) }));

  it('pid vivo (o deste teste) com startedAt antes do boot não é conversa viva; depois do boot, é', async () => {
    const boot = bootTime();
    await write(process.pid, boot - 3_600_000);
    expect((await readLiveSessions(home)).find((s) => s.pid === process.pid)).toMatchObject({ alive: false });
    await write(process.pid, Date.now());
    expect((await readLiveSessions(home)).find((s) => s.pid === process.pid)).toMatchObject({ alive: true });
  });

  it('sem startedAt no arquivo: segue só pelo pid', async () => {
    await write(process.pid);
    expect((await readLiveSessions(home)).find((s) => s.pid === process.pid)).toMatchObject({ alive: true });
  });
});
