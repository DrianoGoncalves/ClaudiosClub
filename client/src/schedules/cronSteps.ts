// "A cada N minutos" e "a cada N horas" do formulário de rotina são crons (`*/N * * * *` e `0 */N * * *`): daqui sai o ida e volta entre o passo e a
// expressão. Puro. O campo do minuto do cron vai de 0 a 59 e o passo recomeça a contar a cada hora, então só N que divide 60 repete de N em N.

export type CronStep = { unit: 'minutes' | 'hours'; n: number };

/** Os N que o formulário oferece em minutos: os que dividem a hora certinho. */
export const MINUTE_STEPS: readonly number[] = [5, 6, 10, 12, 15, 20, 30];
/** Em horas, de 1 a 12 (o passo conta da meia-noite: 5 h roda às 00, 05, 10, 15 e 20). */
export const HOUR_STEPS: readonly number[] = Array.from({ length: 12 }, (_, i) => i + 1);

/** A expressão cron do passo. */
export const cronOfStep = (s: CronStep): string => (s.unit === 'minutes' ? `*/${s.n} * * * *` : `0 */${s.n} * * *`);

/** O passo cabe nas opções do formulário. */
export const stepFits = (s: CronStep): boolean => (s.unit === 'minutes' ? MINUTE_STEPS : HOUR_STEPS).includes(s.n);

const MINUTES = /^\*\/(\d{1,4}) \* \* \* \*$/;
const HOURS = /^0 \*\/(\d{1,4}) \* \* \*$/;

// Lê a expressão na forma `*/N * * * *` ou `0 */N * * *` (qualquer N); outra forma, null.
export function parseCronStep(expr: string): CronStep | null {
  const one = expr.trim().split(/\s+/).join(' ');
  const m = MINUTES.exec(one);
  if (m) return { unit: 'minutes', n: Number(m[1]) };
  const h = HOURS.exec(one);
  return h ? { unit: 'hours', n: Number(h[1]) } : null;
}

// O passo que NÃO repete de N em N como a palavra "a cada" promete: minutos que não dividem 60 (o passo 45 roda no minuto 0 e no 45 de cada hora) e
// horas acima de 12. Os que dividem 60 e ficam fora das opções (2, 3, 4…) são crons certos, só não vão no formulário: devolvem null.
export function oddStep(expr: string): CronStep | null {
  const s = parseCronStep(expr);
  if (!s || s.n < 1 || stepFits(s)) return null;
  return s.unit === 'minutes' ? (60 % s.n === 0 ? null : s) : s.n > 12 ? s : null;
}
