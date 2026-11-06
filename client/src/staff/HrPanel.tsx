import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig } from '../../../shared/model';
import { api, deleteStaffConfirm, isPairingError, type DirectoryStaff, type StaffRef } from '../api';
import { t } from '../i18n';
import { Face } from './CopyFromCompany';
import { hrGroups, linkCandidates, orphansOf } from './directory';

// RH: todas as fichas de todos os projetos, com as cópias da mesma pessoa juntas. Daqui abre a ficha (a edição
// continua no painel do funcionário), arquiva, liga/desliga cópias e exclui de vez.

interface Props {
  /** Leva ao painel do funcionário no projeto dele. */
  onOpen: (person: DirectoryStaff) => void;
  /** Arquivar devolve o config novo (os arquivados). */
  onConfig: (config: AppConfig) => void;
  /** Algo mudou nas fichas: o quadro relê. */
  onChanged: () => void;
  onNotice: (text: string) => void;
}

const refOf = (p: DirectoryStaff): StaffRef => ({ projectId: p.projectId, staffId: p.staffId });
const keyOf = (p: DirectoryStaff) => `${p.projectId}/${p.staffId}`;
const names = (people: DirectoryStaff[]) => people.map((p) => p.name).join(', ');

export function HrPanel({ onOpen, onConfig, onChanged, onNotice }: Props) {
  const [people, setPeople] = useState<DirectoryStaff[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  /** A ficha com as ações abertas (o ⋯). */
  const [open, setOpen] = useState<string | null>(null);
  /** Escolhendo com quem ligar esta ficha. */
  const [linking, setLinking] = useState<DirectoryStaff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      api.staffDirectory().then(
        (r) => {
          setPeople(r.people);
          setLoadError(null);
        },
        (err) => setLoadError((err as Error).message || t('staff.copyLoadError')),
      ),
    [],
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const projects = useMemo(() => {
    const byId = new Map((people ?? []).map((p) => [p.projectId, p.projectName]));
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [people]);
  const groups = useMemo(() => (people ? hrGroups(people, query, project || null) : []), [people, query, project]);
  const shown = groups.reduce((n, g) => n + g.people.length, 0);

  /** Roda a ação; erro fica embaixo da ficha (a recusa por pareamento já tem o aviso do App). */
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const done = await run();
      setOpen(null);
      setLinking(null);
      if (done) onNotice(done);
      await reload();
      onChanged();
    } catch (err) {
      if (!isPairingError(err)) setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const archive = (p: DirectoryStaff) =>
    act(async () => {
      // A mesma chave do arquivar do painel do funcionário (archiveKey).
      onConfig(await api.archive('session', `staff:${p.staffId}`, !p.archived));
      return null;
    });

  const link = (to: DirectoryStaff) =>
    linking &&
    act(async () => {
      await api.linkStaff(refOf(linking), refOf(to));
      return t('hr.linkDone', { a: linking.name, from: linking.projectName, b: to.name, to: to.projectName });
    });

  const unlink = (p: DirectoryStaff) =>
    act(async () => {
      await api.unlinkStaff(refOf(p));
      return t('hr.unlinkDone', { name: p.name, project: p.projectName });
    });

  const remove = (p: DirectoryStaff) => {
    const orphans = orphansOf(people ?? [], refOf(p));
    const ask = t('hr.deleteConfirm', { name: p.name, project: p.projectName });
    if (!window.confirm(orphans.length ? `${ask}\n\n${t('hr.deleteOrphans', { names: names(orphans) })}` : ask)) return;
    void act(async () => {
      const r = await deleteStaffConfirm(p.projectId, p.staffId, (n) => window.confirm(t('hr.deleteOpenTasks', { name: p.name, n })));
      if (!r) return null;
      // Quem ficou sem chefe vem do servidor (pode ter mudado desde a lista).
      const left = (people ?? []).filter((x) => x.projectId === p.projectId && r.orphaned.includes(x.staffId));
      return left.length ? t('hr.deletedOrphans', { name: p.name, names: names(left) }) : t('hr.deleted', { name: p.name });
    });
  };

  const head = (
    <header className="header">
      <p className="kicker">{t('hr.button')}</p>
      <h2>{t('hr.title')}</h2>
      {people && <p className="muted small">{t(shown === 1 ? 'hr.countOne' : 'hr.countOther', { n: shown })}</p>}
    </header>
  );

  if (linking) {
    const candidates = people ? linkCandidates(people, refOf(linking), query) : [];
    return (
      <>
        {head}
        <div className="hr-filters">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('staff.copySearch')}
            aria-label={t('staff.copySearch')}
            maxLength={80}
            autoFocus
          />
        </div>
        <p className="small">{t('hr.linkIntro', { name: linking.name })}</p>
        {candidates.length ? (
          <ul className="rows">
            {candidates.map((p) => (
              <li key={keyOf(p)}>
                <button type="button" className="row row-button copy-row" disabled={busy} onClick={() => void link(p)}>
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
        ) : (
          <p className="muted small">{query ? t('staff.copyNoMatch') : t('hr.linkEmpty')}</p>
        )}
        {error && <p className="error">{error}</p>}
        <p className="actions">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setLinking(null);
              setQuery('');
              setError(null);
            }}
          >
            {t('staff.copyBack')}
          </button>
        </p>
      </>
    );
  }

  const row = (p: DirectoryStaff, linked: boolean) => {
    const key = keyOf(p);
    const expanded = open === key;
    return (
      <li key={key} className={`hr-row ${p.archived ? 'is-archived' : ''}`}>
        <div className="hr-main">
          <Face person={p} />
          <span className="copy-text">
            <b>{p.name}</b>
            <span className="muted small">{p.role}</span>
            <span className="hr-meta small">
              <span className="muted">{p.projectName}</span>
              <span className={`badge ${p.archived ? 'dim' : ''}`}>{p.archived ? t('detail.archived') : t('hr.active')}</span>
            </span>
          </span>
          <button
            type="button"
            className="btn-secondary hr-more"
            aria-expanded={expanded}
            aria-controls={`hr-actions-${key}`}
            aria-label={t('hr.actions', { name: p.name })}
            title={t('hr.actions', { name: p.name })}
            onClick={() => {
              setOpen(expanded ? null : key);
              setError(null);
            }}
          >
            ⋯
          </button>
        </div>
        {expanded && (
          <div className="hr-actions" id={`hr-actions-${key}`}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => onOpen(p)}>
              {t('hr.open')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void archive(p)}>
              {p.archived ? t('detail.unarchive') : t('detail.archive')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setLinking(p);
                setQuery('');
                setError(null);
              }}
            >
              {t('hr.link')}
            </button>
            {linked && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void unlink(p)}>
                {t('hr.unlink')}
              </button>
            )}
            <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => remove(p)}>
              {t('hr.delete')}
            </button>
            {error && <p className="error hr-error">{error}</p>}
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      {head}
      <div className="hr-filters">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('staff.copySearch')}
          aria-label={t('staff.copySearch')}
          maxLength={80}
        />
        <select className="setting-select" value={project} onChange={(e) => setProject(e.target.value)} aria-label={t('hr.projectFilter')}>
          <option value="">{t('hr.allProjects')}</option>
          {projects.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      {loadError && <p className="error">{loadError}</p>}
      {!people && !loadError && <p className="muted small">{t('staff.loading')}</p>}
      {people && people.length === 0 && <p className="muted small">{t('hr.empty')}</p>}
      {people && people.length > 0 && groups.length === 0 && <p className="muted small">{t('staff.copyNoMatch')}</p>}
      <ul className="hr-list">
        {groups.map((g) =>
          g.total > 1 ? (
            <li key={g.key} className="hr-group">
              <p className="hr-group-head small">{t('hr.linked', { n: g.total })}</p>
              <ul className="hr-group-list">{g.people.map((p) => row(p, true))}</ul>
            </li>
          ) : (
            row(g.people[0]!, false)
          ),
        )}
      </ul>
    </>
  );
}
