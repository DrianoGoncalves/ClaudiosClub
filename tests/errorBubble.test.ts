import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretNotice, SecretNoticeView } from '../client/src/chat/SecretNotice';
import { errorNoticesFor, secretNoticesFor } from '../client/src/chat/secretAlerts';
import { inboxText } from '../client/src/inbox/inboxText';
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

  it('com `onIgnore` (quando o servidor puder dispensar erro) o botão volta, igual ao do segredo', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: item(), onIgnore: async () => {} }));
    expect(html).toContain('>Ignorar<');
  });

  it('o balão de segredo segue com a classe e o Ignorar de sempre', () => {
    const s = item({ id: 'secret:s1:x', kind: 'secret', secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-input' } });
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: s, onIgnore: async () => {} }));
    expect(html).toContain('class="permission secret-notice"');
    expect(html).not.toContain('is-error');
    expect(html).toContain('>Ignorar<');
  });

  it('erro não leva botão de arquivo, mesmo com onOpenFile', () => {
    const els: unknown[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (isValidElement(node)) {
        const el = node as ReactElement<{ children?: unknown }>;
        if (el.type === 'button') els.push(el);
        collect(el.props.children);
      }
    };
    collect(SecretNoticeView({ item: item(), busy: false, onOpenFile: () => {} }));
    expect(els).toEqual([]);
  });
});
