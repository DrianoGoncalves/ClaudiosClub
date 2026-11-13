import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FTP_MCP_NAME, type Autonomy, type StaffProfile } from '../shared/model';
import { buildClaudeArgs, type FichaContext } from '../server/staff/ficha';
import { chromeLevel, codexMcpAccess, mcpAccessOfInput, mcpOffDenyRules, mcpServerKey, mergeMcpAccess, readMcpAccess } from '../server/staff/mcpAccess';
import { codexChromeOf, staffSettings } from '../server/staff/launch';
import { StaffInputSchema } from '../server/staff/store';
import { SSH_READ_TOOLS } from '../server/staff/sshMcp';
import { codexChromeMcpArgs, codexSshMcpArgs, CHROME_MCP_TOOLS } from '../server/chat/codexArgs';
import { rememberRules } from '../server/chat/process';

// store.ts e launch.ts leem MYCO_HOME: pasta temporária, para não usar o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcpaccess-home-${process.pid}-${Date.now()}`);
  process.env.MYCO_HOME = dir;
  return dir;
});

const profile = (over: Partial<StaffProfile> = {}): StaffProfile => ({
  id: 'ana-1a2b',
  projectId: 'p',
  name: 'Ana Souza',
  role: 'Dev',
  portrait: null,
  reportsTo: [],
  mission: 'Entregar',
  firstTask: '',
  autonomy: 'manual',
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
  browser: false,
  sessions: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const ctx: FichaContext = {
  company: 'Acme',
  projectName: 'painel',
  projectPath: 'C:\\www\\painel',
  managerNames: [],
  fichaPath: '.myco\\staff\\ana-1a2b.md',
  memoryPath: '.myco\\staff\\ana-1a2b.memory.md',
  mycoUrl: 'http://127.0.0.1:4848',
};

const AUTONOMIAS: Autonomy[] = ['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'];
const opts = { sessionId: 'u', resume: false, systemPromptFile: 'S', mcpConfigPath: 'M', firstPrompt: null };
const denyOf = (args: string[]) => args[args.indexOf('--disallowedTools') + 1]!.split(',');
const listArg = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1]!.split(',');
};

describe('leitura de fichas antigas (readMcpAccess): cada mapeamento, pela mais restrita', () => {
  it('mcpPolicy de servidor: allow vira livre (sai), ask vira ask, off vira off', () => {
    expect(readMcpAccess({ mcpPolicy: { 'mcp__a': 'allow', 'mcp__b': 'ask', 'mcp__c': 'off' } })).toEqual({ b: 'ask', c: 'off' });
  });

  it('mcpPolicy de ferramenta: ask deixa o servidor no mínimo ask; off desliga o servidor inteiro (não dá para desligar só uma no modelo novo); allow não faz nada', () => {
    expect(readMcpAccess({ mcpPolicy: { 'mcp__d__x': 'ask' } })).toEqual({ d: 'ask' });
    expect(readMcpAccess({ mcpPolicy: { 'mcp__e__y': 'off' } })).toEqual({ e: 'off' });
    expect(readMcpAccess({ mcpPolicy: { 'mcp__f__z': 'allow' } })).toBeUndefined();
    expect(readMcpAccess({ mcpPolicy: { 'mcp__f': 'allow', 'mcp__f__z': 'ask' } })).toEqual({ f: 'ask' });
  });

  it('mcpPolicy com valor inválido (typo) vira off: fail-closed por entrada', () => {
    expect(readMcpAccess({ mcpPolicy: { 'mcp__g': 'of' } })).toEqual({ g: 'off' });
    expect(readMcpAccess({ mcpPolicy: { 'mcp__h__w': 'xpto' } })).toEqual({ h: 'off' });
  });

  it('mcpWrite: deny vira readonly; qualquer outro valor vira ask', () => {
    expect(readMcpAccess({ mcpWrite: { a: 'deny', b: 'ask', c: 'xpto' } })).toEqual({ a: 'readonly', b: 'ask', c: 'ask' });
  });

  it('mcpAccess com valor inválido (typo) vira off; livre some; chave reservada sai', () => {
    expect(readMcpAccess({ mcpAccess: { a: 'ofd', b: 'free' } })).toEqual({ a: 'off' });
    expect(readMcpAccess(JSON.parse('{"mcpAccess":{"__proto__":"off","constructor":"off","ok":"ask"}}'))).toEqual({ ok: 'ask' });
  });

  it('as três fontes juntas: o mais restrito vence em cada nome', () => {
    expect(readMcpAccess({ mcpAccess: { x: 'ask' }, mcpPolicy: { 'mcp__x': 'off' }, mcpWrite: { x: 'deny' } })).toEqual({ x: 'off' });
    expect(readMcpAccess({ mcpAccess: { x: 'readonly' }, mcpWrite: { x: 'ask' } })).toEqual({ x: 'readonly' });
    expect(readMcpAccess({})).toBeUndefined();
  });

  it('separa servidor de ferramenta pelo primeiro "__" depois do prefixo', () => {
    expect(mcpServerKey('mcp__srv')).toBe('mcp__srv');
    expect(mcpServerKey('mcp__srv__tool')).toBe('mcp__srv');
    expect(mcpServerKey('mcp__a-b__x__y')).toBe('mcp__a-b');
  });
});

describe('entrada da API (StaffInputSchema): mcpAccess', () => {
  const base = { name: 'Ana', role: 'Dev', mission: 'm' };

  it('aceita os quatro valores; ausente fica ausente; {} passa (limpa)', () => {
    expect(StaffInputSchema.parse({ ...base, mcpAccess: { github: 'off', 'meu.mcp': 'readonly', b: 'ask', c: 'free' } }).mcpAccess).toEqual({
      github: 'off',
      'meu.mcp': 'readonly',
      b: 'ask',
      c: 'free',
    });
    expect(StaffInputSchema.parse(base).mcpAccess).toBeUndefined();
    expect(StaffInputSchema.parse({ ...base, mcpAccess: {} }).mcpAccess).toEqual({});
  });

  it('valor fora dos quatro é erro com mensagem clara', () => {
    const r = StaffInputSchema.safeParse({ ...base, mcpAccess: { github: 'allow' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join(' ')).toContain('acesso ao MCP: off, readonly, ask ou free');
  });

  it('nome reservado é recusado na entrada crua, com a mensagem em português', () => {
    const r = StaffInputSchema.safeParse({ ...base, mcpAccess: JSON.parse('{"__proto__":"off"}') });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain('nome de MCP reservado');
    expect(StaffInputSchema.safeParse({ ...base, mcpAccess: { constructor: 'off' } }).success).toBe(false);
  });

  it('mais de 100 MCPs é recusado', () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, 'ask' as const]));
    expect(StaffInputSchema.safeParse({ ...base, mcpAccess: many }).success).toBe(false);
  });
});

describe('contratação e PATCH com a tela antiga: a tela antiga só aperta', () => {
  it('PATCH só com mcpPolicy legado (allow) não afrouxa o que a ficha já tem', () => {
    expect(mcpAccessOfInput({ mcpPolicy: { 'mcp__x': 'allow' } }, { x: 'ask' })).toEqual({ x: 'ask' });
    expect(mcpAccessOfInput({ mcpWrite: { x: 'deny' } }, { x: 'ask', y: 'off' })).toEqual({ x: 'readonly', y: 'off' });
  });

  it('PATCH sem nenhum dos três fica como está na ficha; {} limpa', () => {
    expect(mcpAccessOfInput({}, { x: 'ask' })).toEqual({ x: 'ask' });
    expect(mcpAccessOfInput({ mcpAccess: {} }, { x: 'ask' })).toBeUndefined();
  });

  it('com mcpAccess no pedido, ele vale e os legados são ignorados', () => {
    expect(mcpAccessOfInput({ mcpAccess: { x: 'free' }, mcpPolicy: { 'mcp__x': 'off' } }, { x: 'ask' })).toBeUndefined();
    expect(mcpAccessOfInput({ mcpAccess: { x: 'readonly' }, mcpWrite: { x: 'ask' } })).toEqual({ x: 'readonly' });
  });

  it('criação (sem ficha antiga) só converte o legado', () => {
    expect(mcpAccessOfInput({ mcpPolicy: { 'mcp__x': 'off' } })).toEqual({ x: 'off' });
    expect(mcpAccessOfInput({})).toBeUndefined();
  });

  it('subfuncionário nunca fica mais solto que o gestor: chaves dos dois entram, a mais restrita vence', () => {
    expect(mergeMcpAccess({ x: 'free' }, { x: 'readonly' })).toEqual({ x: 'readonly' });
    expect(mergeMcpAccess({ x: 'ask', y: 'free' }, { x: 'off', z: 'ask' })).toEqual({ x: 'off', z: 'ask' });
    expect(mergeMcpAccess({ x: 'free' }, undefined)).toBeUndefined();
  });
});

describe('motor Claude: o que sai pelo --disallowedTools (o resto é do hook)', () => {
  it('off com nome seguro vira mcp__<nome> no --disallowedTools; nome fora de letra/número/_/- fica só no hook', () => {
    const args = buildClaudeArgs(profile({ mcpAccess: { github: 'off', 'git.hub': 'off' } }), opts);
    expect(denyOf(args)).toContain('mcp__github');
    expect(denyOf(args).some((r) => r.includes('git.hub'))).toBe(false);
  });

  it('readonly e ask não entram no --disallowedTools (são do hook de escrita)', () => {
    const args = buildClaudeArgs(profile({ mcpAccess: { github: 'readonly', outro: 'ask' } }), opts);
    expect(denyOf(args).some((r) => r.startsWith('mcp__'))).toBe(false);
  });

  it('ask não gera permissions.ask no settings (o ask é do hook, em qualquer autonomia)', () => {
    for (const autonomy of AUTONOMIAS) {
      expect(staffSettings(profile({ autonomy, mcpAccess: { github: 'ask' } }))).not.toHaveProperty('permissions');
    }
  });

  it('o alias do Chrome: desligar um dos dois nomes tira os dois da sessão', () => {
    expect(mcpOffDenyRules({ 'myco-chrome': 'off' })).toEqual(['mcp__claude-in-chrome', 'mcp__myco-chrome']);
    expect(chromeLevel({ 'claude-in-chrome': 'free', 'myco-chrome': 'readonly' })).toBe('readonly');
  });

  it('servidor de ficha com FTP continua tratado como qualquer outro MCP', () => {
    expect(mcpOffDenyRules({ [FTP_MCP_NAME]: 'off' })).toEqual([`mcp__${FTP_MCP_NAME}`]);
  });
});

describe('motor Codex: enabled_tools e o Chrome', () => {
  it('myco-ssh: sem regra entra sem filtro; off não entra', () => {
    expect(codexMcpAccess(undefined, 'myco-ssh', [], SSH_READ_TOOLS)).toEqual({ attached: true, askAsReadonly: false });
    expect(codexMcpAccess({ 'myco-ssh': 'off' }, 'myco-ssh', [], SSH_READ_TOOLS)).toEqual({ attached: false, askAsReadonly: false });
  });

  it('myco-ssh em readonly e em ask: só as de leitura (sem ssh_executar); ask avisa que virou só leitura', () => {
    const ro = codexMcpAccess({ 'myco-ssh': 'readonly' }, 'myco-ssh', [], SSH_READ_TOOLS);
    expect(ro).toEqual({ attached: true, enabledTools: SSH_READ_TOOLS, askAsReadonly: false });
    expect(ro.enabledTools).not.toContain('ssh_executar');
    const ask = codexMcpAccess({ 'myco-ssh': 'ask' }, 'myco-ssh', [], SSH_READ_TOOLS);
    expect(ask).toEqual({ attached: true, enabledTools: SSH_READ_TOOLS, askAsReadonly: true });
  });

  it('readonly ou ask sem lista de leitura: o servidor inteiro fica de fora', () => {
    expect(codexMcpAccess({ 'myco-chrome': 'readonly' }, 'myco-chrome', ['claude-in-chrome'], null).attached).toBe(false);
    expect(codexMcpAccess({ 'myco-chrome': 'ask' }, 'myco-chrome', [], [])).toEqual({ attached: false, askAsReadonly: false });
  });

  it('o alias do Chrome: desligar claude-in-chrome desliga o myco-chrome no Codex', async () => {
    const cli = path.join(home, 'chrome-cli.mjs');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(cli, '');
    const r = codexChromeOf(
      { browser: true, mcpAccess: { 'claude-in-chrome': 'off' } },
      { codexBrowser: true, chromeMcpCli: cli, clubGuard: true },
      false,
      path.join(home, 'chrome'),
    );
    expect(r.mcp).toBeNull();
    expect(r.info?.motivos).toContain('politica');
  });

  it('Chrome em readonly sem lista de leitura: fora; livre: entra com a allowlist padrão', async () => {
    const cli = path.join(home, 'chrome-cli.mjs');
    const cfg = { codexBrowser: true, chromeMcpCli: cli, clubGuard: true };
    expect(codexChromeOf({ browser: true, mcpAccess: { 'myco-chrome': 'readonly' } }, cfg, false, path.join(home, 'chrome')).mcp).toBeNull();
    const livre = codexChromeOf({ browser: true }, cfg, false, path.join(home, 'chrome'));
    expect(livre.mcp).not.toBeNull();
    expect(livre.mcp).not.toHaveProperty('enabledTools');
    expect(codexChromeMcpArgs(livre.mcp).join(' ')).toContain(`enabled_tools=[${CHROME_MCP_TOOLS.map((t) => `"${t}"`).join(',')}]`);
  });

  it('enabled_tools vai à linha de comando; sem lista não há enabled_tools', () => {
    expect(codexSshMcpArgs({ command: 'node', args: ['x.mjs'], enabledTools: ['ssh_status'] })).toContain(
      'mcp_servers.myco-ssh.enabled_tools=["ssh_status"]',
    );
    expect(codexSshMcpArgs({ command: 'node', args: ['x.mjs'] }).join(' ')).not.toContain('enabled_tools');
    expect(codexSshMcpArgs({ command: 'node', args: ['x.mjs'] }).join(' ')).not.toContain('disabled_tools');
  });

  it('no Chrome, a lista da ficha é interseção com a allowlist (nunca união)', () => {
    const args = codexChromeMcpArgs({ command: 'node', args: ['c.mjs'], enabledTools: ['browser_click', 'browser_evaluate'] });
    expect(args).toContain('mcp_servers.myco-chrome.enabled_tools=["browser_click"]');
    expect(args.join(' ')).not.toContain('browser_evaluate');
  });
});

describe('"permitir sempre" (rememberRules) não derruba o acesso da ficha', () => {
  const FTP_TOOL = `mcp__${FTP_MCP_NAME}__ftp_upload`;

  it('sessão: removeRules, replaceRules e addRules que não são allow não voltam; sobra o allow da ferramenta', () => {
    const sugestoes = [
      { type: 'removeRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' },
      { type: 'replaceRules', rules: [{ toolName: FTP_TOOL }], behavior: 'allow' },
      { type: 'addRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' },
      { type: 'addRules', rules: [{ toolName: FTP_TOOL }], behavior: 'deny' },
    ];
    expect(rememberRules(FTP_TOOL, sugestoes, 'session')).toEqual([
      { type: 'addRules', rules: [{ toolName: FTP_TOOL }], behavior: 'allow', destination: 'session' },
    ]);
  });

  it('projeto: as mesmas sugestões não viram regra nenhuma; sai só o allow da ferramenta', () => {
    const sugestoes = [
      { type: 'removeRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' },
      { type: 'addRules', rules: [{ toolName: FTP_TOOL, ruleContent: 'x' }], behavior: 'deny' },
      { type: 'addRules', rules: [{ toolName: FTP_TOOL, ruleContent: 'y' }], behavior: 'ask' },
    ];
    expect(rememberRules(FTP_TOOL, sugestoes, 'project')).toEqual([
      { type: 'addRules', rules: [{ toolName: FTP_TOOL }], behavior: 'allow', destination: 'localSettings' },
    ]);
  });

  it('na sessão, setMode segue e o removeRules junto sai', () => {
    const sugestoes = [{ type: 'setMode', mode: 'acceptEdits' }, { type: 'removeRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' }];
    expect(rememberRules('Write', sugestoes, 'session')).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  });
});

describe('a conversa do Claude sem regra de MCP (controle)', () => {
  it('sem acesso: nenhum mcp__ no --disallowedTools e sem permissions no settings', () => {
    expect(denyOf(buildClaudeArgs(profile(), opts)).some((r) => r.startsWith('mcp__'))).toBe(false);
    expect(staffSettings(profile())).not.toHaveProperty('permissions');
    expect(listArg(buildClaudeArgs(profile({ autonomy: 'auto' }), opts), '--disallowedTools')).toBeTruthy();
  });
});
