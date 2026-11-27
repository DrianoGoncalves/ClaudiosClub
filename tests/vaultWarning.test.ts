import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectOffice } from '../client/src/office/ProjectOffice';
import { VaultWarning } from '../client/src/office/VaultWarning';

describe('aviso de senha guardada sem cifra', () => {
  it('com vaultWarning: mostra o texto do servidor, a explicação e o botão, como alerta', () => {
    const html = renderToStaticMarkup(createElement(VaultWarning, { text: '[cofre] sem chaveiro: senha em arquivo', onDone: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('[cofre] sem chaveiro: senha em arquivo');
    expect(html).toContain('Salvo, mas sem cifra');
    expect(html).toContain('Entendi');
  });
  it('sem vaultWarning: a tela de conexões não mostra o aviso', () => {
    const html = renderToStaticMarkup(createElement(ProjectOffice, { projectId: 'p', config: null, onConfig: () => {} }));
    expect(html).not.toContain('vault-warn');
    expect(html).toContain('+ conexão');
  });
});
