import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatItem } from '../shared/model';
import { AutoContinue, type AutoContinueEvent, type AutoContinueOptions, type Pending } from '../server/chat/autoContinue';
import { ChatManager } from '../server/chat/manager';
import { ChatProcess } from '../server/chat/process';
import { sandboxVerdict, staffMayPost } from '../server/apiPolicy';
import { SLACK_MS } from '../server/chat/usageLimit';
import { WAKE_MAX_SECONDS, WAKE_MAX_STREAK, WAKE_MIN_SECONDS, WAKE_TEXT_MAX, WakeBody, WakeStreakError, wakeNotice, watchWakeups } from '../server/chat/wake';
import { clockHM, secondsLeft } from '../client/src/chat/wakeCountdown';
import dicts from '../client/src/i18n/chat';

// Despertador: o funcionário pede "me chame de novo nesta conversa daqui a N segundos com esta mensagem". Mesmo
// agendador do "continue" do limite de uso, numa segunda instância com arquivo próprio. Relógio injetado em tudo.

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-wake-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-02T10:30:00');
const HOUR = 3_600_000;

describe('pedido do despertador (WakeBody)', () => {
  const ok = (seconds: unknown, text: unknown = 'confira o deploy') => WakeBody.safeParse({ seconds, text });
  const message = (r: ReturnType<typeof ok>) => (r.success ? null : r.error.issues[0]!.message);

  it('seconds é inteiro de 10 a 86400', () => {
    expect(ok(WAKE_MIN_SECONDS).success).toBe(true);
    expect(ok(90).success).toBe(true);
    expect(ok(WAKE_MAX_SECONDS).success).toBe(true);
    expect(message(ok(9))).toMatch(/mínimo 10/);
    expect(message(ok(0))).toMatch(/mínimo 10/);
    expect(message(ok(-30))).toMatch(/mínimo 10/);
    expect(message(ok(WAKE_MAX_SECONDS + 1))).toMatch(/máximo 86400/);
    expect(message(ok(12.5))).toMatch(/inteiro/);
    expect(message(ok('90'))).toMatch(/inteiro/);
    expect(message(ok(Number.NaN))).toMatch(/inteiro/);
    expect(message(WakeBody.safeParse({ text: 'x' }))).toMatch(/falta seconds/);
  });

  it('text é obrigatório, de 1 a 2000 caracteres', () => {
    expect(ok(60, 'a').success).toBe(true);
    expect(ok(60, 'a'.repeat(WAKE_TEXT_MAX)).success).toBe(true);
    expect(message(ok(60, ''))).toMatch(/vazio/);
    expect(message(ok(60, '   \n '))).toMatch(/vazio/);
    expect(message(ok(60, 'a'.repeat(WAKE_TEXT_MAX + 1)))).toMatch(/2000/);
    expect(message(ok(60, 42))).toMatch(/texto/);
    expect(message(WakeBody.safeParse({ seconds: 60 }))).toMatch(/falta text/);
    expect(WakeBody.safeParse({ seconds: 60, text: '  oi  ' })).toMatchObject({ success: true, data: { text: 'oi' } });
  });
});

describe('AutoContinue como despertador: o texto da pendência', () => {
  let n = 0;
  const make = (over: Partial<AutoContinueOptions> = {}) => {
    const clock = { t: T0 };
    const sent: Pending[] = [];
    const events: AutoContinueEvent[] = [];
    const file = path.join(root, `sched-${++n}.json`);
    const ac = new AutoContinue({ file, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async (p) => void sent.push(p), now: () => clock.t, log: () => {}, ...over });
    ac.subscribe((e) => events.push(e));
    const pending = (o: Partial<Pending> = {}): Pending => ({ projectId: 'p', sessionId: 's1', staffId: 'ana', at: T0 + 90_000, resetsAt: T0 + 90_000, text: 'confira o deploy', ...o });
    return { ac, clock, sent, events, file, pending };
  };

  it('o texto vai para o disco, volta ao recarregar e chega ao envio; sem texto (o "continue" do limite), nada é gravado', async () => {
    const a = make();
    await a.ac.schedule(a.pending());
    await a.ac.schedule(a.pending({ sessionId: 's2', text: undefined }));
    const onDisk = JSON.parse(await fs.readFile(a.file, 'utf8')) as { pending: Array<{ sessionId: string; text?: string }> };
    expect(onDisk.pending.find((p) => p.sessionId === 's1')!.text).toBe('confira o deploy');
    expect('text' in onDisk.pending.find((p) => p.sessionId === 's2')!).toBe(false);

    const b = make({ file: a.file });
    expect(await b.ac.get('s1')).toEqual(a.pending());
    expect((await b.ac.get('s2'))!.text).toBeUndefined();
    b.clock.t = T0 + 90_000;
    await b.ac.tick();
    expect(b.sent.map((p) => p.text)).toEqual(['confira o deploy']);
  });
});

// ---- ligação com a conversa ----

function fakeClaude() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, kill: () => proc.emit('exit', 0) });
  const written: Array<{ type?: string; priority?: string; message?: { content?: Array<{ text?: string }> } }> = [];
  stdin.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  const emit = (ev: object) => stdout.write(JSON.stringify(ev) + '\n');
  return { proc, written, emit };
}
const settle = () => new Promise((r) => setTimeout(r, 15));
type Notice = Extract<ChatItem, { kind: 'notice' }>;

describe('ChatManager: despertador', () => {
  let n = 0;
  let spawns: Array<ReturnType<typeof fakeClaude>>;
  let envs: NodeJS.ProcessEnv[];
  let resolved: Array<{ sessionId: string | null; staffId: string | null }>;
  let clock: { t: number };
  let stop: { hit: { resetsAt: string | null } | null };
  let manager: ChatManager;
  let wakeups: AutoContinue;
  let limit: AutoContinue;
  let events: AutoContinueEvent[];
  let wakeFile: string;
  let limitFile: string;
  let usageFile: string;

  /** Dois agendadores como no servidor (despertador e "continue" do limite), cada um com o seu arquivo. */
  const build = (wakeFileIn: string, limitFileIn: string, wakeSend?: (p: Pending) => Promise<void>) => {
    const mk = (file: string, send: (p: Pending) => Promise<void>) =>
      new AutoContinue({ file, enabled: async () => true, stopHit: async () => stop.hit, knownResets: async () => [], send, now: () => clock.t, log: () => {} });
    const w: AutoContinue = mk(wakeFileIn, wakeSend ?? ((p) => m.wakeChat(p)));
    const l: AutoContinue = mk(limitFileIn, (p) => m.continueChat(p.projectId, p.sessionId, p.staffId));
    const m: ChatManager = new ChatManager({
      transcriptsDir: root,
      usageFile,
      listLive: async () => [],
      resolve: async (_p, sid, staffId) => {
        resolved.push({ sessionId: sid, staffId });
        return { sessionId: sid ?? 'sx', cwd: '.', args: ['--resume', sid ?? 'sx'] };
      },
      spawnImpl: (_cmd, _args, o) => {
        const f = fakeClaude();
        f.proc.stdin.on('finish', () => f.proc.emit('exit', 0));
        spawns.push(f);
        envs.push(o.env);
        return f.proc as never;
      },
      autoContinue: l,
      wakeups: w,
      now: () => clock.t,
      log: () => {},
    });
    return { m, w, l };
  };

  beforeEach(() => {
    n++;
    spawns = [];
    envs = [];
    resolved = [];
    // Só o Date é falso (o manager lê Date.now() em alguns pontos): o relógio injetado e o do sistema andam juntos.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    let now = T0;
    clock = {
      get t() {
        return now;
      },
      set t(v: number) {
        now = v;
        vi.setSystemTime(v);
      },
    };
    stop = { hit: null };
    wakeFile = path.join(root, `wake-${n}.json`);
    limitFile = path.join(root, `limit-${n}.json`);
    usageFile = path.join(root, `usage-${n}.json`);
    const b = build(wakeFile, limitFile);
    manager = b.m;
    wakeups = b.w;
    limit = b.l;
    events = [];
    wakeups.subscribe((e) => events.push(e));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const wakeNotices = async (sid = 'sx') => (await manager.snapshot('p', sid)).live!.items.filter((i): i is Notice => i.kind === 'notice' && !!i.wake);
  const closedWakeNotices = async (m: ChatManager = manager, sid = 'sx') =>
    (await m.snapshot('p', sid)).history.filter((i): i is Notice => i.kind === 'notice' && !!i.wake);
  const texts = (f: ReturnType<typeof fakeClaude>) => f.written.filter((w) => w.type === 'user').map((w) => w.message?.content?.at(-1)?.text);
  const hitLimit = async (f: ReturnType<typeof fakeClaude>) => {
    const resetsAt = Math.floor((clock.t + HOUR) / 1000);
    f.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } });
    f.emit({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" });
    await settle();
    await Promise.all(['sx', 'sy'].map((sid) => manager.awaitingLimit(sid)));
  };

  it('agenda: guarda a hora marcada e mostra o aviso com o instante (a contagem é do cliente) e o botão Cancelar', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    const done = await manager.scheduleWake('p', 'sx', { seconds: 90, text: 'confira o deploy' });
    expect(done).toEqual({ at: T0 + 90_000 });
    expect(await wakeups.get('sx')).toEqual({ projectId: 'p', sessionId: 'sx', staffId: 'ana', at: T0 + 90_000, resetsAt: T0 + 90_000, text: 'confira o deploy' });

    const [notice, ...rest] = await wakeNotices();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ tone: 'info', wake: 'waiting', wakeAt: T0 + 90_000, action: 'cancel-wake' });
    // O texto do servidor é o reserva, sem contagem regressiva (os segundos não vêm do servidor).
    expect(notice!.text).toBe('Volta a olhar em 10:31h.');
    expect(notice!.text).not.toMatch(/\d+s\b/);
  });

  it('na hora, manda o texto certo na conversa certa, com a ficha dela, e o aviso vira "Voltou a olhar"', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.send('p', 'sy', 'bia', 'faça Y');
    await manager.scheduleWake('p', 'sx', { seconds: 90, text: 'confira o deploy' });

    clock.t = T0 + 89_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X']);

    clock.t = T0 + 90_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X', 'confira o deploy']);
    expect(texts(spawns[1]!)).toEqual(['faça Y']); // a outra conversa não recebe
    expect(spawns).toHaveLength(2); // a conversa estava aberta: usa o processo dela
    // Conversa no meio de um turno: entra na fila, sem interromper.
    expect(spawns[0]!.written.filter((w) => w.type === 'user').at(-1)!.priority).toBe('later');
    expect(await wakeups.list()).toEqual([]);
    expect(JSON.parse(await fs.readFile(wakeFile, 'utf8'))).toEqual({ pending: [] });

    const [notice, ...rest] = await wakeNotices();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({ wake: 'sent', wakeAt: T0 + 90_000, text: 'Voltou a olhar às 10:31h.' });
    expect(notice!.action).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['sent']);

    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toHaveLength(2); // uma vez só
  });

  it('com a conversa fechada, reabre com a ficha do funcionário para mandar o texto (e o aviso volta com a hora)', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    manager.stop('sx'); // fechou por inatividade
    await settle();
    expect((await manager.snapshot('p', 'sx')).live).toBeNull();

    clock.t = T0 + 600_000;
    await wakeups.tick();
    await settle();
    expect(spawns).toHaveLength(2);
    expect(texts(spawns[1]!)).toEqual(['veja o CI']);
    expect(resolved.at(-1)).toEqual({ sessionId: 'sx', staffId: 'ana' });
    expect(await wakeNotices()).toMatchObject([{ wake: 'sent', text: 'Voltou a olhar às 10:40h.' }]);
  });

  it('agendar de novo troca o anterior: uma pendência, o mesmo aviso com a hora nova, e só o texto novo sai', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'primeiro' });
    clock.t = T0 + 20_000;
    await manager.scheduleWake('p', 'sx', { seconds: 300, text: 'segundo' });

    expect(await wakeups.list()).toEqual([expect.objectContaining({ text: 'segundo', at: T0 + 20_000 + 300_000 })]);
    expect(await wakeNotices()).toMatchObject([{ wake: 'waiting', wakeAt: T0 + 320_000 }]); // um aviso só
    expect(events).toEqual([]); // trocar não é cancelar

    clock.t = T0 + 70_000; // a hora do primeiro já passou
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X']);

    clock.t = T0 + 320_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X', 'segundo']);
  });

  it('o botão Cancelar (a tela) e o próprio funcionário desfazem: não manda, o aviso vira "Despertador cancelado."', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });
    expect(await manager.cancelWake('p', 'sx', 'user')).toBe(true);
    expect(await wakeups.get('sx')).toBeNull();
    expect(await wakeNotices()).toMatchObject([{ wake: 'cancelled', text: 'Despertador cancelado.' }]);
    expect((await wakeNotices())[0]!.action).toBeUndefined();
    expect(await manager.cancelWake('p', 'sx', 'user')).toBe(false); // já não havia

    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'b' });
    expect(await manager.cancelWake('p', 'sx', 'staff')).toBe(true);
    expect(events.map((e) => (e.type === 'cancelled' ? e.by : e.type))).toEqual(['user', 'staff']);
    expect(await wakeNotices()).toMatchObject([{ wake: 'cancelled' }, { wake: 'cancelled' }]);

    clock.t = T0 + 120_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X']);
  });

  // ---- A: a tarefa só é entregue com a conversa parada ----

  describe('entrega da tarefa quando o despertador sai sem mandar', () => {
    let delivered: string[];
    beforeEach(() => {
      delivered = [];
      watchWakeups(wakeups, (sid) => manager.isWorking(sid), (sid) => void delivered.push(sid));
    });
    const endTurn = async () => {
      spawns[0]!.emit({ type: 'result', is_error: false, result: 'ok' });
      await settle();
    };

    it('o funcionário cancela no meio do próprio turno: nada é entregue (o fim do turno entrega)', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });
      expect(manager.isWorking('sx')).toBe(true);
      expect(await manager.cancelWake('p', 'sx', 'staff')).toBe(true);
      expect(delivered).toEqual([]);
      await endTurn();
      expect(manager.isWorking('sx')).toBe(false);
      expect(delivered).toEqual([]); // o aviso do fim do turno vem de outro lugar (onIdle), não do despertador
    });

    it('o usuário cancela com a conversa trabalhando: não entrega; parada: entrega', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });
      expect(await manager.cancelWake('p', 'sx', 'user')).toBe(true);
      expect(delivered).toEqual([]);

      await endTurn();
      await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'b' });
      expect(manager.isWorking('sx')).toBe(false);
      expect(await manager.cancelWake('p', 'sx', 'user')).toBe(true);
      expect(delivered).toEqual(['sx']);
    });

    it('conversa fechada conta como parada: o cancelamento do usuário entrega', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'a' });
      manager.stop('sx');
      await settle();
      expect(manager.isWorking('sx')).toBe(false);
      await manager.cancelWake('p', 'sx', 'user');
      expect(delivered).toEqual(['sx']);
    });

    it('falhou com a conversa parada entrega; com ela trabalhando, não', async () => {
      const failing = build(path.join(root, `wake-f-${n}.json`), path.join(root, `limit-f-${n}.json`), async () => {
        throw new Error('a sessão continua aberta num terminal');
      });
      const got: string[] = [];
      watchWakeups(failing.w, (sid) => failing.m.isWorking(sid), (sid) => void got.push(sid));
      await failing.m.send('p', 'sx', 'ana', 'faça X');
      await failing.m.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });
      clock.t = T0 + 60_000;
      await failing.w.tick(); // a conversa ainda está no turno: não entrega
      await settle();
      expect(got).toEqual([]);

      spawns.at(-1)!.emit({ type: 'result', is_error: false, result: 'ok' });
      await settle();
      await failing.m.scheduleWake('p', 'sx', { seconds: 60, text: 'b' });
      clock.t = T0 + 120_000;
      await failing.w.tick(); // parada: entrega
      await settle();
      expect(got).toEqual(['sx']);
    });

    it('solto (dropped) com a conversa parada entrega; trabalhando, não', async () => {
      const got: string[] = [];
      watchWakeups({ subscribe: (l) => (l({ type: 'dropped', pending: { projectId: 'p', sessionId: 'sx', staffId: 'ana', at: T0, resetsAt: T0 } }), () => {}) }, () => false, (sid) => void got.push(sid));
      watchWakeups({ subscribe: (l) => (l({ type: 'dropped', pending: { projectId: 'p', sessionId: 'sy', staffId: 'ana', at: T0, resetsAt: T0 } }), () => {}) }, () => true, (sid) => void got.push(sid));
      expect(got).toEqual(['sx']);
    });
  });

  // ---- B: teto de despertadores seguidos ----

  describe('teto de despertadores seguidos sem o usuário falar', () => {
    const fire = async (i: number) => {
      await manager.scheduleWake('p', 'sx', { seconds: 10, text: `volta ${i}` });
      clock.t += 20_000; // passa do prazo e da folga entre um envio e outro do agendador
      await wakeups.tick();
      await settle();
    };

    it('o 21º é recusado com erro claro; a conversa e a pendência anterior ficam como estavam', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      for (let i = 1; i <= WAKE_MAX_STREAK; i++) await fire(i);
      expect(texts(spawns[0]!)).toHaveLength(1 + WAKE_MAX_STREAK);
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'a 21ª' })).rejects.toBeInstanceOf(WakeStreakError);
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'a 21ª' })).rejects.toThrow(/muitos despertadores seguidos sem o usuário falar \(20\); peça ao usuário/);
      expect(await wakeups.get('sx')).toBeNull();
    });

    it('uma mensagem do usuário zera a conta; o limite é por conversa', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.send('p', 'sy', 'bia', 'faça Y');
      for (let i = 1; i <= WAKE_MAX_STREAK; i++) await fire(i);
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'x' })).rejects.toBeInstanceOf(WakeStreakError);
      await expect(manager.scheduleWake('p', 'sy', { seconds: 10, text: 'y' })).resolves.toEqual({ at: clock.t + 10_000 }); // outra conversa
      await manager.cancelWake('p', 'sy', 'user'); // (o agendador manda um por vez: que não atrapalhe a contagem abaixo)

      await manager.send('p', 'sx', 'ana', 'e então?');
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'depois' })).resolves.toEqual({ at: clock.t + 10_000 });
      for (let i = 1; i <= WAKE_MAX_STREAK; i++) await fire(i); // a conta recomeçou: mais 20 e recusa de novo
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'x' })).rejects.toBeInstanceOf(WakeStreakError);
    });

    it('agendar de novo antes de disparar não conta; o "continue" do limite não zera a conta', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      for (let i = 0; i < WAKE_MAX_STREAK + 5; i++) await manager.scheduleWake('p', 'sx', { seconds: 60, text: `v${i}` });
      for (let i = 1; i < WAKE_MAX_STREAK; i++) await fire(i); // 19 disparados
      await manager.continueChat('p', 'sx', 'ana');
      await fire(WAKE_MAX_STREAK); // o 20º
      await expect(manager.scheduleWake('p', 'sx', { seconds: 10, text: 'x' })).rejects.toBeInstanceOf(WakeStreakError);
    });
  });

  it('cancelar com o projeto errado: 404 (null) e a pendência fica; conversa de outro projeto não agenda', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });
    expect(await manager.cancelWake('outro', 'sx', 'user')).toBeNull();
    expect(await manager.cancelWake('outro', 'sx', 'staff')).toBeNull();
    expect(await wakeups.get('sx')).not.toBeNull();

    // Não agenda: conversa de outro projeto, conversa que não existe ou que não está aberta aqui.
    expect(await manager.scheduleWake('outro', 'sx', { seconds: 60, text: 'x' })).toBeNull();
    expect(await manager.scheduleWake('p', 'nao-existe', { seconds: 60, text: 'x' })).toBeNull();
    manager.stop('sx');
    await settle();
    expect(await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'x' })).toBeNull();
    expect((await wakeups.get('sx'))!.text).toBe('a');
  });

  it('linha de parada do consumo estourada: reagenda sem mandar, o aviso mostra a hora nova, e sai quando ela libera', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'confira' });
    stop.hit = { resetsAt: new Date(T0 + 5 * HOUR).toISOString() };

    clock.t = T0 + 60_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X']);
    expect(events.map((e) => e.type)).toEqual(['deferred']);
    expect(await wakeups.get('sx')).toMatchObject({ at: T0 + 5 * HOUR + SLACK_MS, text: 'confira' });
    expect(await wakeNotices()).toMatchObject([{ wake: 'waiting', wakeAt: T0 + 5 * HOUR + SLACK_MS }]);

    stop.hit = null;
    clock.t = T0 + 5 * HOUR + SLACK_MS;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X', 'confira']);
  });

  it('sobrevive a reiniciar o servidor: o arquivo traz a pendência, o aviso da conversa fechada e o envio na hora', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    const [open] = await wakeNotices();

    // Outro processo do servidor: tudo novo, o arquivo é o mesmo.
    const second = build(wakeFile, limitFile);
    expect(await second.w.get('sx')).toMatchObject({ at: T0 + 600_000, text: 'veja o CI', staffId: 'ana' });
    const snap = await second.m.snapshot('p', 'sx');
    expect(snap.live).toBeNull();
    expect(await closedWakeNotices(second.m)).toEqual([expect.objectContaining({ wake: 'waiting', wakeAt: T0 + 600_000, action: 'cancel-wake', text: open!.text })]);
    // Outro projeto não vê o aviso.
    expect((await second.m.snapshot('outro', 'sx')).history.filter((i) => i.kind === 'notice')).toEqual([]);

    clock.t = T0 + 600_000;
    await second.w.tick();
    await settle();
    expect(texts(spawns.at(-1)!)).toEqual(['veja o CI']);
    expect(resolved.at(-1)).toEqual({ sessionId: 'sx', staffId: 'ana' });
  });

  it('o processo fechado e reaberto por outro motivo recria o aviso a partir da pendência, sem tirá-la', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    manager.stop('sx');
    await settle();
    expect(await closedWakeNotices()).toMatchObject([{ wake: 'waiting', wakeAt: T0 + 600_000 }]);

    await manager.continueChat('p', 'sx', 'ana'); // qualquer coisa que reabra o processo
    expect(spawns).toHaveLength(2);
    expect(await wakeNotices()).toMatchObject([{ wake: 'waiting', wakeAt: T0 + 600_000, action: 'cancel-wake' }]);
    expect(await wakeups.get('sx')).not.toBeNull();
  });

  it('sem pendência, a conversa fechada não inventa aviso; cancelada com ela fechada, o aviso some', async () => {
    expect(await closedWakeNotices()).toEqual([]);
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'a' });
    manager.stop('sx');
    await settle();
    expect(await manager.cancelWake('p', 'sx', 'user')).toBe(true);
    expect(await closedWakeNotices()).toEqual([]);
  });

  it('mensagem do usuário na conversa não cancela o despertador', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    await manager.sendFromUser('p', 'sx', 'ana', 'eu mesmo continuo');
    await manager.send('p', 'sx', 'ana', 'olha isto', undefined, [], [], true); // e a de outro funcionário também não
    expect(await wakeups.get('sx')).toMatchObject({ text: 'veja o CI' });
    expect(await wakeNotices()).toMatchObject([{ wake: 'waiting' }]);

    clock.t = T0 + 600_000;
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!)).toEqual(['faça X', 'eu mesmo continuo', 'olha isto', 'veja o CI']);
  });

  it('não interfere com o "continue" do limite de uso na mesma conversa: cada um tem o seu arquivo e um não apaga o outro', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    expect((await limit.list()).map((p) => p.sessionId)).toEqual(['sx']);
    expect((await wakeups.list()).map((p) => p.sessionId)).toEqual(['sx']);
    expect(wakeFile).not.toBe(limitFile);
    expect(JSON.parse(await fs.readFile(limitFile, 'utf8')).pending[0]).not.toHaveProperty('text');
    expect(JSON.parse(await fs.readFile(wakeFile, 'utf8')).pending[0].text).toBe('veja o CI');

    // Cancelar o despertador deixa o "continue"…
    expect(await manager.cancelWake('p', 'sx', 'user')).toBe(true);
    expect((await limit.list()).map((p) => p.sessionId)).toEqual(['sx']);
    // …e cancelar o "continue" (botão do aviso de limite) deixa o despertador.
    await manager.scheduleWake('p', 'sx', { seconds: 600, text: 'veja o CI' });
    expect(await manager.cancelAutoContinue('p', 'sx')).toBe(true);
    expect((await wakeups.list()).map((p) => p.sessionId)).toEqual(['sx']);

    // Mensagem sua cancela o "continue" (como sempre) e não o despertador.
    await hitLimit(spawns[0]!);
    expect(await limit.get('sx')).not.toBeNull();
    await manager.sendFromUser('p', 'sx', 'ana', 'eu mesmo continuo');
    expect(await limit.get('sx')).toBeNull();
    expect(await wakeups.get('sx')).not.toBeNull();

    // O despertador que sai não cancela o "continue" agendado.
    await hitLimit(spawns[0]!);
    clock.t = T0 + 600_000; // o limite só volta daqui a 1 h
    await wakeups.tick();
    await settle();
    expect(texts(spawns[0]!).at(-1)).toBe('veja o CI');
    expect(await limit.get('sx')).not.toBeNull();
    // E o "continue" que sai não leva o despertador.
    await manager.scheduleWake('p', 'sx', { seconds: 30_000, text: 'depois' });
    clock.t = T0 + 2 * HOUR;
    await limit.tick();
    await settle();
    expect(texts(spawns[0]!).at(-1)).toBe('continue');
    expect(await wakeups.get('sx')).toMatchObject({ text: 'depois' });
  });

  it('despertadores de conversas diferentes são independentes', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.send('p', 'sy', 'bia', 'faça Y');
    await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'x' });
    await manager.scheduleWake('p', 'sy', { seconds: 600, text: 'y' });
    await manager.cancelWake('p', 'sx', 'staff');
    expect((await wakeups.list()).map((p) => [p.sessionId, p.staffId])).toEqual([['sy', 'bia']]);
  });

  it('o id da conversa chega ao processo do claude em MYCO_SESSION_ID', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.send('p', 'sy', 'bia', 'faça Y');
    expect(envs.map((e) => e.MYCO_SESSION_ID)).toEqual(['sx', 'sy']);
    // Reaberta, é a mesma conversa.
    manager.stop('sx');
    await settle();
    await manager.send('p', 'sx', 'ana', 'de novo');
    expect(envs.map((e) => e.MYCO_SESSION_ID)).toEqual(['sx', 'sy', 'sx']);
  });

  it('o processo recebe MYCO_SESSION_ID também direto (e continua sem as variáveis do Claude/Anthropic)', () => {
    let env: NodeJS.ProcessEnv = {};
    process.env.ANTHROPIC_API_KEY = 'segredo';
    try {
      const f = fakeClaude();
      const chat = new ChatProcess({
        sessionId: 'abc-123',
        cwd: '.',
        args: [],
        spawnImpl: (_c, _a, o) => {
          env = o.env;
          return f.proc as never;
        },
      });
      chat.start();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    expect(env.MYCO_SESSION_ID).toBe('abc-123');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('falha ao mandar: a pendência sai (sem laço) e o aviso conta o motivo', async () => {
    const failing = build(path.join(root, `wake-fail-${n}.json`), path.join(root, `limit-fail-${n}.json`), async () => {
      throw new Error('a sessão continua aberta num terminal');
    });
    const seen: AutoContinueEvent[] = [];
    failing.w.subscribe((e) => seen.push(e));
    await failing.m.send('p', 'sx', 'ana', 'faça X');
    await failing.m.scheduleWake('p', 'sx', { seconds: 60, text: 'a' });

    clock.t = T0 + 60_000;
    await failing.w.tick();
    expect(seen.map((e) => e.type)).toEqual(['failed']);
    expect(await failing.w.get('sx')).toBeNull();
    const notices = (await failing.m.snapshot('p', 'sx')).live!.items.filter((i): i is Notice => i.kind === 'notice' && !!i.wake);
    expect(notices).toMatchObject([{ wake: 'failed', tone: 'warn', text: wakeNotice.failed('a sessão continua aberta num terminal') }]);
    expect(notices[0]!.action).toBeUndefined();

    await failing.w.tick(); // não tenta de novo
    expect(seen).toHaveLength(1);
  });

  it('despertador sem mensagem (arquivo mexido à mão) falha em vez de mandar vazio', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await expect(manager.wakeChat({ projectId: 'p', sessionId: 'sx', staffId: 'ana', at: T0, resetsAt: T0 })).rejects.toThrow(/sem mensagem/);
    expect(texts(spawns[0]!)).toEqual(['faça X']);
  });

  // ---- agendamentos do projeto (a tela central) ----

  describe('listSchedules: despertadores e "continue" do projeto', () => {
    const ms = (o: number) => new Date(T0 + o).toISOString();

    it('junta os dois tipos, do que vence primeiro ao último, com `at` em ISO', async () => {
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.scheduleWake('p', 'sx', { seconds: 300, text: 'confira o deploy' });
      await limit.schedule({ projectId: 'p', sessionId: 'sy', staffId: 'bia', at: T0 + 120_000, resetsAt: T0 + 120_000 });
      await wakeups.schedule({ projectId: 'p', sessionId: 'sz', staffId: null, at: T0 + 60_000, resetsAt: T0 + 60_000, text: 'cedo' });

      expect(await manager.listSchedules('p')).toEqual([
        { kind: 'wake', sessionId: 'sz', staffId: null, at: ms(60_000), text: 'cedo' },
        { kind: 'continue', sessionId: 'sy', staffId: 'bia', at: ms(120_000), text: 'continue' },
        { kind: 'wake', sessionId: 'sx', staffId: 'ana', at: ms(300_000), text: 'confira o deploy' },
      ]);
    });

    it('só entra o que é do projeto pedido; projeto sem nada devolve lista vazia', async () => {
      await wakeups.schedule({ projectId: 'outro', sessionId: 'sz', staffId: 'cy', at: T0 + 60_000, resetsAt: T0 + 60_000, text: 'de outro' });
      await limit.schedule({ projectId: 'outro', sessionId: 'sw', staffId: 'dan', at: T0 + 70_000, resetsAt: T0 + 70_000 });
      await manager.send('p', 'sx', 'ana', 'faça X');
      await manager.scheduleWake('p', 'sx', { seconds: 60, text: 'meu' });

      expect((await manager.listSchedules('p')).map((i) => i.sessionId)).toEqual(['sx']);
      expect((await manager.listSchedules('outro')).map((i) => i.sessionId)).toEqual(['sz', 'sw']);
      expect(await manager.listSchedules('nenhum')).toEqual([]);
    });

    it('o "continue" sai sempre com o texto "continue", mesmo que a pendência traga outro', async () => {
      await limit.schedule({ projectId: 'p', sessionId: 'sy', staffId: 'bia', at: T0 + 1_000, resetsAt: T0 + 1_000, text: 'algo à mão' });
      expect(await manager.listSchedules('p')).toEqual([{ kind: 'continue', sessionId: 'sy', staffId: 'bia', at: ms(1_000), text: 'continue' }]);
    });

    it('sem o agendador configurado, aquele tipo vem vazio (e sem nenhum, a lista é vazia)', async () => {
      const base = { transcriptsDir: root, usageFile, listLive: async () => [], resolve: async (_p: string, sid: string | null) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }), spawnImpl: () => fakeClaude().proc as never, now: () => clock.t, log: () => {} };
      await limit.schedule({ projectId: 'p', sessionId: 'sy', staffId: 'bia', at: T0 + 1_000, resetsAt: T0 + 1_000 });

      expect((await new ChatManager({ ...base, autoContinue: limit }).listSchedules('p')).map((i) => i.kind)).toEqual(['continue']);
      expect((await new ChatManager({ ...base, wakeups }).listSchedules('p')).map((i) => i.kind)).toEqual([]);
      expect(await new ChatManager(base).listSchedules('p')).toEqual([]);
    });
  });

  it('a rota GET /schedules só responde ao navegador; fora da sandbox e da lista de funcionário, nada a libera', async () => {
    const index = await fs.readFile(path.join(process.cwd(), 'server', 'index.ts'), 'utf8');
    const at = index.indexOf('new RegExp(`^/api/projects/${ID}/schedules$`)');
    expect(at).toBeGreaterThan(0);
    expect(index.slice(at, at + 260)).toContain("if (!fromBrowser) throw new BadRequest('só pelo Claudio’s Club');");
    expect(staffMayPost('/api/projects/p1/schedules')).toBe(false);
    expect(sandboxVerdict('GET', '/api/projects/p1/schedules', 'p1')).not.toBeNull();
  });
});

describe('aviso do despertador no cliente', () => {
  it('a contagem regressiva sai do instante: arredonda para cima, só em segundos (mesmo acima de 60) e para em 0s', () => {
    const at = T0 + 90_000;
    expect(secondsLeft(at, T0)).toBe(90);
    expect(secondsLeft(at, T0 + 1)).toBe(90);
    expect(secondsLeft(at, T0 + 1_000)).toBe(89);
    expect(secondsLeft(at, T0 + 89_001)).toBe(1);
    expect(secondsLeft(at, at)).toBe(0);
    expect(secondsLeft(at, at + 5_000)).toBe(0);
    expect(secondsLeft(T0 + 3_600_000, T0)).toBe(3600);
  });

  it('a hora é local, HH:MM (o texto põe o "h")', () => {
    expect(clockHM(Date.parse('2026-11-02T10:32:45'))).toBe('10:32');
    expect(clockHM(Date.parse('2026-11-02T07:05:00'))).toBe('07:05');
    expect(clockHM(Date.parse('2026-11-02T00:00:59'))).toBe('00:00');
  });

  it('os textos existem em pt, en e es, com a hora e os segundos', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      const d = dicts[lang] as Record<string, string>;
      expect(d['chat.wakeWaiting']).toMatch(/\{time\}.*\{secs\}s/);
      expect(d['chat.wakeSent']).toContain('{time}');
      expect(d['chat.wakeCancelled']).toBeTruthy();
    }
    expect(dicts['pt-BR']['chat.wakeWaiting' as never]).toBe('Volta a olhar em {time}h ({secs}s)');
    expect(dicts['pt-BR']['chat.wakeSent' as never]).toBe('Voltou a olhar às {time}h.');
    expect(dicts['pt-BR']['chat.wakeCancelled' as never]).toBe('Despertador cancelado.');
  });
});
