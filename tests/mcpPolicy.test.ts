import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FTP_MCP_NAME, type Autonomy, type McpPolicy, type StaffProfile } from '../shared/model';
import { buildClaudeArgs, renderFicha, type FichaContext } from '../server/staff/ficha';
import { capMcpPolicy, codexMcpPolicy, mcpPolicyRules, mcpServerKey } from '../server/staff/mcpPolicy';
import { codexChromeOf, staffSettings } from '../server/staff/launch';
import { readProfile, StaffInputSchema, writeAtomic } from '../server/staff/store';
import { rememberRules } from '../server/chat/process';
import { CHROME_MCP_TOOLS, codexChromeMcpArgs, codexSshMcpArgs, tomlString } from '../server/chat/codexArgs';

// store.ts e launch.ts leem MYCO_HOME: pasta temporária, para não usar o ~/.myco de quem roda os testes.
const home = await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  const dir = nodePath.join(os.tmpdir(), `myco-mcppolicy-home-${process.pid}-${Date.now()}`);
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
const NIVEIS: McpPolicy[] = ['allow', 'ask', 'off'];
const FTP_SERVER = `mcp__${FTP_MCP_NAME}`;
const FTP_TOOL = `mcp__${FTP_MCP_NAME}__ftp_upload`;
const base = { sessionId: 's', resume: false, systemPromptFile: 'S', mcpConfigPath: null, firstPrompt: null };

/** Valor de uma flag de lista (`--disallowedTools a,b`); ausente = []. */
const listArg = (args: string[], flag: string): string[] => {
  const i = args.indexOf(flag);
  return i === -1 ? [] : args[i + 1]!.split(',');
};

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mcppolicy-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

describe('schema de mcpPolicy (StaffInputSchema)', () => {
  const minimo = { name: 'Ana', role: 'Dev', mission: 'Entregar' };
  const parse = (mcpPolicy: unknown) => StaffInputSchema.safeParse({ ...minimo, mcpPolicy });

  it('aceita chaves válidas de servidor e de ferramenta, com os três valores', () => {
    const r = parse({ mcp__claude_in_chrome: 'allow', 'mcp__myco-ftp': 'ask', 'mcp__myco-ftp__ftp_upload': 'off', 'mcp__a-b_c__x': 'ask' });
    expect(r.success).toBe(true);
  });

  it('ausente: o campo não aparece no resultado (o PATCH sem ele mantém o da ficha)', () => {
    const r = StaffInputSchema.safeParse(minimo);
    expect(r.success).toBe(true);
    expect(r.success && 'mcpPolicy' in r.data).toBe(false);
  });

  it.each([
    ['sem mcp__', 'ftp__x'],
    ['vírgula (quebraria a lista da linha de comando)', 'mcp__a,b'],
    ['espaço', 'mcp__a b'],
    ['aspas', 'mcp__"a"'],
    ['terminada em __', 'mcp__srv__'],
    ['só o prefixo', 'mcp__'],
    ['mais de 128 caracteres depois do prefixo', `mcp__${'a'.repeat(129)}`],
    ['caractere de ponto e vírgula', 'mcp__a;b'],
  ])('recusa chave %s', (_, key) => {
    const r = parse({ [key]: 'ask' });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toBe('ferramenta MCP inválida');
  });

  it('recusa valor fora de allow, ask e off', () => {
    expect(parse({ 'mcp__myco-ftp': 'read' }).success).toBe(false);
    expect(parse({ 'mcp__myco-ftp': null }).success).toBe(false);
  });

  it('aceita até 200 chaves e recusa a 201ª', () => {
    const chaves = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`mcp__s${i}`, 'allow' as const]));
    expect(parse(chaves(200)).success).toBe(true);
    const r = parse(chaves(201));
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.message).toBe('políticas demais');
  });

  it('no arquivo, uma política inválida some e a ficha continua sendo lida (não some da lista)', async () => {
    const projectPath = path.join(tmp, 'projeto');
    const p = profile({ mcpPolicy: { 'mcp__a,b': 'ask' } as Record<string, McpPolicy> });
    await writeAtomic(path.join(projectPath, '.myco', 'staff', `${p.id}.json`), JSON.stringify(p));
    const lida = await readProfile(projectPath, p.id);
    expect(lida).not.toBeNull();
    expect(lida?.mcpPolicy).toBeUndefined();
    // Válida no arquivo: volta igual.
    const ok = profile({ id: 'bia-3c4d', mcpPolicy: { 'mcp__myco-ftp': 'ask' } });
    await writeAtomic(path.join(projectPath, '.myco', 'staff', `${ok.id}.json`), JSON.stringify(ok));
    expect((await readProfile(projectPath, ok.id))?.mcpPolicy).toEqual({ 'mcp__myco-ftp': 'ask' });
  });
});

describe('mcpPolicyRules: o que vai ao Claude', () => {
  it('servidor off: deny do servidor; a ferramenta de allow não gera nada', () => {
    expect(mcpPolicyRules({ [FTP_SERVER]: 'off', [FTP_TOOL]: 'allow' })).toEqual({ deny: [FTP_SERVER], ask: [] });
  });

  it('ferramenta off com servidor ask: deny da ferramenta e ask do servidor (o deny vence no CLI)', () => {
    expect(mcpPolicyRules({ [FTP_SERVER]: 'ask', [FTP_TOOL]: 'off' })).toEqual({ deny: [FTP_TOOL], ask: [FTP_SERVER] });
  });

  it('ferramenta ask com servidor off: nada no ask (o deny do servidor já cobre)', () => {
    expect(mcpPolicyRules({ [FTP_SERVER]: 'off', [FTP_TOOL]: 'ask' })).toEqual({ deny: [FTP_SERVER], ask: [] });
  });

  it('ferramenta ask com servidor allow ou sem política: ask da ferramenta; servidor ask cobre a ferramenta allow', () => {
    expect(mcpPolicyRules({ [FTP_SERVER]: 'allow', [FTP_TOOL]: 'ask' })).toEqual({ deny: [], ask: [FTP_TOOL] });
    expect(mcpPolicyRules({ [FTP_SERVER]: 'ask', [FTP_TOOL]: 'allow' })).toEqual({ deny: [], ask: [FTP_SERVER] });
  });

  it('só allow, ou sem política: nada', () => {
    expect(mcpPolicyRules({ [FTP_SERVER]: 'allow', [FTP_TOOL]: 'allow' })).toEqual({ deny: [], ask: [] });
    expect(mcpPolicyRules(undefined)).toEqual({ deny: [], ask: [] });
    expect(mcpPolicyRules({})).toEqual({ deny: [], ask: [] });
  });

  it('ordenado e sem repetição', () => {
    const r = mcpPolicyRules({ 'mcp__b__x': 'off', 'mcp__a__y': 'off', 'mcp__c': 'ask', 'mcp__d__z': 'ask' });
    expect(r.deny).toEqual(['mcp__a__y', 'mcp__b__x']);
    expect(r.ask).toEqual(['mcp__c', 'mcp__d__z']);
  });

  it('mcpServerKey: a chave do servidor, de servidor ou de ferramenta', () => {
    expect(mcpServerKey('mcp__srv')).toBe('mcp__srv');
    expect(mcpServerKey('mcp__srv__tool')).toBe('mcp__srv');
    expect(mcpServerKey('mcp__a-b__x__y')).toBe('mcp__a-b');
  });
});

describe('mcpPolicy na linha de comando do Claude: matriz autonomia × política × (servidor, ferramenta)', () => {
  const CASOS = AUTONOMIAS.flatMap((autonomy) => NIVEIS.flatMap((nivel) => [FTP_TOOL, FTP_SERVER].map((key) => ({ autonomy, nivel, key }))));

  it.each(CASOS)('$autonomy · $nivel · $key', ({ autonomy, nivel, key }) => {
    const p = profile({ autonomy, mcpPolicy: { [key]: nivel } });
    const args = buildClaudeArgs(p, base);
    const deny = listArg(args, '--disallowedTools');
    const allow = listArg(args, '--allowedTools');
    const ask = staffSettings(p).permissions?.ask ?? [];
    if (nivel === 'off') {
      expect(deny).toContain(key);
      expect(ask).not.toContain(key);
    } else if (nivel === 'ask') {
      // Nunca no --disallowedTools nem no --allowedTools: o ask é do settings.
      expect(ask).toContain(key);
      expect(deny).not.toContain(key);
      expect(allow).not.toContain(key);
    } else {
      expect(deny).not.toContain(key);
      expect(allow).not.toContain(key);
      expect(ask).not.toContain(key);
    }
  });

  it('sem política, o --disallowedTools e o settings ficam como antes', () => {
    const args = buildClaudeArgs(profile(), base);
    expect(args[args.indexOf('--disallowedTools') + 1]).not.toMatch(/mcp__/);
    expect(staffSettings(profile())).not.toHaveProperty('permissions');
  });

  it('Chrome: com acceptEdits, auto ou bypass sai --allowedTools mcp__claude-in-chrome; o ask de uma ferramenta dele segue no settings', () => {
    // No CLI 2.1.310 o ask vence o --allowedTools (provado à mão): a ferramenta com Perguntar continua pedindo permissão.
    const tool = 'mcp__claude-in-chrome__javascript_tool';
    for (const autonomy of ['acceptEdits', 'auto', 'bypassPermissions'] as Autonomy[]) {
      const p = profile({ browser: true, autonomy, mcpPolicy: { [tool]: 'ask' } });
      const args = buildClaudeArgs(p, base);
      expect(listArg(args, '--allowedTools')).toEqual(['mcp__claude-in-chrome']);
      expect(staffSettings(p).permissions?.ask).toEqual([tool]);
      expect(listArg(args, '--disallowedTools')).not.toContain(tool);
    }
    // Manual: o navegador não entra no --allowedTools (pede a cada clique), com ou sem política.
    expect(buildClaudeArgs(profile({ browser: true, autonomy: 'manual', mcpPolicy: { [tool]: 'ask' } }), base)).not.toContain('--allowedTools');
  });
});

describe('"permitir sempre" (rememberRules) não derruba a política da ficha', () => {
  const policy = { [FTP_TOOL]: 'ask', [`mcp__${FTP_MCP_NAME}__ftp_delete`]: 'off' } as Record<string, McpPolicy>;

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
    expect(rememberRules('mcp__myco-ftp__ftp_upload', sugestoes, 'project')).toEqual([
      { type: 'addRules', rules: [{ toolName: FTP_TOOL }], behavior: 'allow', destination: 'localSettings' },
    ]);
  });

  it('addRules allow continua valendo, na sessão e no projeto', () => {
    const allow = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow' };
    expect(rememberRules('Bash', [allow], 'session')).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' },
    ]);
    expect(rememberRules('Bash', [allow], 'project')).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' },
    ]);
  });

  it('na sessão, setMode e addDirectories seguem; o removeRules junto sai', () => {
    const sugestoes = [{ type: 'setMode', mode: 'acceptEdits' }, { type: 'removeRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' }];
    expect(rememberRules('Write', sugestoes, 'session')).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  });

  it('a política da ficha não muda com o "permitir sempre": ask no settings e off no --disallowedTools seguem', () => {
    // ask e deny vencem o allow no CLI (provado à mão): por isso a ficha não depende do que o usuário aprovou.
    rememberRules(FTP_TOOL, [{ type: 'removeRules', rules: [{ toolName: FTP_TOOL }], behavior: 'ask' }], 'session');
    const p = profile({ autonomy: 'bypassPermissions', mcpPolicy: policy });
    expect(staffSettings(p).permissions?.ask).toEqual([FTP_TOOL]);
    expect(listArg(buildClaudeArgs(p, base), '--disallowedTools')).toContain(`mcp__${FTP_MCP_NAME}__ftp_delete`);
  });
});

describe('capMcpPolicy: quem é contratado não fica mais solto que o gestor', () => {
  it('em cada chave, vale a mais restritiva', () => {
    expect(capMcpPolicy({ a: 'allow', b: 'ask', c: 'off' }, { a: 'off', b: 'allow', c: 'ask' })).toEqual({ a: 'off', b: 'ask', c: 'off' });
  });

  it('a chave que só o gestor tem entra; a que só o pedido tem fica', () => {
    expect(capMcpPolicy(undefined, { x: 'ask' })).toEqual({ x: 'ask' });
    expect(capMcpPolicy({ y: 'allow' }, undefined)).toEqual({ y: 'allow' });
  });

  it('sem nenhuma das duas, undefined', () => {
    expect(capMcpPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe('codexMcpPolicy: a política no Codex (ask vira off)', () => {
  it('ferramenta ask e off entram em disabledTools (nome curto); allow não; ask fica listado para a ficha', () => {
    const r = codexMcpPolicy(
      { 'mcp__myco-ssh__ssh_executar': 'ask', 'mcp__myco-ssh__ssh_logs': 'off', 'mcp__myco-ssh__ssh_status': 'allow' },
      'myco-ssh',
    );
    expect(r).toEqual({ disabled: false, disabledTools: ['ssh_executar', 'ssh_logs'], askedAsOff: ['mcp__myco-ssh__ssh_executar'] });
  });

  it('servidor ask ou off: o MCP fica fora da conversa; ask entra em askedAsOff', () => {
    expect(codexMcpPolicy({ 'mcp__myco-ssh': 'ask' }, 'myco-ssh')).toEqual({ disabled: true, disabledTools: [], askedAsOff: ['mcp__myco-ssh'] });
    expect(codexMcpPolicy({ 'mcp__myco-ssh': 'off' }, 'myco-ssh')).toEqual({ disabled: true, disabledTools: [], askedAsOff: [] });
    expect(codexMcpPolicy({ 'mcp__myco-ssh': 'allow' }, 'myco-ssh').disabled).toBe(false);
    expect(codexMcpPolicy(undefined, 'myco-ssh')).toEqual({ disabled: false, disabledTools: [], askedAsOff: [] });
  });

  it('alias: a chave do claude-in-chrome vale para o myco-chrome só no nível do servidor', () => {
    const alias = ['mcp__claude-in-chrome'];
    expect(codexMcpPolicy({ 'mcp__claude-in-chrome': 'off' }, 'myco-chrome', alias).disabled).toBe(true);
    expect(codexMcpPolicy({ 'mcp__claude-in-chrome': 'ask' }, 'myco-chrome', alias)).toEqual({
      disabled: true,
      disabledTools: [],
      askedAsOff: ['mcp__claude-in-chrome'],
    });
    // Sem o alias informado, a chave do Claude não vale.
    expect(codexMcpPolicy({ 'mcp__claude-in-chrome': 'off' }, 'myco-chrome').disabled).toBe(false);
    // Ferramenta da extensão do Claude não mapeia: os nomes são outros.
    expect(codexMcpPolicy({ 'mcp__claude-in-chrome__javascript_tool': 'off' }, 'myco-chrome', alias)).toEqual({
      disabled: false,
      disabledTools: [],
      askedAsOff: [],
    });
  });

  it('ferramenta do Chrome do Codex com ask: vai para disabledTools', () => {
    expect(codexMcpPolicy({ 'mcp__myco-chrome__browser_click': 'ask' }, 'myco-chrome')).toEqual({
      disabled: false,
      disabledTools: ['browser_click'],
      askedAsOff: ['mcp__myco-chrome__browser_click'],
    });
  });
});

describe('args do Codex com disabled_tools', () => {
  const ssh = { command: 'node', args: ['ssh.mjs'], cwd: 'C:\\club' };

  it('sem ferramentas desligadas, nada de disabled_tools', () => {
    expect(codexSshMcpArgs(ssh).join(' ')).not.toContain('disabled_tools');
    expect(codexChromeMcpArgs({ command: 'node', args: ['cli.js'] }).join(' ')).not.toContain('disabled_tools');
  });

  it('com ferramentas desligadas, emite mcp_servers.<nome>.disabled_tools em TOML', () => {
    const args = codexSshMcpArgs({ ...ssh, disabledTools: ['ssh_executar', 'ssh_logs'] });
    expect(args).toContain(`mcp_servers.myco-ssh.disabled_tools=[${tomlString('ssh_executar')},${tomlString('ssh_logs')}]`);
  });

  it('o Chrome: disabled_tools soma, e a allowlist (enabled_tools) fica como está', () => {
    const args = codexChromeMcpArgs({ command: 'node', args: ['cli.js'], disabledTools: ['browser_click'] });
    expect(args).toContain(`mcp_servers.myco-chrome.disabled_tools=[${tomlString('browser_click')}]`);
    expect(args).toContain(`mcp_servers.myco-chrome.enabled_tools=[${CHROME_MCP_TOOLS.map((t) => tomlString(t)).join(',')}]`);
    expect(CHROME_MCP_TOOLS).toHaveLength(9);
  });

  it('codexChromeOf: ask no alias do Chrome vira motivo e a ficha recebe a chave; off desliga a ferramenta na linha', () => {
    const cli = process.execPath; // existe: o teste só precisa de um arquivo para o MCP do Chrome
    const comAsk = codexChromeOf(profile({ browser: true, mcpPolicy: { 'mcp__claude-in-chrome': 'ask' } }), { codexBrowser: true, chromeMcpCli: cli }, false, 'C:\\run\\chrome');
    expect(comAsk.mcp).toBeNull();
    expect(comAsk.info).toEqual({ mcp: false, motivos: ['politica'] });

    const tool = codexChromeOf(profile({ browser: true, mcpPolicy: { 'mcp__myco-chrome__browser_click': 'off' } }), { codexBrowser: true, chromeMcpCli: cli }, false, 'C:\\run\\chrome');
    expect(tool.mcp?.disabledTools).toEqual(['browser_click']);
    expect(codexChromeMcpArgs(tool.mcp)).toContain(`mcp_servers.myco-chrome.disabled_tools=[${tomlString('browser_click')}]`);

    const semPolitica = codexChromeOf(profile({ browser: true }), { codexBrowser: true, chromeMcpCli: cli }, false, 'C:\\run\\chrome');
    expect(semPolitica.mcp).not.toHaveProperty('disabledTools');
  });
});

describe('ficha do Codex: o que a política desligou', () => {
  const codex = profile({ engine: 'codex', autonomy: 'acceptEdits' });

  it('com ferramenta de Perguntar desligada no Codex, uma linha diz quais e por quê', () => {
    const md = renderFicha(codex, { ...ctx, codexMcpAsked: ['mcp__myco-ssh__ssh_executar'] });
    expect(md).toContain('## Ferramentas MCP');
    expect(md).toContain('No Codex não há como perguntar antes: as ferramentas marcadas como Perguntar ficam desligadas (`mcp__myco-ssh__ssh_executar`).');
  });

  it('sem nada desligado por Perguntar, a seção não aparece; no Claude, também não aparece', () => {
    expect(renderFicha(codex, ctx)).not.toContain('## Ferramentas MCP');
    expect(renderFicha(profile({ autonomy: 'acceptEdits' }), { ...ctx, codexMcpAsked: ['mcp__myco-ssh'] })).not.toContain('## Ferramentas MCP');
  });
});
