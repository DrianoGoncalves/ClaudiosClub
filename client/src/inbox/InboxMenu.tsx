import { useEffect, useRef, useState } from 'react';
import type { InboxItem } from '../../../shared/model';
import { formatAgo } from '../format';
import type { InboxView } from './useInbox';

// Botão "precisa de mim" no topo do quadro, com o contador, e a lista que abre embaixo dele.
// Clicar num item abre o painel de quem está esperando.

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  plan: 'plano',
  permission: 'permissão',
  secret: 'segredo',
  waiting: 'esperando',
  error: 'erro',
  routine: 'rotina',
  orphan: 'sem dono',
};

export function InboxMenu({ inbox, onOpen }: { inbox: InboxView; onOpen: (item: InboxItem) => void }) {
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
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      clearInterval(t);
    };
  }, [open]);

  return (
    <div className="inbox" ref={root}>
      <button
        className={`inbox-button ${count ? 'inbox-has' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={count ? `${count} ${count === 1 ? 'coisa espera' : 'coisas esperam'} você` : 'Nada espera você agora'}
        onClick={() => setOpen(!open)}
      >
        precisa de mim
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && (
        <div className="inbox-menu" role="menu">
          {count === 0 ? (
            <p className="muted small inbox-empty">Nada espera você agora.</p>
          ) : (
            <ul className="inbox-list">
              {inbox.items.map((item) => (
                <li key={item.id}>
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
                    <span className="inbox-summary">{item.summary}</span>
                    {item.at && <span className="muted small inbox-at">{formatAgo(now - Date.parse(item.at))}</span>}
                  </button>
                  {item.kind === 'secret' && (
                    <button
                      className="link small inbox-dismiss"
                      title="Já troquei a senha/token: tirar o aviso"
                      onClick={() => void inbox.dismiss(item)}
                    >
                      já troquei
                    </button>
                  )}
                  {item.kind === 'routine' && (
                    <button className="link small inbox-dismiss" title="Tirar o aviso" onClick={() => void inbox.dismiss(item)}>
                      ok, vi
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {inbox.canNotify && (
            <label
              className="check small inbox-notify"
              title="Uma notificação do sistema a cada item novo, e quando alguém termina o trabalho, mesmo com o MyCo em segundo plano"
            >
              <input type="checkbox" checked={inbox.notify} onChange={(e) => void inbox.setNotify(e.target.checked)} /> avisar no sistema (inclusive
              quando alguém termina)
            </label>
          )}
        </div>
      )}
    </div>
  );
}
