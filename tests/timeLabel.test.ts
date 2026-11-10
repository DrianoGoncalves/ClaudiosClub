import { describe, expect, it } from 'vitest';
import { msgTimeFull, msgTimeLabel } from '../client/src/chat/timeLabel';

// Hora local da máquina de testes: monta o instante pelo relógio local e confere o texto por partes.
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 7).toISOString();
const NOW = new Date(2026, 10, 9, 18, 0).getTime();

describe('data e hora no rodapé do balão', () => {
  it('mostra dia, mês e hora do `at`, sem o ano quando é o ano atual', () => {
    const label = msgTimeLabel(at(2026, 11, 9, 14, 32), 'pt-BR', NOW)!;
    expect(label).toMatch(/^09\/11\D+14:32$/);
    expect(label).not.toContain('2026');
  });

  it('inclui o ano quando a mensagem é de outro ano', () => {
    expect(msgTimeLabel(at(2025, 12, 31, 23, 59), 'pt-BR', NOW)).toMatch(/^31\/12\/2025\D+23:59$/);
  });

  it('segue o idioma da tela (en usa 12h e mês antes do dia)', () => {
    expect(msgTimeLabel(at(2026, 11, 9, 14, 32), 'en', NOW)).toMatch(/^11\/09\D+02:32\s?PM$/);
  });

  it('o horário vem do `at`, não do relógio de agora', () => {
    const msg = at(2026, 1, 5, 8, 5);
    expect(msgTimeLabel(msg, 'pt-BR', NOW)).toBe(msgTimeLabel(msg, 'pt-BR', NOW + 3_600_000));
    expect(msgTimeLabel(msg, 'pt-BR', NOW)).toMatch(/^05\/01\D+08:05$/);
  });

  it('sem `at` (ou inválido) não há rodapé: nada de horário inventado', () => {
    expect(msgTimeLabel(null, 'pt-BR', NOW)).toBeNull();
    expect(msgTimeLabel(undefined, 'pt-BR', NOW)).toBeNull();
    expect(msgTimeLabel('', 'pt-BR', NOW)).toBeNull();
    expect(msgTimeLabel('não é data', 'pt-BR', NOW)).toBeNull();
    expect(msgTimeFull(null, 'pt-BR')).toBeNull();
  });

  it('o tooltip traz a data completa com segundos', () => {
    const full = msgTimeFull(at(2026, 11, 9, 14, 32), 'pt-BR')!;
    expect(full).toMatch(/2026/);
    expect(full).toMatch(/14:32:07/);
  });
});
