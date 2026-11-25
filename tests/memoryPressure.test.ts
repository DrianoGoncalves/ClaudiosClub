import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ChatManager } from '../server/chat/manager';
import { idleTaskChats, makeRoom, MEMORY_PRESSURE_IDLE_MS, pickIdleForMemory, ROOM_CLOSE_MAX, stillShort, TASK_CHAT_IDLE_MS, type MemoryReading, type ReapCandidate } from '../server/chat/memoryPressure';

// Falta memória: a conversa parada há mais tempo fecha sem esperar os 15 min. Em 25/11/2026, 7 conversas abertas (4 paradas) numa máquina de 8 GB faziam o
// Windows paginar sem parar.

const NOW = 1_800_000_000_000;
const chat = (sessionId: string, idleMin: number, o: Partial<ReapCandidate> = {}): ReapCandidate => ({ sessionId, running: true, working: false, lastActivity: NOW - idleMin * 60_000, ...o });

describe('pickIdleForMemory', () => {
  it('fecha a parada há mais tempo', () => {
    expect(pickIdleForMemory([chat('a', 5), chat('b', 12), chat('c', 3)], NOW)?.sessionId).toBe('b');
  });

  it('nunca a que trabalha (turno, pergunta ou permissão pendente, tarefa em segundo plano), a que já fechou nem a que está fechando', () => {
    expect(pickIdleForMemory([chat('a', 30, { working: true }), chat('b', 20, { running: false }), chat('d', 25, { isClosing: true }), chat('c', 4)], NOW)?.sessionId).toBe('c');
    expect(pickIdleForMemory([chat('a', 30, { working: true })], NOW)).toBeNull();
  });

  it('a que acabou de responder fica (o dono pode estar lendo): só fecha parada há mais de 2 min', () => {
    expect(MEMORY_PRESSURE_IDLE_MS).toBe(2 * 60_000);
    expect(pickIdleForMemory([chat('a', 1), chat('b', 1.9)], NOW)).toBeNull();
    expect(pickIdleForMemory([chat('a', 1), chat('b', 2.1)], NOW)?.sessionId).toBe('b');
  });
});

describe('idleTaskChats: conversa de tarefa parada fecha em 2 min', () => {
  const tasks = new Set(['t-work', 't-review']);
  const isTask = async (sid: string) => tasks.has(sid);

  it('só as de tarefa, paradas há mais de 2 min; a sua (e a de card automático) seguem com os 15 min', async () => {
    expect(TASK_CHAT_IDLE_MS).toBe(2 * 60_000);
    const out = await idleTaskChats([chat('t-work', 3), chat('t-review', 10), chat('dono', 10), chat('t-x', 1)], NOW, async (s) => tasks.has(s) || s === 't-x');
    expect(out.map((c) => c.sessionId)).toEqual(['t-work', 't-review']); // t-x é de tarefa, mas parada há só 1 min
  });

  it('nunca a que trabalha ou já está fechando; erro ao consultar o quadro conta como "não é" (fica)', async () => {
    const out = await idleTaskChats([chat('t-work', 30, { working: true }), chat('t-review', 30, { isClosing: true })], NOW, isTask);
    expect(out).toEqual([]);
    expect(await idleTaskChats([chat('t-work', 30)], NOW, async () => Promise.reject(new Error('quadro')))).toEqual([]);
  });
});

describe('makeRoom: antes de abrir uma conversa nova', () => {
  const GB = 1024 ** 3;
  /** Conversas falsas: fechar uma devolve `per` GB à memória livre. */
  function world(freeGb: number, minGb: number, list: ReapCandidate[], per = 0.6) {
    let free = freeGb;
    const chats = list.map((c) => {
      const me = {
        ...c,
        stopAndWait: async () => {
          me.running = false;
          free += per;
        },
      };
      return me;
    });
    const memory = async (): Promise<MemoryReading> => ({ freeBytes: free * GB, minBytes: minGb * GB });
    return { chats: () => chats.filter((c) => c.running), memory, list };
  }

  it('memória sobrando: não fecha nada', async () => {
    const w = world(3, 1.5, [chat('a', 30)]);
    const r = await makeRoom(w.chats, w.memory, { now: () => NOW, settleMs: 0 });
    expect(r.closed).toEqual([]);
    expect(stillShort(r.reading)).toBe(false);
  });

  it('falta memória: fecha a parada há mais tempo e para quando a memória volta', async () => {
    const w = world(1.2, 1.5, [chat('a', 5), chat('b', 20), chat('c', 10)]);
    const r = await makeRoom(w.chats, w.memory, { now: () => NOW, settleMs: 0 });
    expect(r.closed).toEqual(['b']); // 1,2 + 0,6 = 1,8 GB: já basta
    expect(stillShort(r.reading)).toBe(false);
  });

  it(`fecha no máximo ${ROOM_CLOSE_MAX} por abertura; sem parada que possa sair, abre assim mesmo e diz que ainda falta`, async () => {
    const w = world(0.2, 1.5, [chat('a', 5), chat('b', 20), chat('c', 10), chat('d', 40)]);
    const r = await makeRoom(w.chats, w.memory, { now: () => NOW, settleMs: 0 });
    expect(r.closed).toEqual(['d', 'b']);
    expect(stillShort(r.reading)).toBe(true);
    const busy = world(0.5, 1.5, [chat('x', 30, { working: true })]);
    const r2 = await makeRoom(busy.chats, busy.memory, { now: () => NOW, settleMs: 0 });
    expect(r2.closed).toEqual([]);
    expect(stillShort(r2.reading)).toBe(true);
  });

  it('regra desligada ou leitura que falha: não fecha nada e nunca lança', async () => {
    const w = world(0.1, 1.5, [chat('a', 30)]);
    expect((await makeRoom(w.chats, async () => null, { now: () => NOW, settleMs: 0 })).closed).toEqual([]);
    const r = await makeRoom(w.chats, async () => Promise.reject(new Error('wmi')), { now: () => NOW, settleMs: 0 });
    expect(r).toEqual({ closed: [], reading: null });
  });
});

describe('ligação no servidor', () => {
  it('a rodada do reap (a cada minuto) também fecha por memória, uma conversa por vez, com o mínimo da config', async () => {
    const manager = await fs.readFile(path.join(__dirname, '..', 'server', 'chat', 'manager.ts'), 'utf8');
    const reap = manager.slice(manager.indexOf('private reap()'), manager.indexOf('private reapingMemory'));
    expect(reap).toContain('void this.reapAsync();');
    const async = manager.slice(manager.indexOf('private async reapAsync()'), manager.indexOf('private async reapTaskChats()'));
    expect(async.indexOf('await this.reapTaskChats();')).toBeLessThan(async.indexOf('await this.reapForMemory();'));
    const fn = manager.slice(manager.indexOf('private async reapForMemory()'));
    expect(fn).toContain('if (!m || m.freeBytes >= m.minBytes) return;');
    expect(fn).toContain('const victim = pickIdleForMemory(this.claudeChats(), now);');
    expect((fn.match(/\.stop\(\)/g) ?? []).length).toBe(1);
    const index = await fs.readFile(path.join(__dirname, '..', 'server', 'index.ts'), 'utf8');
    expect(index).toContain('c.resourceGate && c.minFreeRamGb > 0 ? { freeBytes: os.freemem(), minBytes: c.minFreeRamGb * 1024 ** 3 } : null');
  });
});

describe('ChatManager: abrir enquanto outra coisa mexe na mesma conversa', () => {
  /** Processo falso do claude: guarda o que recebe no stdin e sai `exitMs` depois que o stdin termina (o fechamento leva tempo, como no Windows). */
  function fake(exitMs: number) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), pid: 4242, exitCode: null, signalCode: null, kill: () => proc.emit('exit', 0) });
    const texts: string[] = [];
    stdin.on('data', (d: Buffer) =>
      d.toString().split('\n').filter(Boolean).forEach((l) => {
        const ev = JSON.parse(l) as { type?: string; message?: { content?: Array<{ text?: string }> } };
        for (const c of ev.message?.content ?? []) if (c.text) texts.push(c.text);
        // Responde e termina o turno: a conversa fica parada, como de verdade depois da resposta.
        if (ev.type === 'user') setImmediate(() => stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\n'));
      }),
    );
    stdin.on('finish', () => setTimeout(() => proc.emit('exit', 0), exitMs));
    return { proc, texts };
  }
  async function boot(exitMs = 150, memory?: () => Promise<MemoryReading>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-mempress-'));
    const spawns: Array<ReturnType<typeof fake>> = [];
    const resolved: Array<string | null> = [];
    let n = 0;
    const manager = new ChatManager({
      transcriptsDir: root,
      usageFile: path.join(root, 'usage.json'),
      listLive: async () => [],
      resolve: async (_p, sid) => {
        resolved.push(sid);
        const id = sid ?? `s${++n}`;
        return { sessionId: id, cwd: '.', args: ['--resume', id] };
      },
      spawnImpl: () => {
        const f = fake(exitMs);
        spawns.push(f);
        return f.proc as never;
      },
      stopGraceMs: 5_000,
      memory,
      log: () => {},
    });
    const chats = (manager as unknown as { chats: Map<string, { running: boolean; lastActivity: number; stop(): void }> }).chats;
    return { manager, spawns, resolved, chats, root };
  }
  const GB = 1024 ** 3;
  const short: () => Promise<MemoryReading> = async () => ({ freeBytes: 0.8 * GB, minBytes: 1.5 * GB });

  it('revisão nova com a memória curta: recusa com "aguardando memória" antes de preparar a conversa (nada de sessão-fantasma na ficha do revisor)', async () => {
    const { manager, spawns, resolved, root } = await boot(150, short);
    await expect(manager.send('p', null, 'rev-1', 'revise', undefined, [], [], false, undefined, undefined, true)).rejects.toThrow(/aguardando memória livre/);
    expect(resolved).toEqual([]);
    expect(spawns).toHaveLength(0);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('conversa sua com a memória curta: fecha antes a parada há mais tempo e abre do mesmo jeito', async () => {
    const { manager, spawns, chats, root } = await boot(50, short);
    await manager.send('p', null, null, 'velha');
    const old = chats.get('s1')! as unknown as { running: boolean; working: boolean; lastActivity: number };
    await vi.waitFor(() => expect(old.working).toBe(false)); // o turno terminou
    old.lastActivity = Date.now() - 10 * 60_000; // parada há 10 min
    await manager.send('p', null, null, 'nova');
    expect(old.running).toBe(false); // a parada saiu para abrir espaço
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.texts).toEqual(['nova']);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }, 20_000);

  it('mensagem para a conversa que está fechando espera o processo sair e reabre: nada é escrito no que está morrendo', async () => {
    const { manager, spawns, chats, root } = await boot();
    await manager.send('p', null, null, 'primeira');
    expect(spawns).toHaveLength(1);
    // Fecha (como o reap ou a memória fariam): o processo ainda leva 150 ms para sair.
    chats.get('s1')!.stop();
    await manager.send('p', 's1', null, 'segunda');
    expect(spawns).toHaveLength(2);
    expect(spawns[0]!.texts).toEqual(['primeira']);
    expect(spawns[1]!.texts).toEqual(['segunda']);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it('duas aberturas ao mesmo tempo da mesma conversa fechada dividem um processo só (sem órfão)', async () => {
    const { manager, spawns, root } = await boot();
    await Promise.all([manager.send('p', 'sy', null, 'a'), manager.send('p', 'sy', null, 'b')]);
    expect(spawns).toHaveLength(1);
    expect([...spawns[0]!.texts].sort()).toEqual(['a', 'b']);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
});
