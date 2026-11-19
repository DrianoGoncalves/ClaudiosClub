import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { api } from '../client/src/api';
import { SecretNotice, SecretNoticeView } from '../client/src/chat/SecretNotice';
import { errorLineShown, errorNoticesFor, errorSeenAsNotice, secretNoticesFor } from '../client/src/chat/secretAlerts';
import { inboxText } from '../client/src/inbox/inboxText';
import { dismissCall } from '../client/src/inbox/useInbox';
import type { InboxItem } from '../shared/model';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'error:s1',
  kind: 'error',
  projectId: 'p1',
  projectName: 'Projeto',
  sessionId: 's1',
  staffId: 'f1',
  name: 'Ana',
  summary: 'não foi possível iniciar o claude: spawn ENOENT',
  at: null,
  ...over,
});

describe('balão de erro no chat', () => {
  it('pega só os erros da conversa aberta, sem tocar nos outros tipos', () => {
    const mine = item();
    const cap = item({ id: 'cap:s1', summary: 'o turno parou: passou de 40 ferramentas' });
    const other = item({ id: 'error:s2', sessionId: 's2' });
    const secret = item({ id: 'secret:s1:x', kind: 'secret' });
    expect(errorNoticesFor([other, secret, mine, cap], 's1')).toEqual([mine, cap]);
    expect(secretNoticesFor([other, secret, mine, cap], 's1')).toEqual([secret]);
    expect(errorNoticesFor([mine], 's2')).toEqual([]);
  });

  it('sem conversa (ou sem caixa) não há balão', () => {
    expect(errorNoticesFor([item({ sessionId: '' })], '')).toEqual([]);
    expect(errorNoticesFor([item()], null)).toEqual([]);
    expect(errorNoticesFor(undefined, 's1')).toEqual([]);
  });

  it('um erro = um balão, mesmo se a lista repetir o id', () => {
    const a = item();
    expect(errorNoticesFor([a, { ...a }], 's1')).toHaveLength(1);
  });

  it('o texto que a conversa já mostra no fluxo (o teto) não vira balão em dobro', () => {
    const cap = item({ id: 'cap:s1', summary: 'o turno parou: passou de 40 ferramentas' });
    const err = item();
    expect(errorNoticesFor([cap, err], 's1', [cap.summary])).toEqual([err]);
    expect(errorNoticesFor([cap, err], 's1', ['outro texto'])).toEqual([cap, err]);
  });

  it('o balão traz a mesma frase da caixa, em alerta, sem o Ignorar', () => {
    const a = item();
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: a }));
    expect(html).toContain(inboxText(a));
    expect(html).toContain('role="alert"');
    expect(html).toContain(`data-item-id="${a.id}"`);
    expect(html).toContain('secret-notice is-error');
    expect(html).not.toContain('Ignorar');
    expect(html).not.toContain('actions');
  });

  it('a frase do servidor sai como texto: nada vira HTML', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: item({ summary: '<img src=x onerror=alert(1)>' }) }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('com `onIgnore` o botão aparece, com o título do erro (não o do segredo "já troquei")', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: item(), onIgnore: async () => {} }));
    expect(html).toContain('>Ignorar<');
    expect(html).toContain('Se a conversa parar com outro erro');
    expect(html).not.toContain('já troquei');
    expect(html).not.toContain('Já troquei');
  });

  it('o botão do erro chama o `onIgnore` do balão', () => {
    let clicked = 0;
    let button: ReactElement<{ onClick?: () => void; disabled?: boolean }> | null = null;
    const find = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(find);
      else if (isValidElement(node)) {
        const el = node as ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean }>;
        if (el.type === 'button') button = el;
        find(el.props.children);
      }
    };
    find(SecretNoticeView({ item: item(), busy: false, onIgnore: () => void clicked++ }));
    button!.props.onClick!();
    expect(clicked).toBe(1);
    expect(button!.props.disabled).toBe(false);
  });

  it('o balão de segredo segue com a classe e o Ignorar de sempre', () => {
    const s = item({ id: 'secret:s1:x', kind: 'secret', secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-input' } });
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: s, onIgnore: async () => {} }));
    expect(html).toContain('class="permission secret-notice"');
    expect(html).not.toContain('is-error');
    expect(html).toContain('>Ignorar<');
  });

  it('Ignorar um erro (balão ou caixa) chama a rota de erro com o id inteiro; os outros tipos seguem as rotas de sempre', async () => {
    const calls: string[] = [];
    const names = ['dismissError', 'dismissSecret', 'dismissRoutineAlert', 'dismissQuestion', 'dismissWaiting'] as const;
    const slots = api as unknown as Record<string, unknown>;
    const original = Object.fromEntries(names.map((n) => [n, slots[n]]));
    for (const name of names) slots[name] = async (...a: unknown[]) => (calls.push(`${name}:${a.join(',')}`), { ok: true });
    try {
      await dismissCall(item());
      await dismissCall(item({ id: 'cap:s1' }));
      await dismissCall(item({ id: 'secret:s1:x', kind: 'secret' }), { notSecret: true });
      await dismissCall(item({ id: 'routine:r1', kind: 'routine' }));
      await dismissCall(item({ id: 'question:s1', kind: 'waiting' }));
      await dismissCall(item({ id: 'waiting:s1', kind: 'waiting' }));
    } finally {
      Object.assign(slots, original);
    }
    expect(calls).toEqual([
      'dismissError:error:s1',
      'dismissError:cap:s1',
      'dismissSecret:s1:x,true',
      'dismissRoutineAlert:r1',
      'dismissQuestion:s1',
      'dismissWaiting:s1',
    ]);
  });

  it('ignorado o balão, a faixa vermelha do mesmo erro não volta no lugar dele', () => {
    const err = item();
    const text = err.summary;
    // balão na tela: a faixa fica de fora (já era assim)
    expect(errorLineShown(text, [err], null)).toBe(false);
    expect(errorSeenAsNotice(text, [err], null)).toBe(text);
    // erro chegou antes do balão (o inbox lê a cada 5 s): a faixa aparece, ainda sem "visto"
    expect(errorLineShown(text, [], null)).toBe(true);
    expect(errorSeenAsNotice(text, [], null)).toBe(null);
    // balão dispensado (aqui ou na caixa): o erro segue no estado da conversa, mas já foi visto como balão
    expect(errorLineShown(text, [], text)).toBe(false);
    expect(errorSeenAsNotice(text, [], text)).toBe(text);
    // outro erro depois: texto diferente, a faixa volta
    expect(errorLineShown('outro erro', [], text)).toBe(true);
    // o erro some (mensagem nova): zera, e o mesmo texto de novo aparece
    expect(errorSeenAsNotice(null, [], text)).toBe(null);
    expect(errorLineShown(text, [], null)).toBe(true);
    expect(errorLineShown(null, [], null)).toBe(false);
  });

  it('erro não leva botão de arquivo, mesmo com onFix', () => {
    const els: unknown[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (isValidElement(node)) {
        const el = node as ReactElement<{ children?: unknown }>;
        if (el.type === 'button') els.push(el);
        collect(el.props.children);
      }
    };
    collect(SecretNoticeView({ item: item(), busy: false, onFix: () => {} }));
    expect(els).toEqual([]);
  });
});
