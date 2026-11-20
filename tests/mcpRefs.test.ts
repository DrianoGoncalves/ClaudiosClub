import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';

// MCPs da ficha com escopo (server/mcpAccessRefs.ts), a entrada do Club no ~/.claude.json (parseLauncherEntry, clubDefOf), a conversão das
// fichas e a paridade Claude/Codex: as mesmas refs levam os mesmos servidores aos dois motores.

// MYCO_HOME de teste: a conversa (prepareRun) grava hooks e config fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcprefs-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const { convertMcps, duplicateMcpNames, formatMcpRef, isMcpRef, knownFromRefs, parseMcpRef, resolveLegacyMcp } = await import('../server/mcpAccessRefs');
const { buildMcpConfig, clubDefOf, clubSecretId, codexMcpServers, knownMcpNames, McpError } = await import('../server/staff/mcp');
const { mcpLaunchCommand, parseLauncherEntry } = await import('../server/staff/mcpLaunch');
const { convertStaffMcps } = await import('../server/staff/mcpMigration');
const { prepareRun, prepareCodexRun } = await import('../server/staff/launch');
const { setSecret } = await import('../server/secretVault');

const roots: string[] = [home];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});
const tmp = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
};

describe('refs de MCP: formato e conversão (puro)', () => {
  it('formata e lê global:<n> e project:<n>; o resto é recusado', () => {
    expect(formatMcpRef('global', 'fs')).toBe('global:fs');
    expect(parseMcpRef('global:fs')).toEqual({ scope: 'global', name: 'fs' });
    expect(parseMcpRef('project:meu.mcp-2')).toEqual({ scope: 'project', name: 'meu.mcp-2' });
    for (const bad of ['fs', 'club:fs', 'user:fs', 'local:fs', 'global:', 'global:com espaco', 'global:a:b', 'global:__proto__', 'project:constructor', `global:${'x'.repeat(65)}`]) {
      expect(parseMcpRef(bad), bad).toBeNull();
    }
    expect(isMcpRef('global:fs')).toBe(true);
    expect(isMcpRef('project:')).toBe(true); // tem escopo, mesmo que o nome seja inválido: não é convertido de novo
    expect(isMcpRef('fs')).toBe(false);
  });

  it('nome antigo: Projeto se existe lá (como a precedência de antes), senão Global, mesmo que não exista em lugar nenhum', () => {
    const known = { globalNames: ['g', 'ambos'], projectNames: ['p', 'ambos'] };
    expect(resolveLegacyMcp('p', known)).toBe('project:p');
    expect(resolveLegacyMcp('g', known)).toBe('global:g');
    expect(resolveLegacyMcp('ambos', known)).toBe('project:ambos');
    expect(resolveLegacyMcp('sumiu', known)).toBe('global:sumiu');
  });

  it('converte a lista: refs ficam, nome antigo vira ref, repetido sai, a ordem segue; null (todos) não muda; changed só quando mudou', () => {
    const known = { globalNames: ['g'], projectNames: ['p'] };
    expect(convertMcps(['p', 'global:g', 'g', 'project:p', 'x'], known)).toEqual({ mcps: ['project:p', 'global:g', 'global:x'], changed: true });
    expect(convertMcps(['global:g', 'project:p'], known)).toEqual({ mcps: ['global:g', 'project:p'], changed: false });
    expect(convertMcps([], known)).toEqual({ mcps: [], changed: false });
    expect(convertMcps(null, known)).toEqual({ mcps: null, changed: false });
  });

  it('knownFromRefs e duplicateMcpNames', () => {
    expect(knownFromRefs(['global:a', 'project:b', 'lixo', 'global:c'])).toEqual({ globalNames: ['a', 'c'], projectNames: ['b'] });
    expect(duplicateMcpNames(['global:a', 'project:a', 'global:b', 'project:c'])).toEqual(['a']);
    expect(duplicateMcpNames(['global:a', 'global:a'])).toEqual([]);
    expect(duplicateMcpNames(null)).toEqual([]);
  });
});

describe('parseLauncherEntry: a entrada do Club é a que chama o lançador com o nome do servidor', () => {
  const dev = mcpLaunchCommand(false);
  const bundle = { command: 'C:/node/node.exe', args: ['C:/club/dist/mcp-launch.mjs'] };

  it('stdio (lançador em desenvolvimento ou o pacote): servidor, biblioteca e cofre', () => {
    for (const l of [dev, bundle]) {
      const e = { type: 'stdio', command: l.command, args: [...l.args, '--server', 'fs', '--club', 'C:/x/mcps.json', '--vault', 'C:/x/secrets'] };
      expect(parseLauncherEntry(e)).toMatchObject({ server: 'fs', club: 'C:/x/mcps.json', vault: 'C:/x/secrets', headers: false });
    }
  });

  it('http com cabeçalho: pelo headersHelper (as partes entre aspas)', () => {
    const helper = [bundle.command, ...bundle.args, '--headers', '--server', 'web', '--club', 'C:/x/mcps.json', '--vault', 'C:/x/s'].map((p) => `"${p}"`).join(' ');
    expect(parseLauncherEntry({ type: 'http', url: 'https://a.dev', headersHelper: helper })).toMatchObject({ server: 'web', headers: true, club: 'C:/x/mcps.json' });
  });

  it('o que não é do Club não é reconhecido: entrada comum, sem --server, nome inválido, arquivo do Codex (--snapshot), args que não são texto', () => {
    expect(parseLauncherEntry({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'] })).toBeNull();
    expect(parseLauncherEntry({ type: 'http', url: 'https://a.dev' })).toBeNull();
    expect(parseLauncherEntry({ type: 'stdio', command: 'node', args: [...bundle.args] })).toBeNull();
    expect(parseLauncherEntry({ type: 'stdio', command: 'node', args: [...bundle.args, '--server', '../x'] })).toBeNull();
    expect(parseLauncherEntry({ type: 'stdio', command: 'node', args: [...bundle.args, '--snapshot', 'C:/s.json', '--server', 'fs'] })).toBeNull();
    expect(parseLauncherEntry({ type: 'stdio', command: 'node', args: [...bundle.args, '--server', 1] })).toBeNull();
    expect(parseLauncherEntry({ type: 'stdio', command: 'node-outro', args: ['meu-mcp-launch.mjs', '--server', 'fs'] })).toBeNull();
    expect(parseLauncherEntry({ headersHelper: 42 })).toBeNull();
  });

  it('clubDefOf: só vale com o nosso arquivo de biblioteca e com a definição nele (nada de __proto__)', () => {
    const club = { servers: { fs: { type: 'stdio' as const, command: 'node' } } };
    const here = path.resolve('x-club', 'mcps.json');
    const entry = (name: string, clubFile: string) => ({ type: 'stdio', command: bundle.command, args: [...bundle.args, '--server', name, '--club', clubFile, '--vault', 'V'] });
    expect(clubDefOf(entry('fs', here), club, here)).toEqual({ name: 'fs', def: { type: 'stdio', command: 'node' } });
    expect(clubDefOf(entry('fs', here), club, path.join(path.resolve('x-club'), '..', 'x-club', 'mcps.json'))).not.toBeNull(); // o mesmo arquivo, escrito de outro jeito
    expect(clubDefOf(entry('fs', path.resolve('outro', 'mcps.json')), club, here)).toBeNull();
    expect(clubDefOf(entry('nao-existe', here), club, here)).toBeNull();
    expect(clubDefOf(entry('__proto__', here), club, here)).toBeNull();
    expect(clubDefOf(entry('fs', here), null, here)).toBeNull();
    expect(clubDefOf({ command: 'npx' }, club, here)).toBeNull();
  });
});

describe('knownMcpNames: o que existe agora, para converter nome antigo', () => {
  it('Global (mcpServers), Projeto (.mcp.json e o escopo local); arquivo que não existe = nenhum; nome inválido não conta', async () => {
    const dir = await tmp('myco-known-');
    const proj = path.join(dir, 'p');
    await fs.mkdir(proj);
    const claude = path.join(dir, 'claude.json');
    expect(await knownMcpNames(proj, claude)).toEqual({ globalNames: [], projectNames: [] });

    await fs.writeFile(claude, JSON.stringify({ mcpServers: { g1: {}, 'com espaco': {} }, projects: { [proj]: { mcpServers: { local1: {} } }, 'C:\\outro': { mcpServers: { alheio: {} } } } }));
    await fs.writeFile(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { p1: {}, local1: {} } }));
    const k = await knownMcpNames(proj, claude);
    expect(k.globalNames).toEqual(['g1']);
    expect([...k.projectNames].sort()).toEqual(['local1', 'p1']);
  });

  it('arquivo que existe e não é JSON: lança (converter no escuro mandaria nome de projeto para a Global)', async () => {
    const dir = await tmp('myco-known-bad-');
    const claude = path.join(dir, 'claude.json');
    await fs.writeFile(claude, '{ quebrado');
    await expect(knownMcpNames(dir, claude)).rejects.toThrow(McpError);
    await fs.writeFile(claude, '{}');
    await fs.writeFile(path.join(dir, '.mcp.json'), '[1]');
    await expect(knownMcpNames(dir, claude)).rejects.toThrow('.mcp.json');
  });
});

describe('convertStaffMcps: fichas com nome antigo viram refs', () => {
  const profile = (id: string, mcps: string[] | null): StaffProfile => ({ id, name: id, mcps }) as unknown as StaffProfile;

  it('regrava só a ficha que tem nome antigo, guarda o `mcps` de antes; null e refs ficam', async () => {
    const saved: StaffProfile[] = [];
    const staff = [profile('velha', ['p', 'g']), profile('nova', ['global:g']), profile('todos', null), profile('vazia', [])];
    const r = await convertStaffMcps({
      projects: [{ id: 'proj', path: '/x/proj' }],
      known: async () => ({ globalNames: ['g'], projectNames: ['p'] }),
      list: async () => staff,
      save: async (_p, p) => void saved.push(p),
    });
    expect(r.changed).toEqual([{ projectId: 'proj', staffId: 'velha', before: ['p', 'g'] }]);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.mcps).toEqual(['project:p', 'global:g']);
    expect(r.skipped).toEqual([]);
  });

  it('só lê os MCPs do projeto quando há o que converter; projeto que não dá para ler fica de fora (nada regravado)', async () => {
    const known = vi.fn(async () => ({ globalNames: [], projectNames: [] }));
    const saved: StaffProfile[] = [];
    const r1 = await convertStaffMcps({ projects: [{ id: 'a', path: '/a' }], known, list: async () => [profile('x', ['global:g'])], save: async (_p, p) => void saved.push(p) });
    expect(known).not.toHaveBeenCalled();
    expect(r1.changed).toEqual([]);

    const r2 = await convertStaffMcps({
      projects: [{ id: 'quebrado', path: '/q' }, { id: 'bom', path: '/b' }],
      known: async (p) => {
        if (p.id === 'quebrado') throw new McpError('não é JSON');
        return { globalNames: ['g'], projectNames: [] };
      },
      list: async () => [profile('y', ['g'])],
      save: async (_p, p) => void saved.push(p),
    });
    expect(r2.skipped).toEqual(['quebrado']);
    expect(r2.changed.map((c) => c.projectId)).toEqual(['bom']);
    expect(saved).toHaveLength(1);
  });
});

describe('paridade Claude/Codex: as mesmas refs levam os mesmos servidores aos dois motores', () => {
  const VALOR = 'valor-do-cofre-PAR-123';
  const LAUNCH = { command: 'C:/node/node.exe', args: ['C:/club/dist/mcp-launch.mjs'] };

  /** Global: um do Club (stdio com env no cofre, pelo lançador), um comum e um que repete o nome de um do Projeto. Projeto: um do .mcp.json, um local e o `dup`. */
  async function setup() {
    const dir = await tmp('myco-parity-');
    const proj = path.join(dir, 'projeto');
    await fs.mkdir(proj, { recursive: true });
    const claude = path.join(dir, 'claude.json');
    const club = path.join(dir, 'mcps.json');
    const vault = { dir: path.join(dir, 'secrets'), platform: 'linux' as const };
    await fs.writeFile(club, JSON.stringify({ servers: { fs: { type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'] } } }));
    await setSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), VALOR, vault);
    const launch = mcpLaunchCommand();
    await fs.writeFile(
      claude,
      JSON.stringify({
        mcpServers: {
          fs: { type: 'stdio', command: launch.command, args: [...launch.args, '--server', 'fs', '--club', club, '--vault', vault.dir] },
          comum: { type: 'stdio', command: 'node', args: ['comum.js'] },
          dup: { type: 'stdio', command: 'node', args: ['global-dup.js'] },
        },
        projects: { [proj]: { enableAllProjectMcpServers: true, mcpServers: { so_local: { type: 'stdio', command: 'node', args: ['local.js'] } } } },
      }),
    );
    await fs.writeFile(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { so_json: { type: 'stdio', command: 'node', args: ['json.js'] }, dup: { type: 'stdio', command: 'node', args: ['proj-dup.js'] } } }));
    return { dir, proj, claude, club, vault, launch };
  }

  const codex = (env: Awaited<ReturnType<typeof setup>>, names: string[] | null) =>
    codexMcpServers(env.proj, names, env.claude, {
      snapshotFile: path.join(env.dir, 'codex-mcp.json'),
      launcher: LAUNCH,
      clubFile: env.club,
      vault: env.vault,
      toolsFile: path.join(env.dir, 'tools.json'),
      env: {},
    });

  it('a mesma lista de refs: os mesmos nomes no --mcp-config do Claude e nos -c do Codex; o mesmo nome nas duas escopos, só o do Projeto', async () => {
    const env = await setup();
    const refs = ['global:fs', 'global:comum', 'project:so_json', 'project:so_local', 'global:dup', 'project:dup', 'global:nao-existe'];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const claude = await buildMcpConfig(env.proj, refs, env.claude, { clubFile: env.club, vault: env.vault });
    const cx = await codex(env, refs);
    warn.mockRestore();
    expect(Object.keys(claude.mcpServers).sort()).toEqual(['comum', 'dup', 'fs', 'so_json', 'so_local']);
    expect(cx.servers.map((s) => s.name).sort()).toEqual(Object.keys(claude.mcpServers).sort());
    expect(claude.mcpServers.dup).toMatchObject({ args: ['proj-dup.js'] });
    const snap = JSON.parse(await fs.readFile(path.join(env.dir, 'codex-mcp.json'), 'utf8')) as { servers: Record<string, { args: string[] }> };
    expect(snap.servers.dup!.args).toEqual(['proj-dup.js']);
    // O do Club: o Claude recebe o lançador de agora, e o Codex o do pacote; nenhum valor do cofre em nenhum dos dois.
    expect(claude.mcpServers.fs).toEqual({ type: 'stdio', command: env.launch.command, args: [...env.launch.args, '--server', 'fs', '--club', env.club, '--vault', env.vault.dir] });
    expect(cx.servers.find((s) => s.name === 'fs')).toEqual({ name: 'fs', command: LAUNCH.command, args: [...LAUNCH.args, '--server', 'fs', '--club', env.club, '--vault', env.vault.dir] });
    expect(JSON.stringify({ claude, cx })).not.toContain(VALOR);
  });

  it('cada escopo sozinho: global:<n> e project:<n> escolhem o servidor certo nos dois motores', async () => {
    const env = await setup();
    const g = await buildMcpConfig(env.proj, ['global:dup'], env.claude, { clubFile: env.club, vault: env.vault });
    const p = await buildMcpConfig(env.proj, ['project:dup'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(g.mcpServers.dup).toMatchObject({ args: ['global-dup.js'] });
    expect(p.mcpServers.dup).toMatchObject({ args: ['proj-dup.js'] });
    await codex(env, ['global:dup']);
    expect(JSON.parse(await fs.readFile(path.join(env.dir, 'codex-mcp.json'), 'utf8')).servers.dup.args).toEqual(['global-dup.js']);
    await codex(env, ['project:dup']);
    expect(JSON.parse(await fs.readFile(path.join(env.dir, 'codex-mcp.json'), 'utf8')).servers.dup.args).toEqual(['proj-dup.js']);
  });

  const ficha = (over: Partial<StaffProfile>): StaffProfile =>
    ({
      id: 'ana-1a2b',
      projectId: 'proj',
      name: 'Ana',
      role: 'Dev',
      portrait: null,
      reportsTo: [],
      mission: 'm',
      firstTask: '',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      doneWhen: '',
      model: null,
      effort: null,
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      browser: false,
      sessions: [],
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:00.000Z',
      ...over,
    }) as StaffProfile;

  it('mcps null (todos): o Claude não recebe a Global no --mcp-config (o Claude Code a carrega sozinho, sem strictMcp); com lista, recebe e liga o strict; o Codex recebe todos', async () => {
    const env = await setup();
    const ctx = { company: 'Empresa', projectName: 'Projeto', projectPath: env.proj, managerNames: [], mycoUrl: 'http://127.0.0.1:1', runDir: path.join(env.dir, 'run'), claudeConfigFile: env.claude, serverKeys: [], servers: [] };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const todos = await prepareRun(ficha({ mcps: null }), ctx, randomUUID(), env.proj);
      expect(todos.strictMcp).toBe(false);
      const cfgTodos = todos.mcpConfigPath ? (JSON.parse(await fs.readFile(todos.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> }) : { mcpServers: {} };
      for (const n of ['fs', 'comum', 'dup', 'so_json', 'so_local']) expect(Object.keys(cfgTodos.mcpServers), n).not.toContain(n);

      const lista = await prepareRun(ficha({ mcps: ['global:fs', 'project:so_json'] }), ctx, randomUUID(), env.proj);
      expect(lista.strictMcp).toBe(true);
      const cfgLista = JSON.parse(await fs.readFile(lista.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(cfgLista.mcpServers).filter((k) => !k.startsWith('myco-'))).toEqual(['fs', 'so_json']);

      const cx = await prepareCodexRun(ficha({ mcps: null, engine: 'codex' }), { ...ctx, mcpLauncher: LAUNCH }, randomUUID(), env.proj);
      expect(cx.extraMcps.map((m) => m.name).sort()).toEqual(['comum', 'dup', 'fs', 'so_json', 'so_local']);
      const cxLista = await prepareCodexRun(ficha({ mcps: ['global:fs', 'project:so_json'], engine: 'codex' }), { ...ctx, mcpLauncher: LAUNCH }, randomUUID(), env.proj);
      expect(cxLista.extraMcps.map((m) => m.name)).toEqual(['fs', 'so_json']);
    } finally {
      warn.mockRestore();
    }
  });
});
