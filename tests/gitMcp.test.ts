import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bundle } from '../scripts/bundle';
import { GIT_MCP_NAME, GIT_READ_TOOLS, GIT_WRITE_TOOLS, type StaffProfile } from '../shared/model';
import { buildCodexArgs, CODEX_RESERVED_MCP_NAMES, codexExtraMcpArgs } from '../server/chat/codexArgs';
import { ROOT } from '../server/root';
import { buildClaudeArgs, renderFicha } from '../server/staff/ficha';
import { gitGrant, gitMcpServer, gitRefusal, readGitPolicy, runGitMcpStdio, TOOLS, updateGitPolicyAutonomy, writeGitPolicy, type GitPolicy } from '../server/staff/gitMcp';
import { gitLaunchOf, prepareCodexRun, prepareRun, type LaunchContext } from '../server/staff/launch';
import { mcpOffDenyRules } from '../server/staff/mcpAccess';
import { mcpWriteFileFor } from '../server/staff/mcp';
import { removeTemp } from './support/tmp';

// MCP de git (t-eaffcd), a parte de lançamento: acesso da ficha (`mcpAccess`), autonomia, os dois motores (mcp.json e --allowedTools no Claude; -c mcp_servers e
// enabled_tools no Codex), a cópia do pacote para a pasta da conversa, o texto da ficha e o servidor stdio. O comportamento do git está em gitMcpRepo.test.ts.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// MYCO_HOME de teste: o run e a configuração ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-gitmcp-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const ID = 'ana-1a2b';
let root: string;
let repo: string;
let bundleFile: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-gitmcp-launch-'));
  repo = path.join(root, 'repo');
  await fs.mkdir(path.join(repo, '.myco', 'staff'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  bundleFile = path.join(root, 'git-mcp.fake.mjs');
  await fs.writeFile(bundleFile, '// pacote falso\n');
});
afterAll(() => removeTemp(root, home));

const profile = (over: Partial<StaffProfile> = {}) =>
  ({
    id: ID,
    projectId: 'proj-id',
    name: 'Ana',
    role: 'Dev',
    mission: 'Programar',
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

const launch = (projectPath: string, over: Partial<LaunchContext> = {}): LaunchContext => ({
  company: 'Co',
  projectName: 'proj',
  projectPath,
  managerNames: [],
  mycoUrl: 'http://127.0.0.2:1',
  runDir: path.join(home, 'run'),
  claudeConfigFile: path.join(projectPath, 'claude.json'),
  userAgentsDir: path.join(root, 'agents'),
  gitMcpBundle: bundleFile,
  ...over,
});

const sessionDir = (id: string) => path.join(home, 'run', id);
const fichaDe = (p: string) => fs.readFile(path.join(p, '.myco', 'staff', `${ID}.md`), 'utf8');
const gitEm = (md: string) => {
  const i = md.indexOf('## Git');
  return i < 0 ? '' : md.slice(i, md.indexOf('\n## ', i + 5) < 0 ? undefined : md.indexOf('\n## ', i + 5));
};

describe('gitGrant e gitRefusal: o que a conversa pode fazer', () => {
  const p = (over: Partial<GitPolicy>): GitPolicy => ({ engine: 'codex', access: 'free', autonomy: 'auto', review: false, ...over });

  it('Codex: auto e sem travas liberam tudo; aceitar edições só o commit local; pede-tudo e plano só leitura', () => {
    expect(gitGrant(p({ autonomy: 'auto' })).level).toBe('all');
    expect(gitGrant(p({ autonomy: 'bypassPermissions' })).level).toBe('all');
    expect(gitGrant(p({ autonomy: 'acceptEdits' })).level).toBe('commit');
    expect(gitGrant(p({ autonomy: 'manual' })).level).toBe('read');
    expect(gitGrant(p({ autonomy: 'plan' })).level).toBe('read');
  });

  it('readonly, ask no Codex, revisão e política ausente: só leitura, em qualquer autonomia', () => {
    for (const autonomy of ['acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect(gitGrant(p({ autonomy, access: 'readonly' })).level).toBe('read');
      expect(gitGrant(p({ autonomy, access: 'ask' })).level).toBe('read');
      expect(gitGrant(p({ autonomy, review: true })).level).toBe('read');
    }
    expect(gitGrant(null).level).toBe('read');
  });

  it('Claude: tudo, exceto plano, revisão e readonly (o "pede antes" é do Claude Code e do hook)', () => {
    expect(gitGrant(p({ engine: 'claude', autonomy: 'acceptEdits' })).level).toBe('all');
    expect(gitGrant(p({ engine: 'claude', autonomy: 'manual', access: 'ask' })).level).toBe('all');
    expect(gitGrant(p({ engine: 'claude', autonomy: 'plan' })).level).toBe('read');
    expect(gitGrant(p({ engine: 'claude', access: 'readonly' })).level).toBe('read');
  });

  it('a recusa de push e PR em aceitar edições diz o que fazer', () => {
    expect(gitRefusal(p({ autonomy: 'acceptEdits' }), 'all', 'push')).toBe('push exige autonomia auto ou sem travas; o dono muda na ficha');
    expect(gitRefusal(p({ autonomy: 'acceptEdits' }), 'commit', 'commit')).toBeNull();
    expect(gitRefusal(p({ autonomy: 'auto' }), 'all', 'push')).toBeNull();
    expect(gitRefusal(p({ review: true }), 'commit', 'commit')).toContain('revisão');
  });
});

describe('política em disco', () => {
  it('lê o que o Club grava; arquivo ausente, quebrado ou com valor fora da lista dá null', async () => {
    const dir = path.join(root, 'pol');
    expect(await readGitPolicy(dir)).toBeNull();
    await writeGitPolicy(dir, { engine: 'codex', access: 'free', autonomy: 'auto', review: false });
    expect(await readGitPolicy(dir)).toEqual({ engine: 'codex', access: 'free', autonomy: 'auto', review: false });
    for (const bad of ['{', '[]', 'null', '{"engine":"codex","access":"free","autonomy":"root","review":false}', '{"engine":"x","access":"free","autonomy":"auto","review":false}', '{"engine":"codex","access":"off","autonomy":"auto","review":false}', '{"engine":"codex","access":"free","autonomy":"auto"}']) {
      await fs.writeFile(path.join(dir, 'git-policy.json'), bad);
      expect(await readGitPolicy(dir), bad).toBeNull();
    }
  });

  it('a troca de autonomia da conversa aberta regrava só a autonomia; sem política, nada é criado', async () => {
    const dir = path.join(root, 'pol2');
    await updateGitPolicyAutonomy(dir, 'plan');
    expect(await readGitPolicy(dir)).toBeNull();
    await writeGitPolicy(dir, { engine: 'claude', access: 'ask', autonomy: 'auto', review: true });
    await updateGitPolicyAutonomy(dir, 'plan');
    expect(await readGitPolicy(dir)).toEqual({ engine: 'claude', access: 'ask', autonomy: 'plan', review: true });
  });
});

describe('gitLaunchOf: entra em repositório, com o pacote e com o acesso ligado', () => {
  it('liga: copia o pacote para a pasta da conversa, grava a política e leva a pasta de trabalho e a da conversa', async () => {
    const dir = path.join(root, 's1');
    const r = await gitLaunchOf(profile(), launch(repo), repo, dir);
    expect(r.info).toEqual({ mcp: true, motivos: [], level: 'all' });
    expect(r.enabledTools).toBeUndefined();
    expect(r.server!.command).toBe(process.execPath);
    expect(r.server!.args).toEqual([path.join(dir, 'git-mcp.mjs'), '--project', repo, '--root', repo, '--run', dir]);
    expect(await fs.readFile(path.join(dir, 'git-mcp.mjs'), 'utf8')).toBe('// pacote falso\n');
    expect(await readGitPolicy(dir)).toEqual({ engine: 'codex', access: 'free', autonomy: 'auto', review: false });
  });

  it('acesso off: fora, e a ficha diz que foi a política; readonly e ask: só as de leitura; revisão: só as de leitura e a política diz', async () => {
    expect(await gitLaunchOf(profile({ mcpAccess: { [GIT_MCP_NAME]: 'off' } }), launch(repo), repo, path.join(root, 's2'))).toEqual({ info: { mcp: false, motivos: ['politica'] }, server: null });
    for (const level of ['readonly', 'ask'] as const) {
      const r = await gitLaunchOf(profile({ mcpAccess: { [GIT_MCP_NAME]: level } }), launch(repo), repo, path.join(root, `s3${level}`));
      expect(r.server).not.toBeNull();
      expect(r.enabledTools).toEqual(GIT_READ_TOOLS);
      expect(r.info!.level).toBe('read');
      expect((await readGitPolicy(path.join(root, `s3${level}`)))!.access).toBe(level);
    }
    const rev = await gitLaunchOf(profile(), launch(repo), repo, path.join(root, 's4'), true);
    expect(rev.enabledTools).toEqual(GIT_READ_TOOLS);
    expect((await readGitPolicy(path.join(root, 's4')))!.review).toBe(true);
  });

  it('aceitar edições no Codex: nível commit, com o motivo; Claude: nível all', async () => {
    expect((await gitLaunchOf(profile({ autonomy: 'acceptEdits' }), launch(repo), repo, path.join(root, 's5'))).info!.level).toBe('commit');
    expect((await gitLaunchOf(profile({ engine: 'claude', autonomy: 'acceptEdits' }), launch(repo), repo, path.join(root, 's6'))).info!.level).toBe('all');
  });

  it('sem o pacote: indisponível; fora de repositório: nada (nem texto na ficha)', async () => {
    expect(await gitLaunchOf(profile(), launch(repo, { gitMcpBundle: path.join(root, 'nao-existe.mjs') }), repo, path.join(root, 's7'))).toEqual({ info: { mcp: false, motivos: ['indisponivel'] }, server: null });
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-nogit-'));
    try {
      // Só vale se nenhuma pasta acima da temporária for um repositório (a máquina de quem roda).
      if (!(await fs.stat(path.join(os.tmpdir(), '.git')).catch(() => null))) expect(await gitLaunchOf(profile(), launch(plain), plain, path.join(root, 's8'))).toEqual({ server: null });
    } finally {
      await removeTemp(plain);
    }
  });

  it('numa worktree (arquivo .git), a pasta de trabalho é a da worktree', async () => {
    const wt = path.join(root, 'wt');
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, '.git'), 'gitdir: ../repo/.git/worktrees/wt\n');
    const r = await gitLaunchOf(profile(), launch(repo), wt, path.join(root, 's9'));
    expect(r.server!.args).toContain(wt);
    expect(r.server!.args[r.server!.args.indexOf('--project') + 1]).toBe(repo);
  });
});

describe('Codex: prepareCodexRun, -c mcp_servers.myco-git e enabled_tools', () => {
  it('o servidor sobe com o cwd do Club; approve; sem enabled_tools com o acesso livre', async () => {
    const run = await prepareCodexRun(profile(), launch(repo), 'sess-git-cx', repo);
    expect(run.gitMcp).not.toBeNull();
    expect(run.gitMcp!.cwd).toBe(ROOT);
    expect(run.gitMcp!.args[0]).toBe(path.join(sessionDir('sess-git-cx'), 'git-mcp.mjs'));
    expect(run.gitMcp!.enabledTools).toBeUndefined();
    const args = buildCodexArgs({ cwd: repo, sandbox: 'workspace', secrets: { projectPath: repo, home: path.join(root, 'h'), mycoHome: home }, network: 'off', platform: 'linux', gitMcp: run.gitMcp });
    expect(args.filter((a) => a.startsWith('mcp_servers.myco-git.'))).toHaveLength(4); // command, args, cwd, approve
    expect(args).toContain('mcp_servers.myco-git.default_tools_approval_mode="approve"');
    expect(args.some((a) => a.startsWith('mcp_servers.myco-git.enabled_tools'))).toBe(false);
    // O .git continua só leitura na sandbox: nada de escrita extra nem de danger-full-access.
    expect(args.join(' ')).not.toMatch(/danger|dangerously|="write"/);
    expect(args).toContain('permissions.mycodeny.extends=":workspace"');
  });

  it('readonly: enabled_tools só com as de leitura; off e sem repositório: nenhuma linha', async () => {
    const ro = await prepareCodexRun(profile({ mcpAccess: { [GIT_MCP_NAME]: 'readonly' } }), launch(repo), 'sess-git-ro', repo);
    const args = buildCodexArgs({ cwd: repo, sandbox: 'workspace', secrets: { projectPath: repo, home: path.join(root, 'h'), mycoHome: home }, network: 'off', platform: 'linux', gitMcp: ro.gitMcp });
    expect(args).toContain(`mcp_servers.myco-git.enabled_tools=[${GIT_READ_TOOLS.map((t) => `"${t}"`).join(',')}]`);
    const off = await prepareCodexRun(profile({ mcpAccess: { [GIT_MCP_NAME]: 'off' } }), launch(repo), 'sess-git-off', repo);
    expect(off.gitMcp).toBeNull();
    expect(buildCodexArgs({ cwd: repo, sandbox: 'workspace', secrets: { home: path.join(root, 'h'), mycoHome: home }, network: 'off', platform: 'linux', gitMcp: null }).some((a) => a.startsWith('mcp_servers.myco-git'))).toBe(false);
  });

  it('um MCP da biblioteca com o nome myco-git não sobrescreve o interno', () => {
    expect(CODEX_RESERVED_MCP_NAMES.has(GIT_MCP_NAME)).toBe(true);
    expect(codexExtraMcpArgs([{ name: GIT_MCP_NAME, command: 'evil', args: [] }])).toEqual([]);
  });

  it('a ficha explica que commit, push e PR vão pela ferramenta, sem a palavra "revisor"', async () => {
    await prepareCodexRun(profile(), launch(repo), 'sess-git-ficha', repo);
    const md = gitEm(await fichaDe(repo));
    expect(md).toContain('`git_commit`');
    expect(md).toContain('`git_push`');
    expect(md).toContain('`git_pr_criar`');
    expect(md).toContain('MCP `myco-git`');
    expect(md).toContain('Agora: commit, push e PR liberados.');
    expect(md).not.toMatch(/revisor/i);
    expect(md).not.toContain('mcp__');
  });

  it('a ficha em aceitar edições diz que push e PR exigem auto; com acesso off ou sem o pacote, diz o motivo', async () => {
    await prepareCodexRun(profile({ autonomy: 'acceptEdits' }), launch(repo), 'sess-git-ae', repo);
    expect(gitEm(await fichaDe(repo))).toContain('push e PR exigem autonomia auto ou sem travas');
    await prepareCodexRun(profile({ mcpAccess: { [GIT_MCP_NAME]: 'off' } }), launch(repo), 'sess-git-off2', repo);
    expect(gitEm(await fichaDe(repo))).toContain('desligado na sua ficha');
    await prepareCodexRun(profile(), launch(repo, { gitMcpBundle: path.join(root, 'nao-existe.mjs') }), 'sess-git-nb', repo);
    expect(gitEm(await fichaDe(repo))).toContain('Falta o build do Club');
  });
});

describe('Claude: mcp.json, --allowedTools, --disallowedTools e o hook de acesso', () => {
  const claude = (over: Partial<StaffProfile> = {}) => profile({ engine: 'claude', ...over });
  const allowed = (args: string[]) => (args.includes('--allowedTools') ? args[args.indexOf('--allowedTools') + 1]!.split(',') : []);
  const denied = (args: string[]) => args[args.indexOf('--disallowedTools') + 1]!.split(',');
  const tool = (t: string) => `mcp__${GIT_MCP_NAME}__${t}`;

  it('entra no mcp.json; as de leitura em --allowedTools (a partir de aceitar edições); as de escrita seguem a permissão normal', async () => {
    const p = claude({ autonomy: 'acceptEdits' });
    const run = await prepareRun(p, launch(repo), 'sess-git-cl', repo);
    expect(run.gitMcp).toBe(true);
    const cfg = JSON.parse(await fs.readFile(run.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { type: string; args: string[] }> };
    expect(cfg.mcpServers[GIT_MCP_NAME]!.type).toBe('stdio');
    expect(cfg.mcpServers[GIT_MCP_NAME]!.args).toEqual([path.join(sessionDir('sess-git-cl'), 'git-mcp.mjs'), '--project', repo, '--root', repo, '--run', sessionDir('sess-git-cl')]);
    const args = buildClaudeArgs(p, { ...run, sessionId: 's', resume: false, firstPrompt: null });
    // Mais o MCP de tarefa (cancelar a própria tarefa; ver tests/tarefaMcp.test.ts), que entra em toda conversa do Claude fora da revisão.
    expect(allowed(args)).toEqual([...GIT_READ_TOOLS.map(tool), 'mcp__myco-tarefa']);
    for (const w of GIT_WRITE_TOOLS) {
      expect(allowed(args)).not.toContain(tool(w));
      expect(denied(args)).not.toContain(tool(w));
    }
    const plan = buildClaudeArgs(claude({ autonomy: 'plan' }), { ...run, sessionId: 's', resume: false, firstPrompt: null });
    expect(allowed(plan)).toEqual(['mcp__myco-tarefa']);
  });

  it('na revisão as de escrita saem de vez; off sai por --disallowedTools', async () => {
    const run = await prepareRun(claude({ autonomy: 'acceptEdits' }), launch(repo), 'sess-git-rv', repo, true);
    const args = buildClaudeArgs(claude({ autonomy: 'acceptEdits' }), { ...run, sessionId: 's', resume: false, firstPrompt: null, readOnly: true });
    for (const w of GIT_WRITE_TOOLS) expect(denied(args)).toContain(tool(w));
    for (const r of GIT_READ_TOOLS) expect(denied(args)).not.toContain(tool(r));
    expect((await readGitPolicy(sessionDir('sess-git-rv')))!.review).toBe(true);
    const off = claude({ mcpAccess: { [GIT_MCP_NAME]: 'off' } });
    const offRun = await prepareRun(off, launch(repo), 'sess-git-off3', repo);
    expect(offRun.gitMcp).toBe(false);
    expect(denied(buildClaudeArgs(off, { ...offRun, sessionId: 's', resume: false, firstPrompt: null }))).toContain(`mcp__${GIT_MCP_NAME}`);
    expect(mcpOffDenyRules(off.mcpAccess)).toContain(`mcp__${GIT_MCP_NAME}`);
  });

  it('o hook de acesso conhece as ferramentas de leitura do myco-git (readonly e ask só deixam essas passarem)', async () => {
    const file = await mcpWriteFileFor(repo, claude({ mcpAccess: { [GIT_MCP_NAME]: 'readonly' } }), path.join(root, 'nao.json'), { clubFile: path.join(root, 'club.json'), toolsFile: path.join(root, 'tools.json') });
    expect(file[GIT_MCP_NAME]).toEqual({ policy: 'readonly', readOnly: GIT_READ_TOOLS });
    expect(TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(GIT_READ_TOOLS);
    expect(TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name)).toEqual(GIT_WRITE_TOOLS);
  });

  it('a ficha do Claude só avisa que a ferramenta existe, sem hooks, e que o terminal segue valendo', async () => {
    await prepareRun(claude(), launch(repo), 'sess-git-fc', repo);
    const md = gitEm(await fichaDe(repo));
    expect(md).toContain(`mcp__${GIT_MCP_NAME}__git_commit`);
    expect(md).toContain('sem os hooks do projeto');
    expect(md.length).toBeLessThan(700);
  });

  it('renderFicha sem o contexto de git não tem a seção', () => {
    const md = renderFicha(claude(), { company: 'Co', projectName: 'p', projectPath: repo, managerNames: [], fichaPath: 'f.md', memoryPath: 'm.md', mycoUrl: 'http://127.0.0.2:1', workspace: null, worktree: null });
    expect(md).not.toContain('## Git');
  });
});

describe('servidor stdio', () => {
  async function talk(argv: string[], lines: object[]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c: Buffer) => chunks.push(c.toString()));
    const done = runGitMcpStdio(argv, input, output);
    for (const l of lines) input.write(JSON.stringify(l) + '\n');
    input.end();
    await done;
    return chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown>; error?: { code: number } });
  }

  it('initialize, ping e tools/list; apaga o que sobrou na pasta vazia dos hooks e põe os temporários na pasta da conversa', async () => {
    const run = path.join(root, 'stdio1');
    await fs.mkdir(path.join(run, 'nohooks'), { recursive: true });
    await fs.writeFile(path.join(run, 'nohooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    const out = await talk(['--project', repo, '--root', repo, '--run', run], [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', id: 4, method: 'resources/list' },
    ]);
    expect((out[0]!.result as { serverInfo: { name: string } }).serverInfo.name).toBe(GIT_MCP_NAME);
    expect(out[1]!.result).toEqual({});
    expect((out[2]!.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS]);
    expect(out[3]!.error!.code).toBe(-32601);
    expect(await fs.readdir(path.join(run, 'nohooks'))).toEqual([]);
    expect(process.env.TEMP).toBe(path.join(run, 'tmp'));
  });

  it('sem --project, --root ou --run absolutos: recusa subir', async () => {
    await expect(runGitMcpStdio(['--project', repo, '--root', repo])).rejects.toThrow('uso:');
    await expect(runGitMcpStdio(['--project', 'rel', '--root', repo, '--run', root])).rejects.toThrow('uso:');
  });

  it('gitMcpServer leva só caminhos: nenhum segredo na linha de comando', () => {
    const s = gitMcpServer({ bundle: '/x/git-mcp.mjs', projectPath: '/p', root: '/p/wt', runDir: '/r/s' });
    expect(s.args).toEqual(['/x/git-mcp.mjs', '--project', '/p', '--root', '/p/wt', '--run', '/r/s']);
  });
});

describe('o pacote (esbuild, dependências dentro) roda de uma pasta sem node_modules', () => {
  it('a cópia na pasta da conversa responde ao initialize e à lista de ferramentas', async () => {
    const built = path.join(root, 'dist-git-mcp.mjs');
    await bundle('server/git-mcp.ts', built, { inline: true });
    const copy = path.join(root, 'sem-node-modules', 'git-mcp.mjs');
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.copyFile(built, copy);
    const run = path.join(root, 'stdio2');
    const child = spawn(process.execPath, [copy, '--project', repo, '--root', repo, '--run', run], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let err = '';
    child.stdout.on('data', (c: Buffer) => lines.push(c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    child.stdin.end();
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(err).toBe('');
    expect(code).toBe(0);
    const names = (JSON.parse(lines.join('').split('\n')[0]!) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toEqual([...GIT_READ_TOOLS, ...GIT_WRITE_TOOLS]);
  });
});
