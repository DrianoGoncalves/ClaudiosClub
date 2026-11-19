import type { RoutineHistoryEntry, RoutineSchedule } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';
import { STATE_GLYPH, countdown, describeWhen, stamp, stateLabel } from './scheduleView';

// As rotinas na coluna da esquerda: cada uma com o funcionário, o "quando roda" por extenso, a próxima execução, o resultado da última,
// o histórico curto e as ações. O texto da mensagem e os motivos vêm do funcionário e do servidor: sempre texto puro.

const MODE_KEY = { continue: 'detail.inLastConv', new: 'detail.inNewConv', task: 'detail.inTask' } as const;

/** O que a linha do histórico cobre: um horário, ou o intervalo de um descarte em lote. */
function historyWhen(h: RoutineHistoryEntry): string {
  return h.from && h.from !== h.due ? `${stamp(h.from)} → ${stamp(h.due)}` : stamp(h.due);
}

export function RoutineHistory({ history }: { history: RoutineHistoryEntry[] }) {
  if (history.length === 0) return <p className="muted small">{t('schedules.historyEmpty')}</p>;
  return (
    <ul className="sched-hist">
      {history.map((h, i) => (
        <li key={`${h.at}:${i}`} className={`sched-hist-row st-${h.state}`}>
          <span className="sched-st">
            <span className="sched-glyph" aria-hidden="true">
              {STATE_GLYPH[h.state]}
            </span>
            {stateLabel(h.state)}
          </span>{' '}
          <time dateTime={h.due}>{historyWhen(h)}</time>
          {h.manual && <span className="sched-tag">{t('detail.runNow')}</span>}
          {h.count && h.count > 1 && <span className="sched-tag">{t(h.more ? 'schedules.h.countMore' : 'schedules.h.count', { n: h.count })}</span>}
          {h.lateMin !== undefined && h.lateMin > 0 && <span className="sched-tag">{t('schedules.h.late', { min: h.lateMin })}</span>}
          {h.text && <span className="sched-hist-text">{h.text}</span>}
        </li>
      ))}
    </ul>
  );
}

export type RoutineAsk = 'delete' | 'run';

interface Props {
  r: RoutineSchedule;
  now: number;
  /** A ação que pede confirmação nesta rotina (na própria linha, sem diálogo do navegador). */
  confirming: RoutineAsk | null;
  busy: boolean;
  error?: string;
  /** O resultado do último "Rodar agora" desta rotina. */
  result?: string;
  onToggle: (r: RoutineSchedule) => void;
  onEdit: (r: RoutineSchedule) => void;
  onAsk: (r: RoutineSchedule, action: RoutineAsk | null) => void;
  onDelete: (r: RoutineSchedule) => void;
  onRun: (r: RoutineSchedule) => void;
}

export function RoutineItem({ r, now, confirming, busy, error, result, onToggle, onEdit, onAsk, onDelete, onRun }: Props) {
  const next = r.next;
  return (
    <li className={`sched-item sched-routine${r.enabled ? '' : ' is-off'}`} data-kind="routine">
      <div className="sched-top">
        <strong className="sched-who">{r.name}</strong>
        <button
          type="button"
          className="btn-secondary btn-toggle sched-switch"
          aria-pressed={r.enabled}
          disabled={busy}
          title={t(r.enabled ? 'schedules.switchTitleOn' : 'schedules.switchTitleOff')}
          onClick={() => onToggle(r)}
        >
          {t(r.enabled ? 'schedules.on' : 'schedules.off')}
        </button>
      </div>
      <p className="muted small sched-staff">
        {r.staffName} · {t(MODE_KEY[r.mode])}
      </p>
      <p className="sched-when">{r.invalid ? t('schedules.invalid', { reason: r.invalid }) : describeWhen(r.recurrence)}</p>
      <p className="small sched-next">
        {r.invalid ? null : !r.enabled ? (
          t('schedules.offNote')
        ) : next ? (
          <>
            {t('schedules.next')} <time dateTime={next}>{stamp(next)}</time> · <span className="sched-eta">{countdown(next, now)}</span>
          </>
        ) : (
          t('schedules.nextNone')
        )}
      </p>
      {r.inFlight && <p className="small sched-running">{t('schedules.running', { when: stamp(r.inFlight) })}</p>}
      {r.catchUpHours > 0 && <p className="muted small">{t('schedules.catchUpLine', { hours: r.catchUpHours })}</p>}
      <p className={`small sched-last${r.last && !r.last.ok ? ' is-fail' : ''}`}>
        {r.last
          ? t(r.last.ok ? 'schedules.lastRan' : 'schedules.lastFailed', { ago: formatAgo(now - Date.parse(r.last.at)), text: r.last.text.replace(/^pulada: /, '') })
          : t('schedules.neverRan')}
      </p>
      <p className="sched-text sched-clamp">{r.message}</p>
      <details className="sched-history">
        <summary>{t('schedules.history', { n: r.history.length })}</summary>
        <RoutineHistory history={r.history} />
      </details>
      {error && <p className="error sched-error">{error}</p>}
      {result && (
        <p className="small sched-result" role="status">
          {result}
        </p>
      )}
      {confirming ? (
        <div className="sched-confirm" role="group" aria-label={t(confirming === 'delete' ? 'schedules.confirmDelete' : 'schedules.confirmRun', { name: r.name, staff: r.staffName })}>
          <p>{t(confirming === 'delete' ? 'schedules.confirmDelete' : 'schedules.confirmRun', { name: r.name, staff: r.staffName })}</p>
          <div className="sched-actions">
            <button type="button" className={`btn-secondary${confirming === 'delete' ? ' is-danger' : ''}`} disabled={busy} onClick={() => (confirming === 'delete' ? onDelete(r) : onRun(r))}>
              {busy ? t('schedules.working') : t(confirming === 'delete' ? 'schedules.yesDelete' : 'schedules.yesRun')}
            </button>
            <button type="button" className="btn-secondary" autoFocus disabled={busy} onClick={() => onAsk(r, null)}>
              {t('schedules.back')}
            </button>
          </div>
        </div>
      ) : (
        <div className="sched-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onEdit(r)}>
            {t('detail.edit')}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} title={t('detail.runNowTitle')} onClick={() => onAsk(r, 'run')}>
            {t('detail.runNow')}
          </button>
          <button type="button" className="btn-secondary is-danger" disabled={busy} onClick={() => onAsk(r, 'delete')}>
            {t('detail.deleteRoutine')}
          </button>
        </div>
      )}
    </li>
  );
}
