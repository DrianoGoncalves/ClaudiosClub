import { useEffect, useState } from 'react';
import type { Project } from '../../../shared/model';
import { api, isPairingError, type McpRef } from '../api';
import { t, type MsgKey } from '../i18n';
import { TrashIcon } from '../icons';
import {
  MCP_SCOPES,
  MCP_TYPES,
  draftFrom,
  draftProblem,
  groupServers,
  isProjectScope,
  pairKind,
  saveBody,
  targetLabel,
  type McpDraft,
  type McpServer,
  type PairDraft,
} from './mcpForm';

// Configurações › MCPs: os da conta (cofre do Club e ~/.claude.json) e os do projeto escolhido (.mcp.json e
// locais). Cadastra e edita também os que nasceram fora do Club. Valores de env/cabeçalho só vão para o servidor.

type TestResult = { ok: boolean; tools: string[]; error?: string } | 'running';
const refOf = (s: McpServer): McpRef => ({ scope: s.scope, ...(s.projectId && { projectId: s.projectId }), name: s.name });
const idOf = (s: { scope: string; name: string }) => `${s.scope}:${s.name}`;

export function McpServers({ projects }: { projects: Project[] }) {
  const rooms = projects.filter((p) => p.exists && !p.worktreeOf);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<McpDraft | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});

  const reload = () =>
    api.mcpServers(projectId).then(
      (r) => setServers(r.servers),
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    setServers(null);
    setError(null);
    void reload();
  }, [projectId]);

  const test = async (s: McpServer) => {
    const id = idOf(s);
    setTests((x) => ({ ...x, [id]: 'running' }));
    try {
      const r = await api.testMcpServer(refOf(s));
      setTests((x) => ({ ...x, [id]: r }));
    } catch (err) {
      // Recusa por pareamento: fica sem resultado (o aviso do App explica).
      setTests(({ [id]: _, ...x }) => (isPairingError(err) ? x : { ...x, [id]: { ok: false, tools: [], error: (err as Error).message } }));
    }
  };

  const remove = async (s: McpServer) => {
    if (!window.confirm(t('mcp.removeConfirm', { name: s.name, scope: t(`mcp.scope.${s.scope}`) }))) return;
    setError(null);
    try {
      await api.deleteMcpServer(refOf(s));
    } catch (err) {
      setError((err as Error).message);
    }
    await reload();
  };

  const form = (d: McpDraft) => (
    <McpForm
      draft={d}
      rooms={rooms}
      onChange={setDraft}
      onCancel={() => setDraft(null)}
      onSaved={async () => {
        setDraft(null);
        await reload();
      }}
    />
  );

  const groups = groupServers(servers ?? []);
  return (
    <div className="mcp-servers">
      {MCP_SCOPES.map((scope) => (
        <div key={scope} className="mcp-group">
          {scope === 'project' && (
            <label className="mcp-project">
              {t('mcp.project')}
              <select className="setting-select" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
                <option value="">{t('mcp.projectPick')}</option>
                {rooms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <h4 className="mcp-group-title">{t(`mcp.scope.${scope}`)}</h4>
          <p className="muted small">{t(`mcp.scopeDesc.${scope}`)}</p>
          {scope === 'project' && (
            <p className="conn-warn" role="note">
              {t('mcp.projectWarn')}
            </p>
          )}
          {isProjectScope(scope) && !projectId ? null : servers === null ? (
            !error && <p className="muted small">{t('mcp.loading')}</p>
          ) : groups[scope].length === 0 ? (
            <p className="muted small">{t('mcp.empty')}</p>
          ) : (
            <ul className="conn-list">
              {groups[scope].map((s) => {
                const r = tests[idOf(s)];
                if (draft?.originalName === s.name && draft.scope === s.scope) return <li key={s.name}>{form(draft)}</li>;
                return (
                  <li key={s.name}>
                    <div className="mcp-line">
                      <span className="badge">{t(`mcp.type.${s.type}`)}</span> <b>{s.name}</b>{' '}
                      <span className="muted small mono mcp-target">{targetLabel(s)}</span>
                    </div>
                    {s.env.length + s.headers.length > 0 && (
                      <p className="muted small mono mcp-keys">
                        {[...s.env, ...s.headers].map((k) => `${k.key}${k.set ? ` (${t('mcp.valueSet')})` : ''}`).join(' · ')}
                      </p>
                    )}
                    <p className="actions">
                      <button type="button" className="btn-secondary" disabled={r === 'running'} onClick={() => void test(s)}>
                        {r === 'running' ? t('mcp.testing') : t('mcp.test')}
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setDraft(draftFrom(s, projectId))}>
                        {t('mcp.edit')}
                      </button>
                      <button type="button" className="btn-secondary is-danger" onClick={() => void remove(s)}>
                        {t('mcp.remove')}
                      </button>
                    </p>
                    {r && r !== 'running' && <TestOutcome result={r} />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
      {draft && !draft.originalName ? (
        form(draft)
      ) : (
        <p className="actions">
          <button type="button" className="btn-secondary" onClick={() => setDraft(draftFrom(null, projectId))}>
            {t('mcp.add')}
          </button>
        </p>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function TestOutcome({ result }: { result: { ok: boolean; tools: string[]; readOnly?: string[]; error?: string } }) {
  if (!result.ok) return <p className="error small">{t('mcp.testFail', { error: result.error ?? '' })}</p>;
  return (
    <p className="small ok">
      {t('mcp.testOk', { n: result.tools.length })}
      {/* Quantas o próprio MCP marca como só leitura: o resto conta como escrita na política da ficha. */}
      {result.tools.length > 0 && ` ${t('mcp.testReadOnly', { n: result.readOnly?.length ?? 0 })}`}
      {result.tools.length > 0 && <span className="mono mcp-tools"> {result.tools.join(', ')}</span>}
    </p>
  );
}

function McpForm({
  draft: d,
  rooms,
  onChange,
  onCancel,
  onSaved,
}: {
  draft: McpDraft;
  rooms: Project[];
  onChange: (d: McpDraft) => void;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<McpDraft>) => onChange({ ...d, ...patch });
  const kind = pairKind(d.type);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = draftProblem(d);
    if (problem) return setError(t(`mcp.err.${problem.problem}` as MsgKey, { key: problem.key ?? '' }));
    setBusy(true);
    setError(null);
    try {
      await api.saveMcpServer(saveBody(d));
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const setPair = (i: number, patch: Partial<PairDraft>) => set({ [kind]: d[kind].map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  return (
    <form className="conn-form mcp-form" onSubmit={submit} noValidate>
      <h4 className="mcp-group-title">{d.originalName ? t('mcp.editTitle', { name: d.originalName }) : t('mcp.newTitle')}</h4>
      {/* Mudar de escopo só ao criar: editar mantém o arquivo (ou o cofre) onde ele mora. */}
      {!d.originalName && (
        <>
          <div className="segmented" role="group" aria-label={t('mcp.where')}>
            {MCP_SCOPES.map((s) => (
              <button key={s} type="button" className="btn-secondary btn-toggle" aria-pressed={d.scope === s} onClick={() => set({ scope: s })}>
                {t(`mcp.scope.${s}`)}
              </button>
            ))}
          </div>
          <p className="muted small">{t(`mcp.scopeDesc.${d.scope}`)}</p>
        </>
      )}
      {d.scope === 'project' && (
        <p className="conn-warn" role="note">
          {t('mcp.projectWarn')}
        </p>
      )}
      {isProjectScope(d.scope) && !d.originalName && (
        <label>
          {t('mcp.project')}
          <select value={d.projectId ?? ''} onChange={(e) => set({ projectId: e.target.value || null })} required>
            <option value="">{t('mcp.projectPick')}</option>
            {rooms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        {t('mcp.name')}
        <input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={64} required placeholder="n8n" autoComplete="off" />
      </label>
      <div className="segmented" role="group" aria-label={t('mcp.type')}>
        {MCP_TYPES.map((ty) => (
          <button key={ty} type="button" className="btn-secondary btn-toggle" aria-pressed={d.type === ty} onClick={() => set({ type: ty })}>
            {t(`mcp.type.${ty}`)}
          </button>
        ))}
      </div>
      {d.type === 'stdio' ? (
        <>
          <label>
            {t('mcp.command')}
            <input className="mono" value={d.command} onChange={(e) => set({ command: e.target.value })} maxLength={400} required placeholder="npx" autoComplete="off" />
          </label>
          {d.argsMasked && !d.argsTouched ? (
            <p className="muted small">
              {t('mcp.argsMasked')}{' '}
              <button type="button" className="link" onClick={() => set({ argsTouched: true, args: '' })}>
                {t('mcp.argsChange')}
              </button>
            </p>
          ) : (
            <label>
              {t('mcp.args')}
              <textarea className="mono" value={d.args} onChange={(e) => set({ args: e.target.value })} rows={3} maxLength={4000} placeholder={'-y\n@modelcontextprotocol/server-filesystem'} />
            </label>
          )}
        </>
      ) : (
        <label>
          {t('mcp.url')}
          <input className="mono" inputMode="url" value={d.url} onChange={(e) => set({ url: e.target.value })} maxLength={2000} required placeholder="https://n8n.exemplo.com/mcp" autoComplete="off" />
        </label>
      )}
      <fieldset className="mcp-pairs">
        <legend>{t(kind === 'env' ? 'mcp.env' : 'mcp.headers')}</legend>
        {d[kind].map((p, i) =>
          p.removed ? (
            <p key={`${p.key}-${i}`} className="muted small">
              {t('mcp.removedKey', { key: p.key })}{' '}
              <button type="button" className="link" onClick={() => setPair(i, { removed: false })}>
                {t('mcp.undo')}
              </button>
            </p>
          ) : (
            <div key={i} className="mcp-pair">
              {p.saved ? (
                <span className="mcp-key mono">
                  {p.key} <span className="badge">{t('mcp.valueSet')}</span>
                </span>
              ) : (
                <input
                  className="mono"
                  aria-label={t('mcp.key')}
                  placeholder={t('mcp.key')}
                  value={p.key}
                  onChange={(e) => setPair(i, { key: e.target.value })}
                  maxLength={128}
                  autoComplete="off"
                />
              )}
              {/* Só se grava: nunca vem preenchido; new-password evita o navegador sugerir uma senha salva. */}
              <input
                type="password"
                autoComplete="new-password"
                aria-label={`${t('mcp.value')} ${p.key}`}
                placeholder={p.saved ? t('mcp.valueKeep') : t('mcp.value')}
                value={p.value}
                onChange={(e) => setPair(i, { value: e.target.value })}
                maxLength={4000}
              />
              <button
                type="button"
                className="btn-secondary is-danger mcp-pair-remove"
                aria-label={t('mcp.removeKey', { key: p.key || t('mcp.key') })}
                title={t('mcp.removeKey', { key: p.key || t('mcp.key') })}
                onClick={() => (p.saved ? setPair(i, { removed: true }) : set({ [kind]: d[kind].filter((_, j) => j !== i) }))}
              >
                <TrashIcon />
              </button>
            </div>
          ),
        )}
        <p className="actions">
          <button type="button" className="btn-secondary" onClick={() => set({ [kind]: [...d[kind], { key: '', value: '', saved: false, removed: false }] })}>
            {t(kind === 'env' ? 'mcp.addEnv' : 'mcp.addHeader')}
          </button>
        </p>
      </fieldset>
      {error && <p className="error small">{error}</p>}
      <p className="actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('office.connSaving') : t('mcp.save')}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t('office.cancel')}
        </button>
      </p>
    </form>
  );
}
