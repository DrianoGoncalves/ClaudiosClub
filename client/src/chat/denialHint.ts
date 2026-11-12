import type { ChatItem, DenialInfo } from '../../../shared/model';

export type DenialHint = NonNullable<DenialInfo['hint']>;

/** O aviso é de uma ferramenta negada que tem dica (`denial.hint`). */
export function denialHintOf(item: ChatItem): DenialHint | null {
  return item.kind === 'notice' ? (item.denial?.hint ?? null) : null;
}

/**
 * Ids dos avisos de negação que ainda pedem ação: sem mensagem de usuário depois deles.
 * Quem já escreveu (ou mandou "tente de novo") seguiu em frente, e o botão de um aviso antigo só confundiria.
 */
export function actionableDenials(items: readonly ChatItem[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user') break;
    if (denialHintOf(item)) ids.add(item.id);
  }
  return ids;
}
