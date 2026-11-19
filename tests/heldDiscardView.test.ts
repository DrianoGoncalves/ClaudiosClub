import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../client/src/api';
import { HeldDiscardButton } from '../client/src/chat/HeldDiscardButton';
import { heldDiscardOf, heldIsGone } from '../client/src/chat/heldDiscard';
import chatMessages from '../client/src/i18n/chat';
import type { ChatItem } from '../shared/model';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

// O item guardado como o servidor o monta (`TaskService.heldItems`): id `h:<id da mensagem>`.
const held = (over: Record<string, unknown> = {}): ChatItem =>
  ({ kind: 'user', id: 'h:a1b2c3d4', text: 'corrija o botão', at: '2026-11-18T10:00:00.000Z', held: 'espera Ana terminar “Painel”', heldTaskId: 't-abc123', heldDiscardable: true, ...over }) as ChatItem;

describe('quando dá para excluir a mensagem guardada', () => {
  it('guardada e excluível: devolve a tarefa e o id da mensagem sem o prefixo h:', () => {
    expect(heldDiscardOf(held())).toEqual({ taskId: 't-abc123', heldId: 'a1b2c3d4' });
  });

  it('resposta a uma dúvida (heldDiscardable false) não tem botão', () => {
    expect(heldDiscardOf(held({ heldDiscardable: false }))).toBeNull();
  });

  it('sem o que o servidor manda (item recém-guardado nesta tela, ou servidor velho) não tem botão', () => {
    expect(heldDiscardOf(held({ heldDiscardable: undefined }))).toBeNull();
    expect(heldDiscardOf(held({ heldTaskId: undefined }))).toBeNull();
  });

  it('mensagem comum, já enviada (sem held), ou item de outro tipo não têm botão', () => {
    expect(heldDiscardOf(held({ held: undefined, id: 'u1' }))).toBeNull();
    expect(heldDiscardOf({ kind: 'assistant', id: 'h:a1', text: 'oi', at: null })).toBeNull();
  });

  it('id que não é de item guardado não vira rota', () => {
    expect(heldDiscardOf(held({ id: 'x:a1b2' }))).toBeNull();
    expect(heldDiscardOf(held({ id: 'h:' }))).toBeNull();
  });

  it('só o 409 quer dizer "já não está guardada"; 403, 404 e queda de rede seguem como erro', () => {
    const err = (status: number | null) => new ApiError('x', null, null, {}, status);
    expect(heldIsGone(err(409))).toBe(true);
    expect(heldIsGone(err(404))).toBe(false);
    expect(heldIsGone(err(403))).toBe(false);
    expect(heldIsGone(err(null))).toBe(false);
    expect(heldIsGone(new Error('409'))).toBe(false);
  });
});

describe('botão Excluir na mensagem guardada', () => {
  it('aparece na guardada excluível, com o texto e a dica', () => {
    const html = renderToStaticMarkup(createElement(HeldDiscardButton, { item: held(), busy: false, onDiscard: () => {} }));
    expect(html).toContain('class="btn-secondary msg-held-discard"');
    expect(html).toContain('type="button"');
    expect(html).toContain('>Excluir</button>');
    expect(html).toContain('title="Exclui esta mensagem: ela ainda não foi enviada ao funcionário"');
    expect(html).not.toContain('disabled');
  });

  it('não aparece na resposta a uma dúvida, na já enviada nem sem quem trate o clique', () => {
    const render = (item: ChatItem, onDiscard?: () => void) => renderToStaticMarkup(createElement(HeldDiscardButton, { item, busy: false, onDiscard }));
    expect(render(held({ heldDiscardable: false }), () => {})).toBe('');
    expect(render(held({ held: undefined, id: 'u1' }), () => {})).toBe('');
    expect(render(held())).toBe('');
  });

  it('enquanto exclui, o botão fica desligado (não repete o pedido)', () => {
    const html = renderToStaticMarkup(createElement(HeldDiscardButton, { item: held(), busy: true, onDiscard: () => {} }));
    expect(html).toContain('disabled');
  });

  it('as 6 frases existem em pt, en e es, e a pergunta diz que a mensagem some de vez', () => {
    for (const lang of ['pt-BR', 'en', 'es'] as const) {
      for (const key of ['chat.heldDiscard', 'chat.heldDiscardHelp', 'chat.heldDiscardConfirm', 'chat.heldDiscardGone', 'chat.heldDiscardKept', 'chat.heldDiscardUnsure'] as const) {
        expect(chatMessages[lang][key], `${lang} ${key}`).toBeTruthy();
      }
    }
    expect(chatMessages['pt-BR']['chat.heldDiscardConfirm']).toContain('some de vez');
    expect(chatMessages.en['chat.heldDiscardConfirm']).toContain('gone for good');
    expect(chatMessages.es['chat.heldDiscardConfirm']).toContain('desaparece del todo');
  });
});

describe('chamada ao servidor', () => {
  const stubBrowser = (res: Response) => {
    const fetch = vi.fn(async () => res);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    return fetch;
  };

  it('POST em tasks/:tid/held/:hid/discard, sem corpo útil e com o cabeçalho x-myco', async () => {
    const fetch = stubBrowser(new Response(JSON.stringify({ id: 't-abc123' }), { status: 200 }));
    await api.discardHeld('proj-a', 't-abc123', 'a1b2c3d4');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/projects/proj-a/tasks/t-abc123/held/a1b2c3d4/discard');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-myco']).toBe('1');
  });

  it('409 do servidor vira ApiError com status 409 (a tela relê a conversa e avisa conforme o que viu: tests/heldDiscardFlow.test.ts)', async () => {
    stubBrowser(new Response(JSON.stringify({ error: 'esse ajuste já não está guardado' }), { status: 409 }));
    const e = await api.discardHeld('proj-a', 't-abc123', 'a1b2c3d4').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(heldIsGone(e)).toBe(true);
  });
});
