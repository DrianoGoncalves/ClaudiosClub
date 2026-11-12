import { useEffect, useState } from 'react';
import type { Workspace } from '../../../shared/model';
import { api, type ImportableProject } from '../api';
import { t } from '../i18n';

// Novo projeto: cria uma pasta (com git, se quiser), abre uma que já existe ou importa projetos do
// Claude Code ou do Codex que ainda estão fora do quadro, já no workspace da aba.

/** Nome de cada fonte de importação (os mesmos do cabeçalho). */
const SOURCE_NAME = { claude: 'toolbar.claudeName', codex: 'toolbar.codexName' } as const;

interface Props {
  workspaces: Workspace[];
  /** O workspace da aba de onde veio (null = sem workspace). */
  workspaceId: string | null;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

export function NewProjectForm({ workspaces, workspaceId, onClose, onCreated }: Props) {
  const [mode, setMode] = useState<'create' | 'existing' | 'import'>('create');
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [git, setGit] = useState(true);
  const [workspace, setWorkspace] = useState(workspaceId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Importar: os projetos do Claude Code fora do quadro (null = ainda carregando) e os marcados (pelo caminho).
  const [found, setFound] = useState<ImportableProject[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Onde está a maioria dos projetos: é lá que um novo costuma ir.
  useEffect(() => {
    api.newProjectDefaults().then((d) => setParent((p) => p || d.parent), () => {});
  }, []);

  const pickMode = (m: typeof mode) => {
    setMode(m);
    setError(null);
  };

  // A lista é buscada quando a aba de importar abre, e de novo se `found` voltar a null ("Tentar de novo",
  // ou um envio que falhou: outra aba pode ter importado). Os marcados que sumiram da lista saem.
  useEffect(() => {
    if (mode !== 'import' || found !== null || loadError !== null) return;
    let alive = true;
    api.importableProjects().then(
      (list) => {
        if (!alive) return;
        setFound(list);
        setPicked((prev) => new Set(list.filter((p) => prev.has(p.path)).map((p) => p.path)));
      },
      (err: Error) => alive && setLoadError(err.message),
    );
    return () => {
      alive = false;
    };
  }, [mode, found, loadError]);

  const allPicked = !!found?.length && found.every((p) => picked.has(p.path));
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set(found?.map((p) => p.path)));
  const toggle = (projectPath: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(projectPath)) next.add(projectPath);
      return next;
    });

  const sep = parent.includes('/') && !parent.includes('\\') ? '/' : '\\';
  const target = parent && name.trim() ? `${parent.replace(/[\\/]+$/, '')}${sep}${name.trim()}` : '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const workspaceIdOrNull = workspace || null;
    try {
      if (mode === 'import') {
        // Na ordem da lista (a mais recente primeiro): é a primeira que o quadro abre.
        const r = await api.importProjects(found?.filter((p) => picked.has(p.path)).map((p) => p.path) ?? [], workspaceIdOrNull);
        const first = r.projectIds[0];
        if (first) onCreated(first);
        else onClose();
        return;
      }
      const r = await api.newProject(
        mode === 'create'
          ? { mode, parent: parent.trim(), name: name.trim(), git, workspaceId: workspaceIdOrNull }
          : { mode, path: folder.trim(), workspaceId: workspaceIdOrNull },
      );
      onCreated(r.projectId);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
      if (mode === 'import') setFound(null);
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
          <button type="button" role="radio" aria-checked={mode === 'create'} className={mode === 'create' ? 'btn-primary' : 'btn-secondary'} onClick={() => pickMode('create')}>
            {t('office.npCreate')}
          </button>
          <button type="button" role="radio" aria-checked={mode === 'existing'} className={mode === 'existing' ? 'btn-primary' : 'btn-secondary'} onClick={() => pickMode('existing')}>
            {t('office.npExisting')}
          </button>
          <button type="button" role="radio" aria-checked={mode === 'import'} className={mode === 'import' ? 'btn-primary' : 'btn-secondary'} onClick={() => pickMode('import')}>
            {t('office.npImport')}
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
        ) : mode === 'existing' ? (
          <label>
            {t('office.npPath')}
            <input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={400} required autoFocus className="mono" placeholder={t('office.npPathPlaceholder')} />
          </label>
        ) : loadError !== null ? (
          <>
            <p className="error">{loadError}</p>
            <div className="actions">
              <button type="button" className="btn-secondary" onClick={() => setLoadError(null)}>
                {t('office.npImportRetry')}
              </button>
            </div>
          </>
        ) : found === null ? (
          <p className="muted small">{t('office.npImportLoading')}</p>
        ) : found.length === 0 ? (
          <p className="muted">{t('office.npImportNone')}</p>
        ) : (
          <>
            <p className="muted small">{t('office.npImportHint')}</p>
            <div className="actions">
              <button type="button" className="btn-secondary" onClick={toggleAll}>
                {allPicked ? t('office.npImportNoneAll') : t('office.npImportAll')}
              </button>
            </div>
            <div className="import-list">
              {found.map((p) => (
                <label key={p.path} className="choice">
                  <input type="checkbox" checked={picked.has(p.path)} onChange={() => toggle(p.path)} />
                  <span>
                    <span className="import-head">
                      <b>{p.name}</b>
                      {p.sources?.map((s) => (
                        <span key={s} className="import-source">
                          {`>_ ${t(SOURCE_NAME[s])}`}
                        </span>
                      ))}
                    </span>
                    <span className="muted small mono">{p.path}</span>
                  </span>
                </label>
              ))}
            </div>
          </>
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
          <button type="submit" className="btn-primary" disabled={busy || (mode === 'import' && picked.size === 0)}>
            {mode === 'import'
              ? busy
                ? t('office.npImporting')
                : t('office.npSubmitImport', { n: picked.size })
              : busy
                ? t('office.npWorking')
                : mode === 'create'
                  ? t('office.npSubmitCreate')
                  : t('office.npSubmitOpen')}
          </button>
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('office.cancel')}
          </button>
        </div>
        <p className="muted small">{mode === 'import' ? t('office.npImportNote') : t('office.npNote')}</p>
      </form>
    </div>
  );
}
