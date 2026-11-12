import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ShowcaseStatus } from '../client/src/api';
import { ShowcaseView } from '../client/src/detail/ShowcaseBlock';
import { shouldPollShowcase, showcaseCost, showcaseDoneKey, SHOWCASE_POLL_MS } from '../client/src/detail/showcaseStatus';

const render = (props: Partial<Parameters<typeof ShowcaseView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(ShowcaseView, {
      url: '/api/projects/p1/showcase',
      exists: false,
      status: null,
      busy: false,
      note: null,
      error: null,
      onStart: () => {},
      ...props,
    }),
  );

describe('vitrine: acompanhamento do estado', () => {
  it('pergunta a cada ~3 s, só gerando e com a aba à vista', () => {
    expect(SHOWCASE_POLL_MS).toBe(3000);
    expect(shouldPollShowcase('running', false)).toBe(true);
    expect(shouldPollShowcase('running', true)).toBe(false);
    for (const state of ['idle', 'done', 'failed', undefined] as const) expect(shouldPollShowcase(state, false)).toBe(false);
  });

  it('custo só se o servidor informou; nunca estimado', () => {
    expect(showcaseCost({ costUsd: 0.42 })).toBe('US$ 0,42');
    expect(showcaseCost({ costUsd: 0 })).toBe('US$ 0,00');
    expect(showcaseCost({})).toBeNull();
    expect(showcaseCost(null)).toBeNull();
    expect(showcaseCost({ costUsd: Number.NaN })).toBeNull();
    expect(showcaseCost({ costUsd: -1 })).toBeNull();
  });

  it('a conclusão se identifica pelo fim da geração (reler o guia uma vez por conclusão)', () => {
    expect(showcaseDoneKey({ state: 'done', finishedAt: '2026-11-12T10:00:00.000Z' })).toBe('2026-11-12T10:00:00.000Z');
    expect(showcaseDoneKey({ state: 'done' })).toBe('done');
    expect(showcaseDoneKey({ state: 'running' })).toBeNull();
    expect(showcaseDoneKey(null)).toBeNull();
  });
});

describe('vitrine: tela', () => {
  it('parado, sem vitrine: só "Criar vitrine" (sem seletor de funcionário) e a dica', () => {
    const html = render({ status: { state: 'idle' } });
    expect(html).toContain('Criar vitrine');
    expect(html).toContain('btn-primary');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Quem faz');
    expect(html).not.toContain('Abrir vitrine');
    expect(html).toContain('Gerada por um assistente que só lê o código; o servidor confere e grava o VITRINE.html. Leva alguns minutos.');
    expect(html).not.toMatch(/ disabled/);
  });

  it('com vitrine: "Atualizar vitrine" e o link que abre em outra aba', () => {
    const html = render({ exists: true });
    expect(html).toContain('Atualizar vitrine');
    expect(html).toContain('btn-secondary');
    expect(html).toContain('href="/api/projects/p1/showcase"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('gerando: botão desabilitado em "Gerando…"', () => {
    const html = render({ exists: true, status: { state: 'running' }, busy: true });
    expect(html).toMatch(/<button[^>]* disabled/);
    expect(html).toContain('Gerando…');
    expect(html).not.toContain('Atualizar vitrine');
  });

  it('pronta: "Vitrine pronta" com o custo, ou sem ele se o servidor não informou', () => {
    const done: ShowcaseStatus = { state: 'done', finishedAt: '2026-11-12T10:00:00.000Z', costUsd: 0.42 };
    expect(render({ exists: true, status: done })).toContain('Vitrine pronta · US$ 0,42');
    const semCusto = render({ exists: true, status: { state: 'done' } });
    expect(semCusto).toContain('Vitrine pronta');
    expect(semCusto).not.toContain('US$');
  });

  it('falhou: mostra o erro como veio (escapado), com o botão liberado para tentar de novo', () => {
    const html = render({ status: { state: 'failed', error: 'o HTML foi recusado: <script> não vale' } });
    expect(html).toContain('o HTML foi recusado: &lt;script&gt; não vale');
    expect(html).toContain('class="error small"');
    expect(html).not.toMatch(/<button[^>]* disabled/);
    expect(html).toContain('Criar vitrine');
  });

  it('falhou sem texto do servidor: mensagem genérica, nada inventado sobre a causa', () => {
    expect(render({ status: { state: 'failed' } })).toContain('A geração da vitrine falhou.');
  });

  it('409/429/503 (e o skipped): o texto do servidor aparece como veio', () => {
    expect(render({ error: 'A vitrine deste projeto já está sendo gerada.' })).toContain('A vitrine deste projeto já está sendo gerada.');
    expect(render({ error: 'limite de uso atingido' })).toContain('class="error small"');
    const skipped = render({ note: 'sem mudanças desde 10/11/2026' });
    expect(skipped).toContain('sem mudanças desde 10/11/2026');
    expect(skipped).toContain('role="status"');
    expect(skipped).not.toContain('class="error small"');
  });
});
