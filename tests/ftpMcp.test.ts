import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project, StaffProfile } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { buildClaudeArgs, renderFicha, secretDenyRules, type FichaContext } from '../server/staff/ficha';
import { saveFtpConnection, type FtpConnector, type FtpEntry, type FtpSession } from '../server/staff/ftp';
import { createFtpMcp, ftpMcpCommand, ftpMcpServerConfig, resolveLocal, TOOLS } from '../server/staff/ftpMcp';
import { StaffService } from '../server/staff/service';

const PASSWORD = 'Senha-Do-FTP-123';

let root: string;
let proj: string;
let vault: { dir: string; platform: NodeJS.Platform };

/** FTP falso em memória: pastas e arquivos por caminho absoluto. */
function fakeFtp() {
  const dirs = new Set(['/', '/home', '/home/u', '/public_html', '/public_html/css']);
  const files = new Map<string, Buffer>([['/public_html/index.html', Buffer.from('<h1>oi</h1>')]]);
  const passwords: string[] = [];
  const notFound = () => Object.assign(new Error('550 No such file'), { code: 550 });
  const connect: FtpConnector = async (_c, password) => {
    passwords.push(password);
    const session: FtpSession = {
      pwd: async () => '/home/u',
      list: async (dir) => {
        if (!dirs.has(dir)) throw notFound();
        const child = (p: string) => path.posix.dirname(p) === dir && p !== dir;
        const out: FtpEntry[] = [
          ...[...dirs].filter(child).map((d) => ({ name: path.posix.basename(d), type: 'dir' as const, size: 0, modifiedAt: null })),
          ...[...files].filter(([f]) => child(f)).map(([f, b]) => ({ name: path.posix.basename(f), type: 'file' as const, size: b.length, modifiedAt: '2026-11-01T00:00:00.000Z' })),
        ];
        return out;
      },
      size: async (f) => {
        const b = files.get(f);
        if (!b) throw notFound();
        return b.length;
      },
      download: async (r, dest: Writable) => {
        const b = files.get(r);
        if (!b) throw notFound();
        await pipeline(Readable.from([b]), dest);
      },
      upload: async (src, r) => {
        if (!dirs.has(path.posix.dirname(r))) throw notFound();
        const chunks: Buffer[] = [];
        for await (const c of src) chunks.push(Buffer.from(c as Buffer));
        files.set(r, Buffer.concat(chunks));
      },
      remove: async (f) => {
        if (!files.delete(f)) throw notFound();
      },
      removeDir: async (d) => {
        if (!dirs.delete(d)) throw notFound();
      },
      rename: async (a, b) => {
        const v = files.get(a);
        if (!v) throw notFound();
        files.delete(a);
        files.set(b, v);
      },
      mkdir: async (d) => {
        for (let p = d; p !== '/'; p = path.posix.dirname(p)) dirs.add(p);
      },
      close: () => {},
    };
    return session;
  };
  return { connect, dirs, files, passwords };
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ftpmcp-'));
  proj = path.join(root, 'proj');
  vault = { dir: path.join(root, 'secrets'), platform: 'linux' };
  await fs.mkdir(path.join(proj, '.myco', 'staff'), { recursive: true });
  await fs.mkdir(path.join(proj, 'dist'), { recursive: true });
  await fs.writeFile(path.join(proj, 'dist', 'app.js'), 'console.log(1)');
  await fs.writeFile(path.join(proj, '.env'), `SENHA=${PASSWORD}`);
  await fs.mkdir(path.join(proj, '.git'), { recursive: true });
  await fs.writeFile(path.join(proj, '.git', 'config'), 'x');
  await saveFtpConnection(proj, { name: 'site', protocol: 'ftps', host: 'ftp.example.com', user: 'u', remoteRoot: '/public_html', password: PASSWORD }, vault);
  await saveFtpConnection(proj, { name: 'outro', protocol: 'ftp', host: 'ftp2.example.com', user: 'u', password: 'outra' }, vault);
  await fs.writeFile(path.join(proj, '.myco', 'staff', 'ana-1.json'), JSON.stringify({ servers: ['site'] }));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const text = (r: unknown) => (r as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
const isError = (r: unknown) => (r as { result: { isError?: boolean } }).result.isError === true;

describe('MCP de FTP: protocolo', () => {
  it('initialize, ping, tools/list, notificação e método desconhecido', async () => {
    const mcp = createFtpMcp({ projectPath: proj, root: proj, staffId: 'ana-1', allowed: ['site'], vault });
    const init = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })) as {
      result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
    };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'myco-ftp' } });
    expect(((await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
    expect(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    const list = (await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' })) as { result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['ftp_list', 'ftp_download', 'ftp_upload', 'ftp_delete', 'ftp_rename', 'ftp_mkdir']);
    for (const t of list.result.tools) expect(t.inputSchema.required).toContain('connection');
    expect(await mcp.handle({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
    expect(await mcp.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'rm_rf' } })).toMatchObject({ error: { code: -32602 } });
  });
});

describe('MCP de FTP: ferramentas com um FTP falso', () => {
  const setup = (allowed = ['site'], staffId: string | null = 'ana-1') => {
    const f = fakeFtp();
    const mcp = createFtpMcp({ projectPath: proj, root: proj, staffId, allowed, vault, connect: f.connect });
    let id = 10;
    const call = (name: string, args: Record<string, unknown>) => mcp.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
    return { f, call };
  };

  it('lista, envia, baixa, renomeia, cria pasta e apaga, presa à pasta da conexão', async () => {
    const { f, call } = setup();
    const ls = await call('ftp_list', { connection: 'site' });
    expect(text(ls)).toContain('site:/public_html (2 itens)');
    expect(text(ls)).toContain('index.html');
    expect(f.passwords).toEqual([PASSWORD]); // a senha só chega ao cliente FTP

    const up = await call('ftp_upload', { connection: 'site', local: 'dist/app.js', remote: 'css/app.js' });
    expect(isError(up)).toBe(false);
    expect(f.files.get('/public_html/css/app.js')?.toString()).toBe('console.log(1)');
    // Já existe: só com overwrite.
    expect(text(await call('ftp_upload', { connection: 'site', local: 'dist/app.js', remote: 'css/app.js' }))).toContain('overwrite: true');
    expect(isError(await call('ftp_upload', { connection: 'site', local: 'dist/app.js', remote: 'css/app.js', overwrite: true }))).toBe(false);

    const down = await call('ftp_download', { connection: 'site', remote: 'index.html', local: 'baixado/index.html' });
    expect(text(down)).toContain('baixado/index.html');
    expect(await fs.readFile(path.join(proj, 'baixado', 'index.html'), 'utf8')).toBe('<h1>oi</h1>');
    expect(text(await call('ftp_download', { connection: 'site', remote: 'index.html', local: 'baixado/index.html' }))).toContain('já existe');
    expect((await fs.readdir(path.join(proj, 'baixado'))).filter((n) => n.endsWith('.part'))).toEqual([]);

    expect(isError(await call('ftp_rename', { connection: 'site', from: 'css/app.js', to: 'css/app2.js' }))).toBe(false);
    expect(f.files.has('/public_html/css/app2.js')).toBe(true);
    expect(isError(await call('ftp_mkdir', { connection: 'site', path: 'img/2026' }))).toBe(false);
    expect(f.dirs.has('/public_html/img/2026')).toBe(true);
    expect(isError(await call('ftp_delete', { connection: 'site', path: 'css/app2.js' }))).toBe(false);
    expect(isError(await call('ftp_delete', { connection: 'site', path: 'img/2026', directory: true }))).toBe(false);

    // Remoto fora da pasta, ou a pasta inteira: recusado sem chegar ao servidor.
    for (const [tool, args] of [
      ['ftp_list', { path: '../' }],
      ['ftp_delete', { path: '/etc/passwd' }],
      ['ftp_download', { remote: '..\\..\\etc\\passwd', local: 'x.txt' }],
      ['ftp_delete', { path: '.', directory: true }],
      ['ftp_rename', { from: 'index.html', to: '/tmp/index.html' }],
    ] as const) {
      const r = await call(tool, { connection: 'site', ...args });
      expect(isError(r), `${tool} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(f.files.has('/public_html/index.html')).toBe(true);
  });

  it('conexão não autorizada (ou tirada da ficha) é recusada, sem conectar', async () => {
    const { f, call } = setup(['site']);
    const r = await call('ftp_list', { connection: 'outro' });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain('não está autorizada');
    // Autorizada quando a sessão abriu, mas a ficha mudou depois.
    const { f: f2, call: call2 } = setup(['site', 'outro']);
    expect(text(await call2('ftp_list', { connection: 'outro' }))).toContain('saiu da sua ficha');
    expect([...f.passwords, ...f2.passwords]).toEqual([]);
    // Ficha que não existe: nada passa.
    const { call: call3 } = setup(['site'], 'ninguem');
    expect(isError(await call3('ftp_list', { connection: 'site' }))).toBe(true);
  });

  it('caminho local preso ao projeto: .., absoluto de fora, .git, .vps, .env, .myco, link para fora', async () => {
    const { f, call } = setup();
    const outside = path.join(root, 'fora');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'x.txt'), 'fora');
    await fs.symlink(outside, path.join(proj, 'link'), 'junction');
    for (const local of ['../fora/x.txt', path.join(outside, 'x.txt'), '.git/config', '.vps/ftp.json', '.env', '.myco/staff/ana-1.json', 'link/x.txt', 'C:\\Windows\\win.ini']) {
      const r = await call('ftp_upload', { connection: 'site', local, remote: 'x.txt' });
      expect(isError(r), local).toBe(true);
      const d = await call('ftp_download', { connection: 'site', remote: 'index.html', local, overwrite: true });
      expect(isError(d), `download ${local}`).toBe(true);
    }
    // Baixar não sobrescreve a ficha nem cria arquivo fora.
    expect(JSON.parse(await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.json'), 'utf8'))).toEqual({ servers: ['site'] });
    expect(await fs.readFile(path.join(outside, 'x.txt'), 'utf8')).toBe('fora');
    // A senha nunca aparece no que o funcionário vê.
    expect(JSON.stringify([...f.files.values()].map(String))).not.toContain(PASSWORD);
  });

  it('limite de tamanho: arquivo grande não passa', async () => {
    const f = fakeFtp();
    f.files.set('/public_html/grande.bin', Buffer.alloc(2048));
    const mcp = createFtpMcp({ projectPath: proj, root: proj, staffId: 'ana-1', allowed: ['site'], vault, connect: f.connect, maxBytes: 1024 });
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ftp_download', arguments: { connection: 'site', remote: 'grande.bin', local: 'g.bin' } } });
    expect(text(r)).toContain('grande demais');
    await expect(fs.stat(path.join(proj, 'g.bin'))).rejects.toThrow();
    await expect(resolveLocal(proj, 'dist/app.js', 'read', { maxBytes: 3 })).rejects.toThrow('grande demais');
  });

  it('erro do servidor vira mensagem sem a senha', async () => {
    const mcp = createFtpMcp({
      projectPath: proj,
      root: proj,
      staffId: 'ana-1',
      allowed: ['site'],
      vault,
      connect: async (_c, pw) => {
        throw Object.assign(new Error(`530 senha ${pw} recusada`), { code: 999 });
      },
    });
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ftp_list', arguments: { connection: 'site' } } });
    expect(isError(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });
});

describe('MCP de FTP: lançamento e ficha', () => {
  it('em dev sobe pelo tsx e responde initialize e tools/list no stdio', async () => {
    const cfg = ftpMcpServerConfig({ projectPath: proj, root: proj, staffId: 'ana-1', connections: ['site'], vaultDir: vault.dir });
    expect(ftpMcpCommand(false).args).toContain('--import');
    expect(JSON.stringify(cfg)).not.toContain(PASSWORD);
    const child = spawn(cfg.command, cfg.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const lines = out.trim().split('\n').map((l) => JSON.parse(l) as { id: number; result: { tools?: unknown[] } });
    expect(lines.map((l) => l.id).sort()).toEqual([1, 2]);
    expect(lines.find((l) => l.id === 2)!.result.tools).toHaveLength(TOOLS.length);
  }, 30_000);

  const profile = (over: Partial<StaffProfile> = {}): StaffProfile =>
    ({
      id: 'ana-1',
      projectId: 'p',
      name: 'Ana',
      role: 'Deploy',
      mission: 'Publicar',
      firstTask: '',
      reportsTo: [],
      skills: [],
      agents: [],
      knowledge: [],
      rules: [],
      doneWhen: '',
      servers: ['site'],
      browser: false,
      mcps: null,
      autonomy: 'manual',
      model: null,
      effort: null,
      canHire: false,
      playbook: null,
      worktree: false,
      sessions: [],
      ...over,
    }) as unknown as StaffProfile;

  it('ficha: FTP com as ferramentas mcp__myco-ftp__ftp_*, sem pedir senha; só FTP não libera o ssh', () => {
    const ctx = { company: 'X', projectName: 'p', projectPath: proj, managerNames: [], fichaPath: 'f', memoryPath: 'm', mycoUrl: 'u' } as FichaContext;
    const md = renderFicha(profile({ servers: ['site', 'outro'] }), {
      ...ctx,
      servers: [
        { name: 'site', source: 'ftp', protocol: 'ftps', host: 'ftp.example.com', remoteRoot: '/public_html' },
        { name: 'outro', source: 'ftp', protocol: 'ftp', host: 'ftp2.example.com', remoteRoot: null },
      ],
    });
    expect(md).toContain('- `site` (FTPS): ftp.example.com, projeto em `/public_html`');
    expect(md).toContain('`outro` (FTP sem criptografia');
    expect(md).toContain('`mcp__myco-ftp__ftp_upload`');
    expect(md).toContain('nunca lê, pede, procura');
    expect(md).not.toContain('ssh -F'); // só FTP: nada de instrução de ssh
    expect(md).not.toContain(PASSWORD);

    const deny = secretDenyRules(profile(), [], ['site']);
    expect(deny).toEqual(expect.arrayContaining(['Bash(ssh:*)', 'PowerShell(scp:*)', 'Read(**/.env)', 'Read(~/.myco/secrets/**)']));
    // Com uma SSH na ficha, o ssh fica liberado.
    expect(secretDenyRules(profile({ servers: ['site', 'prod'] }), [], ['site'])).not.toContain('Bash(ssh:*)');
    // Sem lista de MCPs na ficha, o de FTP só se soma (sem --strict-mcp-config).
    const args = buildClaudeArgs(profile(), { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: 'M', firstPrompt: null, strictMcp: false, ftpServers: ['site'] });
    expect(args.slice(-2)).toEqual(['--mcp-config', 'M']);
  });

  it('contratar com FTP na ficha: a sessão sobe o MCP com projeto e nomes, nunca a senha', async () => {
    const project: Project = { id: 'proj-id', path: proj, name: 'proj', exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null };
    const adapter = { listProjects: async () => [project] } as unknown as ToolAdapter;
    const svc = new StaffService(adapter, {
      runDir: path.join(root, 'run'),
      claudeConfigFile: path.join(root, 'claude.json'),
      mycoUrl: 'x',
      readUsage: async () => ({ tapInstalled: true, limits: [], updatedAt: null }),
      vault,
    });

    // A tela: SSH e FTP juntos, com protocol, e nunca a senha.
    const conns = (await svc.listConnections('proj-id'))!;
    expect(conns.map((c) => [c.name, c.protocol])).toEqual([
      ['site', 'ftps'],
      ['outro', 'ftp'],
    ]);
    const servers = (await svc.listServers('proj-id'))!;
    expect(servers.map((s) => s.name)).toEqual(['site', 'outro']);
    expect(JSON.stringify([conns, servers])).not.toMatch(new RegExp(`${PASSWORD}|outra"`));

    const hired = (await svc.hire('proj-id', { name: 'Fê', role: 'Deploy', mission: 'Publicar o site', servers: ['site'], launch: false }, true))!;
    const spawned = (await svc.chatSpawn('proj-id', null, hired.profile.id))!;
    const mcpPath = spawned.args[spawned.args.indexOf('--mcp-config') + 1]!;
    expect(spawned.args).not.toContain('--strict-mcp-config');
    const raw = await fs.readFile(mcpPath, 'utf8');
    expect(raw).not.toContain(PASSWORD);
    const cfg = JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const ftp = cfg.mcpServers['myco-ftp']!;
    expect(ftp.args).toEqual(expect.arrayContaining(['--project', proj, '--staff', hired.profile.id, '--connections', 'site']));
    const ficha = await fs.readFile(path.join(proj, '.myco', 'staff', `${hired.profile.id}.md`), 'utf8');
    expect(ficha).toContain('mcp__myco-ftp__ftp_list');
    expect(ficha + JSON.stringify(spawned.args)).not.toContain(PASSWORD);
    // Só FTP na ficha: ssh continua bloqueado.
    expect(spawned.args[spawned.args.indexOf('--disallowedTools') + 1]).toContain('Bash(ssh:*)');

    // Apagar pela mesma rota das SSH apaga a FTP e a senha.
    expect(await svc.removeConnection('proj-id', 'outro')).toBe(true);
    expect((await svc.listConnections('proj-id'))!.map((c) => c.name)).toEqual(['site']);
  }, 30_000);
});
