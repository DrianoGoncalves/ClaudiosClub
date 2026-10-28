import { useRef, useState, type CSSProperties } from 'react';
import type { AppConfig, InboxItem } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { inTab, TAB_ALL, TAB_NONE } from './workspaces';

interface Props {
  config: AppConfig | null;
  /** Workspace de cada projeto (ver workspaceByProject). */
  workspaceOf: Map<string, string | null>;
  inbox: InboxItem[];
  value: string;
  onChange: (tab: string) => void;
  onConfig: (config: AppConfig) => void;
  onNewProject: () => void;
}

/** Abas logo abaixo do topo: filtram as salas do quadro, sem sair da página. */
export function WorkspaceTabs({ config, workspaceOf, inbox, value, onChange, onConfig, onNewProject }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const workspaces = config?.workspaces ?? [];
  const hasLoose = [...workspaceOf.values()].some((w) => !w);
  // Workspace sem projeto fica fora do topo; o aberto agora continua, para receber o primeiro projeto.
  const used = new Set(workspaceOf.values());
  const shown = workspaces.filter((w) => used.has(w.id) || w.id === value);
  const tabs = [
    { id: TAB_ALL, label: t('office.tabAll'), color: null },
    ...shown.map((w) => ({ id: w.id, label: w.name, color: w.color })),
    ...(shown.length && hasLoose ? [{ id: TAB_NONE, label: t('office.tabNone'), color: null }] : []),
  ];
  const pending = (tab: string) => inbox.filter((i) => inTab(tab, workspaceOf.get(i.projectId), config)).length;

  // Enter e o blur que vem depois chamariam duas vezes.
  const busy = useRef(false);
  const create = async () => {
    if (busy.current) return;
    if (!name.trim()) return setAdding(false);
    busy.current = true;
    setError(null);
    try {
      const next = await api.saveWorkspace({ name: name.trim(), color: null });
      onConfig(next);
      const created = next.workspaces.find((w) => w.name.toLowerCase() === name.trim().toLowerCase());
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
    <div className="workspace-tabs" role="tablist" aria-label={t('office.tabsLabel')}>
      {tabs.map((tab) => {
        const n = tab.id === TAB_ALL ? 0 : pending(tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            className={`workspace-tab ${value === tab.id ? 'is-active' : ''}`}
            style={tab.color ? ({ '--tab-color': `var(--pen-${tab.color})` } as CSSProperties) : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.color && <span className="workspace-dot" aria-hidden="true" />}
            {tab.label}
            {n > 0 && (
              <span className="workspace-pending" title={t('office.tabPending', { n })}>
                {n}
              </span>
            )}
          </button>
        );
      })}
      {adding ? (
        <span className="workspace-add">
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder={t('office.workspaceNamePlaceholder')}
            aria-label={t('office.workspaceNamePlaceholder')}
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
        <button type="button" className="workspace-tab workspace-tab-add" title={t('office.addWorkspaceTitle')} onClick={() => setAdding(true)}>
          {t('office.addWorkspace')}
        </button>
      )}
      <button type="button" className="workspace-tab workspace-tab-add" title={t('office.newProjectTitle')} onClick={onNewProject}>
        {t('office.newProject')}
      </button>
    </div>
  );
}
