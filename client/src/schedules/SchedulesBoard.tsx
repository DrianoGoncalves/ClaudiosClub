import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoutineSchedule, SchedulesResponse, StaffProfile } from '../../../shared/model';
import { dayString } from '../../../shared/recurrence';
import { api } from '../api';
import { pollVisible } from '../usePoll';
import { t } from '../i18n';
import { type CalEntry, calendarEntries, dayAfterMonthChange, monthStart, shiftMonth } from './calendar';
import { RoutineForm, type StaffChoice } from './RoutineForm';
import { type RoutineAsk, RoutineItem } from './RoutineList';
import { type RoutineDraft, ROUTINES_PER_STAFF_MAX, draftChanged, draftFromRoutine, newDraft } from './routineDraft';
import { cancelFormStep, cancelSchedule, enableRoutine, escapeStep, readSchedules, removeRoutine, runRoutineNow, saveDraft, type Settled } from './scheduleFlows';
import { ScheduleCalendar } from './ScheduleCalendar';
import { countdown, type Schedule, scheduleKey, sortRoutines, whenParts } from './scheduleView';

// Agendamentos de um projeto, em tela cheia. À esquerda: as rotinas dos funcionários (criar, editar, ligar, apagar, histórico) e os despertadores
// e "continue" automáticos do limite de uso (abrir a conversa, cancelar). À direita: o calendário do mês com o que vai rodar e o que já rodou.
// Em tela estreita as duas colunas viram duas abas (Lista | Calendário).

/** O texto do despertador é do funcionário: sempre como texto puro (o React escapa; nada de markdown nem HTML). */
function Scheduled({ s, now, who }: { s: Schedule; now: number; who: string }) {
  const wake = s.kind === 'wake';
  const { date, time } = whenParts(s.at, now);
  const at = date ? t('schedules.atDate', { date, time }) : t('schedules.at', { time });
  return (
    <>
      <div className="sched-top">
        <strong className="sched-who">{who}</strong>
        <span className="sched-kind" title={t(wake ? 'schedules.kindWakeHint' : 'schedules.kindContinueHint')}>
          {t(wake ? 'schedules.kindWake' : 'schedules.kindContinue')}
        </span>
      </div>
      <p className="sched-when">
        <time dateTime={s.at}>{at}</time> · <span className="sched-eta">{countdown(s.at, now)}</span>
      </p>
      <p className="sched-text">{wake ? s.text.trim() || t('schedules.noText') : t('schedules.continueText')}</p>
    </>
  );
}

interface ListProps {
  items: Schedule[];
  now: number;
  nameOf: (staffId: string | null) => string;
  /** A linha que pede confirmação para cancelar (pela chave). */
  confirming: string | null;
  /** A linha cujo cancelamento está em andamento. */
  busy: string | null;
  /** Erro do cancelamento, por linha. */
  errors: Record<string, string>;
  onAsk: (key: string | null) => void;
  onCancel: (s: Schedule) => void;
  onOpen: (s: Schedule) => void;
}

export function ScheduleList({ items, now, nameOf, confirming, busy, errors, onAsk, onCancel, onOpen }: ListProps) {
  return (
    <ul className="sched-list">
      {items.map((s) => {
        const key = scheduleKey(s);
        return (
          <li key={key} className="sched-item" data-kind={s.kind}>
            <Scheduled s={s} now={now} who={nameOf(s.staffId)} />
            {errors[key] && <p className="error sched-error">{errors[key]}</p>}
            {confirming === key ? (
              <div className="sched-confirm" role="group" aria-label={t('schedules.confirmAsk')}>
                <p>{t('schedules.confirmAsk')}</p>
                <div className="sched-actions">
                  <button type="button" className="btn-secondary is-danger" disabled={busy === key} onClick={() => onCancel(s)}>
                    {busy === key ? t('schedules.cancelling') : t('schedules.confirmYes')}
                  </button>
                  <button type="button" className="btn-secondary" autoFocus disabled={busy === key} onClick={() => onAsk(null)}>
                    {t('schedules.confirmNo')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="sched-actions">
                <button type="button" className="btn-secondary" onClick={() => onOpen(s)}>
                  {t('schedules.openChat')}
                </button>
                <button type="button" className="btn-secondary is-danger" onClick={() => onAsk(key)}>
                  {t('schedules.cancel')}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  projectId: string;
  projectName: string;
  /** Funcionários com ficha deste projeto (o nome vem do `staffId`). */
  staff: StaffProfile[];
  onClose: () => void;
  /** Abre a conversa do agendamento (`staffId` null = conversa sem ficha). */
  onOpenConversation: (staffId: string | null, sessionId: string) => void;
  /** Volta ao quadro de tarefas do projeto. */
  onOpenTasks?: () => void;
  /** Uma rotina mudou (criada, editada, ligada, desligada ou apagada): quem guarda as fichas relê o quadro. */
  onChanged?: () => void;
}

/** Os dados e a hora de partida da tela: só o teste usa (o render no servidor não roda o efeito que lê do servidor). */
interface Seed {
  data: SchedulesResponse;
  now: number;
}

/** O formulário aberto: o rascunho, como ele abriu (para saber se mudou), o erro e se está perguntando se descarta. */
interface FormState {
  draft: RoutineDraft;
  opened: RoutineDraft;
  error: string | null;
  discarding: boolean;
}

const POLL_MS = 5000;
const rkey = (r: Pick<RoutineSchedule, 'staffId' | 'routineId'>) => `${r.staffId}:${r.routineId}`;
const formOf = (draft: RoutineDraft): FormState => ({ draft, opened: draft, error: null, discarding: false });

/** A tela que o App usa: só leva as props de produção. */
export function SchedulesBoard(props: Props) {
  return <SchedulesBoardCore {...props} />;
}

/** O corpo da tela, com o `seed` que só o teste passa (`tests/support/seededBoard.ts`); o App usa `SchedulesBoard`. */
export function SchedulesBoardCore({ projectId, projectName, staff, onClose, onOpenConversation, onOpenTasks, onChanged, seed }: Props & { seed?: Seed }) {
  const [data, setData] = useState<SchedulesResponse | null>(seed?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => seed?.now ?? Date.now());
  const today = new Date(now);
  const [anchor, setAnchor] = useState(() => monthStart(new Date(seed?.now ?? Date.now())));
  const [selectedDay, setSelectedDay] = useState(() => dayString(new Date(seed?.now ?? Date.now())));
  const [pane, setPane] = useState<'list' | 'calendar'>('list');
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ask, setAsk] = useState<{ rk: string; action: RoutineAsk } | null>(null);
  const [rBusy, setRBusy] = useState<string | null>(null);
  const [rErrors, setRErrors] = useState<Record<string, string>>({});
  const [rResult, setRResult] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);

  /** Relê a lista e a janela do mês; devolve o que veio (ou null se falhou). A resposta de uma janela que já saiu da tela não vale. */
  const load = useCallback(async (): Promise<SchedulesResponse | null> => {
    const mine = ++seq.current;
    const out = await readSchedules(api, projectId, anchor);
    if (mine === seq.current) {
      if (out.ok) setData(out.value);
      setError(out.ok ? null : out.error);
    }
    return out.ok ? out.value : null;
  }, [projectId, anchor]);

  // Os agendamentos disparam e somem sozinhos: relê de tempos em tempos; a contagem desce de segundo em segundo.
  useEffect(() => {
    void load();
    const stopPoll = pollVisible(() => void load(), POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopPoll();
      clearInterval(tick);
    };
  }, [load]);

  // Esc fecha primeiro a confirmação, depois o formulário (se o rascunho mudou, pergunta antes de descartar), depois a tela.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const step = escapeStep({ confirming: !!(confirming || ask), form: form && { dirty: draftChanged(form.draft, form.opened), asking: form.discarding } });
      if (step === 'close-confirm') {
        setConfirming(null);
        setAsk(null);
      } else if (step === 'keep-editing') setForm((f) => f && { ...f, discarding: false });
      else if (step === 'ask-discard') setForm((f) => f && { ...f, discarding: true });
      else if (step === 'close-form') setForm(null);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, confirming, ask, form]);

  // O aviso de sucesso some sozinho (igual ao do canto da tela).
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  const nameOf = (staffId: string | null) => (staffId === null ? t('board.ghostName') : (staff.find((p) => p.id === staffId)?.name ?? staffId));
  const routines = useMemo(() => sortRoutines(data?.routines ?? []), [data]);
  const entries = useMemo(() => (data ? calendarEntries(data) : []), [data]);
  const routineOf = (e: CalEntry) => (e.routineId ? data?.routines.find((r) => r.staffId === e.staffId && r.routineId === e.routineId) : undefined);
  const choices: StaffChoice[] = staff.map((s) => ({ id: s.id, name: s.name, full: routines.filter((r) => r.staffId === s.id).length >= ROUTINES_PER_STAFF_MAX }));
  const firstFree = choices.find((c) => !c.full);

  // ---- despertadores e "continue" ----

  const cancel = async (s: Schedule) => {
    const key = scheduleKey(s);
    setBusy(key);
    setErrors((e) => ({ ...e, [key]: '' }));
    const out = await cancelSchedule(api, projectId, s, load);
    if (out.kind === 'failed') setErrors((prev) => ({ ...prev, [key]: out.error }));
    else {
      setConfirming(null);
      setData((d) => d && { ...d, items: d.items.filter((i) => scheduleKey(i) !== key) });
      setNotice(t(out.kind === 'cancelled' ? 'schedules.cancelled' : 'schedules.gone'));
      void load();
    }
    setBusy(null);
  };

  // ---- rotinas ----

  const openNew = () => {
    if (!firstFree) return;
    setForm(formOf(newDraft(firstFree.id, today)));
    setPane('list');
  };
  const openEdit = (r: RoutineSchedule) => {
    setForm(formOf(draftFromRoutine(r.staffId, { ...r, id: r.routineId }, today)));
    setAsk(null);
    setPane('list');
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setForm({ ...form, error: null, discarding: false });
    const out = await saveDraft(api, projectId, form.draft);
    setSaving(false);
    if (!out.ok) return setForm((f) => f && { ...f, error: out.error });
    setForm(null);
    setNotice(t(out.value.created ? 'schedules.created' : 'schedules.saved'));
    onChanged?.();
    // Leva o calendário ao mês da próxima execução: é onde a rotina aparece.
    if (out.value.next) goTo(new Date(out.value.next));
    void load();
  };

  /** Uma ação sobre uma rotina: trava a linha, mostra o erro nela e relê a lista no fim (a rotina pode ter sumido ou mudado). */
  const act = async <T,>(r: RoutineSchedule, run: () => Promise<Settled<T>>, done: (value: T) => void) => {
    const rk = rkey(r);
    setRBusy(rk);
    setRErrors((e) => ({ ...e, [rk]: '' }));
    setRResult((x) => ({ ...x, [rk]: '' }));
    const out = await run();
    if (out.ok) {
      done(out.value);
      onChanged?.();
    } else setRErrors((prev) => ({ ...prev, [rk]: out.error }));
    setRBusy(null);
    void load();
  };
  const toggle = (r: RoutineSchedule) =>
    act(r, () => enableRoutine(api, projectId, r, !r.enabled), (enabled) => setNotice(t(enabled ? 'schedules.enabled' : 'schedules.disabled', { name: r.name })));
  const remove = (r: RoutineSchedule) =>
    act(r, () => removeRoutine(api, projectId, r), () => {
      setAsk(null);
      setNotice(t('schedules.deleted', { name: r.name }));
    });
  const runNow = (r: RoutineSchedule) =>
    act(r, () => runRoutineNow(api, projectId, r, r.name), (text) => {
      setAsk(null);
      setRResult((x) => ({ ...x, [rkey(r)]: text }));
    });

  // ---- calendário ----

  const goTo = (day: Date) => {
    setAnchor(monthStart(day));
    setSelectedDay(dayString(day));
  };
  const goMonth = (next: Date) => {
    setAnchor(next);
    setSelectedDay(dayAfterMonthChange(next, today));
  };

  return (
    <div className="modal-backdrop sched-backdrop">
      <div className="modal sched-modal" role="dialog" aria-modal="true" aria-label={t('schedules.dialogLabel', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('schedules.title', { name: projectName })}</h2>
          <span className="tasks-head-actions">
            {onOpenTasks && (
              <button type="button" className="btn-secondary" onClick={onOpenTasks}>
                {t('schedules.tasks')}
              </button>
            )}
            <button type="button" className="drawer-close in-head" onClick={onClose} aria-label={t('schedules.close')}>
              ×
            </button>
          </span>
        </header>
        <p className="muted sched-intro">{t('schedules.intro')}</p>
        {error && <p className="error">{t('schedules.loadFailed', { error })}</p>}
        {data?.stateWarning && (
          <p className="sched-warning small" role="status">
            {t('schedules.stateWarning', { text: data.stateWarning })}
          </p>
        )}
        {notice && (
          <p className="muted sched-notice" role="status">
            {notice}
          </p>
        )}
        <div className="segmented sched-tabs" role="group" aria-label={t('schedules.tabsLabel')}>
          <button type="button" className="btn-secondary btn-toggle" aria-pressed={pane === 'list'} onClick={() => setPane('list')}>
            {t('schedules.tabList')}
          </button>
          <button type="button" className="btn-secondary btn-toggle" aria-pressed={pane === 'calendar'} onClick={() => setPane('calendar')}>
            {t('schedules.tabCalendar')}
          </button>
        </div>
        <div className="sched-body" data-pane={pane}>
          <section key={form ? 'form' : 'list'} className="sched-col sched-list-col" aria-label={t('schedules.tabList')}>
            {form ? (
              <>
                <h3 className="sched-col-head">{t(form.draft.id ? 'schedules.editRoutine' : 'schedules.newRoutineTitle')}</h3>
                <RoutineForm
                  draft={form.draft}
                  staff={choices}
                  lockStaff={form.draft.id !== null}
                  busy={saving}
                  error={form.error}
                  now={today}
                  confirmDiscard={form.discarding ? { onDiscard: () => setForm(null), onKeep: () => setForm((f) => f && { ...f, discarding: false }) } : null}
                  onChange={(draft) => setForm((f) => f && { ...f, draft, discarding: false })}
                  onSubmit={() => void save()}
                  onCancel={() => (cancelFormStep(draftChanged(form.draft, form.opened)) === 'ask-discard' ? setForm((f) => f && { ...f, discarding: true }) : setForm(null))}
                />
              </>
            ) : (
              <>
                <div className="sched-col-bar">
                  <h3 className="sched-col-head">{t('schedules.routinesHead', { n: routines.length })}</h3>
                  <button type="button" className="btn-primary" disabled={!firstFree} title={firstFree ? undefined : t(staff.length === 0 ? 'schedules.noStaff' : 'schedules.allFull', { max: ROUTINES_PER_STAFF_MAX })} onClick={openNew}>
                    + {t('schedules.newRoutine')}
                  </button>
                </div>
                {data === null ? (
                  !error && <p className="muted">{t('schedules.loading')}</p>
                ) : (
                  <>
                    {staff.length === 0 && <p className="muted small">{t('schedules.noStaff')}</p>}
                    {routines.length === 0 ? (
                      <div className="sched-empty">
                        <p>{t('schedules.noRoutines')}</p>
                        <p className="muted">{t('schedules.noRoutinesHint')}</p>
                      </div>
                    ) : (
                      <ul className="sched-list">
                        {routines.map((r) => {
                          const rk = rkey(r);
                          return (
                            <RoutineItem
                              key={rk}
                              r={r}
                              now={now}
                              confirming={ask?.rk === rk ? ask.action : null}
                              busy={rBusy === rk}
                              error={rErrors[rk]}
                              result={rResult[rk]}
                              onToggle={(x) => void toggle(x)}
                              onEdit={openEdit}
                              onAsk={(x, action) => setAsk(action ? { rk: rkey(x), action } : null)}
                              onDelete={(x) => void remove(x)}
                              onRun={(x) => void runNow(x)}
                            />
                          );
                        })}
                      </ul>
                    )}
                    {data.items.length > 0 && (
                      <>
                        <h3 className="sched-col-head">{t('schedules.oneOffHead', { n: data.items.length })}</h3>
                        <ScheduleList
                          items={data.items}
                          now={now}
                          nameOf={nameOf}
                          confirming={confirming}
                          busy={busy}
                          errors={errors}
                          onAsk={setConfirming}
                          onCancel={(s) => void cancel(s)}
                          onOpen={(s) => onOpenConversation(s.staffId, s.sessionId)}
                        />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </section>
          <section className="sched-col sched-cal-col" aria-label={t('schedules.cal.label', { name: projectName })}>
            {data?.window.truncated && <p className="sched-warning small">{t('schedules.truncated')}</p>}
            <ScheduleCalendar
              anchor={anchor}
              today={today}
              entries={entries}
              selected={selectedDay}
              nameOf={nameOf}
              titleOf={(e) => (e.kind === 'routine' ? (routineOf(e)?.name ?? e.routineId ?? '') : t(e.kind === 'wake' ? 'schedules.kindWake' : 'schedules.kindContinue'))}
              messageOf={(e) => (e.kind === 'routine' ? (routineOf(e)?.message ?? '') : e.kind === 'wake' ? (e.text ?? '') : '')}
              onPrev={() => goMonth(shiftMonth(anchor, -1))}
              onNext={() => goMonth(shiftMonth(anchor, 1))}
              onToday={() => goTo(today)}
              onSelect={setSelectedDay}
              onEdit={(e) => {
                const r = routineOf(e);
                if (r) openEdit(r);
              }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
