// Agendamentos pendentes de um projeto (GET /api/projects/:pid/schedules): chave, hora e contagem regressiva.
import { clockHM, secondsLeft } from '../chat/wakeCountdown';
import { formatDuration } from '../format';
import { locale, t } from '../i18n';

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
export function countdown(at: string, now: number): string {
  const secs = secondsLeft(Date.parse(at), now);
  if (secs <= 0) return t('schedules.now');
  const dur =
    secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs / 60)}min ${String(secs % 60).padStart(2, '0')}s` : formatDuration(secs * 1000);
  return t('schedules.in', { dur });
}
