import { useEffect, useMemo, useState } from 'react';
import type { StaffProfile } from '../../../shared/model';
import { api, type DirectoryPerson } from '../api';
import { portraitUrl } from '../board/nodes';
import { t } from '../i18n';
import { copyCandidates } from './directory';

// Contratar "da empresa": copia a ficha de alguém de outro projeto (id novo; a memória só se pedir).

interface Props {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onCopied: (profile: StaffProfile) => void;
}

function Face({ person, big = false }: { person: DirectoryPerson; big?: boolean }) {
  const cls = big ? 'copy-face is-big' : 'copy-face';
  return person.hasPortrait ? (
    <img className={cls} src={portraitUrl(person.projectId, { id: person.staffId, updatedAt: person.updatedAt })} alt="" />
  ) : (
    <span className={cls} aria-hidden="true">
      {person.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

export function CopyFromCompany({ projectId, projectName, onClose, onCopied }: Props) {
  const [people, setPeople] = useState<DirectoryPerson[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<DirectoryPerson | null>(null);
  const [withMemory, setWithMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.staffDirectory().then(
      (r) => setPeople(r.people),
      (err) => setLoadError((err as Error).message || t('staff.copyLoadError')),
    );
  }, []);

  const others = useMemo(() => (people ? copyCandidates(people, projectId, '') : []), [people, projectId]);
  const list = useMemo(() => (people ? copyCandidates(people, projectId, query) : []), [people, projectId, query]);

  const pick = (p: DirectoryPerson) => {
    setPicked(p);
    setWithMemory(false);
    setError(null);
  };

  const copy = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.copyStaff(projectId, { fromProjectId: picked.projectId, staffId: picked.staffId, withMemory });
      onCopied(r.profile);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      {picked ? (
        <div className="form-panel copy-confirm">
          <div className="copy-who">
            <Face person={picked} big />
            <span className="copy-text">
              <b>{picked.name}</b>
              <span className="muted small">
                {picked.role} · {t('staff.copyFrom', { project: picked.projectName })}
              </span>
            </span>
          </div>
          {picked.mission && <p className="muted small copy-mission">{picked.mission}</p>}
          <p className="small">{t('staff.copyNote', { project: projectName })}</p>
          <label className="check">
            <input type="checkbox" checked={withMemory} onChange={(e) => setWithMemory(e.target.checked)} /> {t('staff.copyMemory')}
            <span className="muted small"> {t('staff.copyMemoryHint')}</span>
          </label>
        </div>
      ) : (
        <div className="form-panel copy-pick">
          <input
            type="search"
            className="copy-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('staff.copySearch')}
            aria-label={t('staff.copySearch')}
            maxLength={80}
            autoFocus
          />
          {loadError && <p className="error">{loadError}</p>}
          {!people && !loadError && <p className="muted small">{t('staff.loading')}</p>}
          {people && others.length === 0 && <p className="muted small">{t('staff.copyEmpty')}</p>}
          {others.length > 0 && list.length === 0 && <p className="muted small">{t('staff.copyNoMatch')}</p>}
          {list.length > 0 && (
            <ul className="rows">
              {list.map((p) => (
                <li key={`${p.projectId}/${p.staffId}`}>
                  <button type="button" className="row row-button copy-row" onClick={() => pick(p)}>
                    <Face person={p} />
                    <span className="copy-text">
                      <b>{p.name}</b>
                      <span className="muted small">{p.role}</span>
                      <span className="muted small">{p.projectName}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="modal-footer">
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {picked && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void copy()}>
              {busy ? t('staff.saving') : t('staff.copyAction')}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={picked ? () => setPicked(null) : onClose}>
            {picked ? t('staff.copyBack') : t('staff.cancel')}
          </button>
        </div>
      </div>
    </>
  );
}
