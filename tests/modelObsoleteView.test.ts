import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelObsoleteNote, modelObsoleteText, obsoleteFor } from '../client/src/staff/ModelObsoleteNote';

const marca = { model: 'opus', engine: 'claude' as const, at: '2026-11-16T10:00:00.000Z' };

describe('modelo obsoleto: aviso na tela', () => {
  it('o texto diz o modelo, o motor, que segue no padrão e que é para trocar na ficha', () => {
    const text = modelObsoleteText(marca);
    expect(text).toContain('"opus"');
    expect(text).toContain('Claude');
    expect(text).toContain('modelo padrão');
    expect(text).toContain('Troque o modelo na ficha');
    expect(modelObsoleteText({ model: 'gpt-x', engine: 'codex', at: marca.at })).toContain('Codex');
  });

  it('o painel e a ficha mostram o selo e a mensagem com o nome do modelo (nota, não alerta que interrompe)', () => {
    const html = renderToStaticMarkup(createElement(ModelObsoleteNote, { obsolete: marca }));
    expect(html).toContain('role="note"');
    expect(html).toContain('Modelo obsoleto.');
    expect(html).toContain('&quot;opus&quot;');
  });

  it('na ficha o aviso vale só enquanto o formulário mantém o modelo e o motor recusados', () => {
    const staff = { modelObsolete: marca };
    expect(obsoleteFor(staff, 'opus', 'claude')).toEqual(marca);
    expect(obsoleteFor(staff, 'sonnet', 'claude')).toBeNull();
    expect(obsoleteFor(staff, 'opus', 'codex')).toBeNull();
    expect(obsoleteFor(staff, null, 'claude')).toBeNull();
  });

  it('sem a marca na ficha, nada aparece', () => {
    expect(obsoleteFor({}, 'opus', 'claude')).toBeNull();
    expect(obsoleteFor(null, 'opus', 'claude')).toBeNull();
    expect(obsoleteFor(undefined, 'opus', 'claude')).toBeNull();
  });
});
