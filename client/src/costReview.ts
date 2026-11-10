// Revisão de custo de um funcionário (botão Analisar do ranking): contas puras sobre o `CostReview` do servidor.
import type { CostReview, CostReviewApplied, CostReviewApplyResult, CostReviewFinding, CostReviewFix } from '../../shared/model';
import { effortLabel } from './format';
import { locale, t, type MsgKey } from './i18n';

/** Limite de dias que o servidor aceita; "Tudo" no filtro do ranking analisa até aqui. */
export const REVIEW_MAX_DAYS = 3650;

/** Dias da análise a partir do filtro do ranking (`null` = tudo). */
export const reviewDays = (days: number | null): number => (days === null ? REVIEW_MAX_DAYS : Math.min(Math.max(1, days), REVIEW_MAX_DAYS));

export type Severity = CostReviewFinding['severity'];

/** Da mais grave à mais leve, com o texto do título do grupo. */
export const SEVERITIES: Array<[Severity, MsgKey]> = [
  ['high', 'detail.reviewHigh'],
  ['medium', 'detail.reviewMedium'],
  ['low', 'detail.reviewLow'],
];

/** Título curto de cada achado pelo id; id novo no servidor, sem tradução ainda, cai no próprio id. */
export const FINDING_TITLES: Record<string, MsgKey> = {
  'long-context': 'detail.finding.long-context',
  'ignored-context-warning': 'detail.finding.ignored-context-warning',
  'heavy-model-on-implementation': 'detail.finding.heavy-model-on-implementation',
  'no-model': 'detail.finding.no-model',
  'big-memory': 'detail.finding.big-memory',
  'big-tool-output': 'detail.finding.big-tool-output',
  'repeated-reads': 'detail.finding.repeated-reads',
  'inherited-model-agents': 'detail.finding.inherited-model-agents',
  rework: 'detail.finding.rework',
};

/** Achados por severidade, na ordem alta → média → baixa; grupo sem achado não aparece (a ordem de dentro é a do servidor). */
export function groupFindings(findings: CostReview['findings']): Array<{ severity: Severity; key: MsgKey; items: CostReviewFinding[] }> {
  return SEVERITIES.map(([severity, key]) => ({ severity, key, items: findings.filter((f) => f.severity === severity) })).filter((g) => g.items.length > 0);
}

/** Título curto do achado no idioma da tela. */
export const findingTitle = (id: string): string => (FINDING_TITLES[id] ? t(FINDING_TITLES[id]!) : id);

/** Os achados que o botão "Aplicar" sabe resolver (os demais são só sugestão em texto). */
export const fixable = (findings: CostReview['findings']): CostReviewFinding[] => findings.filter((f) => f.fix);

type FichaPart = { model?: string | null; effort?: string | null };

/** Apelido do modelo curto, sem o "(mais recente)" do formulário: "opus" → "Opus"; id comprido fica como está. */
const modelShort = (m: string) => (/^[a-z]+$/.test(m) ? m.charAt(0).toUpperCase() + m.slice(1) : m);

/** "Modelo: Opus → Sonnet · Esforço: XHigh → High": só os campos presentes em `after`; sem valor antes = "padrão". */
function fichaChange(before: FichaPart, after: FichaPart): string {
  const shown = (value: string | null | undefined, label: (v: string) => string) => (value ? label(value) : t('detail.default'));
  const parts: string[] = [];
  if (after.model !== undefined) parts.push(t('detail.fixModel', { from: shown(before.model, modelShort), to: shown(after.model, modelShort) }));
  if (after.effort !== undefined) parts.push(t('detail.fixEffort', { from: shown(before.effort, effortLabel), to: shown(after.effort, effortLabel) }));
  return parts.join(' · ');
}

/** O que o ajuste vai mudar na ficha atual, em uma linha (seleção e confirmação). */
export function fixChange(fix: CostReviewFix, ficha: CostReview['ficha']): string {
  if (fix.kind === 'rule') return t('detail.fixRule', { text: fix.text });
  if (fix.kind === 'task') return t('detail.fixTask', { title: fix.title });
  return fichaChange({ model: ficha.model, effort: ficha.effort }, { model: fix.model, effort: fix.effort });
}

/** Motivos que o servidor devolve em pt-BR → texto no idioma da tela; motivo novo aparece como veio. */
const SKIP_REASONS: Record<string, MsgKey> = {
  'não dispara mais': 'detail.skip.gone',
  'sem ajuste automático': 'detail.skip.manual',
  'já aplicado': 'detail.skip.done',
  'limite de regras da ficha': 'detail.skip.rulesLimit',
};
export const skipReason = (reason: string): string => (SKIP_REASONS[reason] ? t(SKIP_REASONS[reason]!) : reason);

/** O que o aplicar fez, já em texto: a regra e a tarefa vêm do achado da análise que estava na tela (a resposta só traz o id). */
export interface ApplySummary {
  applied: Array<{ id: string; change: string; taskId?: string }>;
  skipped: Array<{ id: string; reason: string }>;
}

function appliedChange(a: CostReviewApplied, findings: CostReview['findings']): string {
  if (a.kind === 'ficha') return fichaChange(a.before ?? {}, a.after ?? {});
  const fix = findings.find((f) => f.id === a.id)?.fix;
  if (fix?.kind === 'rule') return t('detail.fixRule', { text: fix.text });
  if (fix?.kind === 'task') return t('detail.fixTaskDone', { title: fix.title });
  return '';
}

export function summarizeApply(result: CostReviewApplyResult, findings: CostReview['findings']): ApplySummary {
  return {
    applied: result.applied.map((a) => ({ id: a.id, change: appliedChange(a, findings), ...(a.taskId ? { taskId: a.taskId } : {}) })),
    skipped: result.skipped.map((s) => ({ id: s.id, reason: skipReason(s.reason) })),
  };
}

/** Os ajustes escolhidos mexem na ficha (modelo, esforço ou regras)? Só então vale o aviso das cópias e da conversa aberta. */
export const touchesFicha = (findings: CostReviewFinding[], picked: ReadonlySet<string>): boolean =>
  findings.some((f) => picked.has(f.id) && (f.fix?.kind === 'ficha' || f.fix?.kind === 'rule'));

/** Tokens abreviados no idioma da tela: 182000 → "182 mil" / "182K". */
export function formatTokens(tokens: number): string {
  return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);
}
