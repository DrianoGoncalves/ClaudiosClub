import { useEffect, useRef, useState } from 'react';
import type { AppConfig, InboxItem } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { inTab, TAB_ALL, TAB_NONE } from './workspaces';

interface Props {
  config: AppConfig | null;
  /** Workspace de cada projeto (ver workspaceByProject). */
  workspaceOf: Map<string, string | null>;
  /** Workspaces com sala visível no quadro (null = projeto sem workspace). */
  inUse: Set<string | null>;
  inbox: InboxItem[];
  value: string;
  onChange: (tab: string) => void;
  onConfig: (config: AppConfig) => void;
}

/** Abas logo abaixo do topo: filtram as salas do quadro, sem sair da página. */
export function WorkspaceTabs({ config, workspaceOf, inUse, inbox, value, onChange, onConfig }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const workspaces = config?.workspaces ?? [];
  // Aba sem sala no quadro fica fora do topo; a aberta agora continua, para receber o primeiro projeto.
  const hasLoose = inUse.has(null);
  const shown = workspaces.filter((w) => inUse.has(w.id) || w.id === value);
  // "Sem workspace" que sumiu deixaria o quadro só com o escopo do usuário: volta para "Todos".
  // (inUse vazio = quadro ainda carregando; não mexe na aba guardada.)
  useEffect(() => {
    if (value === TAB_NONE && inUse.size && !hasLoose) onChange(TAB_ALL);
  }, [value, inUse, hasLoose, onChange]);
  const tabs = [
    { id: TAB_ALL, label: t('office.tabAll') },
    ...shown.map((w) => ({ id: w.id, label: w.name })),
    ...(shown.length && hasLoose ? [{ id: TAB_NONE, label: t('office.tabNone') }] : []),
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
      const next = await api.saveWorkspace({ name: name.trim() });
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
            onClick={() => onChange(tab.id)}
          >
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
        <button
          type="button"
          className="workspace-tab workspace-tab-add"
          title={t('office.addWorkspaceTitle')}
          aria-label={t('office.addWorkspaceTitle')}
          onClick={() => setAdding(true)}
        >
          +
        </button>
      )}
    </div>
  );
}
