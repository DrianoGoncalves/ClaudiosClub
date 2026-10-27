import type { AccountUsage, UsageStop, UsageStopHit } from '../shared/model';

// Trava de consumo: antes de mandar trabalho novo, compara o 5h/7d da conta com a linha de parada.

const KINDS = [
  ['five_hour', 'fiveHour'],
  ['seven_day', 'sevenDay'],
] as const;

/** Recusa pedida pela trava; o cliente pode confirmar e repetir com `force`. */
export class UsageStopError extends Error {
  readonly code = 'usage-stop';
  constructor(readonly hit: UsageStopHit) {
    super(
      hit.kind === 'project_week'
        ? `${hit.projectName ?? 'o projeto'} já usou cerca de ${Math.round(hit.percentUsed)}% da cota de 7 dias (orçamento: ${hit.limit}%)`
        : `o consumo ${hit.kind === 'five_hour' ? '5h' : '7d'} está em ${Math.round(hit.percentUsed)}% (linha de parada: ${hit.limit}%)`,
    );
  }
}

/**
 * Orçamento do projeto: a parte dele na cota de 7 dias, estimada pela fatia do custo dele nos
 * últimos 7 dias × o uso 7d da conta. Passou do orçamento: o hit; senão (ou sem leitura), null.
 */
export function projectBudgetHit(
  usage: AccountUsage,
  week: { project: number; total: number },
  budget: number | undefined,
  projectName: string,
  now = Date.now(),
): UsageStopHit | null {
  if (!budget || week.total <= 0) return null;
  const reading = usage.limits.find((l) => l.kind === 'seven_day');
  if (!reading || (reading.resetsAt && Date.parse(reading.resetsAt) <= now)) return null;
  const used = (week.project / week.total) * reading.percentUsed;
  if (used < budget) return null;
  return { kind: 'project_week', percentUsed: used, limit: budget, resetsAt: reading.resetsAt, fromProfile: false, projectName };
}

/**
 * O primeiro limite que passou da linha, ou null. A ficha manda em cada limite que ela define;
 * o resto vem da empresa. Uma leitura cuja janela já virou (resetsAt no passado) não conta.
 */
export function usageStopHit(
  usage: AccountUsage,
  company: UsageStop,
  profile: UsageStop | null,
  now = Date.now(),
): UsageStopHit | null {
  for (const [kind, key] of KINDS) {
    const own = profile?.[key] ?? null;
    const limit = own ?? company[key];
    if (limit === null) continue;
    const reading = usage.limits.find((l) => l.kind === kind);
    if (!reading || reading.percentUsed < limit) continue;
    if (reading.resetsAt && Date.parse(reading.resetsAt) <= now) continue;
    return { kind, percentUsed: reading.percentUsed, limit, resetsAt: reading.resetsAt, fromProfile: own !== null };
  }
  return null;
}
