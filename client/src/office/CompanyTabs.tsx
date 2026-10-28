import { useRef, useState, type CSSProperties } from 'react';
import type { AppConfig, InboxItem } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { inTab, TAB_ALL, TAB_NONE } from './companies';

interface Props {
  config: AppConfig | null;
  /** Empresa de cada projeto (ver companyByProject). */
  companyOf: Map<string, string | null>;
  inbox: InboxItem[];
  value: string;
  onChange: (tab: string) => void;
  onConfig: (config: AppConfig) => void;
  onNewProject: () => void;
}

/** Abas logo abaixo do topo: filtram as salas do quadro, sem sair da página. */
export function CompanyTabs({ config, companyOf, inbox, value, onChange, onConfig, onNewProject }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const companies = config?.companies ?? [];
  const hasLoose = [...companyOf.values()].some((c) => !c);
  const tabs = [
    { id: TAB_ALL, label: t('office.tabAll'), color: null },
    ...companies.map((c) => ({ id: c.id, label: c.name, color: c.color })),
    ...(companies.length && hasLoose ? [{ id: TAB_NONE, label: t('office.tabNone'), color: null }] : []),
  ];
  const pending = (tab: string) => inbox.filter((i) => inTab(tab, companyOf.get(i.projectId), config)).length;

  // Enter e o blur que vem depois chamariam duas vezes.
  const busy = useRef(false);
  const create = async () => {
    if (busy.current) return;
    if (!name.trim()) return setAdding(false);
    busy.current = true;
    setError(null);
    try {
      const next = await api.saveCompany({ name: name.trim(), color: null });
      onConfig(next);
      const created = next.companies.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
      if (created) onChange(created.id);
      setName('');
      setAdding(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="company-tabs" role="tablist" aria-label={t('office.tabsLabel')}>
      {tabs.map((tab) => {
        const n = tab.id === TAB_ALL ? 0 : pending(tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            className={`company-tab ${value === tab.id ? 'is-active' : ''}`}
            style={tab.color ? ({ '--tab-color': `var(--pen-${tab.color})` } as CSSProperties) : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.color && <span className="company-dot" aria-hidden="true" />}
            {tab.label}
            {n > 0 && (
              <span className="company-pending" title={t('office.tabPending', { n })}>
                {n}
              </span>
            )}
          </button>
        );
      })}
      {adding ? (
        <span className="company-add">
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder={t('office.companyNamePlaceholder')}
            aria-label={t('office.companyNamePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create();
              if (e.key === 'Escape') setAdding(false);
            }}
            onBlur={() => void create()}
          />
          {error && <span className="error small">{error}</span>}
        </span>
      ) : (
        <button type="button" className="company-tab company-tab-add" title={t('office.addCompanyTitle')} onClick={() => setAdding(true)}>
          {t('office.addCompany')}
        </button>
      )}
      <button type="button" className="company-tab company-tab-add" title={t('office.newProjectTitle')} onClick={onNewProject}>
        {t('office.newProject')}
      </button>
    </div>
  );
}
