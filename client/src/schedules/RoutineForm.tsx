import { useId } from 'react';
import { CATCH_UP_MAX_HOURS } from '../../../shared/model';
import { INTERVAL_MAX, normalizeRecurrence } from '../../../shared/recurrence';
import { locale, t } from '../i18n';
import { weekdayNames } from './calendar';
import { HOUR_STEPS, MINUTE_STEPS, oddStep } from './cronSteps';
import { type Freq, FREQS, type RoutineDraft, type Unit, UNITS, buildRecurrence, isCalendarFreq, previewRuns } from './routineDraft';
import { describeWhen, stamp } from './scheduleView';

// O formulário de rotina da tela de agendamentos e da ficha do funcionário: nome, mensagem, onde roda, repetição (única, diária, semanal,
// quinzenal, mensal, a cada N dias/semanas/meses, a cada N minutos, a cada N horas ou cron avançado), início, fim, hora e "rodar com atraso".
// Controlado: quem usa guarda o rascunho.

export interface StaffChoice {
  id: string;
  name: string;
  /** Já tem o máximo de rotinas: não dá para pôr mais uma nele. */
  full: boolean;
}

interface Props {
  draft: RoutineDraft;
  /** Quem pode receber a rotina; sem a lista (ficha de um funcionário) o campo não aparece. */
  staff?: StaffChoice[];
  /** Rotina que já existe: o funcionário não troca (para mudar, apague e crie de novo). */
  lockStaff?: boolean;
  busy: boolean;
  error: string | null;
  now?: Date;
  /** Pergunta, no pé do formulário, se descarta o que foi mudado (o Esc com o rascunho alterado). */
  confirmDiscard?: { onDiscard: () => void; onKeep: () => void } | null;
  onChange: (draft: RoutineDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

const FREQ_KEY = {
  once: 'schedules.f.freqOnce',
  daily: 'schedules.f.freqDaily',
  weekly: 'schedules.f.freqWeekly',
  biweekly: 'schedules.f.freqBiweekly',
  monthly: 'schedules.f.freqMonthly',
  every: 'schedules.f.freqEvery',
  minutes: 'schedules.f.freqMinutes',
  hours: 'schedules.f.freqHours',
  cron: 'schedules.f.freqCron',
} as const satisfies Record<Freq, string>;
const UNIT_KEY = { daily: 'schedules.f.unitDays', weekly: 'schedules.f.unitWeeks', monthly: 'schedules.f.unitMonths' } as const satisfies Record<Unit, string>;

export function RoutineForm({ draft, staff, lockStaff = false, busy, error, now = new Date(), confirmDiscard = null, onChange, onSubmit, onCancel }: Props) {
  const daysId = useId();
  const set = (patch: Partial<RoutineDraft>) => onChange({ ...draft, ...patch });
  const calendar = isCalendarFreq(draft.freq);
  const odd = draft.freq === 'cron' ? oddStep(draft.cron) : null;
  const weekly = draft.freq === 'weekly' || draft.freq === 'biweekly' || (draft.freq === 'every' && draft.unit === 'weekly');
  const monthly = draft.freq === 'monthly' || (draft.freq === 'every' && draft.unit === 'monthly');
  const names = weekdayNames(locale());
  const toggleDay = (d: number) => set({ weekdays: draft.weekdays.includes(d) ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d].sort((a, b) => a - b) });

  const rec = normalizeRecurrence(buildRecurrence(draft));
  const runs = rec.ok ? previewRuns(draft, now) : [];

  return (
    <form
      className="routine-form sched-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {staff && (
        <label>
          {t('schedules.f.staff')}
          <select value={draft.staffId} disabled={lockStaff || busy} onChange={(e) => set({ staffId: e.target.value })}>
            {staff.map((s) => (
              <option key={s.id} value={s.id} disabled={s.full && s.id !== draft.staffId}>
                {s.full && s.id !== draft.staffId ? t('schedules.f.staffFull', { name: s.name }) : s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('detail.name')}
        <input value={draft.name} maxLength={60} placeholder={t('detail.namePlaceholder')} onChange={(e) => set({ name: e.target.value })} required />
      </label>
      <label>
        {t('detail.message')}
        <textarea rows={3} value={draft.message} maxLength={4000} placeholder={t('detail.messagePlaceholder')} onChange={(e) => set({ message: e.target.value })} required />
      </label>
      <label>
        {t('detail.where')}
        <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as RoutineDraft['mode'] })}>
          <option value="continue">{t('detail.modeContinue')}</option>
          <option value="new">{t('detail.modeNew')}</option>
          <option value="task">{t('detail.modeTask')}</option>
        </select>
      </label>
      {draft.mode === 'task' && <p className="muted small">{t('detail.modeTaskHint')}</p>}

      <fieldset className="sched-when-box">
        <legend>{t('schedules.f.when')}</legend>
        <label>
          {t('schedules.f.repeat')}
          <select value={draft.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
            {FREQS.map((f) => (
              <option key={f} value={f}>
                {t(FREQ_KEY[f])}
              </option>
            ))}
          </select>
        </label>
        {draft.freq === 'every' && (
          <div className="sched-every">
            <label>
              {t('schedules.f.every')}
              <input type="number" inputMode="numeric" min={1} max={INTERVAL_MAX[draft.unit]} value={draft.interval} onChange={(e) => set({ interval: e.target.value })} required />
            </label>
            <label>
              {t('schedules.f.unit')}
              <select value={draft.unit} onChange={(e) => set({ unit: e.target.value as Unit })}>
                {UNITS.map((u) => (
                  <option key={u} value={u}>
                    {t(UNIT_KEY[u])}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {draft.freq === 'minutes' && (
          <>
            <label>
              {t('schedules.f.every')}
              <select value={draft.minutes} onChange={(e) => set({ minutes: e.target.value })}>
                {MINUTE_STEPS.map((n) => (
                  <option key={n} value={String(n)}>
                    {t('schedules.f.minutesN', { n })}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">{t('schedules.f.minutesHint')}</p>
          </>
        )}
        {draft.freq === 'hours' && (
          <>
            <label>
              {t('schedules.f.every')}
              <select value={draft.hours} onChange={(e) => set({ hours: e.target.value })}>
                {HOUR_STEPS.map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? t('schedules.f.hoursOne') : t('schedules.f.hoursN', { n })}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small">{t('schedules.f.hoursHint')}</p>
          </>
        )}
        {weekly && (
          <div className="sched-days-box">
            <span id={daysId} className="sched-label">
              {t('schedules.f.weekdays')}
            </span>
            <div className="sched-days" role="group" aria-labelledby={daysId}>
              {names.map((name, d) => (
                <button key={d} type="button" className="btn-secondary btn-toggle" aria-pressed={draft.weekdays.includes(d)} onClick={() => toggleDay(d)}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
        {monthly && (
          <label>
            {t('schedules.f.monthDay')}
            <input type="number" inputMode="numeric" min={1} max={31} value={draft.monthDay} onChange={(e) => set({ monthDay: e.target.value })} required />
          </label>
        )}
        {calendar && (
          <div className="sched-dates">
            <label>
              {draft.freq === 'once' ? t('schedules.f.date') : t('schedules.f.start')}
              <input type="date" value={draft.start} onChange={(e) => set({ start: e.target.value })} required />
            </label>
            <label>
              {t('detail.time')}
              <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} required />
            </label>
            {draft.freq !== 'once' && (
              <label>
                {t('schedules.f.until')}
                <input type="date" value={draft.until} min={draft.start} onChange={(e) => set({ until: e.target.value })} />
              </label>
            )}
          </div>
        )}
        {draft.freq === 'cron' && (
          <>
            <label>
              {t('schedules.f.cron')}
              <input className="mono" value={draft.cron} maxLength={100} placeholder="0 8 * * 1-5" spellCheck={false} autoCapitalize="off" onChange={(e) => set({ cron: e.target.value })} required />
            </label>
            <p className="muted small">{t('schedules.f.cronHint')}</p>
            {odd && (
              <p className="sched-warning small" role="status">
                {t(odd.unit === 'minutes' ? 'schedules.f.oddMinutes' : 'schedules.f.oddHours', { n: odd.n })}
              </p>
            )}
          </>
        )}
        <p className="sched-preview small" role="status">
          {rec.ok ? t('detail.runsWhen', { when: describeWhen(rec.value) }) : t('schedules.f.incomplete')}
          {rec.ok && (
            <span className="muted">
              {' '}
              {runs.length ? t('schedules.f.nextRuns', { list: runs.map((r) => stamp(r.toISOString())).join(' · ') }) : t('schedules.f.noRuns')}
            </span>
          )}
        </p>
      </fieldset>

      <fieldset className="sched-catchup">
        <legend>{t('schedules.f.catchUp')}</legend>
        <label className="check">
          <input type="checkbox" checked={draft.catchUp} onChange={(e) => set({ catchUp: e.target.checked })} />
          {t('schedules.f.catchUpOn')}
        </label>
        {draft.catchUp && (
          <label>
            {t('schedules.f.catchUpHours')}
            <input type="number" inputMode="numeric" min={1} max={CATCH_UP_MAX_HOURS} value={draft.catchUpHours} onChange={(e) => set({ catchUpHours: e.target.value })} required />
          </label>
        )}
        <p className="muted small">{draft.catchUp ? t('schedules.f.catchUpExplain', { hours: Number(draft.catchUpHours) || 0 }) : t('schedules.f.catchUpOff')}</p>
      </fieldset>

      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        {t('schedules.f.enabled')}
      </label>
      <div className="sched-form-foot">
        {error && (
          <p className="error small" role="alert">
            {error}
          </p>
        )}
        {confirmDiscard ? (
          <div className="sched-confirm" role="group" aria-label={t('schedules.f.discardAsk')}>
            <p>{t('schedules.f.discardAsk')}</p>
            <div className="sched-actions">
              <button type="button" className="btn-secondary is-danger" onClick={confirmDiscard.onDiscard}>
                {t('schedules.f.discardYes')}
              </button>
              <button type="button" className="btn-secondary" autoFocus onClick={confirmDiscard.onKeep}>
                {t('schedules.f.discardNo')}
              </button>
            </div>
          </div>
        ) : (
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {t('detail.saveRoutine')}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
              {t('detail.cancel')}
            </button>
          </p>
        )}
      </div>
    </form>
  );
}
