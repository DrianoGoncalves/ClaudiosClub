import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CostReport } from '../shared/model';
import { RankingPanel, SystemCostBlock } from '../client/src/detail/Detail';
import { formatUsd } from '../client/src/format';
import { t } from '../client/src/i18n';

const system: NonNullable<CostReport['system']> = { usd: 12.5, today: 0.4, last7d: 3, month: 7.25, runs: 3, projects: { p1: 12.5 } };

describe('Gastos: linha do Sistema', () => {
  const render = (s?: CostReport['system']) => renderToStaticMarkup(createElement(SystemCostBlock, { system: s }));

  it('mostra título, dica e os quatro períodos em dólar', () => {
    const html = render(system);
    expect(html).toContain(t('detail.systemHeading'));
    expect(html).toContain(t('detail.systemHint'));
    for (const usd of [0.4, 3, 7.25, 12.5]) expect(html).toContain(formatUsd(usd));
    expect(html).toContain(t('detail.runOther', { n: 3 }));
  });

  it('uma execução usa o singular', () => {
    expect(render({ ...system, runs: 1 })).toContain(t('detail.runOne', { n: 1 }));
  });

  it('sem `system` ou sem valor, não desenha nada', () => {
    expect(render(undefined)).toBe('');
    expect(render({ ...system, usd: 0, today: 0, last7d: 0, month: 0 })).toBe('');
  });

  it('não entra no ranking nem na participação dos agents', () => {
    const agents = [{ type: 'Explore', usd: 2, runs: 4 }];
    const withSystem = renderToStaticMarkup(createElement(RankingPanel, { groups: [], agents, system, scanning: false, onSelect: () => undefined, onOpenPerson: () => undefined }));
    const without = renderToStaticMarkup(createElement(RankingPanel, { groups: [], agents, scanning: false, onSelect: () => undefined, onOpenPerson: () => undefined }));
    expect(withSystem).toContain(t('detail.systemHeading'));
    expect(without).not.toContain(t('detail.systemHeading'));
    // O Explore segue com 100% dos agents (o Sistema não soma no total deles) e o Sistema não vira item de lista.
    expect(withSystem).toContain('100%');
    const items = (html: string) => (html.match(/<li/g) ?? []).length;
    expect(items(withSystem)).toBe(items(without));
  });
});
