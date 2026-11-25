import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inspectRepo, inspectRepoForView, pendingChanges, pendingChangesForView, statusForView, statusOf } from '../server/autoCommit';
import { removeTemp } from './support/tmp';

// As leituras da tela (caixa, contador de commits pendentes, aviso de commit parcial) consultam o git uma vez por projeto para todos que perguntam juntos
// (server/autoCommit.ts, `viewProbe`): antes, cada aviso rodava os 11 comandos do inspectRepo mais o status, todos em paralelo. Aqui: o resultado é o mesmo do
// caminho direto (arquivo, pasta, projeto em subpasta do repositório), quem pergunta junto divide a leitura, e a leitura seguinte vê o git de agora.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let repo: string;
let sub: string;
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
const write = async (dir: string, rel: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text);
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-viewprobe-'));
  repo = path.join(root, 'repo');
  sub = path.join(repo, 'app'); // projeto numa subpasta do repositório (prefixo "app/")
  await fs.mkdir(sub, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  for (const f of ['app/a.ts', 'app/b.ts', 'app/pasta/c.ts', 'app/pasta/d.ts', 'fora.ts']) await write(repo, f, '1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  await write(repo, 'app/a.ts', '2\n'); // modificado
  await write(repo, 'app/pasta/d.ts', '2\n'); // modificado, dentro de pasta
  await write(repo, 'app/novo.ts', 'x\n'); // sem rastreio
  await write(repo, 'fora.ts', '2\n'); // fora do projeto
});
afterAll(() => removeTemp(root));

const sorted = (m: Map<string, unknown>) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

describe('leitura da tela = leitura direta', () => {
  it('o mesmo repositório e o mesmo status por caminho (arquivo, arquivo novo, pasta, sem mudança), no projeto em subpasta', async () => {
    const direct = await inspectRepo(sub);
    const view = await inspectRepoForView(sub);
    expect(view).toEqual(direct);
    expect(direct).toMatchObject({ ok: true, prefix: 'app/' });
    const prefix = direct.ok ? direct.prefix : '';
    const rels = ['a.ts', 'b.ts', 'novo.ts', 'pasta'];
    expect(sorted(await statusForView(sub, prefix, rels))).toEqual(sorted(await statusOf(sub, prefix, rels)));
    // A pasta cobre o que está dentro (como o pathspec): pasta/d.ts entra, pasta/c.ts (sem mudança) não.
    expect([...(await statusForView(sub, prefix, ['pasta'])).values()].map((e) => e.path)).toEqual(['pasta/d.ts']);
  });

  it('pendingChanges da caixa conta o mesmo que o direto; fora de repositório, null nos dois', async () => {
    for (const files of [['a.ts', 'b.ts'], ['a.ts', 'novo.ts', 'pasta/d.ts'], ['b.ts']]) expect(await pendingChangesForView(sub, files)).toBe(await pendingChanges(sub, files));
    const plain = path.join(root, 'sem-git');
    await fs.mkdir(plain);
    expect(await pendingChangesForView(plain, ['a.ts'])).toBeNull();
  });
});

describe('uma leitura por projeto para quem pergunta junto', () => {
  it('perguntas juntas dividem a mesma leitura; a seguinte lê de novo e vê o commit feito à mão', async () => {
    const together = await Promise.all(Array.from({ length: 20 }, () => inspectRepoForView(sub)));
    expect(new Set(together).size).toBe(1); // o mesmo objeto: uma leitura só
    const after = await inspectRepoForView(sub);
    expect(after).not.toBe(together[0]); // terminada a leitura, nada fica guardado
    expect(await pendingChangesForView(sub, ['a.ts'])).toBe(1);
    git(repo, 'commit', '-q', '-m', 'à mão', '--', 'app/a.ts');
    expect(await pendingChangesForView(sub, ['a.ts'])).toBe(0);
  });
});
