import os from 'node:os';
import type { SystemStats } from '../shared/model';

// Monitor do canto (CPU e RAM da máquina inteira, não só do Claudio’s Club): só números do sistema, lidos pelo `os`
// do Node, sem rodar outro programa. A CPU é o uso entre duas leituras; o monitor pede a cada 5 s.

export interface CpuSample {
  /** Soma, em todos os núcleos, do tempo ocioso e do tempo total (ms). */
  idle: number;
  total: number;
  at: number;
}

export function cpuSample(cpus = os.cpus(), at = Date.now()): CpuSample {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total, at };
}

/** Uso entre duas leituras, 0–100; sem tempo entre elas, null. */
export function cpuPercent(prev: CpuSample, next: CpuSample): number | null {
  const total = next.total - prev.total;
  if (total <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (1 - (next.idle - prev.idle) / total) * 100)));
}

/** Leituras com menos de 1 s entre si (duas abas abertas) repetem o último valor, em vez de um número aos saltos. */
const MIN_GAP_MS = 1000;
let last = cpuSample();
let lastCpu: number | null = null;

export function systemStats(): SystemStats {
  const now = cpuSample();
  if (now.at - last.at >= MIN_GAP_MS) {
    lastCpu = cpuPercent(last, now) ?? lastCpu;
    last = now;
  }
  return { cpu: lastCpu, memTotal: os.totalmem(), memFree: os.freemem() };
}
