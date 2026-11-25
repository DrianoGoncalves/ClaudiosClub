import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { DEPLOY_ENVS, isRunning, type DeployEnv, type DeployInfo, type DeployRecord, type DeployState } from '../../../shared/deploy';
import { api } from '../api';
import { t } from '../i18n';
import { askConfirm } from '../lib/dialogStore';
import { pollVisible } from '../usePoll';

// Deploy como código (ver server/deploy.ts e docs/deploy.md), no cartão (o commit mesclado dele) e na aba Histórico da versão (a tag mais nova e o rollback para a anterior).
// Lê ao montar e, só com deploy rodando, a cada DEPLOY_POLL_MS (o servidor ainda não vai ao GitHub mais de 1x a cada 30 s por deploy). Sem o workflow ou fora do GitHub: o
// cartão mostra o "Pedir deploy" de sempre (`fallback`, a conversa SSH) e a versão diz por que não há deploy.

export const DEPLOY_POLL_MS = 30_000;

const STATE_KEY: Record<DeployState, Parameters<typeof t>[0]> = {
  queued: 'release.deployQueued',
  running: 'release.deployRunning',
  success: 'release.deploySuccess',
  failure: 'release.deployFailure',
  unknown: 'release.deployUnknown',
};
const ENV_KEY: Record<DeployEnv, Parameters<typeof t>[0]> = { staging: 'release.deployStaging', producao: 'release.deployProd' };
const shortRef = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref);

function Records({ records }: { records: DeployRecord[] }) {
  if (!records.length) return <p className="muted small">{t('release.deployNone')}</p>;
  return (
    <ul className="deploy-list small">
      {records.slice(0, 5).map((r) => (
        <li key={r.id} className="ci-line" data-state={r.state === 'running' || r.state === 'queued' ? 'pending' : r.state}>
          <span className="ci-dot" aria-hidden="true" />
          <span title={r.reason}>
            {t(ENV_KEY[r.environment])} · <code>{shortRef(r.ref)}</code>
            {r.rollbackFrom && ` · ${t('release.deployRolledBack', { from: r.rollbackFrom })}`} · <b>{t(STATE_KEY[r.state])}</b>
          </span>
          {r.runUrl && (
            <a href={r.runUrl} target="_blank" rel="noopener noreferrer">
              {t('release.deployLog')}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * O painel. `taskId`: o deploy do cartão (pelo "Pedir deploy", com o commit mesclado); sem ele, o da versão (a tag mais nova) e o rollback. `fallback`: o que mostrar sem o
 * workflow (no cartão, a conversa SSH de sempre). `initial` só para teste (o render no servidor não roda os efeitos).
 */
export function DeployPanel({ projectId, taskId, fallback, initial }: { projectId: string; taskId?: string; fallback?: ReactNode; initial?: DeployInfo | null }) {
  const [info, setInfo] = useState<DeployInfo | null | undefined>(initial);
  const [env, setEnv] = useState<DeployEnv>('staging');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const load = useCallback(() => {
    api.deployInfo(projectId, taskId).then((v) => alive.current && setInfo(v), () => alive.current && setInfo(null));
  }, [projectId, taskId]);
  useEffect(load, [load]);
  const running = !!info?.records.some(isRunning);
  useEffect(() => (running ? pollVisible(load, DEPLOY_POLL_MS) : undefined), [running, load]);

  if (info === undefined) return <span className="muted small">{t('release.ciLoading')}</span>;
  if (!info?.available) return fallback !== undefined ? <>{fallback}</> : <p className="muted small">{info?.reason ?? t('release.deployUnavailable')}</p>;

  const go = async (run: () => Promise<unknown>, label: string) => {
    if (env === 'producao' && !(await askConfirm(t('release.deployProdConfirm', { what: label })))) return;
    setBusy(true);
    setError(null);
    try {
      await run();
      load();
    } catch (e) {
      setError((e as Error).message || null);
    } finally {
      setBusy(false);
    }
  };
  const confirm = env === 'producao';
  return (
    <div className="deploy-panel">
      <div className="release-foot">
        <select value={env} onChange={(e) => setEnv(e.target.value as DeployEnv)} disabled={busy} aria-label={t('release.deployEnv')}>
          {DEPLOY_ENVS.map((e) => (
            <option key={e} value={e}>
              {t(ENV_KEY[e])}
            </option>
          ))}
        </select>
        {taskId ? (
          <button type="button" className="btn-secondary" disabled={busy || running} onClick={() => go(() => api.taskDeployWorkflow(projectId, taskId, env, confirm), t('release.deployThisTask'))}>
            {t('tasks.askDeploy')}
          </button>
        ) : (
          <>
            {info.latestTag && (
              <button type="button" className="btn-secondary" disabled={busy || running} onClick={() => go(() => api.dispatchDeploy(projectId, { environment: env, tag: info.latestTag!, confirm }), info.latestTag!)}>
                {t('release.deployTag', { tag: info.latestTag })}
              </button>
            )}
            {info.previousTag && (
              <button
                type="button"
                className="btn-secondary is-danger"
                disabled={busy || running}
                onClick={() => go(() => api.dispatchDeploy(projectId, { environment: env, rollback: true, confirm }), t('release.deployRollbackWhat', { tag: info.previousTag! }))}
              >
                {t('release.deployRollback', { tag: info.previousTag })}
              </button>
            )}
          </>
        )}
      </div>
      <Records records={info.records} />
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
