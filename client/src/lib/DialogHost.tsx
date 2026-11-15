import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from '../chat/usageWarning';
import { t } from '../i18n';
import { onDialogRequest, type DialogRequest } from './dialogStore';

// O modal de askConfirm / showAlert (lib/dialogStore.ts), montado uma vez no App. Vários pedidos viram fila.
// Cancelar é o padrão de foco (como a trava de consumo): Enter sem querer não confirma uma exclusão.

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const req = queue[0] ?? null;

  useEffect(() => onDialogRequest((r) => setQueue((list) => [...list, r])), []);

  const answer = (ok: boolean) => {
    req?.resolve(ok);
    setQueue((list) => list.slice(1));
  };
  useEscape(!!req, () => answer(false));

  if (!req) return null;
  const confirm = req.kind === 'confirm';
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="modal usage-warning" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-text">
        <h2 id="dialog-title">{t(confirm ? 'app.dialogConfirmTitle' : 'app.dialogAlertTitle')}</h2>
        <p id="dialog-text" className="dialog-text">
          {req.text}
        </p>
        <div className="usage-warning-actions">
          {confirm && (
            <button type="button" className="btn-secondary" autoFocus onClick={() => answer(false)}>
              {t('app.dialogCancel')}
            </button>
          )}
          <button type="button" className="btn-primary" autoFocus={!confirm} onClick={() => answer(true)}>
            {t('app.dialogOk')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
