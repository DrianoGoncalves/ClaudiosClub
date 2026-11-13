import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerInfo, StaffProfile } from '../shared/model';
import { clubBlockedOrigins } from '../server/clubAddress';
import {
  buildCodexArgs,
  CHROME_MCP_TOOLS,
  CLEAN_BROWSER_DENIED,
  CLEAN_BROWSER_MCP_NAME,
  CLEAN_BROWSER_TOOLS,
  codexCleanBrowserMcpArgs,
  tomlString,
} from '../server/chat/codexArgs';
import { buildClaudeArgs, renderFicha } from '../server/staff/ficha';
import { cleanBrowserChannel, cleanBrowserOf, prepareCodexRun, prepareRun, type LaunchContext } from '../server/staff/launch';

// O navegador limpo (MCP `myco-navegador`): um Playwright MCP com perfil em memória, sem logins, para os dois motores. Quando entra,
// como vai na linha de comando e no mcp.json, e o que a ficha diz (igual nos dois motores).

// MYCO_HOME de teste: o run e a configuração ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-clean-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
/** CLI de teste do Playwright MCP (existe); `NAO_EXISTE` não existe. Pacote de SSH de teste (existe). */
let CLI: string;
let BUNDLE: string;
const NAO_EXISTE = () => path.join(root, 'nao-existe', 'cli.js');
/** Pasta de tudo que a conversa grava (`<mycoHome>/run`), fora de qualquer projeto. */
const RUN_DIR = () => path.join(root, 'mycohome', 'run');
/** Pasta do navegador limpo de uma conversa: `<mycoHome>/run/<sessionId>/navegador`. */
const CLEAN_DIR = (sessionId: string) => path.join(RUN_DIR(), sessionId, 'navegador');

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-clean-browser-'));
  CLI = path.join(root, 'mcp', 'cli.js');
  BUNDLE = path.join(root, 'ssh-mcp.mjs');
  await fs.mkdir(path.dirname(CLI), { recursive: true });
  await fs.writeFile(CLI, '// cli de teste');
  await fs.writeFile(BUNDLE, '// pacote de teste');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

const CLEAN_ON = 'Navegador limpo: o MCP `myco-navegador` abre um Chrome à parte';
const count = (text: string, part: string) => text.split(part).length - 1;

const profile = (over: Partial<StaffProfile> = {}) =>
  ({
    id: 'ana-1',
    projectId: 'proj-id',
    name: 'Ana',
    role: 'Pesquisa',
    mission: 'Testar o site',
    firstTask: '',
    autonomy: 'acceptEdits',
    agents: [],
    skills: [],
    mcps: null,
    mcpAccess: {},
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
    browser: true,
    portrait: null,
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

/** Funcionário do Claude (o motor padrão da ficha, sem MCP próprio). */
const claudeOf = (over: Partial<StaffProfile> = {}) => profile({ engine: 'claude', ...over });

const ssh = (name: string): ServerInfo => ({ name, source: 'vps', protocol: 'ssh', host: `${name}.example.com`, remoteRoot: '/srv/app' });

const launch = (projectPath: string, over: Partial<LaunchContext> = {}): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath,
  managerNames: [],
  mycoUrl: 'http://127.0.0.2:1',
  runDir: RUN_DIR(),
  claudeConfigFile: path.join(projectPath, 'claude.json'),
  userAgentsDir: path.join(root, 'agents'),
  ...over,
});

const fichaDe = (proj: string) => fs.readFile(path.join(proj, '.myco', 'staff', 'ana-1.md'), 'utf8');

type CleanCtx = Parameters<typeof cleanBrowserOf>[1];
/** Contexto em que o navegador limpo pode entrar: CLI de teste, Chrome instalado, sem motivo. */
const ok = (over: Partial<CleanCtx> = {}): CleanCtx => ({ chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', ...over });

describe('cleanBrowserOf: o navegador limpo entra sem motivo, com perfil isolado e headless', () => {
  const dir = () => path.join(root, 'navegador-x');

  it('entra com --isolated, --headless, o Chrome instalado, --no-webmcp, a pasta da conversa e o bloqueio da tela do Club', () => {
    expect(cleanBrowserOf(true, ok(), false, dir())).toEqual({
      mcp: {
        command: process.execPath,
        args: [CLI, '--isolated', '--headless', '--browser', 'chrome', '--no-webmcp', '--output-dir', dir(), '--blocked-origins', clubBlockedOrigins()],
        cwd: dir(),
      },
      info: { mcp: true, motivos: [] },
    });
  });

  it('com Edge como canal: --browser msedge', () => {
    expect(cleanBrowserOf(true, ok({ cleanBrowserChannel: 'msedge' }), false, dir()).mcp?.args).toContain('msedge');
  });

  it('com o bloqueio do Club desligado (clubGuard: false): sem --blocked-origins', () => {
    const args = cleanBrowserOf(true, ok({ clubGuard: false }), false, dir()).mcp?.args ?? [];
    expect(args).not.toContain('--blocked-origins');
    expect(args).toContain('--isolated');
  });

  it('internet ligada não barra', () => {
    expect(cleanBrowserOf(true, ok({ internetAccess: true }), false, dir()).mcp).not.toBeNull();
  });

  it('cada motivo barra e vai para a ficha: internet, SSH, pacote ausente e sem Chrome/Edge (na ordem)', () => {
    expect(cleanBrowserOf(true, ok({ internetAccess: false }), false, dir())).toEqual({ mcp: null, info: { mcp: false, motivos: ['internet'] } });
    expect(cleanBrowserOf(true, ok(), true, dir())).toEqual({ mcp: null, info: { mcp: false, motivos: ['ssh'] } });
    expect(cleanBrowserOf(true, ok({ chromeMcpCli: NAO_EXISTE() }), false, dir())).toEqual({ mcp: null, info: { mcp: false, motivos: ['indisponivel'] } });
    expect(cleanBrowserOf(true, ok({ cleanBrowserChannel: null }), false, dir())).toEqual({ mcp: null, info: { mcp: false, motivos: ['sem-chrome'] } });
    expect(cleanBrowserOf(true, ok({ internetAccess: false, cleanBrowserChannel: null }), true, dir())).toEqual({
      mcp: null,
      info: { mcp: false, motivos: ['internet', 'ssh', 'sem-chrome'] },
    });
  });

  it('sem a ficha pedir Navegador: nada, nem a informação para a ficha', () => {
    expect(cleanBrowserOf(false, ok(), false, dir())).toStrictEqual({ mcp: null });
  });

  it('nunca --extension (o Chrome do usuário) nem npx', () => {
    const json = JSON.stringify(cleanBrowserOf(true, ok(), false, dir()));
    expect(json).not.toMatch(/--extension|npx/);
  });
});

describe('cleanBrowserChannel: o Chrome instalado, senão o Edge', () => {
  const exe = async (base: string, parts: string[]) => {
    const file = path.join(base, ...parts);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
    return base;
  };
  const vazio = async (nome: string) => {
    const dir = path.join(root, nome);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  it('Chrome na pasta do usuário (LOCALAPPDATA) → chrome', async () => {
    const base = await exe(await vazio('win-local'), ['Google', 'Chrome', 'Application', 'chrome.exe']);
    expect(cleanBrowserChannel('win32', { LOCALAPPDATA: base })).toBe('chrome');
  });

  it('só o Edge (Program Files x86) → msedge', async () => {
    const base = await exe(await vazio('win-edge'), ['Microsoft', 'Edge', 'Application', 'msedge.exe']);
    expect(cleanBrowserChannel('win32', { LOCALAPPDATA: await vazio('win-edge-vazio'), 'PROGRAMFILES(X86)': base })).toBe('msedge');
  });

  it('Chrome e Edge juntos → chrome (o Chrome vence)', async () => {
    const base = await vazio('win-os-dois');
    await exe(base, ['Microsoft', 'Edge', 'Application', 'msedge.exe']);
    await exe(base, ['Google', 'Chrome', 'Application', 'chrome.exe']);
    expect(cleanBrowserChannel('win32', { PROGRAMFILES: base })).toBe('chrome');
  });

  it('nada instalado → null; sistema sem caminho conhecido → null', async () => {
    expect(cleanBrowserChannel('win32', { LOCALAPPDATA: await vazio('win-nada'), PROGRAMFILES: await vazio('win-nada-2') })).toBeNull();
    expect(cleanBrowserChannel('freebsd' as NodeJS.Platform, {})).toBeNull();
  });
});

describe('Codex: o navegador limpo na linha de comando', () => {
  const s = { command: 'C:/node.exe', args: ['C:/Club/node_modules/@playwright/mcp/cli.js', '--isolated'], cwd: 'C:\\Club\\run\\s\\navegador' };

  it('mcp_servers.myco-navegador com a aprovação e a allowlist; sem servidor, nada', () => {
    expect(codexCleanBrowserMcpArgs(s)).toEqual([
      '-c', `mcp_servers.${CLEAN_BROWSER_MCP_NAME}.command=${tomlString('C:/node.exe')}`,
      '-c', `mcp_servers.${CLEAN_BROWSER_MCP_NAME}.args=[${s.args.map((a) => tomlString(a)).join(',')}]`,
      '-c', `mcp_servers.${CLEAN_BROWSER_MCP_NAME}.cwd=${tomlString('C:/Club/run/s/navegador')}`,
      '-c', `mcp_servers.${CLEAN_BROWSER_MCP_NAME}.default_tools_approval_mode="approve"`,
      '-c', `mcp_servers.${CLEAN_BROWSER_MCP_NAME}.enabled_tools=[${CLEAN_BROWSER_TOOLS.map((t) => tomlString(t)).join(',')}]`,
    ]);
    expect(codexCleanBrowserMcpArgs(null)).toEqual([]);
    expect(codexCleanBrowserMcpArgs(undefined)).toEqual([]);
  });

  it('a allowlist é a do Chrome do usuário mais as de teste sem login; nenhuma das negadas do Claude entra', () => {
    expect(CLEAN_BROWSER_TOOLS).toEqual([...CHROME_MCP_TOOLS, 'browser_resize', 'browser_console_messages', 'browser_hover', 'browser_select_option']);
    for (const t of CLEAN_BROWSER_DENIED) expect(CLEAN_BROWSER_TOOLS).not.toContain(t);
  });

  it('buildCodexArgs põe o MCP com cleanMcp, sem mexer no Chrome do usuário nem no SSH', () => {
    const base = { cwd: '/proj', sandbox: 'workspace' as const, secrets: { projectPath: '/proj', home: '/home/u', mycoHome: '/home/u/.myco' }, network: 'off' as const, platform: 'linux' as const };
    const com = buildCodexArgs({ ...base, cleanMcp: s });
    expect(com.filter((a) => a.startsWith(`mcp_servers.${CLEAN_BROWSER_MCP_NAME}.`))).toHaveLength(5);
    expect(com.some((a) => a.startsWith('mcp_servers.myco-chrome.') || a.startsWith('mcp_servers.myco-ssh.'))).toBe(false);
    expect(com[com.length - 1]).toBe('-');
    expect(buildCodexArgs({ ...base, cleanMcp: null }).some((a) => a.includes('mcp_servers'))).toBe(false);
    expect(buildCodexArgs(base).some((a) => a.includes('mcp_servers'))).toBe(false);
  });
});

describe('prepareCodexRun: o navegador limpo na conversa e na ficha', () => {
  it('pedido na ficha, sem SSH e sem o Chrome do usuário: entra com a pasta da conversa fora do projeto; a ficha tem a parte limpa e as regras uma vez', async () => {
    const proj = path.join(root, 'proj-clean-on');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile(), launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome' }), 'sess-clean', proj);
    const pasta = CLEAN_DIR('sess-clean');
    expect(run.cleanMcp).toEqual({
      command: process.execPath,
      args: [CLI, '--isolated', '--headless', '--browser', 'chrome', '--no-webmcp', '--output-dir', pasta, '--blocked-origins', clubBlockedOrigins()],
      cwd: pasta,
    });
    expect(run.chromeMcp).toBeNull();
    expect(existsSync(pasta)).toBe(true);
    expect(pasta.startsWith(proj)).toBe(false);
    const md = await fichaDe(proj);
    expect(md).toContain(CLEAN_ON);
    expect(md).toContain('O Chrome do usuário não entra nesta conversa: a opção "Permitir que o GPT use meu Chrome" está desligada nas Configurações.');
    expect(md).not.toContain('Sem navegador nesta conversa');
    expect(count(md, 'Antes de enviar mensagem')).toBe(1);
    expect(count(md, 'Nunca digite senhas')).toBe(1);
  });

  it('com SSH na conversa: não entra, a pasta não é criada, e a ficha diz o motivo', async () => {
    const proj = path.join(root, 'proj-clean-ssh');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(
      profile({ servers: ['srv1'] }),
      { ...launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', servers: [ssh('srv1')] }), sshMcpBundle: BUNDLE },
      'sess-clean-ssh',
      proj,
    );
    expect(run.sshMcp).not.toBeNull();
    expect(run.cleanMcp).toBeNull();
    expect(existsSync(CLEAN_DIR('sess-clean-ssh'))).toBe(false);
    expect(await fichaDe(proj)).toContain('Navegador limpo indisponível nesta conversa: esta conversa tem acesso a servidor, e o navegador seria um canal para o conteúdo dele sair.');
  });

  it('internet desligada nas Configurações: não entra, e a ficha diz por quê', async () => {
    const proj = path.join(root, 'proj-clean-net');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile(), launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', internetAccess: false }), 'sess-clean-net', proj);
    expect(run.cleanMcp).toBeNull();
    expect(await fichaDe(proj)).toContain('Navegador limpo indisponível nesta conversa: a opção "Permitir acesso à internet" está desligada nas Configurações.');
  });

  it('sem Navegador na ficha: não entra e a ficha não tem seção de navegador', async () => {
    const proj = path.join(root, 'proj-clean-sem');
    await fs.mkdir(proj, { recursive: true });
    const run = await prepareCodexRun(profile({ browser: false }), launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome' }), 'sess-clean-sem', proj);
    expect(run.cleanMcp).toBeNull();
    expect(existsSync(CLEAN_DIR('sess-clean-sem'))).toBe(false);
    expect(await fichaDe(proj)).not.toContain('## Navegador');
  });
});

describe('prepareRun (Claude): o navegador limpo no mcp.json e na ficha', () => {
  it('entra mesmo com a extensão do Chrome desligada (browser efetivo false): mcp.json com o navegador, pasta criada, ficha com a parte limpa', async () => {
    const proj = path.join(root, 'proj-claude-on');
    await fs.mkdir(proj, { recursive: true });
    const sid = 'sess-claude-clean';
    const r = await prepareRun({ ...claudeOf({ mcps: null }), browser: false }, launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', cleanBrowser: true }), sid, proj);
    expect(r.cleanBrowser).toBe(true);
    expect(r.mcpConfigPath).not.toBeNull();
    const mcp = JSON.parse(await fs.readFile(r.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers[CLEAN_BROWSER_MCP_NAME]).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: [CLI, '--isolated', '--headless', '--browser', 'chrome', '--no-webmcp', '--output-dir', CLEAN_DIR(sid), '--blocked-origins', clubBlockedOrigins()],
    });
    expect(existsSync(CLEAN_DIR(sid))).toBe(true);
    const md = await fichaDe(proj);
    expect(md).toContain(CLEAN_ON);
    expect(md).not.toContain('Claude in Chrome');
    expect(count(md, 'Antes de enviar mensagem')).toBe(1);
  });

  it('sem o pedido (cleanBrowser false): nem o servidor no mcp.json nem a parte na ficha', async () => {
    const proj = path.join(root, 'proj-claude-off');
    await fs.mkdir(proj, { recursive: true });
    const r = await prepareRun({ ...claudeOf({ mcps: null }), browser: false }, launch(proj, { chromeMcpCli: CLI, cleanBrowserChannel: 'chrome', cleanBrowser: false }), 'sess-claude-off', proj);
    expect(r.cleanBrowser).toBe(false);
    expect(r.mcpConfigPath).toBeNull();
    expect(await fichaDe(proj)).not.toContain('## Navegador');
  });
});

describe('buildClaudeArgs: o navegador limpo com a autonomia do Chrome e as negações', () => {
  const base = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };
  const allowedOf = (args: string[]) => (args.indexOf('--allowedTools') === -1 ? null : args[args.indexOf('--allowedTools') + 1]);
  const deniedOf = (args: string[]) => args[args.indexOf('--disallowedTools') + 1]!.split(',');

  it('acceptEdits: --allowedTools com o navegador limpo; manual: sem --allowedTools', () => {
    expect(allowedOf(buildClaudeArgs(claudeOf({ autonomy: 'acceptEdits', browser: false }), { ...base, cleanBrowser: true }))).toBe(`mcp__${CLEAN_BROWSER_MCP_NAME}`);
    expect(allowedOf(buildClaudeArgs(claudeOf({ autonomy: 'manual', browser: false }), { ...base, cleanBrowser: true }))).toBeNull();
  });

  it('com a extensão do Chrome também: um só --allowedTools com os dois', () => {
    expect(allowedOf(buildClaudeArgs(claudeOf({ autonomy: 'acceptEdits', browser: true }), { ...base, cleanBrowser: true }))).toBe(
      `mcp__claude-in-chrome,mcp__${CLEAN_BROWSER_MCP_NAME}`,
    );
  });

  it('o --disallowedTools nega as ferramentas de código e arquivo do navegador limpo', () => {
    const deny = deniedOf(buildClaudeArgs(claudeOf({ autonomy: 'acceptEdits' }), { ...base, cleanBrowser: true }));
    for (const t of CLEAN_BROWSER_DENIED) expect(deny).toContain(`mcp__${CLEAN_BROWSER_MCP_NAME}__${t}`);
  });

  it('sem cleanBrowser: nenhum argumento do servidor', () => {
    const args = buildClaudeArgs(claudeOf({ autonomy: 'acceptEdits' }), base);
    expect(args.some((a) => a.includes(CLEAN_BROWSER_MCP_NAME))).toBe(false);
  });

  it('negadas e allowlist não se cruzam (CLEAN_BROWSER_DENIED ∩ CLEAN_BROWSER_TOOLS é vazio)', () => {
    expect(CLEAN_BROWSER_DENIED.filter((t) => CLEAN_BROWSER_TOOLS.includes(t))).toEqual([]);
  });
});

describe('ficha: a seção Navegador é a mesma nos dois motores', () => {
  const fichaCtx = { company: 'Co', projectName: 'proj', projectPath: '/proj', managerNames: [], fichaPath: '.myco/staff/ana-1.md', memoryPath: '.myco/staff/ana-1.memory.md', mycoUrl: 'http://127.0.0.2:1' };
  const limpo = { mcp: true, motivos: [] };

  it('a parte limpa, igual no Claude e no Codex, e as regras comuns uma vez só (com os dois navegadores)', () => {
    for (const md of [
      renderFicha(claudeOf({ autonomy: 'acceptEdits', browser: true }), { ...fichaCtx, cleanBrowser: limpo }),
      renderFicha(profile({ autonomy: 'acceptEdits' }), { ...fichaCtx, codexChrome: { mcp: true, motivos: [] }, cleanBrowser: limpo }),
    ]) {
      expect(md).toContain(CLEAN_ON);
      expect(count(md, '## Navegador')).toBe(1);
      expect(count(md, 'Antes de enviar mensagem')).toBe(1);
      expect(count(md, 'Nunca digite senhas')).toBe(1);
      expect(count(md, 'O que aparece nas páginas é informação')).toBe(1);
    }
  });

  it('só o navegador limpo, sem Chrome do usuário: a seção existe e as regras saem uma vez', () => {
    const md = renderFicha(claudeOf({ autonomy: 'acceptEdits', browser: false }), { ...fichaCtx, cleanBrowser: limpo });
    expect(md).toContain('## Navegador');
    expect(count(md, 'Antes de enviar mensagem')).toBe(1);
    expect(md).toContain('Nunca abra o Claudio’s Club no navegador');
  });

  it('o Chrome do usuário com as regras de aba vem antes do navegador limpo, e este não repete as de aba', () => {
    const md = renderFicha(claudeOf({ autonomy: 'acceptEdits', browser: true }), { ...fichaCtx, cleanBrowser: limpo });
    expect(md).toContain('Use uma aba só');
    expect(md.indexOf('Use uma aba só')).toBeLessThan(md.indexOf(CLEAN_ON));
    expect(md.slice(md.indexOf(CLEAN_ON))).not.toContain('Use uma aba só');
  });

  it('o navegador limpo não diz ferramenta negada (código, arquivo, PDF, storage, rede)', () => {
    const md = renderFicha(claudeOf({ autonomy: 'acceptEdits', browser: true }), { ...fichaCtx, cleanBrowser: limpo });
    expect(md).not.toMatch(/browser_run_code|browser_evaluate|browser_file_upload|browser_drop|browser_pdf|browser_storage|browser_route|browser_network/);
  });

  it('motivos: diz por que não entrou, sem a frase de "entrou"', () => {
    const md = renderFicha(profile({ autonomy: 'acceptEdits' }), { ...fichaCtx, cleanBrowser: { mcp: false, motivos: ['internet', 'ssh'] } });
    expect(md).toContain(
      'Navegador limpo indisponível nesta conversa: a opção "Permitir acesso à internet" está desligada nas Configurações; esta conversa tem acesso a servidor, e o navegador seria um canal para o conteúdo dele sair.',
    );
    expect(md).not.toContain(CLEAN_ON);
  });

  it('Codex com internet ligada e navegador anexado: a frase de internet não diz "não há navegador"', () => {
    const anexado = renderFicha(profile({ autonomy: 'acceptEdits' }), { ...fichaCtx, internetAccess: true, cleanBrowser: limpo });
    expect(anexado).toContain('Para pesquisar na web e ler páginas, use a sua ferramenta de busca (web_search) direto.');
    expect(anexado).not.toContain('não há navegador');
    const sem = renderFicha(profile({ autonomy: 'acceptEdits' }), { ...fichaCtx, internetAccess: true });
    expect(sem).toContain('não há navegador.');
  });

  it('sem navegador limpo e sem Chrome: sem seção', () => {
    expect(renderFicha(claudeOf({ autonomy: 'acceptEdits', browser: false }), fichaCtx)).not.toContain('## Navegador');
  });
});
