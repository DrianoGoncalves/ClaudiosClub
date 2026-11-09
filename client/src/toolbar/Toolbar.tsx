import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountUsage, AuthStatus, CodexUsage, QuotaBoost, UsageLimit } from '../../../shared/model';
import { api } from '../api';
import { formatAgo, formatDuration } from '../format';
import { TerminalFilledIcon } from '../icons';
import { locale, t } from '../i18n';
import { installCodex, useCodexSetup } from './codexSetup';

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

const USAGE_URL = 'https://claude.ai/settings/usage';
const LIMIT_LABEL: Record<string, string> ={ five_hour: '5h', seven_day: '7d', spend_limit: t('toolbar.limitShort') };

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

/** Relógio das barras: reavalia "reinicia em" e janelas já reiniciadas a cada 15 s. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Só as barras de 5 h e de 7 d, na ordem; o Claude e o Codex mandam `limits` no mesmo formato. */
function pickLimits(limits: UsageLimit[]): UsageLimit[] {
  return ['five_hour', 'seven_day'].map((kind) => limits.find((l) => l.kind === kind)).filter((l): l is UsageLimit => !!l);
}

export function UsageMeters({ usage }: { usage: AccountUsage | null }) {
  const now = useNow();

  if (!usage) return null;
  if (!usage.tapInstalled) {
    return (
      <span className="usage-note" title={t('toolbar.usageInstallTitle')}>
        {t('toolbar.usageInstall')}
      </span>
    );
  }
  const shown = pickLimits(usage.limits);
  if (!shown.length) {
    return (
      <span className="usage-note" title={t('toolbar.usageOpenTitle')}>
        {t('toolbar.usageOpen')}
      </span>
    );
  }
  const updated = usage.updatedAt ? t('toolbar.updatedAgo', { ago: formatAgo(now - Date.parse(usage.updatedAt)) }) : '';
  return (
    <a
      className="usage"
      href={USAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      title={updated ? `${t('toolbar.usageLink')} · ${updated}` : t('toolbar.usageLink')}
    >
      {shown.map((l) => (
        <UsageMeter key={l.kind} limit={l} now={now} service="claude" />
      ))}
    </a>
  );
}

function UsageMeter({ limit, now, service, name }: { limit: UsageLimit; now: number; service: 'claude' | 'codex'; name?: string }) {
  const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) - now : null;
  // Janela já reiniciada: a leitura gravada não vale mais até a próxima resposta.
  const expired = resetMs !== null && resetMs <= 0;
  const pct = expired ? 0 : Math.min(100, Math.max(0, limit.percentUsed));
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low';
  const label = LIMIT_LABEL[limit.kind] ?? limit.kind;
  const left = expired ? t('toolbar.resetDone') : resetMs !== null ? t('toolbar.resetsIn', { time: formatDuration(resetMs) }) : '';
  return (
    <span className={`meter meter-${level} meter-${service}`} title={`${name ? `${name} · ` : ''}${label}: ${expired ? '—' : `${Math.round(pct)}%`} ${left}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="meter-value">{expired ? '—' : `${Math.round(pct)}%`}</span>
      {resetMs !== null && !expired && <span className="meter-reset">{formatDuration(resetMs)}</span>}
    </span>
  );
}

/** Nome do serviço ao lado do ícone >_ (só texto; em tela estreita some, e o nome segue no title/aria-label do ícone). */
function ConnName({ name }: { name: string }) {
  return (
    <span className="auth-name" aria-hidden="true">
      {name}
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

  const name = t('toolbar.claudeName');

  if (auth.loggedIn && auth.subscription) {
    const base = t('toolbar.cliSubscription', { method: auth.authMethod ?? '?' });
    const label = `${name} · ${boost ? `${base}. ${t('toolbar.boostOn', { until: formatBoostEnd(boost.until) })}` : base}`;
    return (
      <span className="auth-conn">
        <span className="auth-light auth-ok" role="img" aria-label={label} title={label}>
          <TerminalFilledIcon />
          {boost && (
            <span className="auth-plus" aria-hidden="true">
              +
            </span>
          )}
        </span>
        <ConnName name={name} />
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
      <span className={`auth-light ${light}`} role="img" aria-label={`${name} · ${reason}`} title={`${name} · ${reason}`}>
        <TerminalFilledIcon />
      </span>
      <ConnName name={name} />
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

/**
 * Linha do Codex, logo abaixo da do Claude: barras de 5 h e 7 d e o ícone de conexão (o mesmo >_ do Claude, no mesmo
 * semáforo). Só existe com `usage.codex`, isto é, com "usar o Codex" ligado no config.
 */
export function CodexUsageLine({ codex }: { codex: CodexUsage }) {
  const now = useNow();
  const setup = useCodexSetup();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Leitura pedida pela própria linha (depois do login ou da instalação); a próxima do quadro a substitui.
  const [fresh, setFresh] = useState<CodexUsage | null>(null);
  const wasInstalling = useRef(false);
  useEffect(() => setFresh(null), [codex]);
  const cx = fresh ?? codex;
  const name = t('toolbar.codexName');
  const shown = pickLimits(cx.limits);
  const updated = cx.updatedAt ? t('toolbar.updatedAgo', { ago: formatAgo(now - Date.parse(cx.updatedAt)) }) : '';

  // Depois do clique em "Entrar no Codex", confere a cada 3 s (até 3 min) se o login foi concluído no navegador.
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const t = setInterval(async () => {
      const u = await api.usage(true).catch(() => null);
      if (u?.codex) setFresh(u.codex);
      if (u?.codex?.connected || Date.now() - started > 180_000) setWaiting(false);
    }, 3000);
    return () => clearInterval(t);
  }, [waiting]);

  // Terminou uma instalação (aqui ou nas Configurações): relê o status já, sem esperar a próxima leitura do quadro.
  useEffect(() => {
    if (setup.installing) {
      wasInstalling.current = true;
    } else if (wasInstalling.current) {
      wasInstalling.current = false;
      void api.usage(true).then((u) => {
        if (u.codex) setFresh(u.codex);
      }, () => {});
    }
  }, [setup.installing]);

  const login = async () => {
    setError(null);
    try {
      const r = await api.loginCodex();
      if (r.ok) setWaiting(true);
      else setError(r.error ?? t('toolbar.terminalFailed'));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const install = () => {
    setError(null);
    void installCodex();
  };

  // Semáforo do ícone: verde conectado, cinza lendo pela primeira vez, vermelho sem Codex utilizável.
  const light = cx.connected ? 'auth-ok' : cx.reason === 'loading' ? 'auth-wait' : 'auth-off';
  const version = cx.version?.installed ? ` (${cx.version.installed})` : '';
  const status = cx.connected
    ? t('toolbar.codexConnected', { version })
    : cx.reason === 'not_installed'
      ? t('toolbar.codexNotInstalled')
      : cx.reason === 'not_logged_in'
        ? t('toolbar.codexNotLoggedIn')
        : cx.reason === 'loading'
          ? t('toolbar.codexLoading')
          : t('toolbar.codexError');
  const iconLabel = !cx.connected && cx.detail ? `${status}: ${cx.detail}` : status;
  // O erro da instalação aparece só enquanto o Codex não está instalado (depois, a linha já mostra o novo estado).
  const shownError = error ?? (!setup.installing && cx.reason === 'not_installed' ? setup.error : null);
  // O que fazer quando não está conectado: a ação ao lado do ícone, igual ao "Entrar" do Claude.
  let action: ReactNode = null;
  if (setup.installing) {
    action = <span className="usage-note">{t('toolbar.codexInstalling')}</span>;
  } else if (cx.reason === 'not_installed') {
    action = (
      <button className="btn-login" onClick={install} title={iconLabel}>
        {t('toolbar.codexInstall')}
      </button>
    );
  } else if (cx.reason === 'not_logged_in') {
    action = (
      <button className="btn-login" onClick={login} disabled={waiting} title={iconLabel}>
        {waiting ? t('toolbar.waitingLogin') : t('toolbar.codexLogin')}
      </button>
    );
  } else if (cx.reason === 'error') {
    action = (
      <span className="usage-note" title={iconLabel}>
        {t('toolbar.codexDoError')}
      </span>
    );
  }

  return (
    <div className="usage-line usage-codex">
      {shown.length > 0 && (
        <span className="usage" title={updated ? `${name} · ${updated}` : name}>
          {shown.map((l) => (
            <UsageMeter key={l.kind} limit={l} now={now} service="codex" name={name} />
          ))}
        </span>
      )}
      <span className="auth-conn">
        <span className={`auth-light ${light}`} role="img" aria-label={iconLabel} title={iconLabel}>
          <TerminalFilledIcon />
        </span>
        <ConnName name={name} />
      </span>
      {action}
      {shownError && <span className="error">{shownError}</span>}
      {cx.version?.outdated && cx.upgradeCommand && (
        <span className="usage-note usage-outdated" title={t('toolbar.codexOutdatedTitle', { command: cx.upgradeCommand })}>
          {t('toolbar.codexOutdated', { command: cx.upgradeCommand })}
        </span>
      )}
    </div>
  );
}
