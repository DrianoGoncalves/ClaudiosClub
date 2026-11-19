import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../shared/model';
import { accountHooksFile, buildCodexArgs, type CodexHeavyGuard } from '../server/chat/codexArgs';
import { CodexProcess } from '../server/chat/codexProcess';

// Auditoria t-3bea79 (Codex 0.169.0): a flag --dangerously-bypass-hook-trust, que o Club passa para o hook da fila de validação pesada, também
// libera o $CODEX_HOME/hooks.json da conta (fora da sandbox, sem confirmação, com o MYCO_TOKEN da conversa). Regra: com hooks.json na conta,
// a execução sai sem a flag e sem o hook, e o Club avisa. Estes testes travam a regra; o comportamento do Codex em si fica em
// tests/codexHooksE2e.test.ts (opcional, MYCO_CODEX_E2E=1).

const guard: CodexHeavyGuard = { hook: 'C:\\Users\\x\\.myco\\run\\c1\\hooks\\heavy-guard.mjs', lockDir: 'C:\\Users\\x\\.myco\\run\\heavy', ownerPid: 4242 };
const secrets = { projectPath: '/proj', home: '/nao-existe', mycoHome: '/nao-existe/.myco' };
const base = { cwd: '/proj', sandbox: 'workspace' as const, network: 'loopback' as const, secrets, platform: 'linux' as const };
const configs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
const hooksOf = (args: string[]) => configs(args).filter((c) => c.startsWith('hooks.'));

let root: string;
let n = 0;
/** Uma pasta de dados do Codex só deste teste (CODEX_HOME). */
const codexHome = async () => {
  const dir = path.join(root, `home-${n++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-hooks-trust-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('accountHooksFile: o hooks.json da conta do Codex', () => {
  it('não existe → null; existe (arquivo, vazio, pasta) → o caminho', async () => {
    const dir = await codexHome();
    expect(accountHooksFile('/proj', { CODEX_HOME: dir })).toBeNull();
    await fs.writeFile(path.join(dir, 'hooks.json'), '');
    expect(accountHooksFile('/proj', { CODEX_HOME: dir })).toBe(path.join(dir, 'hooks.json'));
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    expect(accountHooksFile('/proj', { CODEX_HOME: dir })).toBe(path.join(dir, 'hooks.json')); // sem hook dentro também conta: não se lê o conteúdo
    const other = await codexHome();
    await fs.mkdir(path.join(other, 'hooks.json'));
    expect(accountHooksFile('/proj', { CODEX_HOME: other })).toBe(path.join(other, 'hooks.json'));
  });

  it('sem CODEX_HOME (ou vazio) vale ~/.codex; relativo vale a partir da pasta onde o codex roda', async () => {
    const home = await codexHome();
    await fs.mkdir(path.join(home, '.codex'));
    expect(accountHooksFile('/proj', {}, home)).toBeNull();
    await fs.writeFile(path.join(home, '.codex', 'hooks.json'), '{}');
    expect(accountHooksFile('/proj', {}, home)).toBe(path.join(home, '.codex', 'hooks.json'));
    expect(accountHooksFile('/proj', { CODEX_HOME: '' }, home)).toBe(path.join(home, '.codex', 'hooks.json'));
    // CODEX_HOME aponta para outra pasta: o ~/.codex não conta.
    const elsewhere = await codexHome();
    expect(accountHooksFile('/proj', { CODEX_HOME: elsewhere }, home)).toBeNull();
    // Relativo: resolvido contra o cwd do codex.
    await fs.mkdir(path.join(elsewhere, 'rel'));
    await fs.writeFile(path.join(elsewhere, 'rel', 'hooks.json'), '{}');
    expect(accountHooksFile(elsewhere, { CODEX_HOME: 'rel' }, '/nao-existe')).toBe(path.join(elsewhere, 'rel', 'hooks.json'));
  });

  it('CODEX_HOME que é um arquivo (ENOTDIR) não tem hooks.json; erro que não seja "não existe" conta como existente (falha fechada)', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'um-arquivo');
    await fs.writeFile(file, 'x');
    expect(accountHooksFile('/proj', { CODEX_HOME: file })).toBeNull();
    // Caminho que o stat recusa (NUL): não dá para provar que não há hooks.json.
    expect(accountHooksFile('/proj', { CODEX_HOME: 'a\0b' })).not.toBeNull();
  });

  it('o hooks.json do projeto (<projeto>/.codex/) não conta: ele não roda com --ignore-user-config (provado na auditoria)', async () => {
    const dir = await codexHome();
    const repo = path.join(dir, 'repo');
    await fs.mkdir(path.join(repo, '.codex'), { recursive: true });
    await fs.writeFile(path.join(repo, '.codex', 'hooks.json'), '{}');
    expect(accountHooksFile(repo, { CODEX_HOME: path.join(dir, 'vazio') })).toBeNull();
  });
});

describe('buildCodexArgs: a flag de confiança e o hook da fila só saem sem hooks.json na conta', () => {
  it('sem hooks.json: a flag e os hooks Pre e Post (como antes); ninguém é avisado', async () => {
    const env = { CODEX_HOME: await codexHome() };
    for (const threadId of [null, 'thr-1']) {
      const off = vi.fn();
      const args = buildCodexArgs({ ...base, threadId, heavyGuard: guard, env, onHeavyGuardOff: off });
      expect(args).toContain('--dangerously-bypass-hook-trust');
      expect(hooksOf(args).map((c) => c.split('=')[0])).toEqual(['hooks.PreToolUse', 'hooks.PostToolUse']);
      expect(off).not.toHaveBeenCalled();
    }
  });

  it('com hooks.json: sem a flag e sem o hook, na primeira execução e no resume, e avisa com o caminho do arquivo; o resto segue igual', async () => {
    const dir = await codexHome();
    await fs.writeFile(path.join(dir, 'hooks.json'), '{"hooks":{"PreToolUse":[]}}');
    for (const threadId of [null, 'thr-1']) {
      const off = vi.fn();
      const args = buildCodexArgs({ ...base, threadId, heavyGuard: guard, env: { CODEX_HOME: dir }, onHeavyGuardOff: off });
      expect(args.join(' ')).not.toMatch(/dangerously/);
      expect(hooksOf(args)).toEqual([]);
      expect(off).toHaveBeenCalledExactlyOnceWith(path.join(dir, 'hooks.json'));
      // Segurança e estrutura intactas: só a fila saiu.
      expect(args).toContain('--ignore-user-config');
      expect(configs(args)).toContain('default_permissions="mycodeny"');
      expect(args.at(-1)).toBe('-');
      expect(args.includes('resume')).toBe(threadId !== null);
    }
  });

  it('é conferido a cada execução: o arquivo surge no meio da conversa e depois some', async () => {
    const dir = await codexHome();
    const env = { CODEX_HOME: dir };
    const run = () => buildCodexArgs({ ...base, heavyGuard: guard, env });
    expect(run()).toContain('--dangerously-bypass-hook-trust');
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    expect(run()).not.toContain('--dangerously-bypass-hook-trust');
    await fs.rm(path.join(dir, 'hooks.json'));
    expect(run()).toContain('--dangerously-bypass-hook-trust');
  });

  it('sem a fila na conversa, hooks.json não muda nada nem avisa (não há o que tirar)', async () => {
    const dir = await codexHome();
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    const off = vi.fn();
    for (const heavyGuard of [null, undefined]) {
      const args = buildCodexArgs({ ...base, heavyGuard, env: { CODEX_HOME: dir }, onHeavyGuardOff: off });
      expect(args.join(' ')).not.toMatch(/dangerously|hooks\./);
    }
    expect(off).not.toHaveBeenCalled();
  });

  it('sem `env`, vale o ambiente do servidor (CODEX_HOME)', async () => {
    const dir = await codexHome();
    await fs.writeFile(path.join(dir, 'hooks.json'), '{}');
    vi.stubEnv('CODEX_HOME', dir);
    expect(buildCodexArgs({ ...base, heavyGuard: guard })).not.toContain('--dangerously-bypass-hook-trust');
  });
});

describe('CodexProcess: conta com hooks.json roda sem a fila e avisa', () => {
  const profile = { cwd: '/proj', sessionId: 'sess-h', permissionMode: 'default', secrets, heavyGuard: guard };

  /** Cada `spawn` devolve um processo falso (uma execução): `finish` termina o turno e fecha. */
  function fake() {
    const runs: Array<{ args: string[]; env: NodeJS.ProcessEnv; finish: () => void }> = [];
    const spawnImpl = (_cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout, stderr: new PassThrough(), pid: 5000 + runs.length });
      runs.push({
        args,
        env: opts.env,
        finish: () => {
          stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n');
          child.emit('close', 0);
        },
      });
      return child as never;
    };
    return { runs, spawnImpl, last: () => runs[runs.length - 1]! };
  }
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const warns = (chat: CodexProcess) =>
    chat.snapshot().items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice' && i.tone === 'warn' && /hooks\.json/.test(i.text));

  it('com hooks.json: nenhuma execução leva a flag nem o hook; um aviso só, mesmo com várias mensagens', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'hooks.json');
    await fs.writeFile(file, '{}');
    vi.stubEnv('CODEX_HOME', dir);
    const f = fake();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    for (const text of ['um', 'dois']) {
      chat.send(text);
      expect(f.last().args.join(' ')).not.toMatch(/dangerously|hooks\./);
      f.last().finish();
      await tick();
    }
    expect(f.runs).toHaveLength(2);
    expect(warns(chat)).toHaveLength(1);
    expect(warns(chat)[0]!.text).toContain(file);
    expect(warns(chat)[0]!.text).toMatch(/fila de validação pesada/);
  });

  it('sem hooks.json: a flag e o hook como antes e nenhum aviso; o ambiente do codex leva o mesmo CODEX_HOME que foi conferido', async () => {
    const dir = await codexHome();
    vi.stubEnv('CODEX_HOME', dir);
    const f = fake();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    chat.send('oi');
    expect(f.last().args).toContain('--dangerously-bypass-hook-trust');
    expect(f.last().args.some((a) => a.startsWith('hooks.PreToolUse='))).toBe(true);
    expect(f.last().env.CODEX_HOME).toBe(dir);
    expect(warns(chat)).toHaveLength(0);
  });

  it('o arquivo surge no meio da conversa (avisa e tira a fila), some (a fila volta) e surge de novo (avisa de novo)', async () => {
    const dir = await codexHome();
    const file = path.join(dir, 'hooks.json');
    vi.stubEnv('CODEX_HOME', dir);
    const f = fake();
    const chat = new CodexProcess({ ...profile, spawnImpl: f.spawnImpl });
    chat.start();
    const send = async (text: string) => {
      chat.send(text);
      const args = f.last().args;
      f.last().finish();
      await tick();
      return args.includes('--dangerously-bypass-hook-trust');
    };
    expect(await send('1')).toBe(true);
    expect(warns(chat)).toHaveLength(0);
    await fs.writeFile(file, '{}');
    expect(await send('2')).toBe(false);
    expect(warns(chat)).toHaveLength(1);
    expect(await send('3')).toBe(false);
    expect(warns(chat)).toHaveLength(1);
    await fs.rm(file);
    expect(await send('4')).toBe(true);
    await fs.writeFile(file, '{}');
    expect(await send('5')).toBe(false);
    expect(warns(chat)).toHaveLength(2);
  });
});
