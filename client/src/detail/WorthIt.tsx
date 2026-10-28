import { useState } from 'react';
import type { OrchestrationReport, RunMark } from '../../../shared/model';
import { api } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';

// "Valeu a pena?": quanto da sessão foi do planejador e quanto dos executores, a economia em
// relação a tudo rodar no modelo do planejador, e o que foi aproveitado de cada entrega.

const MARK_LABEL: Record<RunMark, string> = { used: t('detail.markUsed'), partial: t('detail.markPartial'), discarded: t('detail.markDiscarded') };

const RUNS_SHOWN = 10;
const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const shortModel = (m: string | null) => (m ? m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1') : '—');

export function WorthIt({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<OrchestrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = () =>
    api.orchestration(sessionId).then(
      (r) => (setReport(r), setError(null)),
      (e: Error) => setError(e.message),
    );

  const mark = async (runId: string, value: RunMark) => {
    const current = report?.runs.find((r) => r.id === runId)?.mark;
    await api.markRun(sessionId, runId, current === value ? null : value).catch((e: Error) => setError(e.message));
    await load();
  };

  return (
    <details className="collapse" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && !report && void load()}>
      <summary>{t('detail.worthIt')}</summary>
      {error && <p className="error small">{error}</p>}
      {!report && !error && <p className="muted small">{t('detail.readingTranscripts')}</p>}
      {report && report.runs.length === 0 && (
        <p className="muted small">
          {t('detail.noSubagentsYet', { model: shortModel(report.plannerModel) })}
          {report.scanning && ` ${t('detail.stillReading')}`}
        </p>
      )}
      {report && report.runs.length > 0 && (
        <>
          <div className="worth-bar" role="img" aria-label={t('detail.splitAria', { planner: pct(report.plannerShare), exec: pct(report.executorShare) })}>
            <span className="worth-planner" style={{ width: pct(report.plannerShare, 1) }} />
            <span className="worth-exec" style={{ width: pct(report.executorShare, 1) }} />
          </div>
          <dl className="stats">
            <div>
              <dt>{t('detail.plannerLabel', { model: shortModel(report.plannerModel) })}</dt>
              <dd>{pct(report.plannerShare)}</dd>
            </div>
            <div>
              <dt>{t('detail.executors')}</dt>
              <dd>{pct(report.executorShare)}</dd>
            </div>
            <div>
              <dt>{t('detail.savings')}</dt>
              <dd className={report.savings !== null && report.savings < -0.005 ? 'worth-bad' : ''}>
                {report.savings === null
                  ? '—'
                  : Math.abs(report.savings) < 0.005
                    ? '0%'
                    : report.savings >= 0
                      ? pct(report.savings)
                      : `+${pct(-report.savings)}`}
              </dd>
            </div>
            <div>
              <dt>{t('detail.discardedLabel')}</dt>
              <dd className={report.wasteShare > 0 ? 'worth-bad' : ''}>{pct(report.wasteShare)}</dd>
            </div>
          </dl>
          <p className="muted small">
            {report.savings === null
              ? t('detail.noPriceNote')
              : Math.abs(report.savings) < 0.005
                ? t('detail.sameModelNote')
                : report.savings >= 0
                  ? t('detail.savedVsPlanner', { pct: pct(report.savings), model: shortModel(report.plannerModel) })
                  : t('detail.spentMoreVsPlanner', { pct: pct(-report.savings), model: shortModel(report.plannerModel) })}{' '}
            {t('detail.markHint')}
          </p>
          <ul className="rows worth-runs">
            {(showAll ? report.runs : report.runs.slice(0, RUNS_SHOWN)).map((r) => (
              <li key={r.id} className="row">
                <span className="row-title">
                  {r.description ?? r.agentType}
                  <span className="muted small">
                    {' '}
                    {r.agentType} · {shortModel(r.model)} · {pct(r.share, 1)}
                    {r.extraIfPlanner !== null && r.extraIfPlanner > 0.05 && ` · ${t('detail.extraIfPlanner', { pct: pct(r.extraIfPlanner) })}`}
                    {r.at && ` · ${formatAgo(Date.now() - Date.parse(r.at))}`}
                  </span>
                </span>
                <span className="worth-marks" role="group" aria-label={t('detail.usedAria')}>
                  {(Object.keys(MARK_LABEL) as RunMark[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`chip ${r.mark === m ? `is-on chip-${m}` : ''}`}
                      aria-pressed={r.mark === m}
                      onClick={() => void mark(r.id, m)}
                    >
                      {MARK_LABEL[m]}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="actions">
            {report.runs.length > RUNS_SHOWN && (
              <button type="button" className="btn-secondary" onClick={() => setShowAll(!showAll)}>
                {showAll ? t('detail.showRecent') : t('detail.showAll', { n: report.runs.length })}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => void load()}>
              {t('detail.refresh')}
            </button>
          </p>
        </>
      )}
    </details>
  );
}
