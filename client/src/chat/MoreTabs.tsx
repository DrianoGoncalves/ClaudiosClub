import type { KeyboardEvent } from 'react';
import type { MoreTab } from './ChatView';

/**
 * As abas do funcionário (Ficha, Projeto, Desempenho, Ações): o "Mais" do chat e a edição do RH mostram as mesmas.
 * Setas, Home e End trocam de aba (e levam o foco); só a aba aberta entra na ordem do Tab.
 */
export function MoreTabs({ tabs, active, onActive, label }: { tabs: MoreTab[]; active: string; onActive: (id: string) => void; label: string }) {
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  if (!current) return null;
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.indexOf(current);
    const last = tabs.length - 1;
    const to = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[e.key];
    const next = to === undefined ? undefined : tabs[to];
    if (!next) return;
    e.preventDefault();
    onActive(next.id);
    e.currentTarget.querySelector<HTMLElement>(`#more-tab-${next.id}`)?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={move}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`more-tab-${tab.id}`}
            aria-selected={current.id === tab.id}
            aria-controls="chat-more-panel"
            tabIndex={current.id === tab.id ? 0 : -1}
            className={`tab ${current.id === tab.id ? 'is-active' : ''}`}
            onClick={() => onActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="chat-more-sec" role="tabpanel" id="chat-more-panel" aria-labelledby={`more-tab-${current.id}`}>
        {typeof current.content === 'function' ? current.content(onActive) : current.content}
      </div>
    </>
  );
}
