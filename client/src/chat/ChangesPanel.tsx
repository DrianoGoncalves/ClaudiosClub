import { useCallback, useEffect, useState } from 'react';
import type { ChatChanges, TestRun } from '../../../shared/model';
import { api, ApiError } from '../api';
import { BranchIcon } from '../icons';
import { t } from '../i18n';

// "O que mudou" na conversa: na worktree do funcionário, tudo desde a base (com mesclar); no
// próprio projeto, só os arquivos que ele editou nesta conversa. Testes rodam onde está o código.

const STATUS: Record<string, string> = {
  A: t('chat.stNew'),
  M: t('chat.stModified'),
  D: t('chat.stDeleted'),
  R: t('chat.stRenamed'),
  C: t('chat.stCopied'),
  '?': t('chat.stUntracked'),
};

export function ChangesPanel({ projectId, sessionId, staffId, name, onClose }: { projectId: string; sessionId: string; staffId: string | null; name: string; onClose: () => void }) {
  const [code, setCode] = useState<ChatChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<TestRun | null>(null);
  const [merged, setMerged] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.chatChanges(projectId, sessionId, staffId).then(setCode, (e: Error) => setError(e.message));
  }, [projectId, sessionId, staffId]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const merge = () =>
    run('merge', async () => {
      if (!code?.base || !window.confirm(t('chat.mergeConfirm', { branch: code.branch ?? '?', base: code.base }))) return;
      try {
        const r = await api.chatMerge(projectId, sessionId, staffId);
        setMerged(t('chat.mergedIn', { base: r.base, sha: r.sha }));
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'no-tests') throw e;
        if (!window.confirm(t('chat.mergeNoTests', { message: e.message }))) return;
        const r = await api.chatMerge(projectId, sessionId, staffId, true);
        setMerged(t('chat.mergedIn', { base: r.base, sha: r.sha }));
      }
    });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal changes-modal" role="dialog" aria-label={t('chat.changedTitle', { name })}>
        <header className="tasks-head">
          <h2>{t('chat.changedTitle', { name })}</h2>
          <span className="tasks-head-actions">
            <button className="btn-secondary" disabled={!!busy} onClick={load}>
              {t('chat.refresh')}
            </button>
            <button className="btn-secondary" onClick={onClose} aria-label={t('chat.close')}>
              {t('chat.close')}
            </button>
          </span>
        </header>
        {!code && !error && <p className="muted">{t('chat.reading')}</p>}
        {code && (
          <>
            <p className="small">
              {code.scope === 'worktree' ? (
                <>
                  <BranchIcon /> {t('chat.worktreeOf')} <b>{code.branch}</b> → {code.base ?? '?'} ·{' '}
                  {t(code.commits.length === 1 ? 'chat.commitsOne' : 'chat.commitsOther', { n: code.commits.length })}
                  {code.uncommitted ? ` · ${t('chat.uncommitted', { n: code.uncommitted })}` : ''}
                </>
              ) : (
                <>
                  {t('chat.ownProject', { branch: code.branch ? ` (${code.branch})` : '' })}{' '}
                  {code.touched.length > code.files.length && (
                    <span className="muted">
                      {t(code.touched.length - code.files.length === 1 ? 'chat.othersOne' : 'chat.othersOther', { n: code.touched.length - code.files.length })}
                    </span>
                  )}
                </>
              )}
            </p>
            {code.files.length ? (
              <ul className="task-files small">
                {code.files.map((f) => (
                  <li key={f.path} title={STATUS[f.status] ?? f.status}>
                    <span className={`task-file-status s-${f.status === '?' ? 'n' : f.status}`}>{f.status}</span> <span className="mono">{f.path}</span>
                    {(f.add > 0 || f.del > 0) && (
                      <span className="task-file-delta">
                        {' '}
                        <span className="add">+{f.add}</span> <span className="del">-{f.del}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{code.scope === 'conversation' && !code.touched.length ? t('chat.noEditsYet') : t('chat.nothingChanged')}</p>
            )}
            {code.diff && <pre className="task-diff changes-diff">{code.diff}</pre>}
            {code.truncated && <p className="muted small">{t('chat.diffCut')}</p>}
            <div className="task-code-row">
              <b className="small">{t('chat.tests')}</b>
              {tests ? (
                <span className={`small ${tests.ok ? 'ok' : 'fail'}`}>
                  {tests.ok ? t('chat.testsPassed') : t('chat.testsFailed')} · {tests.command}
                </span>
              ) : (
                <span className="muted small">{code.test ? t('chat.testNotRun', { test: code.test }) : t('chat.noTestCommand')}</span>
              )}
              {code.test && (
                <button className="btn-secondary" disabled={!!busy} onClick={() => void run('test', async () => setTests(await api.chatTest(projectId, sessionId, staffId)))}>
                  {busy === 'test' ? t('chat.runningTests') : t('chat.runTests')}
                </button>
              )}
            </div>
            {tests && !tests.ok && tests.output && <pre className="task-diff">{tests.output}</pre>}
            {code.scope === 'worktree' && (
              <div className="task-code-row">
                <button className="btn-primary" disabled={!!busy || !code.canMerge} title={code.whyNot ?? t('chat.mergeHelp')} onClick={() => void merge()}>
                  {busy === 'merge' ? t('chat.merging') : t('chat.mergeInto', { base: code.base ?? '?' })}
                </button>
                {merged ? <span className="small ok">{merged}</span> : code.whyNot && <span className="muted small">{code.whyNot}</span>}
              </div>
            )}
          </>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </div>
  );
}
