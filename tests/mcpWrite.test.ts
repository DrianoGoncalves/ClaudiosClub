import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StaffProfile } from '../shared/model';

// Política de escrita dos MCPs na ficha (server/staff/mcpTools.ts): o teste guarda o que é só leitura, a ficha escolhe
// livre / pede antes / bloqueada, e a conversa recebe o arquivo que o hook scripts/hooks/mcp-write-guard.mjs lê (ver mcpWriteGuard.test.ts).

// MYCO_HOME de teste: o arquivo padrão da lista (e a regra que o protege) ficam fora do ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcpwrite-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const { testMcpConfig } = await import('../server/staff/mcpTest');
const { mcpAccessFile, mcpOffDenyRules, mergeMcpAccess, readMcpAccess, withChromeAlias } = await import('../server/staff/mcpAccess');
const { claudeName, mcpFingerprint, saveTestedTools, testedTools, toolsKey } = await import(
  '../server/staff/mcpTools'
);
const { listMcpServers, mcpWriteFileFor } = await import('../server/staff/mcp');
const { createMcpLibrary } = await import('../server/staff/mcpLibrary');
const { buildClaudeArgs, secretDenyRules } = await import('../server/staff/ficha');
const { MCP_TOOLS_MATCHER, staffSettings } = await import('../server/staff/launch');
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

describe('arquivo da política (o que o hook lê)', () => {
  const tools = [
    { name: 'buscar', readOnly: true },
    { name: 'criar issue', readOnly: false },
  ];

  it('acesso por MCP, com as ferramentas de leitura do teste (só as que o teste marcou)', () => {
    const got = mcpAccessFile({ 'git.hub': 'readonly', notas: 'ask' }, new Map([['git.hub', tools]]));
    expect(got).toEqual({ 'git.hub': { policy: 'readonly', readOnly: ['buscar'] }, notas: { policy: 'ask', readOnly: [] } });
  });

  it('sem lista (nunca testado ou mudou): readOnly vazio, o servidor inteiro cai na regra', () => {
    expect(mcpAccessFile({ db: 'readonly' }, new Map())).toEqual({ db: { policy: 'readonly', readOnly: [] } });
  });

  it('off: a lista de leitura sai vazia, mesmo que o teste tenha marcado ferramentas', () => {
    expect(mcpAccessFile({ 'git.hub': 'off' }, new Map([['git.hub', tools]]))).toEqual({ 'git.hub': { policy: 'off', readOnly: [] } });
  });

  it('livre não entra no arquivo; e o alias do Chrome leva o nível mais restrito às duas chaves', () => {
    expect(mcpAccessFile({ notas: 'free' }, new Map())).toEqual({});
    expect(mcpAccessFile({ 'claude-in-chrome': 'free', 'myco-chrome': 'ask' }, new Map())).toEqual({
      'claude-in-chrome': { policy: 'ask', readOnly: [] },
      'myco-chrome': { policy: 'ask', readOnly: [] },
    });
  });

  it('leitura que colide, depois de normalizada, com outra ferramenta do MCP sai da lista (o hook não separaria)', () => {
    const colide = [
      { name: 'listar itens', readOnly: true },
      { name: 'listar_itens', readOnly: false },
      { name: 'ver', readOnly: true },
    ];
    expect(mcpAccessFile({ x: 'readonly' }, new Map([['x', colide]]))).toEqual({ x: { policy: 'readonly', readOnly: ['ver'] } });
  });

  it('nome de MCP reservado não chega ao arquivo: a leitura (readMcpAccess) o tira antes, e o nome que sobra segue', () => {
    const got = mcpAccessFile(readMcpAccess(JSON.parse('{"mcpAccess":{"__proto__":"readonly","ok":"ask"}}')), new Map());
    expect(Object.keys(got)).toEqual(['ok']);
    expect(got).toEqual({ ok: { policy: 'ask', readOnly: [] } });
  });

  it('o nome da ferramenta como o Claude Code o põe (o que não é letra, número, _ ou - vira _)', () => {
    expect(claudeName('git.hub')).toBe('git_hub');
    expect(claudeName('criar issue')).toBe('criar_issue');
    expect(mcpAccessFile(undefined, new Map())).toEqual({});
  });

  it('juntar acesso (subfuncionário e PATCH antigo) fica com o mais restrito; vazio vira ausente', () => {
    expect(mergeMcpAccess({ a: 'ask', b: 'off' }, { a: 'readonly', b: 'ask', c: 'ask' })).toEqual({ a: 'readonly', b: 'off', c: 'ask' });
    expect(mergeMcpAccess(undefined, undefined)).toBeUndefined();
    expect(mergeMcpAccess({}, { a: 'free' })).toBeUndefined();
    expect(mergeMcpAccess({ a: 'ask' })).toEqual({ a: 'ask' });
  });

  it('desligar Chrome por um dos dois nomes vale para o outro (o mesmo Chrome)', () => {
    expect(withChromeAlias({ 'myco-chrome': 'off' })).toEqual({ 'myco-chrome': 'off', 'claude-in-chrome': 'off' });
    // `x.y` tem ponto (fora do nome seguro): fica só no hook. `ok` é só leitura: não sai.
    expect(mcpOffDenyRules({ 'claude-in-chrome': 'off', 'x.y': 'off', ok: 'readonly' })).toEqual(['mcp__claude-in-chrome', 'mcp__myco-chrome']);
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

  it('o teste guarda a lista; a ficha vê quantas são de escrita; a conversa recebe só as de leitura (o resto é do hook)', async () => {
    const env = await setup();
    const r = await env.lib.test({ scope: 'user', name: 'falso' }, true);
    expect(r.ok).toBe(true);
    expect(await testedTools(env.toolsFile, toolsKey('user', null, 'falso'), mcpFingerprint(env.stdioCfg))).toHaveLength(5);

    const infos = await listMcpServers(env.proj, env.claude, env.club, env.toolsFile);
    expect(infos.find((m) => m.name === 'falso')?.tools).toEqual({ total: 5, write: 4 });
    expect(infos.find((m) => m.name === 'outro')?.tools).toBeUndefined(); // nunca testado

    const file = await mcpWriteFileFor(env.proj, { mcpAccess: { falso: 'readonly', outro: 'ask' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    // 'texto' (readOnlyHint só "true", em texto) não é de leitura: fica fora da lista.
    expect(file).toEqual({ falso: { policy: 'readonly', readOnly: ['buscar'] }, outro: { policy: 'ask', readOnly: [] } });
  });

  it('MCP mudado depois do teste (outros argumentos): a lista de leitura fica vazia (a política pega o servidor inteiro)', async () => {
    const env = await setup();
    await env.lib.test({ scope: 'user', name: 'falso' }, true);
    await fs.writeFile(env.claude, JSON.stringify({ mcpServers: { falso: { ...env.stdioCfg, args: [stdioScript, '--outro'] } } }));
    const file = await mcpWriteFileFor(env.proj, { mcpAccess: { falso: 'readonly' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    expect(file).toEqual({ falso: { policy: 'readonly', readOnly: [] } });
    expect((await listMcpServers(env.proj, env.claude, env.club, env.toolsFile))[0]?.tools).toBeUndefined();
  });

  it('Codex e ficha sem política: arquivo vazio (sem hook)', async () => {
    const env = await setup();
    const o = { clubFile: env.club, toolsFile: env.toolsFile };
    expect(await mcpWriteFileFor(env.proj, { engine: 'codex', mcpAccess: { falso: 'readonly' } }, env.claude, o)).toEqual({});
    expect(await mcpWriteFileFor(env.proj, {}, env.claude, o)).toEqual({});
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
    const file = await mcpWriteFileFor(env.proj, { mcpAccess: { falso: 'ask' } }, env.claude, { clubFile: env.club, toolsFile: env.toolsFile });
    expect(file).toEqual({ falso: { policy: 'ask', readOnly: [] } });
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

  it('a política de MCP não vira regra por ferramenta: nem no --disallowedTools, nem no permissions.ask (quem decide é o hook)', () => {
    const args = buildClaudeArgs(profile(), opts);
    expect(denyOf(args).some((r) => r.startsWith('mcp__'))).toBe(false);
    expect(staffSettings(profile(), undefined, { mcpWriteFile: '/run/s/mcp-write.json' })).not.toHaveProperty('permissions');
  });

  it('com política, o hook de MCP entra no PreToolUse com a cópia da pasta da conversa e o arquivo; sem política, não entra', () => {
    const dir = path.join('/run', 's', 'hooks');
    const file = path.join('/run', 's', 'mcp-write.json');
    const pre = staffSettings(profile(), undefined, { hooksDir: dir, mcpWriteFile: file }).hooks.PreToolUse;
    expect(pre.find((h) => h.matcher === MCP_TOOLS_MATCHER)).toMatchObject({
      hooks: [{ type: 'command', command: process.execPath, args: [path.join(dir, 'mcp-write-guard.mjs'), file] }],
    });
    expect(staffSettings(profile(), undefined, { hooksDir: dir }).hooks.PreToolUse.some((h) => h.matcher === MCP_TOOLS_MATCHER)).toBe(false);
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

  it('ficha com mcpWrite inválido editado à mão: a leitura é fail-closed por entrada e junta com o mcpAccess pela mais restrita', async () => {
    const { createProfile, profileFile, readProfile } = await import('../server/staff/store');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcpwrite-ficha-'));
    try {
      const p = await createProfile(dir, 'proj', StaffInputSchema.parse({ ...base, mcpAccess: { github: 'readonly' } }));
      const file = profileFile(dir, p.id);
      const json = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      // "denny" (typo) e "allow" não liberam: pedem antes. Chave vazia e reservada saem; a válida segue. `github` já era readonly no acesso: fica readonly.
      json.mcpWrite = JSON.parse('{"github":"allow","denny":"denny","":"deny","constructor":"deny","__proto__":"deny","ok.mcp":"deny"}');
      await fs.writeFile(file, JSON.stringify(json));
      const got = await readProfile(dir, p.id);
      expect(got).not.toBeNull();
      expect(got?.name).toBe('Ana');
      expect(got?.mcpAccess).toEqual({ github: 'readonly', denny: 'ask', 'ok.mcp': 'readonly' });
      expect(got).not.toHaveProperty('mcpWrite');
      // A escrita continua recusando os mesmos valores.
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
