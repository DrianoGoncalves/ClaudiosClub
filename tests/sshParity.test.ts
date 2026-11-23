import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerInfo, StaffProfile } from '../shared/model';
import { buildClaudeArgs } from '../server/staff/ficha';
import { prepareCodexRun, prepareRun, sshLaunchOf, type LaunchContext } from '../server/staff/launch';
import { ROOT } from '../server/root';
import { SSH_MCP_NAME, SSH_READ_TOOLS } from '../server/staff/sshMcp';
import { removeTemp } from './support/tmp';

// O MCP de SSH (`myco-ssh`) tem de sair igual nos dois motores: o mesmo comando e os mesmos argumentos, a mesma escrita e a mesma
// barreira (projeto do Club, pacote ausente, acesso desligado). No Claude, a lista de leitura vai ao mcp-write.json e às --allowedTools.

// MYCO_HOME de teste: o run e a memória ficam fora do ~/.myco de quem roda os testes (como em cleanBrowser.test.ts).
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-ssh-parity-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

let root: string;
/** Pacote do MCP de SSH de teste (o build de verdade não existe em dev sem `npm run build`). */
let BUNDLE: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-ssh-parity-'));
  BUNDLE = path.join(root, 'ssh-mcp.mjs');
  await fs.writeFile(BUNDLE, '// pacote de teste');
});
afterAll(() => removeTemp(root, home));

const profile = (over: Partial<StaffProfile> = {}) =>
  ({
    id: 'ana-1',
    projectId: 'proj-id',
    name: 'Ana',
    role: 'Ops',
    mission: 'Cuidar do servidor',
    firstTask: '',
    autonomy: 'auto',
    agents: [],
    skills: [],
    mcps: null,
    mcpAccess: {},
    knowledge: [],
    rules: [],
    doneWhen: '',
    reportsTo: [],
    engine: 'claude',
    model: null,
    effort: null,
    canHire: false,
    playbook: null,
    worktree: false,
    servers: ['srv1'],
    sshWrite: ['srv1'],
    browser: false,
    portrait: null,
    sessions: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }) as unknown as StaffProfile;

const ssh = (name: string): ServerInfo => ({ name, source: 'vps', protocol: 'ssh', host: `${name}.example.com`, remoteRoot: '/srv/app' });

const launch = (projectPath: string, over: Partial<LaunchContext> = {}): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath,
  managerNames: [],
  mycoUrl: 'http://127.0.0.2:1',
  runDir: path.join(root, 'mycohome', 'run'),
  claudeConfigFile: path.join(projectPath, 'claude.json'),
  userAgentsDir: path.join(root, 'agents'),
  servers: [ssh('srv1')],
  sshMcpBundle: BUNDLE,
  cleanBrowserChannel: null,
  ...over,
});

/** Os dois motores para a mesma ficha e o mesmo lançamento, numa pasta de projeto própria. */
async function bothRuns(prof: StaffProfile, over: Partial<LaunchContext>, name: string) {
  const proj = path.join(root, name);
  await fs.mkdir(proj, { recursive: true });
  const ctx = launch(proj, over);
  const sessionId = `sess-${name}`;
  const claude = await prepareRun(prof, ctx, sessionId, proj);
  const codex = await prepareCodexRun(prof, ctx, sessionId, proj);
  return { claude, codex, sessionId };
}

/** O `myco-ssh` do mcp.json do Claude (null se não entrou). */
async function claudeSsh(run: { mcpConfigPath: string | null }) {
  if (!run.mcpConfigPath) return null;
  const json = JSON.parse(await fs.readFile(run.mcpConfigPath, 'utf8')) as { mcpServers: Record<string, unknown> };
  return json.mcpServers[SSH_MCP_NAME] ?? null;
}

describe('MCP de SSH: o mesmo no Claude e no Codex', () => {
  it('com SSH e autonomia auto: o mesmo comando e os mesmos argumentos, com a conexão em --write', async () => {
    const { claude, codex } = await bothRuns(profile(), {}, 'auto');
    const mcp = (await claudeSsh(claude)) as { type: string; command: string; args: string[] };
    expect(mcp).toEqual({ type: 'stdio', command: codex.sshMcp!.command, args: codex.sshMcp!.args });
    expect(codex.sshMcp!.cwd).toBe(ROOT);
    expect(mcp.args[mcp.args.indexOf('--connections') + 1]).toBe('srv1');
    expect(mcp.args[mcp.args.indexOf('--write') + 1]).toBe('srv1');
    expect(mcp.args[mcp.args.indexOf('--autonomy') + 1]).toBe('auto');
    expect(claude.sshMcp).toBe(true);
  });

  it('autonomia que não altera (plan): --write vazio nos dois motores', async () => {
    const { claude, codex } = await bothRuns(profile({ autonomy: 'plan' }), {}, 'plan');
    const mcp = (await claudeSsh(claude)) as { args: string[] };
    expect(mcp.args[mcp.args.indexOf('--write') + 1]).toBe('');
    expect(codex.sshMcp!.args[codex.sshMcp!.args.indexOf('--write') + 1]).toBe('');
  });

  it('projeto do próprio Claudio’s Club: nenhum dos dois (acesso desligado nos dois motores)', () => {
    const ctx = launch(ROOT, { projectPath: ROOT });
    const s = sshLaunchOf(profile(), ctx, ROOT);
    expect(s.server).toBeNull();
    expect(s.info).toEqual(expect.objectContaining({ mcp: false, root: true }));
  });

  it('pacote do build ausente: nenhum dos dois, e a ficha diz indisponível', async () => {
    const { claude, codex } = await bothRuns(profile(), { sshMcpBundle: path.join(root, 'nao-existe.mjs') }, 'sem-bundle');
    expect(await claudeSsh(claude)).toBeNull();
    expect(codex.sshMcp).toBeNull();
    expect(claude.sshMcp).toBe(false);
    expect(codex.instructions).toContain('Servidor indisponível: falta o build do Club');
  });

  it('acesso myco-ssh desligado na ficha: nenhum dos dois, e a ficha diz que está desligado', async () => {
    const { claude, codex } = await bothRuns(profile({ mcpAccess: { 'myco-ssh': 'off' } }), {}, 'off');
    expect(await claudeSsh(claude)).toBeNull();
    expect(codex.sshMcp).toBeNull();
    expect(codex.instructions).toContain('O acesso ao MCP `myco-ssh` está desligado na sua ficha');
  });

  it('readonly: o Claude põe só as de leitura no mcp-write.json; o Codex as envia como enabled_tools', async () => {
    const { claude, codex } = await bothRuns(profile({ mcpAccess: { 'myco-ssh': 'readonly' } }), {}, 'readonly');
    expect(await claudeSsh(claude)).not.toBeNull();
    const policy = JSON.parse(await fs.readFile(path.join(path.dirname(claude.mcpConfigPath!), 'mcp-write.json'), 'utf8')) as Record<string, { policy: string; readOnly: string[] }>;
    expect(policy[SSH_MCP_NAME]!.policy).toBe('readonly');
    expect(policy[SSH_MCP_NAME]!.readOnly).toEqual(SSH_READ_TOOLS);
    expect(policy[SSH_MCP_NAME]!.readOnly).not.toContain('ssh_executar');
    expect(policy[SSH_MCP_NAME]!.readOnly).not.toContain('ssh_enviar');
    expect(codex.sshMcp!.enabledTools).toEqual(SSH_READ_TOOLS);
  });

  it('ask: o Claude pede antes das de escrita (mesma lista de leitura); o Codex vira só leitura e a ficha avisa', async () => {
    const { claude, codex } = await bothRuns(profile({ mcpAccess: { 'myco-ssh': 'ask' } }), {}, 'ask');
    const policy = JSON.parse(await fs.readFile(path.join(path.dirname(claude.mcpConfigPath!), 'mcp-write.json'), 'utf8')) as Record<string, { policy: string; readOnly: string[] }>;
    expect(policy[SSH_MCP_NAME]!.policy).toBe('ask');
    expect(policy[SSH_MCP_NAME]!.readOnly).toEqual(SSH_READ_TOOLS);
    expect(codex.sshMcp!.enabledTools).toEqual(SSH_READ_TOOLS);
    expect(codex.instructions).toContain('só nos servidores liberados: `srv1`.');
  });

  it('o mcp-write.json do Claude tem a lista de leitura do myco-ssh mesmo que o teste das ferramentas esteja vazio', async () => {
    // Sem teste nenhum do MCP (a lista vem do código, não do último teste): readonly e ask funcionam sem rodar o teste da biblioteca.
    const { claude } = await bothRuns(profile({ mcpAccess: { 'myco-ssh': 'readonly' } }), {}, 'sem-teste');
    const policy = JSON.parse(await fs.readFile(path.join(path.dirname(claude.mcpConfigPath!), 'mcp-write.json'), 'utf8')) as Record<string, { readOnly: string[] }>;
    expect(policy[SSH_MCP_NAME]!.readOnly.length).toBe(SSH_READ_TOOLS.length);
  });

  it('buildClaudeArgs: com o MCP e autonomia auto, as de leitura saem em --allowedTools; as de escrita, não', async () => {
    const p = profile({ autonomy: 'auto' });
    const run = await bothRuns(p, {}, 'args-auto');
    const args = buildClaudeArgs(p, { ...run.claude, sessionId: 's-auto', resume: false, firstPrompt: null });
    const allowed = (args[args.indexOf('--allowedTools') + 1] ?? '').split(',');
    for (const t of SSH_READ_TOOLS) expect(allowed).toContain(`mcp__${SSH_MCP_NAME}__${t}`);
    expect(allowed).not.toContain(`mcp__${SSH_MCP_NAME}__ssh_executar`);
    expect(allowed).not.toContain(`mcp__${SSH_MCP_NAME}__ssh_enviar`);
  });

  it('buildClaudeArgs: com plan, nenhuma ferramenta do myco-ssh em --allowedTools', async () => {
    const p = profile({ autonomy: 'plan' });
    const run = await bothRuns(p, {}, 'args-plan');
    const args = buildClaudeArgs(p, { ...run.claude, sessionId: 's-plan', resume: false, firstPrompt: null });
    expect(args.join(' ')).not.toContain(`mcp__${SSH_MCP_NAME}__`);
  });
});
