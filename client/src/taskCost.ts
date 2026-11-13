// Custo por tarefa na tela: textos e contas puras sobre o `TaskCost` e o `TaskCostRanking` do servidor (sem React).
// Regras de exibição: US$ só existe para o Claude (custo equivalente à API), então `usd` null mostra os tokens e
// "US$ indisponível", nunca US$ 0; `tokens` null é "sem dado" (conversa apagada pela retenção), nunca 0.
import type { Board, TaskCostBucket, TaskCostCoverage, TaskTokens } from '../../shared/model';
import { formatTokens } from './costReview';
import { formatUsd } from './format';
import { t } from './i18n';

/** Todos os tokens somados (entrada, cache lido, cache gravado e saída). */
export const tokensTotal = (k: TaskTokens): number => k.input + k.cacheRead + k.cacheWrite + k.output;

/** "182 mil tokens": o total, no idioma da tela. */
const tokensLine = (k: TaskTokens): string => t('taskCost.tokensTotal', { n: formatTokens(tokensTotal(k)) });

/** Os quatro componentes, para o title ou uma linha de detalhe. */
export const tokensBreakdown = (k: TaskTokens): string =>
  t('taskCost.tokensBreakdown', { input: formatTokens(k.input), cacheRead: formatTokens(k.cacheRead), cacheWrite: formatTokens(k.cacheWrite), output: formatTokens(k.output) });

export interface CostText {
  /** O valor que vai na frente: US$ (Claude), ou o total de tokens, ou "indisponível". */
  main: string;
  /** Linha de apoio: os tokens ao lado do US$, ou "US$ indisponível" quando só há tokens. */
  sub: string | null;
  /** Os quatro componentes dos tokens (title); null sem dado. */
  detail: string | null;
}

/** Como mostrar um custo `{ usd, tokens }` de qualquer nível (tarefa, papel, executor, gestor). */
export function costText(c: { usd: number | null; tokens: TaskTokens | null }): CostText {
  const detail = c.tokens ? tokensBreakdown(c.tokens) : null;
  if (c.usd !== null) return { main: formatUsd(c.usd), sub: c.tokens ? tokensLine(c.tokens) : null, detail };
  if (c.tokens) return { main: tokensLine(c.tokens), sub: t('taskCost.usdUnavailable'), detail };
  return { main: t('taskCost.unavailable'), sub: null, detail: null };
}

/** "2 conversas", ou "2 conversas · 1 com dado" quando alguma não tem leitura. */
export function bucketMeta(b: Pick<TaskCostBucket, 'sessions' | 'withData'>): string {
  const sessions = b.sessions === 1 ? t('taskCost.sessionsOne') : t('taskCost.sessionsOther', { n: b.sessions });
  return b.sessions > 0 && b.withData < b.sessions ? `${sessions} · ${t('taskCost.withData', { n: b.withData })}` : sessions;
}

/** Aviso longo da cobertura (o total é parcial; a tarefa é anterior ao registro); null = completa. */
export function coverageNote(c: TaskCostCoverage): string | null {
  return c === 'partial' ? t('taskCost.coveragePartial') : c === 'none' ? t('taskCost.coverageNone') : null;
}

/** Etiqueta curta da cobertura para a linha do ranking; null = completa. */
export function coverageTag(c: TaskCostCoverage): string | null {
  return c === 'partial' ? t('taskCost.tagPartial') : c === 'none' ? t('taskCost.tagNone') : null;
}

/** "sem retrabalho", "1 volta de retrabalho", "3 voltas de retrabalho". */
export const reworkText = (rounds: number): string =>
  rounds <= 0 ? t('taskCost.reworkNone') : rounds === 1 ? t('taskCost.reworkOne') : t('taskCost.reworkOther', { n: rounds });

/** "1 revisão", "3 revisões". */
export const reviewsText = (rounds: number): string => (rounds === 1 ? t('taskCost.reviewOne') : t('taskCost.reviewOther', { n: rounds }));

/** "1 tarefa", "5 tarefas". */
export const tasksText = (n: number): string => (n === 1 ? t('taskCost.tasksOne') : t('taskCost.tasksOther', { n }));

/** Tamanho da barra (0 a 1) de cada valor em relação ao maior; sem valor (US$ indisponível), sem barra. */
export function barSizes(values: Array<number | null>): number[] {
  const max = values.reduce<number>((m, v) => Math.max(m, v ?? 0), 0);
  return values.map((v) => (v && max > 0 ? v / max : 0));
}

/** Quem é o funcionário de cada linha: nome, e a ficha a abrir no RH (sem ficha no quadro, a linha não abre nada). */
export interface StaffIndex {
  nameOf: (staffId: string | null, projectId?: string) => string;
  personOf: (staffId: string, projectId?: string) => { projectId: string; staffId: string } | null;
  projectName: (projectId: string) => string;
}

export function staffIndex(board: Pick<Board, 'staff' | 'projects'>): StaffIndex {
  const find = (staffId: string, projectId?: string) =>
    board.staff.find((s) => s.id === staffId && (projectId === undefined || s.projectId === projectId)) ?? board.staff.find((s) => s.id === staffId);
  return {
    nameOf: (staffId, projectId) => (staffId === null ? t('tasks.noOwner') : (find(staffId, projectId)?.name ?? staffId)),
    personOf: (staffId, projectId) => {
      const s = find(staffId, projectId);
      return s ? { projectId: s.projectId, staffId: s.id } : null;
    },
    projectName: (projectId) => board.projects.find((p) => p.id === projectId)?.name ?? projectId,
  };
}
