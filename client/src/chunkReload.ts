// Depois de uma atualização o build novo troca os arquivos de dist/client: uma aba (ou aparelho pareado) com a página
// velha pede um pedaço que não existe mais. O Vite avisa com `vite:preloadError`; recarregar traz a página nova.

const KEY = 'myco.preloadReloadAt';
/** Recarregou há menos que isto e deu o mesmo erro: não recarrega de novo (evita laço se o arquivo some de vez). */
export const RELOAD_GUARD_MS = 30_000;

/** Pode recarregar agora? `last` é o instante (ms) do último recarregamento por este motivo, se houve. */
export function mayReload(last: number | null, now: number): boolean {
  return last === null || now - last >= RELOAD_GUARD_MS;
}

function readLast(): number | null {
  try {
    const n = Number(sessionStorage.getItem(KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * O erro é de carga de pedaço (import dinâmico que falhou: arquivo que sumiu numa atualização, rede fora) e não de
 * render? Cada navegador usa a sua frase; o Vite avisa pelo `vite:preloadError`, mas o erro também chega ao React.
 */
export function isChunkLoadError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  if (name === 'ChunkLoadError') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /dynamically imported module|importing a module script failed|error loading dynamically imported module|unable to preload css|loading (css )?chunk [\w-]+ failed/i.test(
    message,
  );
}

/** Marca e recarrega a página, a menos que já tenha recarregado por isso dentro do prazo. Devolve se recarregou. */
export function reloadOnce(): boolean {
  const now = Date.now();
  if (!mayReload(readLast(), now)) return false;
  try {
    sessionStorage.setItem(KEY, String(now));
  } catch {
    // sem armazenamento não há como vigiar o laço: não recarrega
    return false;
  }
  window.location.reload();
  return true;
}

/** Recarrega a página uma vez por falha de pedaço; na segunda dentro do prazo deixa o erro seguir (a tela mostra o aviso). */
export function reloadOnPreloadError(): void {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnce()) event.preventDefault();
  });
}
