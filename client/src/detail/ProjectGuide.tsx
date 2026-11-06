import { useEffect, useState } from 'react';
import { api, isPairingError, type ProjectGuide as Guide } from '../api';
import { t } from '../i18n';
import { FileIcon } from '../icons';

/** Guia do projeto (SPEC.md): a equipe lê em caso de dúvida. Cria a partir do modelo ou abre no editor de Arquivos. */
export function ProjectGuide({ projectId, onOpen }: { projectId: string; onOpen?: (path: string) => void }) {
  const [guide, setGuide] = useState<Guide | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setGuide(null);
    setError(null);
    api.projectGuide(projectId).then(setGuide, (e: Error) => setError(e.message));
  }, [projectId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setGuide(await api.createProjectGuide(projectId));
    } catch (e) {
      if (isPairingError(e)) return;
      setError((e as Error).message);
      // Recusa por já existir (409): relê, e aparece o "Abrir".
      api.projectGuide(projectId).then((g) => {
        setGuide(g);
        if (g.exists) setError(null);
      }, () => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h3>{t('detail.guideHeading')}</h3>
      {!guide ? (
        !error && <p className="muted small">{t('detail.loading')}</p>
      ) : guide.exists ? (
        <>
          <p className="muted small">{t('detail.guideExists', { path: guide.path })}</p>
          {guide.isGit && !guide.ignored && (
            <p className="guide-alert small" role="note">
              {t('detail.guideGitAlert', { path: guide.path })}
            </p>
          )}
          {onOpen && (
            <p className="actions">
              <button className="btn-secondary btn-with-icon" onClick={() => onOpen(guide.path)}>
                <FileIcon />
                {t('detail.guideOpen')}
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted small">{t('detail.guideNone')}</p>
          <p className="actions">
            <button className="btn-primary" onClick={() => void create()} disabled={busy}>
              {busy ? t('detail.guideCreating') : t('detail.guideCreate')}
            </button>
          </p>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
