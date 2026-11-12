import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResourceWaitBadge, resourceWaitText } from '../client/src/tasks/ResourceWait';
import { normalizeMaxChats, normalizeRamGb } from '../client/src/toolbar/queueGate';

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const wait = (minutesAgo: number) => ({ reason: 'RAM disponível 1,2 GB (reserva 1,5 GB)', since: new Date(NOW - minutesAgo * 60_000).toISOString() });

describe('normalizeRamGb', () => {
  it('0 desliga; abaixo de 0,5 sobe para 0,5; acima de 64 desce para 64', () => {
    expect(normalizeRamGb('0')).toBe(0);
    expect(normalizeRamGb('-3')).toBe(0);
    expect(normalizeRamGb('0.3')).toBe(0.5);
    expect(normalizeRamGb('1.5')).toBe(1.5);
    expect(normalizeRamGb('200')).toBe(64);
  });
  it('aceita vírgula, arredonda a uma casa e devolve null para vazio ou lixo', () => {
    expect(normalizeRamGb('2,25')).toBe(2.3);
    expect(normalizeRamGb('')).toBeNull();
    expect(normalizeRamGb('abc')).toBeNull();
  });
});

describe('normalizeMaxChats', () => {
  it('inteiro de 0 a 50', () => {
    expect(normalizeMaxChats('0')).toBe(0);
    expect(normalizeMaxChats('3.6')).toBe(4);
    expect(normalizeMaxChats('-2')).toBe(0);
    expect(normalizeMaxChats('99')).toBe(50);
    expect(normalizeMaxChats(' ')).toBeNull();
  });
});

describe('resourceWaitText', () => {
  it('motivo (como veio do servidor) e há quanto tempo espera', () => {
    expect(resourceWaitText(wait(4), NOW)).toBe('Aguardando recursos: RAM disponível 1,2 GB (reserva 1,5 GB) · há 4min');
  });
  it('menos de um minuto vira "agora"; data inválida some só com o tempo', () => {
    expect(resourceWaitText(wait(0), NOW)).toMatch(/· agora$/);
    expect(resourceWaitText({ reason: 'CPU média 93% nos últimos 2 min', since: 'ontem' }, NOW)).toBe('Aguardando recursos: CPU média 93% nos últimos 2 min');
  });
  it('relógio do navegador atrás do servidor não dá tempo negativo', () => {
    expect(resourceWaitText(wait(-5), NOW)).toMatch(/· agora$/);
  });
});

describe('ResourceWaitBadge', () => {
  it('sem espera não desenha nada; com espera mostra o texto e a dica', () => {
    expect(renderToStaticMarkup(createElement(ResourceWaitBadge, { wait: null, now: NOW }))).toBe('');
    const html = renderToStaticMarkup(createElement(ResourceWaitBadge, { wait: wait(4), now: NOW }));
    expect(html).toContain('task-resource');
    expect(html).toContain('há 4min');
    expect(html).toContain('title=');
  });
});
