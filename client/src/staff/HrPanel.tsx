import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig, StaffProfile } from '../../../shared/model';
import { api, deleteStaffConfirm, isPairingError, type DirectoryStaff, type StaffRef } from '../api';
import { t } from '../i18n';
import { Face } from './CopyFromCompany';
import { fieldsThatDiffer, hrGroups, linkTargets, orphansOf, PERSON_FIELD_LABEL, personGroup, sameNameGroups, type HrGroup } from './directory';

// RH: uma linha por pessoa, com um chip por projeto em que ela tem ficha (fichas com o mesmo personId são a mesma
// pessoa). Clicar na linha ou num chip abre a edição (o painel do funcionário, no projeto escolhido); daqui também se
// junta fichas da mesma pessoa, se separa uma delas, arquiva e exclui.

interface Props {
  /** Abre o editor da pessoa nesta ficha (o projeto do chip, ou o da linha). */
  onEdit: (person: DirectoryStaff) => void;
  /** As fichas inteiras do quadro: mostram em que campos as da mesma pessoa diferem antes de juntar. */
  profiles: StaffProfile[];
  /** Arquivar devolve o config novo (os arquivados). */
  onConfig: (config: AppConfig) => void;
  /** Algo mudou nas fichas: o quadro relê. */
  onChanged: () => void;
  onNotice: (text: string) => void;
}

/** Juntar: os grupos de fichas que viram uma pessoa só; o primeiro é o de quem pediu. */
interface Join {
  name: string;
  groups: DirectoryStaff[][];
}

const refOf = (p: DirectoryStaff): StaffRef => ({ projectId: p.projectId, staffId: p.staffId });
const keyOf = (p: DirectoryStaff) => `${p.projectId}/${p.staffId}`;
const names = (people: DirectoryStaff[]) => people.map((p) => p.name).join(', ');
const projectNames = (people: DirectoryStaff[]) => [...new Set(people.map((p) => p.projectName))].join(', ');

export function HrPanel({ onEdit, profiles, onConfig, onChanged, onNotice }: Props) {
  const [people, setPeople] = useState<DirectoryStaff[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [project, setProject] = useState('');
  /** A pessoa com as ações abertas (o ⋯). */
  const [open, setOpen] = useState<string | null>(null);
  /** Escolhendo com quem ligar esta pessoa. */
  const [picking, setPicking] = useState<HrGroup | null>(null);
  /** Confirmando juntar (o que passa a valer e o que diverge). */
  const [join, setJoin] = useState<Join | null>(null);
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

  /** Roda a ação; erro fica embaixo da pessoa (a recusa por pareamento já tem o aviso do App). */
  const act = async (run: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const done = await run();
      setOpen(null);
      setPicking(null);
      setJoin(null);
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

  /** Liga o grupo de quem pediu a cada um dos outros, um por vez (o servidor junta os grupos inteiros). */
  const merge = (j: Join) =>
    act(async () => {
      const [mine, ...others] = j.groups;
      for (const other of others) await api.linkStaff(refOf(mine![0]!), refOf(other[0]!));
      const all = j.groups.flat();
      return t('hr.joinDone', { name: j.name, n: new Set(all.map((p) => p.projectId)).size, projects: projectNames(all) });
    });

  const unlink = (p: DirectoryStaff) => {
    if (!window.confirm(t('hr.unlinkConfirm', { name: p.name, project: p.projectName }))) return;
    void act(async () => {
      await api.unlinkStaff(refOf(p));
      return t('hr.unlinkDone', { name: p.name, project: p.projectName });
    });
  };

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

  // O cabeçalho (RH e ranking) e as abas são do PeoplePanel; aqui fica só a contagem.
  const head = people && <p className="muted small">{t(groups.length === 1 ? 'hr.countOne' : 'hr.countOther', { n: groups.length })}</p>;
  const back = (to: () => void) => (
    <p className="actions">
      <button type="button" className="btn-secondary" disabled={busy} onClick={to}>
        {t('staff.copyBack')}
      </button>
    </p>
  );

  if (join) {
    const all = join.groups.flat();
    const found = all.flatMap((p) => profiles.filter((s) => s.projectId === p.projectId && s.id === p.staffId));
    const differ = found.length > 1 ? fieldsThatDiffer(found) : [];
    // Mais de um grupo com memória pessoal própria: o servidor fica com a do último ligado que tem uma.
    const withMemory = join.groups.filter((g) => g[0]?.personId);
    const keeper = [...join.groups.slice(1)].reverse().find((g) => g[0]?.personId) ?? join.groups[0]!;
    return (
      <>
        {head}
        <div className="copy-confirm">
          <p className="copy-ask">{t('hr.joinAsk', { name: join.name })}</p>
          <p className="small">
            {t('hr.joinScope', { n: new Set(all.map((p) => p.projectId)).size, projects: projectNames(all) })}
          </p>
          {/* Ficha de projeto fora do quadro (arquivado): não dá para comparar, então não afirma que são iguais. */}
          {differ.length > 0 && (
            <p className="person-note small" role="note">
              {t('hr.joinDiffer', { fields: differ.map((f) => t(PERSON_FIELD_LABEL[f])).join(', ') })}
            </p>
          )}
          {!differ.length && found.length === all.length && <p className="muted small">{t('hr.joinSame')}</p>}
          {withMemory.length > 1 && (
            <p className="person-note small" role="note">
              {t('hr.joinMemory', { project: projectNames(keeper) })}
            </p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
        <p className="actions">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void merge(join)}>
            {t('hr.joinAction')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              setJoin(null);
              setError(null);
            }}
          >
            {t('staff.copyBack')}
          </button>
        </p>
      </>
    );
  }

  if (picking) {
    const candidates = people ? linkTargets(people, picking, query) : [];
    const who = picking.all[0]!;
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
        <p className="small">{t('hr.linkIntro', { name: who.name })}</p>
        {candidates.length ? (
          <ul className="rows">
            {candidates.map((p) => (
              <li key={keyOf(p)}>
                <button
                  type="button"
                  className="row row-button copy-row"
                  disabled={busy}
                  onClick={() => {
                    setJoin({ name: who.name, groups: [picking.all, people ? personGroup(people, p) : [p]] });
                    setPicking(null);
                    setError(null);
                  }}
                >
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
        {back(() => {
          setPicking(null);
          setQuery('');
          setError(null);
        })}
      </>
    );
  }

  const row = (g: HrGroup) => {
    const who = g.all[0]!;
    const expanded = open === g.key;
    const same = sameNameGroups(people ?? [], g);
    return (
      <li key={g.key} className={`hr-row ${g.all.every((p) => p.archived) ? 'is-archived' : ''}`}>
        <div className="hr-main">
          <button type="button" className="hr-open" onClick={() => onEdit(g.people[0] ?? who)} aria-label={t('hr.edit', { name: who.name })} title={t('hr.edit', { name: who.name })}>
            <Face person={who} />
            <span className="copy-text">
              <b>{who.name}</b>
              <span className="muted small">{who.role}</span>
            </span>
          </button>
          <button
            type="button"
            className="btn-secondary hr-more"
            aria-expanded={expanded}
            aria-controls={`hr-actions-${g.key}`}
            aria-label={t('hr.actions', { name: who.name })}
            title={t('hr.actions', { name: who.name })}
            onClick={() => {
              setOpen(expanded ? null : g.key);
              setError(null);
            }}
          >
            ⋯
          </button>
        </div>
        <ul className="hr-chips" aria-label={t('hr.projectFilter')}>
          {g.all.map((p) => (
            <li key={keyOf(p)}>
              <button type="button" className={`chip hr-chip ${p.archived ? 'is-archived' : ''}`} onClick={() => onEdit(p)} title={t('hr.editIn', { name: p.name, project: p.projectName })}>
                {p.projectName}
                {p.archived && <span className="muted"> · {t('hr.archivedTag')}</span>}
              </button>
            </li>
          ))}
        </ul>
        {same.length > 0 && (
          <p className="hr-suggest small">
            <span className="muted">{t('hr.sameName', { projects: projectNames(same.flat()) })}</span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setJoin({ name: who.name, groups: [g.all, ...same] })}>
              {t('hr.unify')}
            </button>
          </p>
        )}
        {expanded && (
          <div className="hr-actions" id={`hr-actions-${g.key}`}>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                setPicking(g);
                setQuery('');
                setError(null);
              }}
            >
              {t('hr.link')}
            </button>
            {g.all.map((p) => (
              <div key={keyOf(p)} className="hr-proj">
                {g.all.length > 1 && <span className="hr-proj-name small muted">{t('hr.projectActions', { project: p.projectName })}</span>}
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void archive(p)}>
                  {p.archived ? t('detail.unarchive') : t('detail.archive')}
                </button>
                {g.all.length > 1 && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => unlink(p)}>
                    {t('hr.unlink')}
                  </button>
                )}
                <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => remove(p)}>
                  {t('hr.delete')}
                </button>
              </div>
            ))}
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
      <ul className="hr-list">{groups.map(row)}</ul>
    </>
  );
}
