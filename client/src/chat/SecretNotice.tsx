import { useState } from 'react';
import type { InboxItem } from '../../../shared/model';
import { t } from '../i18n';
import { inboxText } from '../inbox/inboxText';
import { secretFileOf } from './secretAlerts';
import { SecretVerdictRow } from './SecretVerdictRow';

/**
 * O aviso de segredo da caixa "precisa de mim" como balão na conversa onde ele apareceu: a mesma frase e o mesmo "ignorar".
 * Com o palpite do servidor (`secret.verdict`), traz o selo (real ou falso positivo), a dica mascarada e o "por quê?" (ver `SecretVerdictRow`);
 * em "possível credencial exposta" o botão se chama "Já troquei", não "Ignorar". Quando o servidor diz em que arquivo o segredo está (`secret.file`), o balão mostra o caminho e, se o editor do Club abre esse arquivo,
 * o botão que o abre; arquivo que a tela recusa (.env, chave) fica só com o caminho e o "abra no seu editor".
 * Só existe na tela: não é mensagem da conversa, o modelo nunca vê. O valor do segredo não chega aqui (o item só traz tipo, contexto, origem, caminho, o palpite e a dica mascarada: no máximo 4 caracteres do valor).
 * O aviso de erro da caixa (`kind: 'error'`) usa o mesmo balão, em vermelho e com a frase do servidor, e o mesmo "Ignorar" (o servidor guarda o carimbo do erro dispensado); sem `onIgnore`, não há botão.
 */
export function SecretNotice({ item, onIgnore, onOpenFile }: { item: InboxItem; onIgnore?: (item: InboxItem) => Promise<void>; onOpenFile?: (path: string) => void }) {
  const [busy, setBusy] = useState(false);
  const ignore = async () => {
    setBusy(true);
    try {
      await onIgnore?.(item);
    } finally {
      setBusy(false);
    }
  };
  return <SecretNoticeView item={item} busy={busy} onIgnore={onIgnore ? () => void ignore() : undefined} onOpenFile={onOpenFile} />;
}

/** O balão sem estado (testável sem navegador): `busy` trava o Ignorar enquanto o servidor responde; sem `onIgnore`, o botão não aparece. */
export function SecretNoticeView({ item, busy, onIgnore, onOpenFile }: { item: InboxItem; busy: boolean; onIgnore?: () => void; onOpenFile?: (path: string) => void }) {
  const isError = item.kind === 'error';
  const file = isError ? null : secretFileOf(item);
  // Possível credencial exposta: o botão não diz "Ignorar" (não sugere deixar pra lá); o que ele faz é o mesmo do "já troquei".
  const exposed = !isError && item.secret?.verdict === 'exposed';
  return (
    <div className={`permission secret-notice${isError ? ' is-error' : ''}`} role="alert" data-item-id={item.id}>
      <p className="small">{inboxText(item)}</p>
      {!isError && <SecretVerdictRow item={item} />}
      {file && (
        <p className="small secret-file">
          <code>{file.path}</code>
          {file.blocked && <span className="muted"> · {t('chat.secretFileBlocked')}</span>}
        </p>
      )}
      {(onIgnore || (file && !file.blocked && onOpenFile)) && (
        <div className="actions">
          {file && !file.blocked && onOpenFile && (
            <button type="button" className="btn-secondary" title={t('chat.secretOpenFileTitle', { path: file.path })} onClick={() => onOpenFile(file.path)}>
              {t('chat.secretOpenFile')}
            </button>
          )}
          {onIgnore && (
            <button type="button" className="btn-secondary" disabled={busy} title={t(isError ? 'chat.errorIgnoreTitle' : exposed ? 'chat.secretIgnoreExposedTitle' : 'chat.secretIgnoreTitle')} onClick={onIgnore}>
              {t(exposed ? 'chat.secretIgnoreExposed' : 'chat.secretIgnore')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
