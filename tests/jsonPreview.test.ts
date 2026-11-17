import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { JsonPreview } from '../client/src/files/JsonPreview';
import { OPEN_ALL_MAX, PAGE, STRING_MAX, countNodes, findJsonError, parseJson } from '../client/src/files/jsonView';
import { isJsonPath, isMarkdownPath, previewKind } from '../client/src/files/previewKind';

const preview = (text: string, path = 'package.json') =>
  renderToStaticMarkup(createElement(JsonPreview, { path, text, onSave: () => {} }));
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('quais arquivos têm Visualizar', () => {
  it('.json por extensão, em qualquer caixa; .md segue; o resto não tem', () => {
    for (const p of ['package.json', 'a/b/tsconfig.JSON', 'x.Json']) expect(previewKind(p)).toBe('json');
    for (const p of ['README.md', 'a/b.markdown', 'NOTAS.MD']) expect(previewKind(p)).toBe('markdown');
    for (const p of ['a.jsonc', 'a.json5', 'a.json.bak', 'a.geojson', 'json', 'a.ts', 'README', 'a.html']) expect(previewKind(p)).toBeNull();
    expect(isJsonPath('a.json')).toBe(true);
    expect(isMarkdownPath('a.json')).toBe(false);
  });
});

describe('ler o texto (só JSON.parse)', () => {
  it('JSON válido, com BOM também', () => {
    expect(parseJson('{"a":[1,true,null]}')).toEqual({ ok: true, value: { a: [1, true, null] } });
    expect(parseJson('\uFEFF[1]')).toEqual({ ok: true, value: [1] });
    expect(parseJson('"só texto"')).toEqual({ ok: true, value: 'só texto' });
  });

  it('vazio é um caso à parte, não um erro de parse', () => {
    expect(parseJson('')).toEqual({ ok: false, empty: true });
    expect(parseJson(' \n\t ')).toEqual({ ok: false, empty: true });
  });

  it('inválido devolve a mensagem do motor e a linha/coluna quando dá', () => {
    const r = parseJson('{\n  "a": 1,\n  "b": ,\n}');
    expect(r.ok).toBe(false);
    if (r.ok || r.empty) throw new Error('esperava erro de parse');
    expect(r.message.length).toBeGreaterThan(0);
    // O V8 informa a posição; o resultado tem de apontar para a linha 3 (onde está a vírgula solta).
    expect(r.line).toBe(3);
    expect(r.column).toBe(8);
  });

  it('sem posição na mensagem do motor (vírgula sobrando em lista), o localizador aponta o caractere', () => {
    const r = parseJson('[1,\n 2,]');
    if (r.ok || r.empty) throw new Error('esperava erro de parse');
    expect(r.line).toBe(2);
    expect(r.column).toBe(4);
  });

  it('linha e coluna sempre juntas; texto cortado no meio aponta o fim', () => {
    for (const bad of ['{', '[1,', '{"a":', '"abc', 'nul', '{"a":1}x']) {
      const r = parseJson(bad);
      if (r.ok || r.empty) throw new Error(`esperava erro em ${bad}`);
      expect(r.line === null).toBe(r.column === null);
    }
  });

  it('countNodes para no limite (profundidade e custo ficam presos nele)', () => {
    expect(countNodes({ a: [1, 2], b: 'x' }, 100)).toBe(5);
    const wide = Array.from({ length: 10_000 }, (_, i) => i);
    expect(countNodes(wide, OPEN_ALL_MAX)).toBe(OPEN_ALL_MAX + 1);
    let deep: unknown = 0;
    for (let i = 0; i < 5000; i++) deep = [deep];
    expect(countNodes(deep as never, OPEN_ALL_MAX)).toBe(OPEN_ALL_MAX + 1);
  });
});

describe('localizador de erro (quando o motor não diz a posição)', () => {
  const valid = ['0', '-1.5e+10', '"a\\u00e9\\n"', 'true', 'null', '[]', '{}', '[1,[2,[3]]]', ' {"a" : [ 1 , { "b" : null } ] } ', '{"":""}', '[0.5,-0,1E3]'];
  const invalid = ['01', '-', '1.', '.5', '+1', '[1,]', '{"a":1,}', '{a:1}', "{'a':1}", '[1 2]', '{"a" 1}', '"a', '"a\nb"', '"\\x"', '"\\u12G4"', 'tru', 'nul', '[1]x', '{"a":}', '[,1]', '{,}', '{"a":1 "b":2}', '//c\n1', 'NaN', 'undefined'];

  it('aceita o que o JSON.parse aceita e recusa o que ele recusa', () => {
    for (const s of valid) {
      expect(() => JSON.parse(s)).not.toThrow();
      expect(findJsonError(s), s).toBeNull();
    }
    for (const s of invalid) {
      expect(() => JSON.parse(s), s).toThrow();
      expect(findJsonError(s), s).not.toBeNull();
    }
  });

  it('concorda com o JSON.parse em textos mutados (válidos com um caractere trocado, tirado ou posto)', () => {
    const base = '{"a":[1,2.5,true,null,"x\\ny"],"b":{"c":"d","e":[]},"f":-3}';
    const junk = ['', ',', ':', '{', '}', '[', ']', '"', '\\', 'x', '1', ' '];
    let rejected = 0;
    for (let i = 0; i <= base.length; i++) {
      for (const j of junk) {
        for (const s of [base.slice(0, i) + j + base.slice(i + 1), base.slice(0, i) + j + base.slice(i)]) {
          let engine = true;
          try {
            JSON.parse(s);
          } catch {
            engine = false;
          }
          expect(findJsonError(s) === null, JSON.stringify(s)).toBe(engine);
          if (!engine) rejected++;
        }
      }
    }
    expect(rejected).toBeGreaterThan(100);
  });

  it('aponta o caractere certo', () => {
    expect(findJsonError('[1,]')).toBe(3);
    expect(findJsonError('{"a":1,}')).toBe(7);
    expect(findJsonError('[1] x')).toBe(4);
    expect(findJsonError('{"a" 1}')).toBe(5);
    expect(findJsonError('{"a":01}')).toBe(6);
    expect(findJsonError('{"a":"x')).toBe(7);
  });

  it('aninhamento absurdo não derruba: devolve null em vez de estourar a pilha', () => {
    expect(() => findJsonError('['.repeat(200_000))).not.toThrow();
  });
});

describe('árvore do JSON', () => {
  it('JSON pequeno abre inteiro, com chaves e tipos distinguíveis', () => {
    const out = preview('{"nome":"club","versao":3,"ativo":true,"extra":null,"itens":[1,"a"],"vazio":{},"lista":[]}');
    expect(out).toContain('class="json-tree"');
    expect(out).toContain('<span class="json-key">&quot;nome&quot;</span>');
    expect(out).toContain('<span class="json-string">&quot;club&quot;</span>');
    expect(out).toContain('<span class="json-number">3</span>');
    expect(out).toContain('<span class="json-bool">true</span>');
    expect(out).toContain('<span class="json-null">null</span>');
    expect(out).toContain('<span class="json-index">0</span>');
    // Vazio não tem seta nem botão; o recolhível tem aria-expanded e a contagem.
    expect(out).toContain('<span class="json-punct">{}</span>');
    expect(out).toContain('<span class="json-punct">[]</span>');
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('2 itens');
    expect(out).toContain('7 chaves');
  });

  it('1 item e 1 chave no singular', () => {
    const out = preview('{"a":[1]}');
    expect(out).toContain('1 chave');
    expect(out).toContain('1 item<');
  });

  it('raiz que não é objeto/lista também aparece', () => {
    expect(preview('42')).toContain('<span class="json-number">42</span>');
    expect(preview('"oi"')).toContain('<span class="json-string">&quot;oi&quot;</span>');
    expect(preview('null')).toContain('<span class="json-null">null</span>');
  });

  it('é uma região rolável e com nome (a moldura é a mesma do .md)', () => {
    const out = preview('{}', 'a/b.json');
    expect(out).toContain('class="files-preview"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('role="region"');
    expect(out).toContain('a/b.json');
  });
});

describe('valores só como texto', () => {
  it('HTML em valor e em chave aparece escapado, nunca como tag', () => {
    const out = preview(
      '{"<img src=x onerror=alert(1)>":"<script>alert(1)</script><b>negrito</b>","h":"<iframe src=\\"https://x\\"></iframe>"}',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;negrito&lt;/b&gt;');
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('URL e esquemas perigosos viram texto: nenhum link, nenhum href', () => {
    const out = preview('{"site":"https://exemplo.com/x","js":"javascript:alert(1)","mail":"mailto:a@b.c","md":"[a](https://x.com)"}');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('href=');
    expect(out).not.toContain('<button type="button" class="md-');
    expect(out).toContain('https://exemplo.com/x');
    expect(out).toContain('javascript:alert(1)');
  });

  it('chave __proto__ é só mais uma chave (JSON.parse cria propriedade própria)', () => {
    const out = preview('{"__proto__":{"admin":true},"a":1}');
    expect(out).toContain('&quot;__proto__&quot;');
    expect(out).toContain('&quot;admin&quot;');
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('quebra de linha e aspas dentro do texto saem escapadas, em uma linha', () => {
    const out = preview('{"t":"a\\nb \\"c\\""}');
    expect(out).toContain('&quot;a\\nb \\&quot;c\\&quot;&quot;');
  });
});

describe('JSON inválido ou vazio não quebra a tela', () => {
  it('mostra o erro do parse com a posição, sem árvore', () => {
    const out = preview('{\n  "a": 1,\n  "b": ,\n}');
    expect(out).toContain('class="json-error"');
    expect(out).toContain('role="alert"');
    expect(out).toContain('JSON inválido');
    expect(out).toContain('linha 3, coluna 8');
    expect(out).not.toContain('json-tree');
    expect(out).toContain('class="files-preview"');
  });

  it('a mensagem do motor também é texto: HTML nela não vira tag', () => {
    const out = preview('<img src=x onerror=alert(1)>');
    expect(out).toContain('class="json-error"');
    expect(out).not.toContain('<img');
  });

  it('arquivo vazio tem aviso próprio, sem alerta de erro', () => {
    const out = preview('  \n');
    expect(out).toContain('Arquivo vazio');
    expect(out).not.toContain('json-error');
    expect(out).not.toContain('json-tree');
  });
});

describe('arquivo grande não trava a aba', () => {
  it('lista enorme: só a primeira página vira elemento, com "mostrar mais"', () => {
    const big = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ id: i, nome: `item ${i}` })));
    const out = preview(big);
    expect(count(out, 'class="json-row"')).toBeLessThanOrEqual(PAGE + 2);
    expect(out).toContain('json-more');
    expect(out).toContain(`Mostrar mais (${50_000 - PAGE} restantes)`);
    // A raiz abre; os 100 objetos filhos ficam recolhidos (sem seus campos na tela).
    expect(count(out, 'aria-expanded="true"')).toBe(1);
    expect(out).not.toContain('item 0<');
    expect(out.length).toBeLessThan(200_000);
  });

  it('profundidade enorme: só a raiz abre, o resto sob demanda', () => {
    let deep = '0';
    for (let i = 0; i < 400; i++) deep = `{"a":${deep}}`;
    const out = preview(deep);
    expect(count(out, 'aria-expanded="true"')).toBe(1);
    expect(count(out, 'aria-expanded="false"')).toBe(1);
  });

  it('texto gigante aparece cortado, com "mostrar tudo"', () => {
    const out = preview(JSON.stringify({ blob: 'x'.repeat(STRING_MAX * 50) }));
    expect(out).toContain(`Mostrar tudo (+${STRING_MAX * 49} caracteres)`);
    expect(out.length).toBeLessThan(STRING_MAX * 3);
  });

  it('JSON pequeno não pagina nem corta nada', () => {
    const out = preview(JSON.stringify({ a: 'x'.repeat(STRING_MAX), b: Array.from({ length: 50 }, (_, i) => i) }));
    expect(out).not.toContain('json-more');
  });
});
