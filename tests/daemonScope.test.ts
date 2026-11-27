import { describe, expect, it } from 'vitest';
import { daemonCommand } from '../scripts/lib';

// O vigia no Linux sobe num escopo próprio do systemd (fora do cgroup do xdg-desktop-portal que trata o myco://).

const NODE = '/usr/bin/node';
const ARGS = ['/home/u/claudios/dist/server/daemon.mjs', '--port', '4848'];

describe('daemonCommand', () => {
  it('Linux com systemd do usuário: embrulha em systemd-run --scope, com o mesmo comando e argumentos', () => {
    expect(daemonCommand(NODE, ARGS, { platform: 'linux', scope: true, stamp: 123 })).toEqual({
      cmd: 'systemd-run',
      args: [
        '--user',
        '--scope',
        '--quiet',
        '--collect',
        '--slice=app.slice',
        '--unit=app-claudios-123',
        "--description=Claudio's Club",
        '--',
        NODE,
        ...ARGS,
      ],
    });
  });

  it('Linux sem systemd-run utilizável: o comando de sempre', () => {
    expect(daemonCommand(NODE, ARGS, { platform: 'linux', scope: false })).toEqual({ cmd: NODE, args: ARGS });
    expect(daemonCommand(NODE, ARGS, { platform: 'linux' })).toEqual({ cmd: NODE, args: ARGS });
  });

  it('fora do Linux: o comando de sempre, mesmo que peçam escopo', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(daemonCommand(NODE, ARGS, { platform, scope: true, stamp: 1 })).toEqual({ cmd: NODE, args: ARGS });
    }
  });

  it('cada subida usa um nome de unidade próprio (sem stamp, vem do relógio)', () => {
    const a = daemonCommand(NODE, ARGS, { platform: 'linux', scope: true, stamp: 'a' }).args.find((x) => x.startsWith('--unit='));
    const b = daemonCommand(NODE, ARGS, { platform: 'linux', scope: true, stamp: 'b' }).args.find((x) => x.startsWith('--unit='));
    expect(a).not.toBe(b);
    expect(daemonCommand(NODE, ARGS, { platform: 'linux', scope: true }).args).toContainEqual(expect.stringMatching(/^--unit=app-claudios-\d+$/));
  });

  it('o vigia que o `daily start` sobe fica fora da lista do systemd-oomd (omit) e não para quando o kernel mata um processo dele (OOMPolicy=continue)', () => {
    const c = daemonCommand(NODE, ARGS, { platform: 'linux', scope: true, stamp: 123, oom: 'omit', keepOnOom: true });
    expect(c.args).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--slice=app.slice',
      '--unit=app-claudios-123',
      "--description=Claudio's Club",
      '--property=ManagedOOMPreference=omit',
      '--property=OOMPolicy=continue',
      '--',
      NODE,
      ...ARGS,
    ]);
  });

  it('o `daily start` pede omit + keepOnOom ao subir o vigia', async () => {
    const { promises: fs } = await import('node:fs');
    const path = await import('node:path');
    const src = await fs.readFile(path.join(__dirname, '..', 'scripts', 'daily.ts'), 'utf8');
    expect(src).toMatch(/daemonCommand\(process\.execPath, \[\.\.\.daemon, '--port', String\(port\)\], \{ scope: systemdScopeUsable\(\), oom: 'omit', keepOnOom: true \}\)/);
  });
});

