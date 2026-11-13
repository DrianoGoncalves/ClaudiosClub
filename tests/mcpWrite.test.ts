import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';

// Política de escrita dos MCPs na ficha (server/staff/mcpTools.ts): o teste guarda o que é só leitura, a ficha escolhe
// livre / pede antes / bloqueada, e a conversa recebe a regra (`--disallowedTools` ou `permissions.ask`).

// MYCO_HOME de teste: o arquivo padrão da lista (e a regra que o protege) ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcpwrite-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const { testMcpConfig } = await import('../server/staff/mcpTest');
const { cleanMcpWrite, mcpFingerprint, mcpRuleName, mcpWriteRules, saveTestedTools, stricterMcpWrite, testedTools, toolsKey } = await import(
  '../server/staff/mcpTools'
);
const { listMcpServers, mcpWriteRulesFor } = await import('../server/staff/mcp');
const { createMcpLibrary } = await import('../server/staff/mcpLibrary');
const { buildClaudeArgs, secretDenyRules } = await import('../server/staff/ficha');
const { withAskRules, staffSettings } = await import('../server/staff/launch');
const { StaffInputSchema } = await import('../server/staff/store');
const { mcpWriteHint, mcpWriteToSend, setMcpWrite } = await import('../client/src/staff/mcpWrite');

const roots: string[] = [home];
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

const TOOLS = [
  { name: 'buscar', annotations: { readOnlyHint: true } },
  { name: 'criar_issue', annotations: { readOnlyHint: false } },
  { name: 'apagar', annotations: { destructiveHint: true } },
  { name: 'sem_marca' },
  // Só `true` é leitura: texto "true" não conta.
  { name: 'texto', annotations: { readOnlyHint: 'true' } },
];

let stdioScript: string;
let server: http.Server;
let base: string;

beforeAll(async () => {
  const dir = await tmp('myco-mcpwrite-');
  stdioScript = path.join(dir, 'fake-mcp.mjs');
  await fs.writeFile(
    stdioScript,
    [
      "import { createInterface } from 'node:readline';",
      `const TOOLS = ${JSON.stringify(TOOLS)};`,
      'const rl = createInterface({ input: process.stdin });',
      'rl.on("line", (line) => {',
      '  const m = JSON.parse(line);',
      "  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {} } }) + '\\n');",
      "  if (m.method === 'tools/list') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } }) + '\\n');",
      '});',
    ].join('\n'),
  );
  server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw || 'null') as { id?: number; method?: string };
    if (msg.method === 'notifications/initialized') return void res.writeHead(202).end();
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {} } : { tools: TOOLS };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('teste do MCP: o que é só leitura', () => {
  it('stdio e http: só readOnlyHint === true conta como leitura', async () => {
    const stdio = await testMcpConfig({ type: 'stdio', command: process.execPath, args: [stdioScript] });
    const viaHttp = await testMcpConfig({ type: 'http', url: `${base}/mcp` });
    for (const r of [stdio, viaHttp]) {
      expect(r.ok).toBe(true);
      expect(r.tools).toEqual(['buscar', 'criar_issue', 'apagar', 'sem_marca', 'texto']);
      expect(r.readOnly).toEqual(['buscar']);
    }
  });

  it('falha volta com a lista vazia', async () => {
    const r = await testMcpConfig({ type: 'banana' });
    expect(r).toMatchObject({ ok: false, tools: [], readOnly: [] });
  });
});

describe('regras da política de escrita', () => {
  const tools = [
    { name: 'buscar', readOnly: true },
    { name: 'criar issue', readOnly: false },
  ];

  it('deny e ask: só as de escrita, com o nome como o Claude Code põe (o que não é letra, número, _ ou - vira _)', () => {
    const servers = new Map([
      ['git.hub', tools],
      ['notas', tools],
    ]);
    expect(mcpWriteRules({ 'git.hub': 'deny', notas: 'ask' }, servers)).toEqual({ deny: ['mcp__git_hub__criar_issue'], ask: ['mcp__notas__criar_issue'] });
  });

  it('sem lista (nunca testado ou mudou): o servidor inteiro', () => {
    expect(mcpWriteRules({ db: 'deny' }, new Map([['db', null]]))).toEqual({ deny: ['mcp__db'], ask: [] });
    expect(mcpRuleName('meu mcp')).toBe('mcp__meu_mcp');
  });

  it('MCP fora do projeto e política ausente não geram regra', () => {
    expect(mcpWriteRules({ sumiu: 'deny' }, new Map())).toEqual({ deny: [], ask: [] });
    expect(mcpWriteRules(undefined, new Map([['db', null]]))).toEqual({ deny: [], ask: [] });
  });

  it('contratado pela API fica no mínimo tão travado quanto o gestor; vazio vira ausente', () => {
    expect(stricterMcpWrite({ a: 'ask', b: 'deny' }, { a: 'deny', b: 'ask', c: 'ask' })).toEqual({ a: 'deny', b: 'deny', c: 'ask' });
    expect(stricterMcpWrite(undefined, undefined)).toBeUndefined();
    expect(cleanMcpWrite({})).toBeUndefined();
    expect(cleanMcpWrite({ a: 'ask' })).toEqual({ a: 'ask' });
  });
});

describe('lista guardada e regras da sessão', () => {
  async function setup() {
    const root = await tmp('myco-mcpwrite-lib-');
    const proj = path.join(root, 'projeto');
    await fs.mkdir(proj, { recursive: true });
    const claude = path.join(root, 'claude.json');
    const toolsFile = path.join(root, 'myco', 'mcp-tools.json');
    const club = path.join(root, 'myco', 'mcps.json');
    const stdioCfg = { type: 'stdio', command: process.execPath, args: [stdioScript] };
    await fs.writeFile(claude, JSON.stringify({ mcpServers: { falso: stdioCfg, outro: { type: 'http', url: `${base}/mcp` } } }));
    const lib = createMcpLibrary({ claudeConfigFile: claude, clubFile: club, backupDir: path.join(root, 'backups'), resolveProject: async () => proj, toolsFile });
    return { proj, claude, toolsFile, club, lib, stdioCfg };
  }

  it('o teste guarda a lista; a ficha vê quantas são de escrita; a sessão recebe a regra por ferramenta', async () => {
    const env = await setup();
    const r = await env.lib.test({ scope: 'user', name: 'falso' }, true);
    expect(r.ok).toBe(true);
    expect(await testedTools(env.toolsFile, toolsKey('user', null, 'falso'), mcpFingerprint(env.stdioCfg))).toHaveLength(5);

    const infos = await listMcpServers(env.proj, env.claude, env.club, env.toolsFile);
    expect(infos.find((m) => m.name === 'falso')?.tools).toEqual({ total: 5, write: 4 });
    expect(infos.find((m) => m.name === 'outro')?.tools).toBeUndefined(); // nunca testado

    const rules = await mcpWriteRulesFor(env.proj, { mcpWrite: { falso: 'deny', outro: 'ask' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    expect(rules.deny).toEqual(['mcp__falso__criar_issue', 'mcp__falso__apagar', 'mcp__falso__sem_marca', 'mcp__falso__texto']);
    expect(rules.ask).toEqual(['mcp__outro']);
  });

  it('MCP mudado depois do teste (outros argumentos): a lista não vale e a regra pega o servidor inteiro', async () => {
    const env = await setup();
    await env.lib.test({ scope: 'user', name: 'falso' }, true);
    await fs.writeFile(env.claude, JSON.stringify({ mcpServers: { falso: { ...env.stdioCfg, args: [stdioScript, '--outro'] } } }));
    const rules = await mcpWriteRulesFor(env.proj, { mcpWrite: { falso: 'deny' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    expect(rules.deny).toEqual(['mcp__falso']);
    expect((await listMcpServers(env.proj, env.claude, env.club, env.toolsFile))[0]?.tools).toBeUndefined();
  });

  it('Codex e ficha sem política: nenhuma regra', async () => {
    const env = await setup();
    const o = { clubFile: env.club, toolsFile: env.toolsFile };
    expect(await mcpWriteRulesFor(env.proj, { engine: 'codex', mcpWrite: { falso: 'deny' } }, env.claude, o)).toEqual({ deny: [], ask: [] });
    expect(await mcpWriteRulesFor(env.proj, {}, env.claude, o)).toEqual({ deny: [], ask: [] });
  });

  it('lista fora do formato não é cortada: a entrada sai (volta a valer para o servidor inteiro)', async () => {
    const env = await setup();
    const key = toolsKey('user', null, 'falso');
    const fp = mcpFingerprint(env.stdioCfg);
    await saveTestedTools(env.toolsFile, key, fp, [{ name: 'ler', readOnly: true }]);
    await saveTestedTools(env.toolsFile, key, fp, [{ name: 'x'.repeat(300), readOnly: false }]);
    expect(await testedTools(env.toolsFile, key, fp)).toBeNull();
  });

  it('arquivo estragado: sem lista, sem quebrar', async () => {
    const env = await setup();
    await fs.mkdir(path.dirname(env.toolsFile), { recursive: true });
    await fs.writeFile(env.toolsFile, '{ não é json');
    const rules = await mcpWriteRulesFor(env.proj, { mcpWrite: { falso: 'ask' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    expect(rules.ask).toEqual(['mcp__falso']);
  });
});

describe('na linha de comando e no --settings', () => {
  const profile = (over: Partial<StaffProfile> = {}): StaffProfile => ({
    id: 'ana-1a2b',
    projectId: 'p',
    name: 'Ana',
    role: 'Dev',
    portrait: null,
    reportsTo: [],
    mission: 'm',
    firstTask: '',
    autonomy: 'bypassPermissions',
    agents: [],
    skills: [],
    mcps: ['falso'],
    knowledge: [],
    rules: [],
    doneWhen: '',
    model: null,
    effort: null,
    canHire: false,
    playbook: null,
    worktree: false,
    servers: [],
    browser: false,
    sessions: [],
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...over,
  });
  const opts = { sessionId: 'u', resume: false, systemPromptFile: 'S', mcpConfigPath: 'M', firstPrompt: null };
  const denyOf = (args: string[]) => args[args.indexOf('--disallowedTools') + 1]!.split(',');

  it('deny entra no --disallowedTools; sem nada, os argumentos ficam iguais', () => {
    const plain = buildClaudeArgs(profile(), opts);
    expect(buildClaudeArgs(profile(), { ...opts, mcpDeny: [] })).toEqual(plain);
    const blocked = buildClaudeArgs(profile(), { ...opts, mcpDeny: ['mcp__falso__apagar'] });
    expect(denyOf(blocked)).toEqual([...denyOf(plain), 'mcp__falso__apagar']);
  });

  it('ask vai para permissions.ask, junto dos hooks; sem nada, o objeto fica como veio', () => {
    const settings = staffSettings(profile());
    expect(withAskRules(settings, [])).toBe(settings);
    const withAsk = withAskRules(settings, ['mcp__falso__apagar']);
    expect(withAsk).toMatchObject({ hooks: settings.hooks, permissions: { ask: ['mcp__falso__apagar'] } });
  });

  it('a lista do último teste não é editável pelo funcionário', () => {
    const rules = secretDenyRules(profile());
    // A forma da regra depende da plataforma e de onde fica o MYCO_HOME (~/... dentro da home, //c/... no Windows fora dela):
    // o que importa é que Edit e Write apontem para o arquivo da lista.
    expect(rules.some((r) => /^Edit\(.+mcp-tools\.json\)$/.test(r))).toBe(true);
    expect(rules.some((r) => /^Write\(.+mcp-tools\.json\)$/.test(r))).toBe(true);
  });
});

describe('ficha: o campo mcpWrite', () => {
  const base = { name: 'Ana', role: 'Dev', mission: 'm' };

  it('aceita ask e deny; ausente fica ausente', () => {
    expect(StaffInputSchema.parse({ ...base, mcpWrite: { github: 'deny', 'meu.mcp': 'ask' } }).mcpWrite).toEqual({ github: 'deny', 'meu.mcp': 'ask' });
    expect(StaffInputSchema.parse(base).mcpWrite).toBeUndefined();
  });

  it('recusa valor desconhecido e nome reservado', () => {
    expect(StaffInputSchema.safeParse({ ...base, mcpWrite: { github: 'allow' } }).success).toBe(false);
    expect(StaffInputSchema.safeParse({ ...base, mcpWrite: JSON.parse('{"__proto__":"deny"}') }).success).toBe(false);
  });

  it('nome reservado sai com a mensagem em português (o zod 4 trocaria por "Invalid key in record")', () => {
    const r = StaffInputSchema.safeParse({ ...base, mcpWrite: { constructor: 'deny' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain('nome de MCP reservado');
  });

  it('ficha com mcpWrite inválido editado à mão: o campo some na leitura e a ficha continua abrindo', async () => {
    const { createProfile, profileFile, readProfile } = await import('../server/staff/store');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcpwrite-ficha-'));
    try {
      const p = await createProfile(dir, 'proj', StaffInputSchema.parse({ ...base, mcpWrite: { github: 'deny' } }));
      const file = profileFile(dir, p.id);
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      json.mcpWrite = { github: 'allow' }; // valor que a escrita recusa
      await fs.writeFile(file, JSON.stringify(json));
      const got = await readProfile(dir, p.id);
      expect(got).not.toBeNull();
      expect(got?.name).toBe('Ana');
      expect(got?.mcpWrite).toBeUndefined();
      // A escrita continua recusando o mesmo valor.
      expect(StaffInputSchema.safeParse({ ...base, mcpWrite: { github: 'allow' } }).success).toBe(false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('tela: seletor de escrita', () => {
  it('livre tira do mapa; o pedido leva só os MCPs ligados', () => {
    const p = setMcpWrite(setMcpWrite({}, 'a', 'deny'), 'b', 'ask');
    expect(p).toEqual({ a: 'deny', b: 'ask' });
    expect(setMcpWrite(p, 'a', 'free')).toEqual({ b: 'ask' });
    expect(mcpWriteToSend(p, new Set(['b']))).toEqual({ b: 'ask' });
    expect(mcpWriteToSend(p, null)).toEqual(p);
  });

  it('a dica diz quantas são de escrita, ou que sem teste vale para todas', () => {
    expect(mcpWriteHint({ tools: { total: 5, write: 4 } })).toEqual({ key: 'staff.mcpWriteCount', params: { write: 4, total: 5 } });
    expect(mcpWriteHint({})).toEqual({ key: 'staff.mcpWriteUntested' });
  });
});
