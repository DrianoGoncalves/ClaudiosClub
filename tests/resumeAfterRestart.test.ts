import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AutoContinue, type Pending } from '../server/chat/autoContinue';
import { ChatClosingError, ChatManager, type ChatManagerOptions } from '../server/chat/manager';
import { bootResume, RESUME_MAX_AGE_MS, ResumeFile, resumeAfterRestart, resumeText, takeResume, type ResumeEntry } from '../server/chat/resume';
import { isInjectedUserText, RESTART_PENDING_TEXT, RESTART_TEXT } from '../server/chat/items';

// Reinício pelo navegador: o que vai para o disco ao sair, o que o boot reabre e o que recusa entrega enquanto fecha.
// Processos falsos (sem `claude` de verdade) e relógio injetado, como em wake.test.ts.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-resume-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const MIN = 60_000;

let n = 0;
const fileIn = () => path.join(root, `resume-${++n}.json`);
const exists = (f: string) => fs.access(f).then(() => true, () => false);
const entry = (over: Partial<ResumeEntry> = {}): ResumeEntry => ({ projectId: 'p', sessionId: 'sx', staffId: 'ana', engine: 'claude', cwd: '.', hadPending: false, ...over });

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  const written: Array<{ type?: string; message?: { content?: Array<{ text?: string }> } }> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, written, emit };
}
const settle = () => new Promise((r) => setTimeout(r, 15));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function manager(extra: Partial<ChatManagerOptions> = {}) {
  const spawns: Array<ReturnType<typeof fakeClaude>> = [];
  const m = new ChatManager({
    transcriptsDir: root,
    usageFile: path.join(root, `usage-${++n}.json`),
    listLive: async () => [],
    resolve: async (_p, sid) => ({ sessionId: sid ?? 'new', cwd: '.', args: [] }),
    spawnImpl: () => {
      const f = fakeClaude();
      spawns.push(f);
      return f.proc as never;
    },
    now: () => NOW,
    log: () => {},
    ...extra,
  });
  return { m, spawns };
}

const texts = (f: ReturnType<typeof fakeClaude>) => f.written.filter((w) => w.type === 'user').map((w) => w.message?.content?.at(-1)?.text);

describe('ChatManager: o que vai para o disco ao reiniciar', () => {
  let ctx: ReturnType<typeof manager>;
  beforeEach(() => {
    ctx = manager();
  });

  it('lista só as conversas em turno: a que trabalha entra, a que terminou o turno não', async () => {
    await ctx.m.send('p', 'sx', 'ana', 'faça X');
    await ctx.m.send('p', 'sy', 'bia', 'faça Y');
    ctx.spawns[1]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    await settle();
    expect(ctx.m.busySessions()).toEqual([entry({ sessionId: 'sx', staffId: 'ana', hadPending: false })]);
  });

  it('com pedido de permissão pendente, a entrada marca hadPending', async () => {
    await ctx.m.send('p', 'sx', 'ana', 'rode o teste');
    ctx.spawns[0]!.emit({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } } });
    await settle();
    expect(ctx.m.busySessions()).toEqual([entry({ sessionId: 'sx', staffId: 'ana', hadPending: true })]);
  });

  it('o pedido grava e o boot lê o mesmo, e apaga o arquivo ao ler', async () => {
    const file = fileIn();
    const rf = new ResumeFile(file);
    expect(await rf.save([entry()], NOW)).toBe(true);
    expect(await takeResume(file, NOW + MIN, () => {})).toEqual([entry()]);
    expect(await exists(file)).toBe(false);
  });
});

describe('Parar nunca agenda retomada', () => {
  it('Parar apaga o pedido, e um save depois dele não grava nada', async () => {
    const file = fileIn();
    const rf = new ResumeFile(file);
    await rf.save([entry()], NOW);
    expect(await exists(file)).toBe(true);
    await rf.stop();
    expect(await exists(file)).toBe(false);
    expect(await rf.save([entry()], NOW)).toBe(false);
    expect(await exists(file)).toBe(false);
  });

  it('Parar durante a gravação de um reinício: o arquivo não sobra', async () => {
    const file = fileIn();
    const rf = new ResumeFile(file);
    const saving = rf.save([entry()], NOW);
    await rf.stop();
    expect(await saving).toBe(false);
    expect(await exists(file)).toBe(false);
  });
});

describe('boot: retomada', () => {
  it('lê e apaga o pedido antes de mandar; cada conversa vai uma vez, com o arquivo já apagado', async () => {
    const file = fileIn();
    await new ResumeFile(file).save([entry({ sessionId: 'sx' }), entry({ sessionId: 'sy', hadPending: true })], NOW);
    const sent: Array<{ id: string; fileThere: boolean }> = [];
    const logs: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW + MIN,
      log: (l) => logs.push(l),
      stopHit: async () => null,
      send: async (e) => void sent.push({ id: e.sessionId, fileThere: await exists(file) }),
    });
    expect(sent).toEqual([
      { id: 'sx', fileThere: false },
      { id: 'sy', fileThere: false },
    ]);
    expect(logs).toEqual(['sx: retomada (claude)', 'sy: retomada (claude, com pedido pendente)']);
  });

  it('sem arquivo, não manda nada', async () => {
    let calls = 0;
    await resumeAfterRestart({ file: fileIn(), now: () => NOW, log: () => {}, stopHit: async () => null, send: async () => void calls++ });
    expect(calls).toBe(0);
  });

  it('arquivo velho, estragado ou sem o formato: não manda, e o arquivo sai', async () => {
    const cases: Array<[string, string]> = [
      ['velho', JSON.stringify({ savedAt: new Date(NOW - RESUME_MAX_AGE_MS - MIN).toISOString(), sessions: [entry()] })],
      ['estragado', '{ não é json'],
      ['sem formato', JSON.stringify({ quem: 'nada' })],
      ['do futuro', JSON.stringify({ savedAt: new Date(NOW + MIN).toISOString(), sessions: [entry()] })],
    ];
    for (const [, body] of cases) {
      const file = fileIn();
      await fs.writeFile(file, body);
      let calls = 0;
      await resumeAfterRestart({ file, now: () => NOW, log: () => {}, stopHit: async () => null, send: async () => void calls++ });
      expect(calls).toBe(0);
      expect(await exists(file)).toBe(false);
    }
  });

  it('entrada estragada não leva as outras', async () => {
    const file = fileIn();
    await fs.writeFile(file, JSON.stringify({ savedAt: new Date(NOW).toISOString(), sessions: [{ sessionId: 'x' }, entry({ sessionId: 'ok' })] }));
    const sent: string[] = [];
    const logs: string[] = [];
    await resumeAfterRestart({ file, now: () => NOW, log: (l) => logs.push(l), stopHit: async () => null, send: async (e) => void sent.push(e.sessionId) });
    expect(sent).toEqual(['ok']);
    expect(logs.some((l) => l.includes('entrada 1 inválida'))).toBe(true);
  });

  it('limite de uso barrado: não envia a conversa barrada, mas segue com as outras', async () => {
    const file = fileIn();
    await new ResumeFile(file).save([entry({ sessionId: 'sx' }), entry({ sessionId: 'sy', engine: 'codex' })], NOW);
    const sent: string[] = [];
    const logs: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW,
      log: (l) => logs.push(l),
      stopHit: async (_p, _s, engine) => (engine === 'claude' ? { resetsAt: '2026-11-11T15:00:00.000Z' } : null),
      send: async (e) => void sent.push(e.sessionId),
    });
    expect(sent).toEqual(['sy']);
    expect(logs[0]).toMatch(/^sx: não retomada: limite de uso \(volta às 2026-11-11T15:00:00/);
  });

  it('não consegue conferir o limite: não envia', async () => {
    const file = fileIn();
    await new ResumeFile(file).save([entry()], NOW);
    let calls = 0;
    const logs: string[] = [];
    await resumeAfterRestart({ file, now: () => NOW, log: (l) => logs.push(l), stopHit: async () => { throw new Error('disco ocupado'); }, send: async () => void calls++ });
    expect(calls).toBe(0);
    expect(logs[0]).toMatch(/não consegui conferir o limite/);
  });

  it('falha de envio: só o log, sem nova tentativa', async () => {
    const file = fileIn();
    await new ResumeFile(file).save([entry()], NOW);
    let calls = 0;
    const logs: string[] = [];
    await resumeAfterRestart({
      file,
      now: () => NOW,
      log: (l) => logs.push(l),
      stopHit: async () => null,
      send: async () => {
        calls++;
        throw new Error('motor não abriu');
      },
    });
    expect(calls).toBe(1);
    expect(logs).toEqual(['sx: não retomada: motor não abriu']);
  });
});

describe('reinício: as pendências do "continue" esperam o boot', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const due = (sid = 'sx'): Pending => ({ projectId: 'p', sessionId: sid, staffId: 'ana', at: Date.now() - 1000, resetsAt: Date.now() - 60_000 });
  const onDisk = async (file: string) => (JSON.parse(await fs.readFile(file, 'utf8')) as { pending: unknown[] }).pending.length;

  it('com a fila parada, a pendência vencida fica no arquivo e não sai; no boot (start) dispara', async () => {
    const file = fileIn();
    const sent: string[] = [];
    const ac = new AutoContinue({
      file,
      enabled: async () => true,
      stopHit: async () => null,
      knownResets: async () => [],
      send: async (p) => void sent.push(p.sessionId),
      tickMs: 5,
      log: () => {},
    });
    await ac.schedule(due());
    ac.start();
    ac.stop();
    await wait(40);
    expect(sent).toEqual([]);
    expect(await onDisk(file)).toBe(1);
    ac.start(); // o boot
    await wait(60);
    ac.stop();
    expect(sent).toEqual(['sx']);
    expect(await onDisk(file)).toBe(0);
  });

  it('um envio já conferido, mas ainda não mandado, não sai depois de parar', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const ac = new AutoContinue({
      file: fileIn(),
      enabled: async () => true,
      stopHit: async () => {
        await gate; // o limite é conferido devagar: o reinício começa agora
        return null;
      },
      knownResets: async () => [],
      send: async (p) => void sent.push(p.sessionId),
      log: () => {},
    });
    await ac.schedule(due());
    const running = ac.tick();
    ac.stop();
    release();
    await running;
    expect(sent).toEqual([]);
    expect(await ac.list()).toHaveLength(1);
  });
});

describe('boot: os temporizadores esperam a retomada', () => {
  it('o "continue", o despertador e a fila só ligam depois que a retomada terminou', async () => {
    const file = fileIn();
    await new ResumeFile(file).save([entry()], NOW);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sendDone = false;
    const order: string[] = [];
    const boot = bootResume(
      {
        file,
        now: () => NOW,
        log: () => {},
        stopHit: async () => null,
        send: async () => {
          await gate; // a conversa ainda está abrindo
          sendDone = true;
        },
      },
      () => order.push(sendDone ? 'temporizadores depois da retomada' : 'temporizadores ANTES da retomada'),
    );
    await wait(20);
    expect(order).toEqual([]);
    release();
    await boot;
    expect(order).toEqual(['temporizadores depois da retomada']);
  });
});

describe('ChatManager: retomada e entrega recusada', () => {
  it('a retomada manda o texto normal, ou o de pedido pendente, e a conversa reabre com a ficha', async () => {
    const ctx = manager();
    expect(resumeText(false)).toBe(RESTART_TEXT);
    expect(resumeText(true)).toBe(RESTART_PENDING_TEXT);
    await ctx.m.resumeChat(entry({ sessionId: 'sx' }));
    await settle();
    expect(texts(ctx.spawns[0]!).at(-1)).toBe(RESTART_TEXT);
    await ctx.m.resumeChat(entry({ sessionId: 'sy', hadPending: true }));
    await settle();
    expect(texts(ctx.spawns[1]!).at(-1)).toBe(RESTART_PENDING_TEXT);
  });

  it('a retomada não dispara onSent ("você respondeu" da tarefa em revisão); a sua mensagem dispara', async () => {
    const sentTo: string[] = [];
    const ctx = manager({ onSent: (sid) => void sentTo.push(sid) });
    await ctx.m.resumeChat(entry({ sessionId: 'sx' }));
    await settle();
    expect(sentTo).toEqual([]);
    await ctx.m.send('p', 'sx', 'ana', 'oi');
    expect(sentTo).toEqual(['sx']);
  });

  it('o texto da retomada é do Claudio’s Club, não do dono (fica fora da conversa e do handoff)', () => {
    expect(isInjectedUserText(RESTART_TEXT)).toBe(true);
    expect(isInjectedUserText(RESTART_PENDING_TEXT)).toBe(true);
  });

  it('reiniciando: toda entrega nova é recusada, sem abrir processo', async () => {
    const ctx = manager();
    ctx.m.closing();
    expect(ctx.m.isClosing()).toBe(true);
    await expect(ctx.m.send('p', 'sx', 'ana', 'oi')).rejects.toThrow(ChatClosingError);
    await expect(ctx.m.send('p', null, 'ana', 'oi')).rejects.toThrow(/reiniciando/);
    await expect(ctx.m.continueChat('p', 'sx', 'ana')).rejects.toThrow(ChatClosingError);
    await expect(ctx.m.sendFromUser('p', 'sx', 'ana', 'oi')).rejects.toThrow(ChatClosingError);
    await expect(ctx.m.sendToRequester('p', 'sx', 'ana', 'aviso')).rejects.toThrow(ChatClosingError);
    expect(ctx.spawns).toEqual([]);
  });
});
