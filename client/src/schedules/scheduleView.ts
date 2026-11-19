// Agendamentos de um projeto (GET /api/projects/:pid/schedules): chave, hora, contagem regressiva, o "quando roda" por extenso e o estado de cada execução.
import { describeCron } from '../../../shared/cron';
import type { Recurrence, RoutineOccurrence, RoutineSchedule } from '../../../shared/model';
import { parseDay } from '../../../shared/recurrence';
import { clockHM, secondsLeft } from '../chat/wakeCountdown';
import { formatDuration } from '../format';
import { locale, t } from '../i18n';
import type { Tr } from '../inbox/secretText';
import { weekdayNames } from './calendar';
import { oddStep, parseCronStep, stepFits } from './cronSteps';

/** `wake` = despertador pedido pelo funcionário; `continue` = "continue" automático para quando o limite de uso voltar. */
export interface Schedule {
  kind: 'wake' | 'continue';
  sessionId: string;
  /** null = conversa sem ficha (Freela). */
  staffId: string | null;
  /** Instante em ISO. */
  at: string;
  /** O que o funcionário escreveu para si (despertador); mostrar sempre como texto puro. */
  text: string;
}

/** Um despertador e um "continue" da mesma conversa podem coexistir: a chave leva o tipo. */
export const scheduleKey = (s: Pick<Schedule, 'kind' | 'sessionId'>): string => `${s.kind}:${s.sessionId}`;

/** Hora marcada: só "10:32" se for hoje (na hora desta máquina), com o dia ("12/11") se for outro. */
export function whenParts(at: string, now: number): { date: string | null; time: string } {
  const ms = Date.parse(at);
  const time = clockHM(ms);
  const d = new Date(ms);
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return { date: sameDay ? null : d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' }), time };
}

/** "agora", "em 42s", "em 4min 05s", "em 3h05", "em 2d4h". */
export function countdown(at: string, now: number, tr: Tr = t): string {
  const secs = secondsLeft(Date.parse(at), now);
  if (secs <= 0) return tr('schedules.now');
  const dur =
    secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}min ${String(secs % 60).padStart(2, '0')}s` : formatDuration(secs * 1000);
  return tr('schedules.in', { dur });
}

/** As que vão rodar primeiro no topo (a mais próxima antes); desligadas, inválidas e sem próxima execução depois, por nome. */
export function sortRoutines(list: readonly RoutineSchedule[]): RoutineSchedule[] {
  const live = (r: RoutineSchedule) => (r.enabled && r.next ? 0 : 1);
  return [...list].sort((a, b) => live(a) - live(b) || (a.next ?? '').localeCompare(b.next ?? '') || a.name.localeCompare(b.name));
}

/** "qua., 18/11, 09:00": o instante com o dia da semana, na hora desta máquina. */
export const stamp = (at: string, loc: string = locale()): string =>
  new Date(at).toLocaleString(loc, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---- estado de cada execução ----

export type RunState = RoutineOccurrence['state'];

/** O símbolo vai junto da cor e do texto: o estado não depende só da cor. */
export const STATE_GLYPH: Record<RunState, string> = { upcoming: '○', ran: '✓', failed: '✕', discarded: '–', uncertain: '?', unknown: '·' };
const STATE_KEY = {
  upcoming: 'schedules.st.upcoming',
  ran: 'schedules.st.ran',
  failed: 'schedules.st.failed',
  discarded: 'schedules.st.discarded',
  uncertain: 'schedules.st.uncertain',
  unknown: 'schedules.st.unknown',
} as const;
export const stateLabel = (s: RunState, tr: Tr = t): string => tr(STATE_KEY[s]);

// ---- o "quando roda" por extenso ----

const dayText = (iso: string, loc: string): string => {
  const d = parseDay(iso);
  return d ? new Date(d.y, d.m - 1, d.d).toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: 'numeric' }) : iso;
};

/**
 * "todo dia às 08:00", "quinzenal (seg e qua) às 09:00", "uma vez, em 20/11/2026 às 10:00"… no idioma da tela.
 * Esta é a FONTE do "quando roda" na tela: o `RoutineSchedule.description` que o servidor manda (shared/model.ts) é só em português e a tela o ignora.
 * Cron: "a cada N minutos/horas" nos 3 idiomas; em português o resto usa a leitura de shared/cron.ts (que devolve a própria expressão nas formas
 * incomuns); nos outros idiomas mostra a expressão.
 */
export function describeWhen(rec: Recurrence, tr: Tr = t, loc: string = locale()): string {
  if (rec.kind === 'cron') {
    const step = parseCronStep(rec.expr);
    if (step && stepFits(step)) return step.unit === 'minutes' ? tr('schedules.d.everyMin', { n: step.n }) : tr(step.n === 1 ? 'schedules.d.everyHourOne' : 'schedules.d.everyHour', { n: step.n });
    // O "a cada 45 minutos" que shared/cron.ts diria seria mentira (roda no minuto 0 e no 45): mostra a expressão.
    if (oddStep(rec.expr)) return tr('schedules.d.cron', { expr: rec.expr });
    return loc === 'pt-BR' ? describeCron(rec.expr) : tr('schedules.d.cron', { expr: rec.expr });
  }
  const time = rec.time;
  const n = rec.interval;
  let text: string;
  if (rec.kind === 'once') {
    text = tr('schedules.d.once', { date: dayText(rec.start, loc), time });
  } else if (rec.kind === 'daily') {
    text = n === 1 ? tr('schedules.d.daily', { time }) : tr('schedules.d.dailyN', { n, time });
  } else if (rec.kind === 'weekly') {
    const s = parseDay(rec.start);
    const days = rec.weekdays?.length ? rec.weekdays : [s ? new Date(s.y, s.m - 1, s.d).getDay() : 1];
    const names = weekdayNames(loc);
    const list = new Intl.ListFormat(loc, { style: 'long', type: 'conjunction' }).format(days.map((d) => names[d]!));
    const workdays = days.length === 5 && days.every((d, i) => d === i + 1);
    text =
      n === 1
        ? workdays ? tr('schedules.d.workdays', { time }) : tr('schedules.d.weekly', { days: list, time })
        : n === 2 ? tr('schedules.d.biweekly', { days: list, time }) : tr('schedules.d.weeklyN', { n, days: list, time });
  } else {
    const day = rec.monthDay ?? parseDay(rec.start)?.d ?? 1;
    text = `${n === 1 ? tr('schedules.d.monthly', { day, time }) : tr('schedules.d.monthlyN', { n, day, time })}${day > 28 ? tr('schedules.d.shortMonth') : ''}`;
  }
  return rec.until ? `${text}${tr('schedules.d.until', { date: dayText(rec.until, loc) })}` : text;
}
