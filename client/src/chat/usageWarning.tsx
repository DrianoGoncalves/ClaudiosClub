import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { engineName, otherEngine } from '../staff/fallbackEngine';
import {
  FALLBACK_NOTICE_EVENT,
  hideFallbackNotice,
  onUsageStopAsk,
  type FallbackNotice,
  type UsageStopAsk,
} from './usageNotice';

// Os avisos da trava de consumo no modal do design system (nunca window.alert/confirm). Montados uma vez no App.

/** Esc fecha o modal aberto. */
function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);
}

/** A mensagem foi para o motor secundário: motor, modelo e o motivo (limite de uso do principal). */
export function FallbackWarningBody({ notice, onClose, onHide }: { notice: FallbackNotice; onClose: () => void; onHide: () => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal usage-warning" role="dialog" aria-modal="true" aria-labelledby="fallback-warning-title">
        <h2 id="fallback-warning-title">{t('chat.fallbackNoticeTitle')}</h2>
        <p>
          {t('chat.fallbackNoticeText', {
            name: notice.name,
            engine: t(engineName(notice.engine)),
            model: notice.model,
            from: t(engineName(otherEngine(notice.engine))),
          })}
        </p>
        <div className="usage-warning-actions">
          <button type="button" className="btn-secondary" onClick={onHide}>{t('chat.fallbackDontWarn')}</button>
        </div>
        <button type="button" className="drawer-close" autoFocus onClick={onClose} aria-label={t('app.closeNotice')}>×</button>
      </div>
    </div>
  );
}

/** A trava de consumo barrou (409): o motivo e "Seguir mesmo assim?". Cancelar é o padrão (foco, Esc, clique fora). */
export function UsageStopBody({ text, onAnswer }: { text: string; onAnswer: (go: boolean) => void }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onAnswer(false)}>
      <div className="modal usage-warning" role="alertdialog" aria-modal="true" aria-labelledby="usage-stop-title" aria-describedby="usage-stop-text">
        <h2 id="usage-stop-title">{t('app.usageStopTitle')}</h2>
        <p id="usage-stop-text">{text}</p>
        <p><strong>{t('app.continueAnyway')}</strong></p>
        <div className="usage-warning-actions">
          <button type="button" className="btn-secondary" autoFocus onClick={() => onAnswer(false)}>{t('app.usageStopCancel')}</button>
          <button type="button" className="btn-primary" onClick={() => onAnswer(true)}>{t('app.usageStopGo')}</button>
        </div>
      </div>
    </div>
  );
}

export function UsageWarnings() {
  const [notice, setNotice] = useState<FallbackNotice | null>(null);
  const [asks, setAsks] = useState<UsageStopAsk[]>([]);
  const ask = asks[0] ?? null;

  useEffect(() => {
    const show = (event: Event) => setNotice((event as CustomEvent<FallbackNotice>).detail);
    window.addEventListener(FALLBACK_NOTICE_EVENT, show);
    return () => window.removeEventListener(FALLBACK_NOTICE_EVENT, show);
  }, []);
  useEffect(() => onUsageStopAsk((a) => setAsks((list) => [...list, a])), []);

  const answer = (go: boolean) => {
    ask?.answer(go);
    setAsks((list) => list.slice(1));
  };
  useEscape(!!ask, () => answer(false));
  useEscape(!!notice && !ask, () => setNotice(null));

  if (ask) return createPortal(<UsageStopBody text={ask.text} onAnswer={answer} />, document.body);
  if (!notice) return null;
  return createPortal(
    <FallbackWarningBody
      notice={notice}
      onClose={() => setNotice(null)}
      onHide={() => {
        hideFallbackNotice(notice.projectId);
        setNotice(null);
      }}
    />,
    document.body,
  );
}
