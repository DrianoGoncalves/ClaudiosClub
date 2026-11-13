import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clubBlockedOrigins } from '../server/clubAddress';
import { BROWSER_TOOLS_MATCHER, staffSettings } from '../server/staff/launch';

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
