import { useCallback, useEffect, useState } from 'react';
import type { ChatChanges, TestRun } from '../../../shared/model';
import { api, ApiError } from '../api';
import { BranchIcon } from '../icons';

// "O que mudou" na conversa: na worktree do funcionário, tudo desde a base (com mesclar); no
// próprio projeto, só os arquivos que ele editou nesta conversa. Testes rodam onde está o código.

const STATUS: Record<string, string> = { A: 'novo', M: 'mudou', D: 'apagado', R: 'renomeado', C: 'copiado', '?': 'novo (fora do git)' };

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
      if (!code?.base || !window.confirm(`Mesclar ${code.branch} em ${code.base}? O que não foi commitado na worktree será commitado antes; teste vermelho desfaz.`)) return;
      try {
        const r = await api.chatMerge(projectId, sessionId, staffId);
        setMerged(`mesclado em ${r.base} (${r.sha})`);
      } catch (e) {
        if (!(e instanceof ApiError) || e.code !== 'no-tests') throw e;
        if (!window.confirm(`${e.message}. Mesclar mesmo assim, sem testes?`)) return;
        const r = await api.chatMerge(projectId, sessionId, staffId, true);
        setMerged(`mesclado em ${r.base} (${r.sha})`);
      }
    });

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal changes-modal" role="dialog" aria-label={`O que ${name} mudou`}>
        <header className="tasks-head">
          <h2>O que {name} mudou</h2>
          <span className="tasks-head-actions">
            <button className="btn-secondary" disabled={!!busy} onClick={load}>
              Atualizar
            </button>
            <button className="btn-secondary" onClick={onClose} aria-label="Fechar">
              Fechar
            </button>
          </span>
        </header>
        {!code && !error && <p className="muted">Lendo…</p>}
        {code && (
          <>
            <p className="small">
              {code.scope === 'worktree' ? (
                <>
                  <BranchIcon /> Worktree dele: <b>{code.branch}</b> → {code.base ?? '?'} · {code.commits.length} commit{code.commits.length === 1 ? '' : 's'}
                  {code.uncommitted ? ` · ${code.uncommitted} sem commit` : ''}
                </>
              ) : (
                <>
                  No próprio projeto{code.branch ? ` (${code.branch})` : ''}: os arquivos que ele editou nesta conversa e ainda estão sem commit.{' '}
                  {code.touched.length > code.files.length && (
                    <span className="muted">
                      ({code.touched.length - code.files.length} {code.touched.length - code.files.length === 1 ? 'outro editado já está' : 'outros editados já estão'} igual ao último commit)
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
              <p className="muted small">{code.scope === 'conversation' && !code.touched.length ? 'Ele ainda não editou nenhum arquivo nesta conversa.' : 'Nada mudou ainda.'}</p>
            )}
            {code.diff && <pre className="task-diff changes-diff">{code.diff}</pre>}
            {code.truncated && <p className="muted small">O diff foi cortado (grande demais).</p>}
            <div className="task-code-row">
              <b className="small">Testes</b>
              {tests ? (
                <span className={`small ${tests.ok ? 'ok' : 'fail'}`}>
                  {tests.ok ? 'passaram' : 'falharam'} · {tests.command}
                </span>
              ) : (
                <span className="muted small">{code.test ? `${code.test}, ainda não rodou` : 'nenhum comando de testes achado'}</span>
              )}
              {code.test && (
                <button className="btn-secondary" disabled={!!busy} onClick={() => void run('test', async () => setTests(await api.chatTest(projectId, sessionId, staffId)))}>
                  {busy === 'test' ? 'Rodando…' : 'Rodar testes'}
                </button>
              )}
            </div>
            {tests && !tests.ok && tests.output && <pre className="task-diff">{tests.output}</pre>}
            {code.scope === 'worktree' && (
              <div className="task-code-row">
                <button className="btn-primary" disabled={!!busy || !code.canMerge} title={code.whyNot ?? 'Testa o resultado e mescla; teste vermelho desfaz'} onClick={() => void merge()}>
                  {busy === 'merge' ? 'Mesclando…' : `Mesclar em ${code.base ?? '?'}`}
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
