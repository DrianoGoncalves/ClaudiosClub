import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Position } from '@xyflow/react';
import { EdgeActions, edgeTypes } from '../client/src/board/edges';

// "Animações" desligado corta o que pesa na placa de vídeo: bolinhas das linhas nem entram no DOM,
// o brilho do ocupado deixa de ser `filter` animado e a barra de ferramentas perde o `backdrop-filter`.

const edge = (animations: boolean | undefined, active: boolean) => {
  const Rough = edgeTypes.rough as unknown as (props: object) => JSX.Element;
  const props = {
    id: 'e1', sourceX: 0, sourceY: 0, targetX: 120, targetY: 90,
    sourcePosition: Position.Bottom, targetPosition: Position.Top,
    data: { kind: 'contains', active },
  };
  const el = createElement(Rough, props);
  // Sem provedor = padrão do contexto (animações ligadas).
  const tree = animations === undefined ? el : createElement(EdgeActions.Provider, { value: { animations } }, el);
  return renderToStaticMarkup(createElement('svg', null, tree));
};

describe('bolinhas das linhas', () => {
  it('ligadas: linha ativa monta as bolinhas com animateMotion', () => {
    const html = edge(true, true);
    expect(html).toContain('edge-dots');
    expect(html).toContain('animateMotion');
  });

  it('sem provedor, o padrão é ligado', () => {
    expect(edge(undefined, true)).toContain('animateMotion');
  });

  it('desligadas: linha ativa não monta o grupo nem o animateMotion', () => {
    const html = edge(false, true);
    expect(html).not.toContain('edge-dots');
    expect(html).not.toContain('animateMotion');
    expect(html).toContain('rough-edge'); // a linha em si segue desenhada
  });

  it('linha parada nunca tem bolinhas', () => {
    expect(edge(true, false)).not.toContain('animateMotion');
  });
});

describe('CSS com .anim-off', () => {
  const css = readFileSync('client/src/styles.css', 'utf8');
  const rule = (selector: string) => {
    // Começo de linha: `.toolbar::before` não pode casar dentro de `.anim-off .toolbar::before`.
    const at = css.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
  };

  it('o brilho animado (filter) só existe com animações ligadas: ocupado para a animação e ganha halo fixo sem filter', () => {
    expect(css).toMatch(/\.bn-employee\.is-busy \{ animation: bn-glow/);
    expect(rule('.anim-off .bn-employee.is-busy')).toContain('animation: none');
    const halo = rule('.anim-off .bn-employee.is-busy::before');
    expect(halo).toContain('box-shadow');
    expect(halo).toContain('var(--busy)');
    expect(halo).not.toContain('filter');
  });

  it('a barra de ferramentas perde o backdrop-filter e fica com fundo quase opaco', () => {
    const off = rule('.anim-off .toolbar::before');
    expect(off).toContain('backdrop-filter: none');
    expect(off).toContain('var(--panel)');
    // Ligada: o vidro de hoje segue igual.
    expect(rule('.toolbar::before')).toContain('backdrop-filter: var(--glass-blur)');
  });

  it('o display:none das bolinhas saiu (agora elas nem montam)', () => {
    expect(css).not.toMatch(/\.anim-off \.edge-dots/);
  });
});
