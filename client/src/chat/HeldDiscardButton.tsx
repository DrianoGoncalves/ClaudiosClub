import type { ChatItem } from '../../../shared/model';
import { t } from '../i18n';
import { heldDiscardOf } from './heldDiscard';

/** "Excluir" na mensagem guardada pelo Claudio’s Club. Só aparece quando o servidor diz que dá para excluir (a resposta a uma dúvida, não). */
export function HeldDiscardButton({ item, busy, onDiscard }: { item: ChatItem; busy: boolean; onDiscard?: (item: ChatItem) => void }) {
  if (!onDiscard || !heldDiscardOf(item)) return null;
  return (
    <button type="button" className="btn-secondary msg-held-discard" disabled={busy} title={t('chat.heldDiscardHelp')} onClick={() => onDiscard(item)}>
      {t('chat.heldDiscard')}
    </button>
  );
}
