import { useEffect, useState } from 'react';
import { cronError, describeCron, nextRun, parseCron } from '../../../shared/cron';
import type { Routine, RoutineRun, StaffProfile } from '../../../shared/model';
import { api } from '../api';
import { formatAgo } from '../format';

// Rotinas do funcionário: no horário, o MyCo manda a mensagem para ele, como se você tivesse digitado.
// Só rodam com o MyCo ligado (npm run daily / autostart).

type When = 'daily' | 'weekdays' | 'weekly' | 'every' | 'custom';

interface Draft {
  id: string;
  name: string;
  when: When;
  time: string;
  weekday: string;
  minutes: string;
  cron: string;
  message: string;
  mode: Routine['mode'];
  enabled: boolean;
}

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

const newId = () => `r-${Math.random().toString(36).slice(2, 8)}`;

function toCron(d: Draft): string {
  const [h, m] = d.time.split(':').map((n) => String(Number(n)));
  if (d.when === 'daily') return `${m} ${h} * * *`;
  if (d.when === 'weekdays') return `${m} ${h} * * 1-5`;
  if (d.when === 'weekly') return `${m} ${h} * * ${d.weekday}`;
  if (d.when === 'every') return `*/${Number(d.minutes) || 60} * * * *`;
  return d.cron.trim();
}

/** Reconhece as formas que o formulário gera; o resto abre como "personalizado". */
function fromRoutine(r: Routine | null): Draft {
  const base: Draft = {
    id: r?.id ?? newId(),
    name: r?.name ?? '',
    when: 'weekdays',
    time: '08:00',
    weekday: '1',
    minutes: '60',
    cron: r?.schedule ?? '',
    message: r?.message ?? '',
    mode: r?.mode ?? 'continue',
    enabled: r?.enabled ?? true,
  };
  if (!r) return base;
  const p = r.schedule.trim().split(/\s+/);
  const time = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  if (p.length === 5 && /^\d+$/.test(p[0]!) && /^\d+$/.test(p[1]!) && p[2] === '*' && p[3] === '*') {
    if (p[4] === '*') return { ...base, when: 'daily', time: time(p[1]!, p[0]!) };
    if (p[4] === '1-5') return { ...base, when: 'weekdays', time: time(p[1]!, p[0]!) };
    if (/^[0-7]$/.test(p[4]!)) return { ...base, when: 'weekly', time: time(p[1]!, p[0]!), weekday: String(Number(p[4]) % 7) };
  }
  if (p.length === 5 && /^\*\/\d+$/.test(p[0]!) && p.slice(1).every((x) => x === '*')) return { ...base, when: 'every', minutes: p[0]!.slice(2) };
  return { ...base, when: 'custom' };
}

export function Routines({ projectId, staff, onChanged }: { projectId: string; staff: StaffProfile; onChanged?: () => void }) {
  const [list, setList] = useState<Routine[]>(staff.routines ?? []);
  const [runs, setRuns] = useState<Record<string, RoutineRun>>({});
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => setList(staff.routines ?? []), [staff.routines]);
  useEffect(() => {
    const read = () => api.routineState().then(setRuns, () => {});
    read();
    const t = setInterval(read, 30_000);
    return () => clearInterval(t);
  }, []);

  const save = async (next: Routine[]) => {
    setBusy(true);
    setError(null);
    try {
      const profile = await api.saveRoutines(projectId, staff.id, next);
      setList(profile.routines ?? []);
      onChanged?.();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!editing) return;
    const schedule = toCron(editing);
    const err = cronError(schedule);
    if (err) return setError(`Horário: ${err}`);
    const r: Routine = { id: editing.id, name: editing.name.trim(), schedule, message: editing.message.trim(), mode: editing.mode, enabled: editing.enabled };
    const exists = list.some((x) => x.id === r.id);
    if (await save(exists ? list.map((x) => (x.id === r.id ? r : x)) : [...list, r])) setEditing(null);
  };

  const runNow = async (r: Routine) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const out = await api.runRoutine(projectId, staff.id, r.id);
      setNotice(out ? `"${r.name}": ${out.ok ? out.text : `não rodou (${out.text.replace(/^pulada: /, '')})`}` : 'Rotina não encontrada.');
      api.routineState().then(setRuns, () => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="routines">
      {list.length === 0 && !editing && (
        <p className="muted small">Nenhuma rotina. Ex.: "dias úteis às 19:00 — revise os PRs abertos e me diga o que precisa de mim".</p>
      )}
      <ul className="routine-list">
        {list.map((r) => {
          const run = runs[`${projectId}:${staff.id}:${r.id}`];
          let next: Date | null = null;
          try {
            next = nextRun(parseCron(r.schedule), new Date(now));
          } catch {
            next = null;
          }
          return (
            <li key={r.id} className={r.enabled ? '' : 'is-off'}>
              <div className="routine-head">
                <label className="check" title={r.enabled ? 'Ligada: roda no horário' : 'Desligada: não roda'}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    disabled={busy}
                    onChange={(e) => void save(list.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))}
                  />
                  <b>{r.name}</b>
                </label>
                <span className="muted small">{describeCron(r.schedule)}</span>
              </div>
              <p className="routine-message small">{r.message}</p>
              <p className="muted small">
                {r.enabled && next ? `próxima: ${next.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'desligada'}
                {' · '}
                {r.mode === 'continue' ? 'na última conversa' : 'numa conversa nova'}
                {run && (
                  <span className={run.ok ? '' : 'routine-fail'}>
                    {' · '}última: {formatAgo(now - Date.parse(run.at))} ({run.ok ? run.text : run.text.replace(/^pulada: /, 'pulada, ')})
                  </span>
                )}
              </p>
              <p className="actions">
                <button className="btn-secondary" disabled={busy} onClick={() => void runNow(r)} title="Manda a mensagem agora, sem esperar o horário">
                  Rodar agora
                </button>
                <button className="btn-secondary" disabled={busy} onClick={() => setEditing(fromRoutine(r))}>
                  Editar
                </button>
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => window.confirm(`Apagar a rotina "${r.name}"?`) && void save(list.filter((x) => x.id !== r.id))}
                >
                  Apagar
                </button>
              </p>
            </li>
          );
        })}
      </ul>

      {editing ? (
        <form
          className="routine-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Nome
            <input value={editing.name} maxLength={60} placeholder="Revisar PRs" onChange={(e) => setEditing({ ...editing, name: e.target.value })} required />
          </label>
          <div className="routine-when">
            <label>
              Quando
              <select value={editing.when} onChange={(e) => setEditing({ ...editing, when: e.target.value as When })}>
                <option value="daily">todo dia</option>
                <option value="weekdays">dias úteis (seg a sex)</option>
                <option value="weekly">uma vez por semana</option>
                <option value="every">a cada N minutos</option>
                <option value="custom">personalizado (cron)</option>
              </select>
            </label>
            {editing.when === 'weekly' && (
              <label>
                Dia
                <select value={editing.weekday} onChange={(e) => setEditing({ ...editing, weekday: e.target.value })}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={String(i)}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(editing.when === 'daily' || editing.when === 'weekdays' || editing.when === 'weekly') && (
              <label>
                Hora
                <input type="time" value={editing.time} onChange={(e) => setEditing({ ...editing, time: e.target.value })} required />
              </label>
            )}
            {editing.when === 'every' && (
              <label>
                Minutos
                <input type="number" min={5} max={720} value={editing.minutes} onChange={(e) => setEditing({ ...editing, minutes: e.target.value })} />
              </label>
            )}
            {editing.when === 'custom' && (
              <label title="minuto hora dia-do-mês mês dia-da-semana">
                Cron
                <input className="mono" value={editing.cron} placeholder="0 8 * * 1-5" onChange={(e) => setEditing({ ...editing, cron: e.target.value })} />
              </label>
            )}
          </div>
          <p className="muted small">
            {(() => {
              const s = toCron(editing);
              const err = cronError(s);
              return err ? `Horário: ${err}` : `Roda ${describeCron(s)} (horário deste computador).`;
            })()}
          </p>
          <label>
            Mensagem
            <textarea
              rows={3}
              value={editing.message}
              maxLength={4000}
              placeholder="Revise os PRs abertos e me diga o que precisa de mim."
              onChange={(e) => setEditing({ ...editing, message: e.target.value })}
              required
            />
          </label>
          <label>
            Onde
            <select value={editing.mode} onChange={(e) => setEditing({ ...editing, mode: e.target.value as Routine['mode'] })}>
              <option value="continue">na última conversa (ele lembra do contexto)</option>
              <option value="new">numa conversa nova (começa do zero, só com a ficha e a memória)</option>
            </select>
          </label>
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              Salvar rotina
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
              Cancelar
            </button>
          </p>
        </form>
      ) : (
        list.length < 10 && (
          <p className="actions">
            <button className="btn-secondary" onClick={() => setEditing(fromRoutine(null))}>
              Nova rotina
            </button>
          </p>
        )
      )}

      {notice && <p className="small">{notice}</p>}
      {error && <p className="error small">{error}</p>}
      <p className="muted small">
        As travas valem: consumo, orçamento do projeto e a autonomia da ficha (pedidos de permissão esperam você na caixa "precisa de mim"). Só roda com
        o MyCo ligado.
      </p>
    </div>
  );
}
