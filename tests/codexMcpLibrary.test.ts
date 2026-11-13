import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { buildCodexArgs, codexExtraMcpArgs, tomlString, type CodexExtraMcp } from '../server/chat/codexArgs';
import { prepareCodexRun, type LaunchContext } from '../server/staff/launch';
import { clubSecretId, codexMcpServers, expandVars } from '../server/staff/mcp';
import type { McpAccessMap } from '../server/staff/mcpAccess';
import { McpLaunchError, mcpLaunchCommand, quotedCommand, snapshotSpec } from '../server/staff/mcpLaunch';
import { mcpFingerprint, saveTestedTools, toolsKey, type McpTool } from '../server/staff/mcpTools';
import { setSecret } from '../server/secretVault';

// Os MCPs da biblioteca do Club e os da ficha (projeto) entram no Codex pelo lançador, com o acesso da ficha. Nenhum valor de env ou
// cabeçalho aparece na linha de comando nem em `servers`: a biblioteca fica no cofre (temporário) e o resto no arquivo de lançamento.
// Tudo em pastas temporárias; o cofre usa o modo arquivo (platform linux), que lê em qualquer sistema.

const VALOR_LIB = 'valor-biblioteca-AB12cd34';
const HDR_LIB = 'Bearer tok-biblioteca-987zyx';
const VALOR_PROJ = 'valor-projeto-QW56er78';
const LITERAL = 'literal-XYZ-123';
/** Lançador de teste: o pacote de verdade só existe depois do build (dist/mcp-launch.mjs). */
const LAUNCH = { command: 'C:/node/node.exe', args: ['C:/club/dist/mcp-launch.mjs'] };
const VARS = { PROJ_KEY: VALOR_PROJ } as NodeJS.ProcessEnv;
const ALL_READ: McpTool[] = [
  { name: 'buscar', readOnly: true },
  { name: 'apagar', readOnly: false },
];

/** Configuração do .mcp.json do projeto (também o que a impressão do teste confere). */
const PSTDIO_CFG = { type: 'stdio', command: 'node', args: ['p.js', '--flag'], env: { TOKEN_P: '${PROJ_KEY}', LIT: LITERAL } };
const PHTTP_CFG = { type: 'http', url: 'https://proj.exemplo.com/mcp', headers: { Authorization: 'Bearer ${PROJ_KEY}' } };

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-mcp-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Uma biblioteca (stdio com env no cofre, http com cabeçalho no cofre, sse) e um projeto (.mcp.json com stdio e http, com `${VAR}` e literal,
 * sse, e casos de erro). As ferramentas testadas ficam em mcp-tools.json; `psem` não tem teste.
 */
async function setup() {
  const dir = await fs.mkdtemp(path.join(root, 'c-'));
  const proj = path.join(dir, 'projeto');
  const vaultDir = path.join(dir, 'secrets');
  const vault = { dir: vaultDir, platform: 'linux' as const };
  const club = path.join(dir, 'mcps.json');
  const claude = path.join(dir, 'claude.json');
  const toolsFile = path.join(dir, 'mcp-tools.json');
  const snapshotFile = path.join(dir, 'run', 'codex-mcp.json');
  await fs.mkdir(proj, { recursive: true });
  // Script do MCP de teste: grava o valor da env num arquivo e sai com 7 (ver o teste do lançador de verdade).
  const out = path.join(dir, 'saida.txt');
  const script = path.join(dir, 'mcp-falso.cjs');
  await fs.writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.TOKEN_P ?? 'SEM');\nprocess.exit(7);\n`);
  await fs.writeFile(
    club,
    JSON.stringify({
      servers: {
        lfs: { type: 'stdio', command: 'node', args: ['srv.js'], env: ['FS_TOKEN'] },
        lweb: { type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: ['Authorization'] },
        lsse: { type: 'sse', url: 'https://sse.exemplo.com/sse' },
      },
    }),
  );
  await fs.writeFile(
    path.join(proj, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        pstdio: PSTDIO_CFG,
        phttp: PHTTP_CFG,
        psem: { type: 'stdio', command: 'node', args: ['s.js'] },
        psse: { type: 'sse', url: 'https://sse2.exemplo.com/sse' },
        pbad: { type: 'stdio', command: 'node', args: [1] },
        pvar: { type: 'stdio', command: 'node', args: ['${NAO_EXISTE_ZZ9}'] },
        pkey: { type: 'http', url: 'https://k.exemplo.com/mcp?api_key=abcdefgh1234' },
        phttpsemcab: { type: 'http', url: 'https://sem.exemplo.com/mcp' },
        pfake: { type: 'stdio', command: process.execPath, args: [script], env: { TOKEN_P: '${PROJ_KEY}' } },
        'pontos.nome': { type: 'stdio', command: 'node' },
        'myco-ssh': { type: 'stdio', command: 'node' },
      },
    }),
  );
  await setSecret(clubSecretId('lfs', 'env', 'FS_TOKEN'), VALOR_LIB, vault);
  await setSecret(clubSecretId('lweb', 'header', 'Authorization'), HDR_LIB, vault);
  // Testes das ferramentas: a impressão tem de bater com o que a biblioteca e o projeto declaram agora.
  await saveTestedTools(toolsFile, toolsKey('club', proj, 'lweb'), mcpFingerprint({ type: 'http', url: 'https://mcp.exemplo.com/mcp' }), ALL_READ);
  await saveTestedTools(toolsFile, toolsKey('project', proj, 'pstdio'), mcpFingerprint(PSTDIO_CFG), ALL_READ);
  await saveTestedTools(toolsFile, toolsKey('project', proj, 'phttp'), mcpFingerprint(PHTTP_CFG), ALL_READ);
  return { dir, proj, club, claude, vault, vaultDir, toolsFile, snapshotFile, script, out };
}
type Env = Awaited<ReturnType<typeof setup>>;

/** `codexMcpServers` com o lançador de teste, as variáveis de teste e o acesso dado. */
function run(env: Env, names: string[] | null, access?: McpAccessMap, launcher: { command: string; args: string[] } | null = LAUNCH) {
  return codexMcpServers(env.proj, names, env.claude, {
    access,
    snapshotFile: env.snapshotFile,
    launcher,
    clubFile: env.club,
    vault: { dir: env.vaultDir, platform: 'linux' },
    toolsFile: env.toolsFile,
    env: VARS,
  });
}

const SECRETS = [VALOR_LIB, HDR_LIB, VALOR_PROJ, LITERAL];

describe('codexMcpServers: a biblioteca entra pelo lançador, sem valor', () => {
  it('stdio da biblioteca vira o lançador com --server, --club e --vault; o cofre não sai', async () => {
    const env = await setup();
    const r = await run(env, ['lfs']);
    expect(r.servers).toEqual([{ name: 'lfs', command: LAUNCH.command, args: [...LAUNCH.args, '--server', 'lfs', '--club', env.club, '--vault', env.vaultDir] }]);
    expect(r.out).toEqual([]);
    // A biblioteca não precisa de arquivo de lançamento: nada gravado.
    await expect(fs.access(env.snapshotFile)).rejects.toThrow();
  });

  it('http da biblioteca com cabeçalho vira headersHelper com --headers; a URL segue como está', async () => {
    const env = await setup();
    const r = await run(env, ['lweb']);
    const helper = quotedCommand([LAUNCH.command, ...LAUNCH.args, '--headers', '--server', 'lweb', '--club', env.club, '--vault', env.vaultDir]);
    expect(r.servers).toEqual([{ name: 'lweb', url: 'https://mcp.exemplo.com/mcp', headersHelper: helper }]);
    expect(helper).toMatch(/^"C:\/node\/node\.exe" "C:\/club\/dist\/mcp-launch\.mjs" "--headers" "--server" "lweb" /);
    expect(JSON.stringify(r.servers)).not.toContain(HDR_LIB);
  });

  it('sse fica de fora com o motivo sse; http sem cabeçalho entra pela URL, mesmo sem lançador', async () => {
    const env = await setup();
    const sse = await run(env, ['lsse']);
    expect(sse.servers).toEqual([]);
    expect(sse.out).toEqual([{ name: 'lsse', motivo: 'sse' }]);
    const sem = await run(env, ['phttpsemcab'], undefined, null);
    expect(sem.servers).toEqual([{ name: 'phttpsemcab', url: 'https://sem.exemplo.com/mcp' }]);
  });

  it('sem lançador, o que precisa dele fica de fora como indisponivel', async () => {
    const env = await setup();
    const r = await run(env, ['lfs', 'lweb', 'pstdio', 'phttp'], undefined, null);
    expect(r.servers).toEqual([]);
    expect(r.out).toEqual(['lfs', 'lweb', 'pstdio', 'phttp'].map((name) => ({ name, motivo: 'indisponivel' })));
  });

  it('cofre sem o valor: fora com o motivo cofre, e o aviso não traz o valor', async () => {
    const env = await setup();
    await fs.rm(env.vaultDir, { recursive: true, force: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run(env, ['lfs', 'lweb']);
    expect(r.servers).toEqual([]);
    expect(r.out).toEqual([
      { name: 'lfs', motivo: 'cofre' },
      { name: 'lweb', motivo: 'cofre' },
    ]);
    const log = warn.mock.calls.flat().join(' ');
    expect(log).toContain('FS_TOKEN');
    for (const s of SECRETS) expect(log).not.toContain(s);
    warn.mockRestore();
  });

  it('caminho da biblioteca com % não passa no headersHelper: fora como caminho; o stdio segue', async () => {
    const env = await setup();
    const pct = path.join(env.dir, 'pct%x');
    await fs.mkdir(pct, { recursive: true });
    const club = path.join(pct, 'mcps.json');
    await fs.copyFile(env.club, club);
    const r = await codexMcpServers(env.proj, ['lfs', 'lweb'], env.claude, {
      snapshotFile: env.snapshotFile,
      launcher: LAUNCH,
      clubFile: club,
      vault: { dir: env.vaultDir, platform: 'linux' },
      toolsFile: env.toolsFile,
      env: VARS,
    });
    expect(r.servers.map((s) => s.name)).toEqual(['lfs']);
    expect(r.out).toEqual([{ name: 'lweb', motivo: 'caminho' }]);
  });
});

describe('codexMcpServers: o acesso da ficha (mcpAccess) no Codex', () => {
  it('off: fica de fora, sem aviso', async () => {
    const env = await setup();
    const r = await run(env, ['pstdio'], { pstdio: 'off' });
    expect(r.servers).toEqual([]);
    expect(r.out).toEqual([]);
  });

  it('readonly com teste: só as ferramentas de leitura (enabled_tools), sem "pede antes"', async () => {
    const env = await setup();
    const r = await run(env, ['pstdio'], { pstdio: 'readonly' });
    expect(r.servers).toHaveLength(1);
    expect(r.servers[0]).toMatchObject({ name: 'pstdio', enabledTools: ['buscar'] });
    expect(r.asked).toEqual([]);
  });

  it('readonly sem teste: fora como política (sem lista de leitura, o servidor inteiro sai)', async () => {
    const env = await setup();
    const r = await run(env, ['psem'], { psem: 'readonly' });
    expect(r.servers).toEqual([]);
    expect(r.out).toEqual([{ name: 'psem', motivo: 'politica' }]);
  });

  it('ask sem teste: também fora como política (o Codex não tem como perguntar)', async () => {
    const env = await setup();
    const r = await run(env, ['psem'], { psem: 'ask' });
    expect(r.out).toEqual([{ name: 'psem', motivo: 'politica' }]);
  });

  it('ask com teste: só leitura (enabled_tools) e entra na lista de "pede antes" da ficha', async () => {
    const env = await setup();
    const r = await run(env, ['pstdio'], { pstdio: 'ask' });
    expect(r.servers[0]).toMatchObject({ name: 'pstdio', enabledTools: ['buscar'] });
    expect(r.asked).toEqual(['pstdio']);
  });

  it('free: entra sem enabled_tools', async () => {
    const env = await setup();
    const r = await run(env, ['pstdio'], { pstdio: 'free' });
    expect(r.servers[0]).not.toHaveProperty('enabledTools');
    expect(r.asked).toEqual([]);
  });

  it('http com cabeçalho e "pede antes": headersHelper, enabled_tools e aviso', async () => {
    const env = await setup();
    const r = await run(env, ['phttp'], { phttp: 'ask' });
    expect(r.servers[0]).toMatchObject({ name: 'phttp', url: 'https://proj.exemplo.com/mcp', enabledTools: ['buscar'] });
    expect(r.servers[0]).toHaveProperty('headersHelper');
    expect(r.asked).toEqual(['phttp']);
  });

  it('a biblioteca tem o mesmo acesso: readonly com teste limita as ferramentas', async () => {
    const env = await setup();
    const r = await run(env, ['lweb'], { lweb: 'readonly' });
    expect(r.servers[0]).toMatchObject({ name: 'lweb', enabledTools: ['buscar'] });
  });
});

describe('codexMcpServers: o projeto e o arquivo de lançamento', () => {
  it('stdio do projeto: comando, argumentos e ambiente só no arquivo; ${VAR} e literal expandidos no arquivo', async () => {
    const env = await setup();
    const r = await run(env, ['pstdio', 'phttp']);
    const snap = JSON.parse(await fs.readFile(env.snapshotFile, 'utf8')) as { servers: Record<string, unknown> };
    expect(snap.servers.pstdio).toEqual({ type: 'stdio', command: 'node', args: ['p.js', '--flag'], env: { TOKEN_P: VALOR_PROJ, LIT: LITERAL } });
    expect(snap.servers.phttp).toEqual({ type: 'http', headers: { Authorization: `Bearer ${VALOR_PROJ}` } });
    const stdio = r.servers.find((s) => s.name === 'pstdio');
    // Sem acesso na ficha (free): sem enabled_tools.
    expect(stdio).toEqual({ name: 'pstdio', command: LAUNCH.command, args: [...LAUNCH.args, '--snapshot', env.snapshotFile, '--server', 'pstdio'] });
  });

  it('nenhum valor de env ou cabeçalho em servers nem na linha de comando', async () => {
    const env = await setup();
    const r = await run(env, ['lfs', 'lweb', 'pstdio', 'phttp', 'pfake']);
    const args = buildCodexArgs({
      cwd: env.proj,
      sandbox: 'workspace',
      secrets: { projectPath: env.proj, home: '/home/u', mycoHome: '/home/u/.myco' },
      network: 'off',
      platform: 'linux',
      extraMcps: r.servers,
    });
    const dump = JSON.stringify(r.servers) + '\n' + args.join('\n');
    for (const s of SECRETS) expect(dump).not.toContain(s);
    expect(r.servers.map((s) => s.name)).toEqual(['lfs', 'lweb', 'pstdio', 'phttp', 'pfake']);
  });

  it('variável ausente sem padrão: fora como variavel, e o aviso diz só o nome', async () => {
    const env = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run(env, ['pvar']);
    expect(r.out).toEqual([{ name: 'pvar', motivo: 'variavel' }]);
    expect(warn.mock.calls.flat().join(' ')).toContain('NAO_EXISTE_ZZ9');
    warn.mockRestore();
  });

  it('url com chave na query sai como url-segredo; a linha de comando não leva a chave', async () => {
    const env = await setup();
    const r = await run(env, ['pkey']);
    expect(r.servers).toEqual([]);
    expect(r.out).toEqual([{ name: 'pkey', motivo: 'url-segredo' }]);
  });

  it('argumento que não é texto, nome fora do padrão e servidor SSE do projeto: cada um com o seu motivo', async () => {
    const env = await setup();
    const r = await run(env, ['pbad', 'pontos.nome', 'psse', 'myco-ssh', 'nao-existe']);
    expect(r.servers).toEqual([]);
    expect(r.out).toHaveLength(3);
    expect(r.out).toEqual(
      expect.arrayContaining([
        { name: 'pbad', motivo: 'transporte' },
        { name: 'pontos.nome', motivo: 'nome' },
        { name: 'psse', motivo: 'sse' },
      ]),
    );
  });

  it('nomes reservados (internos do Codex) são ignorados em silêncio, como nomes que não existem', async () => {
    const env = await setup();
    const r = await run(env, ['myco-ssh', 'myco-chrome', 'claude-in-chrome', 'myco-gpt', 'myco-ftp', 'nao-existe']);
    expect(r).toEqual({ servers: [], asked: [], out: [] });
  });

  it('sem lista da ficha (null): entra o do projeto, mas não a biblioteca', async () => {
    const env = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run(env, null);
    warn.mockRestore();
    const names = r.servers.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['pstdio', 'phttp']));
    expect(names).not.toContain('lfs');
    expect(names).not.toContain('lweb');
  });

  it('o MCP do projeto que pede ${VAR} sem o valor no ambiente: fora como variavel', async () => {
    const env = await setup();
    const r = await codexMcpServers(env.proj, ['pstdio'], env.claude, {
      snapshotFile: env.snapshotFile,
      launcher: LAUNCH,
      clubFile: env.club,
      toolsFile: env.toolsFile,
      env: {},
    });
    expect(r.out).toEqual([{ name: 'pstdio', motivo: 'variavel' }]);
  });
});

describe('codexExtraMcpArgs e buildCodexArgs: os -c dos MCPs extras', () => {
  it('stdio: command, args e aprovação, nessa ordem; sem lista, sem enabled_tools', () => {
    expect(codexExtraMcpArgs([{ name: 'lfs', command: 'C:/node.exe', args: ['a b', '--x'] }])).toEqual([
      '-c', `mcp_servers.lfs.command=${tomlString('C:/node.exe')}`,
      '-c', `mcp_servers.lfs.args=[${tomlString('a b')},${tomlString('--x')}]`,
      '-c', 'mcp_servers.lfs.default_tools_approval_mode="approve"',
    ]);
  });

  it('http com helper e lista: url, http_headers_helper (string TOML), aprovação e enabled_tools', () => {
    const helper = '"C:/node.exe" "--headers"';
    expect(codexExtraMcpArgs([{ name: 'lweb', url: 'https://mcp.exemplo.com/mcp', headersHelper: helper, enabledTools: ['buscar'] }])).toEqual([
      '-c', `mcp_servers.lweb.url=${tomlString('https://mcp.exemplo.com/mcp')}`,
      '-c', `mcp_servers.lweb.http_headers_helper=${tomlString(helper)}`,
      '-c', 'mcp_servers.lweb.default_tools_approval_mode="approve"',
      '-c', `mcp_servers.lweb.enabled_tools=[${tomlString('buscar')}]`,
    ]);
    // Sem cabeçalho, não há helper.
    expect(codexExtraMcpArgs([{ name: 'phttp', url: 'https://x.exemplo.com/mcp' }]).some((a) => a.includes('http_headers_helper'))).toBe(false);
  });

  it('nome reservado ou fora do padrão é pulado, mesmo que chegue aqui', () => {
    const bruto: CodexExtraMcp[] = [
      { name: 'myco-ssh', command: 'x', args: [] },
      { name: 'myco-chrome', command: 'x', args: [] },
      { name: 'myco-navegador', command: 'x', args: [] },
      { name: 'myco-ftp', command: 'x', args: [] },
      { name: 'myco-gpt', command: 'x', args: [] },
      { name: 'claude-in-chrome', command: 'x', args: [] },
      { name: 'pontos.nome', command: 'x', args: [] },
      { name: 'com espaco', command: 'x', args: [] },
      { name: 'x'.repeat(65), command: 'x', args: [] },
    ];
    expect(codexExtraMcpArgs(bruto)).toEqual([]);
    expect(codexExtraMcpArgs(undefined)).toEqual([]);
  });

  it('buildCodexArgs põe os MCPs extras depois do navegador limpo; sem eles, nenhum mcp_servers', () => {
    const base = { cwd: '/proj', sandbox: 'workspace' as const, secrets: { projectPath: '/proj', home: '/home/u', mycoHome: '/home/u/.myco' }, network: 'off' as const, platform: 'linux' as const };
    const com = buildCodexArgs({ ...base, extraMcps: [{ name: 'lfs', command: 'C:/node.exe', args: ['x'] }] });
    expect(com.some((a) => a.startsWith('mcp_servers.lfs.command='))).toBe(true);
    expect(com[com.length - 1]).toBe('-');
    expect(buildCodexArgs(base).some((a) => a.includes('mcp_servers'))).toBe(false);
  });
});

describe('quotedCommand e expandVars', () => {
  it('cita cada parte com aspas duplas, separadas por espaço; recusa aspas, %, $, crase e controle', () => {
    expect(quotedCommand(['C:/x y/node.exe', '--headers'])).toBe('"C:/x y/node.exe" "--headers"');
    for (const ruim of ['a"b', 'a%b', 'a$b', 'a`b', 'a\tb']) expect(quotedCommand(['ok', ruim])).toBeNull();
  });

  it('${VAR}, ${VAR:-padrão}: vazia conta como definida, exceto no :-; a falta sem padrão devolve só o nome', () => {
    expect(expandVars('${A}-${B:-d}', { A: '1' })).toEqual({ value: '1-d' });
    expect(expandVars('${A}', { A: '' })).toEqual({ value: '' });
    expect(expandVars('${B:-d}', { B: '' })).toEqual({ value: 'd' });
    expect(expandVars('x${NAO}y', {})).toEqual({ missing: 'NAO' });
    expect(expandVars('sem variavel', {})).toEqual({ value: 'sem variavel' });
  });
});

describe('snapshotSpec e o lançador: o arquivo da conversa', () => {
  async function arquivo(dir: string): Promise<string> {
    const f = path.join(dir, 'codex-mcp.json');
    await fs.writeFile(
      f,
      JSON.stringify({
        servers: {
          fs: { type: 'stdio', command: 'node', args: ['srv.js'], env: { FS_TOKEN: VALOR_LIB } },
          web: { type: 'http', headers: { Authorization: HDR_LIB } },
          aberto: { type: 'http', headers: {} },
        },
      }),
    );
    return f;
  }

  it('stdio: comando, argumentos e ambiente do arquivo; http: cabeçalhos do arquivo', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'snap-'));
    const f = await arquivo(dir);
    expect(await snapshotSpec('fs', f)).toEqual({ command: 'node', args: ['srv.js'], env: { FS_TOKEN: VALOR_LIB } });
    expect(await snapshotSpec('web', f)).toEqual({ headers: { Authorization: HDR_LIB } });
    expect(await snapshotSpec('aberto', f)).toEqual({ headers: {} });
  });

  it('nome ausente, __proto__, nome inválido e arquivo que falta: recusados, sem valor na mensagem', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'snap-'));
    const f = await arquivo(dir);
    const erro = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
    const ausente = await erro(snapshotSpec('nao-existe', f));
    expect(ausente).toBeInstanceOf(McpLaunchError);
    expect((ausente as Error).message).toContain('não está nesta conversa');
    const proto = await erro(snapshotSpec('__proto__', f));
    expect(proto).toBeInstanceOf(McpLaunchError);
    expect((proto as Error).message).toContain('não está nesta conversa');
    expect(await erro(snapshotSpec('../fs', f))).toBeInstanceOf(McpLaunchError);
    const sumiu = await erro(snapshotSpec('fs', path.join(dir, 'nao-existe.json')));
    expect((sumiu as Error).message).toContain('não está nesta conversa');
    for (const e of [ausente, proto, sumiu]) expect(String((e as Error).message)).not.toContain(VALOR_LIB);
  });

  it('arquivo estragado (formato errado): recusado como arquivo estragado', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'snap-'));
    const f = path.join(dir, 'codex-mcp.json');
    await fs.writeFile(f, JSON.stringify({ servers: { fs: { type: 'stdio', command: 5 } } }));
    await expect(snapshotSpec('fs', f)).rejects.toThrow('estragado');
  });

  it('--snapshot --headers imprime só o JSON dos cabeçalhos do arquivo', async () => {
    const env = await setup();
    const L = mcpLaunchCommand(false);
    await run(env, ['phttp'], undefined, L);
    const r = spawnSync(L.command, [...L.args, '--headers', '--snapshot', env.snapshotFile, '--server', 'phttp'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALOR_PROJ}` });
  }, 60_000);

  it('--snapshot sobe o comando do arquivo com o ambiente expandido e repassa o código de saída', async () => {
    const env = await setup();
    const L = mcpLaunchCommand(false);
    await run(env, ['pfake'], undefined, L);
    const r = spawnSync(L.command, [...L.args, '--snapshot', env.snapshotFile, '--server', 'pfake'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(r.status).toBe(7);
    expect(await fs.readFile(env.out, 'utf8')).toBe(VALOR_PROJ);
    expect(`${r.stdout}${r.stderr}`).not.toContain(VALOR_PROJ);
  }, 60_000);
});

describe('prepareCodexRun: os MCPs da ficha entram pelo lançador, e a ficha diz o que ficou fora', () => {
  const profile = (over: Partial<StaffProfile> = {}) =>
    ({
      id: 'ana-1',
      projectId: 'proj-id',
      name: 'Ana',
      role: 'Ops',
      mission: 'Cuidar do servidor',
      firstTask: '',
      autonomy: 'acceptEdits',
      agents: [],
      skills: [],
      mcps: [],
      knowledge: [],
      rules: [],
      doneWhen: '',
      reportsTo: [],
      engine: 'codex',
      model: null,
      effort: null,
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      sshWrite: [],
      browser: false,
      portrait: null,
      sessions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as unknown as StaffProfile;

  /** Projeto com .mcp.json (stdio com literal, SSE). A biblioteca não entra: a conversa escolhe só nomes do projeto. */
  async function projeto(): Promise<{ dir: string; proj: string; ctx: (launcher: LaunchContext['mcpLauncher']) => LaunchContext }> {
    const dir = await fs.mkdtemp(path.join(root, 'prep-'));
    const proj = path.join(dir, 'proj');
    await fs.mkdir(proj, { recursive: true });
    await fs.writeFile(
      path.join(proj, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          psvc: { type: 'stdio', command: 'node', args: ['x.js'], env: { K: 'valor-literal-ZZ99' } },
          psse: { type: 'sse', url: 'https://s.exemplo.com/sse' },
        },
      }),
    );
    return {
      dir,
      proj,
      ctx: (launcher) => ({
        company: 'Co',
        projectName: 'proj',
        projectPath: proj,
        managerNames: [],
        mycoUrl: 'http://127.0.0.2:1',
        runDir: path.join(dir, 'run'),
        claudeConfigFile: path.join(dir, 'claude.json'),
        mcpLauncher: launcher,
      }),
    };
  }

  it('o servidor do projeto vai com o lançador e o arquivo da conversa; o SSE aparece na ficha com o motivo', async () => {
    const { dir, proj, ctx } = await projeto();
    const run1 = await prepareCodexRun(profile({ mcps: ['psvc', 'psse'] }), ctx(LAUNCH), 'sess-x', proj);
    const snapshot = path.join(dir, 'run', 'sess-x', 'codex-mcp.json');
    expect(run1.extraMcps).toEqual([{ name: 'psvc', command: LAUNCH.command, args: [...LAUNCH.args, '--snapshot', snapshot, '--server', 'psvc'] }]);
    expect(JSON.parse(await fs.readFile(snapshot, 'utf8'))).toEqual({ servers: { psvc: { type: 'stdio', command: 'node', args: ['x.js'], env: { K: 'valor-literal-ZZ99' } } } });
    expect(run1.readOnlyPaths).toContain(path.join(proj, '.mcp.json'));
    const md = await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');
    expect(md).toContain('Ficaram fora desta conversa no Codex: `psse` (SSE não existe no Codex');
  });

  it('sem o lançador: o servidor do projeto fica de fora (indisponível) e não sobra arquivo de lançamento', async () => {
    const { dir, proj, ctx } = await projeto();
    const r = await prepareCodexRun(profile({ mcps: ['psvc'] }), ctx(null), 'sess-y', proj);
    expect(r.extraMcps).toEqual([]);
    await expect(fs.access(path.join(dir, 'run', 'sess-y', 'codex-mcp.json'))).rejects.toThrow();
    const md = await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');
    expect(md).toContain('`psvc` (o lançador do Claudio’s Club não está instalado');
  });
});
