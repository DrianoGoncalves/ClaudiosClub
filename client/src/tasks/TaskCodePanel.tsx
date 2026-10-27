import { useCallback, useEffect, useState } from 'react';
import type { StaffProfile, Task, TaskCode } from '../../../shared/model';
import { api, ApiError, withUsageConfirm } from '../api';
import { formatAgo } from '../format';
import { BranchIcon } from '../icons';

// Código da tarefa, no cartão: o que mudou, testes, mesclar, pedir revisão e pedir deploy.

const STATUS: Record<string, string> = { A: 'novo', M: 'mudou', D: 'apagado', R: 'renomeado', C: 'copiado', '?': 'novo (fora do git)' };

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
      if (!code?.base || !window.confirm(`Mesclar ${code.branch} em ${code.base}? O que não foi commitado na worktree será commitado com o título da tarefa.`)) return;
      try {
        await api.taskMerge(projectId, task.id);
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'no-tests') throw e;
        if (!window.confirm(`${e.message}. Mesclar mesmo assim, sem testes?`)) return;
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
                <BranchIcon /> <b>{code.branch}</b> → {code.base ?? '?'} · {code.commits.length} commit{code.commits.length === 1 ? '' : 's'}
                {code.uncommitted ? ` · ${code.uncommitted} sem commit` : ''}
              </>
            ) : (
              <>
                No próprio projeto{code.branch ? ` (${code.branch})` : ''}: {code.files.length} {code.files.length === 1 ? 'arquivo alterado' : 'arquivos alterados'} sem commit
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
              {code.files.length > 40 && <li className="muted">… e mais {code.files.length - 40}</li>}
            </ul>
          ) : (
            <p className="muted small">Nada mudou ainda.</p>
          )}
          {code.diff && (
            <details className="collapse">
              <summary>Ver as mudanças (diff){code.truncated ? ' — cortado' : ''}</summary>
              <pre className="task-diff">{code.diff}</pre>
            </details>
          )}

          <div className="task-code-row">
            <b className="small">Testes</b>
            {task.tests ? (
              <span className={`small ${task.tests.ok ? 'ok' : 'fail'}`}>
                {task.tests.ok ? 'passaram' : 'falharam'} · {task.tests.command} · {formatAgo(now - Date.parse(task.tests.at))}
              </span>
            ) : (
              <span className="muted small">{code.test ? `${code.test}, ainda não rodou` : 'nenhum comando de testes achado'}</span>
            )}
            {code.test && (
              <button className="btn-secondary" disabled={!!busy} onClick={() => void run('test', () => api.taskTest(projectId, task.id))}>
                {busy === 'test' ? 'Rodando…' : 'Rodar testes'}
              </button>
            )}
          </div>
          {task.tests && !task.tests.ok && task.tests.output && (
            <details className="collapse">
              <summary>Saída dos testes</summary>
              <pre className="task-diff">{task.tests.output}</pre>
            </details>
          )}

          {code.where === 'worktree' && (
            <div className="task-code-row">
              <button
                className="btn-primary"
                disabled={!!busy || !code.canMerge || !!task.merged}
                title={task.merged ? 'Já mesclada' : (code.whyNot ?? 'Testa o resultado e mescla; teste vermelho desfaz')}
                onClick={() => void merge()}
              >
                {busy === 'merge' ? 'Mesclando…' : `Mesclar em ${code.base ?? '?'}`}
              </button>
              {task.merged ? (
                <span className="small ok">
                  mesclada em {task.merged.base} ({task.merged.sha}) · {formatAgo(now - Date.parse(task.merged.at))}
                </span>
              ) : (
                code.whyNot && <span className="muted small">{code.whyNot}</span>
              )}
            </div>
          )}
        </>
      )}

      <div className="task-code-row">
        <b className="small">Revisão</b>
        {task.review ? (
          <span className="small">
            {nameOf(task.review.staffId)} · {task.review.doneAt ? 'respondeu' : 'revisando'} ·{' '}
            <button className="link" onClick={() => onOpenStaff(task.review!.staffId)}>
              abrir a conversa
            </button>
          </span>
        ) : reviewers.length ? (
          <>
            <select value={reviewer} onChange={(e) => setReviewer(e.target.value)} aria-label="Quem revisa">
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
              Pedir revisão
            </button>
          </>
        ) : (
          <span className="muted small">contrate um revisor neste projeto para pedir revisão</span>
        )}
      </div>

      {(task.status === 'done' || task.status === 'live' || task.merged) && (
        <div className="task-code-row">
          <b className="small">Deploy</b>
          {task.deploy ? (
            <span className="small">
              {nameOf(task.deploy.staffId)} · {task.deploy.doneAt ? 'respondeu' : 'fazendo'} ·{' '}
              <button className="link" onClick={() => onOpenStaff(task.deploy!.staffId)}>
                abrir a conversa
              </button>
            </span>
          ) : infra.length ? (
            <>
              <select value={deployer} onChange={(e) => setDeployer(e.target.value)} aria-label="Quem faz o deploy">
                {infra.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.role}
                  </option>
                ))}
              </select>
              <button
                className="btn-secondary"
                disabled={!!busy || !deployer}
                title="Manda o checklist: backup, estado antes e depois, runbook; ele pede confirmação antes do irreversível"
                onClick={() => void run('deploy', () => withUsageConfirm((force) => api.taskDeploy(projectId, task.id, deployer, force)))}
              >
                Pedir deploy
              </button>
            </>
          ) : (
            <span className="muted small">nenhum funcionário com acesso a servidores neste projeto</span>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
