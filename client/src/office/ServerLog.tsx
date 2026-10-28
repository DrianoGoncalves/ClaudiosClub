import { useState } from 'react';
import type { ServerAccess } from '../../../shared/model';
import { api } from '../api';
import { locale, t } from '../i18n';

/**
 * Na ficha de quem acessa servidor: os comandos ssh/scp/vps que ele rodou, com hora, conexão e se
 * deu certo. Lido dos transcripts só quando você abre (eles podem ser grandes).
 */
export function ServerLog({ projectId, staffId }: { projectId: string; staffId: string }) {
  const [list, setList] = useState<ServerAccess[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.serverLog(projectId, staffId).then(setList, (e: Error) => setError(e.message));
  };
  return (
    <details className="server-log" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && list === null && load()}>
      <summary>{t('office.logTitle')}</summary>
      <p className="muted small">{t('office.logIntro')}</p>
      {list === null && !error && <p className="muted small">…</p>}
      {list?.length === 0 && <p className="muted small">{t('office.logEmpty')}</p>}
      {list && list.length > 0 && (
        <ul className="server-log-list">
          {list.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className={`badge ${a.ok === false ? 'warn' : a.ok === null ? 'dim' : ''}`}>
                {a.ok === false ? t('office.logFailed') : a.ok === null ? t('office.logNoResult') : t('office.logOk')}
              </span>{' '}
              <span className="muted small">
                {a.at ? new Date(a.at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                {a.connection ? ` · ${a.connection}` : ''}
              </span>
              <code className="server-log-cmd">{a.command}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="actions">
        <button type="button" className="link small" onClick={load}>
          {t('office.logRefresh')}
        </button>
      </p>
      {error && <p className="error small">{error}</p>}
    </details>
  );
}
