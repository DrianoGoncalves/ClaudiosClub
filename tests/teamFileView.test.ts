import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ImportResult, MAX_TEAM_FILE_BYTES, teamFileName } from '../client/src/staff/TeamFile';

describe('teamFileName', () => {
  const day = new Date('2026-11-13T15:00:00.000Z');
  it('nome do projeto sem acento nem caractere de caminho, com a data', () => {
    expect(teamFileName('Clínica São João / Loja', day)).toBe('equipe-clinica-sao-joao-loja-2026-11-13.json');
  });
  it('nome vazio ou só símbolos cai em "projeto"; nome longo é cortado', () => {
    expect(teamFileName('***', day)).toBe('equipe-projeto-2026-11-13.json');
    expect(teamFileName('a'.repeat(100), day)).toBe(`equipe-${'a'.repeat(40)}-2026-11-13.json`);
  });
});

describe('ImportResult', () => {
  it('uma ficha, no singular, sem caixa de avisos quando não há avisos', () => {
    const html = renderToStaticMarkup(createElement(ImportResult, { created: 1, warnings: [] }));
    expect(html).toContain('1 ficha criada.');
    expect(html).not.toContain('person-note');
  });
  it('lista cada aviso do servidor, com a contagem', () => {
    const warnings = ['Ana: autonomia auto no arquivo; entrou como manual', 'Ana: MCP gh não existe neste projeto; ficou de fora', 'skill revisao já existe na biblioteca: a sua foi mantida'];
    const html = renderToStaticMarkup(createElement(ImportResult, { created: 2, warnings }));
    expect(html).toContain('2 fichas criadas.');
    expect(html).toContain('Avisos (3)');
    for (const w of warnings) expect(html).toContain(w);
    expect(html.match(/<li>/g)).toHaveLength(3);
  });
  it('aviso com marcação não vira HTML', () => {
    const html = renderToStaticMarkup(createElement(ImportResult, { created: 1, warnings: ['<img src=x onerror=alert(1)>'] }));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('MAX_TEAM_FILE_BYTES', () => {
  it('é o teto do servidor (3 MB)', () => {
    expect(MAX_TEAM_FILE_BYTES).toBe(3 * 1024 * 1024);
  });
});
