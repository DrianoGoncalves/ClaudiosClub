import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AppServerInfo, PendingReason } from '../../../shared/model';
import { api } from '../api';
import { t, type MsgKey } from '../i18n';

// Parar e Reiniciar o servidor do Claudio’s Club: o config e o aviso de "mudanças pendentes" do topo usam o mesmo
// fluxo (confirmação com quem perde o que faz, tela de espera, recarregar quando o servidor novo responde).

type ServerState = 'idle' | 'stopping' | 'stopped' | 'restarting';

export function useServerAction(): { state: ServerState; error: string | null; act: (action: 'stop' | 'restart') => Promise<void>; overlay: ReactNode } {
  const [state, setState] = useState<ServerState>('idle');
  const [error, setError] = useState<string | null>(null);

  const act = async (action: 'stop' | 'restart') => {
    // Na hora do clique, não de quando o menu abriu: quem está trabalhando agora perde o que faz.
    const current = await api.serverInfo().catch(() => null);
    const working = current?.working;
    const startedAt = current?.startedAt;
    const cut = [
      working?.busy ? t('toolbar.cutBusy', { n: working.busy }) : '',
      working?.background ? t('toolbar.cutBackground', { n: working.background }) : '',
    ].filter(Boolean);
    const warn = cut.length ? `\n\n${t('toolbar.warnCut', { cut: cut.join(` ${t('toolbar.and')} `) })}` : '';
    const ask = (action === 'stop' ? t('toolbar.askStop') : t('toolbar.askRestart')) + warn;
    if (!window.confirm(ask)) return;
    setError(null);
    setState(action === 'stop' ? 'stopping' : 'restarting');
    try {
      await api.serverAction(action);
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
      return;
    }
    if (action === 'stop') {
      // Espera o servidor sumir de verdade antes de dizer que parou.
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!(await fetch('/api/health').then((r) => r.ok, () => false))) break;
      }
      // Com o service worker, recarregar já mostra a página de início (checklist e botão Iniciar).
      if (navigator.serviceWorker?.controller) return window.location.reload();
      setState('stopped');
      return;
    }
    // Reiniciando: o servidor gera o build do cliente antes de sair, então o antigo segue no ar
    // por até ~2 min. Só recarrega quando o startedAt mudou (servidor novo), senão cairia no antigo.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const now = await api.serverInfo().catch(() => null);
      if (now && now.startedAt !== startedAt) return window.location.reload();
    }
    setError(t('toolbar.serverNotBack'));
    setState('idle');
  };

  const overlay =
    state !== 'idle' &&
    createPortal(
      <div className="server-overlay" role="alertdialog" aria-live="assertive">
        <div className="server-overlay-card">
          {state === 'restarting' && (
            <div className="server-overlay-brand">
              <img src="/icon-192.png" alt="" width={112} height={112} />
              <h2>{t('toolbar.restartingTitle')}</h2>
            </div>
          )}
          {state === 'stopping' && (
            <div className="server-overlay-brand">
              <img src="/icon-192.png" alt="" width={112} height={112} />
              <h2>{t('toolbar.stoppingTitle')}</h2>
            </div>
          )}
          {state === 'stopped' && (
            <>
              <h2>{t('toolbar.stoppedTitle')}</h2>
              <p>{t('toolbar.stoppedBody')}</p>
              <p>
                {t('toolbar.startAgainA')} <code>npm run daily:start</code> {t('toolbar.startAgainC')}
              </p>
            </>
          )}
        </div>
      </div>,
      document.body,
    );

  return { state, error, act, overlay };
}

const REASON_KEY: Record<PendingReason, MsgKey> = {
  server: 'toolbar.pendingServer',
  client: 'toolbar.pendingClient',
  ftpMcp: 'toolbar.pendingFtpMcp',
  gptMcp: 'toolbar.pendingGptMcp',
};

/** O servidor guarda o resultado por 30 s; relido aqui no mesmo ritmo. */
function useServerInfo(): AppServerInfo | null {
  const [info, setInfo] = useState<AppServerInfo | null>(null);
  useEffect(() => {
    const load = () => api.serverInfo().then(setInfo, () => {});
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);
  return info;
}

/** "Mudanças pendentes" no topo: há código novo no disco que só entra reiniciando. Some quando não há. */
export function PendingRestartNotice() {
  const info = useServerInfo();
  const { state, error, act, overlay } = useServerAction();
  if (!info?.pendingRestart) return null;
  const words = info.pendingReasons.map((r) => t(REASON_KEY[r]));
  const reasons = words.length > 1 ? `${words.slice(0, -1).join(', ')} ${t('toolbar.and')} ${words.at(-1)}` : (words[0] ?? '');
  // Sem o vigia não há Reiniciar: o aviso só explica como fazer à mão.
  const title = [t('toolbar.pendingTitle', { reasons }), info.daemon ? t('toolbar.pendingClick') : t('toolbar.pendingNoDaemon'), error]
    .filter(Boolean)
    .join('\n');
  return (
    <>
      <button
        type="button"
        className={`restart-pending${error ? ' is-error' : ''}`}
        title={title}
        aria-label={`${t('toolbar.pendingBadge')}. ${title}`}
        // aria-disabled e não disabled: botão desligado não mostra o tooltip, e sem vigia é ele que explica.
        aria-disabled={!info.daemon || state !== 'idle'}
        onClick={() => info.daemon && state === 'idle' && void act('restart')}
      >
        {t('toolbar.pendingBadge')}
      </button>
      {overlay}
    </>
  );
}
