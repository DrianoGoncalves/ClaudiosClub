import { Component, type ErrorInfo, Suspense, type ReactNode } from 'react';
import { t } from './i18n';

/**
 * Falha ao carregar o pedaço de uma tela (build trocado por uma atualização, rede fora): sem isto o erro sobe até a
 * raiz e o app inteiro fica em branco. Aqui só a tela afetada mostra o aviso; o `lazy` guarda a falha, então o jeito
 * de tentar de novo é recarregar a página.
 */
class LoadFailure extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Tela não carregou:', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="notice notice-pair" role="alert">
        <strong>{t('app.lazyFailed')}</strong>
        <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
          {t('app.reload')}
        </button>
      </div>
    );
  }
}

/** O `Suspense` das telas abertas sob demanda, com o aviso de falha de carga. */
export function LazyScreen({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <LoadFailure>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LoadFailure>
  );
}
