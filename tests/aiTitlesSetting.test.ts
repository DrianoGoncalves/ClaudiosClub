import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import settingsSimple from '../client/src/i18n/settingsSimple';
import toolbar from '../client/src/i18n/toolbar';
import { SIMPLE_ORDER, SimpleList, simpleInfo } from '../client/src/toolbar/SettingsSimple';

// Opção "Títulos de conversa por IA" (config `aiTitles`): textos nos 3 idiomas e a vista Simples.
describe('opção Títulos de conversa por IA (tela)', () => {
  const langs = ['pt-BR', 'en', 'es'] as const;

  it('título, descrição e palavras de busca nos 3 idiomas', () => {
    for (const lang of langs) {
      for (const key of ['toolbar.aiTitlesTitle', 'toolbar.aiTitlesDesc', 'toolbar.aiTitlesKeywords'] as const) {
        expect((toolbar[lang] as Record<string, string>)[key]?.trim(), `${lang} ${key}`).toBeTruthy();
      }
    }
  });

  it('a explicação diz que gasta cota e o que a lista mostra desligado, em cada idioma', () => {
    const desc = (lang: (typeof langs)[number]) => (toolbar[lang] as Record<string, string>)['toolbar.aiTitlesDesc'] ?? '';
    expect(desc('pt-BR')).toMatch(/cota/);
    expect(desc('en')).toMatch(/quota/);
    expect(desc('es')).toMatch(/cuota/);
  });

  it('entra no cartão Conversas do Simples, depois de "começar conversa nova", com texto nos 3 idiomas', () => {
    expect(SIMPLE_ORDER.indexOf('aiTitles')).toBe(SIMPLE_ORDER.indexOf('contextSwitch') + 1);
    for (const lang of langs) {
      const s = settingsSimple[lang] as Record<string, string>;
      expect(s['ss.aiTitles.title']?.trim(), lang).toBeTruthy();
      expect(s['ss.aiTitles.effect']?.trim(), lang).toBeTruthy();
    }
  });

  it('o interruptor é o do DS e mostra Ligado/Desligado conforme o config', () => {
    const render = (checked: boolean) =>
      renderToStaticMarkup(
        createElement(SimpleList, {
          items: [{ id: 'ai-titles', simple: simpleInfo('chat', 'aiTitles'), toggle: { checked, onChange: () => {} } }],
          hidden: 0,
          onAdvanced: () => {},
        }),
      );
    const on = render(true);
    expect(on).toContain('id="setting-ai-titles"');
    expect(on).toContain('data-group="chat"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('>Ligado<');
    expect(render(false)).toContain('aria-pressed="false"');
    expect(render(false)).toContain('>Desligado<');
  });
});
