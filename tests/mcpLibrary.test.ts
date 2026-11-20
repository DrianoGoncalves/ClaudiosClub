import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hasSecret, getSecret } from '../server/secretVault';
import { buildMcpConfig, clubSecretId, listMcpServers, McpError } from '../server/staff/mcp';
import { mcpLaunchCommand, parseLauncherEntry } from '../server/staff/mcpLaunch';
import { createMcpLibrary, MASK, maskArgs, maskUrl } from '../server/staff/mcpLibrary';

// Tudo em pastas temporárias: nunca o ~/.claude.json real. O cofre usa o modo arquivo (platform linux).

const GH = 'ghp_k3J9xQ7mP2vL8nR5tY1wZ6cB4hF0dS9aE7uI';
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

async function setup(seed?: Record<string, unknown>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcplib-'));
  roots.push(root);
  const proj = path.join(root, 'projeto');
  await fs.mkdir(proj, { recursive: true });
  const claude = path.join(root, 'claude.json');
  const club = path.join(root, 'myco', 'mcps.json');
  const backups = path.join(root, 'myco', 'backups');
  const vault = { dir: path.join(root, 'myco', 'secrets'), platform: 'linux' as const };
  const lib = createMcpLibrary({
    claudeConfigFile: claude,
    clubFile: club,
    backupDir: backups,
    resolveProject: async (id) => (id === 'p1' ? proj : null),
    vault,
  });
  const seedRaw = seed ? JSON.stringify(seed, null, 2) + '\n' : null;
  if (seedRaw !== null) await fs.writeFile(claude, seedRaw);
  const readClaude = async () => JSON.parse(await fs.readFile(claude, 'utf8')) as Record<string, any>;
  const readClub = async () => JSON.parse(await fs.readFile(club, 'utf8')) as { servers: Record<string, any> };
  return { root, proj, claude, club, backups, vault, lib, seedRaw, readClaude, readClub };
}

const SEED = {
  numStartups: 7,
  oauthAccount: { emailAddress: 'nao-mexer@exemplo.com' },
  mcpServers: {
    busca: {
      type: 'http',
      url: 'https://mcp.exemplo.com/?api_key=segredo-de-verdade-123',
      headers: { Authorization: 'Bearer abc123def456ghi' },
      timeout: 5000,
    },
    gh: { command: 'gh-mcp', args: ['--token', GH, '-y'], env: { GH_TOKEN: GH } },
    ferramenta: { command: 'tool', args: ['-y'], env: { MODO: 'simples' } },
  },
  projects: {
    // a chave do projeto é o caminho; a comparação é a mesma do Claude Code (pathKey)
    __PROJ__: { mcpServers: { local1: { command: 'x', env: { DB_PASSWORD: 'senhaForte123' } } }, allowedTools: [] },
  },
};

/** Monta o SEED com o caminho do projeto no lugar do marcador. */
function seedFor(proj: string) {
  return JSON.parse(JSON.stringify(SEED).replace('__PROJ__', proj.replace(/\\/g, '\\\\')));
}

describe('biblioteca de MCP: lista sem valor', () => {
  it('não vaza env, cabeçalho nem segredo de URL/argumentos; mascara com o marcador', async () => {
    const env = await setup();
    await fs.writeFile(env.claude, JSON.stringify(seedFor(env.proj), null, 2));
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp'], env: { API_KEY: '${KEY}' } } } }));
    await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);

    const { servers } = await env.lib.list('p1');
    const dump = JSON.stringify(servers);
    for (const secret of ['segredo-de-verdade', 'abc123def456', GH, 'senhaForte123', 'valor-do-cofre-999']) expect(dump).not.toContain(secret);

    const busca = servers.find((s) => s.name === 'busca')!;
    expect(busca.url).toBe(`https://mcp.exemplo.com/?${MASK}`);
    expect(busca.headers).toEqual([{ key: 'Authorization', set: true }]);
    expect(busca.managed).toBeUndefined();
    const gh = servers.find((s) => s.name === 'gh')!;
    expect(gh.argsMasked).toBe(true);
    expect(gh.args).toEqual(['--token', MASK, '-y']);
    expect(gh.env).toEqual([{ key: 'GH_TOKEN', set: true }]);
    const fs_ = servers.find((s) => s.name === 'fs')!;
    expect(fs_.env).toEqual([{ key: 'FS_TOKEN', set: true }]);
    expect(fs_.managed).toBe(true);
    expect(fs_.command).toBe('node');

    // Escopos: sem projeto, só a Global; com projeto, também o Projeto: o .mcp.json e, marcado fora do git, o escopo local.
    expect((await env.lib.list(null)).servers.every((s) => s.scope === 'global')).toBe(true);
    expect(servers.filter((s) => s.scope === 'project').map((s) => s.name)).toEqual(['local1', 'pw']);
    expect(servers.find((s) => s.name === 'local1')).toMatchObject({ scope: 'project', outOfGit: true, projectId: 'p1' });
    expect(servers.find((s) => s.name === 'pw')!.outOfGit).toBeUndefined();
    expect(servers.find((s) => s.name === 'pw')!.env).toEqual([{ key: 'API_KEY', set: true }]);
    // Nenhum escopo antigo sai da lista.
    expect(new Set(servers.map((s) => s.scope))).toEqual(new Set(['global', 'project']));
  });

  it('mesmo nome no .mcp.json e no escopo local: uma linha só, a do local (a precedência do Claude Code)', async () => {
    const env = await setup();
    await fs.writeFile(env.claude, JSON.stringify({ projects: { [env.proj]: { mcpServers: { dup: { command: 'local-cmd' } } } } }));
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'json-cmd' } } }));
    const rows = (await env.lib.list('p1')).servers.filter((s) => s.name === 'dup');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: 'local-cmd', outOfGit: true });
  });

  it('mascara URL e argumentos (unidades)', () => {
    expect(maskUrl('https://a.dev/mcp')).toEqual({ url: 'https://a.dev/mcp', masked: false });
    expect(maskUrl('https://a.dev/mcp?modo=rapido&token=abc123def456')).toEqual({ url: `https://a.dev/mcp?${MASK}`, masked: true });
    expect(maskUrl('https://ana:senha-forte-123@mcp.x.dev/mcp')).toEqual({ url: `https://ana:${MASK}@mcp.x.dev/mcp`, masked: true });
    expect(maskUrl('https://mcp.x.dev:8443/mcp')).toEqual({ url: 'https://mcp.x.dev:8443/mcp', masked: false });
    expect(maskArgs(['--token', GH, '-y']).args).toEqual(['--token', MASK, '-y']);
    expect(maskArgs(['--api-key=xyz-segredo-123']).args).toEqual([`--api-key=${MASK}`]);
    expect(maskArgs(['-y', '@playwright/mcp']).masked).toBe(false);
  });
});

describe('biblioteca de MCP: Global do Club (cofre, lançador)', () => {
  it('grava o segredo no cofre, o lançador no ~/.claude.json e a definição no registro; null mantém; removeKeys apaga', async () => {
    const env = await setup();
    const { server } = await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    expect(server.env).toEqual([{ key: 'FS_TOKEN', set: true }]);
    expect(server.managed).toBe(true);
    // Nenhum valor literal: nem no registro, nem no ~/.claude.json.
    expect(await fs.readFile(env.club, 'utf8')).not.toContain('valor-do-cofre-999');
    expect(await fs.readFile(env.claude, 'utf8')).not.toContain('valor-do-cofre-999');
    expect(await getSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');
    // A entrada do ~/.claude.json chama o lançador com o nome do servidor.
    const entry = (await env.readClaude()).mcpServers.fs;
    expect(entry).toEqual({ type: 'stdio', command: mcpLaunchCommand().command, args: [...mcpLaunchCommand().args, '--server', 'fs', '--club', env.club, '--vault', env.vault.dir] });
    expect(parseLauncherEntry(entry)).toMatchObject({ server: 'fs', club: env.club, vault: env.vault.dir, headers: false });
    // A definição (sem valor) fica no registro.
    expect((await env.readClub()).servers.fs).toEqual({ type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'], headers: [] });

    // null = manter o valor atual (a chave continua e o segredo também)
    await env.lib.save({ scope: 'global', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: null } }, true);
    expect(await getSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');
    // null para chave que não existe: pede o valor
    await expect(env.lib.save({ scope: 'global', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', env: { NOVA: null } }, true)).rejects.toThrow('informe o valor de NOVA');

    // removeKeys tira a chave do registro e do cofre
    await env.lib.save({ scope: 'global', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', env: {}, removeKeys: { env: ['FS_TOKEN'] } }, true);
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    expect((await env.readClub()).servers.fs.env).toEqual([]);
  });

  it('http com cabeçalho: headersHelper no ~/.claude.json, sem o valor; sem cabeçalho: só {type, url}, sem registro', async () => {
    const env = await setup();
    const ok = await env.lib.save({ scope: 'global', name: 'web', type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: { Authorization: 'Bearer abc123def456ghi' } }, true);
    expect(ok.server.headers).toEqual([{ key: 'Authorization', set: true }]);
    const entry = (await env.readClaude()).mcpServers.web;
    expect(entry.type).toBe('http');
    expect(entry.url).toBe('https://mcp.exemplo.com/mcp');
    expect(entry.headers).toBeUndefined();
    expect(entry.headersHelper).toContain('"--headers" "--server" "web"');
    expect(parseLauncherEntry(entry)).toMatchObject({ server: 'web', headers: true });
    expect(await fs.readFile(env.claude, 'utf8')).not.toContain('abc123def456ghi');
    expect(await getSecret(clubSecretId('web', 'header', 'Authorization'), env.vault)).toBe('Bearer abc123def456ghi');

    await env.lib.save({ scope: 'global', name: 'aberto', type: 'http', url: 'https://aberto.exemplo.dev/mcp' }, true);
    expect((await env.readClaude()).mcpServers.aberto).toEqual({ type: 'http', url: 'https://aberto.exemplo.dev/mcp' });
    expect((await env.readClub()).servers.aberto).toBeUndefined();

    // Tirar o cabeçalho de um managed vira {type, url} e leva a definição e o valor do cofre embora.
    await env.lib.save({ scope: 'global', originalName: 'web', name: 'web', type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: {}, removeKeys: { headers: ['Authorization'] } }, true);
    expect((await env.readClaude()).mcpServers.web).toEqual({ type: 'http', url: 'https://mcp.exemplo.com/mcp' });
    expect((await env.readClub()).servers.web).toBeUndefined();
    expect(await hasSecret(clubSecretId('web', 'header', 'Authorization'), env.vault)).toBe(false);
  });

  it('renomear leva os valores e a definição; nome novo que já existe = erro', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    await env.lib.save({ scope: 'global', name: 'outro', type: 'stdio', command: 'node' }, true);
    await expect(env.lib.save({ scope: 'global', originalName: 'fs', name: 'outro', type: 'stdio', command: 'node', env: { FS_TOKEN: null } }, true)).rejects.toThrow('já existe');

    await env.lib.save({ scope: 'global', originalName: 'fs', name: 'fs2', type: 'stdio', command: 'node', env: { FS_TOKEN: null } }, true);
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    expect(await getSecret(clubSecretId('fs2', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');
    const names = (await env.lib.list(null)).servers.map((s) => s.name);
    expect(names).toEqual(['fs2', 'outro']);
    expect(Object.keys((await env.readClub()).servers)).toEqual(['outro', 'fs2']);
    expect(parseLauncherEntry((await env.readClaude()).mcpServers.fs2)?.server).toBe('fs2');
  });

  it('recusa token na URL e segredo nos argumentos (o cofre só guarda env e cabeçalho)', async () => {
    const env = await setup();
    await expect(
      env.lib.save({ scope: 'global', name: 'web', type: 'http', url: 'https://mcp.exemplo.com/?api_key=segredo-de-verdade-123' }, true),
    ).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'global', name: 'gh', type: 'stdio', command: 'gh-mcp', args: ['--token', GH] }, true)).rejects.toThrow(McpError);
    // Nada foi gravado: nem ~/.claude.json nem registro.
    await expect(fs.stat(env.claude)).rejects.toThrow();
    await expect(fs.stat(env.club)).rejects.toThrow();
  });

  it('delete apaga a entrada, a definição e os valores do cofre; só a entrada do Club leva a definição', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    expect(await env.lib.remove({ scope: 'global', name: 'fs' }, true)).toEqual({ ok: true });
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    expect((await env.readClub()).servers.fs).toBeUndefined();
    expect((await env.readClaude()).mcpServers.fs).toBeUndefined();
    await expect(env.lib.remove({ scope: 'global', name: 'fs' }, true)).rejects.toThrow('não encontrado');

    // Uma entrada comum com o nome de uma definição que sobrou no registro (conflito da migração): apagar a entrada não apaga a definição.
    await env.lib.save({ scope: 'global', name: 'sobra', type: 'stdio', command: 'node' }, true);
    const rawClaude = await env.readClaude();
    rawClaude.mcpServers.sobra = { command: 'do-usuario' };
    await fs.writeFile(env.claude, JSON.stringify(rawClaude));
    await env.lib.remove({ scope: 'global', name: 'sobra' }, true);
    expect((await env.readClub()).servers.sobra).toBeDefined();
  });
});

describe('biblioteca de MCP: arquivos do Claude Code', () => {
  it('save global preserva as chaves desconhecidas do ~/.claude.json e faz um backup antes', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    await env.lib.save({ scope: 'global', name: 'novo', type: 'http', url: 'https://novo.exemplo.dev/mcp', headers: { Authorization: 'Bearer xyz987abc654' } }, true);
    const after = await env.readClaude();
    expect(after.numStartups).toBe(7);
    expect(after.oauthAccount).toEqual({ emailAddress: 'nao-mexer@exemplo.com' });
    expect(after.projects).toBeDefined();
    expect(Object.keys(after.mcpServers)).toEqual(['busca', 'gh', 'ferramenta', 'novo']);
    // o que não foi editado segue igual, com os valores
    expect(after.mcpServers.busca).toEqual(SEED.mcpServers.busca);
    // o novo não leva o valor: ele foi para o cofre
    expect(JSON.stringify(after.mcpServers.novo)).not.toContain('xyz987abc654');

    const backups = await fs.readdir(env.backups);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^claude\.json\./);
    expect(await fs.readFile(path.join(env.backups, backups[0]!), 'utf8')).toBe(env.seedRaw);
  });

  it('mantém só os 10 backups mais recentes', async () => {
    const env = await setup({ mcpServers: {} });
    for (let i = 0; i < 12; i++) await env.lib.save({ scope: 'global', name: `m${i}`, type: 'http', url: `https://m${i}.exemplo.dev/mcp` }, true);
    expect(await fs.readdir(env.backups)).toHaveLength(10);
    expect(Object.keys((await env.readClaude()).mcpServers)).toHaveLength(12);
  });

  it('entrada escrita à mão: salvar converte para o Club (campos desconhecidos ficam; os valores têm de ser digitados de novo)', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    // null não vale para o que está no arquivo: o valor tem de ser informado (ele vai para o cofre, nunca de volta ao arquivo).
    await expect(env.lib.save({ scope: 'global', originalName: 'busca', name: 'busca', type: 'http', url: 'https://outra.exemplo.dev/mcp', headers: { Authorization: null } }, true)).rejects.toThrow(
      'informe o valor de Authorization',
    );
    expect((await env.readClaude()).mcpServers.busca).toEqual(SEED.mcpServers.busca);

    await env.lib.save({ scope: 'global', originalName: 'busca', name: 'busca', type: 'http', url: 'https://outra.exemplo.dev/mcp', headers: { Authorization: 'Bearer novo-valor-12345' } }, true);
    const busca = (await env.readClaude()).mcpServers.busca;
    expect(busca.timeout).toBe(5000);
    expect(busca.url).toBe('https://outra.exemplo.dev/mcp');
    expect(busca.headers).toBeUndefined();
    expect(parseLauncherEntry(busca)?.server).toBe('busca');
    expect(await fs.readFile(env.claude, 'utf8')).not.toContain('novo-valor-12345');
    expect(await getSecret(clubSecretId('busca', 'header', 'Authorization'), env.vault)).toBe('Bearer novo-valor-12345');

    // stdio: sempre pelo lançador (a definição no registro, sem a variável literal que estava no arquivo).
    await env.lib.save({ scope: 'global', originalName: 'ferramenta', name: 'ferramenta', type: 'stdio', command: 'tool', args: ['-y'], env: {}, removeKeys: { env: ['MODO'] } }, true);
    const ferr = (await env.readClaude()).mcpServers.ferramenta;
    expect(parseLauncherEntry(ferr)?.server).toBe('ferramenta');
    expect(JSON.stringify(ferr)).not.toContain('simples');
    expect((await env.readClub()).servers.ferramenta).toEqual({ type: 'stdio', command: 'tool', args: ['-y'], env: [], headers: [] });
  });

  it('entrada com segredo literal no arquivo: devolver a URL ou os argumentos mascarados recusa (não regrava o segredo)', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    const before = await fs.readFile(env.claude, 'utf8');
    const { servers } = await env.lib.list(null);
    const busca = servers.find((s) => s.name === 'busca')!;
    const gh = servers.find((s) => s.name === 'gh')!;
    await expect(env.lib.save({ scope: 'global', originalName: 'busca', name: 'busca', type: 'http', url: busca.url!, headers: { Authorization: 'Bearer novo-valor-12345' } }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'global', originalName: 'gh', name: 'gh', type: 'stdio', command: gh.command!, args: gh.args!, env: { GH_TOKEN: 'outro-valor-12345' } }, true)).rejects.toThrow(McpError);
    expect(await fs.readFile(env.claude, 'utf8')).toBe(before);
    await expect(fs.stat(env.club)).rejects.toThrow();
  });

  it('senha na URL: a lista recebe mascarada; salvar na Global com senha literal na URL é recusado', async () => {
    const env = await setup({ mcpServers: { banco: { type: 'http', url: 'https://ana:senha-forte-123@mcp.x.dev/mcp' } } });
    const view = (await env.lib.list(null)).servers.find((s) => s.name === 'banco')!;
    expect(view.url).toBe(`https://ana:${MASK}@mcp.x.dev/mcp`);
    expect(JSON.stringify(view)).not.toContain('senha-forte-123');
    await expect(env.lib.save({ scope: 'global', originalName: 'banco', name: 'banco', type: 'http', url: view.url! }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'global', name: 'banco2', type: 'http', url: 'https://ana:senha-forte-123@mcp.x.dev/mcp' }, true)).rejects.toThrow(McpError);
    expect((await env.readClaude()).mcpServers.banco.url).toBe('https://ana:senha-forte-123@mcp.x.dev/mcp');
  });

  it('Projeto novo vai para o .mcp.json (nunca para o ~/.claude.json), sem mexer nos outros projetos', async () => {
    const env = await setup({ projects: { 'C:\\outro': { mcpServers: { o: { command: 'o' } } } }, numStartups: 1 });
    await env.lib.save({ scope: 'project', projectId: 'p1', name: 'mio', type: 'stdio', command: 'mio', env: { TOKEN_X: '${TOKEN_X}' } }, true);
    const after = await env.readClaude();
    expect(after.numStartups).toBe(1);
    expect(after.projects['C:\\outro']).toEqual({ mcpServers: { o: { command: 'o' } } });
    expect(after.projects[env.proj]).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(env.proj, '.mcp.json'), 'utf8')).mcpServers.mio.env).toEqual({ TOKEN_X: '${TOKEN_X}' });
    await expect(fs.readdir(env.backups)).rejects.toThrow();
  });

  it('Projeto que já está no escopo local: editar e apagar acontecem lá (fora do git), e o valor que já estava fica', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    await env.lib.save({ scope: 'global', name: 'g', type: 'http', url: 'https://g.exemplo.dev/mcp' }, true);
    const claudeRaw = await env.readClaude();
    claudeRaw.projects[env.proj] = { mcpServers: { local1: { command: 'x', env: { DB_PASSWORD: 'senhaForte123' } } } };
    await fs.writeFile(env.claude, JSON.stringify(claudeRaw));

    const { server } = await env.lib.save({ scope: 'project', projectId: 'p1', originalName: 'local1', name: 'local1', type: 'stdio', command: 'y', env: { DB_PASSWORD: null } }, true);
    expect(server).toMatchObject({ scope: 'project', outOfGit: true, command: 'y' });
    expect((await env.readClaude()).projects[env.proj].mcpServers.local1).toEqual({ type: 'stdio', command: 'y', env: { DB_PASSWORD: 'senhaForte123' } });
    await expect(fs.stat(path.join(env.proj, '.mcp.json'))).rejects.toThrow();
    // Valor novo com segredo literal não entra nem no local.
    await expect(
      env.lib.save({ scope: 'project', projectId: 'p1', originalName: 'local1', name: 'local1', type: 'stdio', command: 'y', env: { API_KEY: 'literal-12345678' } }, true),
    ).rejects.toThrow('vai para o git');

    await env.lib.remove({ scope: 'project', projectId: 'p1', name: 'local1' }, true);
    expect(((await env.readClaude()).projects[env.proj] ?? {}).mcpServers.local1).toBeUndefined();
    await expect(env.lib.remove({ scope: 'project', projectId: 'p1', name: 'local1' }, true)).rejects.toThrow('não encontrado');
  });

  it('Projeto (.mcp.json): recusa segredo literal (vai para o git); aceita ${VARIAVEL}; nome que existe em qualquer lugar do Projeto = erro', async () => {
    const env = await setup();
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { base: { command: 'base' } } }));
    await expect(
      env.lib.save({ scope: 'project', projectId: 'p1', name: 'x', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: 'literal-12345678' } }, true),
    ).rejects.toThrow('vai para o git');
    expect(JSON.parse(await fs.readFile(path.join(env.proj, '.mcp.json'), 'utf8')).mcpServers.x).toBeUndefined();

    await env.lib.save({ scope: 'project', projectId: 'p1', name: 'x', type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${API_KEY}' } }, true);
    const file = JSON.parse(await fs.readFile(path.join(env.proj, '.mcp.json'), 'utf8'));
    expect(file.mcpServers.base).toEqual({ command: 'base' });
    expect(file.mcpServers.x).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { API_KEY: '${API_KEY}' } });
    await expect(env.lib.save({ scope: 'project', projectId: 'p1', name: 'base', type: 'stdio', command: 'outro' }, true)).rejects.toThrow('já existe');
  });

  it('recusa ~/.claude.json inválido sem sobrescrever e sem gravar valor no cofre ou no registro', async () => {
    const env = await setup();
    const broken = '{ "mcpServers": ';
    await fs.writeFile(env.claude, broken);
    await expect(env.lib.save({ scope: 'global', name: 'x', type: 'http', url: 'https://x.dev/mcp' }, true)).rejects.toThrow('não mexi');
    await expect(env.lib.save({ scope: 'global', name: 'y', type: 'stdio', command: 'y', env: { TOKEN_Y: 'valor-do-cofre-999' } }, true)).rejects.toThrow('não mexi');
    expect(await fs.readFile(env.claude, 'utf8')).toBe(broken);
    expect(await hasSecret(clubSecretId('y', 'env', 'TOKEN_Y'), env.vault)).toBe(false);
    await expect(fs.stat(env.club)).rejects.toThrow();
  });
});

describe('biblioteca de MCP: entradas e permissão', () => {
  it('recusa sem navegador (save, delete e test)', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    const before = await fs.readFile(env.claude, 'utf8');
    await expect(env.lib.save({ scope: 'global', name: 'x', type: 'http', url: 'https://x.dev/mcp' }, false)).rejects.toThrow('só é alterada pelo Claudio’s Club');
    await expect(env.lib.remove({ scope: 'global', name: 'busca' }, false)).rejects.toThrow(McpError);
    await expect(env.lib.test({ scope: 'global', name: 'busca' }, false)).rejects.toThrow(McpError);
    expect(await fs.readFile(env.claude, 'utf8')).toBe(before);
  });

  it('valida nome, tipo e chaves (e nomes reservados)', async () => {
    const env = await setup();
    await expect(env.lib.save({ scope: 'global', name: 'com espaco', type: 'http', url: 'https://x.dev' }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'global', name: '__proto__', type: 'http', url: 'https://x.dev' }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'global', name: 'ok', type: 'http', url: 'ftp://x.dev' }, true)).rejects.toThrow('URL inválida');
    await expect(env.lib.save({ scope: 'global', name: 'ok', type: 'stdio', command: 'x', env: { '1BAD': 'v' } }, true)).rejects.toThrow('nome de variável inválido');
    await expect(env.lib.save({ scope: 'global', name: 'ok', type: 'http', url: 'https://x.dev', env: { A: 'v' } }, true)).rejects.toThrow('só valem para stdio');
    await expect(env.lib.list('projeto-que-nao-existe')).rejects.toThrow('projeto não encontrado');
  });

  it('só aceita os escopos global e project: club, user e local dão erro (gravar, apagar e testar)', async () => {
    const env = await setup();
    for (const scope of ['club', 'user', 'local']) {
      await expect(env.lib.save({ scope, projectId: 'p1', name: 'x', type: 'http', url: 'https://x.dev/mcp' }, true)).rejects.toThrow('escopo: global ou project');
      await expect(env.lib.remove({ scope, projectId: 'p1', name: 'x' }, true)).rejects.toThrow('escopo: global ou project');
      await expect(env.lib.test({ scope, projectId: 'p1', name: 'x' }, true)).rejects.toThrow('escopo: global ou project');
    }
    await expect(fs.stat(env.claude)).rejects.toThrow();
  });
});

describe('buildMcpConfig por ref', () => {
  it('a Global do Club sai pelo lançador, sem valor; o Projeto, como está; local vence o .mcp.json', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'project-cmd' } } }));

    const cfg = await buildMcpConfig(env.proj, ['global:fs', 'project:dup'], env.claude, { clubFile: env.club, vault: env.vault });
    const launch = mcpLaunchCommand();
    expect(cfg.mcpServers.fs).toEqual({ type: 'stdio', command: launch.command, args: [...launch.args, '--server', 'fs', '--club', env.club, '--vault', env.vault.dir] });
    expect(JSON.stringify(cfg)).not.toContain('valor-do-cofre-999');
    expect(cfg.mcpServers.dup).toEqual({ command: 'project-cmd' });

    const raw = await env.readClaude();
    raw.projects = { [env.proj]: { mcpServers: { dup: { command: 'local-cmd' } } } };
    await fs.writeFile(env.claude, JSON.stringify(raw));
    expect((await buildMcpConfig(env.proj, ['project:dup'], env.claude, { clubFile: env.club, vault: env.vault })).mcpServers.dup).toEqual({ command: 'local-cmd' });

    const info = (await listMcpServers(env.proj, env.claude, env.club)).find((s) => s.name === 'fs');
    expect(info).toEqual({ name: 'fs', ref: 'global:fs', scope: 'global', source: 'user', transport: 'stdio' });
  });

  it('o mesmo nome na Global e no Projeto: cada ref é um servidor; marcadas as duas, sobe só o do Projeto (com aviso)', async () => {
    const env = await setup({ mcpServers: { dup: { command: 'user-cmd' } } });
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'project-cmd' } } }));
    const o = { clubFile: env.club, vault: env.vault };
    expect((await buildMcpConfig(env.proj, ['global:dup'], env.claude, o)).mcpServers.dup).toEqual({ command: 'user-cmd' });
    expect((await buildMcpConfig(env.proj, ['project:dup'], env.claude, o)).mcpServers.dup).toEqual({ command: 'project-cmd' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await buildMcpConfig(env.proj, ['global:dup', 'project:dup'], env.claude, o)).mcpServers.dup).toEqual({ command: 'project-cmd' });
    expect(warn.mock.calls.flat().join(' ')).toContain('só o do Projeto sobe');
    warn.mockRestore();
    // Nas duas listas, as duas linhas.
    expect((await listMcpServers(env.proj, env.claude, env.club)).filter((s) => s.name === 'dup').map((s) => s.ref)).toEqual(['global:dup', 'project:dup']);
  });

  it('nome antigo (sem escopo) vale como na conversão: Projeto se existe lá, senão Global; ref que não existe fica de fora', async () => {
    const env = await setup({ mcpServers: { dup: { command: 'user-cmd' }, so: { command: 'so-cmd' } } });
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'project-cmd' } } }));
    const cfg = await buildMcpConfig(env.proj, ['dup', 'so', 'global:nao-existe', 'project:so'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(cfg.mcpServers).toEqual({ dup: { command: 'project-cmd' }, so: { command: 'so-cmd' } });
  });

  it('servidor da Global do Club sem o valor no cofre fica de fora (sem quebrar a conversa)', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'global', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    // Some o cofre (o valor de FS_TOKEN com ele): o servidor não sobe, e o aviso no log não traz o valor.
    await fs.rm(env.vault.dir, { recursive: true, force: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await buildMcpConfig(env.proj, ['global:fs'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(cfg.mcpServers).toEqual({});
    expect(warn.mock.calls.flat().join(' ')).toContain('FS_TOKEN');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('valor-do-cofre-999');
    warn.mockRestore();
  });
});
