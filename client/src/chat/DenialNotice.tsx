import type { ChatItem } from '../../../shared/model';

/** O botão do aviso de negação: o rótulo, o que ele faz e se está ocupado (ou impedido, com o motivo no `title`). */
export interface DenialAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  title?: string;
}

/** Aviso de ferramenta negada: o texto do servidor e, conforme a dica, um botão com o que fazer a seguir. */
export function DenialNotice({ item, action }: { item: Extract<ChatItem, { kind: 'notice' }>; action: DenialAction | null }) {
  return (
    <div className={`chat-notice chat-notice-${item.tone}${action ? ' has-action' : ''}`} data-item-id={item.id}>
      <span>{item.text}</span>
      {action && (
        <button type="button" className="btn-secondary chat-notice-btn" disabled={action.disabled} title={action.title} onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
