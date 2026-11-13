import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';

// O hook de escrita por MCP (scripts/hooks/mcp-write-guard.mjs) rodado de verdade, e a conversa que o leva na própria pasta
// (prepareRun): a política (mcp-write.json) é a da conversa, e nenhum MCP vira regra por ferramenta no --disallowedTools.

// MYCO_HOME de teste: a config, as listas do teste e o run ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcpguard-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const { prepareRun, BROWSER_TOOLS_MATCHER, MCP_TOOLS_MATCHER } = await import('../server/staff/launch');
const { buildClaudeArgs } = await import('../server/staff/ficha');
const { MCP_TOOLS_FILE, mcpFingerprint, saveTestedTools, toolsKey } = await import('../server/staff/mcpTools');

const hookSrc = (name: string) => fileURLToPath(new URL(`../scripts/hooks/${name}`, import.meta.url));
const hook = hookSrc('mcp-write-guard.mjs');

const roots: string[] = [home];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Roda o hook com o evento (ou o texto cru) e o caminho da política; devolve o que ele escreveu ('' = não respondeu). */
const run = (input: unknown, file: string | null) =>
  execFileSync(process.execPath, [hook, ...(file === null ? [] : [file])], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
  }).toString();
const decision = (out: string) => (out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecision);
const reason = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string;
const ev = (tool_name: unknown, permission_mode = 'auto') => ({ tool_name, tool_input: {}, permission_mode });

let policy: string;
let dir: string;
beforeAll(async () => {
  dir = await tmp('myco-mcpguard-');
  policy = path.join(dir, 'mcp-write.json');
  await fs.writeFile(
    policy,
    JSON.stringify({
      falso: { policy: 'deny', readOnly: ['buscar'] },
      pede: { policy: 'ask', readOnly: ['ler'] },
      'git.hub': { policy: 'deny', readOnly: ['listar issues'] },
    }),
  );
});

describe('hook de escrita por MCP: a política da ficha', () => {
  it('ferramenta de leitura (na lista) passa, sem resposta: não é allow, a permissão segue como era', () => {
    expect(run(ev('mcp__falso__buscar'), policy)).toBe('');
    expect(run(ev('mcp__falso__buscar', 'bypassPermissions'), policy)).toBe('');
    expect(run(ev('mcp__pede__ler'), policy)).toBe('');
  });

  it('ferramenta de escrita de servidor com deny: deny, com motivo em português', () => {
    const out = run(ev('mcp__falso__apagar'), policy);
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toMatch(/^\[MyCo\] .*não é só leitura/);
  });

  it('ferramenta nova (que o MCP ganhou depois do teste) com deny: deny', () => {
    expect(decision(run(ev('mcp__falso__ferramenta_nova'), policy))).toBe('deny');
  });

  it('ferramenta de escrita com ask: ask (pede antes), no auto e nos modos com travas', () => {
    for (const mode of ['auto', 'acceptEdits', 'default', 'plan']) {
      const out = run(ev('mcp__pede__criar', mode), policy);
      expect(decision(out)).toBe('ask');
      expect(reason(out)).toContain('pede confirmação');
    }
  });

  it('ask em bypassPermissions vira deny, com motivo que explica o bloqueio', () => {
    const out = run(ev('mcp__pede__criar', 'bypassPermissions'), policy);
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toContain('sem travas');
  });

  it('deny continua deny em bypassPermissions', () => {
    expect(decision(run(ev('mcp__falso__apagar', 'bypassPermissions'), policy))).toBe('deny');
  });

  it('servidor sem política: não responde (fluxo normal)', () => {
    expect(run(ev('mcp__github__get_me'), policy)).toBe('');
    expect(run(ev('mcp__github__criar_issue', 'bypassPermissions'), policy)).toBe('');
  });

  it('ferramenta que não é de MCP: não responde', () => {
    expect(run(ev('Bash'), policy)).toBe('');
    expect(run(ev('Edit'), policy)).toBe('');
  });

  it('nome normalizado como o Claude Code põe (git.hub → git_hub, "listar issues" → listar_issues)', () => {
    expect(run(ev('mcp__git_hub__listar_issues'), policy)).toBe('');
    expect(decision(run(ev('mcp__git_hub__criar_issue'), policy))).toBe('deny');
  });

  it('nome do servidor com caractere estranho (o Club aceita "."): as outras formas plausíveis seguem a política', () => {
    // "git.hub" pode chegar como git_hub (a nossa), git-hub ou git.hub: nenhuma delas passa como "sem política".
    expect(decision(run(ev('mcp__git-hub__criar_issue'), policy))).toBe('deny');
    expect(decision(run(ev('mcp__git.hub__criar_issue'), policy))).toBe('deny');
    expect(run(ev('mcp__git-hub__listar_issues'), policy)).toBe('');
    // Sem apagar o caractere: "github" é outro servidor, sem política, e segue livre.
    expect(run(ev('mcp__github__criar_issue'), policy)).toBe('');
  });

  it('nome com espaço (o que o ~/.claude.json traz): a forma com "_" e com "-" casam', async () => {
    const sp = path.join(dir, 'espaco.json');
    await fs.writeFile(sp, JSON.stringify({ 'meu mcp': { policy: 'deny', readOnly: [] } }));
    expect(decision(run(ev('mcp__meu_mcp__x'), sp))).toBe('deny');
    expect(decision(run(ev('mcp__meu-mcp__x'), sp))).toBe('deny');
    expect(run(ev('mcp__meumcp__x'), sp)).toBe('');
  });

  it('nome que não separa servidor de ferramenta, com política no arquivo: deny', () => {
    for (const tool of ['mcp__falso', 'mcp__falso__', 'mcp____buscar', 'mcp__']) expect(decision(run(ev(tool), policy))).toBe('deny');
  });

  it('política vazia (sem MCP com política): não responde', async () => {
    const empty = path.join(dir, 'vazio.json');
    await fs.writeFile(empty, '{}');
    expect(run(ev('mcp__falso__apagar'), empty)).toBe('');
  });

  it('ambiguidade: um nome que casa com dois MCP da política é deny (servidor "a" e "a__b")', async () => {
    const amb = path.join(dir, 'ambiguo.json');
    await fs.writeFile(amb, JSON.stringify({ a: { policy: 'ask', readOnly: [] }, 'a__b': { policy: 'deny', readOnly: ['x'] } }));
    expect(decision(run(ev('mcp__a__b__x'), amb))).toBe('deny');
    expect(decision(run(ev('mcp__a__b__y'), amb))).toBe('deny');
  });
});

describe('hook de escrita por MCP: fail-closed (nunca libera por erro)', () => {
  it('arquivo da política ausente: deny para MCP, mesmo ferramenta que seria de leitura', async () => {
    const missing = path.join(dir, 'nao-existe.json');
    expect(decision(run(ev('mcp__falso__buscar'), missing))).toBe('deny');
    expect(decision(run(ev('mcp__github__get_me'), missing))).toBe('deny');
  });

  it('sem o caminho da política no argumento: deny', () => {
    expect(decision(run(ev('mcp__falso__buscar'), null))).toBe('deny');
  });

  it.each([
    ['JSON corrompido', '{ não é json'],
    ['lista em vez de objeto', '[]'],
    ['política fora do valor (allow)', '{"falso":{"policy":"allow","readOnly":[]}}'],
    ['lista de leitura que não é lista', '{"falso":{"policy":"deny","readOnly":"buscar"}}'],
    ['entrada vazia', ''],
  ])('arquivo %s: deny', async (_, content) => {
    const bad = path.join(dir, `bad-${randomUUID()}.json`);
    await fs.writeFile(bad, content);
    expect(decision(run(ev('mcp__falso__buscar'), bad))).toBe('deny');
  });

  it('entrada do hook ilegível ou sem nome de ferramenta: deny', () => {
    expect(decision(run('não é json', policy))).toBe('deny');
    expect(decision(run({}, policy))).toBe('deny');
    expect(decision(run(null, policy))).toBe('deny');
    expect(decision(run(ev(42), policy))).toBe('deny');
  });

  it('arquivo estragado não afeta ferramenta que não é de MCP (não responde)', async () => {
    const bad = path.join(dir, 'estragado-nao-mcp.json');
    await fs.writeFile(bad, '{ quebrado');
    expect(run(ev('Bash'), bad)).toBe('');
  });
});

describe('a conversa: cópia dos hooks, política no run dir e nada por ferramenta no --disallowedTools', () => {
  const ROOT_HOOKS = fileURLToPath(new URL('../scripts/hooks/', import.meta.url));
  const project = () => path.join(home, 'project');
  const ctx = () => ({
    company: 'Empresa',
    projectName: 'Projeto',
    projectPath: project(),
    managerNames: [],
    mycoUrl: 'http://127.0.0.1:1',
    runDir: path.join(home, 'run'),
    claudeConfigFile: path.join(home, 'claude.json'),
    userAgentsDir: path.join(home, 'agents'),
    serverKeys: [],
    servers: [],
  });
  const profile = (over: Partial<StaffProfile> = {}): StaffProfile =>
    ({
      id: 'ana-1a2b',
      projectId: 'proj',
      name: 'Ana Souza',
      role: 'Revisora',
      portrait: null,
      reportsTo: [],
      mission: 'Revisar mudanças',
      firstTask: '',
      autonomy: 'bypassPermissions',
      agents: [],
      skills: [],
      mcps: null,
      knowledge: [],
      rules: [],
      doneWhen: '',
      model: null,
      effort: null,
      canHire: false,
      playbook: null,
      worktree: false,
      servers: [],
      browser: true,
      sessions: [],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    }) as StaffProfile;

  it('com política: settings aponta para a cópia no run dir, a política é a da conversa, e o --disallowedTools não tem MCP', async () => {
    // Um MCP "falso" no ~/.claude.json, com a lista do último teste (o que é de leitura).
    const cfg = { type: 'stdio', command: 'node', args: ['servidor.mjs'] };
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'claude.json'), JSON.stringify({ mcpServers: { falso: cfg } }));
    await saveTestedTools(MCP_TOOLS_FILE, toolsKey('user', null, 'falso'), mcpFingerprint(cfg), [
      { name: 'buscar', readOnly: true },
      { name: 'apagar', readOnly: false },
    ]);

    const sid = randomUUID();
    const p = profile({ mcpWrite: { falso: 'deny', outro: 'ask' } });
    const r = await prepareRun(p, ctx(), sid, project());
    const sessionDir = path.join(home, 'run', sid);

    // Os hooks de guarda são cópias na pasta da conversa, idênticas aos do programa.
    for (const f of ['club-guard.mjs', 'mcp-write-guard.mjs']) {
      expect(await fs.readFile(path.join(sessionDir, 'hooks', f), 'utf8')).toBe(await fs.readFile(path.join(ROOT_HOOKS, f), 'utf8'));
    }

    const settings = JSON.parse(await fs.readFile(r.settingsFile, 'utf8')) as {
      permissions?: unknown;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ args: string[] }> }> };
    };
    expect(settings).not.toHaveProperty('permissions');
    const pre = settings.hooks.PreToolUse;
    expect(pre.find((h) => h.matcher === MCP_TOOLS_MATCHER)?.hooks[0]).toMatchObject({
      args: [path.join(sessionDir, 'hooks', 'mcp-write-guard.mjs'), path.join(sessionDir, 'mcp-write.json')],
      onFailure: 'block',
    });
    expect(pre.find((h) => h.matcher === BROWSER_TOOLS_MATCHER)?.hooks[0]).toMatchObject({
      args: [path.join(sessionDir, 'hooks', 'club-guard.mjs'), 'pre'],
      onFailure: 'block',
    });

    const file = JSON.parse(await fs.readFile(path.join(sessionDir, 'mcp-write.json'), 'utf8'));
    expect(file).toEqual({ falso: { policy: 'deny', readOnly: ['buscar'] }, outro: { policy: 'ask', readOnly: [] } });

    // A linha de comando: nenhum MCP por ferramenta no --disallowedTools (o que bloqueia é o hook).
    const args = buildClaudeArgs(p, { sessionId: sid, resume: false, systemPromptFile: r.systemPromptFile, settingsFile: r.settingsFile, mcpConfigPath: r.mcpConfigPath, firstPrompt: null });
    const deny = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(deny.some((rule) => rule.startsWith('mcp__'))).toBe(false);

    // A cópia da própria conversa roda de verdade e bloqueia a ferramenta nova.
    const out = execFileSync(process.execPath, [path.join(sessionDir, 'hooks', 'mcp-write-guard.mjs'), path.join(sessionDir, 'mcp-write.json')], {
      input: JSON.stringify(ev('mcp__falso__ferramenta_nova')),
    }).toString();
    expect(decision(out)).toBe('deny');
  });

  it('sem política: nem arquivo da política nem hook de MCP; a política de uma conversa anterior sai', async () => {
    const sid = randomUUID();
    const sessionDir = path.join(home, 'run', sid);
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, 'mcp-write.json'), '{"velho":{"policy":"deny","readOnly":[]}}');
    const r = await prepareRun(profile(), ctx(), sid, project());
    const settings = JSON.parse(await fs.readFile(r.settingsFile, 'utf8')) as { hooks: { PreToolUse: Array<{ matcher: string }> } };
    expect(settings.hooks.PreToolUse.some((h) => h.matcher === MCP_TOOLS_MATCHER)).toBe(false);
    await expect(fs.access(path.join(sessionDir, 'mcp-write.json'))).rejects.toThrow();
  });
});
