import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client/src/api';
import { ScheduleList } from '../client/src/schedules/SchedulesBoard';
import { countdown, type Schedule, scheduleKey, whenParts } from '../client/src/schedules/scheduleView';

// Tela de agendamentos: hora e contagem, lista (texto do funcionário escapado, nome pelo staffId, confirmação) e as
// três chamadas da API (ler, cancelar despertador, cancelar "continue") com fetch simulado.

const NOW = new Date(2026, 10, 10, 10, 0, 0).getTime();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const wake = (over: Partial<Schedule> = {}): Schedule => ({ kind: 'wake', sessionId: 's1', staffId: 'ana', at: at(90_000), text: 'Conferir o deploy', ...over });

describe('hora e contagem regressiva', () => {
  it('a chave leva o tipo (despertador e continue da mesma conversa são dois)', () => {
    expect(scheduleKey({ kind: 'wake', sessionId: 'x' })).not.toBe(scheduleKey({ kind: 'continue', sessionId: 'x' }));
  });

  it('hoje só a hora; outro dia leva a data', () => {
    expect(whenParts(at(90 * 60_000), NOW)).toEqual({ date: null, time: '11:30' });
    const next = whenParts(at(26 * 3600_000), NOW);
    expect(next.time).toBe('12:00');
    expect(next.date).toMatch(/11/);
  });

  it('desce de dias a segundos e termina em "agora"', () => {
    expect(countdown(at(2 * 86400_000 + 4 * 3600_000), NOW)).toBe('em 2d4h');
    expect(countdown(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe('em 3h05');
    expect(countdown(at(4 * 60_000 + 5_000), NOW)).toBe('em 4min 05s');
    expect(countdown(at(42_000), NOW)).toBe('em 42s');
    expect(countdown(at(-1_000), NOW)).toBe('agora');
  });
});

describe('lista de agendamentos', () => {
  const nameOf = (id: string | null) => (id === null ? 'Freela' : id === 'ana' ? 'Ana' : id);
  const noop = () => {};
  const html = (items: Schedule[], over: Partial<Parameters<typeof ScheduleList>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(ScheduleList, { items, now: NOW, nameOf, confirming: null, busy: null, errors: {}, onAsk: noop, onCancel: noop, onOpen: noop, ...over }),
    );

  it('mostra quem, quando, o texto e as duas ações', () => {
    const out = html([wake()]);
    expect(out).toContain('Ana');
    expect(out).toContain('Despertador');
    expect(out).toContain('às 10:01h');
    expect(out).toContain('em 1min 30s');
    expect(out).toContain('Conferir o deploy');
    expect(out).toContain('Abrir conversa');
    expect(out).toContain('>Cancelar<');
  });

  it('o texto do funcionário vai como texto puro (HTML escapado)', () => {
    const out = html([wake({ text: '<img src=x onerror=alert(1)> **negrito**' })]);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt; **negrito**');
  });

  it('"continue" automático usa o texto fixo e conversa sem ficha vira Freela', () => {
    const out = html([{ kind: 'continue', sessionId: 's2', staffId: null, at: at(3 * 3600_000), text: 'continue' }]);
    expect(out).toContain('Freela');
    expect(out).toContain('Continuar após o limite');
    expect(out).toContain('Vai mandar “continue” sozinho');
  });

  it('pede confirmação na própria linha antes de cancelar', () => {
    const s = wake();
    const out = html([s, wake({ sessionId: 's9' })], { confirming: scheduleKey(s) });
    expect(out).toContain('Cancelar este agendamento?');
    expect(out).toContain('Sim, cancelar');
    expect(out).toContain('Manter');
    // A outra linha segue com as ações normais.
    expect(out.match(/Abrir conversa/g)).toHaveLength(1);
  });

  it('cancelamento em andamento trava os botões e erro aparece na linha', () => {
    const s = wake();
    const out = html([s], { confirming: scheduleKey(s), busy: scheduleKey(s), errors: { [scheduleKey(s)]: 'Não deu para cancelar: x' } });
    expect(out).toContain('Cancelando…');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
    expect(out).toContain('Não deu para cancelar: x');
  });
});

describe('chamadas da API', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = (body: unknown) => {
    calls.length = 0;
    vi.stubGlobal('window', { dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('lê a lista do projeto', async () => {
    mock({ items: [wake()] });
    const r = await api.schedules('proj');
    expect(calls[0]?.url).toBe('/api/projects/proj/schedules');
    expect(r.items).toHaveLength(1);
  });

  it('cancela o despertador e o "continue" nas rotas certas', async () => {
    mock({ ok: true });
    await api.chatCancelWake('proj', 's1');
    await api.chatCancelAutoContinue('proj', 's2');
    expect(calls.map((c) => c.url)).toEqual(['/api/projects/proj/chat/s1/wake/user-cancel', '/api/projects/proj/chat/s2/auto-continue/cancel']);
    expect(calls.every((c) => c.init?.method === 'POST')).toBe(true);
  });
});
