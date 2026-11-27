import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatProcess } from '../server/chat/process';
import { bootResume } from '../server/chat/resume';
import {
  ScopeSupport,
  chatUnit,
  conversationCommand,
  homeTag,
  listChatScopes,
  parseChatUnit,
  probeScope,
  reapChatScopes,
  scopeCommand,
  splitScopeMarker,
  systemdRunArgs,
  type RunResult,
  type ScopeRunner,
} from '../server/scopeCommand';
import { removeTemp } from './support/tmp';

// Cada conversa no seu escopo do systemd: o oomd mata a mais pesada, não o Claudio’s Club inteiro (27/11/2026: 234 processos de uma vez, vigia e servidor juntos).

const TAG = 'abc123';

describe('comando embrulhado no escopo', () => {
  it('Linux: systemd-run --user --scope em app.slice, com o comando depois do --; fora dele, o comando como veio', () => {
    expect(scopeCommand('claude', ['-p'], { unit: 'app-claudios-chat-x', description: 'd' }, { platform: 'linux' })).toEqual({
      cmd: 'systemd-run',
      args: ['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', '--unit=app-claudios-chat-x', '--description=d', '--', 'claude', '-p'],
    });
    for (const platform of ['win32', 'darwin'] as const) {
      expect(scopeCommand('claude', ['-p'], { unit: 'u', description: 'd' }, { platform })).toEqual({ cmd: 'claude', args: ['-p'] });
    }
    expect(scopeCommand('claude', [], { unit: 'u', description: 'd' }, { platform: 'linux', enabled: false })).toEqual({ cmd: 'claude', args: [] });
  });

  it('o vigia sai da lista do oomd (omit) e o servidor fica por último (avoid); OOMPolicy=continue impede o systemd de parar o escopo quando o kernel mata um processo', () => {
    expect(systemdRunArgs({ unit: 'u', description: 'd', oom: 'omit', keepOnOom: true })).toEqual(
      expect.arrayContaining(['--property=ManagedOOMPreference=omit', '--property=OOMPolicy=continue']),
    );
    expect(systemdRunArgs({ unit: 'u', description: 'd', oom: 'avoid' })).toContain('--property=ManagedOOMPreference=avoid');
    expect(systemdRunArgs({ unit: 'u', description: 'd' }).join(' ')).not.toMatch(/ManagedOOM|OOMPolicy/);
  });

  it('a conversa não usa --quiet: a linha "Running as unit" é o sinal de que o escopo nasceu', () => {
    const c = conversationCommand('claude', ['--resume', 's1'], 'e231d043-7934-417f-bf65-306123b88037', 1_000_000, TAG);
    expect(c.cmd).toBe('systemd-run');
    expect(c.args).not.toContain('--quiet');
    expect(c.args.slice(c.args.indexOf('--') + 1)).toEqual(['claude', '--resume', 's1']);
    expect(c.unit).toBe(`app-claudios-chat-${TAG}-${(1_000_000).toString(36)}-e231d043`);
    expect(c.args).toContain(`--unit=${c.unit}`);
  });
});

describe('nome da unidade da conversa', () => {
  it('leva a casa, a hora do lançamento e o começo da sessão; dá para desmontar; nome de outro tipo não é conversa', () => {
    const unit = chatUnit(TAG, 'ca930b85-dadc-4d4d-a2e1-5e9f58b75cef', 1_795_790_000_000);
    expect(parseChatUnit(`${unit}.scope`)).toEqual({ tag: TAG, stamp: 1_795_790_000_000, session: 'ca930b85' });
    expect(parseChatUnit('app-claudios-1795783180466.scope')).toBeNull();
    expect(parseChatUnit('app-claudios-server-1795783180466.scope')).toBeNull();
    expect(parseChatUnit('app-firefox-123.scope')).toBeNull();
  });

  it('duas instâncias do Club (a real e uma cópia de teste) têm etiquetas diferentes; a mesma pasta dá sempre a mesma', () => {
    expect(homeTag('/home/u/.myco')).toBe(homeTag('/home/u/.myco/'));
    expect(homeTag('/home/u/.myco')).not.toBe(homeTag('/tmp/myco-teste'));
    expect(homeTag('/home/u/.myco')).toMatch(/^[0-9a-f]{6}$/);
  });
});

describe('linha do systemd-run', () => {
  it('as duas escritas (versão nova e antiga) são o sinal, e a linha sai do stderr da conversa', () => {
    expect(splitScopeMarker('Running as unit: app-claudios-chat-x.scope; invocation ID: 90de87df\n')).toEqual({ marker: true, text: '' });
    expect(splitScopeMarker('Running scope as unit: app-claudios-chat-x.scope\nerro do claude\n')).toEqual({ marker: true, text: 'erro do claude\n' });
    expect(splitScopeMarker('Failed to start transient scope unit: Connection timed out\n')).toEqual({ marker: false, text: 'Failed to start transient scope unit: Connection timed out\n' });
  });
});

describe('ScopeSupport (a sonda de 5 min)', () => {
  it('desligado por padrão: sem a variável do vigia nunca é usável nem sonda', async () => {
    const probe = vi.fn(async () => true);
    const s = new ScopeSupport({ enabled: false, probe });
    s.start();
    await s.refresh();
    expect(s.usable).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('só é usável depois de uma sonda bem-sucedida; falha de lançamento desliga até a próxima sonda; uma sonda por vez', async () => {
    let answer = true;
    let release: () => void = () => {};
    const probe = vi.fn(() => (answer ? new Promise<boolean>((r) => (release = () => r(true))) : Promise.resolve(false)));
    const log: string[] = [];
    const s = new ScopeSupport({ enabled: true, probe, log: (l) => log.push(l) });
    expect(s.usable).toBe(false);
    const first = s.refresh();
    void s.refresh(); // sobreposta: ignorada
    expect(probe).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(s.usable).toBe(true);
    s.fail('Failed to connect to bus');
    expect(s.usable).toBe(false);
    expect(log.some((l) => l.includes('Failed to connect to bus'))).toBe(true);
    const next = s.refresh();
    release();
    await next;
    expect(s.usable).toBe(true);
    answer = false;
    await s.refresh();
    expect(s.usable).toBe(false);
  });

  it('a sonda cria um escopo descartável e roda `true` nele; só o código 0 vale', async () => {
    const seen: string[][] = [];
    const ok: ScopeRunner = async (_c, a) => (seen.push(a), { code: 0, stdout: '' });
    expect(await probeScope(ok)).toBe(true);
    expect(seen[0]!.slice(-2)).toEqual(['--', 'true']);
    expect(await probeScope(async () => ({ code: 1, stdout: '' }))).toBe(false);
    expect(await probeScope(async () => ({ code: null, stdout: '' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (a) Servidor morto + conversa viva: a sobra é encerrada ANTES da retomada.
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** O gerenciador do usuário de mentira: `scopes` são as unidades vivas; `kill` as tira (SIGTERM, ou só o SIGKILL no `stubborn`). */
function fakeSystemd(initial: string[], stubborn: string[] = []) {
  const alive = new Set(initial);
  const calls: string[] = [];
  const run: ScopeRunner = async (cmd, args): Promise<RunResult> => {
    expect(cmd).toBe('systemctl');
    if (args[1] === 'list-units') {
      const pattern = new RegExp('^' + String(args[args.length - 1]).replace(/\*/g, '.*') + '$');
      calls.push('list');
      return { code: 0, stdout: [...alive].filter((u) => pattern.test(u)).map((u) => `${u} loaded active running Claudio's Club: conversa`).join('\n') };
    }
    const signal = String(args[2]).replace('--signal=', '');
    const units = args.slice(3);
    calls.push(`${signal} ${units.join(',')}`);
    for (const u of units) if (signal === 'SIGKILL' || !stubborn.includes(u)) alive.delete(u);
    return { code: 0, stdout: '' };
  };
  return { run, alive, calls };
}

describe('conversa que sobrou de um servidor que morreu (o escopo do servidor foi morto, o das conversas não)', () => {
  const START = 1_795_790_000_000;
  const old1 = `${chatUnit(TAG, 'aaaaaaaa-1', START - 60_000)}.scope`;
  const old2 = `${chatUnit(TAG, 'bbbbbbbb-2', START - 30_000)}.scope`;
  const fresh = `${chatUnit(TAG, 'cccccccc-3', START + 1_000)}.scope`;
  const foreign = `${chatUnit('ffffff', 'dddddddd-4', START - 60_000)}.scope`;

  it('lista só as conversas desta casa', async () => {
    const sd = fakeSystemd([old1, foreign, 'app-claudios-1795783180466.scope']);
    expect(await listChatScopes(TAG, sd.run)).toEqual([old1]);
  });

  it('encerra as de antes do servidor que subiu, deixa a que ele mesmo abriu e a de outra instância', async () => {
    const sd = fakeSystemd([old1, old2, fresh, foreign]);
    const reaped = await reapChatScopes({ tag: TAG, olderThan: START, run: sd.run, sleep: async () => {} });
    expect(reaped.sort()).toEqual([old1, old2].sort());
    expect([...sd.alive].sort()).toEqual([fresh, foreign].sort());
    expect(sd.calls.some((c) => c.startsWith('SIGTERM') && c.includes(old1) && c.includes(old2))).toBe(true);
    expect(sd.calls.some((c) => c.includes('SIGKILL'))).toBe(false);
  });

  it('o que ignora o SIGTERM sai com SIGKILL depois do prazo', async () => {
    const sd = fakeSystemd([old1, old2], [old2]);
    const log: string[] = [];
    await reapChatScopes({ tag: TAG, olderThan: START, graceMs: 500, run: sd.run, sleep: async () => {}, log: (l) => log.push(l) });
    expect(sd.alive.size).toBe(0);
    expect(sd.calls).toContain(`SIGKILL ${old2}`);
    expect(log.join('\n')).toContain('SIGKILL');
  });

  it('sem systemctl ou sem gerenciador do usuário: nada a encerrar, e nunca lança', async () => {
    expect(await reapChatScopes({ tag: TAG, run: async () => ({ code: null, stdout: '' }) })).toEqual([]);
    expect(await reapChatScopes({ tag: TAG, run: async () => Promise.reject(new Error('boom')), log: () => {} })).toEqual([]);
  });

  it('no boot: a sobra é encerrada ANTES de a retomada abrir qualquer conversa (senão dois claude no mesmo jsonl)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-conv-scope-'));
    try {
      const file = path.join(dir, 'resume.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          savedAt: new Date(START).toISOString(),
          sessions: [{ projectId: 'p', sessionId: 'aaaaaaaa-1', staffId: null, engine: 'claude', cwd: '/x', hadPending: false }],
        }),
      );
      const sd = fakeSystemd([old1]);
      const events: string[] = [];
      const run: ScopeRunner = async (c, a, t) => {
        const r = await sd.run(c, a, t);
        if (a[1] === 'kill') events.push(`mata:${a.slice(3).join(',')}`);
        return r;
      };
      let timers = false;
      await bootResume(
        {
          file,
          now: () => START,
          log: () => {},
          beforeResume: () => reapChatScopes({ tag: TAG, olderThan: START, run, sleep: async () => {} }),
          stopHit: async () => null,
          send: async (e) => void events.push(`retoma:${e.sessionId}`),
        },
        () => {
          timers = true;
          events.push('timers');
        },
      );
      expect(events).toEqual([`mata:${old1}`, 'retoma:aaaaaaaa-1', 'timers']);
      expect(sd.alive.size).toBe(0);
      expect(timers).toBe(true);
    } finally {
      await removeTemp(dir);
    }
  });

  it('se encerrar a sobra falhar, a retomada segue (o erro vai ao log)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-conv-scope-'));
    try {
      const file = path.join(dir, 'resume.json');
      await fs.writeFile(file, JSON.stringify({ savedAt: new Date(START).toISOString(), sessions: [{ projectId: 'p', sessionId: 's', staffId: null, engine: 'claude', cwd: '/x', hadPending: false }] }));
      const sent: string[] = [];
      const log: string[] = [];
      await bootResume({ file, now: () => START, log: (l) => log.push(l), beforeResume: () => Promise.reject(new Error('sem bus')), stopHit: async () => null, send: async (e) => void sent.push(e.sessionId) }, () => {});
      expect(sent).toEqual(['s']);
      expect(log.join('\n')).toContain('sem bus');
    } finally {
      await removeTemp(dir);
    }
  });

  it('Parar, reiniciar e daily stop também encerram os escopos (fiação)', async () => {
    const root = path.join(__dirname, '..');
    const index = await fs.readFile(path.join(root, 'server', 'index.ts'), 'utf8');
    // A retomada espera a limpeza; só encerra os de antes do servidor que subiu.
    expect(index).toMatch(/bootResume\(\{[^}]*beforeResume: \(\) => reapChatScopes\(\{ olderThan: Date\.parse\(STARTED_AT\)/);
    // Parar, reiniciar e o sinal de término passam por closeAll, que encerra o que o fechamento normal não alcançou (só quem ficou com a porta).
    const closeAll = index.slice(index.indexOf('async function closeAll()'), index.indexOf('let leaving = false;'));
    expect(closeAll).toContain('chats.stopAll()');
    expect(closeAll).toContain('if (listening) await reapChatScopes(');
    expect(index.match(/closeAll\(\)/g)!.length).toBeGreaterThanOrEqual(3);
    expect(index).not.toMatch(/Promise\.race\(\[Promise\.all\(\[chats\.stopAll\(\)/);
    const daily = await fs.readFile(path.join(root, 'scripts', 'daily.ts'), 'utf8');
    const sw = daily.slice(daily.indexOf("case 'stop':"), daily.indexOf("case 'status':"));
    expect(sw).toContain('reapLeftoverChats()');
    // Só com o vigia de fato parado: "não deu para confirmar" não encerra conversa de quem pode estar vivo.
    expect(sw).toContain('!runningDaemon()');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// (b) O systemd-run falha ao abrir a conversa: abre de novo na hora, sem escopo.
// ---------------------------------------------------------------------------------------------------------------------------------------------

function fakeChild(pid: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (d: Buffer) => written.push(...d.toString().split('\n').filter(Boolean)));
  const proc = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill: (_signal?: string) => {
      proc.emit('exit', null, 'SIGKILL');
      proc.emit('close', null, 'SIGKILL');
      return true;
    },
  });
  /** O processo saiu: `exit` e, quando os canais fecham, `close` (o stderr já entregue). */
  const exit = (code: number | null) => {
    proc.emit('exit', code, null);
    proc.emit('close', code, null);
  };
  return { proc, written, exit };
}

function launcher(children: Array<ReturnType<typeof fakeChild>>) {
  const spawned: Array<{ cmd: string; args: string[] }> = [];
  const spawnImpl = (cmd: string, args: string[]) => {
    spawned.push({ cmd, args });
    return children[spawned.length - 1]!.proc as never;
  };
  const fails: string[] = [];
  const scopes = { usable: true, fail: (r: string) => void fails.push(r) };
  const relaunched: Array<number | null> = [];
  const make = () => new ChatProcess({ sessionId: 'e231d043-7934', cwd: '.', args: ['--resume', 's1'], spawnImpl, scopes, onRelaunch: (pid) => relaunched.push(pid) });
  return { spawned, fails, relaunched, make };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('conversa que não pode deixar de abrir por causa do escopo', () => {
  afterEach(() => vi.useRealTimers());

  it('com escopo usável, o spawn é o systemd-run e o claude vai depois do --', () => {
    const a = fakeChild(10);
    const l = launcher([a]);
    l.make().start();
    expect(l.spawned).toHaveLength(1);
    expect(l.spawned[0]!.cmd).toBe('systemd-run');
    expect(l.spawned[0]!.args[l.spawned[0]!.args.indexOf('--') + 1]).toBe('claude');
  });

  it('systemd-run ausente (ENOENT): abre sem escopo na hora, avisa a sonda e o registro de órfãos, e refaz a mensagem que ficou sem o claude', async () => {
    const a = fakeChild(10);
    const b = fakeChild(11);
    const l = launcher([a, b]);
    const chat = l.make();
    chat.start();
    chat.send('Olá');
    a.proc.emit('error', Object.assign(new Error('spawn systemd-run ENOENT'), { code: 'ENOENT' }));
    await tick();
    expect(l.spawned.map((s) => s.cmd)).toEqual(['systemd-run', 'claude']);
    expect(l.fails[0]).toContain('ENOENT');
    expect(l.relaunched).toEqual([11]);
    expect(chat.pid).toBe(11);
    expect(chat.snapshot().state.running).toBe(true);
    expect(chat.snapshot().state.error).toBeNull();
    expect(b.written).toHaveLength(1);
    expect(JSON.parse(b.written[0]!).message.content[0].text).toBe('Olá');
  });

  it('o systemd-run sai antes do claude ("Failed to …", código 1): a conversa abre sem escopo, sem erro, e o erro do systemd não vira o da conversa', async () => {
    const a = fakeChild(20);
    const b = fakeChild(21);
    const l = launcher([a, b]);
    const chat = l.make();
    chat.start();
    chat.send('Oi');
    a.proc.stderr.write('Failed to start transient scope unit: Connection timed out\n');
    await tick();
    a.exit(1);
    await tick();
    expect(l.spawned.map((s) => s.cmd)).toEqual(['systemd-run', 'claude']);
    expect(l.fails[0]).toContain('Failed to start transient scope unit');
    expect(chat.snapshot().state.running).toBe(true);
    expect(chat.snapshot().state.error).toBeNull();
    expect(b.written).toHaveLength(1);
    // O novo claude vive e sai como qualquer outro: a saída dele é tratada normalmente.
    b.exit(0);
    await tick();
    expect(chat.snapshot().state.running).toBe(false);
  });

  it('escopo criado (a linha "Running as unit" chega): nada de abrir de novo; a linha não entra no stderr da conversa; o fim do claude é o fim da conversa', async () => {
    const a = fakeChild(30);
    const l = launcher([a]);
    const chat = l.make();
    chat.start();
    chat.send('Oi');
    a.proc.stderr.write("Running as unit: app-claudios-chat-abc123-x-e231d043.scope; invocation ID: 1\nerro de verdade do claude\n");
    await tick();
    a.exit(2);
    await tick();
    expect(l.spawned).toHaveLength(1);
    expect(l.fails).toEqual([]);
    const state = chat.snapshot().state;
    expect(state.running).toBe(false);
    expect(state.error).toBe('erro de verdade do claude');
  });

  it('a primeira saída do claude também confirma o escopo', async () => {
    const a = fakeChild(40);
    const l = launcher([a]);
    const chat = l.make();
    chat.start();
    a.proc.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' }) + '\n');
    await tick();
    a.exit(0);
    await tick();
    expect(l.spawned).toHaveLength(1);
    expect(chat.snapshot().state.running).toBe(false);
  });

  it('o systemd-run que não responde em 10 s é encerrado e a conversa abre sem escopo', async () => {
    vi.useFakeTimers();
    const a = fakeChild(50);
    const b = fakeChild(51);
    const l = launcher([a, b]);
    const chat = l.make();
    chat.start();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(l.spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(l.spawned.map((s) => s.cmd)).toEqual(['systemd-run', 'claude']);
    expect(chat.pid).toBe(51);
    expect(chat.snapshot().state.running).toBe(true);
  });

  it('sem escopo usável (ou sem a opção, como nos outros testes), o spawn é o claude puro', () => {
    const a = fakeChild(60);
    const spawned: string[] = [];
    const chat = new ChatProcess({
      sessionId: 's',
      cwd: '.',
      args: [],
      spawnImpl: (cmd) => (spawned.push(cmd), a.proc as never),
      scopes: { usable: false, fail: () => {} },
    });
    chat.start();
    const b = fakeChild(61);
    const plain = new ChatProcess({ sessionId: 's2', cwd: '.', args: [], spawnImpl: (cmd) => (spawned.push(cmd), b.proc as never) });
    plain.start();
    expect(spawned).toEqual(['claude', 'claude']);
  });
});
