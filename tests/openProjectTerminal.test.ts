import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openProjectTerminalRoute, shellCommand } from '../server/openProjectTerminal';
import { removeTempSync } from './support/tmp';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-term-'));
afterAll(() => removeTempSync(dir));
const env = { SESSIONNAME: 'Console', DISPLAY: ':0', SHELL: '/bin/zsh', MYCO_TOKEN: 'x', GITHUB_TOKEN: 'y', PATH: 'p' };

describe('openProjectTerminalRoute', () => {
  it('abre na pasta do projeto com shell fixo e ambiente sem tokens', async () => {
    const open = vi.fn(() => ({ ok: true, error: null }));
    const r = await openProjectTerminalRoute({ fromBrowser: true, projectDir: dir }, { platform: 'win32', env, open });
    expect(r).toEqual({ opened: true });
    const [cmd, opts] = open.mock.calls[0] as unknown as [string[], { cwd: string; env: NodeJS.ProcessEnv }];
    expect(cmd).toEqual(['cmd.exe', '/k']);
    expect(opts.cwd).toBe(fs.realpathSync(dir));
    expect(opts.env.MYCO_TOKEN).toBeUndefined();
    expect(opts.env.GITHUB_TOKEN).toBeUndefined();
    expect(opts.env.PATH).toBe('p');
  });

  it('403 fora do navegador pareado, sem abrir', async () => {
    const open = vi.fn();
    await expect(openProjectTerminalRoute({ fromBrowser: false, projectDir: dir }, { env, open })).rejects.toMatchObject({ status: 403 });
    expect(open).not.toHaveBeenCalled();
  });

  it('projeto desconhecido devolve null (404 da rota)', async () => {
    expect(await openProjectTerminalRoute({ fromBrowser: true, projectDir: null }, { env, open: vi.fn() })).toBeNull();
  });

  it('pasta que sumiu: folder-missing', async () => {
    await expect(openProjectTerminalRoute({ fromBrowser: true, projectDir: path.join(dir, 'nao-existe') }, { env, open: vi.fn() })).rejects.toMatchObject({
      status: 409,
      extra: { code: 'folder-missing' },
    });
  });

  it('sem sessão gráfica: no-display, sem abrir', async () => {
    const open = vi.fn();
    await expect(openProjectTerminalRoute({ fromBrowser: true, projectDir: dir }, { platform: 'linux', env: { PATH: 'p' }, open })).rejects.toMatchObject({
      extra: { code: 'no-display' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('terminal que falha: no-terminal com texto fixo (sem o erro do sistema)', async () => {
    const open = vi.fn(() => ({ ok: false, error: 'C:\\Users\\x\\segredo' }));
    const err = await openProjectTerminalRoute({ fromBrowser: true, projectDir: dir }, { platform: 'linux', env, open }).catch((e) => e);
    expect(err.extra).toEqual({ code: 'no-terminal' });
    expect(err.message).not.toContain('segredo');
  });
});

describe('shellCommand', () => {
  it('Windows: cmd /k; Linux: SHELL absoluto ou /bin/sh', () => {
    expect(shellCommand('win32', {})).toEqual(['cmd.exe', '/k']);
    expect(shellCommand('linux', { SHELL: '/bin/zsh' })).toEqual(['/bin/zsh']);
    expect(shellCommand('linux', { SHELL: 'zsh -c evil' })).toEqual(['/bin/sh']);
    expect(shellCommand('linux', {})).toEqual(['/bin/sh']);
  });
});
