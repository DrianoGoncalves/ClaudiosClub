import { Component, type ErrorInfo, Suspense, type ReactNode } from 'react';
import { isChunkLoadError, reloadOnce } from './chunkReload';
import { t } from './i18n';
import { Skeleton } from './lib/Skeleton';

/** O texto do erro como texto puro (o React escapa; aqui só garante string e tamanho razoável). */
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/**
 * Falha numa tela aberta sob demanda: sem isto o erro sobe até a raiz e o app inteiro fica em branco. Aqui só a tela
 * afetada mostra o aviso. Dois casos distintos: falha de carga do pedaço (build trocado por uma atualização, rede
 * fora: recarrega sozinho uma vez e, se repetir, avisa com Recarregar) e erro de render (a tela quebrou: mostra o
 * motivo real). O `lazy` guarda a falha, então o jeito de tentar de novo é recarregar a página.
 */
class LoadFailure extends Component<{ children: ReactNode }, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Tela não carregou:', error, info.componentStack);
    if (isChunkLoadError(error)) reloadOnce();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const chunk = isChunkLoadError(this.state.error);
    return (
      <div className="notice notice-pair" role="alert">
        {chunk ? (
          <strong>{t('app.lazyFailed')}</strong>
        ) : (
          <span>
            <strong>{t('app.renderFailed')}</strong> <code>{errorText(this.state.error)}</code>
          </span>
        )}
        <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
}

/**
 * O `Suspense` das telas abertas sob demanda, com o aviso de falha de carga ou de render. Enquanto o pedaço da tela baixa, um esqueleto no lugar
 * dela (antes ficava vazio, e no celular parecia que o clique não tinha pegado): `modal` para as telas que abrem por cima de tudo (o esqueleto vem
 * no mesmo véu e caixa do modal); sem ele, linhas no lugar (o painel lateral). Quem precisa de outro, passa `fallback` (null = nada).
 */
export function LazyScreen({ children, modal = false, fallback }: { children: ReactNode; modal?: boolean; fallback?: ReactNode }) {
  const label = t('app.loadingScreen');
  const waiting =
    fallback !== undefined ? (
      fallback
    ) : modal ? (
      <div className="modal-backdrop">
        <div className="modal">
          <Skeleton label={label} lines={4} />
        </div>
      </div>
    ) : (
      <Skeleton label={label} />
    );
  return (
    <LoadFailure>
      <Suspense fallback={waiting}>{children}</Suspense>
    </LoadFailure>
  );
}
