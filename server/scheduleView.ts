import { SCHEDULE_WINDOW_MAX_DAYS, type Routine, type RoutineHistoryEntry, type RoutineOccurrence, type RoutineRun, type RoutineSchedule, type StaffProfile } from '../shared/model';
import { describeRecurrence, nextOccurrence, occurrencesIn, recurrenceError, recurrenceOf } from '../shared/recurrence';
import { routineKey } from './routines';

// O que a tela central de agendamentos lê (GET /api/projects/:pid/schedules): as rotinas do projeto com próxima ocorrência, estado e histórico,
// e as ocorrências de uma janela para o calendário. Só monta a resposta; quem decide o que roda é server/routines.ts.

const DAY_MS = 86_400_000;
/** Padrão sem `from`/`to`: do começo de hoje até tantos dias depois. */
const DEFAULT_WINDOW_DAYS = 31;
const PER_ROUTINE_MAX = 500;
const TOTAL_MAX = 5000;

export class ScheduleWindowError extends Error {}

/** A janela [from, to) do pedido (ISO na query). Sem as duas, do começo de hoje a 31 dias; só uma, a outra sai 31 dias dela. Erro de formato ou passando de 62 dias: `ScheduleWindowError`. */
export function scheduleWindow(fromRaw: string | null, toRaw: string | null, now: Date): { from: Date; to: Date } {
  const parse = (raw: string, name: string) => {
    const ms = /^\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
    if (!Number.isFinite(ms)) throw new ScheduleWindowError(`${name}: use uma data em ISO (2026-11-18T00:00:00-03:00)`);
    return new Date(ms);
  };
  const span = DEFAULT_WINDOW_DAYS * DAY_MS;
  let from: Date;
  let to: Date;
  if (fromRaw && toRaw) {
    from = parse(fromRaw, 'from');
    to = parse(toRaw, 'to');
  } else if (fromRaw) {
    from = parse(fromRaw, 'from');
    to = new Date(from.getTime() + span);
  } else if (toRaw) {
    to = parse(toRaw, 'to');
    from = new Date(to.getTime() - span);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    to = new Date(from.getTime() + span);
  }
  if (to.getTime() <= from.getTime()) throw new ScheduleWindowError('to tem que ser depois de from');
  if (to.getTime() - from.getTime() > SCHEDULE_WINDOW_MAX_DAYS * DAY_MS) throw new ScheduleWindowError(`a janela passa de ${SCHEDULE_WINDOW_MAX_DAYS} dias`);
  return { from, to };
}

/** O estado que o agendador guarda de uma rotina (ver `RoutineScheduler.snapshot`). */
export interface RoutineSnapshot {
  last: RoutineRun | null;
  history: RoutineHistoryEntry[];
  armedAt: string | null;
  inFlight: string | null;
  cursor: number | null;
}

/** O que aconteceu com a ocorrência `at`: ainda por vir (ou em andamento), o que o histórico lembra, ou `unknown` (o histórico é limitado). */
export function occurrenceState(at: Date, now: Date, snap: RoutineSnapshot | null): RoutineOccurrence['state'] {
  const ms = at.getTime();
  if (ms > now.getTime() || (snap?.cursor != null && ms > snap.cursor) || snap?.inFlight === at.toISOString()) return 'upcoming';
  const iso = at.toISOString();
  const hit = snap?.history.find((h) => !h.manual && h.state !== 'discarded' && h.due === iso);
  if (hit) return hit.state;
  const dropped = snap?.history.some((h) => h.state === 'discarded' && Date.parse(h.from ?? h.due) <= ms && ms <= Date.parse(h.due));
  return dropped ? 'discarded' : 'unknown';
}

/** Uma rotina como a tela a vê. */
export function routineSchedule(profile: StaffProfile, r: Routine, snap: RoutineSnapshot | null, now: Date): RoutineSchedule {
  const recurrence = recurrenceOf(r);
  const invalid = recurrenceError(recurrence);
  return {
    projectId: profile.projectId,
    staffId: profile.id,
    staffName: profile.name,
    routineId: r.id,
    name: r.name,
    message: r.message,
    mode: r.mode,
    enabled: r.enabled,
    recurrence,
    description: invalid ? '' : describeRecurrence(recurrence),
    invalid,
    catchUpHours: r.catchUpHours ?? 0,
    next: r.enabled && !invalid ? (nextOccurrence(recurrence, now)?.toISOString() ?? null) : null,
    armedAt: snap?.armedAt ?? null,
    inFlight: snap?.inFlight ?? null,
    last: snap?.last ?? null,
    history: snap?.history ?? [],
  };
}

/** Todas as rotinas das fichas dadas e as ocorrências das ligadas na janela, em ordem de horário. */
export async function buildSchedules(
  staff: StaffProfile[],
  snapshot: (key: string) => Promise<RoutineSnapshot | null>,
  window: { from: Date; to: Date },
  now: Date,
): Promise<{ routines: RoutineSchedule[]; occurrences: RoutineOccurrence[]; truncated: boolean }> {
  const routines: RoutineSchedule[] = [];
  const occurrences: RoutineOccurrence[] = [];
  let truncated = false;
  for (const profile of staff) {
    for (const r of profile.routines ?? []) {
      const snap = await snapshot(routineKey(profile.projectId, profile.id, r.id));
      const view = routineSchedule(profile, r, snap, now);
      routines.push(view);
      if (!r.enabled || view.invalid) continue;
      // Antes do marco a rotina não existia: não há ocorrência dela ali.
      const since = view.armedAt ? Date.parse(view.armedAt) : -Infinity;
      const found = occurrencesIn(view.recurrence, window.from, window.to, { limit: PER_ROUTINE_MAX });
      truncated ||= found.truncated;
      for (const at of found.items) {
        if (at.getTime() < since) continue;
        if (occurrences.length >= TOTAL_MAX) {
          truncated = true;
          break;
        }
        occurrences.push({ staffId: profile.id, routineId: r.id, at: at.toISOString(), state: occurrenceState(at, now, snap) });
      }
    }
  }
  occurrences.sort((a, b) => a.at.localeCompare(b.at));
  return { routines, occurrences, truncated };
}
