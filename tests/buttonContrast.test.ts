import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Contraste dos botões (regra em docs/design-system.md): texto da primária e da destrutiva ≥ 4,5:1 nos dois temas.
const css = readFileSync('client/src/styles.css', 'utf8');

const block = (start: RegExp): string => {
  const i = css.search(start);
  return css.slice(i, css.indexOf('\n}', i));
};
const light = block(/^:root\s*\{/m);
const dark = block(/^:root\[data-theme='dark'\]\s*\{/m);

const tok = (scope: string, name: string): string => {
  const m = scope.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m?.[1]) throw new Error(`token ${name} não achado`);
  return m[1];
};
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r = 0, g = 0, b = 0] = c;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const themes = { claro: light, escuro: dark } as const;

describe.each(Object.entries(themes))('botões, tema %s', (_name, scope) => {
  it('primária: --on-ink-blue sobre --ink-blue ≥ 4,5', () => {
    expect(ratio(tok(scope, '--on-ink-blue'), tok(scope, '--ink-blue'))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([['--card-base'], ['--panel'], ['--board-base']])('destrutiva: --danger sobre %s ≥ 4,5', (surface) => {
    expect(ratio(tok(scope, '--danger'), tok(scope, surface))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('CSS dos botões', () => {
  it('a primária usa --on-ink-blue e os botões têm foco visível e o mesmo tamanho (o do Salvar ficha)', () => {
    expect(css).toMatch(/:is\(\.btn-primary, \.btn-secondary\):focus-visible \{ outline: 2px solid var\(--ink-blue\)/);
    expect(css).toMatch(/:is\(\.btn-primary, \.btn-secondary\):not\([^)]*\) \{ font-size: var\(--btn-font\); line-height: var\(--btn-lh\); padding: var\(--btn-pad\); min-height: var\(--btn-h\);/);
    expect(css).not.toMatch(/font-size: *\d+(\.\d+)?px/);
    // shorthand `font:` (peso opcional, depois o tamanho): o tamanho também vem do token
    expect(css).not.toMatch(/\bfont:\s*(?:[a-z-]+\s+|\d{3}\s+)*\d+(\.\d+)?px/);
    expect(css).toMatch(/\.btn-primary \{[^}]*color: var\(--on-ink-blue\);/);
  });
});
