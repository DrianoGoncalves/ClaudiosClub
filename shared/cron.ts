// Agenda das rotinas: expressão cron de 5 campos (minuto hora dia-do-mês mês dia-da-semana), no
// horário desta máquina. Aceita *, números, intervalos (1-5), listas (1,3,5) e passos (*/15, 8-18/2).
// Dia da semana: 0 ou 7 = domingo. Com dia do mês e dia da semana restritos, vale um OU o outro
// (como no cron de sempre).

const FIELDS = [
  { name: 'minuto', min: 0, max: 59 },
  { name: 'hora', min: 0, max: 23 },
  { name: 'dia do mês', min: 1, max: 31 },
  { name: 'mês', min: 1, max: 12 },
  { name: 'dia da semana', min: 0, max: 7 },
] as const;

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

/** Lê a expressão; erro com a explicação em português se não der. */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('use 5 campos: minuto hora dia mês dia-da-semana (ex.: 0 8 * * 1-5)');
  const sets = parts.map((p, i) => field(p, FIELDS[i]!));
  const dow = new Set([...sets[4]!].map((d) => (d === 7 ? 0 : d)));
  return { minute: sets[0]!, hour: sets[1]!, dom: sets[2]!, month: sets[3]!, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function field(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const piece of text.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
    if (!m) throw new Error(`${f.name}: "${piece}" não é válido`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`${f.name}: passo inválido`);
    let lo: number = f.min;
    let hi: number = f.max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-').map(Number);
      lo = a!;
      hi = b ?? (m[2] ? f.max : a!);
    }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(`${f.name}: use de ${f.min} a ${f.max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function cronMatches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes()) || !spec.hour.has(d.getHours()) || !spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowOk;
  if (spec.dowAny) return domOk;
  return domOk || dowOk;
}

/** Próxima vez que a rotina roda depois de `from` (até um ano à frente); null se nunca. */
export function nextRun(spec: CronSpec, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60_000;
  while (d.getTime() <= limit) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (cronMatches(spec, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Mensagem de erro, ou null se a expressão é válida. */
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

const DAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "todo dia às 08:00", "dias úteis às 18:30"…; formas incomuns voltam como a própria expressão. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5 || cronError(expr)) return expr;
  const [mi, h, dom, mon, dow] = p as [string, string, string, string, string];
  const fixed = /^\d+$/;
  if (fixed.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `toda hora, aos ${mi} minutos`;
  if (mi.startsWith('*/') && h === '*' && dom === '*' && mon === '*' && dow === '*') return `a cada ${mi.slice(2)} minutos`;
  if (!fixed.test(mi) || !fixed.test(h) || mon !== '*') return expr;
  const at = `às ${pad(Number(h))}:${pad(Number(mi))}`;
  if (dom === '*' && dow === '*') return `todo dia ${at}`;
  if (dom === '*' && dow === '1-5') return `dias úteis ${at}`;
  if (dom === '*' && fixed.test(dow)) {
    const day = DAYS[Number(dow) % 7]!;
    return `${day === 'sábado' || day === 'domingo' ? 'todo' : 'toda'} ${day} ${at}`;
  }
  if (fixed.test(dom) && dow === '*') return `todo dia ${dom} do mês ${at}`;
  return expr;
}
