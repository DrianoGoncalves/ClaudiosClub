import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import settingsSimple from '../client/src/i18n/settingsSimple';
import { groupSimple, SIMPLE_GROUPS, SIMPLE_ORDER, SimpleList, simpleInfo, type SimpleItem } from '../client/src/toolbar/SettingsSimple';

const item = (id: string, key: Parameters<typeof simpleInfo>[1], group: Parameters<typeof simpleInfo>[0], extra: Partial<SimpleItem> = {}, wide = false): SimpleItem => ({
  id,
  simple: simpleInfo(group, key, wide),
  ...extra,
});

const render = (items: SimpleItem[], hidden = 0, empty?: string) =>
  renderToStaticMarkup(createElement(SimpleList, { items, hidden, empty: empty ? createElement('p', { className: 'empty' }, empty) : null, onAdvanced: () => {} }));

describe('configurações no nível Simples: textos', () => {
  const langs = Object.keys(settingsSimple) as Array<keyof typeof settingsSimple>;
  const ptKeys = Object.keys(settingsSimple['pt-BR']);

  it('pt, en e es têm as mesmas chaves, todas com texto', () => {
    for (const lang of langs) {
      expect(Object.keys(settingsSimple[lang]).sort()).toEqual([...ptKeys].sort());
      for (const [key, text] of Object.entries(settingsSimple[lang])) expect(text.trim(), `${lang} ${key}`).not.toBe('');
    }
  });

  it('os mesmos {marcadores} em todo idioma', () => {
    const holes = (s: string | undefined) => (s?.match(/\{\w+\}/g) ?? []).sort().join();
    const text = (lang: keyof typeof settingsSimple, key: string) => (settingsSimple[lang] as Record<string, string>)[key];
    for (const key of ptKeys) for (const lang of langs) expect(holes(text(lang, key)), `${lang} ${key}`).toBe(holes(text('pt-BR', key)));
  });

  it('em português não vaza jargão que um não técnico não entende', () => {
    const jargon = /\b(mcp|token|worktree|cli|ram|cpu|agents?|skills?|hooks?|opus|sonnet|haiku|codex|gpt|esfor[cç]o|prompt|diff|deploy|api|sandbox|~\/\.claude)\b/i;
    for (const [key, text] of Object.entries(settingsSimple['pt-BR'])) expect(text, key).not.toMatch(jargon);
  });

  it('cada item da ordem tem título e frase de efeito prontos', () => {
    for (const key of SIMPLE_ORDER) {
      const info = simpleInfo('help', key);
      expect(info.title.length, key).toBeGreaterThan(2);
      expect(info.effect.length, key).toBeGreaterThan(10);
      // a vista mostra o texto do efeito, nunca a chave crua
      expect(info.title).not.toMatch(/^ss\./);
      expect(info.effect).not.toMatch(/^ss\./);
    }
  });
});

describe('configurações no nível Simples: agrupamento', () => {
  it('um cartão por tema, na ordem dos temas, e o item dentro dele na ordem de SIMPLE_ORDER', () => {
    const items = [item('language', 'language', 'look'), item('theme', 'theme', 'look'), item('manual', 'manual', 'help'), item('ui-level', 'uiLevel', 'level')];
    const grouped = groupSimple(items);
    expect(grouped.map((g) => g.group.id)).toEqual(['level', 'look', 'help']);
    expect(grouped[1]?.items.map((s) => s.id)).toEqual(['theme', 'language']);
  });

  it('tema sem item nem aparece', () => {
    expect(groupSimple([item('manual', 'manual', 'help')]).map((g) => g.group.id)).toEqual(['help']);
    expect(groupSimple([])).toEqual([]);
  });

  it('todo tema tem ícone e nome', () => {
    for (const g of SIMPLE_GROUPS) {
      expect(g.label.trim(), g.id).not.toBe('');
      expect(g.icon, g.id).toBeTruthy();
    }
  });
});

describe('configurações no nível Simples: a tela', () => {
  it('liga/desliga é botão do DS com aria-pressed e o estado escrito', () => {
    const on = render([item('animations', 'animations', 'look', { toggle: { checked: true, onChange: () => {} } })]);
    expect(on).toContain('class="btn-secondary btn-toggle ss-toggle"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain('>Ligado<');
    const off = render([item('animations', 'animations', 'look', { toggle: { checked: false, onChange: () => {}, disabled: true } })]);
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('>Desligado<');
    expect(off).toContain('disabled');
  });

  it('o botão se chama pelo título do item (aria-labelledby aponta para ele)', () => {
    const html = render([item('archived', 'archived', 'board', { toggle: { checked: false, onChange: () => {} } })]);
    expect(html).toContain('id="ss-title-archived"');
    expect(html).toContain('aria-labelledby="ss-title-archived"');
  });

  it('mostra título, frase e o controle do item; mantém o id #setting-… de antes', () => {
    const html = render([item('theme', 'theme', 'look', { control: createElement('span', { className: 'ctl' }, 'X') })]);
    expect(html).toContain('id="setting-theme"');
    expect(html).toContain('Tema');
    expect(html).toContain('Claro, escuro ou igual ao do seu computador');
    expect(html).toContain('<span class="ctl">X</span>');
    expect(html).toContain('data-group="look"');
  });

  it('controle largo vai abaixo do texto', () => {
    expect(render([item('workspaces', 'workspaces', 'board', {}, true)])).toContain('class="ss-item is-wide"');
    expect(render([item('theme', 'theme', 'look')])).toContain('class="ss-item"');
  });

  it('convite para o Avançado só com itens escondidos, no singular e no plural', () => {
    const one = [item('theme', 'theme', 'look')];
    expect(render(one, 0)).not.toContain('Passar para o nível Avançado');
    expect(render(one, 1)).toContain('Há mais 1 configuração, para quem quer ajustar cada detalhe.');
    expect(render(one, 4)).toContain('Há mais 4 configurações');
    expect(render(one, 4)).toContain('Passar para o nível Avançado');
  });

  it('sem resultado, mostra o aviso passado (a busca) e nenhum cartão', () => {
    const html = render([], 3, 'Nada');
    expect(html).toContain('class="empty"');
    expect(html).not.toContain('ss-card');
  });
});
