import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConsultStamp, Project } from '../shared/model';
import type { ToolAdapter } from '../server/adapters/types';
import { SessionTokens } from '../server/callers';
import { buildCodexArgs, codexDenyPaths, CodexBlockedError, type CodexSpawn } from '../server/chat/codexArgs';
import { CodexProcess } from '../server/chat/codexProcess';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { MYCO_HOME } from '../server/config';
import { consultDenyRules, buildClaudeConsultArgs, secretDenyRules } from '../server/staff/ficha';
import { CONSULT_GUIDE_MAX_BYTES } from '../server/staff/consultGuide';
import { StaffService } from '../server/staff/service';
import { profileFile, readProfile } from '../server/staff/store';

// O perfil SÓ LEITURA da conversa de consulta (t-ee823d), nos dois motores, e as duas ressalvas do Tupac: R2 (a leitura é só a pasta do projeto: `.myco`, MYCO_HOME, ~/.codex, ~/.claude, outros
// projetos e `.env` ficam negados, inclusive no Codex) e R3 (todo pedido de permissão da conversa de consulta é negado na hora, sem virar aprovação na tela do dono). Provado também com chamada real
// ao claude 2.1.310 e ao `codex sandbox` 0.169.0 (ver a entrega); aqui, a linha de comando e o processo.

const base = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-consult-profile-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = nodePath.join(dir, 'myco');
  process.env.MYCO_CLAUDE_HOME = nodePath.join(dir, 'claude');
  return dir;
});

let root: string;
let proj: string;
let outro: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-consult-proj-'));
  proj = path.join(root, 'slingshot-learnote');
  outro = path.join(root, 'outro-projeto');
  await fs.mkdir(proj, { recursive: true });
  await fs.mkdir(outro, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(base, { recursive: true, force: true });
});

const mkProject = (id: string, dir: string): Project => ({ id, path: dir, name: path.basename(dir), exists: true, worktreeOf: null, hasClaudeMd: false, agentCount: 0, skillCount: 0, sessionCount: 0, lastActivityAt: null });
const service = () =>
  new StaffService({ listProjects: async () => [mkProject('proj-id', proj), mkProject('outro-id', outro)] } as unknown as ToolAdapter, {
    runDir: path.join(root, 'run'),
    claudeConfigFile: path.join(root, 'claude.json'),
    mycoUrl: 'http://127.0.0.1:4848',
    codexUrl: 'http://127.0.0.2:4848',
    readUsage: async () => ({ tapInstalled: true, limits: [], updatedAt: null }),
    codexEnabled: async () => true,
  });
const STAMP: ConsultStamp = { id: 'c-a1b2c3', fromProjectId: 'slingshot-id', fromProjectName: 'Slingshot', fromStaffId: 'roberto', fromStaffName: 'Roberto' };
const hire = async (name: string, engine?: 'codex') =>
  (await service().hire('proj-id', { name, role: 'Dev back-end', mission: 'Cuidar do builder', autonomy: 'bypassPermissions', playbook: 'plan-big-execute-small', mcps: null, browser: true, knowledge: ['o builder mora em src/builder'], rules: ['Siga o padrão'], ...(engine && { engine, model: 'gpt-6-sol' }), launch: false }, true))!.profile;
const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1];

describe('Claude: a consulta só lê a pasta do projeto (critério 4, R2)', () => {
  it('abre com --tools Read,Grep,Glob, modo default, sem Bash, MCP, agents, hooks, pasta extra, Chrome nem "sem travas"; a ficha do funcionário (autonomia bypassPermissions) não afrouxa nada', async () => {
    const p = await hire('Alphonse');
    const fichaBefore = await fs.readFile(path.join(proj, '.myco', 'staff', `${p.id}.md`), 'utf8');
    const spawn = (await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!;
    const a = spawn.args;
    expect(spawn.consult).toEqual(STAMP);
    expect(spawn.cwd).toBe(proj);
    expect(flag(a, '--tools')).toBe('Read,Grep,Glob');
    expect(flag(a, '--permission-mode')).toBe('default');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-chrome');
    expect(a).toContain('--disable-slash-commands');
    for (const never of ['--add-dir', '--agents', '--plugin-dir', '--settings', '--allowedTools', '--chrome', '--dangerously-skip-permissions', 'bypassPermissions', 'acceptEdits', 'plan']) expect(a, never).not.toContain(never);
    // mcp.json vazio, na pasta da conversa; a linha de comando só leva o caminho dele.
    const mcp = flag(a, '--mcp-config')!;
    expect(mcp).toBe(path.join(root, 'run', spawn.sessionId, 'mcp.json'));
    expect(JSON.parse(await fs.readFile(mcp, 'utf8'))).toEqual({ mcpServers: {} });
    // O prompt de sistema é o compacto: sem memória, sem tarefas, sem contratar, sem ficha de verdade.
    const system = await fs.readFile(flag(a, '--append-system-prompt-file')!, 'utf8');
    expect(system).toContain('conversa de consulta');
    expect(system).toContain('Cuidar do builder');
    for (const gone of ['.memory.md', 'x-myco-token', 'Ordem da fila', 'Navegador', 'agents']) expect(system, gone).not.toContain(gone);
    // O `.md` real da ficha e a memória não foram reescritos por esta conversa.
    expect(await fs.readFile(path.join(proj, '.myco', 'staff', `${p.id}.md`), 'utf8')).toBe(fichaBefore);
  });

  it('R2: nega a leitura de .env, .myco, .git, chaves, MYCO_HOME, ~/.claude, ~/.codex, ~/.ssh e das pastas dos OUTROS projetos (nunca a do próprio), também para Grep e Glob', async () => {
    const p = await hire('Bia');
    const a = (await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.args;
    const deny = flag(a, '--disallowedTools')!.split(',');
    for (const rule of ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Skill', 'WebFetch', 'WebSearch', 'Read(**/.env*)', 'Read(**/.myco/**)', 'Read(**/.git/**)', 'Read(**/.claude/**)', 'Read(**/.codex/**)', 'Read(**/.vps/**)', 'Read(**/.mcp.json)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(~/.claude/**)', 'Read(~/.codex/**)', 'Read(~/.ssh/**)']) {
      expect(deny, rule).toContain(rule);
    }
    expect(deny.some((r) => r.startsWith('Read(') && r.includes(path.basename(base)) && r.endsWith('/myco/**)'))).toBe(true); // MYCO_HOME
    expect(deny.some((r) => r.includes('outro-projeto'))).toBe(true);
    expect(deny.some((r) => r.includes('slingshot-learnote'))).toBe(false);
    expect(deny.some((r) => r.includes(' '))).toBe(false);
  });

  it('as regras: pasta com espaço fica de fora da lista (a regra sairia quebrada), a do projeto nunca entra e o resto segue', async () => {
    const p = await hire('Cris');
    const rules = consultDenyRules(p, { otherProjects: ['C:\\meus projetos\\com espaco', 'C:\\www\\outro'] });
    expect(rules.some((r) => r.includes('com espaco'))).toBe(false);
    expect(rules.some((r) => r.endsWith('www/outro/**)'))).toBe(true);
    expect(rules).toContain('Read(**/.env*)');
  });

  it('a linha de comando pura: ordem estável e o resume usa o mesmo perfil', () => {
    const p = { name: 'Ana', model: 'sonnet', effort: 'high' } as never;
    const first = buildClaudeConsultArgs(p, { sessionId: 's1', resume: false, systemPromptFile: 'sys.md', mcpConfigPath: 'mcp.json', deny: ['Bash'] });
    const again = buildClaudeConsultArgs(p, { sessionId: 's1', resume: true, systemPromptFile: 'sys.md', mcpConfigPath: 'mcp.json', deny: ['Bash'] });
    expect(first).toEqual(expect.arrayContaining(['--session-id', 's1', '--tools', 'Read,Grep,Glob', '--model', 'sonnet', '--effort', 'high']));
    expect(again).toEqual(expect.arrayContaining(['--resume', 's1', '--tools', 'Read,Grep,Glob']));
    expect(again).not.toContain('--session-id');
  });

  it('a entrada da sessão grava o carimbo e readOnly; reabrir (sem pedir de novo) mantém o perfil; um carimbo estragado no arquivo vira carimbo vazio, nunca sessão comum', async () => {
    const p = await hire('Dani');
    const svc = service();
    const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!;
    const saved = (await readProfile(proj, p.id))!.sessions.at(-1)!;
    expect(saved).toMatchObject({ id: first.sessionId, readOnly: true, consult: STAMP, cwd: proj });
    const reopened = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(reopened.consult).toEqual(STAMP);
    expect(flag(reopened.args, '--tools')).toBe('Read,Grep,Glob');
    expect(reopened.args).toEqual(expect.arrayContaining(['--resume', first.sessionId]));
    // Arquivo mexido à mão (ou de uma versão que o schema não conhece): o carimbo não some.
    const file = profileFile(proj, p.id);
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { sessions: Array<Record<string, unknown>> };
    raw.sessions[raw.sessions.length - 1]!.consult = 'lixo';
    await fs.writeFile(file, JSON.stringify(raw));
    expect((await readProfile(proj, p.id))!.sessions.at(-1)!.consult).toMatchObject({ id: 'c-invalido' });
    const broken = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(flag(broken.args, '--tools')).toBe('Read,Grep,Glob');
    // Duplicar uma conversa de consulta não vale.
    await expect(svc.chatSpawn('proj-id', null, p.id, first.sessionId)).rejects.toThrow(/não se duplica/);
  });

  it('a seção Consulta entra na ficha gravada só enquanto o dono mantém o vínculo liberado a ele (critério 9, de ponta a ponta), nos dois motores', async () => {
    let linked = false;
    const withLink = () =>
      new StaffService({ listProjects: async () => [mkProject('proj-id', proj), mkProject('outro-id', outro)] } as unknown as ToolAdapter, {
        runDir: path.join(root, 'run'),
        claudeConfigFile: path.join(root, 'claude.json'),
        mycoUrl: 'http://127.0.0.1:4848',
        codexUrl: 'http://127.0.0.2:4848',
        readUsage: async () => ({ tapInstalled: true, limits: [], updatedAt: null }),
        codexEnabled: async () => true,
        consultTargets: async () => (linked ? [{ projectId: 'learnote-id', projectName: 'Learnote' }] : []),
      });
    for (const engine of [undefined, 'codex'] as const) {
      const p = await hire(engine ? 'Gabi Codex' : 'Gabi Claude', engine);
      const ficha = () => fs.readFile(path.join(proj, '.myco', 'staff', `${p.id}.md`), 'utf8');
      await withLink().chatSpawn('proj-id', null, p.id);
      expect(await ficha()).not.toContain('Consulta a outro projeto');
      linked = true;
      expect(await withLink().chatSpawn('proj-id', null, p.id)).not.toBeNull();
      const text = await ficha();
      expect(text).toContain('## Consulta a outro projeto');
      expect(text).toContain(`${engine ? 'http://127.0.0.2:4848' : 'http://127.0.0.1:4848'}/api/projects/proj-id/consult/directory`);
      // A conversa de consulta do mesmo funcionário não reescreve a ficha (nem leva a seção): ela tem a ficha compacta.
      await withLink().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP);
      expect(await ficha()).toBe(text);
      linked = false;
      await withLink().chatSpawn('proj-id', null, p.id);
      expect(await ficha()).not.toContain('Consulta a outro projeto');
    }
  });

  it('a conversa comum do mesmo funcionário segue como antes (pasta extra, hooks, sem --tools), e a ficha com uma sessão comum continua legível (sem carimbo)', async () => {
    const p = await hire('Eli');
    const first = (await service().chatSpawn('proj-id', null, p.id))!;
    const a = first.args;
    // A entrada da sessão comum não tem carimbo: o schema não a trata como sessão de consulta nem derruba a leitura da ficha (regressão: `consult` obrigatório no schema fazia a ficha sumir).
    const saved = (await readProfile(proj, p.id))!;
    expect(saved.sessions.map((s) => s.id)).toEqual([first.sessionId]);
    expect('consult' in saved.sessions[0]!).toBe(false);
    expect((await service().chatSpawn('proj-id', null, p.id))!.args).not.toContain('--tools');
    expect(a).toContain('--add-dir');
    expect(a).toContain('--settings');
    expect(a).not.toContain('--tools');
    expect(flag(a, '--permission-mode')).toBe('bypassPermissions');
  });
});

describe('Codex: a consulta é read-only, sem rede, sem MCP e com as negações (critério 4, R2)', () => {
  const home = () => path.join(root, 'home');
  const mycoHome = () => path.join(root, 'home', '.myco');
  async function disk() {
    for (const d of ['.codex', '.claude', '.myco', '.ssh']) await fs.mkdir(path.join(home(), d), { recursive: true });
    await fs.mkdir(path.join(proj, '.myco'), { recursive: true });
    await fs.mkdir(path.join(proj, '.git'), { recursive: true });
  }
  const secrets = () => ({ projectPath: proj, home: home(), mycoHome: mycoHome() });
  const full = (consult: { otherProjects: string[]; platform?: NodeJS.Platform } | undefined) =>
    buildCodexArgs({
      cwd: proj,
      sandbox: 'workspace',
      network: 'loopback',
      secrets: secrets(),
      internetAccess: true,
      platform: 'win32',
      consult,
      sshMcp: { command: 'node', args: ['ssh.mjs'] },
      memoriaMcp: { command: 'node', args: ['memoria.mjs'] },
      gitMcp: { command: 'node', args: ['git.mjs'] },
      chromeMcp: { command: 'node', args: ['chrome.mjs'] },
      cleanMcp: { command: 'node', args: ['clean.mjs'] },
      extraMcps: [{ name: 'extra', command: 'node', args: ['x.mjs'] }] as never,
      agents: [{ name: 'executor', description: 'faz', configFile: 'C:\\run\\executor.toml' }],
      heavyGuard: { hook: 'C:\\run\\heavy-guard.mjs', lockDir: 'C:\\lock', ownerPid: 1 },
    }).join(' ');

  it('a linha de comando ignora o que o chamador disser: read-only, sem rede (nem a API do Club), sem MCP, sem agents, sem fila pesada, sem busca na web', async () => {
    await disk();
    const consult = full({ otherProjects: [outro], platform: 'win32' });
    const comum = full(undefined);
    // A conversa comum, com as mesmas entradas, tem tudo isso (a prova de que o teste enxerga a diferença).
    expect(comum).toContain('mcp_servers.myco-ssh');
    expect(comum).toContain('hooks.PreToolUse');
    expect(comum).toContain('agents.executor');
    expect(comum).toContain('domains={"127.0.0.2"="allow"}');
    // A busca na web da conversa comum (sem SSH, que a desliga) vale "live"; a da consulta nunca.
    const web = (consult?: { otherProjects: string[] }) => buildCodexArgs({ cwd: proj, sandbox: 'workspace', network: 'loopback', secrets: secrets(), internetAccess: true, consult }).join(' ');
    expect(web()).toContain('web_search="live"');
    expect(web({ otherProjects: [] })).toContain('web_search="disabled"');
    expect(consult).toContain('extends=":read-only"');
    expect(consult).not.toContain(':workspace');
    expect(consult).toContain('network={enabled=false}');
    expect(consult).not.toContain('network_proxy');
    expect(consult).not.toContain('127.0.0.2');
    expect(consult).toContain('web_search="disabled"');
    for (const never of ['mcp_servers', 'agents.', 'hooks.', 'dangerously', 'enabled_tools']) expect(consult, never).not.toContain(never);
  });

  it('R2 no Windows: nega .env*, .mcp.json, chaves e as pastas .myco/.git/.claude/.codex/.vps pela raiz do projeto; e MYCO_HOME, ~/.codex, ~/.claude e os outros projetos por caminho', async () => {
    await disk();
    const args = full({ otherProjects: [outro, path.join(root, 'nao-existe')], platform: 'win32' });
    expect(args).toContain('":project_roots"={".myco"="deny",".git"="deny",".claude"="deny",".codex"="deny",".vps"="deny","**/.env*"="deny","**/.mcp.json"="deny","**/*.pem"="deny","**/*.key"="deny","**/*.p12"="deny","**/id_rsa*"="deny","**/id_ed25519*"="deny"}');
    const deny = (p: string) => expect(args).toContain(`${JSON.stringify(p)}="deny"`);
    deny(mycoHome());
    deny(path.join(home(), '.codex'));
    deny(path.join(home(), '.claude'));
    expect(args).toContain('"~/.ssh"="deny"');
    deny(outro);
    // Caminho que não existe não entra (o Codex criaria um arquivo vazio no lugar), e o próprio projeto nunca é negado.
    expect(args).not.toContain('nao-existe');
    expect(args).not.toContain(`${JSON.stringify(proj)}="deny"`);
  });

  it('R2 fora do Windows (sem glob provado): as pastas do projeto e os arquivos sensíveis da raiz entram pelo caminho; mais de um arquivo regular falha fechado', async () => {
    await disk();
    const secretsCtx = { cwd: proj, projectPath: proj, home: home(), mycoHome: mycoHome(), consult: { otherProjects: [outro], platform: 'linux' as const } };
    await fs.rm(path.join(proj, '.env'), { force: true });
    await fs.rm(path.join(proj, '.mcp.json'), { force: true });
    await fs.writeFile(path.join(proj, '.env'), 'API_KEY=segredo');
    const one = codexDenyPaths(secretsCtx);
    for (const p of [path.join(proj, '.myco'), path.join(proj, '.git'), path.join(proj, '.env'), mycoHome(), path.join(home(), '.codex'), path.join(home(), '.claude'), outro]) expect(one, p).toContain(p);
    const args = buildCodexArgs({ cwd: proj, sandbox: 'workspace', network: 'loopback', secrets: secrets(), consult: secretsCtx.consult, platform: 'linux' }).join(' ');
    expect(args).not.toContain(':project_roots');
    expect(args).toContain(`${JSON.stringify(path.join(proj, '.env'))}="deny"`);
    // Um segundo arquivo sensível na raiz: o limite da sandbox é de UM arquivo regular negado por execução, então não roda (falha fechada).
    await fs.writeFile(path.join(proj, '.mcp.json'), '{}');
    expect(() => codexDenyPaths(secretsCtx)).toThrow(CodexBlockedError);
    await fs.rm(path.join(proj, '.env'), { force: true });
    await fs.rm(path.join(proj, '.mcp.json'), { force: true });
  });

  it('a conversa comum não ganha nenhuma das negações da consulta', async () => {
    await disk();
    const plain = codexDenyPaths({ cwd: proj, projectPath: proj, home: home(), mycoHome: mycoHome() });
    expect(plain).not.toContain(path.join(home(), '.codex'));
    expect(plain).not.toContain(outro);
    expect(full(undefined)).not.toContain(':project_roots');
  });

  it('chatSpawn no Codex: perfil de consulta (sem MCP, agents nem fila pesada; autonomia manual; sem busca na web; na pasta do projeto) gravado na entrada e mantido ao reabrir', async () => {
    const p = await hire('Fabi', 'codex');
    const svc = service();
    const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!;
    const c = first.codex as CodexSpawn;
    expect(first).toMatchObject({ engine: 'codex', cwd: proj, consult: STAMP });
    expect(c).toMatchObject({ autonomy: 'manual', readOnly: true, consult: { otherProjects: [outro] }, sshMcp: null, memoriaMcp: null, gitMcp: null, chromeMcp: null, cleanMcp: null, extraMcps: [], agents: [], heavyGuard: null, writableRoots: [], readOnlyPaths: [] });
    expect(await c.internetAccess!()).toBe(false);
    expect(c.instructions).toContain('conversa de consulta');
    expect(c.instructions).not.toContain('.memory.md');
    expect(c.instructions.toLowerCase()).not.toContain('revisor');
    expect((await readProfile(proj, p.id))!.sessions.at(-1)).toMatchObject({ id: first.sessionId, readOnly: true, consult: STAMP });
    const reopened = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(reopened.consult).toEqual(STAMP);
    expect(reopened.codex).toMatchObject({ readOnly: true, consult: { otherProjects: [outro] }, agents: [], sshMcp: null });
  });

  it('o processo: com tudo ligado no spawn, a execução sai read-only, sem rede, sem MCP e SEM MYCO_TOKEN', async () => {
    await disk();
    const runs: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const spawnImpl = (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      runs.push({ args, env: opts.env });
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 99 });
      return child as never;
    };
    const chat = new CodexProcess({
      sessionId: 'cs-1',
      cwd: proj,
      permissionMode: 'bypassPermissions',
      secrets: secrets(),
      readOnly: true,
      consult: { otherProjects: [outro] },
      sshMcp: { command: 'node', args: ['ssh.mjs'] },
      memoriaMcp: { command: 'node', args: ['memoria.mjs'] },
      agents: [{ name: 'executor', description: 'faz', configFile: 'C:\\run\\executor.toml' }],
      env: async () => ({ error: null, version: '0.169.0', networkProxy: true, multiAgent: true, notice: null }),
      internetAccess: async () => true,
      spawnImpl,
    });
    chat.start();
    chat.send('pergunta');
    await new Promise((r) => setTimeout(r, 20));
    expect(runs).toHaveLength(1);
    const joined = runs[0]!.args.join(' ');
    expect(joined).toContain('extends=":read-only"');
    expect(joined).toContain('network={enabled=false}');
    expect(joined).toContain('web_search="disabled"');
    for (const never of ['mcp_servers', 'agents.', 'hooks.', ':workspace', '127.0.0.2']) expect(joined, never).not.toContain(never);
    expect(runs[0]!.env.MYCO_TOKEN).toBeUndefined();
  });
});

// t-1a9bf2 (follow-up da revisão de t-ee823d): a consulta não lê credencial da home e nenhum funcionário forja vínculo nem resposta de consulta.
describe('o registro da consulta não se edita e as credenciais da home não se leem, nos dois motores', () => {
  const noServers = { servers: [] } as never;
  const inside = (dir: string, file: string) => {
    const rel = path.relative(dir, file);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const clubConsult = (rule: string) => rule.includes(path.basename(base)) && rule.endsWith('/myco/consult/**)');

  it('Claude: Edit e Write de MYCO_HOME/consult/** (links.json e records.json) são negados a todo funcionário, na consulta também; a leitura não é negada à conversa comum', async () => {
    for (const tool of ['Edit', 'Write']) expect(secretDenyRules(noServers).filter((r) => r.startsWith(`${tool}(`) && clubConsult(r)), tool).toHaveLength(1);
    expect(secretDenyRules(noServers).some((r) => r.startsWith('Read(') && clubConsult(r))).toBe(false);
    const p = await hire('Gui');
    const comum = flag((await service().chatSpawn('proj-id', null, p.id))!.args, '--disallowedTools')!.split(',');
    const consulta = flag((await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.args, '--disallowedTools')!.split(',');
    for (const deny of [comum, consulta]) for (const tool of ['Edit', 'Write']) expect(deny.filter((r) => r.startsWith(`${tool}(`) && clubConsult(r)), tool).toHaveLength(1);
  });

  it('Codex: MYCO_HOME/consult não entra em writableRoots, na conversa comum nem na de consulta, e a linha de comando não a abre para escrita', async () => {
    const p = await hire('Hugo', 'codex');
    const consultDir = path.join(MYCO_HOME, 'consult');
    for (const stamp of [undefined, STAMP]) {
      const c = (await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, stamp))!.codex as CodexSpawn;
      for (const dir of c.writableRoots) {
        expect(inside(consultDir, dir), dir).toBe(false);
        expect(inside(dir, consultDir), dir).toBe(false);
      }
      const args = buildCodexArgs({ cwd: proj, sandbox: 'workspace', network: 'off', secrets: c.secrets, writableRoots: c.writableRoots, readOnlyPaths: c.readOnlyPaths, consult: c.consult, platform: 'win32' }).join(' ');
      expect(args).not.toContain(`${JSON.stringify(consultDir)}="write"`);
    }
  });

  it('Claude: a consulta nega a leitura das credenciais da home (Grep e Glob junto), sem espaço na regra; a conversa comum não ganha essas regras', async () => {
    const p = await hire('Iris');
    const deny = flag((await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.args, '--disallowedTools')!.split(',');
    const rules = ['Read(~/.aws/**)', 'Read(~/.docker/**)', 'Read(~/.config/gh/**)', 'Read(~/AppData/Roaming/GitHub?CLI/**)', 'Read(~/.kube/**)', 'Read(~/.npmrc)', 'Read(~/.netrc)', 'Read(~/.git-credentials)'];
    for (const rule of rules) expect(deny, rule).toContain(rule);
    expect(deny.some((r) => r.includes(' '))).toBe(false);
    for (const rule of rules) expect(secretDenyRules(noServers), rule).not.toContain(rule);
  });

  describe('Codex: as credenciais da home que existem entram em codexDenyPaths na consulta, e só nela', () => {
    async function home() {
      const dir = await fs.mkdtemp(path.join(root, 'cred-'));
      const h = path.join(dir, 'home');
      const projeto = path.join(dir, 'proj');
      for (const d of ['.aws', '.docker', path.join('.config', 'gh'), path.join('AppData', 'Roaming', 'GitHub CLI')]) await fs.mkdir(path.join(h, d), { recursive: true });
      await fs.mkdir(projeto, { recursive: true });
      await fs.writeFile(path.join(h, '.npmrc'), '//registry:_authToken=x');
      await fs.writeFile(path.join(h, '.netrc'), 'machine x');
      return { h, projeto, ctx: { cwd: projeto, projectPath: projeto, home: h, mycoHome: path.join(h, '.myco') } };
    }
    const dirs = (h: string) => [path.join(h, '.aws'), path.join(h, '.docker'), path.join(h, '.config', 'gh'), path.join(h, 'AppData', 'Roaming', 'GitHub CLI')];

    it('Windows: as pastas e todos os arquivos de credencial que existem (os que não existem, como ~/.kube, ficam de fora) e a linha de comando os nega', async () => {
      const { h, ctx } = await home();
      const paths = codexDenyPaths({ ...ctx, consult: { otherProjects: [], platform: 'win32' } });
      expect(paths).toEqual([...dirs(h), path.join(h, '.npmrc'), path.join(h, '.netrc')]);
      expect(paths).not.toContain(path.join(h, '.kube'));
      const args = buildCodexArgs({ cwd: ctx.cwd, sandbox: 'workspace', network: 'off', secrets: { projectPath: ctx.projectPath, home: h, mycoHome: ctx.mycoHome }, consult: { otherProjects: [], platform: 'win32' }, platform: 'win32' }).join(' ');
      for (const p of paths) expect(args, p).toContain(`${JSON.stringify(p)}="deny"`);
    });

    it('fora do Windows só cabe UM arquivo regular na sandbox: o primeiro de credencial entra, o resto fica de fora sem erro; o ~/.claude.json e o .vps arquivo têm a vez antes', async () => {
      const { h, projeto, ctx } = await home();
      const consult = { otherProjects: [], platform: 'linux' as const };
      expect(codexDenyPaths({ ...ctx, consult })).toEqual([...dirs(h), path.join(h, '.npmrc')]);
      await fs.writeFile(path.join(h, '.claude.json'), '{}');
      expect(codexDenyPaths({ ...ctx, consult })).toEqual([...dirs(h), path.join(h, '.claude.json')]);
      await fs.rm(path.join(h, '.claude.json'));
      await fs.writeFile(path.join(projeto, '.vps'), 'x');
      expect(codexDenyPaths({ ...ctx, consult })).toEqual([...dirs(h), path.join(projeto, '.vps')]);
    });

    it('a conversa comum do Codex não ganha nenhuma delas', async () => {
      const { ctx } = await home();
      expect(codexDenyPaths(ctx)).toEqual([]);
    });
  });
});

describe('Claude: a consulta abre só com as configurações do usuário e leva o CLAUDE.md do projeto no prompt (t-1a9bf2, item 1)', () => {
  const guideFile = () => path.join(proj, 'CLAUDE.md');
  const systemOf = async (args: string[]) => fs.readFile(flag(args, '--append-system-prompt-file')!, 'utf8');
  const SECTION = '## Instruções do projeto consultado (CLAUDE.md)';

  it('--setting-sources user na abertura e no resume; a conversa comum não leva a flag (segue com as configurações todas)', async () => {
    const p = await hire('Jade');
    const svc = service();
    const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!;
    expect(flag(first.args, '--setting-sources')).toBe('user');
    const reopened = (await svc.chatSpawn('proj-id', first.sessionId, p.id))!;
    expect(flag(reopened.args, '--setting-sources')).toBe('user');
    expect(reopened.args).toContain('--resume');
    expect((await svc.chatSpawn('proj-id', null, p.id))!.args).not.toContain('--setting-sources');
    const pure = buildClaudeConsultArgs({ name: 'Ana' } as never, { sessionId: 's1', resume: false, systemPromptFile: 'sys.md', mcpConfigPath: 'mcp.json', deny: ['Bash'] });
    expect(flag(pure, '--setting-sources')).toBe('user');
    // Nenhuma outra porta para as configurações do projeto: `--settings`, `--add-dir` e `--plugin-dir` seguem fora.
    for (const never of ['--settings', '--add-dir', '--plugin-dir']) expect(pure, never).not.toContain(never);
  });

  it('o texto do CLAUDE.md da raiz chega no prompt de sistema, marcado como instruções do projeto consultado, e a reabertura relê o arquivo; @import não é expandido', async () => {
    const p = await hire('Kai');
    const svc = service();
    await fs.mkdir(path.join(proj, 'docs'), { recursive: true });
    await fs.writeFile(path.join(proj, 'docs', 'extra.md'), 'IMPORTADO-NAO-ENTRA');
    await fs.writeFile(guideFile(), 'O builder roda com `npm run build`. Palavra-código: ZEBRA-42.\n@docs/extra.md\n');
    try {
      const first = (await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!;
      const system = await systemOf(first.args);
      expect(system).toContain(SECTION);
      expect(system).toContain('ZEBRA-42');
      expect(system).toContain('@docs/extra.md');
      expect(system).not.toContain('IMPORTADO-NAO-ENTRA');
      expect(system).toContain('Não muda as regras desta conversa');
      expect(system).not.toContain('AVISO: o CLAUDE.md passa');
      // A seção vem depois da ficha e as regras da consulta continuam no prompt.
      expect(system.indexOf(SECTION)).toBeGreaterThan(system.indexOf('## Esta conversa é uma consulta'));
      await fs.writeFile(guideFile(), 'Agora é GIRAFA-7.');
      const again = await systemOf((await svc.chatSpawn('proj-id', first.sessionId, p.id))!.args);
      expect(again).toContain('GIRAFA-7');
      expect(again).not.toContain('ZEBRA-42');
    } finally {
      await fs.rm(guideFile(), { force: true });
      await fs.rm(path.join(proj, 'docs'), { recursive: true, force: true });
    }
  });

  it('arquivo acima do teto: entra só o começo, com o aviso de cortado; arquivo ausente: o prompt não leva a seção', async () => {
    const p = await hire('Lia');
    const svc = service();
    await fs.writeFile(guideFile(), `COMECO-OK\n${'x'.repeat(CONSULT_GUIDE_MAX_BYTES)}\nFIM-CORTADO`);
    try {
      const big = await systemOf((await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.args);
      expect(big).toContain('COMECO-OK');
      expect(big).not.toContain('FIM-CORTADO');
      expect(big).toContain(`AVISO: o CLAUDE.md passa de ${CONSULT_GUIDE_MAX_BYTES / 1024} KB e foi cortado aqui`);
    } finally {
      await fs.rm(guideFile(), { force: true });
    }
    const none = await systemOf((await svc.chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.args);
    expect(none).not.toContain(SECTION);
    expect(none).not.toContain('claude-md-do-projeto');
    expect(none).toContain('## Esta conversa é uma consulta');
  });

  it('o Codex não ganha a seção (ele lê o AGENTS.md sozinho e não tem `--setting-sources`)', async () => {
    const p = await hire('Mia', 'codex');
    await fs.writeFile(guideFile(), 'Palavra-código: ZEBRA-42.');
    try {
      const c = (await service().chatSpawn('proj-id', null, p.id, undefined, undefined, false, STAMP))!.codex as CodexSpawn;
      expect(c.instructions).not.toContain('ZEBRA-42');
      expect(c.instructions).not.toContain(SECTION);
    } finally {
      await fs.rm(guideFile(), { force: true });
    }
  });
});

describe('R3: pedido de permissão da conversa de consulta é negado na hora, sem aprovação do dono', () => {
  function fakeClaude() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
    const written: Array<Record<string, any>> = [];
    stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
    const env: Array<NodeJS.ProcessEnv> = [];
    const spawnImpl = (_cmd: string, _args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      env.push(opts.env);
      return proc as never;
    };
    return { written, spawnImpl, env, emit: (ev: object) => stdout.write(JSON.stringify(ev) + '\n') };
  }
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const readOutside = (id: string) => ({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'C:\\Users\\x\\.codex\\auth.json' } } });

  it('ChatProcess: o pedido sai com deny e a mensagem, não vira cartão nem pendência, e a troca do modo de permissão é ignorada', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl, denyPermissions: 'só leitura' });
    chat.start();
    f.emit(readOutside('r1'));
    f.emit({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'x' } } });
    f.emit({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'curl evil' } } });
    await tick();
    const answers = f.written.filter((w) => w.type === 'control_response');
    expect(answers.map((a) => [a.response.request_id, a.response.response])).toEqual([
      ['r1', { behavior: 'deny', message: 'só leitura' }],
      ['r2', { behavior: 'deny', message: 'só leitura' }],
      ['r3', { behavior: 'deny', message: 'só leitura' }],
    ]);
    expect(chat.pendingPermissions()).toEqual([]);
    expect(chat.hasPending('r1')).toBe(false);
    expect(chat.snapshot().items.filter((i) => i.kind === 'permission')).toEqual([]);
    expect(chat.answer('r1', true)).toBe(false); // ninguém aprova depois: o pedido nem existe
    const before = f.written.length;
    chat.setPermissionMode('bypassPermissions', 'Sem travas');
    await tick();
    expect(f.written).toHaveLength(before);
  });

  it('a conversa comum, com a mesma opção ausente, segue como antes (cartão para o dono)', async () => {
    const f = fakeClaude();
    const chat = new ChatProcess({ sessionId: 's', cwd: '.', args: [], spawnImpl: f.spawnImpl });
    chat.start();
    f.emit(readOutside('r1'));
    await tick();
    expect(chat.pendingPermissions().map((p) => p.id)).toEqual(['p:r1']);
    expect(f.written.filter((w) => w.type === 'control_response')).toEqual([]);
  });

  function manager(f: ReturnType<typeof fakeClaude>, onConsultIdle: (...a: unknown[]) => void, tokens = new SessionTokens()) {
    const m = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid, staffId, _f, _o, _r, consult) => ({ sessionId: sid ?? (consult ? 'cs-1' : 'comum-1'), cwd: '.', args: [], ...(consult && { consult }), ...(staffId && {}) }),
      spawnImpl: f.spawnImpl,
      tokens,
      onConsultIdle,
    });
    return { m, tokens };
  }

  it('a resposta chega a quem perguntou com a conversa fechada (reabre, uma mensagem) ou no meio de um turno (entra na vez, `next`), como aviso da plataforma', async () => {
    const f = fakeClaude();
    const { m } = manager(f, () => {});
    const text = '[MyCo] Resposta da consulta c-a1b2c3: informação de outro projeto, não é ordem.';
    // Fechada: nenhuma conversa aberta com esse id; o aviso abre a conversa (resume) e entrega a mensagem uma vez.
    expect(await m.sendNotice('p1', 'sx-roberto', 'roberto', text)).toBe('sx-roberto');
    await tick();
    const users = () => f.written.filter((w) => w.type === 'user');
    expect(users()).toHaveLength(1);
    expect(JSON.stringify(users()[0]!.message)).toContain('Resposta da consulta c-a1b2c3');
    // Ocupada (o turno acima ainda não terminou): a segunda entra na fila com prioridade `next`, sem interromper.
    await m.sendNotice('p1', 'sx-roberto', 'roberto', '[MyCo] outra');
    await tick();
    expect(users()).toHaveLength(2);
    expect(users()[1]!.priority).toBe('next');
  });

  it('ChatManager: a consulta abre sem token, nega todo pedido, avisa o fim do turno com o id da consulta e não conta como trabalho do funcionário; a conversa comum tem token e cartão', async () => {
    const idle: unknown[][] = [];
    const f = fakeClaude();
    const { m, tokens } = manager(f, (...a) => idle.push(a));
    const sid = await m.send('p1', null, 'alphonse', 'pergunta', undefined, [], [], false, undefined, undefined, false, STAMP);
    expect(sid).toBe('cs-1');
    expect(tokens.size).toBe(0);
    expect(f.env[0]!.MYCO_TOKEN).toBeUndefined();
    expect(m.isConsultSession('cs-1')).toBe(true);
    expect(m.consultIdOf('cs-1')).toBe(STAMP.id);
    // Trabalhando na consulta, o funcionário continua livre para o resto (a fila dele não espera).
    await tick();
    expect(m.staffWorking('p1', 'alphonse')).toBe(false);
    // R3 pelo manager: o pedido é negado e nada fica pendente na caixa.
    f.emit(readOutside('r1'));
    await tick();
    expect(f.written.filter((w) => w.type === 'control_response').map((w) => w.response.response.behavior)).toEqual(['deny']);
    expect((await m.snapshot('p1', 'cs-1')).live!.items.filter((i) => i.kind === 'permission')).toEqual([]);
    // Fim do turno: o serviço de consulta é avisado com o id da consulta.
    f.emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Resposta.' }] } });
    f.emit({ type: 'result', is_error: false });
    await tick();
    expect(idle).toContainEqual([STAMP.id, 'cs-1', 'turn']);
    expect(m.lastAssistantText('cs-1')).toBe('Resposta.');

    // A conversa comum do mesmo funcionário: token, conta como trabalho e o pedido vira cartão.
    const g = fakeClaude();
    const second = manager(g, () => {});
    await second.m.send('p1', null, 'alphonse', 'oi');
    expect(second.tokens.size).toBe(1);
    expect(g.env[0]!.MYCO_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(second.m.isConsultSession('comum-1')).toBe(false);
    expect(second.m.staffWorking('p1', 'alphonse')).toBe(true);
    g.emit(readOutside('r9'));
    await tick();
    expect(g.written.filter((w) => w.type === 'control_response')).toEqual([]);
  });
});
