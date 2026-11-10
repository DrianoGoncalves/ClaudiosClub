import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MsgTime } from '../client/src/chat/MsgTime';

describe('rodape da mensagem', () => {
  const at = '2026-11-10T12:30:00Z';
  it('mostra o motor e o modelo depois do horario', () => {
    const html = renderToStaticMarkup(createElement(MsgTime, { at, fallback: { engine: 'codex', model: 'gpt-test' } }));
    expect(html).toMatch(/<time.*<\/time>.*secundário: Codex \(GPT\)/);
    expect(html).toContain('title="Modelo: gpt-test"');
  });
  it('mantem horario sem aviso para mensagens sem fallback e exibe aviso sem horario', () => {
    expect(renderToStaticMarkup(createElement(MsgTime, { at }))).not.toContain('secundário');
    const html = renderToStaticMarkup(createElement(MsgTime, { at: null, fallback: { engine: 'claude', model: 'sonnet' } }));
    expect(html).toContain('secundário: Claude');
    expect(html).not.toContain('<time');
  });
});
