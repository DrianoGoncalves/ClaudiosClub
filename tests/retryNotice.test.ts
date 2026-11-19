import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatItem, TaskRetry } from '../shared/model';
import chatMessages from '../client/src/i18n/chat';
import taskMessages from '../client/src/i18n/tasks';
import toolbarMessages from '../client/src/i18n/toolbar';
import schedulesMessages from '../client/src/i18n/schedules';
import { parseRetryNotice, retryFromText, retryLabelText, retryMinutesLeft, retryNoticeText, retryTickMs } from '../client/src/chat/retryNotice';
import { RetryNoticeBox } from '../client/src/chat/RetryNoticeBox';
import { inboxText } from '../client/src/inbox/inboxText';
import { RetryBadge, retryText } from '../client/src/tasks/TaskRetry';
import { capText } from '../server/chat/turnCap';
import { BACKOFF_MS, classifyTurnError, MAX_ATTEMPTS, retryNotice as serverNotice } from '../server/chat/turnRetry';
import { wakeClock } from '../server/chat/wake';

// Aviso da retomada automática no chat, selo "Retomando em X" no cartão e opção nas Configurações. O aviso do servidor traz os campos
// `retry` (espera e desfecho) e `cap` (desistiu / ação cortada); o texto em pt-BR só é lido quando eles não vêm (`retryFromText`, o
// fallback). Os testes do fallback usam os textos do próprio servidor: mudar uma frase lá sem mudar o leitor daqui quebra aqui.

const LANGS = ['pt-BR', 'en', 'es'] as const;
type Dict = Record<string, string>;
const trFor = (lang: (typeof LANGS)[number]) => (key: string, vars?: Record<string, string | number>) =>
  ((chatMessages[lang] as Dict)[key] ?? (taskMessages[lang] as Dict)[key] ?? (schedulesMessages[lang] as Dict)[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
const en = trFor('en') as never;

const info = (attempt: number, max = 3) => ({ turnId: 't', attempt, max, kind: 'transient' as const, error: 'x' });
// 17/11/2026 10:00:30, na hora desta máquina (o servidor escreve a hora na dele).
const NOW = new Date(2026, 10, 17, 10, 0, 30).getTime();
const AT = new Date(2026, 10, 17, 10, 3, 0).getTime();
const notice = (id: string, text: string, tone: 'info' | 'warn' = 'warn'): Extract<ChatItem, { kind: 'notice' }> => ({ kind: 'notice', id, text, tone, at: null });

describe('fallback: aviso sem os campos, lido da frase do servidor (`retryFromText`)', () => {
  it('a espera: motivo, hora e tentativa; sem horário exato', () => {
    const text = serverNotice.waiting(AT, info(2), 'API sobrecarregada');
    expect(retryFromText({ id: 'n:retry:abc', text })).toEqual({ state: 'waiting', label: 'API sobrecarregada', attempt: 2, max: 3, at: null, clock: wakeClock(AT) });
    expect(parseRetryNotice({ id: 'n:retry:abc', text })).toEqual(retryFromText({ id: 'n:retry:abc', text }));
  });

  it('o desfecho: retomou, cancelada, não deu e desligada', () => {
    const id = 'n:retry:abc';
    expect(retryFromText({ id, text: serverNotice.sent(info(3)) })).toEqual({ state: 'sent', attempt: 3, max: 3 });
    expect(retryFromText({ id, text: serverNotice.cancelled })).toEqual({ state: 'cancelled' });
    expect(retryFromText({ id, text: serverNotice.failed('sem conversa') })).toEqual({ state: 'failed', error: 'sem conversa' });
    expect(retryFromText({ id, text: serverNotice.dropped })).toEqual({ state: 'dropped' });
  });

  it('a espera e o desfecho só valem com o id `n:retry:` (o mesmo texto em outro aviso não é lido)', () => {
    const text = serverNotice.sent(info(1));
    expect(retryFromText({ id: 'n:other', text })).toBeNull();
    expect(retryFromText({ text })).toBeNull();
  });

  it('desistiu depois das tentativas e não retomou por ação cortada: a frase da caixa "precisa de mim" (sem id)', () => {
    expect(retryFromText({ text: capText({ kind: 'retry', why: 'exhausted', attempts: 3, error: 'API sobrecarregada' }) })).toEqual({ state: 'exhausted', label: 'API sobrecarregada', attempts: 3 });
    expect(retryFromText({ text: capText({ kind: 'retry', why: 'exhausted', attempts: 1, error: 'o processo caiu sem aviso' }) })).toEqual({ state: 'exhausted', label: 'o processo caiu sem aviso', attempts: 1 });
    const action = 'git push origin "main"\nsegunda linha';
    expect(retryFromText({ text: capText({ kind: 'retry', why: 'cut', action, error: 'erro 503 da API' }) })).toEqual({ state: 'cut', label: 'erro 503 da API', action });
    expect(retryFromText({ text: capText({ kind: 'restart', action: 'deploy' }) })).toEqual({ state: 'restart', action: 'deploy' });
  });

  it('o teto de ferramentas/minutos e texto qualquer não são da retomada', () => {
    expect(retryFromText({ text: capText({ kind: 'tools', limit: 50 }) })).toBeNull();
    expect(retryFromText({ id: 'n:retry:abc', text: 'Texto que ninguém conhece.' })).toBeNull();
  });
});

describe('aviso com os campos do servidor (`retry` e `cap`)', () => {
  const at = (s: number) => NOW + s * 1000;
  // O texto do aviso não é lido quando o campo vem: aqui ele é lixo de propósito.
  const withRetry = (retry: unknown) => ({ id: 'n:retry:x', text: 'lixo', retry });

  it('a espera: tentativa, teto e horário em epoch ms; o motivo é opcional', () => {
    expect(parseRetryNotice(withRetry({ state: 'waiting', attempt: 2, max: 3, at: at(42) }))).toEqual({ state: 'waiting', label: null, attempt: 2, max: 3, at: at(42), clock: null });
    expect(parseRetryNotice(withRetry({ state: 'waiting', attempt: 1, max: 1, at: at(5), error: 'o processo caiu sem aviso' }))).toMatchObject({ label: 'o processo caiu sem aviso' });
  });

  it('a contagem é por segundo e a hora é a do navegador; sem motivo a frase não leva parênteses', () => {
    const n = parseRetryNotice(withRetry({ state: 'waiting', attempt: 2, max: 3, at: at(42) }))!;
    expect(retryNoticeText(n, NOW)).toBe('Falha passageira. Tento de novo sozinho às 10:01h, em 42s (tentativa 2 de 3).');
    expect(retryNoticeText(n, at(-48))).toContain('em 1min 30s');
    expect(retryNoticeText(n, at(42))).toBe('Falha passageira. Tentando de novo agora (tentativa 2 de 3).');
    expect(retryNoticeText(n, at(51))).toContain('Tentando de novo agora');
    expect(retryNoticeText(n, NOW, 'chat', en)).toBe('Temporary failure. Trying again on its own at 10:01, in 42s (attempt 2 of 3).');
    const longe = parseRetryNotice(withRetry({ state: 'waiting', attempt: 1, max: 3, at: NOW + 3 * 3_600_000, error: 'API sobrecarregada' }))!;
    expect(retryNoticeText(longe, NOW)).toContain('em 3h'); // parada de consumo adiou: o horário exato mostra quanto falta
    expect(retryNoticeText(longe, NOW)).toContain('(API sobrecarregada)');
  });

  it('o horário não depende do relógio do servidor: vale o instante, mesmo que o texto diga outra hora', () => {
    const item = { id: 'n:retry:x', text: serverNotice.waiting(AT, info(1), 'API sobrecarregada'), retry: { state: 'waiting', attempt: 2, max: 3, at: at(42) } };
    expect(parseRetryNotice(item)).toMatchObject({ at: at(42), clock: null });
  });

  it('o desfecho: retomou, cancelada, falhou (com ou sem motivo) e desligada', () => {
    expect(parseRetryNotice(withRetry({ state: 'sent', attempt: 3, max: 3 }))).toEqual({ state: 'sent', attempt: 3, max: 3 });
    expect(parseRetryNotice(withRetry({ state: 'cancelled' }))).toEqual({ state: 'cancelled' });
    expect(parseRetryNotice(withRetry({ state: 'dropped' }))).toEqual({ state: 'dropped' });
    const failed = parseRetryNotice(withRetry({ state: 'failed', error: 'a conversa não abriu' }))!;
    expect(retryNoticeText(failed, NOW)).toBe('Não deu para retomar sozinho (a conversa não abriu). Mande uma mensagem quando quiser.');
    expect(retryNoticeText(parseRetryNotice(withRetry({ state: 'failed' }))!, NOW)).toBe('Não deu para retomar sozinho. Mande uma mensagem quando quiser.');
  });

  it('campo incompleto, de estado desconhecido ou com horário impossível cai no texto (e no fallback se o texto é conhecido)', () => {
    for (const retry of [{ state: 'lixo' }, { state: 'waiting', attempt: 2, max: 3 }, { state: 'waiting', attempt: 0, max: 3, at: at(1) }, { state: 'waiting', attempt: 1, max: 3, at: 1e20 }, { state: 'sent', attempt: 1 }, 'texto', null, []]) {
      expect(parseRetryNotice(withRetry(retry)), JSON.stringify(retry)).toBeNull();
    }
    const text = serverNotice.sent(info(2));
    expect(parseRetryNotice({ id: 'n:retry:x', text, retry: { state: 'sent' } })).toEqual({ state: 'sent', attempt: 2, max: 3 });
  });

  it('desistiu e não retomou por ação cortada: o `cap` do aviso, sem depender do texto', () => {
    const base = { id: 'n:cap', text: 'lixo' };
    expect(parseRetryNotice({ ...base, cap: { kind: 'retry', why: 'exhausted', attempts: 3, error: 'API sobrecarregada' } })).toEqual({ state: 'exhausted', label: 'API sobrecarregada', attempts: 3 });
    expect(parseRetryNotice({ ...base, cap: { kind: 'retry', why: 'cut', action: 'git push', error: 'erro 503 da API' } })).toEqual({ state: 'cut', label: 'erro 503 da API', action: 'git push' });
    expect(parseRetryNotice({ ...base, cap: { kind: 'restart', action: 'deploy' } })).toEqual({ state: 'restart', action: 'deploy' });
  });

  it('o teto de ferramentas/minutos e `cap` incompleto não são da retomada', () => {
    expect(parseRetryNotice({ id: 'n:cap', text: 'lixo', cap: { kind: 'tools', limit: 50 } })).toBeNull();
    expect(parseRetryNotice({ id: 'n:cap', text: 'lixo', cap: { kind: 'retry', why: 'exhausted', error: 'x' } })).toBeNull();
    expect(parseRetryNotice({ id: 'n:cap', text: 'lixo', cap: { kind: 'retry', why: 'cut', error: 'x' } })).toBeNull();
  });

  it('o relógio: 1 s com o horário exato, 15 s no texto, nenhum quando não espera', () => {
    expect(retryTickMs(parseRetryNotice(withRetry({ state: 'waiting', attempt: 1, max: 3, at: at(30) })))).toBe(1000);
    expect(retryTickMs(parseRetryNotice({ id: 'n:retry:x', text: serverNotice.waiting(AT, info(1), 'API sobrecarregada') }))).toBe(15_000);
    expect(retryTickMs(parseRetryNotice(withRetry({ state: 'sent', attempt: 1, max: 3 })))).toBeNull();
    expect(retryTickMs(null)).toBeNull();
  });
});

describe('o motivo da queda no idioma da página', () => {
  it('cada motivo que o servidor sabe dar sai traduzido em inglês e espanhol', () => {
    const labels = [
      classifyTurnError({ text: 'API Error: 529 overloaded', status: 529 })!.label,
      classifyTurnError({ text: 'rate limit', status: 429 })!.label,
      classifyTurnError({ text: 'API Error: 503 service unavailable', status: 503 })!.label,
      classifyTurnError({ text: 'we are experiencing high demand' })!.label,
      classifyTurnError({ text: 'fetch failed' })!.label,
      'o processo caiu sem aviso',
    ];
    for (const label of labels) {
      expect(retryLabelText(label, trFor('en') as never), label).not.toBe(label);
      expect(retryLabelText(label, trFor('es') as never), label).not.toBe(label);
    }
    expect(retryLabelText('erro 503 da API', en)).toBe('API error 503');
  });

  it('motivo novo no servidor volta como veio', () => {
    expect(retryLabelText('algo que o servidor passou a dizer', en)).toBe('algo que o servidor passou a dizer');
  });
});

describe('contagem até o horário', () => {
  it('por minuto, e só quando o horário é perto', () => {
    expect(retryMinutesLeft('10:03', NOW)).toBe(3);
    expect(retryMinutesLeft('10:01', NOW)).toBe(1);
    expect(retryMinutesLeft('10:00', NOW)).toBe(0); // passou 30 s: está saindo
    expect(retryMinutesLeft('09:58', NOW)).toBeNull(); // passou de vez
    expect(retryMinutesLeft('10:21', NOW)).toBeNull(); // longe: parada de consumo adiou, só a hora
    expect(retryMinutesLeft('25:99', NOW)).toBeNull();
    expect(retryMinutesLeft('lixo', NOW)).toBeNull();
  });

  it('a frase muda com a contagem: com tempo, "em cerca de N min"; no horário, "agora"; longe, só a hora', () => {
    const n = parseRetryNotice({ id: 'n:retry:a', text: serverNotice.waiting(AT, info(2), 'API sobrecarregada') })!;
    expect(retryNoticeText(n, NOW)).toBe('Falha passageira (API sobrecarregada). Tento de novo sozinho às 10:03h, em cerca de 3 min (tentativa 2 de 3).');
    expect(retryNoticeText(n, AT + 5_000)).toBe('Falha passageira (API sobrecarregada). Tentando de novo agora (tentativa 2 de 3).');
    expect(retryNoticeText(n, AT - 3 * 3_600_000)).toBe('Falha passageira (API sobrecarregada). Tento de novo sozinho às 10:03h (tentativa 2 de 3).');
    expect(retryNoticeText(n, NOW, 'chat', en)).toBe('Temporary failure (API overloaded). Trying again on its own at 10:03, in about 3 min (attempt 2 of 3).');
  });
});

describe('desfecho: frase no chat e na caixa', () => {
  const exhausted = { state: 'exhausted', label: 'API sobrecarregada', attempts: 3 } as const;
  const cut = { state: 'cut', label: 'erro 503 da API', action: 'git push' } as const;

  it('no chat diz que a caixa "precisa de mim" foi avisada; na própria caixa não repete', () => {
    expect(retryNoticeText(exhausted, NOW, 'chat')).toBe('A conversa caiu (API sobrecarregada) e não voltou depois de 3 tentativas automáticas. Mande mensagem para seguir. Avisei na caixa “precisa de mim”.');
    expect(retryNoticeText(exhausted, NOW, 'inbox')).not.toContain('Avisei');
    expect(retryNoticeText({ ...exhausted, attempts: 1 }, NOW, 'inbox')).toContain('1 tentativa automática');
  });

  it('ação cortada: diz o que parou e que repetir poderia duplicar, nos 3 idiomas', () => {
    expect(retryNoticeText(cut, NOW, 'chat')).toContain('“git push”');
    expect(retryNoticeText(cut, NOW, 'chat')).toContain('duplicar');
    expect(retryNoticeText(cut, NOW, 'chat', en)).toContain('could duplicate');
    expect(retryNoticeText(cut, NOW, 'chat', trFor('es') as never)).toContain('duplicarla');
  });

  it('retomou, cancelada, falhou, desligada: uma frase cada, no idioma da página', () => {
    expect(retryNoticeText({ state: 'sent', attempt: 2, max: 3 }, NOW)).toBe('Retomou sozinho (tentativa 2 de 3).');
    expect(retryNoticeText({ state: 'sent', attempt: 2, max: 3 }, NOW, 'chat', en)).toBe('Resumed on its own (attempt 2 of 3).');
    expect(retryNoticeText({ state: 'failed', error: 'sem conversa' }, NOW, 'chat', en)).toContain('(sem conversa)');
    expect(retryNoticeText({ state: 'dropped' }, NOW, 'chat', en)).toContain('turned off');
    expect(retryNoticeText({ state: 'cancelled' }, NOW)).toBe('Retomada automática cancelada.');
  });

  it('o item `cap:` da caixa "precisa de mim" sai no idioma da página; outro erro fica como veio', () => {
    const summary = capText({ kind: 'retry', why: 'exhausted', attempts: 3, error: 'API sobrecarregada' });
    expect(inboxText({ kind: 'error', summary }, en)).toBe('The chat dropped (API overloaded) and did not come back after 3 automatic attempts. Send a message to continue.');
    expect(inboxText({ kind: 'error', summary: 'Erro qualquer' }, en)).toBe('Erro qualquer');
    expect(inboxText({ kind: 'waiting', summary }, en)).toBe(summary);
  });
});

describe('aviso no chat (componente)', () => {
  it('a espera leva a dica de como cancelar; o desfecho não', () => {
    const waiting = renderToStaticMarkup(createElement(RetryNoticeBox, { item: notice('n:retry:a', serverNotice.waiting(AT, info(1), 'API sobrecarregada')) }));
    expect(waiting).toContain('data-retry="waiting"');
    expect(waiting).toContain('chat-notice chat-notice-warn chat-retry');
    expect(waiting).toContain('Para cancelar, mande uma mensagem.');
    const sent = renderToStaticMarkup(createElement(RetryNoticeBox, { item: notice('n:retry:a', serverNotice.sent(info(1)), 'info') }));
    expect(sent).toContain('data-retry="sent"');
    expect(sent).not.toContain('Para cancelar');
  });

  it('com o campo `retry`, a espera mostra a contagem por segundo e a dica de cancelar', () => {
    const item = { ...notice('n:retry:a', 'lixo'), retry: { state: 'waiting' as const, attempt: 2, max: 3, at: Date.now() + 90_000, error: 'API sobrecarregada' } };
    const html = renderToStaticMarkup(createElement(RetryNoticeBox, { item }));
    expect(html).toContain('data-retry="waiting"');
    expect(html).toMatch(/em 1min \d{2}s|em 90s/);
    expect(html).toContain('(API sobrecarregada)');
    expect(html).toContain('Para cancelar, mande uma mensagem.');
    expect(html).not.toContain('lixo');
  });

  it('o que não é da retomada não vira nada aqui (o chat segue com o aviso comum)', () => {
    expect(renderToStaticMarkup(createElement(RetryNoticeBox, { item: notice('n:x', 'Compactado') }))).toBe('');
  });
});

describe('selo "Retomando em X" no cartão (Task.retry)', () => {
  const retry = (over: Partial<TaskRetry> = {}): TaskRetry => ({ attempt: 2, max: 3, at: new Date(NOW + 42_000).toISOString(), kind: 'transient', error: 'API sobrecarregada', ...over });

  it('diz quando volta e qual tentativa; a frase inteira traz o motivo e como cancelar', () => {
    const text = retryText(retry(), NOW)!;
    expect(text.head).toBe('Retomando em 42s · 2/3');
    expect(text.hint).toBe('A conversa caiu (API sobrecarregada) e volta sozinha às 10:01h: tentativa 2 de 3. Para cancelar, mande uma mensagem na conversa.');
  });

  it('passou da hora e ainda aparece (envio em curso): "agora"', () => {
    expect(retryText(retry({ at: new Date(NOW - 5_000).toISOString() }), NOW)!.head).toBe('Retomando agora · 2/3');
  });

  it('processo que caiu sem causa: tentativa 1/1 e o motivo no idioma da página', () => {
    const text = retryText(retry({ attempt: 1, max: 1, kind: 'unknown', error: 'o processo caiu sem aviso' }), NOW)!;
    expect(text.head).toBe('Retomando em 42s · 1/1');
    expect(text.hint).toContain('o processo caiu sem aviso');
  });

  it('sem a marca, ou com tentativa/horário ilegível: sem selo', () => {
    expect(retryText(undefined, NOW)).toBeNull();
    expect(retryText(retry({ at: 'lixo' }), NOW)).toBeNull();
    expect(retryText(retry({ attempt: 0 }), NOW)).toBeNull();
    expect(retryText(retry({ max: 2.5 }), NOW)).toBeNull();
    expect(renderToStaticMarkup(createElement(RetryBadge, { retry: undefined, now: NOW }))).toBe('');
  });

  it('é selo da fila, sem o laranja de A fazer; no detalhe ganha a frase inteira', () => {
    const card = renderToStaticMarkup(createElement(RetryBadge, { retry: retry(), now: NOW }));
    expect(card).toContain('class="task-queue task-retry small"');
    expect(card).not.toContain('task-wait');
    expect(card).not.toContain('<span class="muted small">'); // a frase inteira fica no title do selo
    const detail = renderToStaticMarkup(createElement(RetryBadge, { retry: retry(), now: NOW, withHint: true }));
    expect(detail).toContain('<span class="muted small">A conversa caiu');
  });
});

describe('opção nas Configurações e textos nos 3 idiomas', () => {
  it('título, descrição e palavras de busca nos 3 idiomas', () => {
    for (const lang of LANGS) {
      for (const key of ['toolbar.autoRetryTitle', 'toolbar.autoRetryDesc', 'toolbar.autoRetryKeywords']) {
        expect((toolbarMessages[lang] as Dict)[key]?.trim(), `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it('a descrição cita as esperas e o teto de tentativas do servidor, e que a ação fora do projeto não é repetida', () => {
    const waits = BACKOFF_MS.map((ms) => (ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`));
    for (const lang of LANGS) {
      const desc = (toolbarMessages[lang] as Dict)['toolbar.autoRetryDesc']!;
      for (const wait of waits) expect(desc, `${lang} ${wait}`).toContain(wait);
      expect(desc, lang).toContain(String(MAX_ATTEMPTS));
    }
    expect((toolbarMessages['pt-BR'] as Dict)['toolbar.autoRetryDesc']).toMatch(/fora do projeto/);
    expect((toolbarMessages.en as Dict)['toolbar.autoRetryDesc']).toMatch(/outside the project/);
    expect((toolbarMessages.es as Dict)['toolbar.autoRetryDesc']).toMatch(/fuera del proyecto/);
  });

  it('os textos do chat e do cartão existem nos 3 idiomas', () => {
    for (const lang of LANGS) {
      for (const [dict, prefix] of [[chatMessages[lang], 'chat.retry'], [taskMessages[lang], 'tasks.retry']] as const) {
        const keys = Object.keys(dict).filter((k) => k.startsWith(prefix));
        expect(keys.length, `${lang} ${prefix}`).toBeGreaterThan(0);
        for (const k of keys) expect((dict as Dict)[k]!.trim(), `${lang} ${k}`).toBeTruthy();
      }
    }
    const ptKeys = (d: object, prefix: string) => Object.keys(d).filter((k) => k.startsWith(prefix)).sort();
    for (const lang of ['en', 'es'] as const) {
      expect(ptKeys(chatMessages[lang], 'chat.retry')).toEqual(ptKeys(chatMessages['pt-BR'], 'chat.retry'));
      expect(ptKeys(taskMessages[lang], 'tasks.retry')).toEqual(ptKeys(taskMessages['pt-BR'], 'tasks.retry'));
    }
  });
});
