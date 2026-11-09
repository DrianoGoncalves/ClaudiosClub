import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { guideActionText, MAX_LISTED_FILES, runGuideAction } from '../server/guideActions';
import { guideStatus } from '../server/projectGuide';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=teste', '-c', 'user.email=teste@teste', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
  }).trim();

describe('guia: base da conferência e drift só do que mudou', () => {
  let dir: string;
  let sent: Array<{ staffId: string; text: string; force: boolean }>;
  const ana = { id: 'ana-1', name: 'Ana', role: 'Revisora' } as StaffProfile;
  const deps = () => ({
    readProfile: async (id: string) => (id === 'ana-1' ? ana : null),
    send: async (staffId: string, text: string, force: boolean) => {
      sent.push({ staffId, text, force });
      return 'sess-9';
    },
  });
  const run = (action: 'drift' | 'draft' | 'test') => runGuideAction(deps(), dir, { action, staffId: 'ana-1' });
  const head = () => git(dir, 'rev-parse', 'HEAD');
  const writeIn = async (rel: string, text: string) => {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text, 'utf8');
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-guia-drift-'));
    sent = [];
    git(dir, 'init', '-q');
    await writeIn('SPEC.md', '# Guia\n');
    await writeIn('src/a.ts', 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('drift em git grava o HEAD e a hora em .myco/guide.json; o status mostra a base sem mudanças', async () => {
    await run('drift');
    const saved = JSON.parse(await fs.readFile(path.join(dir, '.myco', 'guide.json'), 'utf8')) as { sha: string; at: string };
    expect(saved.sha).toBe(await head());
    expect(Number.isNaN(Date.parse(saved.at))).toBe(false);
    expect(await guideStatus(dir)).toMatchObject({ isGit: true, lastCheck: { sha: saved.sha }, changedSince: 0 });
  });

  it('conta arquivos mudados desde a base (modificado e novo), sem contar .myco/', async () => {
    await run('drift');
    await writeIn('src/a.ts', 'export const a = 2;\n');
    await writeIn('src/b.ts', 'export const b = 1;\n');
    await writeIn('.myco/tasks.json', '[]\n');
    expect((await guideStatus(dir)).changedSince).toBe(2);
  });

  it('drift sem mudança desde a base não abre conversa e responde skipped', async () => {
    await run('drift');
    const r = await run('drift');
    expect(r).toEqual({ skipped: true, reason: expect.stringMatching(/^sem mudanças desde \d/) });
    expect(sent).toHaveLength(1);
  });

  it('drift com mudança desde a base lista status e caminho, e manda conferir só isso', async () => {
    await run('drift');
    await writeIn('src/a.ts', 'export const a = 2;\n');
    await writeIn('src/b.ts', 'export const b = 1;\n');
    const r = await run('drift');
    expect(r).toEqual({ sessionId: 'sess-9', staffId: 'ana-1' });
    const text = sent[1]!.text;
    expect(text).toContain('- M src/a.ts');
    expect(text).toContain('- ? src/b.ts');
    expect(text).not.toContain('.myco');
    expect(text).toContain('SÓ contra os arquivos mudados listados abaixo');
    expect(text).toContain('Nenhuma divergência');
  });

  it('com mais de 80 arquivos, o texto só traz a contagem e a orientação de varrer por pasta', async () => {
    await run('drift');
    const total = MAX_LISTED_FILES + 5;
    for (let i = 0; i < total; i++) await writeIn(`novos/f${i}.ts`, '\n');
    await run('drift');
    const text = sent[1]!.text;
    expect(text).toContain(`${total} arquivos mudados desde`);
    expect(text).toContain('por pasta de nível alto');
    expect(text).not.toContain('novos/f0.ts');
  });

  it('sha inexistente (ex.: rebase) cai no comportamento antigo e grava uma base nova', async () => {
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(dir, '.myco', 'guide.json'), JSON.stringify({ sha: '1'.repeat(40), at: '2026-11-01T10:00:00.000Z' }), 'utf8');
    expect(await guideStatus(dir)).not.toHaveProperty('lastCheck');
    expect(await guideStatus(dir)).not.toHaveProperty('changedSince');
    await writeIn('src/a.ts', 'export const a = 3;\n');
    await run('drift');
    expect(sent[0]!.text).toBe(guideActionText('drift'));
    expect(await guideStatus(dir)).toMatchObject({ lastCheck: { sha: await head() }, changedSince: 1 });
  });

  it('valor fora do formato de sha na base é tratado como sem base (não vai para o git)', async () => {
    await fs.mkdir(path.join(dir, '.myco'), { recursive: true });
    await fs.writeFile(path.join(dir, '.myco', 'guide.json'), JSON.stringify({ sha: '--output=x', at: '2026-11-01T10:00:00.000Z' }), 'utf8');
    expect(await guideStatus(dir)).not.toHaveProperty('lastCheck');
  });

  it('test não grava base', async () => {
    await run('test');
    await expect(fs.stat(path.join(dir, '.myco', 'guide.json'))).rejects.toThrow();
  });
});
