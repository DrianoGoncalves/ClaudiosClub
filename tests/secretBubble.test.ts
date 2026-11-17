import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretNotice, SecretNoticeView } from '../client/src/chat/SecretNotice';
import { secretFileOf, secretNoticesFor } from '../client/src/chat/secretAlerts';
import { secretText } from '../client/src/inbox/secretText';
import type { InboxItem } from '../shared/model';

const item = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'secret:s1:senha na variável DB_PASSWORD',
  kind: 'secret',
  projectId: 'p1',
  projectName: 'Projeto',
  sessionId: 's1',
  staffId: 'f1',
  name: 'Ana',
  summary: 'Senha na variável DB_PASSWORD apareceu no chat: troque e não cole segredos na conversa',
  at: '2026-11-16T10:00:00.000Z',
  secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-input' },
  ...over,
});

describe('balão de segredo no chat', () => {
  it('pega só os avisos de segredo da conversa aberta', () => {
    const mine = item();
    const other = item({ id: 'secret:s2:x', sessionId: 's2' });
    const waiting = item({ id: 'waiting:s1', kind: 'waiting' });
    expect(secretNoticesFor([other, waiting, mine], 's1')).toEqual([mine]);
    expect(secretNoticesFor([mine], 's2')).toEqual([]);
  });

  it('sem conversa (ou sem caixa) não há balão: aviso do .mcp.json fica só na caixa', () => {
    const mcp = item({ id: 'secret:mcp:p1:srv', sessionId: '', secret: undefined });
    expect(secretNoticesFor([mcp], '')).toEqual([]);
    expect(secretNoticesFor([mcp, item()], null)).toEqual([]);
    expect(secretNoticesFor(undefined, 's1')).toEqual([]);
  });

  it('um aviso = um balão, mesmo se a lista repetir o id', () => {
    const a = item();
    expect(secretNoticesFor([a, { ...a }, { ...a }], 's1')).toHaveLength(1);
  });

  it('o balão traz a mesma frase da caixa e o Ignorar', () => {
    const a = item();
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: a, onIgnore: async () => {} }));
    expect(html).toContain(secretText(a));
    expect(html).toContain('>Ignorar<');
    expect(html).toContain(`data-item-id="${a.id}"`);
    expect(html).toContain('role="alert"');
  });

  it('sem o tipo (servidor antigo) cai no resumo do servidor', () => {
    const old = item({ secret: undefined, summary: 'Resumo do servidor' });
    expect(renderToStaticMarkup(createElement(SecretNotice, { item: old, onIgnore: async () => {} }))).toContain('Resumo do servidor');
  });

  it('não leva dado além do item: nada de valor, e o aviso não tem campo para ele', () => {
    const a = item();
    expect(Object.keys(a.secret ?? {}).sort()).toEqual(['detail', 'kind', 'source']);
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: a, onIgnore: async () => {} }));
    expect(html).not.toMatch(/title="[^"]*(DB_PASSWORD|senha)/i);
  });
});

/** Procura, na árvore de elementos que a view devolve, os `<button>` (a view não tem hooks, então roda sem navegador). */
function buttons(node: unknown, out: ReactElement<{ onClick?: () => void; children?: unknown; disabled?: boolean }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<{ onClick?: () => void; children?: unknown; disabled?: boolean }>;
    if (el.type === 'button') out.push(el);
    buttons(el.props.children, out);
  }
  return out;
}
const view = (a: InboxItem, onOpenFile?: (path: string) => void, onIgnore = () => {}) => SecretNoticeView({ item: a, busy: false, onIgnore, onOpenFile });
const withFile = (secret: Partial<NonNullable<InboxItem['secret']>>) => item({ secret: { kind: 'password-env', detail: 'DB_PASSWORD', source: 'tool-input', ...secret } });

describe('botão que abre o arquivo do segredo', () => {
  it('com o caminho, o botão aparece com o caminho no balão e abre esse arquivo ao clicar', () => {
    const a = withFile({ file: 'config/app.ini' });
    const opened: string[] = [];
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: a, onIgnore: async () => {}, onOpenFile: (p) => opened.push(p) }));
    expect(html).toContain('>Abrir arquivo<');
    expect(html).toContain('<code>config/app.ini</code>');
    expect(html).toContain('Abre config/app.ini no editor');
    const open = buttons(view(a, (p) => opened.push(p))).find((b) => b.props.children === 'Abrir arquivo');
    open!.props.onClick!();
    expect(opened).toEqual(['config/app.ini']);
  });

  it('o Ignorar segue igual e vem depois do botão do arquivo', () => {
    const a = withFile({ file: 'a/b.env.example' });
    let ignored = 0;
    const list = buttons(view(a, () => {}, () => (ignored += 1)));
    expect(list.map((b) => b.props.children)).toEqual(['Abrir arquivo', 'Ignorar']);
    list[1]!.props.onClick!();
    expect(ignored).toBe(1);
  });

  it('sem o caminho (servidor antigo, aviso sem arquivo) o balão é o de antes: sem botão e sem linha de arquivo', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: item(), onIgnore: async () => {}, onOpenFile: () => {} }));
    expect(html).not.toContain('Abrir arquivo');
    expect(html).not.toContain('secret-file');
    expect(buttons(view(item(), () => {})).map((b) => b.props.children)).toEqual(['Ignorar']);
  });

  it('sem como abrir arquivo (nenhum editor ligado), mostra o caminho e não o botão', () => {
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: withFile({ file: 'a/b.ini' }), onIgnore: async () => {} }));
    expect(html).toContain('<code>a/b.ini</code>');
    expect(html).not.toContain('Abrir arquivo');
  });

  it('arquivo que a tela recusa (.env, chave): caminho e "abra no seu editor", sem botão', () => {
    const a = withFile({ file: '.env', fileBlocked: true });
    const html = renderToStaticMarkup(createElement(SecretNotice, { item: a, onIgnore: async () => {}, onOpenFile: () => {} }));
    expect(html).toContain('<code>.env</code>');
    expect(html).toContain('abra no seu editor');
    expect(html).not.toContain('Abrir arquivo');
  });

  it('caminho fora do projeto (absoluto, "..", unidade, barra invertida) não vira botão nem texto', () => {
    for (const file of ['/etc/passwd', 'C:/Users/x/.env', '../fora.txt', 'a/../../b.txt', 'a\\b.txt', '~/x', 'a//b', './a.txt', '']) {
      const a = withFile({ file });
      expect(secretFileOf(a), file).toBeNull();
      const html = renderToStaticMarkup(createElement(SecretNotice, { item: a, onIgnore: async () => {}, onOpenFile: () => {} }));
      expect(html, file).not.toContain('Abrir arquivo');
      expect(html, file).not.toContain('secret-file');
    }
    expect(secretFileOf(withFile({ file: 'src/app/config.ts' }))).toEqual({ path: 'src/app/config.ts', blocked: false });
    expect(secretFileOf(withFile({ file: 'k.pem', fileBlocked: true }))).toEqual({ path: 'k.pem', blocked: true });
  });

  it('o título do botão leva só o caminho: nada do tipo nem do detalhe do segredo', () => {
    const open = buttons(view(withFile({ file: 'config/app.ini' }), () => {})).find((b) => b.props.children === 'Abrir arquivo');
    expect(JSON.stringify(open)).not.toMatch(/DB_PASSWORD|password-env/);
  });
});
