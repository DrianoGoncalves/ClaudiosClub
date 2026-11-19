import type { Task } from '../../../shared/model';
import { t } from '../i18n';

// A linha de resumo da seção "Código, revisão e deploy" quando ela está recolhida: o que o dono olha primeiro (revisão e testes),
// lido só da tarefa, sem esperar o diff carregar.

/** Quem revisa e se já respondeu, com o veredito se veio. Vazio se não houve pedido. */
export function reviewLine(review: Task['review'], name: (staffId: string) => string): string {
  if (!review) return '';
  const who = name(review.staffId);
  const verdict = review.doneAt ? review.verdict : null;
  if (verdict) return t(verdict === 'approved' ? 'tasks.verdictApproved' : 'tasks.verdictRejected', { name: who });
  return `${who} · ${review.doneAt ? t('tasks.replied') : t('tasks.reviewing')}`;
}

/** Revisão (veredito ou revisor), testes e se já foi mesclada, nesta ordem; sem nada disso, uma frase de "ainda não". */
export function codeSummary(task: Pick<Task, 'review' | 'tests' | 'merged'>, name: (staffId: string) => string): string {
  const parts = [
    reviewLine(task.review, name),
    task.tests ? `${t('tasks.tests')}: ${t(task.tests.ok ? 'tasks.passed' : 'tasks.failed')}` : '',
    task.merged ? t('tasks.sumCodeMerged') : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : t('tasks.sumCodeNone');
}
