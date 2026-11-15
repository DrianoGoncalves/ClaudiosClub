import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '../../../shared/model';
import { useEscape } from '../chat/usageWarning';
import { t } from '../i18n';
import { applyToAll, choiceOf, deleteReady, dependentRows, dependentsMap, leavesWorkBehind, optionsOf, visibleRows, type DepChoice, type DepMap, type DepMode, type DepPicks, type DepTask } from './cancelDeps';

// Cancelar (ou apagar) uma tarefa, no modal do design system (como o aviso da trava de consumo e o dos hooks da skill): o motivo (só no
// cancelar) e, se há tarefas esperando por esta, uma árvore para escolher o destino de cada uma. A conta mora em `cancelDeps.ts`.

const REASON_MAX = 300;
/** A ordem em que as escolhas aparecem (a do select, a do "Aplicar a todas" e a das explicações). */
const ORDER: DepChoice[] = ['wait', 'release', 'cancel'];

const LABEL: Record<DepChoice, string> = { wait: t('tasks.depWait'), release: t('tasks.depRelease'), cancel: t('tasks.depCancel') };
const HELP: Record<DepChoice, string> = { wait: t('tasks.depHelpWait'), release: t('tasks.depHelpRelease'), cancel: t('tasks.depHelpCancel') };

interface Props {
  mode: DepMode;
  task: Pick<Task, 'id' | 'title' | 'status' | 'sessionId' | 'merged' | 'deploy'>;
  /** Todas as tarefas do projeto (a árvore sai de `blockedBy`). */
  tasks: DepTask[];
  nameOf: (staffId: string | null) => string | null;
  /** Faz o pedido. Se lançar, o erro aparece no diálogo e ele continua aberto; se voltar, ele fecha. */
  onConfirm: (input: { reason?: string; dependents: DepMap }) => Promise<void>;
  onClose: () => void;
}

export function TaskCloseDialog({ mode, task, tasks, nameOf, onConfirm, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [picks, setPicks] = useState<DepPicks>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(() => dependentRows(task.id, tasks), [task.id, tasks]);
  const shown = visibleRows(rows, picks, mode);
  const ready = mode === 'cancel' || deleteReady(rows, picks);
  const running = mode === 'cancel' && !!task.sessionId && (task.status === 'doing' || task.status === 'planning');
  // Já houve trabalho no mundo (em andamento, mescla ou deploy): cancelar não o desfaz.
  const notUndone = mode === 'cancel' && leavesWorkBehind(task);
  const offered = new Set(shown.flatMap((r) => optionsOf(r, mode)));
  useEscape(!busy, onClose);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ reason: reason.trim() || undefined, dependents: dependentsMap(rows, picks, mode) });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal usage-warning" role="alertdialog" aria-modal="true" aria-labelledby="task-close-title" aria-describedby="task-close-text">
        <h2 id="task-close-title">{mode === 'cancel' ? t('tasks.cancelTask') : t('tasks.deleteTask')}</h2>
        <p id="task-close-text">{t(mode === 'cancel' ? 'tasks.cancelDialogText' : 'tasks.deleteDialogText', { title: task.title })}</p>
        {running && <p className="muted small">{t('tasks.cancelRunning')}</p>}
        {notUndone && <p className="muted small">{t('tasks.cancelNotUndone')}</p>}
        {mode === 'cancel' && (
          <label>
            {t('tasks.cancelReasonLabel')}
            <input value={reason} maxLength={REASON_MAX} autoFocus placeholder={t('tasks.cancelReasonPlaceholder')} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        {rows.length > 0 && (
          <>
            <p>
              <strong>{t(mode === 'cancel' ? 'tasks.depsAsk' : 'tasks.depsAskDelete')}</strong>
            </p>
            {rows.length > 1 && (
              <p className="small">
                {t('tasks.depAll')}{' '}
                {ORDER.filter((c) => mode === 'cancel' || c !== 'wait').map((c, i) => (
                  <span key={c}>
                    {i > 0 && ' · '}
                    <button type="button" className="link small" disabled={busy} onClick={() => setPicks(applyToAll(rows, c))}>
                      {LABEL[c]}
                    </button>
                  </span>
                ))}
              </p>
            )}
            <ul className="skill-hooks">
              {shown.map((row) => {
                const choice = choiceOf(row, picks, mode);
                return (
                  <li key={row.task.id} style={{ marginLeft: (row.depth - 1) * 16 }}>
                    <strong>
                      {row.depth > 1 && <span aria-hidden="true">↳ </span>}
                      {row.task.title}
                    </strong>
                    <span className="muted small">
                      {nameOf(row.task.staffId) ?? t('tasks.noOwner')}
                      {row.children > 0 && choice !== 'cancel' && ` · ${t(row.children === 1 ? 'tasks.depBelowOne' : 'tasks.depBelowOther', { n: row.children })}`}
                      {!row.direct && row.parents.length > 1 && ` · ${t(row.parents.length === 2 ? 'tasks.depAlsoOne' : 'tasks.depAlsoOther', { n: row.parents.length - 1 })}`}
                    </span>
                    <select
                      className="task-move"
                      value={choice ?? ''}
                      disabled={busy}
                      aria-label={t('tasks.depChoiceLabel', { title: row.task.title })}
                      onChange={(e) => setPicks({ ...picks, [row.task.id]: e.target.value as DepChoice })}
                    >
                      {choice === null && (
                        <option value="" disabled>
                          {t('tasks.depPick')}
                        </option>
                      )}
                      {optionsOf(row, mode).map((c) => (
                        <option key={c} value={c}>
                          {LABEL[c]}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
            {ORDER.filter((c) => offered.has(c)).map((c) => (
              <p key={c} className="muted small">
                <strong>{LABEL[c]}:</strong> {HELP[c]}
              </p>
            ))}
            {shown.some((r) => r.depth > 1) && <p className="muted small">{t('tasks.depsNested')}</p>}
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="usage-warning-actions">
          <button type="button" className="btn-secondary" autoFocus={mode === 'delete'} disabled={busy} onClick={onClose}>
            {t('tasks.back')}
          </button>
          <button
            type="button"
            className="btn-secondary is-danger"
            disabled={busy || !ready}
            title={ready ? undefined : t('tasks.deletePickHint')}
            onClick={() => void submit()}
          >
            {busy ? t(mode === 'cancel' ? 'tasks.cancelling' : 'tasks.deleting') : t(mode === 'cancel' ? 'tasks.cancelTask' : 'tasks.deleteTask')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
