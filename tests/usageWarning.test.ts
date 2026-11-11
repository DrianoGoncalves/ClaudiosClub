import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FallbackWarningBody, UsageStopBody } from '../client/src/chat/usageWarning';
import {
  announceSent,
  askUsageStop,
  fallbackNoticeHidden,
  hideFallbackNotice,
  onUsageStopAsk,
  type UsageStopAsk,
} from '../client/src/chat/usageNotice';
import { api, ApiError, withUsageConfirm } from '../client/src/api';

afterEach(() => vi.unstubAllGlobals());

const notice = { projectId: 'p', name: 'Belchior', engine: 'codex' as const, model: 'gpt-test' };
const fallback = { movedFrom: 'anterior', engine: 'codex' as const, model: 'gpt-test' };

function stubBrowser() {
  const data = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
  const dispatchEvent = vi.fn();
  const confirm = vi.fn();
  vi.stubGlobal('window', { dispatchEvent, confirm });
  vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: { detail: unknown }) {} });
  return { data, dispatchEvent, confirm };
}

describe('aviso da troca de motor', () => {
  it('diz o motor, o modelo e o motivo, e oferece não avisar nesta sessão', () => {
    const html = renderToStaticMarkup(createElement(FallbackWarningBody, { notice, onClose: () => {}, onHide: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Esta conversa com Belchior passou para o motor secundário');
    expect(html).toContain('Codex (GPT) · gpt-test');
    expect(html).toContain('O limite de uso do Claude foi atingido');
    expect(html).toContain('Não avisar nesta sessão');
  });

  it('abre quando a resposta traz fallback e fica quieto quando não traz', async () => {
    const { dispatchEvent } = stubBrowser();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sessionId: 'nova', fallback }), { status: 200 })));
    const sent = await api.chatSend('proj-a', { sessionId: 'anterior', staffId: 's', text: 'oi' });
    expect(sent).toMatchObject({ sessionId: 'nova', fallback });
    dispatchEvent.mockClear(); // o POST que passou já disparou o PAIRED_EVENT
    expect(announceSent('proj-a', 'Belchior', sent)).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ init: { detail: { projectId: 'proj-a', name: 'Belchior', engine: 'codex', model: 'gpt-test' } } });

    expect(announceSent('proj-a', 'Belchior', { sessionId: 'mesma' } as never)).toBe(false);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('"não avisar nesta sessão" vale por projeto, no sessionStorage', () => {
    const { data, dispatchEvent } = stubBrowser();
    expect(fallbackNoticeHidden('proj-b')).toBe(false);
    hideFallbackNotice('proj-b');
    expect(data.get('myco.hideFallbackNotice.proj-b')).toBe('1');
    expect(fallbackNoticeHidden('proj-b')).toBe(true);

    expect(announceSent('proj-b', 'Belchior', { fallback })).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalled();
    // outro projeto continua avisando
    expect(fallbackNoticeHidden('proj-c')).toBe(false);
    expect(announceSent('proj-c', 'Belchior', { fallback })).toBe(true);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('com o sessionStorage bloqueado, "não avisar" vale enquanto a página estiver aberta', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(fallbackNoticeHidden('proj-d')).toBe(false);
    hideFallbackNotice('proj-d');
    expect(fallbackNoticeHidden('proj-d')).toBe(true);
  });
});

describe('trava de consumo (409) no modal do design system', () => {
  const hit = { kind: 'five_hour' as const, limit: 95, percentUsed: 97, resetsAt: null };
  const stopRun = () => vi.fn(async (force: boolean) => { if (!force) throw new ApiError('limite', 'usage-stop', hit); return 'enviado'; });

  it('pergunta no modal (não no window.confirm) e só passa da trava com o ok', async () => {
    const { confirm } = stubBrowser();
    const asked: UsageStopAsk[] = [];
    const off = onUsageStopAsk((a) => { asked.push(a); a.answer(asked.length > 1); });
    const run = stopRun();

    expect(await withUsageConfirm(run)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(asked[0]?.text).toContain('97%');

    expect(await withUsageConfirm(run)).toBe('enviado');
    expect(run).toHaveBeenLastCalledWith(true);
    expect(confirm).not.toHaveBeenCalled();
    off();
  });

  it('sem o modal montado, não passa da trava', async () => {
    const { confirm } = stubBrowser();
    expect(await askUsageStop('x')).toBe(false);
    const run = stopRun();
    expect(await withUsageConfirm(run)).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('outro erro sobe sem perguntar', async () => {
    const run = vi.fn(async () => { throw new ApiError('quebrou', 'outro', null); });
    await expect(withUsageConfirm(run)).rejects.toThrow('quebrou');
  });

  it('o modal mostra o motivo, a pergunta e as duas respostas, sem dizer que o chat não troca', () => {
    const html = renderToStaticMarkup(createElement(UsageStopBody, { text: 'O consumo 5h da conta está em 97%.', onAnswer: () => {} }));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('O consumo 5h da conta está em 97%.');
    expect(html).toContain('Seguir mesmo assim?');
    expect(html).toContain('Cancelar');
    expect(html).toContain('Seguir<');
    expect(html).not.toMatch(/n[ãa]o troca/i);
  });
});
