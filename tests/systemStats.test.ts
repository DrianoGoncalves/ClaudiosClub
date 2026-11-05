import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { cpuPercent, cpuSample, systemStats } from '../server/systemStats';

const core = (user: number, idle: number) => ({ model: 'x', speed: 1, times: { user, nice: 0, sys: 0, idle, irq: 0 } }) as os.CpuInfo;

describe('monitor de CPU e RAM', () => {
  it('a CPU é o uso entre duas leituras, somando os núcleos', () => {
    const a = cpuSample([core(100, 900), core(100, 900)], 0);
    // 1º núcleo: 300 de 400 ms ocupado; 2º: ocioso. Juntos: 300 de 800.
    const b = cpuSample([core(400, 1000), core(100, 1300)], 1000);
    expect(cpuPercent(a, b)).toBe(38);
    expect(cpuPercent(a, a)).toBeNull();
    // Nunca sai de 0–100, nem com contador estranho.
    expect(cpuPercent(a, cpuSample([core(5000, 900), core(5000, 900)], 1000))).toBe(100);
  });

  it('a RAM vem em bytes, com o livre menor que o total', () => {
    const s = systemStats();
    expect(s.memTotal).toBeGreaterThan(0);
    expect(s.memFree).toBeGreaterThanOrEqual(0);
    expect(s.memFree).toBeLessThanOrEqual(s.memTotal);
    expect(s.cpu === null || (s.cpu >= 0 && s.cpu <= 100)).toBe(true);
  });
});
