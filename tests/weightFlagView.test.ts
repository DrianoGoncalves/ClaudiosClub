import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import staffMessages from '../client/src/i18n/staff';
import { WEIGHT_MB } from '../client/src/staff/mcpWeight';
import { WeightFlags, weightFlags, type WeightCtx, type WeightId } from '../client/src/staff/WeightFlag';

const ALL: WeightId[] = ['claude', 'codexRun', 'gpt', 'browser', 'mcps', 'model', 'effort'];
const base = (over: Partial<WeightCtx> = {}): WeightCtx => ({ engine: 'claude', gpt: false, browser: false, mcps: 0, model: '', effort: '', ...over });
const kindsOf = (ctx: WeightCtx) => Object.fromEntries(weightFlags(ctx, ALL).map((f) => [f.id, f.kinds]));

describe('selos de peso da ficha', () => {
  it('Claude sem nada ligado: só a base da conversa (memória medida)', () => {
    const flags = weightFlags(base(), ALL);
    expect(flags.map((f) => f.id)).toEqual(['claude']);
    expect(flags[0]!.kinds).toEqual(['memory']);
    expect(flags[0]!.label).toContain(`${WEIGHT_MB.claude[0]}`);
    expect(flags[0]!.label).toContain(`${WEIGHT_MB.claude[1]}`);
  });

  it('GPT ligado nas Configurações: memória E limite (a pergunta abre outra chamada no Codex)', () => {
    expect(kindsOf(base({ gpt: true })).gpt).toEqual(['memory', 'limit']);
    expect(kindsOf(base({ gpt: false })).gpt).toBeUndefined();
  });

  it('navegador: memória, com o proxy sempre aberto e o navegador de verdade só ao usar', () => {
    expect(kindsOf(base()).browser).toBeUndefined();
    const flag = weightFlags(base({ browser: true }), ['browser'])[0]!;
    expect(flag.kinds).toEqual(['memory']);
    expect(flag.tip).toContain(`${WEIGHT_MB.browserProxy[1]}`);
    expect(flag.tip).toContain(`${WEIGHT_MB.browser[0]}`);
    expect(flag.tip).toContain(`${WEIGHT_MB.browser[1]}`);
    expect(flag.tip).not.toContain('não pesa');
  });

  it('modelo: só os grandes ganham selo de limite (Opus, Fable); Sonnet, Haiku e o padrão ficam sem', () => {
    for (const model of ['opus', 'fable', 'claude-opus-4-7']) expect(kindsOf(base({ model })).model).toEqual(['limit']);
    for (const model of ['', 'sonnet', 'haiku']) expect(kindsOf(base({ model })).model).toBeUndefined();
  });

  it('esforço: de alto para cima ganha selo de limite; baixo, médio e o padrão não', () => {
    for (const effort of ['high', 'xhigh', 'max']) expect(kindsOf(base({ effort })).effort).toEqual(['limit']);
    for (const effort of ['', 'low', 'medium']) expect(kindsOf(base({ effort })).effort).toBeUndefined();
  });

  it('MCPs marcados: informa sem selo (peso não medido)', () => {
    expect(kindsOf(base({ mcps: 2 })).mcps).toEqual([]);
    expect(kindsOf(base({ mcps: 0 })).mcps).toBeUndefined();
  });

  it('GPT como motor: sem selo nem número (não há medida); modelo, esforço, navegador e MCP do Claude não valem', () => {
    const ctx = base({ engine: 'codex', gpt: true, browser: true, mcps: 3, model: 'opus', effort: 'max' });
    expect(weightFlags(ctx, ALL).map((f) => [f.id, f.kinds])).toEqual([['codexRun', []]]);
  });

  it('só devolve o que foi pedido, na ordem pedida', () => {
    const ctx = base({ gpt: true, browser: true, model: 'opus' });
    expect(weightFlags(ctx, ['model', 'claude']).map((f) => f.id)).toEqual(['model', 'claude']);
  });

  it('o limite nunca leva número (só comparação)', () => {
    const limit = weightFlags(base({ model: 'opus', effort: 'max' }), ['model', 'effort']);
    for (const f of limit) expect(`${f.label} ${f.tip}`).not.toMatch(/\d/);
  });

  it('os textos existem nos 3 idiomas e o selo diz o peso em palavras', () => {
    const keys = [
      ...ALL.flatMap((id) => [`staff.w.${id}`, `staff.w.${id}Tip`]),
      'staff.w.memory',
      'staff.w.limit',
      'staff.w.hint',
    ];
    for (const locale of ['pt-BR', 'en', 'es'] as const) {
      const dict = staffMessages[locale] as Record<string, string>;
      for (const key of keys) expect(dict[key], `${locale} ${key}`).toBeTruthy();
    }
    expect((staffMessages['pt-BR'] as Record<string, string>)['staff.w.memory']).toBe('Usa memória');
    expect((staffMessages['pt-BR'] as Record<string, string>)['staff.w.limit']).toBe('Gasta limite');
  });

  it('marcação: selo de memória sólido, de limite tracejado, dica no <details>; sem aviso, nada na tela', () => {
    const html = renderToStaticMarkup(createElement(WeightFlags, { ctx: base({ gpt: true }), ids: ['gpt'] }));
    expect(html).toContain('<details');
    expect(html).toContain('weight-badge is-memory');
    expect(html).toContain('weight-badge is-limit');
    expect(html).toContain('role="note"');
    expect(renderToStaticMarkup(createElement(WeightFlags, { ctx: base(), ids: ['gpt', 'browser', 'model'] }))).toBe('');
  });
});
