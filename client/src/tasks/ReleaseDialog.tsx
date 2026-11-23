import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StaffProfile, Task, TaskStatus } from '../../../shared/model';
import { expandScope, parseVersion, RELEASE_MODES, type ReleaseActor, type ReleaseHistory, type ReleaseLogEntry, type ReleaseMode, type ReleaseProof, type ReleaseTaskState, type ReleaseView } from '../../../shared/release';
import { api } from '../api';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { pollVisible } from '../usePoll';
import { CiBadge, CiSummary, useCi } from './CiBadge';
import { DeployPanel } from './DeployPanel';

// Versão com escopo (ver server/release.ts): a página em que o dono marca as tarefas pendentes que entram, acompanha a versão aberta (preparar, publicar, tag) e vê
// o histórico (as tags). O estado é lido a cada 5 s enquanto a página está aberta (custo fixo no servidor); o histórico, só ao abrir e ao trocar para a aba.

const STATUS_KEY: Record<TaskStatus, Parameters<typeof t>[0]> = {
  waiting: 'tasks.statusWaiting',
  todo: 'tasks.statusTodo',
  planning: 'tasks.statusPlanning',
  doing: 'tasks.statusDoing',
  review: 'tasks.statusReview',
  done: 'tasks.statusDone',
  cancelled: 'tasks.statusCancelled',
};
const STATE_KEY: Record<ReleaseTaskState, Parameters<typeof t>[0]> = {
  done: 'release.stateDone',
  pending: 'release.statePending',
  cancelled: 'release.stateCancelled',
  stuck: 'release.stateStuck',
};
const MODE_KEY: Record<ReleaseMode, Parameters<typeof t>[0]> = {
  manual: 'release.modeManual',
  'staff-pr': 'release.modeAgentPr',
  'staff-all': 'release.modeAgentAll',
};
const LOG_KEY: Record<ReleaseLogEntry['action'], Parameters<typeof t>[0]> = {
  opened: 'release.logOpened',
  scope: 'release.logScope',
  hotfix: 'release.logHotfix',
  prepared: 'release.logPrepared',
  'prepare-failed': 'release.logPrepareFailed',
  discarded: 'release.logDiscarded',
  published: 'release.logPublished',
  'tag-requested': 'release.logTagRequested',
  'tag-declined': 'release.logTagDeclined',
  tagged: 'release.logTagged',
};
const PROOF_KEY: Record<ReleaseProof['tests'], Parameters<typeof t>[0]> = { ok: 'release.proofOk', none: 'release.proofNone', skipped: 'release.proofSkipped' };
const actorName = (by: ReleaseActor) => by?.name ?? t('release.you');
/** "Provas: tipos ok, testes ok (relacionados a 12 arquivos)" ou "preparada sem as provas". */
export function proofText(p: ReleaseProof): string {
  if (p.typecheck === 'skipped' && p.tests === 'skipped') return t('release.proofSkippedAll');
  const base = t('release.proof', { typecheck: t(PROOF_KEY[p.typecheck]), tests: t(PROOF_KEY[p.tests]) });
  return p.related !== null ? `${base} ${t('release.proofRelated', { n: p.related })}` : base;
}

/** Pendentes na ordem em que mais importam: o que já anda primeiro. */
const ORDER: TaskStatus[] = ['doing', 'planning', 'review', 'todo', 'waiting'];
const pendingOf = (tasks: Task[]) =>
  tasks.filter((x) => ORDER.includes(x.status)).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.title.localeCompare(b.title));

/** A faixa do quadro com a versão aberta: quantas prontas e que as de fora esperam. Some sem versão. */
export function ReleaseBanner({ view, onOpen }: { view: ReleaseView | null | undefined; onOpen: () => void }) {
  const r = view?.release;
  if (!r || !view) return null;
  const text = r.prepared ? t('release.bannerPrepared', { version: r.version }) : t('release.banner', { version: r.version, done: view.done, total: view.total });
  return (
    <section className="release-banner" role="status">
      <p>{text}</p>
      <button type="button" className="btn-secondary" onClick={onOpen}>
        {t('release.bannerOpen')}
      </button>
    </section>
  );
}

/** Lê o estado da versão do projeto de tempos em tempos (para a faixa do quadro). Falha (servidor sem a rota) deixa undefined: nada aparece. */
export function useRelease(projectId: string, ms = 15_000): [ReleaseView | null | undefined, (v: ReleaseView | null) => void, () => void] {
  const [view, setView] = useState<ReleaseView | null | undefined>(undefined);
  const load = useCallback(() => {
    api.release(projectId).then(setView, () => {});
  }, [projectId]);
  useEffect(() => {
    load();
    return pollVisible(load, ms);
  }, [load, ms]);
  return [view, setView, load];
}

interface Props {
  projectId: string;
  projectName: string;
  staff: StaffProfile[];
  tasks: Task[];
  onClose: () => void;
  /** A versão mudou (aberta, preparada, cancelada): o quadro relê a faixa. */
  onChanged: (view: ReleaseView | null) => void;
  /** Só para teste (o render no servidor não roda os efeitos). */
  initialView?: ReleaseView | null;
  initialHistory?: ReleaseHistory | null;
}

export function ReleaseDialog({ projectId, projectName, staff, tasks, onClose, onChanged, initialView, initialHistory }: Props) {
  const [pane, setPane] = useState<'current' | 'history'>('current');
  const [view, setView] = useState<ReleaseView | null | undefined>(initialView);
  const [history, setHistory] = useState<ReleaseHistory | null | undefined>(initialHistory);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState('');
  const [docs, setDocs] = useState(true);
  const [docsStaff, setDocsStaff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.release(projectId).then(setView, (e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(() => {
    load();
    return pollVisible(load, 5000);
  }, [load]);
  const loadHistory = useCallback(() => {
    api.releaseHistory(projectId).then(setHistory, (e: Error) => setError(e.message));
  }, [projectId]);
  useEffect(loadHistory, [loadHistory]);
  // O número sugerido entra no campo uma vez (o que você digitar depois fica).
  useEffect(() => {
    if (history?.suggested) setVersion((v) => v || history.suggested);
  }, [history?.suggested]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const release = view?.release ?? null;
  // O CI do PR da versão: só depois de publicada (antes, nada vai ao GitHub).
  const prUrl = release?.published?.pr ?? null;
  const [ci, reloadCi] = useCi(prUrl ?? 'sem-pr', () => (prUrl ? api.releaseCi(projectId) : Promise.resolve(null)));
  /** Entradas do histórico abertas: só elas leem o CI (uma consulta por entrada que você abre, nunca a lista toda). */
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const pending = useMemo(() => pendingOf(tasks), [tasks]);
  const inScope = useMemo(() => new Set(release?.taskIds ?? []), [release]);
  // Com as dependências: a mesma conta do servidor (shared/release.ts).
  const scope = useMemo(() => new Set(expandScope(tasks, [...picked])), [tasks, picked]);
  const names = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);

  const act = async (run: () => Promise<ReleaseView | null>, confirm?: string) => {
    if (confirm && !(await askConfirm(confirm))) return;
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      setView(next);
      onChanged(next);
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message || null);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** A lista de pendentes com caixa de marcar; `skip` = já na versão (não aparece). */
  const picker = (skip: Set<string>) => {
    const list = pending.filter((x) => !skip.has(x.id));
    if (!list.length) return <p className="muted small">{t('release.none')}</p>;
    return (
      <ul className="release-list">
        {list.map((x) => {
          const pulled = scope.has(x.id) && !picked.has(x.id);
          return (
            <li key={x.id} className="release-item">
              <label className="release-pick">
                <input type="checkbox" checked={scope.has(x.id)} disabled={busy || pulled} onChange={() => toggle(x.id)} />
                <span className="release-title">{x.title}</span>
              </label>
              <span className="release-meta muted small">
                {t(STATUS_KEY[x.status])}
                {x.staffId && names.get(x.staffId) ? ` · ${names.get(x.staffId)}` : ''}
                {pulled && <span className="release-chip"> {t('release.pulled')}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    );
  };

  /** Quem publica no projeto (vale com ou sem versão aberta) e o botão que desliga a publicação por funcionários na hora. */
  const modeSection = (mode: ReleaseMode) => (
    <fieldset className="release-mode" disabled={busy}>
      <legend>{t('release.modeHead')}</legend>
      {RELEASE_MODES.map((m) => (
        <label key={m} className="release-pick">
          <input
            type="radio"
            name="release-mode"
            checked={mode === m}
            onChange={() =>
              act(async () => {
                await api.setPublishGate(projectId, m);
                return api.release(projectId);
              }, m === 'staff-all' ? t('release.modeAllConfirm') : undefined)
            }
          />
          <span>{t(MODE_KEY[m])}</span>
        </label>
      ))}
      {mode !== 'manual' && (
        <button
          type="button"
          className="btn-secondary is-danger"
          onClick={() =>
            act(async () => {
              await api.setPublishGate(projectId, 'manual');
              return api.release(projectId);
            })
          }
        >
          {t('release.modeOff')}
        </button>
      )}
    </fieldset>
  );

  /** O registro da versão (quem abriu, preparou, publicou, pediu a tag), do mais novo para o mais velho. */
  const logSection = (log: ReleaseLogEntry[]) =>
    log.length > 0 && (
      <details className="release-add">
        <summary>{t('release.logHead', { n: log.length })}</summary>
        <ul className="release-history-tasks small">
          {[...log].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`}>
              <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time> · {t(LOG_KEY[e.action])} · {actorName(e.by)}
              {e.detail ? ` · ${e.detail}` : ''}
            </li>
          ))}
        </ul>
      </details>
    );

  const openForm = () => {
    const valid = !!parseVersion(version);
    const needsStaff = docs && !docsStaff;
    return (
      <div className="release-body">
        {modeSection(view?.mode ?? 'manual')}
        <p className="muted small">{t('release.intro')}</p>
        <label className="release-field">
          <span>{t('release.number')}</span>
          <input type="text" inputMode="decimal" value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="1.2.3" aria-invalid={!valid} maxLength={20} />
          <span className="muted small">{t('release.numberHint')}</span>
        </label>
        <h3 className="release-head">{t('release.pending', { n: pending.length })}</h3>
        {picker(new Set())}
        <label className="release-pick">
          <input type="checkbox" checked={docs} onChange={(e) => setDocs(e.target.checked)} disabled={busy} />
          <span>{t('release.docs')}</span>
        </label>
        {docs && (
          <label className="release-field">
            <span>{t('release.docsStaff')}</span>
            <select value={docsStaff} onChange={(e) => setDocsStaff(e.target.value)} disabled={busy}>
              <option value="">{t('release.docsPick')}</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="release-foot">
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !valid || !scope.size || needsStaff}
            onClick={() => act(() => api.openRelease(projectId, { version, taskIds: [...picked], docsStaffId: docs ? docsStaff : null }))}
          >
            {t('release.start', { n: scope.size })}
          </button>
        </div>
      </div>
    );
  };

  const current = (v: ReleaseView) => {
    const r = v.release!;
    const add = [...scope].filter((id) => !inScope.has(id));
    const hotfixTitles = r.hotfixes.map((id) => tasks.find((x) => x.id === id)?.title ?? id);
    return (
      <div className="release-body">
        {modeSection(v.mode)}
        <h3 className="release-head">{t('release.openedHead', { version: r.version, done: v.done, total: v.total })}</h3>
        <progress className="release-progress" max={Math.max(1, v.total)} value={v.done} aria-label={t('release.openedHead', { version: r.version, done: v.done, total: v.total })} />
        <ul className="release-list">
          {v.tasks.map((x) => (
            <li key={x.id} className="release-item" data-state={x.state}>
              <span className="release-title">{x.title}</span>
              <span className="release-meta small">
                <span className="release-chip" data-state={x.state}>
                  {t(STATE_KEY[x.state])}
                </span>
                {x.state === 'pending' && x.status && <span className="muted"> · {t(STATUS_KEY[x.status])}</span>}
                {x.staffId && names.get(x.staffId) && <span className="muted"> · {names.get(x.staffId)}</span>}
                {x.rejections > 0 && <span className="muted"> · {t('release.rejections', { n: x.rejections })}</span>}
              </span>
              {!r.prepared && x.state !== 'done' && (
                <button type="button" className="btn-secondary release-remove" title={t('release.removeTitle')} disabled={busy} onClick={() => act(() => api.changeReleaseScope(projectId, { remove: [x.id] }))}>
                  {t('release.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
        {hotfixTitles.length > 0 && <p className="small">{t('release.hotfixes', { list: hotfixTitles.join(' · ') })}</p>}
        {!r.prepared && (
          <details className="release-add">
            <summary>{t('release.addHead')}</summary>
            {picker(new Set([...inScope, ...r.hotfixes]))}
            <div className="release-foot">
              <button type="button" className="btn-secondary" disabled={busy || !add.length} onClick={() => act(() => api.changeReleaseScope(projectId, { add: [...picked] }))}>
                {t('release.add', { n: add.length })}
              </button>
              <button type="button" className="btn-secondary" title={t('release.hotfixTitle')} disabled={busy || !picked.size} onClick={() => act(() => api.changeReleaseScope(projectId, { hotfix: [...picked] }))}>
                {t('release.hotfix', { n: picked.size })}
              </button>
            </div>
          </details>
        )}
        <div className="release-status" role="status">
          {!r.prepared && v.preparing && <p>{t('release.preparing')}</p>}
          {!r.prepared && !v.preparing && r.prepareError && (
            <>
              <p className="error small">{t('release.prepareFailed', { error: r.prepareError.message })}</p>
              {r.prepareError.testsOutput && (
                <details>
                  <summary className="small">{t('release.testsOutput')}</summary>
                  <pre className="release-output">{r.prepareError.testsOutput}</pre>
                </details>
              )}
              <div className="release-foot">
                <button type="button" className="btn-primary" disabled={busy || !v.ready} onClick={() => act(() => api.prepareRelease(projectId))}>
                  {t('release.retry')}
                </button>
                <button type="button" className="btn-secondary" disabled={busy || !v.ready} onClick={() => act(() => api.prepareRelease(projectId, true), t('release.skipTestsConfirm', { version: r.version }))}>
                  {t('release.skipTests')}
                </button>
              </div>
            </>
          )}
          {!r.prepared && !v.preparing && !r.prepareError && (
            <>
              <p className="muted small">{t('release.waiting')}</p>
              {v.ready && (
                <button type="button" className="btn-primary" disabled={busy} onClick={() => act(() => api.prepareRelease(projectId))}>
                  {t('release.prepareNow')}
                </button>
              )}
            </>
          )}
          {r.prepared && <p className="small">{t('release.prepared', { sha: r.prepared.sha.slice(0, 7), branch: r.prepared.branch })}</p>}
          {r.prepared && <p className="muted small">{proofText(r.prepared.proof)}</p>}
          {r.prepared && !r.published && (
            <div className="release-foot">
              <button type="button" className="btn-primary" disabled={busy} onClick={() => act(() => api.publishRelease(projectId), t('release.publishConfirm', { version: r.version }))}>
                {t('release.publish')}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api.discardRelease(projectId), t('release.discardConfirm', { version: r.version }))}>
                {t('release.discard')}
              </button>
            </div>
          )}
          {r.published && (
            <>
              <p className="small">
                {t('release.published')} ({t('release.publishedBy', { who: actorName(r.published.by) })}){' '}
                {/^https:\/\/github\.com\//.test(r.published.pr) ? (
                  <a href={r.published.pr} target="_blank" rel="noopener noreferrer">
                    {r.published.pr}
                  </a>
                ) : (
                  r.published.pr
                )}
              </p>
              <CiSummary data={ci} />
              {r.tagRequest ? (
                <p className="small release-request">{t('release.tagRequest', { who: r.tagRequest.by.name, version: r.version })}</p>
              ) : (
                <p className="muted small">{t('release.tagHint')}</p>
              )}
              <div className="release-foot">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      const out = await api.tagRelease(projectId);
                      reloadCi();
                      return out;
                    }, t('release.tagConfirm', { version: r.version }))
                  }
                >
                  {r.tagRequest ? t('release.approveTag', { version: r.version }) : t('release.tag', { version: r.version })}
                </button>
                {ci?.pr?.state === 'merged' && (!ci.merge || ci.merge.state === 'unavailable') && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api.tagRelease(projectId, true), t('release.tagForceConfirm', { version: r.version }))}>
                    {t('release.tagForce')}
                  </button>
                )}
                {r.tagRequest && (
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => act(() => api.declineReleaseTag(projectId))}>
                    {t('release.declineTag')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {logSection(r.log)}
        <div className="release-foot">
          <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => act(() => api.cancelRelease(projectId), t('release.cancelConfirm', { version: r.version }))}>
            {t('release.cancel')}
          </button>
        </div>
      </div>
    );
  };

  const historyPane = () => {
    if (history === undefined) return <p className="muted">{t('release.loading')}</p>;
    // Deploy como código da versão (a tag mais nova) e o rollback para a anterior; só lido com a aba aberta.
    const deploy = (
      <section className="release-status">
        <h3 className="release-head">{t('release.deployHead')}</h3>
        <DeployPanel projectId={projectId} />
      </section>
    );
    if (!history?.entries.length) return <p className="muted">{t('release.historyEmpty')}</p>;
    return (
      <>
      {deploy}
      <ul className="release-list">
        {history.entries.map((e) => (
          <li key={e.tag} className="release-history">
            <details
              onToggle={(ev) => {
                const open = (ev.currentTarget as HTMLDetailsElement).open;
                setOpenTags((s) => {
                  const n = new Set(s);
                  if (open) n.add(e.tag);
                  else n.delete(e.tag);
                  return n;
                });
              }}
            >
              <summary>
                <strong>{e.tag}</strong>
                <span className="muted small">
                  {' '}
                  · {e.date ? new Date(e.date).toLocaleDateString() : ''} · <code>{e.sha.slice(0, 7)}</code>
                  {e.tasks.length > 0 && ` · ${t('release.historyTasks', { n: e.tasks.length })}`}
                </span>
                {e.subject && <span className="release-subject small">{e.subject}</span>}
              </summary>
              {openTags.has(e.tag) && /^[0-9a-f]{40}$/.test(e.sha) && <CiBadge k={`commit:${e.sha}`} load={() => api.commitCi(projectId, e.sha)} />}
              {e.summary && <p className="release-summary small">{e.summary}</p>}
              {e.tasks.length ? (
                <ul className="release-history-tasks small">
                  {e.tasks.map((x) => (
                    <li key={x.id}>
                      <code>{x.id}</code> {x.title}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">{t('release.historyNoTasks')}</p>
              )}
            </details>
          </li>
        ))}
      </ul>
      </>
    );
  };

  return (
    <div className="modal-backdrop sched-backdrop">
      <div className="modal sched-modal release-modal" role="dialog" aria-modal="true" aria-label={t('release.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('release.title', { name: projectName })}</h2>
          <span className="tasks-head-actions">
            <button type="button" className="drawer-close in-head" onClick={onClose} aria-label={t('release.close')}>
              ×
            </button>
          </span>
        </header>
        <div className="segmented" role="group" aria-label={t('release.tabsLabel')}>
          <button type="button" className="btn-secondary btn-toggle" aria-pressed={pane === 'current'} onClick={() => setPane('current')}>
            {t('release.tabCurrent')}
          </button>
          <button
            type="button"
            className="btn-secondary btn-toggle"
            aria-pressed={pane === 'history'}
            onClick={() => {
              setPane('history');
              loadHistory();
            }}
          >
            {t('release.tabHistory')}
          </button>
        </div>
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        <div className="release-scroll">
          {pane === 'history' ? historyPane() : view === undefined ? <p className="muted">{t('release.loading')}</p> : release ? current(view!) : openForm()}
        </div>
      </div>
    </div>
  );
}
