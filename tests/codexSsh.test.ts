import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerInfo, StaffProfile } from '../shared/model';
import { buildCodexArgs, codexProfileError, codexSshMcpArgs, tomlString } from '../server/chat/codexArgs';
import { renderFicha, isClaudeRoot } from '../server/staff/ficha';
import { prepareCodexRun, type LaunchContext } from '../server/staff/launch';
import { StaffInputSchema } from '../server/staff/store';
import { ROOT } from '../server/root';

let root: string;
/** Pacote do MCP de SSH de teste (o build de verdade não existe em dev sem `npm run build`). */
let BUNDLE: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-codex-ssh-'));
  BUNDLE = path.join(root, 'ssh-mcp.mjs');
  await fs.writeFile(BUNDLE, '// pacote de teste');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

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
    servers: ['srv1', 'srv2'],
    sshWrite: ['srv1'],
    browser: false,
    portrait: null,
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

const ssh = (name: string): ServerInfo => ({ name, source: 'vps', protocol: 'ssh', host: `${name}.example.com`, remoteRoot: '/srv/app' });
const ftp = (name: string): ServerInfo => ({ name, source: 'ftp', protocol: 'ftps', host: 'ftp.example.com', remoteRoot: '/' });

const fichaCtx = { company: 'Co', projectName: 'proj', projectPath: '/proj', managerNames: [], fichaPath: '.myco/staff/ana-1.md', memoryPath: '.myco/staff/ana-1.memory.md', mycoUrl: 'http://127.0.0.2:1' };

describe('codexSshMcpArgs: o MCP de SSH na linha de comando do Codex', () => {
  const loader = 'C:/x y/tsx/loader.mjs';
  const s = { command: 'C:/node.exe', args: ['--import', loader, '--project', 'C:/proj/site'] };

  it('gera command, args (TOML) e default_tools_approval_mode="approve"; sem servidor, nada', () => {
    const args = codexSshMcpArgs(s);
    expect(args).toEqual([
      '-c', `mcp_servers.myco-ssh.command=${tomlString('C:/node.exe')}`,
      '-c', `mcp_servers.myco-ssh.args=[${s.args.map((a) => tomlString(a)).join(',')}]`,
      '-c', 'mcp_servers.myco-ssh.default_tools_approval_mode="approve"',
    ]);
    expect(codexSshMcpArgs(null)).toEqual([]);
    expect(codexSshMcpArgs(undefined)).toEqual([]);
  });

  it('o cwd do MCP vai junto (ROOT do Claudio’s Club, com barras /)', () => {
    const args = codexSshMcpArgs({ ...s, cwd: 'C:\\Users\\didog\\Club' });
    expect(args).toContain(`mcp_servers.myco-ssh.cwd=${tomlString('C:/Users/didog/Club')}`);
    expect(args.join(' ')).not.toContain('\\');
  });

  it('buildCodexArgs põe os três -c só com sshMcp; sem ele não há mcp_servers', () => {
    const base = { cwd: '/proj', sandbox: 'workspace' as const, secrets: { projectPath: '/proj', home: '/home/u', mycoHome: '/home/u/.myco' }, network: 'off' as const, platform: 'linux' as const };
    const com = buildCodexArgs({ ...base, sshMcp: s });
    expect(com.filter((a) => a.startsWith('mcp_servers.myco-ssh.'))).toHaveLength(3);
    expect(com.some((a) => a.includes('mcp_servers.myco-ssh.default_tools_approval_mode="approve"'))).toBe(true);
    const sem = buildCodexArgs({ ...base, sshMcp: null });
    expect(sem.some((a) => a.includes('mcp_servers'))).toBe(false);
    expect(buildCodexArgs(base).some((a) => a.includes('mcp_servers'))).toBe(false);
    // O prompt segue por último (o `-` do stdin).
    expect(com[com.length - 1]).toBe('-');
  });

  it('com o MCP de SSH, a busca na web fica desligada mesmo com "Permitir acesso à internet" ligado', () => {
    const base = { cwd: '/proj', sandbox: 'workspace' as const, secrets: { projectPath: '/proj', home: '/home/u', mycoHome: '/home/u/.myco' }, network: 'off' as const, platform: 'linux' as const, internetAccess: true };
    expect(buildCodexArgs({ ...base, sshMcp: s })).toContain('web_search="disabled"');
    expect(buildCodexArgs({ ...base, sshMcp: s })).not.toContain('web_search="live"');
    expect(buildCodexArgs({ ...base, sshMcp: null })).toContain('web_search="live"');
  });
});

describe('regras da ficha no Codex', () => {
  it('FTP recusa no Codex (com o projeto); SSH passa', () => {
    expect(codexProfileError({ engine: 'codex', servers: ['srv1'], ftpServers: ['srv1'] })).toBe('Conexão FTP não funciona no Codex: tire as conexões FTP ou use o Claude');
    expect(codexProfileError({ engine: 'codex', servers: ['srv1'], ftpServers: ['outra'] })).toBeNull();
  });

  it('sshWrite fora de servers é erro de validação; dentro passa; ausente = nenhum', () => {
    const base = { name: 'Ana', role: 'Ops', mission: 'Cuidar', launch: false };
    const fora = StaffInputSchema.safeParse({ ...base, servers: ['srv1'], sshWrite: ['srv9'] });
    expect(fora.success).toBe(false);
    expect(StaffInputSchema.safeParse({ ...base, servers: ['srv1', 'srv9'], sshWrite: ['srv9'] }).success).toBe(true);
    const sem = StaffInputSchema.parse({ ...base });
    expect(sem.sshWrite).toEqual([]);
  });

  it('isClaudeRoot: o próprio projeto do Claudio’s Club é ROOT; outra pasta não', () => {
    expect(isClaudeRoot(ROOT)).toBe(true);
    expect(isClaudeRoot(root)).toBe(false);
  });
});

describe('prepareCodexRun: o MCP só entra com SSH na ficha, fora do projeto do Club', () => {
  const launch = (projectPath: string, servers: ServerInfo[], sshMcpBundle: string = BUNDLE): LaunchContext => ({
    company: 'Co',
    projectName: 'proj',
    projectPath,
    managerNames: [],
    mycoUrl: 'http://127.0.0.2:1',
    runDir: path.join(projectPath, 'run'),
    claudeConfigFile: path.join(projectPath, 'claude.json'),
    servers,
    sshMcpBundle,
  });

  it('com SSH: o MCP vai com as conexões, a escrita do lançamento, a autonomia e a pasta do Club', async () => {
    const proj = path.join(root, 'proj-ssh');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile(), launch(proj, [ssh('srv1'), ssh('srv2'), ftp('srv3')]), 'sess-1', proj);
    expect(run.sshMcp).not.toBeNull();
    expect(run.sshMcp!.args).toEqual(expect.arrayContaining(['--connections', 'srv1,srv2']));
    expect(run.sshMcp!.args).not.toContain('srv3');
    expect(run.sshMcp!.args).toEqual(expect.arrayContaining(['--write', 'srv1', '--autonomy', 'acceptEdits']));
    expect(run.sshMcp!.args[0]).toBe(BUNDLE);
    expect(run.sshMcp!.cwd).toBe(ROOT);
    const md = await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');
    expect(md).toContain('ssh_*');
    expect(md).toContain('Escrita (`ssh_executar`, comando livre) só nos servidores liberados: `srv1`.');
    expect(md).not.toContain('ssh -F');
  });

  it('autonomia que não altera (plan): --write vazio e a ficha diz só leitura', async () => {
    const proj = path.join(root, 'proj-plan');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile({ autonomy: 'plan' }), launch(proj, [ssh('srv1')]), 'sess-p', proj);
    expect(run.sshMcp!.args).toEqual(expect.arrayContaining(['--write', '', '--autonomy', 'plan']));
    const md = await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');
    expect(md).toContain('nenhum, só leitura');
  });

  it('sem o pacote do build: o MCP não entra e a ficha diz que o servidor está indisponível', async () => {
    const proj = path.join(root, 'proj-sem-bundle');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile(), launch(proj, [ssh('srv1')], path.join(root, 'nao-existe.mjs')), 'sess-b', proj);
    expect(run.sshMcp).toBeNull();
    const md = await fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');
    expect(md).toContain('Servidor indisponível: falta o build do Club');
    expect(md).not.toContain('ssh_*');
  });

  it('sem conexão SSH na ficha (só FTP ou nenhuma): sem MCP', async () => {
    const proj = path.join(root, 'proj-sem');
    await fs.mkdir(proj, { recursive: true });
    expect((await prepareCodexRun(profile({ servers: [], sshWrite: [] }), launch(proj, []), 's', proj)).sshMcp).toBeNull();
    expect((await prepareCodexRun(profile({ servers: ['srv3'], sshWrite: [] }), launch(proj, [ftp('srv3')]), 's', proj)).sshMcp).toBeNull();
  });
});

describe('ficha do Codex: a seção Servidores conforme o MCP', () => {
  it('com MCP e escrita: lista as conexões e a escrita; sem escrita: "só leitura"', () => {
    const com = renderFicha(profile(), { ...fichaCtx, codexSsh: { mcp: true, names: ['srv1', 'srv2'], writable: ['srv1'], root: false } });
    expect(com).toContain('ferramentas `ssh_*` do MCP `myco-ssh`');
    expect(com).toContain('Você acessa estas conexões do projeto, pelo nome: `srv1`, `srv2`.');
    expect(com).toContain('só nos servidores liberados: `srv1`.');
    expect(com).toContain('No terminal não há ssh, scp, sftp nem rsync');
    const leitura = renderFicha(profile({ sshWrite: [] }), { ...fichaCtx, codexSsh: { mcp: true, names: ['srv1'], writable: [], root: false } });
    expect(leitura).toContain('nenhum, só leitura');
  });

  it('no projeto do próprio Club: "aqui servidor só pelo Claude", sem ferramentas ssh_*', () => {
    const md = renderFicha(profile(), { ...fichaCtx, codexSsh: { mcp: false, names: ['srv1'], writable: [], root: true } });
    expect(md).toContain('Aqui servidor só pelo Claude');
    expect(md).not.toContain('Você acessa estas conexões');
  });

  it('sem o build: "Servidor indisponível: falta o build do Club"', () => {
    const md = renderFicha(profile(), { ...fichaCtx, codexSsh: { mcp: false, names: ['srv1'], writable: [], root: false, indisponivel: true } });
    expect(md).toContain('Servidor indisponível: falta o build do Club');
    expect(md).not.toContain('ssh_*');
  });

  it('com o MCP anexado, a seção Autonomia diz que a busca na web está desligada por causa do servidor (não a frase de internet)', () => {
    const com = renderFicha(profile(), { ...fichaCtx, internetAccess: true, codexSsh: { mcp: true, names: ['srv1'], writable: ['srv1'], root: false } });
    expect(com).toContain('Busca na web desligada nesta conversa porque você tem acesso a servidor.');
    expect(com).not.toContain('use a sua ferramenta de busca (web_search)');
    const sem = renderFicha(profile({ servers: [], sshWrite: [] }), { ...fichaCtx, internetAccess: true });
    expect(sem).toContain('use a sua ferramenta de busca (web_search)');
  });
});
