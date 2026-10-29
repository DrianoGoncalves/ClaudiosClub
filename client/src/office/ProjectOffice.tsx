import { useEffect, useState } from 'react';
import type { AppConfig, ProjectConnection } from '../../../shared/model';
import { api } from '../api';
import { t } from '../i18n';

// No detalhe do projeto: o workspace dele (a aba onde aparece) e as conexões SSH, que os
// funcionários usam conforme a ficha de cada um. O MyCo só guarda o caminho da chave, nunca o conteúdo.

export function ProjectOffice({ projectId, config, onConfig }: { projectId: string; config: AppConfig | null; onConfig: (c: AppConfig) => void }) {
  const workspaces = config?.workspaces ?? [];
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {workspaces.length > 0 && (
        <section className="section">
          <h3>{t('office.projectWorkspace')}</h3>
          <select
            className="setting-select"
            value={config?.projectWorkspaces[projectId] ?? ''}
            aria-label={t('office.projectWorkspace')}
            onChange={async (e) => {
              setError(null);
              try {
                onConfig(await api.setProjectWorkspace(projectId, e.target.value || null));
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <option value="">{t('office.noWorkspace')}</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          {error && <p className="error small">{error}</p>}
        </section>
      )}
      <Connections projectId={projectId} />
    </>
  );
}

type Draft = { name: string; host: string; port: string; user: string; identityFile: string; remoteRoot: string; originalName?: string };
const EMPTY: Draft = { name: '', host: '', port: '22', user: '', identityFile: '', remoteRoot: '' };

function Connections({ projectId }: { projectId: string }) {
  const [list, setList] = useState<ProjectConnection[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string } | 'running'>>({});

  const reload = () => api.connections(projectId).then(setList, (e: Error) => setError(e.message));
  useEffect(() => {
    setList(null);
    setDraft(null);
    setTests({});
    void reload();
  }, [projectId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveConnection(projectId, {
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: Number(draft.port) || 22,
        user: draft.user.trim(),
        identityFile: draft.identityFile.trim(),
        remoteRoot: draft.remoteRoot.trim() || null,
        ...(draft.originalName && { originalName: draft.originalName }),
      });
      setDraft(null);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const test = async (name: string) => {
    setTests((s) => ({ ...s, [name]: 'running' }));
    try {
      const r = await api.testConnection(projectId, name);
      setTests((s) => ({ ...s, [name]: r }));
    } catch (err) {
      setTests((s) => ({ ...s, [name]: { ok: false, message: (err as Error).message } }));
    }
  };

  const field = (key: keyof Draft, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>
      {label}
      <input value={draft?.[key] ?? ''} onChange={(e) => setDraft((d) => d && { ...d, [key]: e.target.value })} {...extra} />
    </label>
  );

  return (
    <section className="section connections">
      <h3>{t('office.serversTitle')}</h3>
      <p className="muted small">{t('office.serversIntro')}</p>
      {list === null && !error && <p className="muted small">…</p>}
      {list?.length === 0 && !draft && <p className="muted small">{t('office.serversEmpty')}</p>}
      <ul className="conn-list">
        {list?.map((c) => {
          const r = tests[c.name];
          return (
            <li key={c.name}>
              <div>
                <b>{c.name}</b>{' '}
                <span className="muted small mono">
                  {c.user ? `${c.user}@` : ''}
                  {c.host}
                  {c.port !== 22 ? `:${c.port}` : ''}
                  {c.remoteRoot ? ` · ${c.remoteRoot}` : ''}
                </span>
              </div>
              {!c.complete && <span className="badge warn">{t('office.connIncomplete')}</span>}
              {c.complete && !c.keyFound && <span className="badge warn">{t('office.connKeyMissing')}</span>}
              {c.user === 'root' && <span className="badge warn">{t('office.connRootUser')}</span>}
              <p className="actions">
                <button type="button" className="btn-secondary" disabled={!c.complete || r === 'running'} onClick={() => void test(c.name)}>
                  {r === 'running' ? t('office.connTesting') : t('office.connTest')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setDraft({
                      name: c.name,
                      host: c.host,
                      port: String(c.port),
                      user: c.user ?? '',
                      identityFile: c.identityFile ?? '',
                      remoteRoot: c.remoteRoot ?? '',
                      originalName: c.name,
                    })
                  }
                >
                  {t('office.connEdit')}
                </button>
                <button
                  type="button"
                  className="link small"
                  onClick={async () => {
                    if (!window.confirm(t('office.connRemoveConfirm', { name: c.name }))) return;
                    await api.removeConnection(projectId, c.name).catch((e: Error) => setError(e.message));
                    await reload();
                  }}
                >
                  {t('office.connRemove')}
                </button>
              </p>
              {r && r !== 'running' && <p className={r.ok ? 'small ok' : 'error small'}>{r.message}</p>}
            </li>
          );
        })}
      </ul>
      {draft ? (
        <form className="conn-form" onSubmit={save}>
          <div className="grid2">
            {field('name', t('office.connName'), { required: true, maxLength: 40, placeholder: t('office.connNamePlaceholder') })}
            {field('host', t('office.connHost'), { required: true, maxLength: 253 })}
            {field('user', t('office.connUser'), { required: true, maxLength: 32 })}
            {field('port', t('office.connPort'), { inputMode: 'numeric', maxLength: 5 })}
          </div>
          {field('identityFile', t('office.connKey'), { required: true, maxLength: 400, className: 'mono', placeholder: t('office.connKeyPlaceholder') })}
          {field('remoteRoot', t('office.connRoot'), { maxLength: 300, className: 'mono', placeholder: t('office.connRootPlaceholder') })}
          <p className="actions">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? t('office.connSaving') : t('office.connSave')}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
              {t('office.cancel')}
            </button>
          </p>
        </form>
      ) : (
        <p className="actions">
          <button type="button" className="btn-secondary" onClick={() => setDraft(EMPTY)}>
            {t('office.connAdd')}
          </button>
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
