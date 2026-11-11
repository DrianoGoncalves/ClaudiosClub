import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FallbackIcon } from '../client/src/board/nodes';
import messages from '../client/src/i18n/board';

describe('indicador de motor secundário no organograma', () => {
  it('não aparece sem secundário e identifica motor e modelo quando existe', () => {
    expect(renderToStaticMarkup(createElement(FallbackIcon, {}))).toBe('');
    const codex = renderToStaticMarkup(createElement(FallbackIcon, { fallback: { engine: 'codex', model: 'gpt-6-sol' } }));
    expect(codex).toContain('title="Secundário: Codex (GPT) · gpt-6-sol"');
    expect(codex).toContain('aria-label="Secundário: Codex (GPT) · gpt-6-sol"');
    const claude = renderToStaticMarkup(createElement(FallbackIcon, { fallback: { engine: 'claude', model: 'sonnet' } }));
    expect(claude).toContain('Secundário: Claude · sonnet');
  });

  it('tem texto com motor e modelo nos três idiomas', () => {
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      expect(messages[locale]['board.secondaryEngine']).toContain('{engine}');
      expect(messages[locale]['board.secondaryEngine']).toContain('{model}');
    }
  });
});
