import { useEffect, useRef, useState } from 'react';
import type { InboxItem } from '../../../shared/model';
import { formatAgo } from '../format';
import { t } from '../i18n';
import type { InboxView } from './useInbox';

// Botão "precisa de mim" no topo do quadro, com o contador, e a lista que abre embaixo dele.
// Clicar num item abre o painel de quem está esperando.

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  plan: t('inbox.kindPlan'),
  permission: t('inbox.kindPermission'),
  secret: t('inbox.kindSecret'),
  waiting: t('inbox.kindWaiting'),
  error: t('inbox.kindError'),
  routine: t('inbox.kindRoutine'),
  orphan: t('inbox.kindOrphan'),
};

/** Itens que só se dispensam ganham um X no canto; o title explica o que o X faz. Segredo tem duas ações, com texto. */
function dismissTitleOf(item: InboxItem): string | null {
  if (item.id.startsWith('question:')) return t('office.questionSeenTitle');
  if (item.id.startsWith('waiting:')) return t('inbox.dismissWaitingTitle');
  if (item.kind === 'routine') return t('inbox.dismissTitle');
  return null;
}

export function InboxMenu({
  inbox,
  topicOf,
  onOpen,
}: {
  inbox: InboxView;
  /** Assunto da conversa por sessionId; sem assunto conhecido, o item não mostra a linha. */
  topicOf: ReadonlyMap<string, string>;
  onOpen: (item: InboxItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const count = inbox.items.length;

  // Fecha ao clicar fora ou apertar Esc; o "há X min" acompanha o relógio.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      clearInterval(timer);
    };
  }, [open]);

  return (
    <div className="inbox" ref={root}>
      <button
        className={`inbox-button ${count ? 'inbox-has' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={count ? t(count === 1 ? 'inbox.countOne' : 'inbox.countOther', { count }) : t('inbox.nothingTitle')}
        onClick={() => setOpen(!open)}
      >
        {t('inbox.button')}
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && (
        <div className="inbox-menu" role="menu">
          {count === 0 ? (
            <p className="muted small inbox-empty">{t('inbox.nothingBody')}</p>
          ) : (
            <ul className="inbox-list">
              {inbox.items.map((item) => {
                const dismissTitle = dismissTitleOf(item);
                const topic = topicOf.get(item.sessionId);
                return (
                <li key={item.id} className={dismissTitle ? 'inbox-has-x' : undefined}>
                  <button
                    role="menuitem"
                    className={`inbox-item inbox-${item.kind}`}
                    onClick={() => {
                      setOpen(false);
                      onOpen(item);
                    }}
                  >
                    <span className="inbox-kind">{KIND_LABEL[item.kind]}</span>
                    <span className="inbox-who">
                      <b>{item.name}</b>
                      {item.projectName && <span className="muted"> · {item.projectName}</span>}
                    </span>
                    {topic && <span className="inbox-topic" title={topic}>{topic}</span>}
                    <span className="inbox-summary">{item.summary}</span>
                    {item.at && <span className="muted small inbox-at">{formatAgo(now - Date.parse(item.at))}</span>}
                  </button>
                  {item.kind === 'secret' && (
                    <span className="inbox-dismiss">
                      <button className="link small" title={t('inbox.secretTitle')} onClick={() => void inbox.dismiss(item)}>
                        {t('inbox.secretDone')}
                      </button>
                      <button className="link small" title={t('office.notSecretTitle')} onClick={() => void inbox.dismiss(item, { notSecret: true })}>
                        {t('office.notSecret')}
                      </button>
                    </span>
                  )}
                  {dismissTitle && (
                    <button className="drawer-close inbox-x" title={dismissTitle} aria-label={t('inbox.dismiss')} onClick={() => void inbox.dismiss(item)}>
                      ×
                    </button>
                  )}
                </li>
                );
              })}
            </ul>
          )}
          {inbox.canNotify && (
            <label
              className="check small inbox-notify"
              title={t('inbox.notifyTitle')}
            >
              <input type="checkbox" checked={inbox.notify} onChange={(e) => void inbox.setNotify(e.target.checked)} /> {t('inbox.notifyLabel')}
            </label>
          )}
        </div>
      )}
    </div>
  );
}
