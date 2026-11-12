import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { AppConfig } from '../shared/model';
import { cpuPercent, cpuSample, type CpuSample } from './systemStats';

// Gate de recursos da fila de tarefas: o início automático da próxima tarefa espera RAM livre (e CPU, se ligada) e
// o teto de conversas rodando. Só a partida automática passa por aqui; começar à mão ignora (ver tasks.ts).

/** A CPU é amostrada a cada 5 s; a média vale nos últimos 2 min. */
const SAMPLE_MS = 5_000;
const CPU_WINDOW_MS = 2 * 60_000;
/** CPU média a partir de 90% segura o início; só libera abaixo de 75% (histerese). */
const CPU_BLOCK = 90;
const CPU_RELEASE = 75;
/** Depois de segurar pela RAM, só libera com a reserva × 1,25 de folga. */
const RAM_RELEASE = 1.25;
/** Quanto uma partida ainda em andamento deve ocupar de RAM (estimativa): as que chegam juntas não leem a mesma folga. */
const START_RAM_GB = 0.5;
const GB = 1024 ** 3;

/** Os campos do AppConfig que o gate lê. */
export type GateConfig = Pick<AppConfig, 'resourceGate' | 'minFreeRamGb' | 'cpuGate' | 'maxActiveChats'>;

/** O que o gate está segurando agora. A decisão seguinte parte daqui (histerese). */
export interface GateHold {
  ram: boolean;
  cpu: boolean;
}

export interface AdmitInput {
  config: GateConfig;
  /** RAM disponível agora, em GB (null = não sabemos: não segura). */
  freeRamGb: number | null;
  /** Média da CPU na janela de 2 min, 0–100 (null = janela incompleta ou sem leitura: não segura). */
  cpuAvg: number | null;
  /** Conversas trabalhando agora (null = não sabemos: o teto não segura). */
  activeTurns: number | null;
  /** Partidas reservadas e ainda não terminadas (ver ResourceGate.reserve). */
  reserved: number;
  /** O que o gate segurava na decisão anterior. */
  prev: GateHold;
}

export type GateVerdict = { ok: true; hold: GateHold } | { ok: false; reason: string; hold: GateHold };

/** GB em pt-BR, com até 2 casas: 1.5 → "1,5". */
const gb = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');

/**
 * A decisão do gate, sem efeito. RAM: segura abaixo da reserva, e só libera com a folga de 1,25×. CPU (se `cpuGate`): segura
 * a partir de 90%, só libera abaixo de 75%. Teto: conversas rodando mais as reservadas. Sem dado (null) não segura, e
 * `minFreeRamGb` 0 não olha a RAM. Gate desligado: sempre ok.
 */
export function admit(input: AdmitInput): GateVerdict {
  const { config: c, prev, freeRamGb: free, cpuAvg: cpuNow, activeTurns: active } = input;
  if (!c.resourceGate) return { ok: true, hold: { ram: false, cpu: false } };
  const ramLimit = c.minFreeRamGb * (prev.ram ? RAM_RELEASE : 1);
  const ram = free !== null && free < ramLimit;
  const cpu = c.cpuGate && cpuNow !== null && cpuNow >= (prev.cpu ? CPU_RELEASE : CPU_BLOCK);
  const hold = { ram, cpu };
  if (ram) return { ok: false, reason: `RAM disponível ${gb(free!)} GB (reserva ${gb(c.minFreeRamGb)} GB)`, hold };
  if (cpu) return { ok: false, reason: `CPU média ${Math.round(cpuNow!)}% nos últimos 2 min`, hold };
  if (c.maxActiveChats > 0 && active !== null) {
    const busy = active + input.reserved;
    if (busy >= c.maxActiveChats) {
      const n = busy === 1 ? '1 conversa rodando' : `${busy} conversas rodando`;
      return { ok: false, reason: `${n} (teto ${c.maxActiveChats})`, hold };
    }
  }
  return { ok: true, hold };
}

/** MemAvailable, em bytes, do texto de /proc/meminfo; null se não está lá. */
export function parseMemAvailable(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * RAM disponível agora, em bytes; null se não der para ler. No Linux, MemAvailable: o os.freemem() não conta o cache e dá
 * um falso "cheio". Nos outros sistemas, e se o /proc falhar, o os.freemem().
 */
export async function freeRamBytes(): Promise<number | null> {
  if (process.platform === 'linux') {
    const meminfo = await fs.readFile('/proc/meminfo', 'utf8').catch(() => null);
    const avail = meminfo === null ? null : parseMemAvailable(meminfo);
    if (avail !== null) return avail;
  }
  const free = os.freemem();
  return Number.isFinite(free) && free >= 0 ? free : null;
}

export interface ResourceGateDeps {
  /** A config agora (lida a cada decisão). */
  config: () => Promise<GateConfig>;
  /** Conversas trabalhando agora, em todos os projetos (ChatManager.activeTurns). */
  activeTurns: () => number;
  /** RAM disponível em bytes (padrão: freeRamBytes). */
  freeRam?: () => Promise<number | null>;
  /** Relógio (padrão: Date.now). */
  now?: () => number;
}

/** Ok: `release` ao terminar a partida (sempre, inclusive em erro). Segurada: o motivo. */
export type Reservation = { ok: true; release: () => void } | { ok: false; reason: string };

interface CpuPoint {
  at: number;
  pct: number;
}

export class ResourceGate {
  private last: CpuSample | null = null;
  /** Primeira amostra de CPU: a janela só vale cheia depois de ~2 min daqui. */
  private since: number | null = null;
  private readonly points: CpuPoint[] = [];
  private hold: GateHold = { ram: false, cpu: false };
  /** Partidas reservadas e ainda não terminadas: contam no teto, mesmo as que ainda leem a config. */
  private inFlight = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ResourceGateDeps) {}

  /** Liga a coleta de CPU (a cada 5 s, sem segurar o processo). Uma vez, no boot. */
  start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    this.timer.unref();
  }

  /** Uma amostra de CPU: o uso desde a anterior entra na janela. Sem `s`, lê a máquina agora. */
  sample(s: CpuSample = cpuSample()): void {
    const prev = this.last;
    this.last = s;
    const pct = prev ? cpuPercent(prev, s) : null;
    if (pct === null) return;
    if (this.since === null) this.since = s.at;
    this.points.push({ at: s.at, pct });
    while (this.points[0] && this.points[0].at < s.at - CPU_WINDOW_MS) this.points.shift();
  }

  /** Média da CPU nos últimos 2 min; null se a janela ainda não tem ~2 min de amostras (ou nenhuma). */
  cpuAverage(now: number): number | null {
    // Cheia = ~2 min de amostras; um intervalo de folga, para o timer atrasar sem travar o gate.
    if (this.since === null || now - this.since < CPU_WINDOW_MS - SAMPLE_MS) return null;
    const recent = this.points.filter((p) => p.at >= now - CPU_WINDOW_MS);
    if (recent.length === 0) return null;
    return recent.reduce((sum, p) => sum + p.pct, 0) / recent.length;
  }

  /**
   * Pede para começar uma partida. Ok: chame `release` quando ela terminar (ou falhar). A partida já conta no teto desde o
   * início da leitura, então duas que chegam juntas não passam pela mesma leitura.
   */
  async reserve(): Promise<Reservation> {
    const others = this.inFlight;
    this.inFlight++;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.inFlight--;
    };
    try {
      const verdict = await this.decide(others);
      if (!verdict.ok) {
        release();
        return { ok: false, reason: verdict.reason };
      }
      return { ok: true, release };
    } catch (err) {
      release();
      throw err;
    }
  }

  private async decide(reserved: number): Promise<GateVerdict> {
    const [config, bytes] = await Promise.all([this.deps.config(), (this.deps.freeRam ?? freeRamBytes)()]);
    const now = (this.deps.now ?? Date.now)();
    const verdict = admit({
      config,
      freeRamGb: bytes === null ? null : Math.max(0, bytes / GB - reserved * START_RAM_GB),
      cpuAvg: this.cpuAverage(now),
      activeTurns: this.deps.activeTurns(),
      reserved,
      prev: this.hold,
    });
    this.hold = verdict.hold;
    return verdict;
  }
}
