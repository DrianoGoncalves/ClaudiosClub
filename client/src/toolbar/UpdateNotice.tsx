import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UpdateStatus } from '../../../shared/model';
import { api } from '../api';
import { formatAgo } from '../format';
import { t } from '../i18n';

// Versões do Claudio’s Club publicadas no GitHub (tags vX.Y.Z): "Nova versão" no topo do quadro quando há uma mais
// nova que a daqui, e o item "Atualizações" nas configurações. Atualizar avança o código até ela (só fast-forward,
// no servidor) e, com o vigia, reinicia; a página recarrega quando o servidor novo responde.

/** Status guardado no servidor (ele busca no GitHub ao subir e a cada 6 h); relido aqui a cada 30 min. */
export function useUpdateStatus(): [UpdateStatus | null, (s: UpdateStatus) => void] {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    const load = () => api.updateStatus().then(setStatus, () => {});
    load();
    const timer = setInterval(load, 30 * 60_000);
    return () => clearInterval(timer);
  }, []);
  return [status, setStatus];
}

/** Por que não dá para atualizar por aqui; null quando dá. */
function blockedReason(s: UpdateStatus): string | null {
  if (s.dirty) return t('toolbar.updateDirty');
  if (s.diverged) return t('toolbar.updateDiverged', { latest: s.latest ?? '' });
  return null;
}

/** O botão que atualiza, com a confirmação e a tela de "atualizando" por cima de tudo. */
function UpdateButton({ status }: { status: UpdateStatus }) {
  const [state, setState] = useState<'idle' | 'updating' | 'updated'>('idle');
  const [done, setDone] = useState<{ from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const daemon = !!status.daemon;

  const run = async () => {
    const info = await api.serverInfo().catch(() => null);
    const working = info?.working;
    const cut = [
      working?.busy ? t('toolbar.cutBusy', { n: working.busy }) : '',
      working?.background ? t('toolbar.cutBackground', { n: working.background }) : '',
    ].filter(Boolean);
    const warn = daemon && cut.length ? `\n\n${t('toolbar.warnCut', { cut: cut.join(` ${t('toolbar.and')} `) })}` : '';
    if (!window.confirm((daemon ? t('toolbar.askUpdate') : t('toolbar.askUpdateNoDaemon')) + warn)) return;
    setError(null);
    setState('updating');
    let result: Awaited<ReturnType<typeof api.applyUpdate>>;
    try {
      result = await api.applyUpdate();
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
      return;
    }
    if (!result.restarting) {
      setDone(result);
      setState('updated');
      return;
    }
    // Espera o servidor novo (outro startedAt): o vigia ainda refaz o build do cliente antes de subir.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const now = await api.serverInfo().catch(() => null);
      if (now && now.startedAt !== info?.startedAt) return window.location.reload();
    }
    setError(t('toolbar.updateNotBack'));
    setState('idle');
  };

  return (
    <>
      <button type="button" className="btn-primary" disabled={state !== 'idle' || !!blockedReason(status)} onClick={() => void run()}>
        {daemon ? t('toolbar.updateBtn') : t('toolbar.updateBtnNoDaemon')}
      </button>
      {error && <span className="error small">{error}</span>}
      {state !== 'idle' &&
        createPortal(
          <div className="server-overlay" role="alertdialog" aria-live="assertive">
            <div className="server-overlay-card">
              {state === 'updating' && (
                <>
                  <h2>{t('toolbar.updatingTitle')}</h2>
                  <p>{daemon ? t('toolbar.updatingBody') : t('toolbar.updatingBodyNoDaemon')}</p>
                </>
              )}
              {state === 'updated' && done && (
                <>
                  <h2>{t('toolbar.updatedTitle', { from: done.from, to: done.to })}</h2>
                  <p>{t('toolbar.updatedRestart')}</p>
                  <span>
                    <button type="button" className="btn-secondary" onClick={() => setState('idle')}>
                      {t('toolbar.updateClose')}
                    </button>
                  </span>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** As notas da versão, o que entra (assunto dos commits), o motivo de não poder atualizar e o botão. */
function UpdateDetails({ status }: { status: UpdateStatus }) {
  const blocked = blockedReason(status);
  const more = status.behind - status.commits.length;
  return (
    <>
      {status.notes && <p className="update-notes">{status.notes}</p>}
      <ul className="update-commits">
        {status.commits.map((c) => (
          <li key={c.hash}>
            <code>{c.hash}</code> {c.subject}
          </li>
        ))}
        {more > 0 && <li className="muted">{t('toolbar.updateMore', { n: more })}</li>}
      </ul>
      {blocked && <p className="muted small">{blocked}</p>}
      {!blocked && !status.daemon && <p className="muted small">{t('toolbar.updateNoDaemon')}</p>}
      <span className="setting-buttons">
        <UpdateButton status={status} />
      </span>
    </>
  );
}

/** "Nova versão" no topo do quadro; some quando está em dia. */
export function UpdateNotice() {
  const [status] = useUpdateStatus();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!status?.supported || status.behind === 0) return null;
  const title = t('toolbar.updateAvailable', { latest: status.latest ?? '', current: status.current ?? '?' });
  return (
    <div className="update-notice" ref={root}>
      <button className="update-button" aria-haspopup="dialog" aria-expanded={open} title={title} onClick={() => setOpen(!open)}>
        {t('toolbar.updateBadge')}
      </button>
      {open && (
        <div className="update-menu" role="dialog" aria-label={t('toolbar.updateMenuTitle')}>
          <strong>{title}</strong>
          <UpdateDetails status={status} />
        </div>
      )}
    </div>
  );
}

/** O item "Atualizações" das configurações: em dia ou não, procurar agora e atualizar. */
export function UpdateControls() {
  const [status, setStatus] = useUpdateStatus();
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await api.updateStatus(true).then(setStatus, () => {});
    setChecking(false);
  };

  if (!status) return null;
  if (!status.supported) return <span className="muted small">{t('toolbar.updateUnsupported')}</span>;
  const versions = { latest: status.latest ?? '', current: status.current ?? '?' };
  const summary = !status.latest
    ? t('toolbar.updateNoRelease', versions)
    : status.behind === 0
      ? t('toolbar.updateUpToDate', versions)
      : t('toolbar.updateAvailable', versions);
  const checked = status.checkedAt ? ` · ${t('toolbar.updateChecked', { ago: formatAgo(Date.now() - Date.parse(status.checkedAt)) })}` : '';
  return (
    <>
      <span className="setting-buttons">
        <button type="button" className="btn-secondary" disabled={checking} onClick={() => void check()}>
          {checking ? t('toolbar.updateChecking') : t('toolbar.updateCheckBtn')}
        </button>
        <span className="muted small">
          {summary}
          {checked}
        </span>
      </span>
      {status.error && <span className="error small">{t('toolbar.updateFetchError', { error: status.error })}</span>}
      {status.behind > 0 && <UpdateDetails status={status} />}
    </>
  );
}
