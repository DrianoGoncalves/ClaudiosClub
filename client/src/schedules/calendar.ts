// O calendário mensal da tela de agendamentos: a grade de dias e as execuções agrupadas por dia. Puro; sem lib.
import type { RoutineOccurrence, SchedulesResponse } from '../../../shared/model';
import { WEEK_STARTS_ON, dayString } from '../../../shared/recurrence';

/** Uma execução no calendário: de uma rotina (com o estado que o servidor deu) ou um despertador/"continue" pendente. */
export interface CalEntry {
  key: string;
  /** ISO. */
  at: string;
  kind: 'routine' | 'wake' | 'continue';
  /** null = conversa sem ficha. */
  staffId: string | null;
  routineId?: string;
  state: RoutineOccurrence['state'];
  /** O texto do despertador (só `wake`). */
  text?: string;
}

export const monthStart = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);
export const shiftMonth = (anchor: Date, n: number): Date => new Date(anchor.getFullYear(), anchor.getMonth() + n, 1);

/**
 * Os dias da grade do mês `anchor`: começa no primeiro dia da semana (domingo, o mesmo do quinzenal em shared/recurrence.ts) em que o dia 1
 * cai e termina com a semana do último dia (5 ou 6 semanas). `from` e `to` são a janela [from, to) que o servidor deve mandar (no máximo 42 dias).
 */
export function monthGrid(anchor: Date): { days: Date[]; from: Date; to: Date } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const lead = (new Date(y, m, 1).getDay() - WEEK_STARTS_ON + 7) % 7;
  const weeks = Math.ceil((lead + new Date(y, m + 1, 0).getDate()) / 7);
  const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(y, m, 1 - lead + i));
  return { days, from: days[0]!, to: new Date(y, m, 1 - lead + weeks * 7) };
}

/** O dia que fica escolhido ao trocar para o mês `next`: hoje, se o mês é o de hoje; senão o dia 1. */
export const dayAfterMonthChange = (next: Date, today: Date): string =>
  dayString(next.getFullYear() === today.getFullYear() && next.getMonth() === today.getMonth() ? today : next);

/** As execuções que a tela mostra: as ocorrências das rotinas e os despertadores/"continue" pendentes. */
export function calendarEntries(data: Pick<SchedulesResponse, 'occurrences' | 'items'>): CalEntry[] {
  const out: CalEntry[] = [];
  for (const o of data.occurrences ?? []) out.push({ key: `r:${o.staffId}:${o.routineId}:${o.at}`, at: o.at, kind: 'routine', staffId: o.staffId, routineId: o.routineId, state: o.state });
  for (const s of data.items ?? []) out.push({ key: `${s.kind}:${s.sessionId}`, at: s.at, kind: s.kind, staffId: s.staffId, state: 'upcoming', ...(s.kind === 'wake' && { text: s.text }) });
  return out;
}

/** As execuções por dia local ('YYYY-MM-DD'), cada dia em ordem de horário. */
export function groupByDay(entries: readonly CalEntry[]): Map<string, CalEntry[]> {
  const by = new Map<string, CalEntry[]>();
  for (const e of [...entries].sort((a, b) => a.at.localeCompare(b.at))) {
    const day = dayString(new Date(e.at));
    by.set(day, [...(by.get(day) ?? []), e]);
  }
  return by;
}

/** Nomes dos dias da semana, de domingo (0) a sábado (6), no idioma `loc`. */
export function weekdayNames(loc: string, style: 'short' | 'long' = 'short'): string[] {
  const fmt = new Intl.DateTimeFormat(loc, { weekday: style });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i))); // 1/1/2023 foi domingo
}

/** "novembro de 2026". */
export const monthTitle = (anchor: Date, loc: string): string => anchor.toLocaleDateString(loc, { month: 'long', year: 'numeric' });

/** "quarta-feira, 18 de novembro". */
export const dayTitle = (day: Date, loc: string): string => day.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
