import { useState } from 'react';
import type { AppConfig, ProjectColor, Workspace } from '../../../shared/model';
import { api } from '../api';
import { BackgroundPicker, RoomColorPicker, useSystemTheme } from '../board/colors';
import { t } from '../i18n';

/** Configurações → Workspaces: nome, cor e fundo de cada aba; remover deixa os projetos dele sem workspace. */
export function WorkspacesEditor({
  workspaces,
  projectWorkspaces,
  onConfig,
}: {
  workspaces: Workspace[];
  projectWorkspaces: Record<string, string>;
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
          <li key={w.id}>
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
            <RoomColorPicker
              small
              label={t('office.workspaceColor')}
              value={w.color}
              onChange={(color: ProjectColor | null) => run(() => api.saveWorkspace({ id: w.id, name: w.name, color }))}
            />
            <button
              type="button"
              className="link small"
              onClick={() => window.confirm(t('office.workspaceRemoveConfirm', { name: w.name })) && void run(() => api.removeWorkspace(w.id))}
            >
              {t('office.workspaceRemove')}
            </button>
            {/* Fundo do quadro na aba dele, no tema do sistema agora (o outro tema se escolhe ao trocar). */}
            <span className="workspace-bg">
              <span className="muted small">{t(theme === 'light' ? 'office.workspaceBgLight' : 'office.workspaceBgDark')}</span>
              <BackgroundPicker
                theme={theme}
                value={w.background[theme]}
                onChange={(hex) => run(() => api.saveWorkspace({ id: w.id, name: w.name, background: { [theme]: hex } }))}
              />
            </span>
          </li>
        ))}
      </ul>
      <form
        className="workspace-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void run(() => api.saveWorkspace({ name: name.trim(), color: null })).then(() => setName(''));
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
