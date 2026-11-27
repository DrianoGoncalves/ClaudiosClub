import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../client/src/api';
import { decisionErrorText } from '../client/src/tasks/followUp';
import { t } from '../client/src/i18n';
import { ServerStoppedView } from '../client/src/lib/ServerStoppedBanner';
import { RESTART_LIMIT_MS, noteOffline, noteOnline, offlineMessageKey, serverPhase } from '../client/src/serverStatus';
import messages from '../client/src/i18n/app';

describe('serverPhase: reiniciando x parou', () => {
  it('no ar', () => expect(serverPhase(null, 1e9)).toBe('up'));
  it('dentro do prazo segue reiniciando', () => expect(serverPhase(1000, 1000 + RESTART_LIMIT_MS - 1)).toBe('restarting'));
  it('no limite ou além, parou', () => {
    expect(serverPhase(1000, 1000 + RESTART_LIMIT_MS)).toBe('stopped');
    expect(serverPhase(1000, 1000 + RESTART_LIMIT_MS * 5)).toBe('stopped');
  });
});

describe('estado do módulo e mensagem de erro', () => {
  afterEach(() => {
    noteOnline();
    vi.useRealTimers();
  });
  const phaseNow = () => offlineMessageKey();

  it('antes do limite: "reiniciando"; depois: "parou" com o que fazer', () => {
    vi.useFakeTimers();
    noteOffline();
    expect(phaseNow()).toBe('app.serverOffline');
    vi.advanceTimersByTime(RESTART_LIMIT_MS);
    expect(phaseNow()).toBe('app.serverStoppedAction');
    const err = new ApiError(t(phaseNow()), 'offline', null);
    expect(err.message).not.toBe(t('app.serverOffline'));
    expect(err.message).toContain('Iniciar');
    expect(decisionErrorText(err)).toBe(t('app.serverStoppedAction'));
  });
  it('voltar sozinho dentro do prazo: fica no ar e o timer de "parou" é limpo', () => {
    vi.useFakeTimers();
    noteOffline();
    vi.advanceTimersByTime(RESTART_LIMIT_MS - 1000);
    noteOnline();
    vi.advanceTimersByTime(RESTART_LIMIT_MS * 2);
    expect(phaseNow()).toBe('app.serverOffline');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('aviso de Claudio’s Club parado', () => {
  it('é persistente (role=alert), diz o que fazer e traz o botão', () => {
    const html = renderToStaticMarkup(createElement(ServerStoppedView));
    expect(html).toContain('role="alert"');
    expect(html).toContain('server-stopped');
    expect(html).toContain('<button');
    expect(html).toContain('página de início');
  });
  it('os textos existem em pt, en e es', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const)
      for (const k of ['app.serverStoppedTitle', 'app.serverStoppedBody', 'app.serverStoppedGo', 'app.serverStoppedAction'])
        expect((messages as Record<string, Record<string, string>>)[lang]![k], `${lang} ${k}`).toBeTruthy();
  });
});
