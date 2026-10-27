import { describe, expect, it } from 'vitest';
import { cronError, cronMatches, describeCron, nextRun, parseCron } from '../shared/cron';

const at = (s: string) => new Date(s); // horário local

describe('cron das rotinas', () => {
  it('casa minuto, hora, dias úteis e passos', () => {
    const weekdays8 = parseCron('0 8 * * 1-5');
    expect(cronMatches(weekdays8, at('2026-10-26T08:00:00'))).toBe(true); // segunda
    expect(cronMatches(weekdays8, at('2026-10-25T08:00:00'))).toBe(false); // domingo
    expect(cronMatches(weekdays8, at('2026-10-26T08:01:00'))).toBe(false);
    const every15 = parseCron('*/15 * * * *');
    expect([0, 15, 30, 45].every((m) => cronMatches(every15, at(`2026-10-26T10:${String(m).padStart(2, '0')}:00`)))).toBe(true);
    expect(cronMatches(every15, at('2026-10-26T10:20:00'))).toBe(false);
    // 7 também é domingo; dia do mês e da semana restritos = um ou outro.
    expect(cronMatches(parseCron('0 9 * * 7'), at('2026-10-25T09:00:00'))).toBe(true);
    expect(cronMatches(parseCron('0 9 1 * 1'), at('2026-10-26T09:00:00'))).toBe(true);
  });

  it('próxima execução', () => {
    expect(nextRun(parseCron('30 18 * * 1-5'), at('2026-10-30T19:00:00'))).toEqual(at('2026-11-02T18:30:00')); // sexta à noite → segunda
    expect(nextRun(parseCron('0 0 29 2 *'), at('2026-03-01T00:00:00'))).toBeNull(); // 29/fev só em 2028: fora de um ano
  });

  it('erros e descrições em português', () => {
    expect(cronError('0 8 * *')).toMatch(/5 campos/);
    expect(cronError('0 25 * * *')).toMatch(/hora/);
    expect(cronError('0 8 * * 1-5')).toBeNull();
    expect(describeCron('0 8 * * *')).toBe('todo dia às 08:00');
    expect(describeCron('30 18 * * 1-5')).toBe('dias úteis às 18:30');
    expect(describeCron('0 9 * * 1')).toBe('toda segunda às 09:00');
    expect(describeCron('0 10 * * 6')).toBe('todo sábado às 10:00');
    expect(describeCron('*/30 * * * *')).toBe('a cada 30 minutos');
    expect(describeCron('5 1,13 * * *')).toBe('5 1,13 * * *');
  });
});
