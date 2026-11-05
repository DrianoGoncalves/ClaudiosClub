import { useEffect, useState } from 'react';
import type { AnyConnection, AppConfig, ConnectionProtocol, FtpConnection } from '../../../shared/model';
import { api, isPairingError } from '../api';
import { t } from '../i18n';

// No detalhe do projeto: o workspace dele (a aba onde aparece) e as conexões SSH e FTP, que os
// funcionários usam conforme a ficha de cada um. O Claudio’s Club só guarda o caminho da chave, nunca o conteúdo;
// a senha do FTP vai para o cofre do servidor e não volta para a tela.

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

type Draft = {
  protocol: ConnectionProtocol;
  name: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
  remoteRoot: string;
  /** Só FTP: a senha nova. Nunca vem do servidor; vazia na edição mantém a guardada. */
  password: string;
  hasPassword?: boolean;
  originalName?: string;
};
const EMPTY: Draft = { protocol: 'ssh', name: '', host: '', port: '22', user: '', identityFile: '', remoteRoot: '', password: '' };
const DEFAULT_PORT: Record<ConnectionProtocol, string> = { ssh: '22', ftps: '21', ftp: '21' };
const PROTOCOLS: ConnectionProtocol[] = ['ssh', 'ftps', 'ftp'];

const isFtp = (c: AnyConnection): c is FtpConnection => c.protocol !== 'ssh';

function Connections({ projectId }: { projectId: string }) {
  const [list, setList] = useState<AnyConnection[] | null>(null);
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
      if (draft.protocol === 'ssh') {
        await api.saveConnection(projectId, {
          name: draft.name.trim(),
          host: draft.host.trim(),
          port: Number(draft.port) || 22,
          user: draft.user.trim(),
          identityFile: draft.identityFile.trim(),
          remoteRoot: draft.remoteRoot.trim() || null,
          ...(draft.originalName && { originalName: draft.originalName }),
        });
      } else {
        await api.saveFtpConnection(projectId, {
          protocol: draft.protocol,
          name: draft.name.trim(),
          host: draft.host.trim(),
          port: Number(draft.port) || 21,
          user: draft.user.trim(),
          remoteRoot: draft.remoteRoot.trim() || null,
          // Sem senha nova na edição: não manda o campo, e o servidor mantém a do cofre.
          ...(draft.password && { password: draft.password }),
          ...(draft.originalName && { originalName: draft.originalName }),
        });
      }
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
      // Recusa por pareamento: fica sem resultado (o aviso do App explica).
      setTests(({ [name]: _, ...s }) => (isPairingError(err) ? s : { ...s, [name]: { ok: false, message: (err as Error).message } }));
    }
  };

  const field = (key: Exclude<keyof Draft, 'protocol' | 'hasPassword'>, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
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
          const ftp = isFtp(c);
          const ready = ftp ? c.hasPassword : c.complete;
          return (
            <li key={c.name}>
              <div>
                <ProtocolBadge protocol={c.protocol} /> <b>{c.name}</b>{' '}
                <span className="muted small mono">
                  {c.user ? `${c.user}@` : ''}
                  {c.host}
                  {c.port !== Number(DEFAULT_PORT[c.protocol]) ? `:${c.port}` : ''}
                  {c.remoteRoot ? ` · ${c.remoteRoot}` : ''}
                </span>
              </div>
              {ftp && !c.hasPassword && <span className="badge warn">{t('office.connNoPassword')}</span>}
              {!ftp && !c.complete && <span className="badge warn">{t('office.connIncomplete')}</span>}
              {!ftp && c.complete && !c.keyFound && <span className="badge warn">{t('office.connKeyMissing')}</span>}
              {c.user === 'root' && <span className="badge warn">{t('office.connRootUser')}</span>}
              <p className="actions">
                <button type="button" className="btn-secondary" disabled={!ready || r === 'running'} onClick={() => void test(c.name)}>
                  {r === 'running' ? t('office.connTesting') : t('office.connTest')}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() =>
                    setDraft({
                      protocol: c.protocol,
                      name: c.name,
                      host: c.host,
                      port: String(c.port),
                      user: c.user ?? '',
                      identityFile: ftp ? '' : (c.identityFile ?? ''),
                      remoteRoot: c.remoteRoot ?? '',
                      password: '',
                      hasPassword: ftp && c.hasPassword,
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
          {/* Trocar de protocolo só ao criar: editar mantém o arquivo onde a conexão mora (.vps/config.json ou ftp.json). */}
          {!draft.originalName && (
            <div className="segmented" role="group" aria-label={t('office.connProtocol')}>
              {PROTOCOLS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="btn-secondary btn-toggle"
                  aria-pressed={draft.protocol === p}
                  onClick={() =>
                    setDraft((d) => d && { ...d, protocol: p, port: d.port === DEFAULT_PORT[d.protocol] || !d.port ? DEFAULT_PORT[p] : d.port })
                  }
                >
                  {t(`office.proto.${p}`)}
                </button>
              ))}
            </div>
          )}
          {draft.protocol === 'ftp' && (
            <p className="conn-warn" role="note">
              {t('office.connFtpPlain')}
            </p>
          )}
          <div className="grid2">
            {field('name', t('office.connName'), { required: true, maxLength: 40, placeholder: t('office.connNamePlaceholder') })}
            {field('host', t('office.connHost'), { required: true, maxLength: 253 })}
            {field('user', t('office.connUser'), { required: true, maxLength: 32 })}
            {field('port', t('office.connPort'), { inputMode: 'numeric', maxLength: 5 })}
          </div>
          {draft.protocol === 'ssh' ? (
            field('identityFile', t('office.connKey'), { required: true, maxLength: 400, className: 'mono', placeholder: t('office.connKeyPlaceholder') })
          ) : (
            <>
              {draft.hasPassword && (
                <p className="muted small">
                  <span className="badge">{t('office.connPasswordSaved')}</span> {t('office.connPasswordKeep')}
                </p>
              )}
              {/* Só se grava: nunca preenchido nem mostrado; new-password evita o navegador sugerir a senha salva dele. */}
              {field('password', draft.originalName ? t('office.connPasswordNew') : t('office.connPassword'), {
                type: 'password',
                autoComplete: 'new-password',
                required: !draft.originalName || !draft.hasPassword,
                maxLength: 200,
              })}
            </>
          )}
          {field('remoteRoot', t(draft.protocol === 'ssh' ? 'office.connRoot' : 'office.connFtpRoot'), {
            maxLength: 300,
            className: 'mono',
            placeholder: t(draft.protocol === 'ssh' ? 'office.connRootPlaceholder' : 'office.connFtpRootPlaceholder'),
          })}
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

/** Protocolo da conexão; FTP puro em aviso (sem criptografia). Usado também na ficha. */
export function ProtocolBadge({ protocol }: { protocol: ConnectionProtocol }) {
  return (
    <span className={protocol === 'ftp' ? 'badge warn' : 'badge'} title={protocol === 'ftp' ? t('office.connFtpPlain') : undefined}>
      {t(`office.proto.${protocol}`)}
    </span>
  );
}
