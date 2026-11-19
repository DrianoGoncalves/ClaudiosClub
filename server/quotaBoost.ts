import type { AccountUsage, QuotaBoost } from '../shared/model';

// Folga de cota ("otimizar assinatura"): a cota de 7 dias renova sozinha, e o que sobra no reset se
// perde. Nas últimas 72h, se no ritmo desta semana ia sobrar o bastante, as conversas vão para o
// Opus no esforço máximo e os agents pensam mais, até a folga acabar. A sobra exigida é a reserva
// para o erro da previsão, que cresce com o tempo restante: 30% faltando 72h, 20% faltando 48h e
// 10% (piso) nas últimas 24h. O ritmo se corrige sozinho: gastando mais, a projeção sobe e a folga
// desliga antes de encostar na trava de consumo.

/** Só nas últimas horas antes do reset da cota de 7 dias. */
export const BOOST_WINDOW_H = 72;
/** Sobra exigida no começo da janela (faltando BOOST_WINDOW_H), em % da cota. */
export const BOOST_SPARE_MAX = 30;
/** Sobra exigida no fim da janela: o piso, a partir de BOOST_WINDOW_H / 3 restantes. */
export const BOOST_SPARE_MIN = 10;
/** A partir daqui no limite de 5h, a folga espera: Opus no máximo esgota a janela curta e trava todo mundo. */
export const BOOST_MAX_5H = 50;
const WEEK_H = 168;
/** Leitura mais velha que isso não conta: outros apps também gastam a cota, e a sobra pode ser menor. */
const STALE_MS = 3 * 3600_000;

/** A folga agora, ou null. Sem leitura, leitura velha ou janela já renovada: null (na dúvida, não liga). */
export function quotaBoost(usage: AccountUsage, now = Date.now()): QuotaBoost | null {
  if (!usage.updatedAt || now - Date.parse(usage.updatedAt) > STALE_MS) return null;
  const week = usage.limits.find((l) => l.kind === 'seven_day');
  if (!week?.resetsAt) return null;
  const hoursLeft = (Date.parse(week.resetsAt) - now) / 3600_000;
  if (!(hoursLeft > 0 && hoursLeft <= BOOST_WINDOW_H)) return null;
  // O seu ritmo desta semana até agora, levado até o reset.
  const projected = week.percentUsed + (week.percentUsed / (WEEK_H - hoursLeft)) * hoursLeft;
  // Quanto da cota, no ritmo da semana, ia sobrar no reset para valer a pena: proporcional ao que falta.
  const minSpare = Math.max(BOOST_SPARE_MIN, (BOOST_SPARE_MAX * hoursLeft) / BOOST_WINDOW_H);
  if (100 - projected < minSpare) return null;
  const short = usage.limits.find((l) => l.kind === 'five_hour');
  const shortOpen = !!short && !(short.resetsAt && Date.parse(short.resetsAt) <= now);
  if (shortOpen && short.percentUsed >= BOOST_MAX_5H) return null;
  return { until: week.resetsAt, projected: Math.round(projected) };
}
