import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUpdate, readUpdateStatus } from '../server/selfUpdate';

// Um "GitHub" de mentira (repositório bare), o clone em que o Claudio’s Club roda e outro clone que publica.

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

describe('atualizar o Claudio’s Club pelo GitHub', () => {
  it('em dia, sem novidades', async () => {
    const s = await readUpdateStatus(app);
    expect(s).toMatchObject({ supported: true, upstream: 'origin/main', behind: 0, ahead: 0, dirty: false, commits: [], error: null });
  });

  it('conta as novidades do remoto e avança até elas', async () => {
    commit(dev, 'a.txt', 'a\n', 'novidade um');
    commit(dev, 'b.txt', 'b\n', 'novidade dois');
    git(dev, 'push', '-q');

    const s = await readUpdateStatus(app);
    expect(s.behind).toBe(2);
    expect(s.commits.map((c) => c.subject)).toEqual(['novidade dois', 'novidade um']);

    const r = await applyUpdate(app, noInstall);
    expect(r.installed).toBe(false);
    expect(fs.existsSync(path.join(app, 'b.txt'))).toBe(true);
    expect((await readUpdateStatus(app, { fetch: false })).behind).toBe(0);
  });

  it('roda o npm install quando o package-lock muda', async () => {
    commit(dev, 'package-lock.json', '{}\n', 'dependências');
    git(dev, 'push', '-q');
    let ran = false;
    const r = await applyUpdate(app, async () => ((ran = true), { ok: true, out: '', err: '' }));
    expect(r.installed).toBe(true);
    expect(ran).toBe(true);
  });

  it('não atualiza com arquivo mudado à mão nem com commit local', async () => {
    commit(dev, 'a.txt', 'a\n', 'novidade');
    git(dev, 'push', '-q');

    fs.writeFileSync(path.join(app, 'README.md'), 'mexido\n');
    await expect(applyUpdate(app, noInstall)).rejects.toThrow(/mudados à mão/);
    git(app, 'checkout', '-q', '--', 'README.md');

    commit(app, 'meu.txt', 'meu\n', 'meu commit');
    await expect(applyUpdate(app, noInstall)).rejects.toThrow(/commit\(s\) seus/);
  });

  it('pasta sem git não tem o que buscar', async () => {
    expect((await readUpdateStatus(dir)).supported).toBe(false);
  });
});
