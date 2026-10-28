import { useEffect, useState } from 'react';
import type { Workspace } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// Novo projeto: cria uma pasta (com git, se quiser) ou abre uma que já existe, já no workspace da aba.

interface Props {
  workspaces: Workspace[];
  /** O workspace da aba de onde veio (null = sem workspace). */
  workspaceId: string | null;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

export function NewProjectForm({ workspaces, workspaceId, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'create' | 'existing'>('create');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [git, setGit] = useState(true);
  const [workspace, setWorkspace] = useState(workspaceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Onde está a maioria dos projetos: é lá que um novo costuma ir.
  useEffect(() => {
    api.newProjectDefaults().then((d) => setParent((p) => p || d.parent), () => {});
  }, []);

  const sep = parent.includes('/') && !parent.includes('\\') ? '/' : '\\';
  const target = parent && name.trim() ? `${parent.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const workspaceIdOrNull = workspace || null;
    try {
      const r = await api.newProject(
        mode === 'create'
          ? { mode, parent: parent.trim(), name: name.trim(), git, workspaceId: workspaceIdOrNull }
          : { mode, path: folder.trim(), workspaceId: workspaceIdOrNull },
      );
      onCreated(r.projectId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal hire" onSubmit={submit}>
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('office.cancel')}>
          ×
        </button>
        <p className="kicker">{t('office.npKicker')}</p>
        <h2>{t('office.npTitle')}</h2>

        <div className="templates" role="radiogroup">
          <button type="button" role="radio" aria-checked={mode === 'create'} className={mode === 'create' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('create')}>
            {t('office.npCreate')}
          </button>
          <button type="button" role="radio" aria-checked={mode === 'existing'} className={mode === 'existing' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMode('existing')}>
            {t('office.npExisting')}
          </button>
        </div>

        {mode === 'create' ? (
          <>
            <label>
              {t('office.npName')}
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
            </label>
            <label>
              {t('office.npParent')}
              <input value={parent} onChange={(e) => setParent(e.target.value)} maxLength={400} required className="mono" />
            </label>
            {target && <p className="muted small">{t('office.npWillCreate', { path: target })}</p>}
            <label className="check">
              <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} /> {t('office.npGit')}
            </label>
          </>
        ) : (
          <label>
            {t('office.npPath')}
            <input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={400} required autoFocus className="mono" placeholder={t('office.npPathPlaceholder')} />
          </label>
        )}

        {workspaces.length > 0 && (
          <label>
            {t('office.npWorkspace')}
            <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              <option value="">{t('office.noWorkspace')}</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? t('office.npWorking') : mode === 'create' ? t('office.npSubmitCreate') : t('office.npSubmitOpen')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('office.cancel')}
          </button>
        </div>
        <p className="muted small">{t('office.npNote')}</p>
      </form>
    </div>
  );
}
