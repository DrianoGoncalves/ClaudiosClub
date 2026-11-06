import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hasSecret, getSecret } from '../server/secretVault';
import { buildMcpConfig, clubSecretId, listMcpServers, McpError } from '../server/staff/mcp';
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
  return { root, proj, claude, club, backups, vault, lib, seedRaw, readClaude };
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
    await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);

    const { servers } = await env.lib.list('p1');
    const dump = JSON.stringify(servers);
    for (const secret of ['segredo-de-verdade', 'abc123def456', GH, 'senhaForte123', 'valor-do-cofre-999']) expect(dump).not.toContain(secret);

    const busca = servers.find((s) => s.name === 'busca')!;
    expect(busca.url).toBe(`https://mcp.exemplo.com/?${MASK}`);
    expect(busca.headers).toEqual([{ key: 'Authorization', set: true }]);
    const gh = servers.find((s) => s.name === 'gh')!;
    expect(gh.argsMasked).toBe(true);
    expect(gh.args).toEqual(['--token', MASK, '-y']);
    expect(gh.env).toEqual([{ key: 'GH_TOKEN', set: true }]);
    expect(servers.find((s) => s.name === 'fs')!.env).toEqual([{ key: 'FS_TOKEN', set: true }]);

    // Escopos: sem projeto, só club e user; com projeto, também project e local (com a origem certa).
    expect((await env.lib.list(null)).servers.map((s) => s.scope).every((s) => s === 'club' || s === 'user')).toBe(true);
    expect(servers.filter((s) => s.scope === 'project').map((s) => s.name)).toEqual(['pw']);
    expect(servers.find((s) => s.name === 'local1')!.scope).toBe('local');
    expect(servers.find((s) => s.name === 'pw')!.env).toEqual([{ key: 'API_KEY', set: true }]);
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

describe('biblioteca de MCP: club (cofre)', () => {
  it('grava o segredo no cofre e não no mcps.json; null mantém; removeKeys apaga', async () => {
    const env = await setup();
    const { server } = await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    expect(server.env).toEqual([{ key: 'FS_TOKEN', set: true }]);
    expect(await fs.readFile(env.club, 'utf8')).not.toContain('valor-do-cofre-999');
    expect(await getSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');

    // null = manter o valor atual (a chave continua e o segredo também)
    await env.lib.save({ scope: 'club', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: null } }, true);
    expect(await getSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');
    // null para chave que não existe: pede o valor
    await expect(env.lib.save({ scope: 'club', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', env: { NOVA: null } }, true)).rejects.toThrow('informe o valor de NOVA');

    // removeKeys tira a chave do arquivo e do cofre
    await env.lib.save({ scope: 'club', originalName: 'fs', name: 'fs', type: 'stdio', command: 'node', env: {}, removeKeys: { env: ['FS_TOKEN'] } }, true);
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    const club = JSON.parse(await fs.readFile(env.club, 'utf8'));
    expect(club.servers.fs.env).toEqual([]);
  });

  it('renomear leva os valores; nome novo que já existe = erro', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    await env.lib.save({ scope: 'club', name: 'outro', type: 'stdio', command: 'node' }, true);
    await expect(env.lib.save({ scope: 'club', originalName: 'fs', name: 'outro', type: 'stdio', command: 'node', env: { FS_TOKEN: null } }, true)).rejects.toThrow('já existe');

    await env.lib.save({ scope: 'club', originalName: 'fs', name: 'fs2', type: 'stdio', command: 'node', env: { FS_TOKEN: null } }, true);
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    expect(await getSecret(clubSecretId('fs2', 'env', 'FS_TOKEN'), env.vault)).toBe('valor-do-cofre-999');
    const names = (await env.lib.list(null)).servers.map((s) => s.name);
    expect(names).toEqual(['fs2', 'outro']);
  });

  it('recusa token na URL e segredo nos argumentos (o cofre só guarda env e cabeçalho)', async () => {
    const env = await setup();
    await expect(
      env.lib.save({ scope: 'club', name: 'web', type: 'http', url: 'https://mcp.exemplo.com/?api_key=segredo-de-verdade-123' }, true),
    ).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'club', name: 'gh', type: 'stdio', command: 'gh-mcp', args: ['--token', GH] }, true)).rejects.toThrow(McpError);
    // Cabeçalho com o token é o jeito certo.
    const ok = await env.lib.save({ scope: 'club', name: 'web', type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: { Authorization: 'Bearer abc123def456ghi' } }, true);
    expect(ok.server.headers).toEqual([{ key: 'Authorization', set: true }]);
  });

  it('delete apaga o registro e os valores do cofre', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    expect(await env.lib.remove({ scope: 'club', name: 'fs' }, true)).toEqual({ ok: true });
    expect(await hasSecret(clubSecretId('fs', 'env', 'FS_TOKEN'), env.vault)).toBe(false);
    await expect(env.lib.remove({ scope: 'club', name: 'fs' }, true)).rejects.toThrow('não encontrado');
  });
});

describe('biblioteca de MCP: arquivos do Claude Code', () => {
  it('save user preserva as chaves desconhecidas do ~/.claude.json e faz backup antes', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    await env.lib.save({ scope: 'user', name: 'novo', type: 'http', url: 'https://novo.exemplo.dev/mcp', headers: { Authorization: 'Bearer xyz987abc654' } }, true);
    const after = await env.readClaude();
    expect(after.numStartups).toBe(7);
    expect(after.oauthAccount).toEqual({ emailAddress: 'nao-mexer@exemplo.com' });
    expect(after.projects).toBeDefined();
    expect(Object.keys(after.mcpServers)).toEqual(['busca', 'gh', 'ferramenta', 'novo']);
    // o que não foi editado segue igual, com os valores
    expect(after.mcpServers.busca).toEqual(SEED.mcpServers.busca);
    expect(after.mcpServers.novo.headers).toEqual({ Authorization: 'Bearer xyz987abc654' });

    const backups = await fs.readdir(env.backups);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^claude\.json\./);
    expect(await fs.readFile(path.join(env.backups, backups[0]!), 'utf8')).toBe(env.seedRaw);
  });

  it('mantém só os 10 backups mais recentes', async () => {
    const env = await setup({ mcpServers: {} });
    for (let i = 0; i < 12; i++) await env.lib.save({ scope: 'user', name: `m${i}`, type: 'http', url: `https://m${i}.exemplo.dev/mcp` }, true);
    expect(await fs.readdir(env.backups)).toHaveLength(10);
    expect(Object.keys((await env.readClaude()).mcpServers)).toHaveLength(12);
  });

  it('edita sem perder campos desconhecidos do servidor; null mantém o cabeçalho; removeKeys tira', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    await env.lib.save({ scope: 'user', originalName: 'busca', name: 'busca', type: 'http', url: 'https://outra.exemplo.dev/mcp', headers: { Authorization: null } }, true);
    const busca = (await env.readClaude()).mcpServers.busca;
    expect(busca).toEqual({ type: 'http', url: 'https://outra.exemplo.dev/mcp', headers: { Authorization: 'Bearer abc123def456ghi' }, timeout: 5000 });

    await env.lib.save({ scope: 'user', originalName: 'ferramenta', name: 'ferramenta', type: 'stdio', command: 'tool', args: ['-y'], env: {}, removeKeys: { env: ['MODO'] } }, true);
    expect((await env.readClaude()).mcpServers.ferramenta).toEqual({ type: 'stdio', command: 'tool', args: ['-y'] });
  });

  it('argumentos e URL mascarados voltam como estavam (o que a tela recebe, devolvido)', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    const { servers } = await env.lib.list(null);
    const busca = servers.find((s) => s.name === 'busca')!;
    const gh = servers.find((s) => s.name === 'gh')!;
    await env.lib.save({ scope: 'user', originalName: 'busca', name: 'busca', type: 'http', url: busca.url!, headers: { Authorization: null } }, true);
    await env.lib.save({ scope: 'user', originalName: 'gh', name: 'gh', type: 'stdio', command: gh.command!, args: gh.args!, env: { GH_TOKEN: null } }, true);
    const after = await env.readClaude();
    expect(after.mcpServers.busca.url).toBe('https://mcp.exemplo.com/?api_key=segredo-de-verdade-123');
    expect(after.mcpServers.gh.args).toEqual(['--token', GH, '-y']);
    expect(after.mcpServers.gh.env).toEqual({ GH_TOKEN: GH });
  });

  it('senha na URL: a tela recebe mascarada; devolver mascarada mantém a senha', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    await env.lib.save({ scope: 'user', name: 'banco', type: 'http', url: 'https://ana:senha-forte-123@mcp.x.dev/mcp' }, true);
    const view = (await env.lib.list(null)).servers.find((s) => s.name === 'banco')!;
    expect(view.url).toBe(`https://ana:${MASK}@mcp.x.dev/mcp`);
    expect(JSON.stringify(view)).not.toContain('senha-forte-123');
    await env.lib.save({ scope: 'user', originalName: 'banco', name: 'banco', type: 'http', url: view.url! }, true);
    expect((await env.readClaude()).mcpServers.banco.url).toBe('https://ana:senha-forte-123@mcp.x.dev/mcp');
    // Clube: senha na URL não vai para o cofre (o cofre só guarda env e cabeçalho).
    await expect(env.lib.save({ scope: 'club', name: 'banco', type: 'http', url: 'https://ana:senha-forte-123@mcp.x.dev/mcp' }, true)).rejects.toThrow(McpError);
  });

  it('local: cria o projeto em ~/.claude.json sem mexer nos outros', async () => {
    const env = await setup({ projects: { 'C:\\outro': { mcpServers: { o: { command: 'o' } } } }, numStartups: 1 });
    await env.lib.save({ scope: 'local', projectId: 'p1', name: 'mio', type: 'stdio', command: 'mio', env: { TOKEN_X: 'valor-local-123' } }, true);
    const after = await env.readClaude();
    expect(after.numStartups).toBe(1);
    expect(after.projects['C:\\outro']).toEqual({ mcpServers: { o: { command: 'o' } } });
    const mine = Object.entries<any>(after.projects).find(([k]) => k === env.proj)?.[1];
    expect(mine.mcpServers.mio.env).toEqual({ TOKEN_X: 'valor-local-123' });
    await env.lib.remove({ scope: 'local', projectId: 'p1', name: 'mio' }, true);
    expect(((await env.readClaude()).projects[env.proj] ?? {}).mcpServers.mio).toBeUndefined();
  });

  it('project (.mcp.json): recusa segredo literal (vai para o git); aceita ${VARIAVEL}', async () => {
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
  });

  it('recusa ~/.claude.json inválido sem sobrescrever', async () => {
    const env = await setup();
    const broken = '{ "mcpServers": ';
    await fs.writeFile(env.claude, broken);
    await expect(env.lib.save({ scope: 'user', name: 'x', type: 'http', url: 'https://x.dev/mcp' }, true)).rejects.toThrow('não mexi');
    expect(await fs.readFile(env.claude, 'utf8')).toBe(broken);
  });
});

describe('biblioteca de MCP: entradas e permissão', () => {
  it('recusa sem navegador (save, delete e test)', async () => {
    const env = await setup(seedFor('C:\\nao-existe'));
    const before = await fs.readFile(env.claude, 'utf8');
    await expect(env.lib.save({ scope: 'user', name: 'x', type: 'http', url: 'https://x.dev/mcp' }, false)).rejects.toThrow('só é alterada pelo Claudio’s Club');
    await expect(env.lib.remove({ scope: 'user', name: 'busca' }, false)).rejects.toThrow(McpError);
    await expect(env.lib.test({ scope: 'user', name: 'busca' }, false)).rejects.toThrow(McpError);
    expect(await fs.readFile(env.claude, 'utf8')).toBe(before);
  });

  it('valida nome, tipo e chaves (e nomes reservados)', async () => {
    const env = await setup();
    await expect(env.lib.save({ scope: 'user', name: 'com espaco', type: 'http', url: 'https://x.dev' }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'user', name: '__proto__', type: 'http', url: 'https://x.dev' }, true)).rejects.toThrow(McpError);
    await expect(env.lib.save({ scope: 'user', name: 'ok', type: 'http', url: 'ftp://x.dev' }, true)).rejects.toThrow('URL inválida');
    await expect(env.lib.save({ scope: 'user', name: 'ok', type: 'stdio', command: 'x', env: { '1BAD': 'v' } }, true)).rejects.toThrow('nome de variável inválido');
    await expect(env.lib.save({ scope: 'user', name: 'ok', type: 'http', url: 'https://x.dev', env: { A: 'v' } }, true)).rejects.toThrow('só valem para stdio');
    await expect(env.lib.list('projeto-que-nao-existe')).rejects.toThrow('projeto não encontrado');
  });
});

describe('buildMcpConfig com a biblioteca', () => {
  it('inclui o club com o segredo resolvido; prioridade local > project > club > user', async () => {
    const env = await setup();
    await fs.writeFile(env.claude, JSON.stringify({ mcpServers: { dup: { command: 'user-cmd' } } }));
    await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    await env.lib.save({ scope: 'club', name: 'dup', type: 'stdio', command: 'club-cmd' }, true);

    const cfg = await buildMcpConfig(env.proj, ['fs', 'dup'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(cfg.mcpServers.fs).toEqual({ type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: 'valor-do-cofre-999' } });
    expect(cfg.mcpServers.dup).toEqual({ type: 'stdio', command: 'club-cmd' });

    // Projeto com o mesmo nome: o .mcp.json ganha do club; o local ganha de todos.
    await fs.writeFile(path.join(env.proj, '.mcp.json'), JSON.stringify({ mcpServers: { dup: { command: 'project-cmd' } } }));
    expect((await buildMcpConfig(env.proj, ['dup'], env.claude, { clubFile: env.club, vault: env.vault })).mcpServers.dup).toEqual({ command: 'project-cmd' });
    await fs.writeFile(env.claude, JSON.stringify({ mcpServers: { dup: { command: 'user-cmd' } }, projects: { [env.proj]: { mcpServers: { dup: { command: 'local-cmd' } } } } }));
    expect((await buildMcpConfig(env.proj, ['dup'], env.claude, { clubFile: env.club, vault: env.vault })).mcpServers.dup).toEqual({ command: 'local-cmd' });

    const info = (await listMcpServers(env.proj, env.claude, env.club)).find((s) => s.name === 'fs');
    expect(info).toEqual({ name: 'fs', source: 'club', transport: 'stdio' });
  });

  it('servidor da biblioteca sem o valor no cofre fica de fora (sem quebrar a conversa)', async () => {
    const env = await setup();
    await env.lib.save({ scope: 'club', name: 'fs', type: 'stdio', command: 'node', env: { FS_TOKEN: 'valor-do-cofre-999' } }, true);
    // Some o cofre (o valor de FS_TOKEN com ele): o servidor não sobe, e o aviso no log não traz o valor.
    await fs.rm(env.vault.dir, { recursive: true, force: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await buildMcpConfig(env.proj, ['fs'], env.claude, { clubFile: env.club, vault: env.vault });
    expect(cfg.mcpServers).toEqual({});
    expect(warn.mock.calls.flat().join(' ')).toContain('FS_TOKEN');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('valor-do-cofre-999');
    warn.mockRestore();
  });
});
