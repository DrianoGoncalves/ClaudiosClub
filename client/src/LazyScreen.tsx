import { Component, type ErrorInfo, Suspense, type ReactNode } from 'react';
import { isChunkLoadError, reloadOnce } from './chunkReload';
import { t } from './i18n';

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

/** O `Suspense` das telas abertas sob demanda, com o aviso de falha de carga ou de render. */
export function LazyScreen({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <LoadFailure>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadFailure>
  );
}
