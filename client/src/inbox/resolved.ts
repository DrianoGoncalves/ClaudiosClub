import type { InboxItem } from '../../../shared/model';

// Aviso de erro cujo problema já passou (`InboxItem.resolvedAt`, marcado pelo servidor): fica na caixa com o selo "Resolvido" até ser ignorado, mas não é pendência.

export const isResolved = (item: InboxItem): boolean => !!item.resolvedAt;

/** O que de fato espera o dono: a lista sem os avisos já resolvidos (sino, título da página, abas e cartão amarelo contam só isto). */
export const pendingOf = (items: ReadonlyArray<InboxItem>): InboxItem[] => items.filter((i) => !isResolved(i));
