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

/** Recarrega a página uma vez por falha de pedaço; na segunda dentro do prazo deixa o erro seguir (a tela mostra o aviso). */
export function reloadOnPreloadError(): void {
  window.addEventListener('vite:preloadError', (event) => {
    const now = Date.now();
    if (!mayReload(readLast(), now)) return;
    try {
      sessionStorage.setItem(KEY, String(now));
    } catch {
      // sem armazenamento não há como vigiar o laço: não recarrega
      return;
    }
    event.preventDefault();
    window.location.reload();
  });
}
