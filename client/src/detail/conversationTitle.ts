import { t } from '../i18n';

/** Id da conversa → título que o user deu a ela; é o `conversationTitles` do config. */
export type ConversationTitles = Record<string, string>;

/** O título manual da conversa (sem entrada, ou em branco, não há). */
export function manualTitle(id: string, manual?: ConversationTitles): string | null {
  const own = manual && Object.prototype.hasOwnProperty.call(manual, id) ? manual[id]?.trim() : '';
  return own || null;
}

/** O título de uma conversa de revisão: o nome da coluna Revisão do quadro, no idioma da tela, e a tarefa (sem título da tarefa, não há). */
export function reviewTitle(task?: string | null): string | null {
  const name = task?.trim();
  return name ? `${t('tasks.statusReview')} - ${name}` : null;
}

/**
 * O título que a lista mostra: o manual, senão o da revisão (`reviewTask`: "<coluna Revisão> - <tarefa>"), senão o gerado
 * por IA (`aiTitle`, que chega depois: até lá, ou sem ele, vale o assunto), senão o último assunto (`topic`), senão o
 * `title`. Quem lista as conversas da ficha não passa `title`: no Claude Code e no Codex ele é o nome do funcionário, só
 * serve de reserva às soltas.
 */
export function conversationTitle(
  c: { id: string; reviewTask?: string | null; aiTitle?: string | null; topic?: string | null; title?: string | null },
  manual?: ConversationTitles,
): string | null {
  return manualTitle(c.id, manual) ?? reviewTitle(c.reviewTask) ?? (c.aiTitle?.trim() || c.topic?.trim() || c.title?.trim() || null);
}

/**
 * O que gravar ao salvar o campo do "Renomear": `undefined` = nada mudou (não chama o servidor), `null` = volta ao título
 * automático, texto = o novo título manual. `shown` é o título que estava na lista ao abrir o campo.
 */
export function titleToSave(draft: string, shown: string | null, hasManual: boolean): string | null | undefined {
  const title = draft.trim();
  if (!title) return hasManual ? null : undefined;
  return title === (shown ?? '').trim() ? undefined : title;
}
