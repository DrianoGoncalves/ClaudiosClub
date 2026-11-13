import type { AccountUsage, UsageStop } from '../shared/model';

// Aviso de consumo antes da linha de parada, para a caixa "precisa de mim". Vale para a conta Claude: o Codex tem conta própria.
// Conta 5h/7d: começa 10 pontos antes da linha de parada (ver usageStop.ts). Projeto: começa em 80% do orçamento, como estimativa.
// Cada aviso tem id pela janela (o resetsAt): some quando o uso cai abaixo do limiar ou a janela vira; volta com id novo.

/** Quantos pontos antes da linha de parada o aviso começa. */
export const WARN_MARGIN = 10;
/** Fração do orçamento do projeto em que o aviso começa. */
export const BUDGET_WARN_SHARE = 0.8;
/** Leitura mais velha que isto não avisa: o consumo pode já ter andado. */
export const READING_MAX_AGE_MS = 30 * 60_000;

const ACCOUNT = [
  { kind: 'five_hour', key: 'fiveHour', label: '5h' },
  { kind: 'seven_day', key: 'sevenDay', label: '7d' },
] as const;

export interface UsageWarning {
  /** Muda a cada janela: quem mostra avisa só o id novo. */
  id: string;
  scope: 'five_hour' | 'seven_day' | 'project_week';
  /** Em `project_week`: o projeto do orçamento. */
  projectId: string | null;
  summary: string;
  /** Quando a janela vira (ms desde 1970). */
  resetsAt: number;
}

export interface UsageWarnInput {
  usage: AccountUsage;
  usageStop: UsageStop;
  /** Orçamento por projeto (1–100); sem entrada = sem orçamento. */
  projectBudgets: Record<string, number>;
  /** Custo dos últimos 7 dias do projeto e da conta (só dos projetos com orçamento). */
  week: Record<string, { project: number; total: number }>;
  projectName: (projectId: string) => string;
  now: number;
}

export interface UsageWarnUpdate {
  /** Avisos vigentes: é o que a caixa mostra. */
  active: UsageWarning[];
  /** Os que entraram agora (id que ainda não estava): é o que vale avisar. */
  fresh: UsageWarning[];
}

/** Guarda os avisos vigentes entre leituras (em memória: reiniciar o Claudio’s Club refaz o aviso uma vez). */
export class UsageWarnings {
  private entries = new Map<string, UsageWarning>();

  /** Confere a leitura de agora. Quem já está na caixa segue com o mesmo id, então não avisa de novo. */
  update(input: UsageWarnInput): UsageWarnUpdate {
    const { usage, usageStop, projectBudgets, week, projectName, now } = input;
    const before = new Set([...this.entries.values()].map((w) => w.id));

    for (const { kind, key, label } of ACCOUNT) {
      const stop = usageStop[key];
      // Sem linha de parada (ou tão baixa que não sobra faixa para avisar): sem aviso.
      if (stop === null || stop - WARN_MARGIN < 1) {
        this.entries.delete(kind);
        continue;
      }
      const r = readingOf(usage, kind, now);
      if (!r) continue; // sem leitura válida: não avisa, e não tira o que já está na caixa
      if (r.percentUsed < stop - WARN_MARGIN || r.percentUsed >= stop) {
        // Caiu abaixo do limiar (rearma) ou já passou da linha (a trava de início já barra e avisa).
        this.entries.delete(kind);
        continue;
      }
      this.entries.set(kind, {
        id: `usage:${kind}:${r.resetsAt}`,
        scope: kind,
        projectId: null,
        resetsAt: r.resetsAt,
        summary: `Consumo da conta Claude em ${Math.round(r.percentUsed)}% na janela ${label}; tarefas novas param em ${stop}%. O Codex tem conta própria e não entra nessa conta.`,
      });
    }

    // Projeto que perdeu o orçamento sai da caixa.
    for (const [key, w] of this.entries) {
      if (w.projectId !== null && !Object.hasOwn(projectBudgets, w.projectId)) this.entries.delete(key);
    }
    const seven = readingOf(usage, 'seven_day', now);
    if (seven) {
      for (const [projectId, budget] of Object.entries(projectBudgets)) {
        const key = `project:${projectId}`;
        const cost = week[projectId];
        // Sem custo da semana, a parte do projeto é zero (não há o que estimar).
        const used = cost && cost.total > 0 ? (cost.project / cost.total) * seven.percentUsed : 0;
        if (used < budget * BUDGET_WARN_SHARE || used >= budget) {
          this.entries.delete(key);
          continue;
        }
        this.entries.set(key, {
          id: `usage:${key}:${seven.resetsAt}`,
          scope: 'project_week',
          projectId,
          resetsAt: seven.resetsAt,
          summary: `Estimativa: ${projectName(projectId)} já usou cerca de ${Math.round(used)}% da cota de 7 dias da conta Claude; o orçamento é ${budget}% e tarefas novas param nele.`,
        });
      }
    }

    // Janela que já virou: o aviso dela não vale mais.
    for (const [key, w] of this.entries) if (w.resetsAt <= now) this.entries.delete(key);

    const active = [...this.entries.values()];
    return { active, fresh: active.filter((w) => !before.has(w.id)) };
  }
}

/**
 * A leitura da janela, se for recente e a janela ainda não virou; senão null. Sem `resetsAt` não dá para
 * saber a janela (e o aviso não teria id), então também não avisa.
 */
function readingOf(usage: AccountUsage, kind: string, now: number): { percentUsed: number; resetsAt: number } | null {
  const measured = usage.updatedAt ? Date.parse(usage.updatedAt) : NaN;
  if (!(measured >= now - READING_MAX_AGE_MS)) return null;
  const l = usage.limits.find((x) => x.kind === kind);
  const resetsAt = l?.resetsAt ? Date.parse(l.resetsAt) : NaN;
  if (!l || !(resetsAt > now)) return null;
  return { percentUsed: l.percentUsed, resetsAt };
}
