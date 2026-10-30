import { describe, expect, it } from 'vitest';
import { buildStartPage } from '../server/startPage';

describe('página de início servida pela porta', () => {
  it('vai num arquivo só: CSS e ícones embutidos, nada relativo à pasta do projeto', async () => {
    const html = await buildStartPage();
    // Só o teste do build (que roda apenas como arquivo) ainda aponta para ../dist.
    expect(html).not.toMatch(/(href|src)="\.\.\//);
    expect(html).not.toContain('../client/');
    expect(html).toContain('<style>');
    expect(html).toMatch(/href="data:image\/png;base64,/);
    expect(html).toMatch(/src="data:image\/png;base64,/);
    // O checklist continua vindo à parte (/status.js), para o service worker guardar a versão mais nova.
    expect(html).toContain('status.js?t=');
    expect(html).toContain('Iniciar o Claudio’s Club');
  });
});
