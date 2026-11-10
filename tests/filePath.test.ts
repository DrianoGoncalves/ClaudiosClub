import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { projectRelativePath } from '../client/src/chat/filePath';
import { Markdown, OpenFileContext } from '../client/src/chat/markdown';

const ROOT = 'C:\\Users\\me\\MyCo';

describe('caminho de arquivo do projeto citado na resposta', () => {
  it('aceita relativo, com ./ e com \\', () => {
    expect(projectRelativePath('docs/x.md')).toBe('docs/x.md');
    expect(projectRelativePath('./x.md')).toBe('x.md');
    expect(projectRelativePath('README.md')).toBe('README.md');
    expect(projectRelativePath('src\\a\\b.ts')).toBe('src/a/b.ts');
  });

  it('absoluto só vale dentro do projeto (sem diferenciar maiúsculas, \\ ou /)', () => {
    expect(projectRelativePath('C:\\Users\\me\\MyCo\\docs\\x.md', ROOT)).toBe('docs/x.md');
    expect(projectRelativePath('c:/users/ME/myco/docs/x.md', ROOT)).toBe('docs/x.md');
    expect(projectRelativePath('C:\\Users\\me\\MyCo/docs/x.md', ROOT + '\\')).toBe('docs/x.md');
    expect(projectRelativePath('/home/a/MyCo/x.md', '/home/a/MyCo')).toBe('x.md');
  });

  it('absoluto fora do projeto, sem raiz ou com prefixo parecido: null', () => {
    expect(projectRelativePath('C:\\Users\\me\\Other\\x.md', ROOT)).toBeNull();
    expect(projectRelativePath('C:\\Users\\me\\MyCo2\\x.md', ROOT)).toBeNull();
    expect(projectRelativePath('C:\\Users\\me\\MyCo\\x.md')).toBeNull();
    expect(projectRelativePath('/etc/x.md', ROOT)).toBeNull();
  });

  it('tira o sufixo de linha (:42, :42:7, #L10, #L10-L20)', () => {
    expect(projectRelativePath('src/a.ts:42')).toBe('src/a.ts');
    expect(projectRelativePath('src/a.ts:42:7')).toBe('src/a.ts');
    expect(projectRelativePath('src/a.ts#L10')).toBe('src/a.ts');
    expect(projectRelativePath('src/a.ts#L10-L20')).toBe('src/a.ts');
    expect(projectRelativePath('C:\\Users\\me\\MyCo\\src\\a.ts:42', ROOT)).toBe('src/a.ts');
  });

  it('recusa .. em qualquer segmento e ~', () => {
    expect(projectRelativePath('../x.md')).toBeNull();
    expect(projectRelativePath('a/../b.md')).toBeNull();
    expect(projectRelativePath('a\\..\\b.md')).toBeNull();
    expect(projectRelativePath('C:\\Users\\me\\MyCo\\..\\x.md', ROOT)).toBeNull();
    expect(projectRelativePath('~/x.md')).toBeNull();
  });

  it('recusa URL e esquema (http, file, javascript)', () => {
    expect(projectRelativePath('https://example.com/a.md')).toBeNull();
    expect(projectRelativePath('file:///C:/x.md')).toBeNull();
    expect(projectRelativePath('javascript:alert(1).js')).toBeNull();
    expect(projectRelativePath('mailto:a@b.c')).toBeNull();
  });

  it('exige extensão no nome, sem espaço', () => {
    expect(projectRelativePath('docs/LICENSE')).toBeNull();
    expect(projectRelativePath('Makefile')).toBeNull();
    expect(projectRelativePath('minha pasta/x.md')).toBeNull();
    expect(projectRelativePath('')).toBeNull();
    expect(projectRelativePath('docs/')).toBeNull();
  });
});

describe('Markdown com OpenFileContext', () => {
  const html = (text: string, withContext: boolean) => {
    const md = createElement(Markdown, { text });
    const el = withContext ? createElement(OpenFileContext.Provider, { value: { projectRoot: ROOT, open: () => {} } }, md) : md;
    return renderToStaticMarkup(el);
  };

  it('caminho no código inline e no link vira botão, nunca <a href>', () => {
    const out = html('veja `docs/x.md:42` e [spec](docs/spec.md)', true);
    expect(out).toContain('<button type="button" class="md-file"');
    expect(out).toContain('docs/x.md:42');
    expect(out).toContain('>spec</button>');
    expect(out).not.toContain('href="docs');
  });

  it('código de bloco não vira botão, mesmo com caminho dentro', () => {
    const out = html('```\ndocs/x.md\n```', true);
    expect(out).not.toContain('md-file');
    expect(out).toContain('docs/x.md');
  });

  it('sem context, o caminho segue como texto (como antes)', () => {
    const out = html('veja `docs/x.md` e [spec](docs/spec.md)', false);
    expect(out).not.toContain('md-file');
    expect(out).toContain('<code>docs/x.md</code>');
    expect(out).toContain('<span class="md-link-off">spec</span>');
  });

  it('link http continua <a>, mesmo com context', () => {
    const out = html('[doc](https://example.com)', true);
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">doc</a>');
  });
});
