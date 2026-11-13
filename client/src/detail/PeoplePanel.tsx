import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import type { RankingTab } from './Detail';

/** O que o painel mostra: o RH ou uma das telas do ranking. */
export type PeopleView = 'hr' | 'ranking';

/**
 * RH e ranking num painel só (um botão no topo em vez de dois): cabeçalho, abas RH | Gastos | Economia e, embaixo, a
 * tela da aba. `view` vem da seleção do quadro (o RH ou o ranking); a aba do ranking é daqui.
 */
export function PeoplePanel({
  view,
  onView,
  hr,
  ranking,
}: {
  view: PeopleView;
  onView: (view: PeopleView) => void;
  hr: ReactNode;
  /** Só é chamada com o ranking aberto (a lista de custo é cara de montar). */
  ranking: (tab: RankingTab) => ReactNode;
}) {
  const [rankingTab, setRankingTab] = useState<RankingTab>('cost');
  const tabs: Array<[string, string, boolean, () => void]> = [
    ['hr', t('hr.button'), view === 'hr', () => onView('hr')],
    ['cost', t('detail.tabCost'), view === 'ranking' && rankingTab === 'cost', () => (setRankingTab('cost'), onView('ranking'))],
    ['savings', t('detail.tabSavings'), view === 'ranking' && rankingTab === 'savings', () => (setRankingTab('savings'), onView('ranking'))],
  ];
  return (
    <>
      <header className="header">
        <p className="kicker">{t('hr.people')}</p>
        <h2>{t('hr.title')}</h2>
      </header>
      <div className="tabs" role="tablist" aria-label={t('hr.people')}>
        {tabs.map(([key, label, active, select]) => (
          <button key={key} type="button" role="tab" aria-selected={active} className={`tab ${active ? 'is-active' : ''}`} onClick={select}>
            {label}
          </button>
        ))}
      </div>
      {view === 'hr' ? hr : ranking(rankingTab)}
    </>
  );
}
