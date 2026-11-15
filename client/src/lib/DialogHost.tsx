import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import {
  answerHead,
  canDismissByBackdrop,
  DIALOG_ATTR,
  guardEscape,
  nextFocusIndex,
  onDialogRequest,
  type DialogRequest,
} from './dialogStore';

// O modal de askConfirm / showAlert (lib/dialogStore.ts), montado uma vez no App. Vários pedidos viram fila.
// Cancelar é o padrão de foco (como a trava de consumo): Enter sem querer não confirma uma exclusão.

export function DialogHost() {
  const [queue, setQueue] = useState<DialogRequest[]>([]);
  const req = queue[0] ?? null;

  const openedAt = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // O foco de antes é guardado na chegada do pedido, antes de o modal montar e puxar o foco (autoFocus).
  useEffect(
    () =>
      onDialogRequest((r) => {
        if (!returnFocus.current) returnFocus.current = document.activeElement as HTMLElement | null;
        setQueue((list) => [...list, r]);
      }),
    [],
  );

  // Funcional: responde a cabeça da lista de agora (ver answerHead).
  const answer = (ok: boolean) => setQueue((list) => answerHead(list, ok));
  const answerRef = useRef(answer);
  answerRef.current = answer;

  const id = req?.id;
  useEffect(() => {
    if (id === undefined) return;
    openedAt.current = Date.now();
  }, [id]);

  // Esc é só do modal, enquanto houver pedido.
  const open = !!req;
  useEffect(() => (open ? guardEscape(window, () => answerRef.current(false)) : undefined), [open]);

  // Ao esvaziar a fila, o foco volta para quem estava com ele.
  useEffect(() => {
    if (open) return;
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus();
  }, [open]);

  // Tab fica dentro do modal.
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
    const next = nextFocusIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  };

  if (!req) return null;
  const confirm = req.kind === 'confirm';
  return createPortal(
    <div
      key={req.id}
      className="modal-backdrop dialog-host"
      {...{ [DIALOG_ATTR]: '' }}
      onMouseDown={(e) => e.target === e.currentTarget && canDismissByBackdrop(openedAt.current, Date.now()) && answer(false)}
    >
      <div ref={box} onKeyDown={trapTab} className="modal usage-warning" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-text">
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
