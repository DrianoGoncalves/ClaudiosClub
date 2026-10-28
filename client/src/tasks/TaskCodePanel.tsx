import { useCallback, useEffect, useState } from 'react';
import type { StaffProfile, Task, TaskCode } from '../../../shared/model';
import { api, ApiError, withUsageConfirm } from '../api';
import { formatAgo } from '../format';
import { t, locale } from '../i18n';
import { BranchIcon } from '../icons';

// Código da tarefa, no cartão: o que mudou, testes, mesclar, pedir revisão e pedir deploy.

const STATUS: Record<string, string> = {
  A: t('tasks.fileAdded'),
  M: t('tasks.fileModified'),
  D: t('tasks.fileDeleted'),
  R: t('tasks.fileRenamed'),
  C: t('tasks.fileCopied'),
  '?': t('tasks.fileUntracked'),
};

interface Props {
  projectId: string;
  task: Task;
  staff: StaffProfile[];
  /** Algo mudou na tarefa (relê o quadro). */
  onChanged: () => void;
  onOpenStaff: (staffId: string) => void;
}

export function TaskCodePanel({ projectId, task, staff, onChanged, onOpenStaff }: Props) {
  const [code, setCode] = useState<TaskCode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewers = staff.filter((s) => s.id !== task.staffId);
  const infra = staff.filter((s) => s.servers.length > 0);
  const [reviewer, setReviewer] = useState(reviewers[0]?.id ?? '');
  const [deployer, setDeployer] = useState(infra[0]?.id ?? '');
  const now = Date.now();
  const nameOf = (id: string) => staff.find((s) => s.id === id)?.name ?? id;

  const load = useCallback(() => {
    setLoadError(null);
    api.taskCode(projectId, task.id).then(setCode, (e: Error) => setLoadError(e.message));
  }, [projectId, task.id]);
  useEffect(load, [load, task.updatedAt]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onChanged();
      load();
    } catch (e) {
      setError((e as Error).message);
      onChanged(); // um teste vermelho fica gravado no cartão
    } finally {
      setBusy(null);
    }
  };

  const merge = () =>
    run('merge', async () => {
      if (!code?.base || !window.confirm(t('tasks.confirmMerge', { branch: code.branch ?? '?', base: code.base }))) return;
      try {
        await api.taskMerge(projectId, task.id);
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'no-tests') throw e;
        if (!window.confirm(t('tasks.confirmNoTests', { message: e.message }))) return;
        await api.taskMerge(projectId, task.id, true);
      }
    });

  return (
    <div className="task-code">
      {loadError && <p className="muted small">{loadError}</p>}
      {code && (
        <>
          <p className="small">
            {code.where === 'worktree' ? (
              <>
                <BranchIcon /> <b>{code.branch}</b> → {code.base ?? '?'} ·{' '}
                {t(code.commits.length === 1 ? 'tasks.commitOne' : 'tasks.commitOther', { n: code.commits.length })}
                {code.uncommitted ? ` · ${t('tasks.uncommitted', { n: code.uncommitted })}` : ''}
              </>
            ) : (
              <>
                {t('tasks.ownProject')}
                {code.branch ? ` (${code.branch})` : ''}: {t(code.files.length === 1 ? 'tasks.filesOne' : 'tasks.filesOther', { n: code.files.length })}
              </>
            )}
          </p>
          {code.files.length > 0 ? (
            <ul className="task-files small">
              {code.files.slice(0, 40).map((f) => (
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
              {code.files.length > 40 && <li className="muted">{t('tasks.andMore', { n: code.files.length - 40 })}</li>}
            </ul>
          ) : (
            <p className="muted small">{t('tasks.nothingChanged')}</p>
          )}
          {code.diff && (
            <details className="collapse">
              <summary>
                {t('tasks.seeDiff')}
                {code.truncated ? ` — ${t('tasks.cut')}` : ''}
              </summary>
              <pre className="task-diff">{code.diff}</pre>
            </details>
          )}

          <div className="task-code-row">
            <b className="small">{t('tasks.tests')}</b>
            {task.tests ? (
              <span className={`small ${task.tests.ok ? 'ok' : 'fail'}`}>
                {task.tests.ok ? t('tasks.passed') : t('tasks.failed')} · {task.tests.command} · {formatAgo(now - Date.parse(task.tests.at))}
              </span>
            ) : (
              <span className="muted small">{code.test ? t('tasks.notRunYet', { cmd: code.test }) : t('tasks.noTestCmd')}</span>
            )}
            {code.test && (
              <button className="btn-secondary" disabled={!!busy} onClick={() => void run('test', () => api.taskTest(projectId, task.id))}>
                {busy === 'test' ? t('tasks.running') : t('tasks.runTests')}
              </button>
            )}
          </div>
          {task.tests && !task.tests.ok && task.tests.output && (
            <details className="collapse">
              <summary>{t('tasks.testOutput')}</summary>
              <pre className="task-diff">{task.tests.output}</pre>
            </details>
          )}

          {code.where === 'worktree' && (
            <div className="task-code-row">
              <button
                className="btn-primary"
                disabled={!!busy || !code.canMerge || !!task.merged}
                title={task.merged ? t('tasks.alreadyMerged') : (code.whyNot ?? t('tasks.mergeHint'))}
                onClick={() => void merge()}
              >
                {busy === 'merge' ? t('tasks.merging') : t('tasks.mergeInto', { base: code.base ?? '?' })}
              </button>
              {task.merged ? (
                <span className="small ok">
                  {t('tasks.mergedIn', { base: task.merged.base, sha: task.merged.sha, ago: formatAgo(now - Date.parse(task.merged.at)) })}
                </span>
              ) : (
                code.whyNot && <span className="muted small">{code.whyNot}</span>
              )}
            </div>
          )}
        </>
      )}

      <div className="task-code-row">
        <b className="small">{t('tasks.reviewLabel')}</b>
        {task.review ? (
          <span className="small">
            {nameOf(task.review.staffId)} · {task.review.doneAt ? t('tasks.replied') : t('tasks.reviewing')} ·{' '}
            <button className="link" onClick={() => onOpenStaff(task.review!.staffId)}>
              {t('tasks.openConversation')}
            </button>
          </span>
        ) : reviewers.length ? (
          <>
            <select value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label={t('tasks.whoReviews')}>
              {reviewers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.role}
                </option>
              ))}
            </select>
            <button
              className="btn-secondary"
              disabled={!!busy || !reviewer}
              onClick={() => void run('review', () => withUsageConfirm((force) => api.taskReview(projectId, task.id, reviewer, force)))}
            >
              {t('tasks.askReview')}
            </button>
          </>
        ) : (
          <span className="muted small">{t('tasks.hireReviewer')}</span>
        )}
      </div>

      {(task.status === 'done' || task.status === 'live' || task.merged) && (
        <div className="task-code-row">
          <b className="small">{t('tasks.deploy')}</b>
          {task.deploy ? (
            <span className="small">
              {nameOf(task.deploy.staffId)} · {task.deploy.doneAt ? t('tasks.replied') : t('tasks.working')} ·{' '}
              <button className="link" onClick={() => onOpenStaff(task.deploy!.staffId)}>
                {t('tasks.openConversation')}
              </button>
            </span>
          ) : infra.length ? (
            <>
              <select value={deployer} onChange={(e) => setDeployer(e.target.value)} aria-label={t('tasks.whoDeploys')}>
                {infra.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.role}
                  </option>
                ))}
              </select>
              <button
                className="btn-secondary"
                disabled={!!busy || !deployer}
                title={t('tasks.deployHint')}
                onClick={() => void run('deploy', () => withUsageConfirm((force) => api.taskDeploy(projectId, task.id, deployer, force)))}
              >
                {t('tasks.askDeploy')}
              </button>
            </>
          ) : (
            <span className="muted small">{t('tasks.noInfraStaff')}</span>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
