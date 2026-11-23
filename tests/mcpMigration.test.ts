import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { setSecret } from '../server/secretVault';
import { clubSecretId, knownMcpNames, McpError } from '../server/staff/mcp';
import { parseLauncherEntry } from '../server/staff/mcpLaunch';
import { createMcpLibrary } from '../server/staff/mcpLibrary';
import { migrateClubToGlobal, migrateMcpsAtBoot, repairLauncherEntries, rollbackMcpMigration } from '../server/staff/mcpMigration';
import { migrateToolsKeys, newToolsKey, saveTestedTools, toolsKey } from '../server/staff/mcpTools';

// Migração do registro do Club (~/.myco/mcps.json) para a Global (~/.claude.json): tudo em pastas temporárias, nunca o ~/.claude.json real.

const VALOR = 'valor-do-cofre-MIG-AB12';
const HDR = 'Bearer tok-do-cofre-MIG-987';
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

const REGISTRO = {
  servers: {
    fs: { type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'], headers: [] },
    web: { type: 'http', url: 'https://mcp.exemplo.com/mcp', env: [], headers: ['Authorization'] },
    aberto: { type: 'http', url: 'https://aberto.exemplo.com/mcp', env: [], headers: [] },
    sse1: { type: 'sse', url: 'https://sse.exemplo.com/sse' },
  },
};
const SEED = { numStartups: 7, oauthAccount: { emailAddress: 'nao-mexer@exemplo.com' }, mcpServers: { usuario: { command: 'meu-mcp', args: ['-y'] } }, projects: { 'C:\\outro': { allowedTools: [] } } };

async function setup(opts: { registry?: unknown | null; claude?: unknown | null; withVault?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcpmig-'));
  roots.push(dir);
  const clubFile = path.join(dir, 'myco', 'mcps.json');
  const claudeConfigFile = path.join(dir, 'claude.json');
  const backupDir = path.join(dir, 'myco', 'backups');
  const recordFile = path.join(dir, 'myco', 'mcps-migracao.json');
  const toolsFile = path.join(dir, 'myco', 'mcp-tools.json');
  const vault = { dir: path.join(dir, 'myco', 'secrets'), platform: 'linux' as const };
  const launcherFile = path.join(dir, 'dist', 'mcp-launch.mjs');
  await fs.mkdir(path.dirname(launcherFile), { recursive: true });
  await fs.writeFile(launcherFile, '// lançador de teste\n');
  const launcher = { command: process.execPath, args: [launcherFile] };
  await fs.mkdir(path.dirname(clubFile), { recursive: true });
  const registry = opts.registry === undefined ? REGISTRO : opts.registry;
  if (registry !== null) await fs.writeFile(clubFile, typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2) + '\n');
  const claude = opts.claude === undefined ? SEED : opts.claude;
  if (claude !== null) await fs.writeFile(claudeConfigFile, typeof claude === 'string' ? claude : JSON.stringify(claude, null, 2) + '\n');
  if (opts.withVault !== false) {
    await setSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), VALOR, vault);
    await setSecret(clubSecretId('web', 'header', 'Authorization'), HDR, vault);
  }
  const o = { clubFile, claudeConfigFile, backupDir, recordFile, vault, launcher };
  const readClaude = async () => JSON.parse(await fs.readFile(claudeConfigFile, 'utf8')) as Record<string, any>;
  return { dir, o, vault, launcher, launcherFile, toolsFile, clubFile, claudeConfigFile, backupDir, recordFile, readClaude };
}

const tail = (e: Awaited<ReturnType<typeof setup>>, name: string) => ['--server', name, '--club', e.clubFile, '--vault', e.vault.dir];

describe('migrateClubToGlobal: o registro do Club vai para a Global, sem valor e sem sobrescrever', () => {
  it('cada MCP vira uma entrada que chama o lançador (ou {type, url}); os valores ficam no cofre; backup, relatório e o registro intacto', async () => {
    const e = await setup();
    const registroAntes = await fs.readFile(e.clubFile, 'utf8');
    const claudeAntes = await fs.readFile(e.claudeConfigFile, 'utf8');

    const r = await migrateClubToGlobal(e.o);
    expect(r).not.toBeNull();
    expect(r!.moved).toEqual(['fs', 'web', 'aberto', 'sse1']);
    expect(r!.conflicts).toEqual([]);
    expect(r!.semValor).toEqual([]);

    const after = await e.readClaude();
    expect(after.mcpServers.fs).toEqual({ type: 'stdio', command: e.launcher.command, args: [...e.launcher.args, ...tail(e, 'fs')] });
    expect(after.mcpServers.web.type).toBe('http');
    expect(after.mcpServers.web.url).toBe('https://mcp.exemplo.com/mcp');
    expect(after.mcpServers.web.headers).toBeUndefined();
    expect(parseLauncherEntry(after.mcpServers.web)).toMatchObject({ server: 'web', headers: true, club: e.clubFile });
    expect(after.mcpServers.aberto).toEqual({ type: 'http', url: 'https://aberto.exemplo.com/mcp' });
    expect(after.mcpServers.sse1).toEqual({ type: 'sse', url: 'https://sse.exemplo.com/sse' });
    // O que já estava lá, e o resto do arquivo, fica como estava.
    expect(after.mcpServers.usuario).toEqual(SEED.mcpServers.usuario);
    expect(after.numStartups).toBe(7);
    expect(after.oauthAccount).toEqual(SEED.oauthAccount);
    expect(after.projects).toEqual(SEED.projects);

    // Nenhum valor literal no ~/.claude.json, nem no relatório.
    const dump = (await fs.readFile(e.claudeConfigFile, 'utf8')) + (await fs.readFile(e.recordFile, 'utf8'));
    for (const secret of [VALOR, HDR, 'tok-do-cofre']) expect(dump).not.toContain(secret);

    // Backup do ~/.claude.json de antes, com o caminho no relatório.
    expect(r!.backup).not.toBeNull();
    expect(path.dirname(r!.backup!)).toBe(e.backupDir);
    expect(await fs.readFile(r!.backup!, 'utf8')).toBe(claudeAntes);
    expect(await fs.readdir(e.backupDir)).toHaveLength(1);

    // O registro não é apagado nem mexido: é o que o lançador lê.
    expect(await fs.readFile(e.clubFile, 'utf8')).toBe(registroAntes);
    const rec = JSON.parse(await fs.readFile(e.recordFile, 'utf8'));
    expect(rec).toMatchObject({ moved: ['fs', 'web', 'aberto', 'sse1'], conflicts: [], semValor: [], backup: r!.backup, fichas: [] });
    expect(Object.keys(rec.written)).toEqual(['fs', 'web', 'aberto', 'sse1']);
  });

  it('idempotente: com o relatório, uma segunda execução não toca em nada (null)', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    const claude = await fs.readFile(e.claudeConfigFile, 'utf8');
    const rec = await fs.readFile(e.recordFile, 'utf8');
    expect(await migrateClubToGlobal(e.o)).toBeNull();
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe(claude);
    expect(await fs.readFile(e.recordFile, 'utf8')).toBe(rec);
    expect(await fs.readdir(e.backupDir)).toHaveLength(1);
  });

  it('idempotente sem relatório (execução interrompida): a entrada que já é a do Club não é conflito e nada é regravado', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    const claude = await fs.readFile(e.claudeConfigFile, 'utf8');
    await fs.rm(e.recordFile);
    const r = await migrateClubToGlobal(e.o);
    // fs e web já são a entrada do Club; aberto e sse1 são `{type, url}` iguais ao que seria gravado: nenhum é conflito.
    expect(r!.moved).toEqual(['fs', 'web', 'aberto', 'sse1']);
    expect(r!.conflicts).toEqual([]);
    expect(r!.backup).toBeNull();
    expect(r!.written).toEqual({});
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe(claude);
  });

  it('nome que já existe na Global fica como está e vai no relatório; os outros migram', async () => {
    const e = await setup({ claude: { mcpServers: { fs: { command: 'do-usuario', args: ['--x'] }, outro: { command: 'o' } } } });
    const r = await migrateClubToGlobal(e.o);
    expect(r!.moved).toEqual(['web', 'aberto', 'sse1']);
    expect(r!.conflicts).toEqual(['fs (já existe na Global: ficou como estava)']);
    const after = await e.readClaude();
    expect(after.mcpServers.fs).toEqual({ command: 'do-usuario', args: ['--x'] });
    expect(after.mcpServers.outro).toEqual({ command: 'o' });
    expect(Object.keys(r!.written)).toEqual(['web', 'aberto', 'sse1']);
  });

  it('entrada do mesmo nome que chama o lançador de OUTRO registro não é a do Club: é conflito', async () => {
    const e = await setup({ claude: { mcpServers: { fs: { type: 'stdio', command: 'node', args: ['C:/outro/dist/mcp-launch.mjs', '--server', 'fs', '--club', 'C:/outro/mcps.json', '--vault', 'V'] } } } });
    const r = await migrateClubToGlobal(e.o);
    expect(r!.conflicts).toEqual(['fs (já existe na Global: ficou como estava)']);
    expect(r!.moved).not.toContain('fs');
  });

  it('faltando valor no cofre: migra assim mesmo e lista o que falta (sem valor)', async () => {
    const e = await setup({ withVault: false });
    const r = await migrateClubToGlobal(e.o);
    expect(r!.moved).toEqual(['fs', 'web', 'aberto', 'sse1']);
    expect(r!.semValor).toEqual(['fs (FS_TOKEN)', 'web (Authorization)']);
  });

  it('entrada que não dá para montar (caminho com %: o headersHelper não pode ser citado) e nome inválido: não migram, com o motivo; o stdio segue', async () => {
    const e = await setup({ registry: { servers: { ...REGISTRO.servers, 'com espaco': { type: 'stdio', command: 'x' } } } });
    const pct = path.join(e.dir, 'pct%x');
    await fs.mkdir(pct, { recursive: true });
    const club = path.join(pct, 'mcps.json');
    await fs.copyFile(e.clubFile, club);
    const r = await migrateClubToGlobal({ ...e.o, clubFile: club });
    expect(r!.moved).toEqual(['fs', 'aberto', 'sse1']);
    expect(r!.conflicts).toEqual(['web (não deu para montar a entrada: caminho com aspas, % ou $, ou sem URL)', 'com espaco (nome inválido para a Global)']);
  });

  it('~/.claude.json que não existe: é criado, sem backup; sem registro: só o relatório vazio (o ~/.claude.json não nasce)', async () => {
    const novo = await setup({ claude: null });
    const r = await migrateClubToGlobal(novo.o);
    expect(r!.backup).toBeNull();
    expect(Object.keys((await novo.readClaude()).mcpServers)).toEqual(['fs', 'web', 'aberto', 'sse1']);
    await expect(fs.readdir(novo.backupDir)).rejects.toThrow();

    const vazio = await setup({ registry: null, claude: null });
    const rv = await migrateClubToGlobal(vazio.o);
    expect(rv).toMatchObject({ moved: [], conflicts: [], semValor: [], backup: null });
    await expect(fs.stat(vazio.claudeConfigFile)).rejects.toThrow();
    expect(await migrateClubToGlobal(vazio.o)).toBeNull();
  });

  it('~/.claude.json ou registro estragados: lança sem gravar nada nem o relatório (tenta de novo no próximo boot)', async () => {
    const quebrado = '{ "mcpServers": ';
    const a = await setup({ claude: quebrado });
    await expect(migrateClubToGlobal(a.o)).rejects.toThrow('não mexi');
    expect(await fs.readFile(a.claudeConfigFile, 'utf8')).toBe(quebrado);
    await expect(fs.stat(a.recordFile)).rejects.toThrow();

    const b = await setup({ registry: '{ não é json' });
    const antes = await fs.readFile(b.claudeConfigFile, 'utf8');
    await expect(migrateClubToGlobal(b.o)).rejects.toThrow(McpError);
    expect(await fs.readFile(b.claudeConfigFile, 'utf8')).toBe(antes);
    await expect(fs.stat(b.recordFile)).rejects.toThrow();
  });

  it('o que a migração grava a biblioteca lê: Global do Club (managed), com o valor do cofre marcado como preenchido', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    const lib = createMcpLibrary({ claudeConfigFile: e.claudeConfigFile, clubFile: e.clubFile, backupDir: e.backupDir, resolveProject: async () => null, vault: e.vault });
    const { servers } = await lib.list(null);
    const fs_ = servers.find((s) => s.name === 'fs')!;
    expect(fs_).toMatchObject({ scope: 'global', managed: true, command: 'node', env: [{ key: 'FS_TOKEN', set: true }] });
    expect(servers.find((s) => s.name === 'web')).toMatchObject({ managed: true, headers: [{ key: 'Authorization', set: true }] });
    expect(servers.find((s) => s.name === 'usuario')!.managed).toBeUndefined();
    expect(JSON.stringify(servers)).not.toContain(VALOR);
  });
});

describe('rollbackMcpMigration: desfaz só o que a migração fez e o usuário não mexeu', () => {
  const ficha = (id: string, mcps: string[] | null) => ({ id, name: id, mcps }) as unknown as StaffProfile;

  it('remove as entradas iguais às gravadas, devolve o `mcps` das fichas e apaga o relatório; a que o usuário editou fica', async () => {
    const e = await setup();
    const store = new Map<string, StaffProfile>([['ana', ficha('ana', ['fs', 'usuario'])]]);
    const projects = [{ id: 'proj', path: '/x/proj' }];
    const list = async () => [...store.values()];
    const save = async (_p: string, p: StaffProfile) => void store.set(p.id, p);
    await migrateMcpsAtBoot({ ...e.o, toolsFile: e.toolsFile, projects, known: async () => ({ globalNames: ['fs', 'usuario'], projectNames: [] }), list, save });
    expect(store.get('ana')!.mcps).toEqual(['global:fs', 'global:usuario']);

    // O usuário mexeu na entrada `web` depois da migração.
    const mid = await e.readClaude();
    mid.mcpServers.web.timeout = 9999;
    await fs.writeFile(e.claudeConfigFile, JSON.stringify(mid));

    const r = await rollbackMcpMigration({ recordFile: e.recordFile, claudeConfigFile: e.claudeConfigFile, backupDir: e.backupDir, projects, list, save });
    expect(r).toEqual({ removed: ['fs', 'aberto', 'sse1'], kept: ['web'], fichas: 1 });
    const after = await e.readClaude();
    expect(Object.keys(after.mcpServers)).toEqual(['usuario', 'web']);
    expect(after.mcpServers.web.timeout).toBe(9999);
    expect(store.get('ana')!.mcps).toEqual(['fs', 'usuario']);
    await expect(fs.stat(e.recordFile)).rejects.toThrow();
    // O registro e o cofre não foram mexidos: o modelo antigo acha tudo.
    expect(JSON.parse(await fs.readFile(e.clubFile, 'utf8'))).toEqual(REGISTRO);
    // Sem relatório, nada a desfazer.
    expect(await rollbackMcpMigration({ recordFile: e.recordFile, claudeConfigFile: e.claudeConfigFile, backupDir: e.backupDir, projects, list, save })).toBeNull();
  });

  it('entrada que sumiu do ~/.claude.json não dá erro; sem entradas a remover, o arquivo nem é regravado', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    await fs.writeFile(e.claudeConfigFile, JSON.stringify({ mcpServers: { usuario: SEED.mcpServers.usuario } }));
    const antes = await fs.readFile(e.claudeConfigFile, 'utf8');
    const r = await rollbackMcpMigration({ recordFile: e.recordFile, claudeConfigFile: e.claudeConfigFile, backupDir: e.backupDir, projects: [], list: async () => [], save: async () => {} });
    expect(r).toEqual({ removed: [], kept: [], fichas: 0 });
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe(antes);
  });
});

describe('repairLauncherEntries: só a entrada do Club cujo lançador sumiu é refeita', () => {
  it('lançador antigo que não existe mais: refaz com o de agora (campos do usuário ficam); o que existe e o que não é do Club não mexem', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    const claude = await e.readClaude();
    claude.mcpServers.fs = { ...claude.mcpServers.fs, args: [path.join(e.dir, 'dist-velho', 'mcp-launch.mjs'), ...tail(e, 'fs')], timeout: 1234 };
    claude.mcpServers.usuario = { type: 'stdio', command: 'node', args: [path.join(e.dir, 'nao-existe', 'mcp-launch.mjs'), '--server', 'usuario', '--club', 'C:/outro/mcps.json', '--vault', 'V'] };
    await fs.writeFile(e.claudeConfigFile, JSON.stringify(claude));
    const usuario = JSON.stringify(claude.mcpServers.usuario);

    const fixed = await repairLauncherEntries(e.o);
    expect(fixed).toEqual(['fs']);
    const after = await e.readClaude();
    expect(after.mcpServers.fs).toEqual({ type: 'stdio', command: e.launcher.command, args: [...e.launcher.args, ...tail(e, 'fs')], timeout: 1234 });
    expect(JSON.stringify(after.mcpServers.usuario)).toBe(usuario);

    // Tudo certo: nada a refazer, e o arquivo nem é regravado.
    const bytes = await fs.readFile(e.claudeConfigFile, 'utf8');
    expect(await repairLauncherEntries(e.o)).toEqual([]);
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe(bytes);
  });

  it('se o lançador de agora também não existe, não troca um quebrado por outro', async () => {
    const e = await setup();
    await migrateClubToGlobal(e.o);
    const claude = await e.readClaude();
    claude.mcpServers.fs.args[0] = path.join(e.dir, 'dist-velho', 'mcp-launch.mjs');
    await fs.writeFile(e.claudeConfigFile, JSON.stringify(claude));
    expect(await repairLauncherEntries({ ...e.o, launcher: { command: process.execPath, args: [path.join(e.dir, 'tambem-sumiu', 'mcp-launch.mjs')] } })).toEqual([]);
  });
});

describe('migrateMcpsAtBoot: a ordem do boot e o que fica no relatório', () => {
  const ficha = (id: string, mcps: string[] | null) => ({ id, name: id, mcps }) as unknown as StaffProfile;

  it('registro → Global, chaves das ferramentas testadas, fichas com nome antigo viram refs (o de antes no relatório); o segundo boot não muda nada', async () => {
    const e = await setup();
    const proj = path.join(e.dir, 'projeto');
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { doc: { command: 'doc' } } }));
    // Ferramentas testadas no modelo antigo (`club||`, `user||`, `local|`), e uma já no novo.
    await saveTestedTools(e.toolsFile, 'club||fs', 'fp1', [{ name: 'ler', readOnly: true }], new Date('2026-11-01T00:00:00Z'));
    await saveTestedTools(e.toolsFile, 'user||usuario', 'fp2', [{ name: 'a', readOnly: false }], new Date('2026-11-02T00:00:00Z'));
    await saveTestedTools(e.toolsFile, `local|${proj.toLowerCase()}|x`, 'fp3', [], new Date('2026-11-03T00:00:00Z'));
    await saveTestedTools(e.toolsFile, 'project|p|ja-novo', 'fp4', [], new Date('2026-11-04T00:00:00Z'));

    const store = new Map<string, StaffProfile>([
      ['ana', ficha('ana', ['fs', 'doc', 'usuario'])],
      ['bia', ficha('bia', ['global:fs'])],
      ['cai', ficha('cai', null)],
    ]);
    const projects = [{ id: 'proj', path: proj }];
    const args = { ...e.o, toolsFile: e.toolsFile, projects, known: (p: { path: string }) => knownMcpNames(p.path, e.claudeConfigFile), list: async () => [...store.values()], save: async (_p: string, p: StaffProfile) => void store.set(p.id, p) };

    const r = await migrateMcpsAtBoot(args);
    expect(r.clubError).toBeUndefined();
    expect(r.club!.moved).toEqual(['fs', 'web', 'aberto', 'sse1']);
    expect(r.toolsKeys).toBe(3);
    expect(r.fichas.changed).toEqual([{ projectId: 'proj', staffId: 'ana', before: ['fs', 'doc', 'usuario'] }]);
    expect(r.fichas.skipped).toEqual([]);
    // `fs` já é Global (migrado antes da conversão), `doc` está no .mcp.json do projeto, `usuario` é Global.
    expect(store.get('ana')!.mcps).toEqual(['global:fs', 'project:doc', 'global:usuario']);
    expect(store.get('bia')!.mcps).toEqual(['global:fs']);
    expect(store.get('cai')!.mcps).toBeNull();
    const rec = JSON.parse(await fs.readFile(e.recordFile, 'utf8'));
    expect(rec.fichas).toEqual([{ projectId: 'proj', staffId: 'ana', before: ['fs', 'doc', 'usuario'] }]);

    const keys = Object.keys(JSON.parse(await fs.readFile(e.toolsFile, 'utf8')).servers).sort();
    expect(keys).toEqual([`project|${proj.toLowerCase()}|x`, 'global||fs', 'global||usuario', 'project|p|ja-novo'].sort());

    const claude = await fs.readFile(e.claudeConfigFile, 'utf8');
    const record = await fs.readFile(e.recordFile, 'utf8');
    const again = await migrateMcpsAtBoot(args);
    expect(again).toMatchObject({ club: null, repaired: [], toolsKeys: 0, fichas: { changed: [], skipped: [] } });
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe(claude);
    expect(await fs.readFile(e.recordFile, 'utf8')).toBe(record);
  });

  it('~/.claude.json estragado: o erro vem no resultado, nada é gravado e a conversão das fichas pula o projeto (não converte no escuro)', async () => {
    const e = await setup({ claude: '{ quebrado' });
    const proj = path.join(e.dir, 'projeto');
    await fs.mkdir(proj, { recursive: true });
    const saved: StaffProfile[] = [];
    const r = await migrateMcpsAtBoot({
      ...e.o,
      toolsFile: e.toolsFile,
      projects: [{ id: 'proj', path: proj }],
      known: (p) => knownMcpNames(p.path, e.claudeConfigFile),
      list: async () => [ficha('ana', ['fs'])],
      save: async (_p, p) => void saved.push(p),
    });
    expect(r.clubError).toContain('não mexi');
    expect(r.club).toBeNull();
    expect(r.fichas).toEqual({ changed: [], skipped: ['proj'] });
    expect(saved).toEqual([]);
    expect(await fs.readFile(e.claudeConfigFile, 'utf8')).toBe('{ quebrado');
    await expect(fs.stat(e.recordFile)).rejects.toThrow();
  });
});

describe('chaves das ferramentas testadas: do modelo antigo para Global/Projeto', () => {
  it('newToolsKey: club e user viram global; local vira project; o novo e o que não entende ficam', () => {
    expect(newToolsKey('club||fs')).toBe('global||fs');
    expect(newToolsKey('user||fs')).toBe('global||fs');
    expect(newToolsKey('local|c:\\proj|db')).toBe('project|c:\\proj|db');
    expect(newToolsKey('project|c:\\proj|db')).toBe('project|c:\\proj|db');
    expect(newToolsKey('global||fs')).toBe('global||fs');
    expect(newToolsKey('esquisito')).toBe('esquisito');
    expect(newToolsKey('club||a|b')).toBe('global||a|b');
    expect(toolsKey('global', '/p', 'fs')).toBe('global||fs');
    expect(toolsKey('project', null, 'db')).toBe('project||db');
  });

  it('duas chaves antigas que viram a mesma: fica a testada por último; sem mudança, o arquivo não é regravado; arquivo que não existe, 0', async () => {
    const e = await setup();
    await saveTestedTools(e.toolsFile, 'club||x', 'velho', [], new Date('2026-11-01T00:00:00Z'));
    await saveTestedTools(e.toolsFile, 'user||x', 'novo', [], new Date('2026-11-05T00:00:00Z'));
    expect(await migrateToolsKeys(e.toolsFile)).toBe(2);
    const doc = JSON.parse(await fs.readFile(e.toolsFile, 'utf8')) as { servers: Record<string, { fingerprint: string }> };
    expect(Object.keys(doc.servers)).toEqual(['global||x']);
    expect(doc.servers['global||x']!.fingerprint).toBe('novo');
    const bytes = await fs.readFile(e.toolsFile, 'utf8');
    expect(await migrateToolsKeys(e.toolsFile)).toBe(0);
    expect(await fs.readFile(e.toolsFile, 'utf8')).toBe(bytes);
    expect(await migrateToolsKeys(path.join(e.dir, 'nao-existe.json'))).toBe(0);
  });
});

describe('o caminho do backup, para o log do boot', () => {
  it('o relatório traz o caminho do backup do ~/.claude.json (o boot o imprime, server/index.ts)', async () => {
    const e = await setup();
    const r = await migrateClubToGlobal(e.o);
    expect(path.basename(r!.backup!)).toMatch(/^claude\.json\.\d{4}-\d{2}-\d{2}T/);
    expect(JSON.parse(await fs.readFile(e.recordFile, 'utf8')).backup).toBe(r!.backup);
  });
});
