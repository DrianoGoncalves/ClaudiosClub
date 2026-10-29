import { useEffect, useRef, useState } from 'react';
import type { AccountUsage, AuthStatus, QuotaBoost, UsageLimit } from '../../../shared/model';
import { api } from '../api';
import { formatAgo, formatDuration } from '../format';
import { TerminalFilledIcon } from '../icons';
import { locale, t } from '../i18n';

// Topo do quadro: nome da empresa (editável), consumo da conta e login do CLI.

/** "sáb., 14:00": quando a folga de cota acaba (o reset da cota de 7 dias). */
function formatBoostEnd(iso: string): string {
  return new Date(iso).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

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
          aria-label={t('toolbar.companyName')}
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
    <button className="toolbar-title company-name" onClick={() => setDraft(name)} title={t('toolbar.renameTitle')}>
      {name}
    </button>
  );
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: t('toolbar.limitShort') };

/** Consumo da conta, relido a cada 15 s: as barras e a bolinha da folga de cota (no ícone da assinatura) leem daqui. */
export function useAccountUsage(): AccountUsage | null {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  useEffect(() => {
    const load = () => api.usage().then(setUsage, () => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);
  return usage;
}

export function UsageMeters({ usage }: { usage: AccountUsage | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  if (!usage) return null;
  if (!usage.tapInstalled) {
    return (
      <span className="usage-note" title={t('toolbar.usageInstallTitle')}>
        {t('toolbar.usageInstall')}
      </span>
    );
  }
  const shown = ['five_hour', 'seven_day']
    .map((kind) => usage.limits.find((l) => l.kind === kind))
    .filter((l): l is UsageLimit => !!l);
  if (!shown.length) {
    return (
      <span className="usage-note" title={t('toolbar.usageOpenTitle')}>
        {t('toolbar.usageOpen')}
      </span>
    );
  }
  const updated = usage.updatedAt ? t('toolbar.updatedAgo', { ago: formatAgo(now - Date.parse(usage.updatedAt)) }) : '';
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
  const left = expired ? t('toolbar.resetDone') : resetMs !== null ? t('toolbar.resetsIn', { time: formatDuration(resetMs) }) : '';
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

/** Folga de cota ligada: bolinha "+" no canto do ícone; acabou, o ícone volta sem ela. */
export function AuthBadge({ boost }: { boost: QuotaBoost | null }) {
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
    const base = t('toolbar.cliSubscription', { method: auth.authMethod ?? '?' });
    const label = boost ? `${base}. ${t('toolbar.boostOn', { until: formatBoostEnd(boost.until) })}` : base;
    return (
      <span className="auth-light auth-ok" role="img" aria-label={label} title={label}>
        <TerminalFilledIcon />
        {boost && (
          <span className="auth-plus" aria-hidden="true">
            +
          </span>
        )}
      </span>
    );
  }

  const login = async () => {
    setError(null);
    try {
      const r = await api.login();
      if (r.ok) setWaiting(true);
      else setError(t('toolbar.loginFailed', { error: r.error ?? t('toolbar.terminalFailed'), command: String(r.command) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const reason = !auth.cliFound
    ? t('toolbar.reasonNoCli')
    : auth.loggedIn
      ? t('toolbar.reasonApi', { method: String(auth.authMethod) })
      : t('toolbar.reasonLoggedOut');

  // Semáforo: amarelo = logado pela API (cobra por token) ou aguardando login; vermelho = sem sessão possível.
  const light = waiting || (auth.cliFound && auth.loggedIn) ? 'auth-api' : 'auth-off';
  return (
    <span className="auth-warn">
      <span className={`auth-light ${light}`} role="img" aria-label={reason} title={reason}>
        <TerminalFilledIcon />
      </span>
      {auth.cliFound ? (
        <button className="btn-login" onClick={login} disabled={waiting} title={reason}>
          {waiting ? t('toolbar.waitingLogin') : auth.loggedIn ? t('toolbar.loginSubscription') : t('toolbar.loginClaude')}
        </button>
      ) : (
        <span className="usage-note" title={reason}>{t('toolbar.cliNotFound')}</span>
      )}
      {error && <span className="error">{error}</span>}
    </span>
  );
}
