import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type GithubChoose, type GithubPreview, type GithubTarget } from '../api';
import { useEscape } from '../chat/usageWarning';
import { t } from '../i18n';
import {
  alertTotals,
  batchItems,
  dangerOutCount,
  defaultInclude,
  previewRows,
  retryPicks,
  rowNameOk,
  runBatch,
  togglePick,
  togglePickAll,
  worstLevel,
  type BatchOutcome,
  type BatchRow,
} from './githubBatch';
import { errorText, folderNameOk, formatSize, githubError, hasDanger, repoLabel, shortSha, type GithubErrorKind } from './githubSkill';
import { AlertList, FileList, LEVEL_LABEL, Sha } from './GithubParts';

// Instalar uma skill de um link do GitHub: URL → (marcar, se o link tem várias) → prévia → Instalar. A prévia mostra o
// SKILL.md, todos os arquivos e os alertas ANTES de gravar; o Instalar é um botão à parte e, com alerta de perigo, só vale
// com a ciência marcada. Instalar não ativa a skill (ninguém a usa até marcar na ficha). Mesmo fluxo nos três escopos.
// Com várias marcadas (link com várias skills): a prévia de cada uma num acordeão, a de perigo vem desmarcada e o lote vai
// de uma vez para o servidor, que devolve um resultado por skill. Com uma só marcada, vale o fluxo de uma skill (nome editável).

const SCOPE_LABEL = { library: 'gh.scopeLibrary', user: 'gh.scopeUser', project: 'gh.scopeProject' } as const;

interface PreviewProps {
  preview: GithubPreview;
  scope: GithubTarget['scope'];
  name: string;
  ack: boolean;
  busy: boolean;
  error: GithubErrorKind | null;
  onName: (name: string) => void;
  onAck: (ack: boolean) => void;
  onInstall: () => void;
  onRefresh: () => void;
  onBack: () => void;
  onCancel: () => void;
}

/** A prévia (sem rede, testável por renderização): origem, alertas, SKILL.md, arquivos, nome e o Instalar. */
export function PreviewView({ preview, scope, name, ack, busy, error, onName, onAck, onInstall, onRefresh, onBack, onCancel }: PreviewProps) {
  const danger = hasDanger(preview.alerts);
  const nameOk = folderNameOk(scope, name);
  const { source } = preview;
  return (
    <>
      <section className="gh-source">
        <h3>{t('gh.source')}</h3>
        <p className="mono">{t('gh.sourceLine', { repo: `${source.owner}/${source.repo}`, ref: source.ref, sha: shortSha(source.sha) })}</p>
        <p className="muted small">{t('gh.sourceFolder', { path: source.path || t('gh.sourceRoot') })}</p>
      </section>
      <AlertList alerts={preview.alerts} />
      <section>
        <h3>{t('gh.skillMdTitle')}</h3>
        <pre className="gh-md gh-scroll" tabIndex={0} aria-label={t('gh.skillMdTitle')}>
          {preview.skillMd}
        </pre>
      </section>
      <FileList files={preview.files} totalBytes={preview.totalBytes} />
      <label className="gh-name">
        {t('gh.nameLabel')}
        <input value={name} onChange={(e) => onName(e.target.value)} maxLength={64} required aria-invalid={!nameOk} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      </label>
      {!nameOk && <p className="error small">{t('gh.nameInvalid')}</p>}
      <p className="gh-note" role="note">
        {scope === 'library' ? t('gh.notActiveLibrary', { name }) : t('gh.notActiveFolder')}
      </p>
      {danger && (
        <label className="check gh-ack">
          <input type="checkbox" checked={ack} onChange={(e) => onAck(e.target.checked)} /> {t('gh.ack')}
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gh-actions">
        {error?.kind === 'changed' ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={onRefresh}>
            {t('gh.refresh')}
          </button>
        ) : (
          <button type="button" className="btn-primary" disabled={busy || !nameOk || (danger && !ack)} onClick={onInstall}>
            {busy ? t('gh.installing') : t('gh.installBtn')}
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
          {t('gh.back')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('gh.cancel')}
        </button>
      </div>
    </>
  );
}

interface ChooseProps {
  choose: GithubChoose;
  /** Os caminhos marcados. */
  picks: string[];
  busy: boolean;
  /** Quantas prévias já vieram, quando são várias. */
  progress: { done: number; total: number } | null;
  error: GithubErrorKind | null;
  onToggle: (path: string) => void;
  onToggleAll: () => void;
  onPreview: () => void;
  onBack: () => void;
}

/** O link tinha várias skills: uma caixa por skill (com a descrição), "Selecionar todas" e o botão da prévia das marcadas. */
export function ChooseView({ choose, picks, busy, progress, error, onToggle, onToggleAll, onPreview, onBack }: ChooseProps) {
  const total = choose.skills.length;
  const n = choose.skills.filter((s) => picks.includes(s.path)).length;
  return (
    <>
      <section className="gh-choose">
        <h3>{t('gh.chooseTitle', { n: total })}</h3>
        <p className="muted small">{t('gh.chooseHint')}</p>
        <div className="gh-pickbar">
          <label className="gh-pickall">
            <input
              type="checkbox"
              checked={n === total}
              disabled={busy}
              ref={(el) => {
                if (el) el.indeterminate = n > 0 && n < total;
              }}
              onChange={onToggleAll}
            />
            {t('gh.chooseAll')}
          </label>
          <span className="muted small" aria-live="polite">
            {t('gh.chooseCount', { n, total })}
          </span>
        </div>
        <ul className="plain">
          {choose.skills.map((s) => {
            const on = picks.includes(s.path);
            return (
              <li key={s.path}>
                <label className={`gh-pick${on ? ' is-on' : ''}`}>
                  <input type="checkbox" checked={on} disabled={busy} onChange={() => onToggle(s.path)} />
                  <span className="gh-pick-text">
                    <strong>{s.name}</strong>
                    <span className="mono muted">{s.path}</span>
                    <span className="gh-desc">{s.description || t('gh.chooseNoDesc')}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
      {error && (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gh-actions">
        <button type="button" className="btn-primary" disabled={busy || n === 0} onClick={onPreview}>
          {busy ? (progress ? t('gh.chooseProgress', progress) : t('gh.previewing')) : t('gh.choosePreview', { n })}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
          {t('gh.back')}
        </button>
      </div>
    </>
  );
}

interface BatchItemProps {
  scope: GithubTarget['scope'];
  row: BatchRow;
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}

/** Uma skill do lote: caixa de incluir fora do acordeão (o clique na caixa não abre nem fecha) e, dentro dele, o que a prévia de uma só mostra. */
function BatchItem({ scope, row, on, busy, onToggle }: BatchItemProps) {
  const p = row.preview;
  if (!p) {
    return (
      <li className="gh-item is-error">
        <span aria-hidden="true" />
        <div className="gh-item-body">
          <p>
            <strong>{row.name}</strong> <span className="badge">{t('gh.batchNoPreview')}</span>
          </p>
          <p className="mono muted small">{row.path}</p>
          <p className="error small" role="alert">
            {errorText(row.error)}
          </p>
        </div>
      </li>
    );
  }
  const danger = hasDanger(p.alerts);
  const level = worstLevel(p.alerts);
  const nameBad = !rowNameOk(scope, row);
  return (
    <li className={`gh-item${on ? ' is-on' : ''}`}>
      <label className="gh-item-check">
        <input type="checkbox" checked={on} disabled={busy || nameBad} onChange={onToggle} aria-label={t('gh.batchInclude', { name: p.name })} />
      </label>
      <div className="gh-item-body">
        <details open={danger}>
          <summary>
            <strong>{p.name}</strong>
            {level && <span className={`badge gh-lv is-${level}`}>{t(LEVEL_LABEL[level])}</span>}
            <span className="muted small">{t('gh.batchFiles', { n: p.files.length, size: formatSize(p.totalBytes) })}</span>
          </summary>
          <div className="gh-item-more">
            <p className="mono small">{t('gh.sourceLine', { repo: `${p.source.owner}/${p.source.repo}`, ref: p.source.ref, sha: shortSha(p.source.sha) })}</p>
            <p className="muted small">{t('gh.sourceFolder', { path: p.source.path || t('gh.sourceRoot') })}</p>
            {p.alerts.length > 0 && <AlertList alerts={p.alerts} />}
            <section>
              <h3>{t('gh.skillMdTitle')}</h3>
              <pre className="gh-md gh-scroll" tabIndex={0} aria-label={`${t('gh.skillMdTitle')} · ${p.name}`}>
                {p.skillMd}
              </pre>
            </section>
            <FileList files={p.files} totalBytes={p.totalBytes} />
          </div>
        </details>
        {danger && <p className="gh-item-flag is-danger">{t('gh.batchDangerRow')}</p>}
        {nameBad && <p className="gh-item-flag is-danger">{t('gh.batchNameBad', { name: p.name })}</p>}
      </div>
    </li>
  );
}

interface BatchProps {
  scope: GithubTarget['scope'];
  rows: BatchRow[];
  include: Record<string, boolean>;
  busy: boolean;
  error: GithubErrorKind | null;
  onToggle: (path: string) => void;
  onInstall: () => void;
  onBack: () => void;
  onCancel: () => void;
}

/** A prévia de várias skills (sem rede, testável por renderização): alertas somados no topo, uma linha por skill e "Instalar N". */
export function BatchPreviewView({ scope, rows, include, busy, error, onToggle, onInstall, onBack, onCancel }: BatchProps) {
  const totals = alertTotals(rows);
  const alertCount = totals.danger + totals.warn + totals.info;
  const dangerOut = dangerOutCount(scope, rows, include);
  const source = rows.find((r) => r.preview)?.preview?.source;
  const n = batchItems(scope, rows, include).length;
  return (
    <>
      <section className="gh-source">
        <h3>{t('gh.batchHead', { n: rows.length })}</h3>
        {source && <p className="mono">{t('gh.batchSource', { repo: `${source.owner}/${source.repo}`, ref: source.ref })}</p>}
      </section>
      <section className="gh-alerts" aria-label={t('gh.alertsTitle', { n: alertCount })}>
        <h3>{t('gh.alertsTitle', { n: alertCount })}</h3>
        {alertCount === 0 ? (
          <p className="muted small">{t('gh.noAlerts')}</p>
        ) : (
          <p className="gh-totals">
            {(['danger', 'warn', 'info'] as const)
              .filter((l) => totals[l] > 0)
              .map((l) => (
                <span key={l} className={`badge gh-lv is-${l}`}>
                  {t(LEVEL_LABEL[l])} {totals[l]}
                </span>
              ))}
          </p>
        )}
        {dangerOut > 0 && (
          <p className="gh-warn" role="note">
            {t('gh.batchDangerOff', { n: dangerOut })}
          </p>
        )}
      </section>
      <ul className="plain gh-batch">
        {rows.map((r) => (
          <BatchItem key={r.path} scope={scope} row={r} on={!!include[r.path]} busy={busy} onToggle={() => onToggle(r.path)} />
        ))}
      </ul>
      <p className="gh-note" role="note">
        {scope === 'library' ? t('gh.batchNotActiveLibrary') : t('gh.batchNotActiveFolder')}
      </p>
      {error && (
        <p className="error" role="alert">
          {errorText(error)}
        </p>
      )}
      <div className="gh-actions">
        <button type="button" className="btn-primary" disabled={busy || n === 0} onClick={onInstall}>
          {busy ? t(n === 1 ? 'gh.batchInstallingOne' : 'gh.batchInstallingOther', { n }) : t('gh.batchInstallBtn', { n })}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onBack}>
          {t('gh.back')}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('gh.cancel')}
        </button>
      </div>
    </>
  );
}

/** O fim do lote: uma linha por skill (instalou, com o commit / falhou, com o motivo). A falha de uma não desfaz as outras. */
export function BatchDoneView({ scope, outcomes, onRetry, onClose }: { scope: GithubTarget['scope']; outcomes: BatchOutcome[]; onRetry: () => void; onClose: () => void }) {
  const ok = outcomes.filter((o) => o.ok).length;
  return (
    <>
      <section className="gh-done" role="status">
        <h3>{t('gh.batchDoneTitle', { ok, total: outcomes.length })}</h3>
        <ul className="plain gh-results">
          {outcomes.map((o) => (
            <li key={o.path} className={`gh-result ${o.ok ? 'is-ok' : 'is-fail'}`}>
              <strong>{o.name}</strong>
              <span className="gh-result-state">
                <span aria-hidden="true">{o.ok ? '✓' : '✗'}</span> {o.ok ? t('gh.batchOk') : t('gh.batchFail')}
              </span>
              {o.ok ? <Sha sha={o.sha} /> : <span className="error small">{errorText(o.error)}</span>}
            </li>
          ))}
        </ul>
        {ok > 0 && <p className="gh-note">{scope === 'library' ? t('gh.batchNotActiveLibrary') : t('gh.batchNotActiveFolder')}</p>}
      </section>
      <div className="gh-actions">
        <button type="button" className="btn-primary" autoFocus onClick={onClose}>
          {t('gh.close')}
        </button>
        {ok < outcomes.length && (
          <button type="button" className="btn-secondary" onClick={onRetry}>
            {t('gh.batchRetry')}
          </button>
        )}
      </div>
    </>
  );
}

type Step =
  | { kind: 'url' }
  | { kind: 'choose'; choose: GithubChoose }
  | { kind: 'preview'; preview: GithubPreview; from: 'url' | 'choose'; choose?: GithubChoose }
  | { kind: 'batch'; choose: GithubChoose; rows: BatchRow[] }
  | { kind: 'batch-done'; choose: GithubChoose; outcomes: BatchOutcome[] }
  | { kind: 'done'; name: string; sha: string };

interface Props {
  target: GithubTarget;
  onClose: () => void;
  /** Instalou: quem chamou relê a lista (a skill nova aparece). */
  onInstalled: () => void;
}

export function GithubInstall({ target, onClose, onInstalled }: Props) {
  const [url, setUrl] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'url' });
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GithubErrorKind | null>(null);
  // O que a prévia atual usa para instalar (o link como colado e a pasta escolhida).
  const [picked, setPicked] = useState<string | undefined>(undefined);
  // Várias skills: as marcadas na lista, as incluídas no lote (depois da prévia) e quantas prévias já vieram.
  const [picks, setPicks] = useState<string[]>([]);
  const [include, setInclude] = useState<Record<string, boolean>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  useEscape(!busy, onClose);
  // Cada etapa abre no topo (a lista de skills rolada não pode deixar a prévia começando no meio).
  useEffect(() => {
    // Bloco, não seta: em navegador novo o scrollTo devolve uma promessa e o React não aceita devolução que não seja a limpeza.
    modal.current?.scrollTo(0, 0);
  }, [step.kind]);

  const fail = (e: unknown) => setError(githubError(e));

  const showPreview = async (path: string | undefined, choose?: GithubChoose) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.githubPreview(url.trim(), path);
      if (res.kind === 'choose') {
        setPicks([]);
        setStep({ kind: 'choose', choose: res });
      } else {
        setPicked(path);
        setName(res.name);
        setAck(false);
        setStep({ kind: 'preview', preview: res, from: choose ? 'choose' : 'url', ...(choose && { choose }) });
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // As marcadas, na ordem da lista. Uma só: o fluxo de uma skill. Várias: a prévia de cada uma em sequência (regras em `previewRows`).
  const previewPicked = async (choose: GithubChoose) => {
    const skills = choose.skills.filter((s) => picks.includes(s.path));
    if (skills.length === 1) return showPreview(skills[0]!.path, choose);
    setBusy(true);
    setError(null);
    const rows = await previewRows(skills, (path) => api.githubPreview(url.trim(), path), t('gh.batchNotSkill'), (done, total) => setProgress({ done, total }));
    if (rows) {
      setInclude(defaultInclude(target.scope, rows));
      setStep({ kind: 'batch', choose, rows });
    }
    setBusy(false);
    setProgress(null);
  };

  const installBatch = async (choose: GithubChoose, rows: BatchRow[]) => {
    const items = batchItems(target.scope, rows, include);
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    const run = await runBatch(items, (list) => api.githubInstallBatch(target, url.trim(), list), t('gh.batchMissing'));
    if (run.ok) {
      setStep({ kind: 'batch-done', choose, outcomes: run.outcomes });
      if (run.installed) onInstalled();
    } else {
      setError(run.error);
    }
    setBusy(false);
  };

  const install = async (preview: GithubPreview) => {
    setBusy(true);
    setError(null);
    try {
      const { source } = preview;
      const done = await api.githubInstall(target, { url: url.trim(), path: source.path, ref: source.ref, sha: source.sha, digest: preview.digest, name });
      setStep({ kind: 'done', name: done.name, sha: done.sha });
      onInstalled();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    setError(null);
    if (step.kind === 'preview' && step.from === 'choose' && step.choose) setStep({ kind: 'choose', choose: step.choose });
    else if (step.kind === 'batch') setStep({ kind: 'choose', choose: step.choose });
    else setStep({ kind: 'url' });
  };

  // No body: o vidro do painel lateral (backdrop-filter) prenderia o modal dentro dele. Clique fora só fecha na primeira etapa.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && step.kind === 'url' && !url && !busy && onClose()}>
      <div ref={modal} className="modal gh-modal" role="dialog" aria-modal="true" aria-labelledby="gh-title">
        <button type="button" className="drawer-close" onClick={onClose} aria-label={t('gh.close')}>
          ×
        </button>
        <p className="kicker">{t('gh.kicker', { scope: t(SCOPE_LABEL[target.scope]) })}</p>
        <h2 id="gh-title">{t('gh.title')}</h2>

        {step.kind === 'url' && (
          <form
            className="gh-url"
            onSubmit={(e) => {
              e.preventDefault();
              void showPreview(undefined);
            }}
          >
            <label>
              {t('gh.urlLabel')}
              <input
                type="text"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('gh.urlPlaceholder')}
                maxLength={500}
                required
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-describedby="gh-url-help"
              />
            </label>
            <p id="gh-url-help" className="muted small">
              {t('gh.urlHelp')}
            </p>
            {error && (
              <p className="error" role="alert">
                {errorText(error)}
              </p>
            )}
            <div className="gh-actions">
              <button type="submit" className="btn-primary" disabled={busy || !url.trim()}>
                {busy ? t('gh.previewing') : t('gh.preview')}
              </button>
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t('gh.cancel')}
              </button>
            </div>
          </form>
        )}

        {step.kind === 'choose' && (
          <ChooseView
            choose={step.choose}
            picks={picks}
            busy={busy}
            progress={progress}
            error={error}
            onToggle={(path) => setPicks((p) => togglePick(p, path))}
            onToggleAll={() => setPicks((p) => togglePickAll(step.choose.skills.map((s) => s.path), p))}
            onPreview={() => void previewPicked(step.choose)}
            onBack={back}
          />
        )}

        {step.kind === 'batch' && (
          <BatchPreviewView
            scope={target.scope}
            rows={step.rows}
            include={include}
            busy={busy}
            error={error}
            onToggle={(path) => setInclude((i) => ({ ...i, [path]: !i[path] }))}
            onInstall={() => void installBatch(step.choose, step.rows)}
            onBack={back}
            onCancel={onClose}
          />
        )}

        {step.kind === 'batch-done' && (
          <BatchDoneView
            scope={target.scope}
            outcomes={step.outcomes}
            onRetry={() => {
              setPicks(retryPicks(step.outcomes));
              setError(null);
              setStep({ kind: 'choose', choose: step.choose });
            }}
            onClose={onClose}
          />
        )}

        {step.kind === 'preview' && (
          <PreviewView
            preview={step.preview}
            scope={target.scope}
            name={name}
            ack={ack}
            busy={busy}
            error={error}
            onName={setName}
            onAck={setAck}
            onInstall={() => void install(step.preview)}
            onRefresh={() => void showPreview(picked, step.choose)}
            onBack={back}
            onCancel={onClose}
          />
        )}

        {step.kind === 'done' && (
          <>
            <section className="gh-done" role="status">
              <h3>{t('gh.doneTitle', { name: step.name })}</h3>
              <p>{target.scope === 'library' ? t('gh.doneLibraryText', { sha: shortSha(step.sha), name: step.name }) : t('gh.doneText', { sha: shortSha(step.sha) })}</p>
              {repoLabel(url.trim()) && (
                <p className="muted small">
                  {repoLabel(url.trim())} · <Sha sha={step.sha} />
                </p>
              )}
            </section>
            <div className="gh-actions">
              <button type="button" className="btn-primary" autoFocus onClick={onClose}>
                {t('gh.close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
