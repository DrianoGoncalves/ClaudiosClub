import { useEffect, useState } from 'react';
import type { ChatItem } from '../../../shared/model';
import { t } from '../i18n';
import { parseRetryNotice, retryNoticeText, retryTickMs } from './retryNotice';

/**
 * Aviso da retomada automática no chat: o texto no idioma da página e, esperando, a contagem que desce sozinha: por segundo, com o
 * horário exato do servidor (`retry.at`); sem ele (aviso antigo), por minuto (ver `retryMinutesLeft`). O intervalo sai quando o aviso deixa de esperar.
 */
export function RetryNoticeBox({ item }: { item: Extract<ChatItem, { kind: 'notice' }> }) {
  const parsed = parseRetryNotice(item);
  const tick = retryTickMs(parsed);
  const [now, setNow] = useState(() => Date.now());
  const at = parsed?.state === 'waiting' ? parsed.at : null;
  useEffect(() => {
    if (!tick) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), tick);
    return () => window.clearInterval(timer);
  }, [tick, item.text, at]);
  if (!parsed) return null;
  return (
    <div className={`chat-notice chat-notice-${item.tone} chat-retry`} data-retry={parsed.state} data-item-id={item.id}>
      {retryNoticeText(parsed, now)}
      {parsed.state === 'waiting' && <span className="chat-retry-hint small">{t('chat.retryCancelHint')}</span>}
    </div>
  );
}
