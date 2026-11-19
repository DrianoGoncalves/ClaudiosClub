import { dayString } from '../../../shared/recurrence';
import { clockHM } from '../chat/wakeCountdown';
import { locale, t } from '../i18n';
import { type CalEntry, dayTitle, groupByDay, monthGrid, monthTitle, weekdayNames } from './calendar';
import { STATE_GLYPH, type RunState, stateLabel } from './scheduleView';

// O calendário do mês (sem biblioteca) e, embaixo, o que roda no dia escolhido. As execuções vêm do servidor (`occurrences`) e dos
// despertadores pendentes; o estado aparece como símbolo + texto + cor (a cor sozinha não basta).

const STATES: readonly RunState[] = ['upcoming', 'ran', 'failed', 'discarded', 'uncertain', 'unknown'];
const STATE_HINT = {
  upcoming: 'schedules.hint.upcoming',
  ran: 'schedules.hint.ran',
  failed: 'schedules.hint.failed',
  discarded: 'schedules.hint.discarded',
  uncertain: 'schedules.hint.uncertain',
  unknown: 'schedules.hint.unknown',
} as const satisfies Record<RunState, string>;

interface Props {
  /** O primeiro dia do mês mostrado. */
  anchor: Date;
  today: Date;
  entries: readonly CalEntry[];
  /** O dia escolhido ('YYYY-MM-DD'). */
  selected: string;
  /** Nome de quem executa (funcionário, ou "Freela" sem ficha). */
  nameOf: (staffId: string | null) => string;
  /** O nome da rotina da execução (ou o tipo, no despertador). */
  titleOf: (e: CalEntry) => string;
  /** A mensagem da rotina da execução. */
  messageOf: (e: CalEntry) => string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  onSelect: (day: string) => void;
  /** Abre a rotina da execução no formulário. */
  onEdit: (e: CalEntry) => void;
}

const time = (at: string) => clockHM(Date.parse(at));

export function ScheduleCalendar({ anchor, today, entries, selected, nameOf, titleOf, messageOf, onPrev, onNext, onToday, onSelect, onEdit }: Props) {
  const loc = locale();
  const { days } = monthGrid(anchor);
  const by = groupByDay(entries);
  const todayKey = dayString(today);
  const names = weekdayNames(loc);
  const longNames = weekdayNames(loc, 'long');
  const weeks = Array.from({ length: days.length / 7 }, (_, w) => days.slice(w * 7, w * 7 + 7));
  const picked = by.get(selected) ?? [];
  const [sy, sm, sd] = selected.split('-').map(Number) as [number, number, number];

  return (
    <div className="sched-cal">
      <div className="sched-cal-nav">
        <button type="button" className="btn-secondary btn-icon" onClick={onPrev} aria-label={t('schedules.cal.prev')} title={t('schedules.cal.prev')}>
          ‹
        </button>
        <h3 className="sched-cal-title" aria-live="polite">
          {monthTitle(anchor, loc)}
        </h3>
        <button type="button" className="btn-secondary btn-icon" onClick={onNext} aria-label={t('schedules.cal.next')} title={t('schedules.cal.next')}>
          ›
        </button>
        <button type="button" className="btn-secondary" onClick={onToday}>
          {t('schedules.cal.today')}
        </button>
      </div>
      <table className="sched-cal-table">
        <thead>
          <tr>
            {names.map((n, i) => (
              <th key={n} scope="col" abbr={longNames[i]}>
                {n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={dayString(week[0]!)}>
              {week.map((d) => {
                const key = dayString(d);
                const es = by.get(key) ?? [];
                const label = dayTitle(d, loc);
                return (
                  <td key={key}>
                    <button
                      type="button"
                      className={`sched-day${d.getMonth() !== anchor.getMonth() ? ' is-out' : ''}${key === todayKey ? ' is-today' : ''}`}
                      aria-pressed={key === selected}
                      aria-label={es.length === 0 ? t('schedules.cal.dayNone', { day: label }) : es.length === 1 ? t('schedules.cal.dayOne', { day: label }) : t('schedules.cal.dayMany', { day: label, n: es.length })}
                      onClick={() => onSelect(key)}
                    >
                      <span className="sched-num">{d.getDate()}</span>
                      {es.length > 0 && (
                        <>
                          <span className="sched-dots" aria-hidden="true">
                            {es.slice(0, 3).map((e) => (
                              <span key={e.key} className={`sched-dot st-${e.state}`}>
                                {STATE_GLYPH[e.state]}
                              </span>
                            ))}
                            {es.length > 3 && <span className="sched-more">+{es.length - 3}</span>}
                          </span>
                          <span className="sched-lines" aria-hidden="true">
                            {es.slice(0, 2).map((e) => (
                              <span key={e.key} className={`sched-line st-${e.state}`}>
                                <span className="sched-glyph">{STATE_GLYPH[e.state]}</span> {time(e.at)} {titleOf(e)}
                              </span>
                            ))}
                            {es.length > 2 && <span className="sched-more">+{es.length - 2}</span>}
                          </span>
                        </>
                      )}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="sched-legend" aria-label={t('schedules.cal.legend')}>
        {STATES.map((s) => (
          <li key={s} className={`st-${s}`} title={t(STATE_HINT[s])}>
            <span className="sched-glyph" aria-hidden="true">
              {STATE_GLYPH[s]}
            </span>{' '}
            {stateLabel(s)}
          </li>
        ))}
      </ul>
      <section className="sched-dayview" aria-label={dayTitle(new Date(sy, sm - 1, sd), loc)}>
        <h3>{dayTitle(new Date(sy, sm - 1, sd), loc)}</h3>
        {picked.length === 0 ? (
          <p className="muted">{t('schedules.cal.empty')}</p>
        ) : (
          <ul className="sched-occ-list">
            {picked.map((e) => (
              <li key={e.key} className={`sched-occ st-${e.state}`}>
                <div className="sched-occ-top">
                  <time dateTime={e.at} className="sched-occ-time">
                    {time(e.at)}
                  </time>
                  <strong>{titleOf(e)}</strong>
                  <span className="muted small">{nameOf(e.staffId)}</span>
                </div>
                <p className="small sched-occ-state">
                  <span className="sched-st">
                    <span className="sched-glyph" aria-hidden="true">
                      {STATE_GLYPH[e.state]}
                    </span>
                    {stateLabel(e.state)}
                  </span>
                  <span className="muted"> · {t(STATE_HINT[e.state])}</span>
                </p>
                {messageOf(e) && <p className="sched-text sched-clamp">{messageOf(e)}</p>}
                {e.kind === 'routine' && (
                  <div className="sched-actions">
                    <button type="button" className="btn-secondary" onClick={() => onEdit(e)}>
                      {t('detail.edit')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
