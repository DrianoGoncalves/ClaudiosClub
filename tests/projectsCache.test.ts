import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../server/adapters/claude';
import { encodeProjectDir } from '../server/adapters/claude/paths';
import { removeTemp } from './support/tmp';

// O resumo dos projetos (`listProjects`) lê todo transcript e quase toda rota passa por ele: com `projectsTtlMs` fica guardado, e muda na hora
// quando o projeto muda (novo projeto: `forgetProjects`; apelido: nem entra no que fica guardado).

let root: string;
let home: string;
let configFile: string;
let projA: string;
let projB: string;
let idA: string;

const writeConfig = (...projects: string[]) => fs.writeFile(configFile, JSON.stringify({ projects: Object.fromEntries(projects.map((p) => [p, {}])) }));
const transcript = (project: string, name: string) => fs.writeFile(path.join(home, 'projects', encodeProjectDir(path.resolve(project)), `${name}.jsonl`), '{}\n');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-projcache-'));
  home = path.join(root, 'home', '.claude');
  configFile = path.join(root, 'home', '.claude.json');
  projA = path.join(root, 'work', 'projA');
  projB = path.join(root, 'work', 'projB');
  idA = encodeProjectDir(path.resolve(projA));
  await fs.mkdir(projA, { recursive: true });
  await fs.mkdir(projB, { recursive: true });
});
afterAll(() => removeTemp(root));
beforeEach(async () => {
  // Cada teste começa com só o projA, sem conversa. O relógio é falso só na data (o disco segue de verdade).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  await fs.rm(path.join(home, 'projects'), { recursive: true, force: true });
  await fs.mkdir(path.join(home, 'projects', idA), { recursive: true });
  await fs.mkdir(path.join(home, 'projects', encodeProjectDir(path.resolve(projB))), { recursive: true });
  await writeConfig(projA);
});
afterEach(() => vi.useRealTimers());

/** Descoberta sem cache (-1): o que segura o resultado é só o cache do resumo. */
const adapter = (opts: ConstructorParameters<typeof ClaudeAdapter>[0] = {}) => new ClaudeAdapter({ locations: { home, configFile }, includeTemp: true, discoveryTtlMs: -1, ...opts });
const byPath = <T extends { path: string }>(list: T[], p: string) => list.find((x) => x.path === path.resolve(p));

describe('listProjects com cache (projectsTtlMs)', () => {
  it('reaproveita o resumo dentro do prazo e relê depois dele', async () => {
    const ad = adapter({ projectsTtlMs: 5_000 });
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 0 });
    await transcript(projA, 's1');
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 0 }); // guardado
    vi.setSystemTime(Date.now() + 4_999);
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 0 });
    vi.setSystemTime(Date.now() + 2);
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 1 });
  });

  it('projeto novo: forgetProjects esquece o resumo e a descoberta, e ele aparece na hora', async () => {
    const ad = adapter({ projectsTtlMs: 5_000 });
    expect((await ad.listProjects()).map((p) => p.path)).toEqual([path.resolve(projA)]);
    await writeConfig(projA, projB);
    expect((await ad.listProjects()).map((p) => p.path)).toEqual([path.resolve(projA)]); // ainda o de antes
    ad.forgetProjects();
    expect((await ad.listProjects()).map((p) => p.path).sort()).toEqual([path.resolve(projA), path.resolve(projB)].sort());
  });

  it('projeto removido: forgetProjects tira da lista', async () => {
    await writeConfig(projA, projB);
    const ad = adapter({ projectsTtlMs: 5_000 });
    expect(await ad.listProjects()).toHaveLength(2);
    await writeConfig(projA);
    expect(await ad.listProjects()).toHaveLength(2);
    ad.forgetProjects();
    expect((await ad.listProjects()).map((p) => p.path)).toEqual([path.resolve(projA)]);
  });

  it('renomear vale na hora, sem esperar o prazo nem forgetProjects (o resumo guardado continua)', async () => {
    const names: Record<string, string> = {};
    const ad = adapter({ projectsTtlMs: 5_000, projectNames: async () => names });
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ name: 'projA', sessionCount: 0 });
    await transcript(projA, 's1');
    names[idA] = 'Apelido A';
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ name: 'Apelido A', sessionCount: 0 }); // nome novo, resumo ainda o guardado
    names[idA] = '';
    expect(byPath(await ad.listProjects(), projA)!.name).toBe('projA'); // sem apelido: o nome da pasta
  });

  it('chamadas juntas dividem uma leitura só', async () => {
    let discoveries = 0;
    const ad = adapter({
      projectsTtlMs: 5_000,
      onBoard: async (refs) => {
        discoveries++;
        return refs;
      },
    });
    await Promise.all([ad.listProjects(), ad.listProjects(), ad.listProjects()]);
    expect(discoveries).toBe(1);
    await ad.listProjects();
    expect(discoveries).toBe(1);
  });

  it('quem recebe a lista pode mexer nela sem estragar a guardada', async () => {
    const ad = adapter({ projectsTtlMs: 5_000 });
    const first = await ad.listProjects();
    first[0]!.name = 'mexi';
    first.pop();
    const second = await ad.listProjects();
    expect(second).toHaveLength(1);
    expect(second[0]!.name).toBe('projA');
  });

  it('sem projectsTtlMs, cada chamada relê (como antes)', async () => {
    const ad = adapter();
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 0 });
    await transcript(projA, 's1');
    expect(byPath(await ad.listProjects(), projA)).toMatchObject({ sessionCount: 1 });
  });
});
