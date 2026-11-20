import { useEffect, useState } from 'react';
import { api, isPairingError, type ConsultLinkView, type ConsultRecordView } from '../api';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { STATE_KEY, consultErrorKey, secondsToDeadline, splitLinks, toggleStaff } from './consultView';

interface Named {
  id: string;
  name: string;
}

export interface ConsultViewProps {
  projectName: string;
  /** Os outros projetos que existem (alvos possíveis). */
  projects: Named[];
  /** Funcionários deste projeto, na ordem da equipe. */
  team: Named[];
  /** Nome do funcionário de qualquer projeto (para o registro). */
  staffName: (projectId: string, staffId: string) => string;
  links: ConsultLinkView[];
  records: ConsultRecordView[];
  projectId: string;
  now: number;
  busy?: boolean;
  notice?: { tone: 'ok' | 'error'; text: string } | null;
  onSet: (to: string, staff: 'all' | string[]) => void;
  onRevoke: (link: ConsultLinkView) => void;
}

/** O que a seção mostra, sem buscar nada: o dono liga, limita e revoga o vínculo; o resto é leitura. */
export function ConsultView({ projectName, projects, team, staffName, links, records, projectId, now, busy, notice, onSet, onRevoke }: ConsultViewProps) {
  const [target, setTarget] = useState('');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [needOne, setNeedOne] = useState(false);
  const { out, incoming } = splitLinks(links, projectId);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const free = projects.filter((p) => !out.some((l) => l.to === p.id));
  const options = editing ? projects.filter((p) => p.id === target) : free;
  const who = (l: ConsultLinkView) =>
    l.staffIds === null ? t('consult.everyone') : t('consult.only', { names: l.staffIds.map((s) => team.find((m) => m.id === s)?.name ?? s).join(', ') });

  const reset = () => {
    setTarget('');
    setAll(true);
    setPicked([]);
    setEditing(false);
    setNeedOne(false);
  };
  const edit = (l: ConsultLinkView) => {
    setTarget(l.to);
    setAll(l.staffIds === null);
    setPicked(l.staffIds ?? []);
    setEditing(true);
    setNeedOne(false);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    if (!all && picked.length === 0) return setNeedOne(true);
    onSet(target, all ? 'all' : picked);
    reset();
  };

  return (
    <section className="section consult-section">
      <h3>{t('consult.title')}</h3>
      <p className="muted small">{t('consult.intro')}</p>
      <p className="consult-rules small">{t('consult.rules')}</p>

      <h4 className="consult-sub">{t('consult.asks')}</h4>
      {out.length === 0 && <p className="muted small">{t('consult.none')}</p>}
      <ul className="conn-list consult-links">
        {out.map((l) => (
          <li key={l.to}>
            <strong>{nameOf(l.to)}</strong>
            <span className="muted small">{who(l)}</span>
            <p className="actions">
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => edit(l)}>
                {t('detail.edit')}
              </button>
              <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => onRevoke(l)}>
                {t('consult.revoke')}
              </button>
            </p>
          </li>
        ))}
      </ul>

      {team.length === 0 ? (
        <p className="muted small">{t('consult.noStaff')}</p>
      ) : options.length === 0 ? (
        <p className="muted small">{t('consult.noTargets')}</p>
      ) : (
        <form className="conn-form consult-form" onSubmit={submit}>
          <h4 className="consult-sub">{t('consult.addTitle')}</h4>
          <label className="consult-field">
            <span className="small">{t('consult.target')}</span>
            <select className="setting-select" value={target} disabled={editing || busy} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{t('consult.pickTarget')}</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <div className="consult-field">
            <span className="small">{t('consult.who')}</span>
            <div className="segmented" role="group" aria-label={t('consult.who')}>
              <button type="button" className="btn-secondary btn-toggle" aria-pressed={all} onClick={() => setAll(true)}>
                {t('consult.whoAll')}
              </button>
              <button type="button" className="btn-secondary btn-toggle" aria-pressed={!all} onClick={() => setAll(false)}>
                {t('consult.whoSome')}
              </button>
            </div>
          </div>
          {!all && (
            <div className="consult-chips" role="group" aria-label={t('consult.who')}>
              {team.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="btn-secondary btn-toggle"
                  aria-pressed={picked.includes(m.id)}
                  onClick={() => {
                    setNeedOne(false);
                    setPicked(toggleStaff(picked, team.map((s) => s.id), m.id));
                  }}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          {needOne && (
            <p className="error small" role="alert">
              {t('consult.needOne')}
            </p>
          )}
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy || !target}>
              {editing ? t('consult.saveList') : t('consult.turnOn')}
            </button>
            {(editing || target) && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={reset}>
                {t('detail.cancel')}
              </button>
            )}
          </p>
        </form>
      )}
      {notice && (
        <p className={notice.tone === 'ok' ? 'ok small' : 'error small'} role={notice.tone === 'ok' ? 'status' : 'alert'}>
          {notice.text}
        </p>
      )}

      <h4 className="consult-sub">{t('consult.askedBy')}</h4>
      {incoming.length === 0 && <p className="muted small">{t('consult.noneIncoming')}</p>}
      <ul className="conn-list consult-links">
        {incoming.map((l) => (
          <li key={l.from}>
            <strong>{nameOf(l.from)}</strong>
            <span className="muted small">{l.staffIds === null ? t('consult.everyone') : l.staffIds.map((s) => staffName(l.from, s)).join(', ')}</span>
            <p className="actions">
              <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => onRevoke(l)}>
                {t('consult.revoke')}
              </button>
            </p>
          </li>
        ))}
      </ul>

      <h4 className="consult-sub">{t('consult.recent')}</h4>
      {records.length === 0 && <p className="muted small">{t('consult.none.records')}</p>}
      <ul className="conn-list consult-records">
        {records.slice(0, 5).map((r) => (
          <li key={r.id}>
            <span className="small">
              {t('consult.recordLine', {
                from: `${staffName(r.from.projectId, r.from.staffId)} (${r.from.projectId === projectId ? projectName : nameOf(r.from.projectId)})`,
                to: `${staffName(r.to.projectId, r.to.staffId)} (${r.to.projectId === projectId ? projectName : nameOf(r.to.projectId)})`,
              })}
            </span>
            <span className="badge dim consult-state" data-state={r.state}>
              {t(STATE_KEY[r.state])}
              {r.state === 'running' && ` · ${t('consult.deadline', { m: Math.ceil(secondsToDeadline(r.deadlineAt, now) / 60) })}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A seção no detalhe do projeto: lê vínculos, projetos, equipe e registro, e grava pelas rotas /api/consult. */
export function ConsultSection({ projectId, projectName, team }: { projectId: string; projectName: string; team: Named[] }) {
  const [data, setData] = useState<{ links: ConsultLinkView[]; records: ConsultRecordView[]; projects: Named[]; people: Map<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    const [{ links }, { consults }, projects, { people }] = await Promise.all([api.consultLinks(), api.consultRecords(projectId), api.projects(), api.staffDirectory()]);
    setData({
      links,
      records: consults,
      projects: projects.filter((p) => p.id !== projectId && p.exists && !p.worktreeOf).map((p) => ({ id: p.id, name: p.name })),
      people: new Map(people.map((p) => [`${p.projectId}:${p.staffId}`, p.name])),
    });
    setNow(Date.now());
  };
  useEffect(() => {
    setData(null);
    setNotice(null);
    load().catch(() => setNotice({ tone: 'error', text: t('consult.errGeneric') }));
    // Os prazos andam sozinhos: relê de tempos em tempos.
    const timer = setInterval(() => void load().catch(() => undefined), 20_000);
    return () => clearInterval(timer);
  }, [projectId]);

  if (!data) return null;
  const fail = (e: unknown) => {
    if (isPairingError(e)) return;
    setNotice({ tone: 'error', text: t(consultErrorKey((e as { status?: number | null }).status)) });
  };
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      const text = await action();
      await load();
      setNotice({ tone: 'ok', text });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const nameOf = (id: string) => (id === projectId ? projectName : (data.projects.find((p) => p.id === id)?.name ?? id));
  return (
    <ConsultView
      projectId={projectId}
      projectName={projectName}
      projects={data.projects}
      team={team}
      staffName={(pid, sid) => (pid === projectId ? team.find((m) => m.id === sid)?.name : data.people.get(`${pid}:${sid}`)) ?? sid}
      links={data.links}
      records={data.records}
      now={now}
      busy={busy}
      notice={notice}
      onSet={(to, staff) =>
        void run(async () => {
          await api.setConsultLink(projectId, to, staff);
          return t('consult.saved');
        })
      }
      onRevoke={async (l) => {
        if (!(await askConfirm(t('consult.revokeConfirm', { from: nameOf(l.from), to: nameOf(l.to) })))) return;
        await run(async () => t('consult.revokeOk', { n: (await api.revokeConsultLink(l.from, l.to)).cancelled }));
      }}
    />
  );
}
