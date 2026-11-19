import { useEffect, useState } from 'react';
import type { Routine, RoutineRun, StaffProfile } from '../../../shared/model';
import { nextOccurrence, recurrenceOf } from '../../../shared/recurrence';
import { api } from '../api';
import { pollVisible } from '../usePoll';
import { formatAgo } from '../format';
import { t, locale } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { RoutineForm } from '../schedules/RoutineForm';
import { type RoutineDraft, ROUTINES_PER_STAFF_MAX, draftFromRoutine, newDraft, toRoutine } from '../schedules/routineDraft';
import { enableRoutine, removeRoutine, runRoutineNow, saveDraft, type Settled } from '../schedules/scheduleFlows';
import { describeWhen } from '../schedules/scheduleView';

// Rotinas do funcionário: no horário, o Claudio’s Club manda a mensagem para ele, como se você tivesse digitado.
// Só rodam com o Claudio’s Club ligado (npm run daily / autostart), ou, com "rodar com atraso", ao ligar de novo.
// O formulário é o mesmo da tela de Agendamentos (todas as rotinas do projeto, com calendário).

export function Routines({ projectId, staff, onChanged }: { projectId: string; staff: StaffProfile; onChanged?: () => void }) {
  const [list, setList] = useState<Routine[]>(staff.routines ?? []);
  const [runs, setRuns] = useState<Record<string, RoutineRun>>({});
  const [editing, setEditing] = useState<RoutineDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => setList(staff.routines ?? []), [staff.routines]);
  useEffect(() => {
    const read = () => api.routineState().then(setRuns, () => {});
    read();
    return pollVisible(read, 30_000);
  }, []);

  // Cada ação mexe numa rotina só (rotas por rotina, que o servidor aplica sobre a ficha fresca): salvar a lista inteira apagaria o que a tela de
  // Agendamentos ou outra aba mudou desde que esta lista foi lida.
  const act = async <T,>(run: () => Promise<Settled<T>>, done: (value: T) => void) => {
    setBusy(true);
    setError(null);
    const out = await run();
    if (out.ok) {
      done(out.value);
      onChanged?.();
    } else setError(out.error);
    setBusy(false);
    return out.ok;
  };

  const toggle = (r: Routine, enabled: boolean) =>
    act(() => enableRoutine(api, projectId, { staffId: staff.id, routineId: r.id }, enabled), () => setList((l) => l.map((x) => (x.id === r.id ? { ...x, enabled } : x))));

  const remove = (r: Routine) =>
    act(() => removeRoutine(api, projectId, { staffId: staff.id, routineId: r.id }), () => setList((l) => l.filter((x) => x.id !== r.id)));

  const submit = async () => {
    if (!editing) return;
    const saved = await act(() => saveDraft(api, projectId, editing), (done) => {
      const r = toRoutine(done.routine, done.routineId);
      setList((l) => (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : [...l, r]));
    });
    if (saved) setEditing(null);
  };

  const runNow = async (r: Routine) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const out = await runRoutineNow(api, projectId, { staffId: staff.id, routineId: r.id }, r.name);
    if (out.ok) {
      setNotice(out.value);
      api.routineState().then(setRuns, () => {});
    } else setError(out.error);
    setBusy(false);
  };

  return (
    <div className="routines">
      {list.length === 0 && !editing && <p className="muted small">{t('detail.routinesEmpty')}</p>}
      <ul className="routine-list">
        {list.map((r) => {
          const run = runs[`${projectId}:${staff.id}:${r.id}`];
          const rec = recurrenceOf(r);
          let next: Date | null = null;
          let when = '';
          try {
            next = nextOccurrence(rec, new Date(now));
            when = describeWhen(rec);
          } catch {
            // Recorrência que não dá para ler (ficha editada à mão): a rotina não roda; a tela de Agendamentos mostra o motivo.
            next = null;
            when = r.schedule || '—';
          }
          return (
            <li key={r.id} className={r.enabled ? '' : 'is-off'}>
              <div className="routine-head">
                <label className="check" title={r.enabled ? t('detail.routineOn') : t('detail.routineOff')}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy}
                    onChange={(e) => void toggle(r, e.target.checked)}
                  />
                  <b>{r.name}</b>
                </label>
                <span className="muted small">{when}</span>
              </div>
              <p className="routine-message small">{r.message}</p>
              <p className="muted small">
                {r.enabled && next
                  ? t('detail.routineNext', { when: next.toLocaleString(locale(), { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })
                  : t('detail.off')}
                {' · '}
                {r.mode === 'task' ? t('detail.inTask') : r.mode === 'continue' ? t('detail.inLastConv') : t('detail.inNewConv')}
                {!!r.catchUpHours && ` · ${t('schedules.catchUpLine', { hours: r.catchUpHours })}`}
                {run && (
                  <span className={run.ok ? '' : 'routine-fail'}>
                    {' · '}
                    {t('detail.lastRun', {
                      ago: formatAgo(now - Date.parse(run.at)),
                      text: run.ok ? run.text : run.text.replace(/^pulada: /, `${t('detail.skipped')}, `),
                    })}
                  </span>
                )}
              </p>
              <p className="actions">
                <button className="btn-secondary" disabled={busy} onClick={() => void runNow(r)} title={t('detail.runNowTitle')}>
                  {t('detail.runNow')}
                </button>
                <button className="btn-secondary" disabled={busy} onClick={() => setEditing(draftFromRoutine(staff.id, { ...r, recurrence: rec }))}>
                  {t('detail.edit')}
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => void askConfirm(t('detail.deleteRoutineConfirm', { name: r.name })).then((ok) => { if (ok) void remove(r); })}
                >
                  {t('detail.deleteRoutine')}
                </button>
              </p>
            </li>
          );
        })}
      </ul>

      {editing ? (
        <RoutineForm draft={editing} busy={busy} error={error} onChange={setEditing} onSubmit={() => void submit()} onCancel={() => setEditing(null)} />
      ) : (
        list.length < ROUTINES_PER_STAFF_MAX && (
          <p className="actions">
            <button className="btn-secondary" onClick={() => setEditing(newDraft(staff.id))}>
              {t('detail.newRoutine')}
            </button>
          </p>
        )
      )}

      {notice && <p className="small">{notice}</p>}
      {error && !editing && <p className="error small">{error}</p>}
      <p className="muted small">{t('detail.routinesNote')}</p>
    </div>
  );
}
