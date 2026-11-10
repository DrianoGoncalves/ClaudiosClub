import { useEffect, useState } from 'react';
import type { StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { t, locale } from '../i18n';

// Histórico da ficha (aba Ações do funcionário): cada edição guarda a versão anterior; dá para restaurar.

type Version = { version: string; name: string; role: string; updatedAt: string };

export function StaffHistory({ projectId, staffId, onRestored }: { projectId: string; staffId: string; onRestored: (profile: StaffProfile) => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.staffVersions(projectId, staffId).then(setVersions, () => setVersions([]));
  }, [projectId, staffId]);

  const restore = async (version: string) => {
    setBusy(true);
    setError(null);
    try {
      onRestored(await api.restoreStaff(projectId, staffId, version));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h4>{versions ? `${t('staff.tabHistory')} (${versions.length})` : t('staff.tabHistory')}</h4>
      <p className="muted small">{t('staff.tabHistoryIntro')}</p>
      {versions === null && <p className="muted small">{t('staff.loading')}</p>}
      {versions?.length === 0 && <p className="muted small">{t('staff.historyEmpty')}</p>}
      <ul className="rows">
        {versions?.map((v) => (
          <li key={v.version} className="row row-inline">
            <span className="row-title">
              {v.name} <span className="muted small">{v.role}</span>
            </span>
            <span className="row-meta">
              <span className="muted">{new Date(v.updatedAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}</span>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void restore(v.version)}>
                {t('staff.restore')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </>
  );
}
