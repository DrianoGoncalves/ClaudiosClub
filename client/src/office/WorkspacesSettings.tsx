import { useState } from 'react';
import type { AppConfig, BoardBackground, Workspace } from '../../../shared/model';
import { api } from '../api';
import { useSystemTheme } from '../board/colors';
import { t } from '../i18n';
import { ThemeBackgrounds } from '../toolbar/ThemeBackgrounds';

/** Configurações → Workspaces: nome e fundo (claro e escuro) de cada aba; remover deixa os projetos dele sem workspace. */
export function WorkspacesEditor({
  workspaces,
  projectWorkspaces,
  background,
  onConfig,
}: {
  workspaces: Workspace[];
  projectWorkspaces: Record<string, string>;
  /** Fundo geral do quadro: o que vale numa aba sem fundo próprio. */
  background: BoardBackground | null;
  onConfig: (config: AppConfig) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const theme = useSystemTheme();
  const run = async (fn: () => Promise<AppConfig>) => {
    setError(null);
    try {
      onConfig(await fn());
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const count = (id: string) => Object.values(projectWorkspaces).filter((w) => w === id).length;

  return (
    <div className="workspaces-editor">
      {!workspaces.length && <p className="muted small">{t('office.workspaceNone')}</p>}
      <ul className="room-colors">
        {workspaces.map((w) => (
          <li key={w.id} className="workspace-card">
            {/* O nome é o título do cartão e se edita ali mesmo. */}
            <div className="workspace-head">
              <input
                className="workspace-rename"
                defaultValue={w.name}
                maxLength={40}
                aria-label={w.name}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== w.name) void run(() => api.saveWorkspace({ id: w.id, name: next }));
                }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
              <span className="muted small">{t('office.workspaceProjects', { n: count(w.id) })}</span>
              <button
                type="button"
                className="link small"
                onClick={() => window.confirm(t('office.workspaceRemoveConfirm', { name: w.name })) && void run(() => api.removeWorkspace(w.id))}
              >
                {t('office.workspaceRemove')}
              </button>
            </div>
            <div className="workspace-field">
              <span className="muted small">{t('office.workspaceBg')}</span>
              <ThemeBackgrounds
                value={w.background}
                fallback={background ?? { light: null, dark: null }}
                current={theme}
                onChange={(th, hex) => run(() => api.saveWorkspace({ id: w.id, name: w.name, background: { [th]: hex } }))}
              />
            </div>
          </li>
        ))}
      </ul>
      <form
        className="workspace-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => api.saveWorkspace({ name: name.trim() })).then(() => setName(''));
        }}
      >
        <input value={name} maxLength={40} placeholder={t('office.workspaceNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn-secondary" disabled={!name.trim()}>
          {t('office.workspaceAdd')}
        </button>
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

/** Configurações → Projeto demo: cria (uma vez) e abre a sala dele. */
export function DemoButton({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.createDemo();
            onOpen(r.projectId);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t('office.demoWorking') : t('office.demoCreate')}
      </button>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
