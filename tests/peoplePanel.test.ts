import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PeoplePanel, type PeopleView } from '../client/src/detail/PeoplePanel';
import type { RankingTab } from '../client/src/detail/Detail';
import { t } from '../client/src/i18n';

const render = (view: PeopleView) => {
  const asked: RankingTab[] = [];
  const html = renderToStaticMarkup(
    createElement(PeoplePanel, {
      view,
      onView: () => undefined,
      hr: createElement('p', null, 'LISTA-RH'),
      ranking: (tab: RankingTab) => (asked.push(tab), createElement('p', null, `LISTA-RANKING-${tab}`)),
    }),
  );
  return { html, asked };
};

describe('RH e ranking num painel só', () => {
  it('uma faixa de abas: RH, Gastos, Economia e Tarefas', () => {
    const { html } = render('hr');
    for (const label of [t('hr.button'), t('detail.tabCost'), t('detail.tabSavings'), t('detail.tabTasks')]) expect(html).toContain(`>${label}</button>`);
    expect((html.match(/role="tab"/g) ?? []).length).toBe(4);
    expect(html).toContain(t('hr.people'));
  });

  it('no RH só a aba RH fica ativa e o ranking nem é montado', () => {
    const { html, asked } = render('hr');
    expect(html).toContain('LISTA-RH');
    expect(html).not.toContain('LISTA-RANKING');
    expect(asked).toEqual([]);
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toMatch(new RegExp(`aria-selected="true" class="tab is-active">${t('hr.button')}<`));
  });

  it('no ranking abre em Gastos e não monta o RH', () => {
    const { html, asked } = render('ranking');
    expect(html).toContain('LISTA-RANKING-cost');
    expect(html).not.toContain('LISTA-RH');
    expect(asked).toEqual(['cost']);
    expect(html).toMatch(new RegExp(`aria-selected="true" class="tab is-active">${t('detail.tabCost')}<`));
  });
});
