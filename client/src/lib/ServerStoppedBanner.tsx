import { t } from '../i18n';
import { useServerPhase } from '../serverStatus';

/**
 * Aviso fixo (não some sozinho como um toast) de que o Claudio’s Club parou. Recarregar leva à página de início: com a porta
 * fechada, o service worker (client/public/sw.js) responde à navegação com ela, que tem o botão Iniciar. Não dá para abrir
 * essa página sozinho: ela só existe depois que o navegador falha em carregar, e nada escuta na porta para dizer que ela
 * está no ar; por isso o botão é o destaque da faixa. Se o servidor voltar, a sonda (serverStatus) tira a faixa.
 */
export function ServerStoppedView() {
  return (
    <div className="server-stopped" role="alert">
      <div className="server-stopped-text">
        <strong>{t('app.serverStoppedTitle')}</strong>
        <span>{t('app.serverStoppedBody')}</span>
      </div>
      <button type="button" className="btn-primary" onClick={() => location.reload()}>
        {t('app.serverStoppedGo')}
      </button>
    </div>
  );
}

export function ServerStoppedBanner() {
  return useServerPhase() === 'stopped' ? <ServerStoppedView /> : null;
}
