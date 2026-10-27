import { useEffect, useRef, useState } from 'react';
import type { AccountUsage, AuthStatus, UsageLimit } from '../../../shared/model';
import { api } from '../api';
import { formatAgo, formatDuration } from '../format';

// Topo do quadro: nome da empresa (editável), consumo da conta e login do CLI.

export function CompanyTitle({ name, onRename }: { name: string; onRename: (name: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (draft !== null) input.current?.select();
  }, [draft !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (draft === null) return;
    const value = draft.trim();
    if (!value || value === name) {
      setDraft(null);
      setError(null);
      return;
    }
    try {
      await onRename(value);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (draft !== null) {
    return (
      <span className="company-edit">
        <input
          ref={input}
          className="toolbar-title company-input"
          value={draft}
          maxLength={40}
          aria-label="Nome da empresa"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') {
              setDraft(null);
              setError(null);
            }
          }}
        />
        {error && <span className="error">{error}</span>}
      </span>
    );
  }
  return (
    <button className="toolbar-title company-name" onClick={() => setDraft(name)} title="Clique para renomear">
      {name}
    </button>
  );
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'limite' };

export function UsageMeters() {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () => api.usage().then(setUsage, () => {});
    load();
    const t = setInterval(() => {
      load();
      setNow(Date.now());
    }, 15_000);
    return () => clearInterval(t);
  }, []);

  if (!usage) return null;
  if (!usage.tapInstalled) {
    return (
      <span className="usage-note" title="O consumo 5h/7d vem do mod myco-tap. Rode: npm run mod:install">
        consumo: instale o myco-tap
      </span>
    );
  }
  const shown = ['five_hour', 'seven_day']
    .map((kind) => usage.limits.find((l) => l.kind === kind))
    .filter((l): l is UsageLimit => !!l);
  if (!shown.length) {
    return (
      <span
        className="usage-note"
        title={
          'O consumo 5h/7d chega pelo mod myco-tap, que só roda em sessões do app abertas depois da instalação ' +
          '(o claude do terminal está com mods desligados por enquanto). Abra uma sessão nova no app e mande uma mensagem.'
        }
      >
        consumo: abra uma sessão nova no app
      </span>
    );
  }
  const updated = usage.updatedAt ? `lido ${formatAgo(now - Date.parse(usage.updatedAt))}` : '';
  return (
    <span className="usage" title={updated}>
      {shown.map((l) => (
        <UsageMeter key={l.kind} limit={l} now={now} />
      ))}
    </span>
  );
}

function UsageMeter({ limit, now }: { limit: UsageLimit; now: number }) {
  const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) - now : null;
  // Janela já reiniciada: a leitura gravada não vale mais até a próxima resposta.
  const expired = resetMs !== null && resetMs <= 0;
  const pct = expired ? 0 : Math.min(100, Math.max(0, limit.percentUsed));
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
  const label = LIMIT_LABEL[limit.kind] ?? limit.kind;
  const left = expired ? 'reiniciou' : resetMs !== null ? `reinicia em ${formatDuration(resetMs)}` : '';
  return (
    <span className={`meter meter-${level}`} title={`${label}: ${expired ? '—' : `${Math.round(pct)}%`} ${left}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-value">{expired ? '—' : `${Math.round(pct)}%`}</span>
      {resetMs !== null && !expired && <span className="meter-reset">{formatDuration(resetMs)}</span>}
    </span>
  );
}

export function AuthBadge() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => api.auth().then(setAuth, () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  // Depois do clique, confere a cada 3 s (até 3 min) se o login foi concluído no navegador.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const status = await api.auth(true).catch(() => null);
      if (status) setAuth(status);
      if (status?.loggedIn || Date.now() - started > 180_000) setWaiting(false);
    }, 3000);
    return () => clearInterval(t);
  }, [waiting]);

  if (!auth) return null;

  if (auth.loggedIn && auth.subscription) {
    return (
      <span className="auth-ok" title={`CLI logado pela assinatura (${auth.authMethod ?? '?'})`}>
        <span className="dot dot-ok" /> assinatura
      </span>
    );
  }

  const login = async () => {
    setError(null);
    try {
      const r = await api.login();
      if (r.ok) setWaiting(true);
      else setError(`${r.error ?? 'não foi possível abrir o terminal'}. Rode: ${r.command}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reason = !auth.cliFound
    ? '`claude` não encontrado no PATH'
    : auth.loggedIn
      ? `logado pela API (${auth.authMethod}): as sessões cobrariam por token`
      : 'o CLI está deslogado: o MyCo não consegue abrir sessões';

  return (
    <span className="auth-warn">
      {auth.cliFound ? (
        <button className="btn-login" onClick={login} disabled={waiting} title={reason}>
          {waiting ? 'aguardando login…' : auth.loggedIn ? 'Entrar pela assinatura' : 'Entrar no Claude'}
        </button>
      ) : (
        <span className="usage-note" title={reason}>CLI não encontrado</span>
      )}
      {error && <span className="error">{error}</span>}
    </span>
  );
}

