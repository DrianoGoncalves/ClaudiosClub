import { useEffect, useRef, useState } from 'react';
import type { CostReview } from '../../../shared/model';
import { api, ApiError } from '../api';
import { type ApplySummary, findingTitle, fixable, fixChange, formatTokens, groupFindings, summarizeApply, touchesFicha } from '../costReview';
import { effortLabel } from '../format';
import { locale, t } from '../i18n';
import { SearchIcon } from '../icons';
import { modelLabel } from '../staff/HireForm';
import { formatBytes } from './attachmentFiles';

/**
 * O corpo da análise: números principais, achados por severidade (os que têm ajuste automático vêm com caixa de
 * seleção, marcada) e as conversas que mais pesaram. `onApply` devolve o erro (texto) ou `null` se aplicou; nada
 * muda na ficha antes da confirmação aqui mesmo na tela.
 */
export function ReviewBody({ review, name, onApply }: { review: CostReview; name: string; onApply: (ids: string[]) => Promise<string | null> }) {
  const { totals, tasks, memory, ficha } = review;
  const sheet = [ficha.model ? modelLabel(ficha.model) : t('detail.default'), ficha.effort ? effortLabel(ficha.effort) : null, t(ficha.engine === 'codex' ? 'toolbar.codexName' : 'toolbar.claudeName')]
    .filter(Boolean)
    .join(' · ');
  const groups = groupFindings(review.findings);
  const fixes = fixable(review.findings);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(fixes.map((f) => f.id)));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  // O botão some quando a confirmação abre (e volta quando fecha): o foco acompanha para não cair no corpo da página.
  useEffect(() => {
    if (confirming) boxRef.current?.focus();
    else if (wasConfirming.current) applyRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const chosen = fixes.filter((f) => picked.has(f.id));
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const failure = await onApply(chosen.map((f) => f.id));
    setBusy(false);
    if (failure === null) return;
    setError(failure);
    setConfirming(false);
  };

  return (
    <>
      <dl className="stats">
        <div><dt>{t('detail.reviewSessions')}</dt><dd>{totals.sessions}</dd></div>
        <div><dt>{t('detail.reviewCalls')}</dt><dd>{totals.calls.toLocaleString(locale())}</dd></div>
        <div><dt>{t('detail.reviewMaxContext')}</dt><dd>{formatTokens(totals.maxContext)}</dd></div>
        <div><dt>{t('detail.reviewCacheRead')}</dt><dd>{formatTokens(totals.cacheRead)}</dd></div>
        <div><dt>{t('detail.reviewOutput')}</dt><dd>{formatTokens(totals.output)}</dd></div>
        <div><dt>{t('detail.reviewMemory')}</dt><dd>{t('detail.reviewMemoryValue', { size: formatBytes(memory.bytes, locale()), lines: memory.lines })}</dd></div>
        <div className="review-wide"><dt>{t('detail.reviewTasks')}</dt><dd>{t('detail.reviewTasksValue', { total: tasks.total, rework: tasks.rework, reopened: tasks.reopened })}</dd></div>
        <div className="review-wide"><dt>{t('detail.reviewSheet')}</dt><dd>{sheet}</dd></div>
      </dl>
      {groups.length === 0 && <p className="muted">{t('detail.reviewNone')}</p>}
      {groups.map((g) => (
        <section key={g.severity} className="review-group">
          <h4>{t(g.key)}</h4>
          <ul className={`review-findings is-${g.severity}`}>
            {g.items.map((f, i) => {
              const text = (
                <>
                  <strong>{findingTitle(f.id)}</strong>
                  <span className="muted small">{f.evidence}</span>
                  <span className="small">{f.suggestion}</span>
                </>
              );
              return (
                <li key={`${f.id}-${i}`}>
                  {f.fix ? (
                    <label className="review-pick">
                      <input type="checkbox" checked={picked.has(f.id)} disabled={confirming || busy} onChange={() => toggle(f.id)} />
                      <span className="review-pick-text">
                        {text}
                        <span className="review-change small">{fixChange(f.fix, ficha)}</span>
                      </span>
                    </label>
                  ) : (
                    text
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {fixes.length > 0 && (
        <>
          {error && <p className="error small" role="alert">{error}</p>}
          {confirming ? (
            <div ref={boxRef} tabIndex={-1} className="person-note review-confirm" role="group" aria-label={t('detail.reviewConfirmTitle', { name })}>
              <strong>{t('detail.reviewConfirmTitle', { name })}</strong>
              <ul>
                {chosen.map((f) => (
                  <li key={f.id}>
                    <b>{findingTitle(f.id)}</b>
                    <span>{fixChange(f.fix!, ficha)}</span>
                  </li>
                ))}
              </ul>
              {touchesFicha(fixes, picked) && <p className="small">{t('detail.reviewConfirmScope')}</p>}
              <div className="review-actions">
                <button type="button" className="btn-primary" disabled={busy} aria-busy={busy} onClick={() => void confirm()}>
                  {busy ? t('detail.reviewApplying') : t('detail.reviewConfirmYes')}
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('detail.reviewConfirmNo')}
                </button>
              </div>
            </div>
          ) : (
            <div className="review-actions">
              <button ref={applyRef} type="button" className="btn-primary" disabled={picked.size === 0} onClick={() => setConfirming(true)}>
                {t('detail.reviewApply', { n: picked.size })}
              </button>
            </div>
          )}
        </>
      )}
      {review.sessions.length > 0 && (
        <details className="collapse">
          <summary>{t('detail.reviewTopSessions', { n: review.sessions.length })}</summary>
          <ul className="review-sessions">
            {review.sessions.map((s) => (
              <li key={s.id}>
                <span className="review-session-title">{s.title ?? t('detail.reviewUntitled')}</span>
                <span className="muted small">{t('detail.reviewSessionLine', { calls: s.calls.toLocaleString(locale()), context: formatTokens(s.maxContext), cache: formatTokens(s.cacheRead) })}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small">{t('detail.reviewNote')}</p>
    </>
  );
}

/** O que o último "Aplicar" fez: o que mudou (com a tarefa criada, quando houve) e o que ficou de fora, com o motivo. */
export function ApplyResult({ summary, onOpenTask }: { summary: ApplySummary; onOpenTask?: (taskId: string) => void }) {
  return (
    <div className="review-result" role="status">
      {summary.applied.length > 0 && (
        <section className="review-group">
          <h4>{t('detail.reviewAppliedTitle', { n: summary.applied.length })}</h4>
          <ul className="review-findings is-applied">
            {summary.applied.map((a) => (
              <li key={a.id}>
                <strong>{findingTitle(a.id)}</strong>
                <span className="small">
                  {a.change}
                  {a.taskId &&
                    (onOpenTask ? (
                      <button type="button" className="link task-id review-task-link" title={t('detail.reviewOpenTask', { id: a.taskId })} onClick={() => onOpenTask(a.taskId!)}>
                        {a.taskId}
                      </button>
                    ) : (
                      <span className="task-id review-task-link">{a.taskId}</span>
                    ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {summary.skipped.length > 0 && (
        <section className="review-group">
          <h4>{t('detail.reviewSkippedTitle', { n: summary.skipped.length })}</h4>
          <ul className="review-findings is-skipped">
            {summary.skipped.map((s) => (
              <li key={s.id}>
                <strong>{findingTitle(s.id)}</strong>
                <span className="muted small">{s.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Botão "Analisar" de uma linha do ranking + o painel com o resultado logo abaixo dela (a `li` pai é
 * uma grade de duas colunas). Mostra as sugestões; só muda a ficha quando o usuário marca, confirma e aplica
 * (e a análise é refeita). O resultado fica guardado enquanto o período não muda (quem usa troca a `key` com os dias).
 */
export function StaffReview({
  projectId,
  staffId,
  name,
  days,
  onOpenTask,
}: {
  projectId: string;
  staffId: string;
  name: string;
  days: number;
  /** Abre a tarefa criada pelo "Aplicar"; sem isso mostra só o id. */
  onOpenTask?: (projectId: string, taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<CostReview | null>(null);
  // Cada análise nova remonta o corpo (seleção e confirmação voltam ao início).
  const [version, setVersion] = useState(0);
  const [applied, setApplied] = useState<ApplySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // StrictMode (dev) monta, desmonta e monta de novo: o efeito religa a flag.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = () => {
    setLoading(true);
    setError(null);
    api.costReview(projectId, staffId, days).then(
      (r) => {
        if (!alive.current) return;
        setReview(r);
        setVersion((v) => v + 1);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive.current) return;
        setError(e instanceof ApiError ? e.message : t('detail.reviewError'));
        setLoading(false);
      },
    );
  };
  const apply = async (ids: string[]): Promise<string | null> => {
    if (!review) return '';
    try {
      const result = await api.applyCostReview(projectId, staffId, ids, days);
      if (alive.current) {
        setApplied(summarizeApply(result, review.findings));
        run();
      }
      return null;
    } catch (e) {
      // Recusa por pareamento vem sem texto: o aviso do App já explica.
      return e instanceof ApiError ? e.message : t('detail.reviewApplyError');
    }
  };
  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    setApplied(null);
    if (!review && !loading) run();
  };
  const label = t('detail.reviewTitle', { name });
  return (
    <>
      <button type="button" className={`btn-secondary btn-icon ranking-review ${loading ? 'is-loading' : ''}`} aria-expanded={open} aria-busy={loading} aria-label={label} title={label} onClick={toggle}>
        <SearchIcon />
      </button>
      {open && (
        <div className="ranking-review-panel" role="region" aria-label={label}>
          {applied && <ApplyResult summary={applied} onOpenTask={onOpenTask && ((taskId) => onOpenTask(projectId, taskId))} />}
          {loading && <p className="muted small" role="status">{t('detail.reviewLoading')}</p>}
          {error && (
            <div className="review-error">
              <p className="error small" role="alert">{error}</p>
              <button type="button" className="btn-secondary" onClick={run}>{t('detail.reviewRetry')}</button>
            </div>
          )}
          {review && !error && !loading && <ReviewBody key={version} review={review} name={name} onApply={apply} />}
        </div>
      )}
    </>
  );
}
