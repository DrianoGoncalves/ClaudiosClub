import { describe, expect, it } from 'vitest';
import { admit, freeRamBytes, parseMemAvailable, ResourceGate, type AdmitInput, type GateConfig, type Reservation } from '../server/resourceGate';
import type { CpuSample } from '../server/systemStats';

const GB = 1024 ** 3;
const ON: GateConfig = { resourceGate: true, minFreeRamGb: 1.5, cpuGate: false, maxActiveChats: 0 };
const NONE = { ram: false, cpu: false };
const input = (over: Partial<AdmitInput> = {}): AdmitInput => ({ config: ON, freeRamGb: 8, cpuAvg: null, activeTurns: 0, reserved: 0, prev: NONE, ...over });

describe('gate de recursos: decisão (admit)', () => {
  it('RAM: segura abaixo da reserva; a reserva exata passa', () => {
    expect(admit(input({ freeRamGb: 1.2 }))).toEqual({ ok: false, reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)', hold: { ram: true, cpu: false } });
    expect(admit(input({ freeRamGb: 1.5 }))).toEqual({ ok: true, hold: NONE });
  });

  it('RAM: depois de segurar, só libera com a reserva × 1,25', () => {
    const held = { ram: true, cpu: false };
    expect(admit(input({ freeRamGb: 1.6, prev: held }))).toMatchObject({ ok: false, hold: held });
    expect(admit(input({ freeRamGb: 1.874, prev: held }))).toMatchObject({ ok: false });
    expect(admit(input({ freeRamGb: 1.875, prev: held }))).toEqual({ ok: true, hold: NONE });
  });

  it('sem dado (null) não segura; reserva 0 não olha a RAM', () => {
    expect(admit(input({ freeRamGb: null }))).toEqual({ ok: true, hold: NONE });
    expect(admit(input({ freeRamGb: 0.01, config: { ...ON, minFreeRamGb: 0 } }))).toEqual({ ok: true, hold: NONE });
  });

  it('CPU: só com cpuGate ligado; segura a partir de 90% e só libera abaixo de 75%', () => {
    const on = { ...ON, cpuGate: true };
    expect(admit(input({ cpuAvg: 99 }))).toEqual({ ok: true, hold: NONE });
    expect(admit(input({ cpuAvg: 94.6, config: on }))).toEqual({ ok: false, reason: 'CPU média 95% nos últimos 2 min', hold: { ram: false, cpu: true } });
    expect(admit(input({ cpuAvg: 89, config: on }))).toEqual({ ok: true, hold: NONE });
    const held = { ram: false, cpu: true };
    expect(admit(input({ cpuAvg: 80, config: on, prev: held }))).toMatchObject({ ok: false, hold: held });
    expect(admit(input({ cpuAvg: 74, config: on, prev: held }))).toEqual({ ok: true, hold: NONE });
    expect(admit(input({ cpuAvg: 99, prev: held }))).toEqual({ ok: true, hold: NONE });
  });

  it('CPU com janela incompleta (null) não segura', () => {
    expect(admit(input({ cpuAvg: null, config: { ...ON, cpuGate: true } }))).toEqual({ ok: true, hold: NONE });
  });

  it('teto: conversas rodando mais as reservadas; 0 = sem teto; sem leitura não segura', () => {
    const cap = { ...ON, maxActiveChats: 3 };
    expect(admit(input({ config: cap, activeTurns: 2, reserved: 1 }))).toEqual({ ok: false, reason: '3 conversas rodando (teto 3)', hold: NONE });
    expect(admit(input({ config: cap, activeTurns: 2, reserved: 0 }))).toEqual({ ok: true, hold: NONE });
    expect(admit(input({ config: { ...cap, maxActiveChats: 1 }, activeTurns: 1 }))).toMatchObject({ ok: false, reason: '1 conversa rodando (teto 1)' });
    expect(admit(input({ activeTurns: 99 }))).toEqual({ ok: true, hold: NONE });
    expect(admit(input({ config: cap, activeTurns: null }))).toEqual({ ok: true, hold: NONE });
  });

  it('gate desligado: sempre ok, mesmo com tudo estourado', () => {
    const off = { resourceGate: false, minFreeRamGb: 64, cpuGate: true, maxActiveChats: 1 };
    expect(admit(input({ config: off, freeRamGb: 0.1, cpuAvg: 100, activeTurns: 5, prev: { ram: true, cpu: true } }))).toEqual({ ok: true, hold: NONE });
  });
});

describe('/proc/meminfo', () => {
  it('lê MemAvailable (kB → bytes); sem a linha, null', () => {
    const meminfo = 'MemTotal:       16273460 kB\nMemFree:          812344 kB\nMemAvailable:    9876543 kB\nBuffers:          412000 kB\n';
    expect(parseMemAvailable(meminfo)).toBe(9876543 * 1024);
    expect(parseMemAvailable('MemTotal:       16273460 kB\nMemFree:          812344 kB\n')).toBeNull();
  });

  it('a leitura da máquina devolve um número positivo (Linux ou fallback)', async () => {
    expect(await freeRamBytes()).toBeGreaterThan(0);
  });
});

/** Relógio de CPU falso: cada passo de 5 s gasta `pct`% da CPU. Devolve o instante final (ms). */
function cpuClock(gate: ResourceGate) {
  let s: CpuSample = { idle: 0, total: 0, at: 0 };
  gate.sample(s);
  return (pct: number, steps: number): number => {
    for (let i = 0; i < steps; i++) {
      s = { idle: s.idle + (100 - pct), total: s.total + 100, at: s.at + 5_000 };
      gate.sample(s);
    }
    return s.at;
  };
}

/** Gate com RAM fixa (8 GB, para não depender da máquina) e a config dada. */
function gateWith(config: Partial<GateConfig> = {}, activeTurns = () => 0) {
  return new ResourceGate({ config: async () => ({ ...ON, ...config }), activeTurns, freeRam: async () => 8 * GB });
}

/** A partida passou (lança se o gate segurou, para o teste ler o erro). */
function admitted(r: Reservation): { ok: true; release: () => void } {
  if (!r.ok) throw new Error(`segurada: ${r.reason}`);
  return r;
}

describe('ResourceGate: coleta, reserva e liberação', () => {
  it('média de CPU: só com ~2 min de amostras, e só dos últimos 2 min', () => {
    const gate = gateWith({ cpuGate: true });
    const run = cpuClock(gate);
    const t1 = run(20, 12); // 1 min a 20%: a janela ainda não está cheia
    expect(gate.cpuAverage(t1)).toBeNull();
    const t2 = run(95, 30); // 2,5 min a 95%: a média é só do que está nos últimos 2 min
    expect(gate.cpuAverage(t2)).toBe(95);
  });

  it('RAM pelo gate: a leitura de agora, com a histerese entre uma partida e outra', async () => {
    let free = 1.2 * GB;
    const gate = new ResourceGate({ config: async () => ON, activeTurns: () => 0, freeRam: async () => free });
    expect(await gate.reserve()).toEqual({ ok: false, reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)' });
    free = 1.6 * GB;
    expect(await gate.reserve()).toMatchObject({ ok: false });
    free = 1.9 * GB;
    expect((await gate.reserve()).ok).toBe(true);
  });

  it('teto: a partida conta até soltar; soltar duas vezes não conta a mais', async () => {
    const gate = gateWith({ maxActiveChats: 1 });
    const a = admitted(await gate.reserve());
    expect(await gate.reserve()).toEqual({ ok: false, reason: '1 conversa rodando (teto 1)' });
    a.release();
    const c = admitted(await gate.reserve());
    a.release(); // de novo: não tira a partida c da conta
    expect(await gate.reserve()).toEqual({ ok: false, reason: '1 conversa rodando (teto 1)' });
    c.release();
    expect((await gate.reserve()).ok).toBe(true);
  });

  it('duas partidas que chegam juntas: a segunda vê a primeira no teto', async () => {
    const gate = gateWith({ maxActiveChats: 1 });
    const [x, y] = await Promise.all([gate.reserve(), gate.reserve()]);
    expect(x.ok).toBe(true);
    expect(y).toEqual({ ok: false, reason: '1 conversa rodando (teto 1)' });
  });

  it('erro na leitura: a partida não fica contada, e o gate segue', async () => {
    let fail = true;
    const gate = new ResourceGate({
      config: async () => {
        if (fail) {
          fail = false;
          throw new Error('config ilegível');
        }
        return { ...ON, maxActiveChats: 1 };
      },
      activeTurns: () => 0,
      freeRam: async () => 8 * GB,
    });
    await expect(gate.reserve()).rejects.toThrow('config ilegível');
    expect((await gate.reserve()).ok).toBe(true); // a que falhou não ficou contada
    expect(await gate.reserve()).toEqual({ ok: false, reason: '1 conversa rodando (teto 1)' });
  });
});
