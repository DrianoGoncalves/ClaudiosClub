import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UncommittedConversation, UncommittedFile, UncommittedReport } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// Arquivos sem commit do projeto, agrupados pela conversa que os editou. "Pedir commit" manda uma
// mensagem fixa para a conversa dela (o mesmo envio do chat): ela commita só o que é dela.

type Sent = { kind: 'sending' } | { kind: 'sent'; staffId: string; sessionId: string } | { kind: 'error'; message: string };

/** O texto do pedido: fixo, com a lista dos arquivos dela e, à parte, os que outra conversa também mexeu. */
function commitRequest(files: UncommittedFile[]): string {
  const shared = files.filter((f) => f.also.length > 0);
  const list = (xs: UncommittedFile[]) => xs.map((f) => `- ${f.path}`).join('\n');
  return [
    `${t('board.uncReqHead')}\n${list(files)}`,
    shared.length ? `${t('board.uncReqShared')}\n${list(shared)}` : '',
    t('board.uncReqRules'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function UncommittedPanel({
  projectId,
  projectName,
  onOpenConversation,
  onClose,
}: {
  projectId: string;
  projectName: string;
  onOpenConversation: (staffId: string, sessionId: string) => void;
  onClose: () => void;
}) {
  const [report, setReport] = useState<UncommittedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, Sent>>({});
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.gitUncommitted(projectId).then(setReport, (e: Error) => setError(e.message)).finally(() => setLoading(false));
  }, [projectId]);
  useEffect(load, [load]);

  // Foco no X ao abrir; ao fechar, volta para quem tinha o foco (o selo).
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => back?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = async (c: UncommittedConversation) => {
    if (!c.staffId) return;
    const staffId = c.staffId;
    setConfirming(null);
    setSent((s) => ({ ...s, [c.sessionId]: { kind: 'sending' } }));
    try {
      // A conversa pode ter virado outra (assunto fechado): o pedido segue para a que o servidor devolver.
      const r = await api.chatSend(projectId, { sessionId: c.sessionId, staffId, text: commitRequest(c.files) });
      setSent((s) => ({ ...s, [c.sessionId]: { kind: 'sent', staffId, sessionId: r.sessionId } }));
    } catch (e) {
      setSent((s) => ({ ...s, [c.sessionId]: { kind: 'error', message: (e as Error).message } }));
    }
  };

  // No body: o modal sai do nó do quadro (o selo fica dentro de uma sala do React Flow).
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal git-unc-modal" role="dialog" aria-label={t('board.uncTitle', { name: projectName })}>
        <header className="tasks-head">
          <h2>{t('board.uncTitle', { name: projectName })}</h2>
          <span className="tasks-head-actions">
            <button className="btn-secondary" disabled={loading} onClick={load}>
              {t('board.uncRefresh')}
            </button>
            <button ref={closeRef} className="drawer-close in-head" onClick={onClose} aria-label={t('board.uncClose')}>
              ×
            </button>
          </span>
        </header>
        <p className="muted small">{t('board.uncIntro')}</p>
        {!report && !error && <p className="muted small">{t('board.uncLoading')}</p>}
        {report && !report.total && <p className="muted small">{t('board.uncEmpty')}</p>}

        {report?.conversations.map((c) => {
          const s = sent[c.sessionId];
          return (
            <section className="git-unc-group" key={c.sessionId}>
              <div className="git-unc-head">
                <b>{c.name}</b>
                {c.topic && c.topic !== c.name && <span className="muted small"> · {c.topic}</span>}
                <span className="muted small"> · {t(c.files.length === 1 ? 'board.gitFileOne' : 'board.gitFileOther', { n: c.files.length })}</span>
              </div>
              <ul className="task-files small">
                {c.files.map((f) => (
                  <li key={f.path}>
                    <span className="mono">{f.path}</span>
                    {f.also.length > 0 && <span className="git-unc-also"> · {t('board.uncAlso', { names: f.also.join(', ') })}</span>}
                  </li>
                ))}
              </ul>
              <div className="task-code-row">
                {!c.staffId ? (
                  <span className="muted small">{t('board.uncNoStaff')}</span>
                ) : s?.kind === 'sent' ? (
                  <>
                    <span className="ok small">{t('board.uncSent')}</span>
                    <button className="btn-secondary" onClick={() => onOpenConversation(s.staffId, s.sessionId)}>
                      {t('board.uncOpen')}
                    </button>
                  </>
                ) : s?.kind === 'sending' ? (
                  <span className="muted small">{t('board.uncSending')}</span>
                ) : confirming === c.sessionId ? (
                  <>
                    <span className="small">{t('board.uncConfirm', { name: c.name, n: c.files.length })}</span>
                    <button className="btn-primary" onClick={() => void send(c)}>
                      {t('board.uncSend')}
                    </button>
                    <button className="btn-secondary" onClick={() => setConfirming(null)}>
                      {t('board.uncCancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn-primary" onClick={() => setConfirming(c.sessionId)}>
                      {t('board.uncAsk')}
                    </button>
                    {s?.kind === 'error' && <span className="error small">{s.message}</span>}
                  </>
                )}
              </div>
            </section>
          );
        })}

        {report && report.unowned.length > 0 && (
          <section className="git-unc-group">
            <div className="git-unc-head">
              <b>{t('board.uncUnowned')}</b>
              <span className="muted small"> · {t(report.unowned.length === 1 ? 'board.gitFileOne' : 'board.gitFileOther', { n: report.unowned.length })}</span>
            </div>
            <p className="muted small">{t('board.uncUnownedHint', { days: report.recentDays })}</p>
            <ul className="task-files small">
              {report.unowned.map((f) => (
                <li key={f.path}>
                  <span className="mono">{f.path}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </div>,
    document.body,
  );
}
