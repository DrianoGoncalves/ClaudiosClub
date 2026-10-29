import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, looksLikeMarkdown, safeUrl } from '../client/src/chat/markdown';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown do chat (GFM, seguro)', () => {
  it('link javascript: não vira link', () => {
    const out = html('[clique](javascript:alert(1)) e <javascript:alert(2)>');
    expect(out).not.toMatch(/href="javascript/i);
    expect(out).not.toContain('<a ');
    expect(out).toContain('clique');
  });

  it('links seguros abrem em aba nova sem opener', () => {
    const out = html('[doc](https://example.com) [mail](mailto:a@b.c) [rel](./x) [data](data:text/html,x)');
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">doc</a>');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).not.toContain('href="./x"');
    expect(out).not.toContain('href="data:');
  });

  it('HTML cru aparece como texto, nunca como elemento', () => {
    const out = html('oi <img src=x onerror="alert(1)"> <b onclick="x">b</b>\n\n<script>alert(1)</script>');
    expect(out).not.toMatch(/<img|<script|<b /);
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('imagem remota vira link, sem carregar', () => {
    const out = html('![logo](https://example.com/x.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://example.com/x.png"');
    expect(out).toContain('logo');
  });

  it('tabela GFM fica numa caixa com rolagem; lista aninhada e código com linguagem', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n  - y\n\n```ts\nconst a = 1;\n```');
    expect(out).toContain('<div class="md-table"><table>');
    expect(out).toMatch(/<li>x\s*<ul>\s*<li>y<\/li>/);
    expect(out).toContain('class="md-code-lang">ts<');
    expect(out).toContain('const a = 1;');
  });

  it('streaming: bloco de código e tabela abertos não quebram', () => {
    expect(html('```py\nprint(1)')).toContain('print(1)');
    expect(html('| a | b |\n|---|---|\n| 1')).toContain('<td>1</td>');
  });

  it('safeUrl e detecção de markdown do usuário', () => {
    expect(safeUrl(' JavaScript:alert(1)')).toBe('');
    expect(safeUrl('HTTPS://x.com')).toBe('HTTPS://x.com');
    expect(looksLikeMarkdown('oi\ntudo bem?')).toBe(false);
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true);
    expect(looksLikeMarkdown('| a | b |')).toBe(true);
  });
});
