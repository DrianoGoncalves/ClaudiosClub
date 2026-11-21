import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InboxMenu } from '../client/src/inbox/InboxMenu';
import { pendingOf } from '../client/src/inbox/resolved';
import type { InboxView } from '../client/src/inbox/useInbox';
import type { InboxItem } from '../shared/model';

// Aviso de erro já resolvido (`InboxItem.resolvedAt`): selo "Resolvido" e item atenuado na caixa, fora da contagem de pendências; sem a marca, igual a antes.

const AT = '2026-11-19T10:00:00Z';
const noop = () => {};
const error = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({ id, kind: 'error', projectId: 'p-1', projectName: 'MyCo', sessionId: 's-1', staffId: null, name: 'Beto', summary: 'x', at: AT, ...over });
const inbox = (items: InboxItem[]): InboxView => ({ items, notify: false, canNotify: false, setNotify: async () => {}, dismiss: async () => {}, refresh: async () => {} });
const menu = (items: InboxItem[]) => renderToStaticMarkup(createElement(InboxMenu, { inbox: inbox(items), titleOf: new Map(), onOpen: noop, initialOpen: true }));
const open = error('error:a');
const done = error('error:b', { resolvedAt: AT });

describe('caixa: erro resolvido', () => {
  it('com a marca: selo e item atenuado; sem ela: nenhum dos dois', () => {
    const html = menu([done]);
    expect(html).toContain('inbox-resolved');
    expect(html).toContain('Resolvido');
    expect(html).toContain('is-resolved');
    const plain = menu([open]);
    expect(plain).not.toContain('inbox-resolved');
    expect(plain).not.toContain('is-resolved');
  });

  it('o número do sino conta só os pendentes; só resolvidos = sem número, mas a lista aparece', () => {
    expect(pendingOf([open, done])).toEqual([open]);
    const mixed = menu([open, done]);
    expect(mixed).toContain('<span class="inbox-count">1</span>');
    const only = menu([done]);
    expect(only).not.toContain('inbox-count');
    expect(only).toContain('inbox-list');
    expect(only).not.toContain('inbox-empty');
  });
});
