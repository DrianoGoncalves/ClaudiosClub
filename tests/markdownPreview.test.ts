import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { looksLikeFileLink, resolveFromDir } from '../client/src/chat/filePath';
import { isMarkdownPath } from '../client/src/files/previewKind';
import { MarkdownPreview } from '../client/src/files/MarkdownPreview';

const preview = (text: string, path = 'docs/uso/README.md') =>
  renderToStaticMarkup(createElement(MarkdownPreview, { path, text, onOpen: () => {}, onSave: () => {} }));

describe('quais arquivos têm Visualizar', () => {
  it('só .md e .markdown, em qualquer caixa', () => {
    for (const p of ['README.md', 'docs/uso/02-x.md', 'NOTAS.MD', 'a/b.markdown', 'a/b.Markdown']) expect(isMarkdownPath(p)).toBe(true);
    for (const p of ['a.ts', 'a.mdx', 'a.md.bak', 'README', 'docs/md', 'a.html', 'markdown', 'a.json']) expect(isMarkdownPath(p)).toBe(false);
  });
});

describe('visualização do .md (mesmo renderizador seguro do chat)', () => {
  it('renderiza GFM: títulos, listas, tarefas, tabela, código e riscado', () => {
    const out = preview('# Título\n\n- a\n- [x] feito\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n~~velho~~');
    expect(out).toContain('<h1>Título</h1>');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('md-code');
    expect(out).toContain('<del>velho</del>');
  });

  it('HTML cru aparece como texto, nunca como tag', () => {
    const out = preview('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\ntexto <b>negrito</b> <iframe src="https://x"></iframe>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('onerror=alert(1)>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;negrito&lt;/b&gt;');
  });

  it('link só http, https e mailto; o resto vira texto sem href', () => {
    const out = preview('[a](https://x.com) [b](mailto:a@b.c) [c](javascript:alert(1)) [d](data:text/html,x) [e](//evil.com/x) [f](file:///C:/x.md)');
    expect(out).toContain('<a href="https://x.com" target="_blank" rel="noopener noreferrer">a</a>');
    expect(out).toContain('href="mailto:a@b.c"');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('data:');
    expect(out).not.toContain('evil.com');
    expect(out).not.toContain('file:');
    expect(out.match(/href=/g)?.length).toBe(2);
  });

  it('imagem remota não carrega: vira link, sem <img>', () => {
    const out = preview('![logo](https://x.com/a.png) ![local](./a.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('class="md-img"');
  });

  it('link para outro arquivo do projeto é botão (nunca href) e parte da pasta do .md', () => {
    const out = preview('[ok](02-funcionarios.md) [cima](../../README.md#topo) [fora](../../../x.md)');
    expect(out).toContain('<button type="button" class="md-file md-link"');
    expect(out).toContain('>ok</button>');
    expect(out).toContain('>cima</button>');
    expect(out).not.toContain('href=');
    expect(out).toContain('<span class="md-link-off">fora</span>');
  });

  it('é uma região rolável e com nome', () => {
    const out = preview('oi', 'a/b.md');
    expect(out).toContain('class="files-preview"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('role="region"');
    expect(out).toContain('a/b.md');
  });
});

describe('link relativo a partir da pasta do .md', () => {
  it('resolve irmão, subpasta, ./ e ..', () => {
    expect(resolveFromDir('outro.md', 'docs/uso')).toBe('docs/uso/outro.md');
    expect(resolveFromDir('./outro.md', 'docs/uso')).toBe('docs/uso/outro.md');
    expect(resolveFromDir('sub/x.png', 'docs')).toBe('docs/sub/x.png');
    expect(resolveFromDir('../x.md', 'docs/uso')).toBe('docs/x.md');
    expect(resolveFromDir('../../README.md', 'docs/uso')).toBe('README.md');
    expect(resolveFromDir('a.md', '')).toBe('a.md');
    expect(resolveFromDir('docs\\x.md', '')).toBe('docs/x.md');
  });

  it('tira âncora e sufixo de linha', () => {
    expect(resolveFromDir('x.md#secao', 'docs')).toBe('docs/x.md');
    expect(resolveFromDir('x.ts#L10-L20', 'src')).toBe('src/x.ts');
    expect(resolveFromDir('x.ts:42', 'src')).toBe('src/x.ts');
  });

  it('recusa o que sai do projeto, absoluto, esquema, só âncora e sem extensão', () => {
    expect(resolveFromDir('../x.md', '')).toBeNull();
    expect(resolveFromDir('../../x.md', 'docs')).toBeNull();
    expect(resolveFromDir('/etc/x.md', 'docs')).toBeNull();
    expect(resolveFromDir('C:\\x.md', 'docs')).toBeNull();
    expect(resolveFromDir('~/x.md', 'docs')).toBeNull();
    expect(resolveFromDir('https://a.b/x.md', 'docs')).toBeNull();
    expect(resolveFromDir('javascript:alert(1).js', 'docs')).toBeNull();
    expect(resolveFromDir('#secao', 'docs')).toBeNull();
    expect(resolveFromDir('LICENSE', 'docs')).toBeNull();
    expect(resolveFromDir('a//b.md', 'docs')).toBeNull();
    expect(resolveFromDir('..', 'docs')).toBeNull();
  });

  it('looksLikeFileLink aceita .. e âncora (só para passar pelo urlTransform)', () => {
    expect(looksLikeFileLink('../x.md#a')).toBe(true);
    expect(looksLikeFileLink('x.md')).toBe(true);
    expect(looksLikeFileLink('https://a.b/x.md')).toBe(false);
    expect(looksLikeFileLink('#a')).toBe(false);
  });
});
