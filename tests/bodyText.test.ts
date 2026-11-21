import { describe, expect, it } from 'vitest';
import { bodyText } from '../server/bodyText';

const TEXT = '{"text":"A prova não mostra a composição: versões, licença ‘aspas’ – ok"}';

describe('bodyText', () => {
  it('UTF-8 válido segue igual', () => {
    expect(bodyText(Buffer.from(TEXT, 'utf8'))).toBe(TEXT);
  });

  it('corpo em Windows-1252 (PowerShell 5.1) não vira U+FFFD', () => {
    const cp1252 = Buffer.from(TEXT.replace(/[‘’–]/g, (c) => ({ '‘': '\x91', '’': '\x92', '–': '\x96' })[c]!), 'latin1');
    const out = bodyText(cp1252);
    expect(out).toBe(TEXT);
    expect(out).not.toContain('�');
  });

  it('BOM do começo sai, para o JSON.parse aceitar', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')]);
    expect(JSON.parse(bodyText(withBom))).toEqual(JSON.parse(TEXT));
  });

  it('corpo vazio continua vazio', () => {
    expect(bodyText(Buffer.alloc(0))).toBe('');
  });
});
