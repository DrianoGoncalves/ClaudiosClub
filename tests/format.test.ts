import { describe, expect, it } from 'vitest';
import { bareVersion, updateVersions } from '../client/src/format';
import toolbar from '../client/src/i18n/toolbar';
import type { Locale } from '../client/src/i18n';

describe('bareVersion', () => {
  it('tira o v da tag', () => {
    expect(bareVersion('v0.2.8')).toBe('0.2.8');
    expect(bareVersion('V1.0.0')).toBe('1.0.0');
  });
  it('deixa em paz o que já vem sem v', () => {
    expect(bareVersion('0.2.8')).toBe('0.2.8');
    expect(bareVersion('?')).toBe('?');
  });
});

describe('textos de atualização', () => {
  const vars: Record<string, string> = updateVersions({ latest: 'v0.2.9', current: 'v0.2.8' });
  // t() só lê o idioma atual (trocar recarrega a página); aqui o texto de cada idioma é lido direto do dicionário.
  const text = (loc: Locale, key: 'toolbar.updateAvailable' | 'toolbar.updateNoRelease') =>
    toolbar[loc][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
  const cases: [Locale, string, string][] = [
    ['pt-BR', 'Versão 0.2.9 disponível (você está na 0.2.8)', 'Versão 0.2.8; nenhuma versão publicada no GitHub ainda'],
    ['en', 'Version 0.2.9 available (you have 0.2.8)', 'Version 0.2.8; no version published on GitHub yet'],
    ['es', 'Versión 0.2.9 disponible (tienes la 0.2.8)', 'Versión 0.2.8; todavía no hay versiones publicadas en GitHub'],
  ];
  it.each(cases)('%s sem o v repetido', (loc, available, noRelease) => {
    expect(text(loc, 'toolbar.updateAvailable')).toBe(available);
    expect(text(loc, 'toolbar.updateNoRelease')).toBe(noRelease);
  });
  it('sem versão conhecida mostra ?', () => {
    expect(updateVersions({ latest: null, current: null })).toEqual({ latest: '', current: '?' });
  });
});
