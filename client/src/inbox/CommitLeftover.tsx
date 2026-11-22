import { useCallback, useEffect, useState } from 'react';
import type { CommitLeftovers } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { COMMIT_FILES_SHOWN, leftWhy, type CommitAlert } from './commitAlert';

// O corpo do aviso de commit parcial na caixa (ver commitAlert.ts): os arquivos de fora com o motivo e os botões. Hierarquia do design system (docs/design-system.md): secundária à esquerda,
// primária à direita (no celular, largura toda e embaixo). `ready`: "Ignorar" e "Revisar sobras" (a lista, o diff e a confirmação; a recusa do servidor aparece com o motivo). `failed`: "Ignorar" e "Abrir card".
// "Ignorar" só dispensa o aviso. O servidor é quem decide o que entra no commit: aqui só se mostra o preview e se devolve o `digest` que o dono viu.

interface Props {
  projectId: string;
  alert: CommitAlert;
  /** Dispensa o aviso (nada é commitado nem desfeito). */
  onIgnore: () => void;
  onOpenCard: () => void;
  /** Depois de commitar: a caixa relê. */
  onChanged: () => Promise<void>;
  /** A frase do resultado ("Commit abc1234 feito…"): o item some da lista, então ela fica no topo do menu. */
  onDone: (text: string) => void;
}

export function CommitLeftoverBody({ projectId, alert, onIgnore, onOpenCard, onChanged, onDone }: Props) {
  const [reviewing, setReviewing] = useState(false);
  const panelId = `inbox-commit-${alert.taskId}`;
  const shown = alert.files.slice(0, COMMIT_FILES_SHOWN);
  const more = alert.files.length - shown.length;
  return (
    <div className="inbox-commit">
      {shown.length > 0 && (
        <ul className="inbox-commit-files">
          {shown.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code> · {leftWhy(f, alert.state)}
              {!!f.cancelledBy?.length && <span className="muted"> · {t('inbox.commit.cancelledBy', { ids: f.cancelledBy.join(', ') })}</span>}
            </li>
          ))}
          {more > 0 && <li className="muted">{t('inbox.commit.moreFiles', { n: more })}</li>}
        </ul>
      )}
      <div className="inbox-commit-actions">
        <button className="btn-secondary" title={t('inbox.commit.ignoreTitle')} onClick={onIgnore}>
          {t('inbox.commit.ignore')}
        </button>
        {alert.state === 'ready' ? (
          <button className={reviewing ? 'btn-secondary' : 'btn-primary'} title={t('inbox.commit.reviewTitle')} aria-expanded={reviewing} aria-controls={panelId} onClick={() => setReviewing(!reviewing)}>
            {t('inbox.commit.review')}
          </button>
        ) : (
          <button className="btn-primary" title={t('inbox.commit.openCardTitle')} onClick={onOpenCard}>
            {t('inbox.commit.openCard')}
          </button>
        )}
      </div>
      {alert.state === 'ready' && reviewing && <LeftoversPanel id={panelId} projectId={projectId} alert={alert} onClose={() => setReviewing(false)} onChanged={onChanged} onDone={onDone} />}
    </div>
  );
}

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; preview: CommitLeftovers };

/** O painel de "Revisar sobras": lê o preview (disco e git de agora) ao abrir, e relê quando o servidor recusa por o conteúdo ter mudado. */
export function LeftoversPanel({ id, projectId, alert, onClose, onChanged, onDone }: { id: string; projectId: string; alert: CommitAlert; onClose: () => void; onChanged: () => Promise<void>; onDone: (text: string) => void }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', preview: await api.commitLeftovers(projectId, alert.taskId) });
    } catch (e) {
      setLoad({ kind: 'error', message: (e as Error).message });
    }
  }, [projectId, alert.taskId]);

  useEffect(() => {
    void read();
  }, [read]);

  const redo = async (preview: CommitLeftovers) => {
    if (busy) return;
    const n = preview.files.filter((f) => f.redo).length;
    if (!(await askConfirm(t('inbox.commit.confirm', { n, task: alert.taskTitle }), t('inbox.commit.redo')))) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.redoCommitLeftovers(projectId, alert.taskId, preview.digest);
      onDone(t('inbox.commit.done', { sha: done.sha.slice(0, 7), n: done.files.length }) + (done.left.length ? t('inbox.commit.doneLeft', { n: done.left.length }) : ''));
      onClose();
      await onChanged();
    } catch (e) {
      // A recusa (409: arquivos mudaram, card voltou a mexer, git recusou) chega com o motivo; o preview é relido para o próximo clique valer.
      setError((e as Error).message);
      await read();
    } finally {
      setBusy(false);
    }
  };

  if (load.kind === 'loading') return <p id={id} className="muted small inbox-commit-panel" role="status">{t('inbox.commit.loading')}</p>;
  if (load.kind === 'error') {
    return (
      <p id={id} className="error small inbox-commit-panel" role="alert">
        {t('inbox.commit.loadFailed', { error: load.message })}
      </p>
    );
  }
  return <LeftoversView id={id} preview={load.preview} alert={alert} busy={busy} error={error} onRedo={() => void redo(load.preview)} onClose={onClose} />;
}

/** O que seria commitado: arquivo a arquivo (letra do git, motivo e o diff, que é texto de arquivo e sai como texto puro), e os botões. Pura: o painel acima a alimenta. */
export function LeftoversView({ id, preview, alert, busy, error, onRedo, onClose }: { id: string; preview: CommitLeftovers; alert: CommitAlert; busy: boolean; error: string | null; onRedo: () => void; onClose: () => void }) {
  const takes = preview.files.filter((f) => f.redo).length;
  const canRedo = preview.canRedo && takes > 0;
  return (
    <section id={id} className="inbox-commit-panel" aria-label={t('inbox.commit.panelTitle', { head: preview.head })}>
      <p className="small inbox-commit-head">
        <b>{t('inbox.commit.panelTitle', { head: preview.head })}</b>
      </p>
      {preview.blockers.length > 0 && <p className="small">{t('inbox.commit.blockedBy', { ids: preview.blockers.map((b) => b.id).join(', ') })}</p>}
      {!canRedo && preview.blockers.length === 0 && <p className="small">{t('inbox.commit.cannotRedo')}</p>}
      <ul className="inbox-commit-diffs">
        {preview.files.map((f) => (
          <li key={f.path}>
            <p className="small inbox-commit-file">
              <span className="inbox-commit-letter" title={t(`inbox.commit.status.${f.status}`)}>
                {f.status}
              </span>{' '}
              <code>{f.path}</code>
              <span className="muted"> · {f.redo ? t('inbox.commit.takes') : `${t('inbox.commit.keeps')} (${leftWhy(f, alert.state)})`}</span>
            </p>
            {f.redo && <FileDiff diff={f.diff} binary={f.binary} truncated={f.diffTruncated} />}
          </li>
        ))}
      </ul>
      {preview.dropped.length > 0 && <p className="muted small">{t('inbox.commit.dropped', { n: preview.dropped.length })}</p>}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="inbox-commit-actions">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>
          {t('inbox.commit.close')}
        </button>
        <button className="btn-primary" disabled={busy || !canRedo} onClick={onRedo}>
          {busy ? t('inbox.commit.redoBusy') : t('inbox.commit.redo')}
        </button>
      </div>
    </section>
  );
}

function FileDiff({ diff, binary, truncated }: { diff: string; binary?: true; truncated?: true }) {
  if (binary) return <p className="muted small inbox-commit-note">{t('inbox.commit.diffBinary')}</p>;
  if (!diff) return <p className="muted small inbox-commit-note">{t('inbox.commit.diffEmpty')}</p>;
  return (
    <details className="inbox-commit-diff">
      <summary>{t('inbox.commit.diffShow')}</summary>
      <pre tabIndex={0}>{diff}</pre>
      {truncated && <p className="muted small">{t('inbox.commit.diffTruncated')}</p>}
    </details>
  );
}
