import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// O hook de acesso remoto no terminal (scripts/hooks/remote-guard.mjs) rodado de verdade, e a entrada que o staffSettings põe nele.

// MYCO_HOME de teste: o staffSettings não toca no ~/.myco de quem roda os testes.
await vi.hoisted(async () => {
  const os = await import('node:os');
  const nodePath = await import('node:path');
  process.env.MYCO_HOME = nodePath.join(os.tmpdir(), `myco-remoteguard-home-${process.pid}-${Date.now()}`);
});

const { staffSettings, REMOTE_GUARD_MATCHER } = await import('../server/staff/launch');

const hook = fileURLToPath(new URL('../scripts/hooks/remote-guard.mjs', import.meta.url));

/** Roda o hook com o evento (ou o texto cru); devolve o que ele escreveu ('' = não respondeu). */
const run = (input: unknown) => execFileSync(process.execPath, [hook], { input: typeof input === 'string' ? input : JSON.stringify(input) }).toString();
const decision = (out: string) => (out === '' ? null : JSON.parse(out).hookSpecificOutput.permissionDecision);
const reason = (out: string) => JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string;
const bash = (command: unknown) => ({ tool_name: 'Bash', tool_input: { command }, permission_mode: 'bypassPermissions' });
const ps = (command: unknown) => ({ tool_name: 'PowerShell', tool_input: { command }, permission_mode: 'auto' });

// 'ssh h' em UTF-16LE, em base64 (16 caracteres): o formato que o `-enc` do PowerShell recebe.
const ENC = Buffer.from('ssh h', 'utf16le').toString('base64');

describe('hook de acesso remoto: nega ssh, scp e afins no terminal', () => {
  it.each([
    ['ssh h', bash('ssh h')],
    ['/usr/bin/ssh h', bash('/usr/bin/ssh h')],
    ['C:\\Windows\\System32\\OpenSSH\\ssh.exe h', bash('C:\\Windows\\System32\\OpenSSH\\ssh.exe h')],
    ['bash -c "ssh h ls"', bash('bash -c "ssh h ls"')],
    ['powershell -c "scp a h:/b" (Bash)', bash('powershell -c "scp a h:/b"')],
    ['cmd /c sftp h', bash('cmd /c sftp h')],
    ['env ssh h', bash('env ssh h')],
    ['echo h | xargs ssh', bash('echo h | xargs ssh')],
    ['git -c core.sshCommand=x push', bash('git -c core.sshCommand=x push')],
    ['GIT_SSH_COMMAND=x git push', bash('GIT_SSH_COMMAND=x git push')],
    ['rsync -e ssh a h:b', bash('rsync -e ssh a h:b')],
    ['SSH h (maiúsculo)', bash('SSH h')],
    ['plink.exe h (PowerShell)', ps('plink.exe h')],
    ['pwsh -enc <base64 de ssh h>', bash(`pwsh -enc ${ENC}`)],
    ['pwsh -EncodedCommand <base64> (PowerShell)', ps(`pwsh -EncodedCommand ${ENC}`)],
    ["& 'ssh.exe' h (PowerShell)", ps("& 'ssh.exe' h")],
  ])('%s: deny', (_, ev) => {
    const out = run(ev);
    expect(decision(out)).toBe('deny');
    expect(reason(out)).toMatch(/^\[MyCo\] O Claudio’s Club bloqueia ssh, scp, sftp e rsync no terminal/);
    expect(reason(out)).toContain('mcp__myco-ssh__ssh_*');
    expect(reason(out)).toContain('ferramenta Grep');
  });

  it('comando que não é texto: deny', () => {
    expect(decision(run(bash(42)))).toBe('deny');
    expect(decision(run(bash(null)))).toBe('deny');
    expect(decision(run({ tool_name: 'Bash', tool_input: {} }))).toBe('deny');
  });
});

describe('hook de acesso remoto: deixa passar o resto', () => {
  it.each([
    ['npm test', bash('npm test')],
    ['git push', bash('git push')],
    ['npx vitest run tests/sshMcp.test.ts', bash('npx vitest run tests/sshMcp.test.ts')],
    ['ssh-keygen -l -f x.pub', bash('ssh-keygen -l -f x.pub')],
    ['echo sshd', bash('echo sshd')],
    ['pwsh sem comando codificado', ps('pwsh -NoProfile -Command "Get-ChildItem"')],
  ])('%s: sem saída', (_, ev) => {
    expect(run(ev)).toBe('');
  });

  it('outra ferramenta: não responde', () => {
    expect(run({ tool_name: 'Read', tool_input: { file_path: 'ssh h' } })).toBe('');
    expect(run({ tool_name: 'Edit', tool_input: { command: 'ssh h' } })).toBe('');
  });
});

describe('hook de acesso remoto: fail-closed', () => {
  it('entrada ilegível: deny', () => {
    expect(decision(run('não é json'))).toBe('deny');
  });

  it('entrada sem nome de ferramenta: deny', () => {
    expect(decision(run({}))).toBe('deny');
    expect(decision(run(null))).toBe('deny');
  });
});

describe('a conversa: o hook entra em todo funcionário, com ou sem servidor e sem o hook de navegador', () => {
  it('no PreToolUse, com o matcher de Bash e PowerShell, o node chamado direto e timeout com bloqueio', () => {
    const pre = staffSettings(undefined, undefined, { clubGuard: false }).hooks.PreToolUse;
    expect(REMOTE_GUARD_MATCHER).toBe('Bash|PowerShell');
    expect(pre.find((h) => h.matcher === REMOTE_GUARD_MATCHER)).toMatchObject({
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: process.execPath, args: [hook], timeout: 10, onFailure: 'block' }],
    });
  });

  it('não entra no PostToolUse', () => {
    // Pelo hook, não pelo matcher: a fila de validação pesada (heavy-guard) também solta a trava no PostToolUse de Bash e PowerShell.
    expect(staffSettings().hooks.PostToolUse.some((h) => h.hooks.some((x) => x.args.includes(hook)))).toBe(false);
  });
});
