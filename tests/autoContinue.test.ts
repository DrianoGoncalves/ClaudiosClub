import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatItem } from '../shared/model';
import { AutoContinue, CONTINUE_TEXT, type AutoContinueEvent, type AutoContinueOptions, type Pending } from '../server/chat/autoContinue';
import { ChatManager } from '../server/chat/manager';
import { readConfig, updateConfig } from '../server/config';
import { limitNotice, SLACK_MS } from '../server/chat/usageLimit';

// "Continue" sozinho quando o limite de uso volta: agendador (relógio injetado, sem esperar de verdade)
// e a ligação com a conversa (aviso, cancelamento, mensagem sua).

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-autocontinue-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;

let n = 0;
function scheduler(over: Partial<AutoContinueOptions> = {}) {
  const clock = { t: T0 };
  const sent: Pending[] = [];
  const events: AutoContinueEvent[] = [];
  const file = path.join(root, `pending-${++n}.json`);
  const ac = new AutoContinue({
    file,
    enabled: async () => true,
    stopHit: async () => null,
    knownResets: async () => [],
    send: async (p) => void sent.push(p),
    now: () => clock.t,
    log: () => {},
    ...over,
  });
  ac.subscribe((e) => events.push(e));
  const pending = (over: Partial<Pending> = {}): Pending => ({
    projectId: 'proj',
    sessionId: 's1',
    staffId: 'ana',
    resetsAt: T0 + HOUR,
    at: T0 + HOUR + SLACK_MS,
    ...over,
  });
  return { ac, clock, sent, events, file, pending };
}

describe('AutoContinue: agendador', () => {
  it('vencida: manda a conversa continuar, uma vez, e sai da lista (e do disco)', async () => {
    const { ac, clock, sent, events, file, pending } = scheduler();
    expect(await ac.schedule(pending())).toBe(true);

    clock.t = T0 + HOUR; // o limite voltou, mas a folga de 1 minuto ainda não passou
    await ac.tick();
    expect(sent).toEqual([]);

    clock.t = T0 + HOUR + SLACK_MS;
    await ac.tick();
    expect(sent).toEqual([pending()]);
    expect(events).toEqual([{ type: 'sent', pending: pending() }]);
    expect(await ac.list()).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ pending: [] });

    await ac.tick();
    expect(sent).toHaveLength(1);
  });

  it('o texto é sempre "continue"', () => {
    expect(CONTINUE_TEXT).toBe('continue');
  });

  it('opção desligada: não agenda; a que já estava saiu sem mandar', async () => {
    let on = true;
    const { ac, clock, sent, events, pending } = scheduler({ enabled: async () => on });
    expect(await ac.schedule(pending())).toBe(true);
    on = false;
    clock.t = T0 + 2 * HOUR;
    await ac.tick();
    expect(sent).toEqual([]);
    expect(events).toEqual([{ type: 'dropped', pending: pending() }]);
    expect(await ac.list()).toEqual([]);

    // Desligada na hora de agendar: devolve false e não guarda (e tira a antiga da mesma conversa).
    on = true;
    await ac.schedule(pending());
    on = false;
    expect(await ac.schedule(pending({ at: T0 + 3 * HOUR }))).toBe(false);
    expect(await ac.list()).toEqual([]);
  });

  it('linha de parada do usuário estourada: reagenda para o reset dela, sem mandar', async () => {
    const stop = { hit: { resetsAt: new Date(T0 + 5 * HOUR).toISOString() } as { resetsAt: string | null } | null };
    const { ac, clock, sent, events, pending } = scheduler({ stopHit: async () => stop.hit });
    await ac.schedule(pending());

    clock.t = T0 + HOUR + SLACK_MS;
    await ac.tick();
    expect(sent).toEqual([]);
    const moved = pending({ resetsAt: T0 + 5 * HOUR, at: T0 + 5 * HOUR + SLACK_MS });
    expect(events).toEqual([{ type: 'deferred', pending: moved }]);
    expect(await ac.get('s1')).toEqual(moved);

    // Ainda barrada na hora nova: reagenda de novo, sem laço no mesmo instante.
    clock.t = T0 + 5 * HOUR + SLACK_MS;
    stop.hit = { resetsAt: null };
    await ac.tick();
    expect(sent).toEqual([]);
    const again = await ac.get('s1');
    expect(again!.at).toBe(clock.t + 30 * 60_000); // nada conhecido: daqui a 30 min
    expect(again!.at).toBeGreaterThan(clock.t);

    // A linha deixou de barrar: manda.
    stop.hit = null;
    clock.t = again!.at;
    await ac.tick();
    expect(sent).toHaveLength(1);
  });

  it('linha de parada sem hora: usa o próximo reset conhecido', async () => {
    const { ac, clock, sent, pending } = scheduler({
      stopHit: async () => ({ resetsAt: null }),
      knownResets: async () => [
        { kind: 'five_hour', resetsAt: new Date(T0 + 4 * HOUR).toISOString() },
        { kind: 'seven_day', resetsAt: new Date(T0 + 60 * HOUR).toISOString() },
      ],
    });
    await ac.schedule(pending());
    clock.t = T0 + HOUR + SLACK_MS;
    await ac.tick();
    expect(sent).toEqual([]);
    expect((await ac.get('s1'))!.at).toBe(T0 + 4 * HOUR + SLACK_MS);
  });

  it('não conseguir conferir a linha de parada também espera, não manda', async () => {
    const { ac, clock, sent, pending } = scheduler({
      stopHit: async () => {
        throw new Error('config ilegível');
      },
    });
    await ac.schedule(pending());
    clock.t = T0 + HOUR + SLACK_MS;
    await ac.tick();
    expect(sent).toEqual([]);
    expect((await ac.get('s1'))!.at).toBe(clock.t + 30 * 60_000);
  });

  it('cancelar tira a pendência: não manda e avisa quem ouve', async () => {
    const { ac, clock, sent, events, pending } = scheduler();
    await ac.schedule(pending());
    expect(await ac.cancel('s1', 'user')).toBe(true);
    expect(await ac.cancel('s1', 'user')).toBe(false);
    expect(events).toEqual([{ type: 'cancelled', by: 'user', pending: pending() }]);
    clock.t = T0 + 2 * HOUR;
    await ac.tick();
    expect(sent).toEqual([]);
  });

  it('uma pendência por conversa: a nova substitui a antiga', async () => {
    const { ac, clock, sent, events, pending } = scheduler();
    await ac.schedule(pending());
    await ac.schedule(pending({ resetsAt: T0 + 3 * HOUR, at: T0 + 3 * HOUR + SLACK_MS }));
    await ac.schedule(pending({ sessionId: 's2' }));
    expect((await ac.list()).map((p) => [p.sessionId, p.at])).toEqual([
      ['s2', T0 + HOUR + SLACK_MS],
      ['s1', T0 + 3 * HOUR + SLACK_MS],
    ]);
    expect(events).toEqual([]); // trocar não é cancelar

    clock.t = T0 + 2 * HOUR;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['s2']);
  });

  it('recarrega do arquivo depois de reiniciar o servidor', async () => {
    const first = scheduler();
    await first.ac.schedule(first.pending());
    await first.ac.schedule(first.pending({ sessionId: 's2', staffId: null }));

    const second = scheduler({ file: first.file });
    expect(await second.ac.list()).toEqual([first.pending(), first.pending({ sessionId: 's2', staffId: null })]);
    second.clock.t = T0 + 2 * HOUR;
    await second.ac.tick();
    expect(second.sent).toEqual([first.pending()]);
  });

  it('arquivo estragado: vai para .bad (com o erro no log), o agendador segue vazio e a próxima gravação não pisa nele', async () => {
    for (const [name, body] of [['json', '{ nao e json'], ['lista', JSON.stringify({ pending: 3 })], ['nulo', 'null']] as const) {
      const file = path.join(root, `quebrado-${name}.json`);
      await fs.writeFile(file, body);
      const logs: string[] = [];
      const { ac, pending } = scheduler({ file, log: (l) => logs.push(l) });
      expect(await ac.list()).toEqual([]);
      expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe(body);
      await expect(fs.access(file)).rejects.toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/estragado/);
      expect(logs[0]).toContain(`${file}.bad`);

      await ac.schedule(pending());
      expect(JSON.parse(await fs.readFile(file, 'utf8')).pending).toHaveLength(1);
      expect(await fs.readFile(`${file}.bad`, 'utf8')).toBe(body);
    }
  });

  it('arquivo que ainda não existe não é erro: sem log e sem .bad', async () => {
    const file = path.join(root, 'nunca-existiu.json');
    const logs: string[] = [];
    expect(await scheduler({ file, log: (l) => logs.push(l) }).ac.list()).toEqual([]);
    expect(logs).toEqual([]);
    await expect(fs.access(`${file}.bad`)).rejects.toThrow();
  });

  it('entrada inválida é pulada com log; as outras ficam', async () => {
    const file = path.join(root, 'entrada-ruim.json');
    const good = { projectId: 'p', sessionId: 'ok', staffId: 'x', at: new Date(T0).toISOString(), resetsAt: new Date(T0).toISOString() };
    await fs.writeFile(file, JSON.stringify({ pending: [good, { projectId: 'p', sessionId: 'data-ruim', staffId: null, at: 'x', resetsAt: 'y' }, { lixo: 1 }] }));
    const logs: string[] = [];
    const { ac } = scheduler({ file, log: (l) => logs.push(l) });
    expect((await ac.list()).map((p) => p.sessionId)).toEqual(['ok']);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/entrada 2.*inválida/);
    expect(logs[1]).toMatch(/entrada 3.*inválida/);
    await expect(fs.access(`${file}.bad`)).rejects.toThrow(); // o arquivo em si estava bom
  });

  it('manda primeiro e só depois apaga: no meio do envio a pendência ainda está no disco (um servidor que caísse ali a reencontra)', async () => {
    let s: ReturnType<typeof scheduler>;
    let duringSend: Pending[] | null = null;
    s = scheduler({
      send: async () => {
        duringSend = await scheduler({ file: s.file }).ac.list();
      },
    });
    await s.ac.schedule(s.pending());
    s.clock.t = T0 + 2 * HOUR;
    await s.ac.tick();
    expect(duringSend).toEqual([s.pending()]);
    expect(await s.ac.list()).toEqual([]);
    expect(JSON.parse(await fs.readFile(s.file, 'utf8'))).toEqual({ pending: [] });
    expect(s.events).toEqual([{ type: 'sent', pending: s.pending() }]);
  });

  it('mensagem sua durante o envio: a pendência já saiu, então não apaga de novo nem avisa duas vezes', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const begun = new Promise<void>((r) => (started = r));
    const { ac, clock, events, pending } = scheduler({
      send: async () => {
        started();
        await gate;
      },
    });
    await ac.schedule(pending());
    clock.t = T0 + 2 * HOUR;
    const run = ac.tick();
    await begun;
    await ac.cancel('s1', 'message');
    release();
    await run;
    expect(events).toEqual([{ type: 'cancelled', by: 'message', pending: pending() }]);
    expect(await ac.list()).toEqual([]);
  });

  it('outro estouro durante o envio troca a pendência: a nova fica, e o envio não a apaga', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const begun = new Promise<void>((r) => (started = r));
    const { ac, clock, events, pending } = scheduler({
      send: async () => {
        started();
        await gate;
      },
    });
    await ac.schedule(pending());
    clock.t = T0 + 2 * HOUR;
    const run = ac.tick();
    await begun;
    const next = pending({ resetsAt: T0 + 5 * HOUR, at: T0 + 5 * HOUR + SLACK_MS });
    await ac.schedule(next);
    release();
    await run;
    expect(await ac.list()).toEqual([next]);
    expect(events).toEqual([]);
  });

  it('opção desligada no meio da espera: solta todas as pendências na hora, mesmo as que não venceram, com dropped', async () => {
    let on = true;
    const { ac, clock, sent, events, file, pending } = scheduler({ enabled: async () => on });
    await ac.schedule(pending());
    await ac.schedule(pending({ sessionId: 's2', at: T0 + 9 * HOUR }));
    on = false;
    clock.t = T0 + 1000; // nada venceu
    await ac.tick();
    expect(events).toEqual([
      { type: 'dropped', pending: pending() },
      { type: 'dropped', pending: pending({ sessionId: 's2', at: T0 + 9 * HOUR }) },
    ]);
    expect(await ac.list()).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ pending: [] });

    // Ligar de novo não traz nada de volta.
    on = true;
    clock.t = T0 + 20 * HOUR;
    await ac.tick();
    expect(sent).toEqual([]);
    expect(events).toHaveLength(2);
  });

  it('giveUp: tira a pendência e avisa com failed; com a opção desligada não há o que desistir', async () => {
    let on = true;
    const { ac, events, pending } = scheduler({ enabled: async () => on });
    await ac.schedule(pending());
    expect(await ac.giveUp(pending(), 'estourou 5 vezes seguidas')).toBe(true);
    expect(events).toEqual([{ type: 'failed', pending: pending(), error: 'estourou 5 vezes seguidas', gaveUp: true }]);
    expect(await ac.list()).toEqual([]);

    on = false;
    expect(await ac.giveUp(pending(), 'x')).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('várias vencidas juntas: uma a cada ~20 s, a mais antiga primeiro', async () => {
    const { ac, clock, sent, pending } = scheduler();
    await ac.schedule(pending({ sessionId: 'c', at: T0 + 3 * HOUR }));
    await ac.schedule(pending({ sessionId: 'a', at: T0 + HOUR }));
    await ac.schedule(pending({ sessionId: 'b', at: T0 + 2 * HOUR }));

    clock.t = T0 + 4 * HOUR;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['a']);
    clock.t += 10_000;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['a']);
    clock.t += 10_000;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['a', 'b']);
    clock.t += 20_000;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
    expect(await ac.list()).toEqual([]);
  });

  it('as reagendadas e as descartadas não gastam a vez da próxima', async () => {
    const { ac, clock, sent, pending } = scheduler({ stopHit: async (projectId) => (projectId === 'barrado' ? { resetsAt: null } : null) });
    await ac.schedule(pending({ sessionId: 'x', projectId: 'barrado', at: T0 + HOUR }));
    await ac.schedule(pending({ sessionId: 'y', at: T0 + 2 * HOUR }));
    clock.t = T0 + 3 * HOUR;
    await ac.tick();
    expect(sent.map((p) => p.sessionId)).toEqual(['y']);
    expect((await ac.get('x'))!.at).toBe(clock.t + 30 * 60_000);
  });

  it('falha ao mandar: a pendência sai (sem laço) e quem ouve fica sabendo', async () => {
    const { ac, clock, events, pending } = scheduler({
      send: async () => {
        throw new Error('a sessão continua aberta num terminal');
      },
    });
    await ac.schedule(pending());
    clock.t = T0 + 2 * HOUR;
    await ac.tick();
    expect(events).toEqual([{ type: 'failed', pending: pending(), error: 'a sessão continua aberta num terminal' }]);
    expect(await ac.list()).toEqual([]);
  });

  it('cancelada enquanto confere a linha de parada: não manda', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ac, clock, sent, pending } = scheduler({ stopHit: async () => (await gate, null) });
    await ac.schedule(pending());
    clock.t = T0 + 2 * HOUR;
    const run = ac.tick();
    await ac.cancel('s1', 'user');
    release();
    await run;
    expect(sent).toEqual([]);
  });
});

// ---- ligação com a conversa ----

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

describe('ChatManager: limite de uso estourado', () => {
  let spawns: ReturnType<typeof fakeClaude>[];
  let resolved: Array<{ sessionId: string | null; staffId: string | null }>;
  let enabled: boolean;
  let skew: number;
  let manager: ChatManager;
  let ac: AutoContinue;
  let acFile: string;
  /** O que o servidor faz quando a conversa fica parada (onIdle); aqui, quem quiser espiar o instante. */
  let idleHook: ((sessionId: string, reason: string) => void) | null;

  beforeEach(() => {
    idleHook = null;
    spawns = [];
    resolved = [];
    enabled = true;
    skew = 0;
    acFile = path.join(root, `mgr-${++n}.json`);
    ac = new AutoContinue({
      file: acFile,
      enabled: async () => enabled,
      stopHit: async () => null,
      knownResets: async () => [],
      send: (p) => manager.continueChat(p.projectId, p.sessionId, p.staffId),
      now: () => Date.now() + skew,
      log: () => {},
    });
    manager = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, `usage-${n}.json`),
      listLive: async () => [],
      resolve: async (_p, sid, staffId) => {
        resolved.push({ sessionId: sid, staffId });
        return { sessionId: sid ?? 'sx', cwd: '.', args: ['--resume', sid ?? 'sx'] };
      },
      spawnImpl: () => {
        const f = fakeClaude();
        f.proc.stdin.on('finish', () => f.proc.emit('exit', 0));
        spawns.push(f);
        return f.proc as never;
      },
      autoContinue: ac,
      onIdle: (sid, _p, _s, reason) => idleHook?.(sid, reason),
      log: () => {},
    });
  });

  const limitNotices = async (sid = 'sx') =>
    (await manager.snapshot('p', sid)).live!.items.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice' && i.id.startsWith('n:limit:'));
  const reset = () => Math.floor((Date.now() + HOUR) / 1000);
  const hitLimit = async (f: ReturnType<typeof fakeClaude>, resetsAt = reset()) => {
    f.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' } });
    f.emit({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" });
    await settle();
    // O agendamento termina fora do fluxo do stream (disco): espera por ele em vez de apostar no tempo.
    await Promise.all(['sx', 'sy'].map((sid) => manager.awaitingLimit(sid)));
  };
  const continues = (f: ReturnType<typeof fakeClaude>) => f.written.filter((w) => w.type === 'user').map((w) => w.message?.content?.at(-1)?.text);

  it('agenda o "continue" para a hora do reset + 1 min e mostra o aviso com o botão Cancelar', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    const resetsAt = reset();
    await hitLimit(spawns[0]!, resetsAt);

    const pending = await ac.get('sx');
    expect(pending).toEqual({ projectId: 'p', sessionId: 'sx', staffId: 'ana', resetsAt: resetsAt * 1000, at: resetsAt * 1000 + SLACK_MS });
    const [notice] = await limitNotices();
    expect(notice).toMatchObject({ tone: 'warn', action: 'cancel-auto-continue', text: expect.stringMatching(/^Limite de uso atingido\. Continua sozinha (às \d\d:\d\d|dia \d\d\/\d\d às \d\d:\d\d)\.$/) });
  });

  it('na hora, manda "continue" na mesma conversa, com a ficha dela, e o aviso vira "Continuou sozinha"', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);

    await ac.tick(); // ainda cedo
    expect(continues(spawns[0]!)).toEqual(['faça X']);

    skew = 2 * HOUR;
    await ac.tick();
    await settle();
    expect(continues(spawns[0]!)).toEqual(['faça X', 'continue']);
    // Reabre com a ficha do funcionário, não como conversa avulsa.
    expect(resolved.at(-1)).toEqual({ sessionId: 'sx', staffId: 'ana' });
    const [notice] = await limitNotices();
    expect(notice).toMatchObject({ tone: 'info', text: expect.stringMatching(/^Continuou sozinha às \d\d:\d\d\.$/) });
    expect(notice!.action).toBeUndefined();
    expect(await ac.list()).toEqual([]);
  });

  it('com a conversa fechada, acorda o processo para mandar o "continue"', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    manager.stop('sx'); // fechou por inatividade
    await settle();

    skew = 2 * HOUR;
    await ac.tick();
    await settle();
    expect(spawns).toHaveLength(2);
    expect(continues(spawns[1]!)).toEqual(['continue']);
    // O aviso do processo novo conta que continuou (o do processo antigo ficou lá).
    expect(await limitNotices()).toMatchObject([{ tone: 'info', text: expect.stringMatching(/^Continuou sozinha /) }]);
  });

  it('o botão Cancelar tira a pendência e o aviso fica só com a hora que volta', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    expect(await manager.cancelAutoContinue('p', 'sx')).toBe(true);
    expect(await ac.get('sx')).toBeNull();
    const [notice] = await limitNotices();
    expect(notice!.text).toMatch(/^Limite de uso atingido\. Volta (às \d\d:\d\d|dia \d\d\/\d\d às \d\d:\d\d)\.$/);
    expect(notice!.action).toBeUndefined();

    skew = 2 * HOUR;
    await ac.tick();
    expect(continues(spawns[0]!)).toEqual(['faça X']);
    expect(await manager.cancelAutoContinue('p', 'sx')).toBe(false);
  });

  it('mensagem sua na conversa antes da hora cancela a pendência dela (e só dela)', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.send('p', 'sy', 'bia', 'faça Y');
    await hitLimit(spawns[0]!);
    await hitLimit(spawns[1]!);
    expect((await ac.list()).map((p) => p.sessionId).sort()).toEqual(['sx', 'sy']);

    await manager.sendFromUser('p', 'sx', 'ana', 'eu mesmo continuo');
    expect((await ac.list()).map((p) => p.sessionId)).toEqual(['sy']);
    const [notice] = await limitNotices();
    expect(notice!.text).toMatch(/^Limite de uso atingido\. Volta /);
    expect(notice!.action).toBeUndefined();

    skew = 2 * HOUR;
    await ac.tick();
    await settle();
    expect(continues(spawns[0]!)).toEqual(['faça X', 'eu mesmo continuo']);
    expect(continues(spawns[1]!)).toEqual(['faça Y', 'continue']);
  });

  it('opção desligada: só o aviso "Volta às…", sem botão e sem agendar nada', async () => {
    enabled = false;
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    expect(await ac.list()).toEqual([]);
    const [notice] = await limitNotices();
    expect(notice!.text).toMatch(/^Limite de uso atingido\. Volta /);
    expect(notice!.action).toBeUndefined();
  });

  it('o "continue" bate no limite de novo: reagenda para a hora nova, sem mandar de novo no mesmo minuto', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    skew = 2 * HOUR;
    await ac.tick();
    await settle();
    // O limite não tinha voltado: o claude rejeita outra vez, com a hora que ele diz agora.
    const again = Math.floor((Date.now() + skew) / 1000) + 1800;
    await hitLimit(spawns[0]!, again);
    expect(await ac.get('sx')).toMatchObject({ resetsAt: again * 1000, at: again * 1000 + SLACK_MS });

    await ac.tick();
    await settle();
    expect(continues(spawns[0]!)).toEqual(['faça X', 'continue']);
    expect(await limitNotices()).toHaveLength(2); // um aviso por estouro
  });

  it('sem hora no stream: usa o reset conhecido das janelas', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    const f = spawns[0]!;
    const known = Math.floor((Date.now() + 2 * HOUR) / 1000);
    f.emit({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 1, resetsAt: known } } } });
    f.emit({ type: 'assistant', isApiErrorMessage: true, message: { id: 'e', model: '<synthetic>', content: [{ type: 'text', text: 'Session limit reached' }] } });
    f.emit({ type: 'result', is_error: true, result: 'Session limit reached' });
    await settle();
    expect(await ac.get('sx')).toMatchObject({ resetsAt: known * 1000, at: known * 1000 + SLACK_MS });
  });

  it('sem hora no stream e sem janela conhecida: tenta de novo em 30 minutos', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    const before = Date.now();
    spawns[0]!.emit({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm (America/Sao_Paulo)" });
    await settle();
    const p = (await ac.get('sx'))!;
    expect(p.at).toBeGreaterThanOrEqual(before + 30 * 60_000);
    expect(p.at).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
  });

  it('o "continue" automático não cancela o que ele mesmo agendou, e mensagem de outro funcionário cancela', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    // Outro funcionário (pela API) mandou algo na conversa: também vale mais que o agendado.
    await manager.send('p', 'sx', 'ana', 'olha isto', undefined, [], [], true);
    expect(await ac.get('sx')).toBeNull();
  });

  it('awaitingLimit: já certo no instante do fim do turno, antes de o agendamento terminar', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    // Como o servidor liga as tarefas: o aviso "parou" sai junto do limite, e a pergunta sai dele na hora.
    let atIdle: Promise<boolean> | null = null;
    idleHook = (sid, reason) => {
      if (reason === 'turn') atIdle = manager.awaitingLimit(sid);
    };
    await hitLimit(spawns[0]!);
    expect(atIdle).not.toBeNull();
    expect(await atIdle).toBe(true);
    // O vigia de sessões vê o fim depois: a pendência em disco responde.
    expect(await manager.awaitingLimit('sx')).toBe(true);
    // Outra conversa, que não bateu no limite: não.
    expect(await manager.awaitingLimit('sy')).toBe(false);
  });

  it('awaitingLimit: falso com a opção desligada, com a pendência cancelada ou depois do "continue"', async () => {
    enabled = false;
    await manager.send('p', 'sx', 'ana', 'faça X');
    let atIdle: Promise<boolean> | null = null;
    idleHook = (sid, reason) => {
      if (reason === 'turn') atIdle = manager.awaitingLimit(sid);
    };
    await hitLimit(spawns[0]!);
    expect(await atIdle).toBe(false);

    enabled = true;
    await hitLimit(spawns[0]!);
    expect(await manager.awaitingLimit('sx')).toBe(true);
    await manager.cancelAutoContinue('p', 'sx');
    expect(await manager.awaitingLimit('sx')).toBe(false);

    await hitLimit(spawns[0]!);
    expect(await manager.awaitingLimit('sx')).toBe(true);
    skew = 2 * HOUR;
    await ac.tick(); // o "continue" saiu: a pendência foi embora
    await settle();
    expect(await manager.awaitingLimit('sx')).toBe(false);
  });

  // ---- o aviso sem o processo aberto ----

  const closedNotices = async (m: ChatManager = manager, sid = 'sx') =>
    (await m.snapshot('p', sid)).history.filter((i): i is Extract<ChatItem, { kind: 'notice' }> => i.kind === 'notice' && i.id.startsWith('n:limit:'));

  it('processo ocioso fechado: o snapshot recria o aviso a partir da pendência, com a mesma hora e o botão Cancelar', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    const [open] = await limitNotices();
    manager.stop('sx');
    await settle();

    const snap = await manager.snapshot('p', 'sx');
    expect(snap.live).toBeNull();
    expect(await closedNotices()).toEqual([expect.objectContaining({ tone: 'warn', action: 'cancel-auto-continue', text: open!.text })]);

    // Cancelar pela API, com a conversa ainda fechada: a pendência sai e o aviso não volta.
    expect(await manager.cancelAutoContinue('p', 'sx')).toBe(true);
    expect(await closedNotices()).toEqual([]);
  });

  it('sem pendência (nunca estourou, ou já continuou): o snapshot da conversa fechada não inventa aviso', async () => {
    expect(await closedNotices()).toEqual([]);
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    manager.stop('sx');
    await settle();
    skew = 2 * HOUR;
    await ac.tick(); // reabre e manda o "continue": a pendência sai
    await settle();
    expect(await ac.list()).toEqual([]);
    manager.stop('sx');
    await settle();
    expect(await closedNotices()).toEqual([]);
  });

  it('depois de reiniciar o servidor: a pendência em disco traz o aviso de volta', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    const [open] = await limitNotices();

    const ac2 = new AutoContinue({ file: acFile, enabled: async () => true, stopHit: async () => null, knownResets: async () => [], send: async () => {}, log: () => {} });
    const manager2 = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, `usage-${n}.json`),
      listLive: async () => [],
      resolve: async (_p, sid) => ({ sessionId: sid ?? 'sx', cwd: '.', args: [] }),
      autoContinue: ac2,
      log: () => {},
    });
    const snap = await manager2.snapshot('p', 'sx');
    expect(snap.live).toBeNull();
    expect(await closedNotices(manager2)).toEqual([expect.objectContaining({ action: 'cancel-auto-continue', text: open!.text })]);
  });

  it('reabrir o processo recria o aviso a partir da pendência (sem tirar a pendência)', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    const [before] = await limitNotices();
    manager.stop('sx');
    await settle();

    await manager.continueChat('p', 'sx', 'ana'); // qualquer coisa que reabra o processo sem ser mensagem sua
    expect(spawns).toHaveLength(2);
    const [after, ...rest] = await limitNotices();
    expect(rest).toEqual([]);
    expect(after).toMatchObject({ tone: 'warn', action: 'cancel-auto-continue', text: before!.text });
    expect(await ac.get('sx')).not.toBeNull();

    // Mensagem sua no processo reaberto: cancela, e o aviso perde o botão.
    await manager.sendFromUser('p', 'sx', 'ana', 'eu mesmo');
    const [mine] = await limitNotices();
    expect(mine!.text).toMatch(/^Limite de uso atingido\. Volta /);
    expect(mine!.action).toBeUndefined();
  });

  // ---- teto de tentativas ----

  it('5 estouros seguidos: desiste, avisa com failed (a tarefa é entregue) e deixa o aviso sem botão', async () => {
    const failed: AutoContinueEvent[] = [];
    ac.subscribe((e) => void (e.type === 'failed' && failed.push(e)));
    await manager.send('p', 'sx', 'ana', 'faça X');
    const f = spawns[0]!;
    for (let i = 1; i <= 4; i++) {
      await hitLimit(f);
      expect(await ac.get('sx')).not.toBeNull();
      skew += 2 * HOUR;
      await ac.tick();
      await settle();
    }
    expect(continues(f)).toEqual(['faça X', 'continue', 'continue', 'continue', 'continue']);
    expect(failed).toEqual([]);

    await hitLimit(f); // a quinta
    expect(failed).toEqual([
      { type: 'failed', pending: expect.objectContaining({ projectId: 'p', sessionId: 'sx', staffId: 'ana' }), error: expect.stringMatching(/estourou 5 vezes seguidas/), gaveUp: true },
    ]);
    expect(await ac.get('sx')).toBeNull();
    expect(await manager.awaitingLimit('sx')).toBe(false); // a tarefa não fica presa em "fazendo"
    const last = (await limitNotices()).at(-1)!;
    expect(last).toMatchObject({ tone: 'warn', text: 'Não deu para continuar sozinha depois de várias tentativas; mande uma mensagem quando quiser.' });
    expect(last.action).toBeUndefined();

    skew += 2 * HOUR;
    await ac.tick();
    await settle();
    expect(continues(f)).toHaveLength(5); // nenhum "continue" a mais

    // A conta recomeça: um novo estouro, depois de uma mensagem sua, volta a agendar.
    await hitLimit(f);
    expect(await ac.get('sx')).not.toBeNull();
    expect(failed).toHaveLength(1);
  });

  it('turno normal zera a conta dos estouros seguidos', async () => {
    const failed: AutoContinueEvent[] = [];
    ac.subscribe((e) => void (e.type === 'failed' && failed.push(e)));
    await manager.send('p', 'sx', 'ana', 'faça X');
    const f = spawns[0]!;
    for (let i = 0; i < 4; i++) await hitLimit(f);
    f.emit({ type: 'result', is_error: false, result: 'pronto' });
    await settle();
    for (let i = 0; i < 4; i++) await hitLimit(f);
    expect(failed).toEqual([]);
    expect(await ac.get('sx')).not.toBeNull();
    await hitLimit(f); // a quinta seguida desde o turno normal
    expect(failed).toHaveLength(1);
  });

  it('o teto é por conversa: estouros em duas conversas não se somam', async () => {
    const failed: AutoContinueEvent[] = [];
    ac.subscribe((e) => void (e.type === 'failed' && failed.push(e)));
    await manager.send('p', 'sx', 'ana', 'faça X');
    await manager.send('p', 'sy', 'bia', 'faça Y');
    for (let i = 0; i < 3; i++) {
      await hitLimit(spawns[0]!);
      await hitLimit(spawns[1]!);
    }
    expect(failed).toEqual([]);
  });

  // ---- opção desligada no meio ----

  it('opção desligada no meio da espera: a pendência sai na hora e o aviso perde o botão e vira "Volta às…"', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    expect((await limitNotices())[0]!.action).toBe('cancel-auto-continue');

    enabled = false;
    await ac.tick(); // bem antes da hora: o temporizador percebe a opção desligada
    expect(await ac.list()).toEqual([]);
    const [notice] = await limitNotices();
    expect(notice!.text).toMatch(/^Limite de uso atingido\. Volta (às \d\d:\d\d|dia \d\d\/\d\d às \d\d:\d\d)\.$/);
    expect(notice!.action).toBeUndefined();
    expect(await manager.awaitingLimit('sx')).toBe(false);
    expect(continues(spawns[0]!)).toEqual(['faça X']);
  });

  // ---- cancelar de outro projeto, e a hora de cada aviso ----

  it('cancelar com o projeto errado: recusa (a rota responde 404) e a pendência e o aviso ficam', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    await hitLimit(spawns[0]!);
    expect(await manager.cancelAutoContinue('outro', 'sx')).toBeNull();
    expect(await ac.get('sx')).not.toBeNull();
    expect((await limitNotices())[0]!.action).toBe('cancel-auto-continue');

    expect(await manager.cancelAutoContinue('p', 'nenhuma')).toBe(false);
    expect(await manager.cancelAutoContinue('p', 'sx')).toBe(true);
  });

  it('cada aviso guarda a própria hora: o estouro novo não reescreve o anterior com a hora dele', async () => {
    await manager.send('p', 'sx', 'ana', 'faça X');
    const first = reset();
    const second = first + 3 * 3600;
    await hitLimit(spawns[0]!, first);
    await hitLimit(spawns[0]!, second);

    const [old, current] = await limitNotices();
    expect(old!.text).toBe(limitNotice.back(first * 1000, Date.now()));
    expect(old!.action).toBeUndefined();
    expect(current!.text).toBe(limitNotice.waiting(second * 1000, Date.now()));
    expect(current!.action).toBe('cancel-auto-continue');

    await manager.cancelAutoContinue('p', 'sx');
    const [old2, current2] = await limitNotices();
    expect(old2!.text).toBe(old!.text);
    expect(current2!.text).toBe(limitNotice.back(second * 1000, Date.now()));
  });
});

describe('config: autoContinue', () => {
  it('vem ligado por padrão, grava e lê desligado, e valor estranho volta ao padrão', async () => {
    const file = path.join(root, 'cfg-ac', 'config.json');
    expect((await readConfig(file)).autoContinue).toBe(true);
    expect((await updateConfig({ autoContinue: false }, file)).autoContinue).toBe(false);
    expect((await readConfig(file)).autoContinue).toBe(false);
    expect((await updateConfig({ autoContinue: true }, file)).autoContinue).toBe(true);
    await fs.writeFile(file, JSON.stringify({ autoContinue: 'talvez' }));
    expect((await readConfig(file)).autoContinue).toBe(true);
  });
});
