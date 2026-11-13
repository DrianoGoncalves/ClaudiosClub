import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StaffProfile } from '../shared/model';
import { clubBlockedOrigins } from '../server/clubAddress';
import { ConfigPatch, MYCO_HOME, readConfig, updateConfig } from '../server/config';
import { renderFicha, secretDenyRules } from '../server/staff/ficha';
import { BROWSER_TOOLS_MATCHER, codexChromeOf, staffSettings } from '../server/staff/launch';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-guard-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// O navegador do funcionário não abre a tela do Club (scripts/hooks/club-guard.mjs e o --blocked-origins do Codex).

const hook = fileURLToPath(new URL('../scripts/hooks/club-guard.mjs', import.meta.url));
const run = (input: unknown, port = '4848', stage = 'pre') =>
  execFileSync(process.execPath, [hook, stage], { input: JSON.stringify(input), env: { ...process.env, MYCO_PORT: port } }).toString();
const denied = (out: string) => out !== '' && JSON.parse(out).hookSpecificOutput?.permissionDecision === 'deny';

describe('club-guard: o navegador do funcionário não abre o Claudio’s Club', () => {
  it.each([
    ['nome do Club', { url: 'http://claudio.localhost:4848/' }],
    ['nome antigo, outra porta (Vite do dev)', { url: 'http://myco.localhost:5173' }],
    ['maiúsculas', { url: 'HTTP://CLAUDIO.LOCALHOST' }],
    ['localhost na porta do Club', { url: 'http://localhost:4848/api/inbox' }],
    ['127.0.0.1 na porta do Club', { url: '127.0.0.1:4848' }],
    ['127.1 (atalho do loopback)', { url: 'http://127.1:4848' }],
    ['IPv6', { url: 'http://[::1]:4848' }],
    ['URL codificada', { url: 'http://claudio%2Elocalhost%3A4848' }],
    ['código no javascript_tool', { action: 'javascript_exec', text: "location.href = 'http://claudio.localhost:4848'" }],
    ['aninhado', { actions: [{ type: 'click' }, { type: 'goto', args: ['http://localhost:4848'] }] }],
  ])('nega: %s', (_, tool_input) => {
    const out = run({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input });
    expect(denied(out)).toBe(true);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toContain('[MyCo]');
  });

  it.each([
    ['site comum', { url: 'https://example.com' }],
    ['projeto do funcionário em outra porta', { url: 'http://localhost:3000' }],
    ['porta parecida', { url: 'http://localhost:48480' }],
    ['outro nome .localhost', { url: 'http://app.localhost:3000' }],
    ['sem texto', { tabId: 3 }],
  ])('deixa passar: %s', (_, tool_input) => {
    expect(run({ tool_name: 'mcp__claude-in-chrome__navigate', tool_input })).toBe('');
  });

  it('segue a MYCO_PORT do servidor', () => {
    expect(denied(run({ tool_input: { url: 'http://localhost:5000' } }, '5000'))).toBe(true);
    expect(run({ tool_input: { url: 'http://localhost:4848' } }, '5000')).toBe('');
  });

  it('entrada estranha ou outra etapa: não responde', () => {
    expect(execFileSync(process.execPath, [hook, 'pre'], { input: 'não é json' }).toString()).toBe('');
    expect(run({ tool_input: { url: 'http://claudio.localhost' } }, '4848', 'post')).toBe('');
  });

  it('entra em todo funcionário, antes das ferramentas de navegador', () => {
    const pre = staffSettings().hooks.PreToolUse;
    const guard = pre.find((h) => h.matcher === BROWSER_TOOLS_MATCHER);
    expect(guard?.hooks[0]).toMatchObject({ type: 'command', command: process.execPath, args: [hook, 'pre'] });
    expect(staffSettings().hooks.PostToolUse.some((h) => h.matcher === BROWSER_TOOLS_MATCHER)).toBe(false);
    const re = new RegExp(`^(?:${BROWSER_TOOLS_MATCHER})$`);
    expect(re.test('mcp__claude-in-chrome__navigate')).toBe(true);
    expect(re.test('mcp__playwright__browser_navigate')).toBe(true);
    expect(re.test('mcp__github__get_me')).toBe(false);
  });
});

describe('clubBlockedOrigins: o Playwright MCP do Codex', () => {
  it('os nomes em qualquer porta; localhost e 127.0.0.1 só na porta do Club', () => {
    expect(clubBlockedOrigins(4848)).toBe('http://claudio.localhost:*;http://myco.localhost:*;http://localhost:4848;http://127.0.0.1:4848');
  });
});

describe('a opção nas Configurações: "Bloquear o Claudio’s Club no navegador dos funcionários"', () => {
  const ficha = (over: Partial<StaffProfile> = {}) =>
    ({
      id: 'ana-1', projectId: 'p', name: 'Ana', role: 'Dev', mission: '', firstTask: '', autonomy: 'acceptEdits', agents: [], skills: [], mcps: [],
      knowledge: [], rules: [], doneWhen: '', reportsTo: [], engine: 'claude', model: null, effort: null, canHire: false, playbook: null,
      worktree: false, servers: [], sshWrite: [], browser: true, portrait: null, sessions: [], ...over,
    }) as unknown as StaffProfile;
  const ctx = { company: 'Co', projectName: 'p', projectPath: '/p', managerNames: [], fichaPath: 'f.md', memoryPath: 'm.md', mycoUrl: 'http://127.0.0.1:4848' };

  it('padrão ligada; o PATCH aceita só booleano; o arquivo guarda e lê', async () => {
    const file = path.join(root, 'config.json');
    expect((await readConfig(file)).clubGuard).toBe(true);
    expect(ConfigPatch.safeParse({ clubGuard: false }).success).toBe(true);
    expect(ConfigPatch.safeParse({ clubGuard: 'não' }).success).toBe(false);
    await updateConfig({ clubGuard: false }, file);
    expect((await readConfig(file)).clubGuard).toBe(false);
  });

  it('só `false` desliga: sem o hook, sem --blocked-origins e sem a regra na ficha', () => {
    const guarded = (o?: { clubGuard?: boolean }) => staffSettings(undefined, undefined, o).hooks.PreToolUse.some((h) => h.matcher === BROWSER_TOOLS_MATCHER);
    expect(guarded()).toBe(true);
    expect(guarded({ clubGuard: true })).toBe(true);
    expect(guarded({ clubGuard: false })).toBe(false);

    const codex = (clubGuard?: boolean) => codexChromeOf({ browser: true }, { codexBrowser: true, chromeMcpCli: hook, clubGuard }, false, root).mcp?.args ?? [];
    expect(codex()).toContain('--blocked-origins');
    expect(codex(false)).not.toContain('--blocked-origins');

    const regra = 'Nunca abra o Claudio’s Club no navegador';
    expect(renderFicha(ficha(), ctx)).toContain(regra);
    expect(renderFicha(ficha(), { ...ctx, clubGuard: false })).not.toContain(regra);
    expect(renderFicha(ficha({ engine: 'codex' } as Partial<StaffProfile>), { ...ctx, codexChrome: { mcp: true, motivos: [] } })).toContain(regra);
  });

  it('o funcionário não edita o arquivo da configuração (desligaria o bloqueio por fora da tela)', () => {
    const rules = secretDenyRules(ficha());
    const file = path.basename(path.dirname(path.join(MYCO_HOME, 'config.json')));
    for (const tool of ['Edit', 'Write']) expect(rules.some((r) => r.startsWith(`${tool}(`) && r.includes(`${file}/config.json`))).toBe(true);
    expect(rules.some((r) => r.startsWith('Read(') && r.includes('config.json') && !r.includes('claude'))).toBe(false); // ler pode
  });
});
