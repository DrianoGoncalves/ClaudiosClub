import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, readUpdateStatus } from '../server/selfUpdate';

// Um "GitHub" de mentira (repositório bare), o clone em que o Claudio’s Club roda e outro clone que publica
// as versões (tags).

let dir: string;
let app: string;
let dev: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function commit(cwd: string, file: string, text: string, msg: string) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

const noInstall = async () => ({ ok: true, out: '', err: '' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-'));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  dev = path.join(dir, 'dev');
  git(dir, 'clone', '-q', remote, dev);
  git(dev, 'checkout', '-q', '-b', 'main');
  commit(dev, 'README.md', 'v1\n', 'primeira');
  git(dev, 'push', '-q', '-u', 'origin', 'main');
  app = path.join(dir, 'app');
  git(dir, 'clone', '-q', remote, app);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Publica uma versão: tag anotada com as notas, enviada ao remoto. */
function release(tag: string, notes = `versão ${tag}`) {
  git(dev, 'tag', '-a', tag, '-m', notes);
  git(dev, 'push', '-q', 'origin', tag);
}

describe('atualizar o Claudio’s Club pela versão publicada no GitHub', () => {
  it('sem versão publicada, não há o que atualizar', async () => {
    commit(dev, 'a.txt', 'a\n', 'no main, sem versão');
    git(dev, 'push', '-q');
    const s = await readUpdateStatus(app);
    expect(s).toMatchObject({ supported: true, latest: null, behind: 0, diverged: false, dirty: false, error: null });
    await expect(applyUpdate(app, noInstall)).rejects.toThrow(/mais nova/);
  });

  it('o que foi mesclado no main não chega antes da versão', async () => {
    release('v0.1.0');
    git(app, 'fetch', '-q', '--tags');
    git(app, 'merge', '-q', '--ff-only', 'v0.1.0');
    commit(dev, 'a.txt', 'a\n', 'só no main');
    git(dev, 'push', '-q');
    expect(await readUpdateStatus(app)).toMatchObject({ current: 'v0.1.0', latest: 'v0.1.0', behind: 0 });
  });

  it('avança até a versão mais nova, com as notas, e para nela', async () => {
    release('v0.1.0');
    commit(dev, 'a.txt', 'a\n', 'novidade um');
    commit(dev, 'b.txt', 'b\n', 'novidade dois');
    git(dev, 'push', '-q');
    release('v0.2.0', 'Versão 0.2\n\nDuas novidades.');
    commit(dev, 'c.txt', 'c\n', 'depois da versão');
    git(dev, 'push', '-q');

    const s = await readUpdateStatus(app);
    expect(s.latest).toBe('v0.2.0');
    expect(s.behind).toBe(2);
    expect(s.notes).toBe('Versão 0.2\n\nDuas novidades.');
    expect(s.commits.map((c) => c.subject)).toEqual(['novidade dois', 'novidade um']);

    const r = await applyUpdate(app, noInstall);
    expect(r).toMatchObject({ to: 'v0.2.0', installed: false });
    expect(fs.existsSync(path.join(app, 'b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(app, 'c.txt'))).toBe(false);
    expect(await readUpdateStatus(app, { fetch: false })).toMatchObject({ current: 'v0.2.0', behind: 0 });
  });

  it('a versão mais nova é pela ordem das versões, não pela data', async () => {
    release('v0.9.0');
    commit(dev, 'a.txt', 'a\n', 'nova');
    git(dev, 'push', '-q');
    release('v0.10.0');
    expect((await readUpdateStatus(app)).latest).toBe('v0.10.0');
  });

  it('roda o npm install quando o package-lock muda', async () => {
    commit(dev, 'package-lock.json', '{}\n', 'dependências');
    git(dev, 'push', '-q');
    release('v0.2.0');
    let ran = false;
    const r = await applyUpdate(app, async () => ((ran = true), { ok: true, out: '', err: '' }));
    expect(r.installed).toBe(true);
    expect(ran).toBe(true);
  });

  it('não atualiza com arquivo mudado à mão nem com commit local', async () => {
    commit(dev, 'a.txt', 'a\n', 'novidade');
    git(dev, 'push', '-q');
    release('v0.2.0');

    fs.writeFileSync(path.join(app, 'README.md'), 'mexido\n');
    await expect(applyUpdate(app, noInstall)).rejects.toThrow(/mudados à mão/);
    git(app, 'checkout', '-q', '--', 'README.md');

    commit(app, 'meu.txt', 'meu\n', 'meu commit');
    expect((await readUpdateStatus(app)).diverged).toBe(true);
    await expect(applyUpdate(app, noInstall)).rejects.toThrow(/commits que a v0.2.0 não tem/);
  });

  it('pasta sem git não tem o que buscar', async () => {
    expect((await readUpdateStatus(dir)).supported).toBe(false);
  });
});
