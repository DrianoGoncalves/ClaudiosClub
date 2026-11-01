import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../server/adapters/claude';
import { encodeProjectDir } from '../server/adapters/claude/paths';
import { boardFilter } from '../server/board';
import { addExtraProject, readConfig, readExtraProjects, setArchived } from '../server/config';
import { importableList, importProjects } from '../server/importProjects';
import { ProjectError } from '../server/newProject';
import { createProfile, StaffInputSchema } from '../server/staff/store';

// Um ~/.claude falso com projetos de todo tipo: com ficha, sem ficha, do "Novo projeto", o demo, worktrees e pasta sumida.
let root: string;
let home: string;
let cfg: string;
const dir = (name: string) => path.join(root, 'work', name);
const names = (list: Array<{ name: string }>) => list.map((p) => p.name).sort();

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/** Um transcript com 1M de tokens de entrada no Sonnet 5 = US$ 2. */
const transcript = (id: string, model = 'claude-sonnet-5') =>
  JSON.stringify({
    type: 'assistant',
    uuid: id,
    timestamp: new Date().toISOString(),
    message: { model, id, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1_000_000, output_tokens: 0 } },
  });

const hire = (projectPath: string) => createProfile(projectPath, 'x', StaffInputSchema.parse({ name: 'Bia', role: 'Dev', mission: 'Ajudar' }));

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-board-'));
  home = path.join(root, 'home', '.claude');
  cfg = path.join(root, 'myco-config.json');

  for (const name of ['semFicha', 'comFicha', 'extra', 'demo', 'outro']) await fs.mkdir(dir(name), { recursive: true });
  await hire(dir('comFicha'));
  const wtBoard = path.join(dir('comFicha'), '.claude', 'worktrees', 'wt');
  const wtOff = path.join(dir('semFicha'), '.claude', 'worktrees', 'wt');
  await fs.mkdir(wtBoard, { recursive: true });
  await fs.mkdir(wtOff, { recursive: true });
  // O git leva o `.myco/staff` para dentro da worktree: isso não promove a worktree de um projeto que está fora.
  await hire(wtOff);

  await write(
    path.join(root, 'home', '.claude.json'),
    JSON.stringify({ projects: { [dir('semFicha')]: {}, [dir('comFicha')]: {}, [dir('extra')]: {}, [dir('outro')]: {}, [dir('sumiu')]: {}, [wtBoard]: {}, [wtOff]: {} } }),
  );
  await addExtraProject(dir('extra'), cfg);

  // Cada projeto gastou US$ 2 (um transcript).
  for (const name of ['semFicha', 'comFicha', 'extra', 'demo']) {
    await write(path.join(home, 'projects', encodeProjectDir(dir(name)), `s-${name}.jsonl`), transcript(`m-${name}`) + '\n');
  }
  // Um modelo sem preço, só num projeto de fora.
  await fs.appendFile(path.join(home, 'projects', encodeProjectDir(dir('semFicha')), 's-semFicha.jsonl'), transcript('m-novo', 'modelo-novo') + '\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function adapter(filtered = true, configFile = cfg, discoveryTtlMs = 0) {
  const pinned = async () => [dir('demo'), ...(await readExtraProjects(configFile))];
  return new ClaudeAdapter({
    locations: { home, configFile: path.join(root, 'home', '.claude.json') },
    includeTemp: true, // a fixture fica na pasta temporária
    extraPaths: pinned,
    ...(filtered ? { onBoard: boardFilter({ pinned }) } : {}),
    costCacheFile: path.join(root, `cache-${filtered}.json`),
    discoveryTtlMs,
  });
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; ; i++) {
    const v = await read();
    if (ok(v) || i > 200) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('o que entra no quadro', () => {
  it('projeto sem ficha fica fora; com ficha, de extraProjects e o demo ficam', async () => {
    const list = await adapter().listProjects();
    expect(names(list.filter((p) => !p.worktreeOf))).toEqual(['comFicha', 'demo', 'extra']);
    // Sem o filtro, o adapter continua devolvendo tudo o que o Claude Code conhece.
    expect(names((await adapter(false).listProjects()).filter((p) => !p.worktreeOf))).toEqual(['comFicha', 'demo', 'extra', 'outro', 'semFicha', 'sumiu']);
  });

  it('worktree entra se o projeto-pai entra, e só por ele', async () => {
    const list = await adapter().listProjects();
    const wts = list.filter((p) => p.worktreeOf);
    expect(wts.map((p) => p.worktreeOf)).toEqual([dir('comFicha')]);
    // A sessão ainda vira projeto no adapter: dá para abrir a sala pelo id.
    expect(await adapter().getProject(wts[0]!.id)).not.toBeNull();
    expect(await adapter().getProject(encodeProjectDir(dir('semFicha')))).toBeNull();
  });

  it('a lista de importáveis traz só os de fora, sem worktree e sem pasta que sumiu', async () => {
    const found = await adapter().listImportable();
    expect(names(found)).toEqual(['outro', 'semFicha']);
    expect(await importableList(adapter())).toEqual(
      expect.arrayContaining([{ id: encodeProjectDir(dir('semFicha')), name: 'semFicha', path: dir('semFicha'), lastActivityAt: expect.any(String) }]),
    );
  });

  it('o ranking e os custos só contam os projetos do quadro (o total da conta continua inteiro)', async () => {
    const a = adapter();
    const savings = await until(() => a.getSavingsFiles(null), (r) => !r.scanning && r.files.length > 0);
    expect(savings.files.map((f) => f.projectId).sort()).toEqual([encodeProjectDir(dir('comFicha')), encodeProjectDir(dir('demo')), encodeProjectDir(dir('extra'))].sort());

    const costs = await until(() => a.getCosts(), (c) => !c.scanning);
    expect(Object.keys(costs.projects).sort()).toEqual([encodeProjectDir(dir('comFicha')), encodeProjectDir(dir('demo')), encodeProjectDir(dir('extra'))].sort());
    // A trava de consumo e as porcentagens usam a conta toda.
    expect(costs.total.usd).toBeCloseTo(8, 6);
    expect(costs.models['claude-sonnet-5']).toBeCloseTo(6, 6);
    expect(costs.unpricedModels).toEqual([]); // o modelo sem preço é de um projeto de fora

    // Sem filtro, tudo conta como antes.
    const everything = adapter(false);
    const all = await until(() => everything.getSavingsFiles(null), (r) => !r.scanning && r.files.length > 0);
    expect(all.files).toHaveLength(4);
    expect((await everything.getCosts()).unpricedModels).toEqual(['modelo-novo']);
  });

  it('offBoardRefs: id e pasta de tudo o que ficou fora, worktrees e pasta sumida inclusive', async () => {
    const off = await adapter().offBoardRefs();
    expect(off.map((r) => r.path).sort()).toEqual(
      [dir('semFicha'), dir('outro'), dir('sumiu'), path.join(dir('semFicha'), '.claude', 'worktrees', 'wt')].sort(),
    );
    expect(off.find((r) => r.path === dir('outro'))?.id).toBe(encodeProjectDir(dir('outro')));
    expect(await adapter(false).offBoardRefs()).toEqual([]);
  });
});

describe('regras do filtro', () => {
  it('worktree que o usuário abriu pelo "+ projeto" (está em extraProjects) continua entrando, mesmo com o pai fora', async () => {
    const pinnedWt = path.join(dir('outro'), '.claude', 'worktrees', 'fixa');
    await fs.mkdir(pinnedWt, { recursive: true });
    const file = path.join(root, 'cfg-wt.json');
    await addExtraProject(pinnedWt, file);
    const list = await adapter(true, file).listProjects();
    expect(list.filter((p) => p.worktreeOf).map((p) => p.path).sort()).toEqual([path.join(dir('comFicha'), '.claude', 'worktrees', 'wt'), pinnedWt].sort());
    expect(names(list.filter((p) => !p.worktreeOf))).toEqual(['comFicha', 'demo']); // o pai (outro) continua fora
    // A de fora que ninguém abriu segue fora.
    expect(list.some((p) => p.path.includes('semFicha'))).toBe(false);
  });

  it('ficha = arquivo <id>.json em .myco/staff; o conteúdo não é lido e o resto da pasta não conta', async () => {
    const ref = (name: string) => ({ id: encodeProjectDir(dir(name)), path: dir(name) });
    const staffAt = (name: string) => path.join(dir(name), '.myco', 'staff');
    await write(path.join(staffAt('soMemoria'), 'bia-1234.memory.md'), '# memória');
    await write(path.join(staffAt('soMemoria'), 'notas.txt'), 'x');
    await fs.mkdir(path.join(staffAt('soMemoria'), 'pasta-1234.json'), { recursive: true });
    await write(path.join(staffAt('fichaQuebrada'), 'bia-1234.json'), '{ isto nem é json');
    await fs.mkdir(dir('semNada'), { recursive: true });
    const refs = ['soMemoria', 'fichaQuebrada', 'semNada'].map(ref);
    const kept = await boardFilter({ pinned: async () => [] })(refs);
    expect(kept.map((r) => r.path)).toEqual([dir('fichaQuebrada')]);
  });

  it('depois de importar o projeto aparece na hora, mesmo com a descoberta em cache', async () => {
    const file = path.join(root, 'cfg-ttl.json');
    const a = adapter(true, file, 60_000);
    const before = names((await a.listProjects()).filter((p) => !p.worktreeOf));
    expect(before).toEqual(['comFicha', 'demo']);
    expect(names(await a.listImportable())).toContain('outro');
    await importProjects(a, { paths: [dir('outro')] }, file);
    expect(names((await a.listProjects()).filter((p) => !p.worktreeOf))).toEqual(['comFicha', 'demo', 'outro']);
    expect(names(await a.listImportable())).not.toContain('outro');
  });
});

describe('importar do Claude Code', () => {
  it('importar põe no quadro (extraProjects), desarquiva e leva ao workspace', async () => {
    const a = adapter();
    const id = encodeProjectDir(dir('semFicha'));
    await setArchived({ kind: 'project', id, archived: true }, cfg);
    const done = await importProjects(a, { paths: [dir('semFicha'), dir('outro')] }, cfg);
    expect(done).toEqual({ projectIds: [id, encodeProjectDir(dir('outro'))], imported: 2 });

    expect(await readExtraProjects(cfg)).toEqual([dir('extra'), dir('semFicha'), dir('outro')]);
    expect(names((await a.listProjects()).filter((p) => !p.worktreeOf))).toEqual(['comFicha', 'demo', 'extra', 'outro', 'semFicha']);
    expect(await a.listImportable()).toEqual([]);
    expect((await readConfig(cfg)).archived.projects).not.toContain(id);
    // A worktree do projeto importado agora acompanha o pai.
    expect((await a.listProjects()).filter((p) => p.worktreeOf).map((p) => p.worktreeOf).sort()).toEqual([dir('comFicha'), dir('semFicha')].sort());
    // Só o que está fora é importável: importar de novo o que já entrou não repete nem dá erro.
    expect(await importProjects(a, { paths: [dir('semFicha')] }, cfg)).toEqual({ projectIds: [id], imported: 0 });
    expect(await readExtraProjects(cfg)).toHaveLength(3);
  });

  it('recusa caminho que o Claude Code não conhece, worktree e pasta que sumiu, sem importar nada', async () => {
    const fresh = path.join(root, 'cfg2.json');
    await addExtraProject(dir('extra'), fresh);
    const a = adapter(true, fresh);
    const wt = path.join(dir('semFicha'), '.claude', 'worktrees', 'wt');
    for (const bad of [path.join(root, 'work', 'nao-e-projeto'), wt, dir('sumiu'), root, 'relativo']) {
      await expect(importProjects(a, { paths: [dir('outro'), bad] }, fresh), bad).rejects.toBeInstanceOf(ProjectError);
    }
    await expect(importProjects(a, { paths: [] }, fresh)).rejects.toThrow('ao menos um');
    await expect(importProjects(a, { paths: [dir('outro')], workspaceId: 'nao-existe' }, fresh)).rejects.toThrow('workspace');
    expect(await readExtraProjects(fresh)).toEqual([dir('extra')]);
  });
});
