import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Só os alfabetos da interface (pt-BR, en, es): latin e latin-ext. O 400.css/700.css traziam também cirílico (4 subconjuntos por peso).
import '@fontsource/caveat/latin-400.css';
import '@fontsource/caveat/latin-ext-400.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/caveat/latin-ext-700.css';
import '@xyflow/react/dist/style.css';
import { App } from './App';
import { reloadOnPreloadError } from './chunkReload';
import './styles.css';
import { initTheme } from './theme';

initTheme();
reloadOnPreloadError();

// Com o Claudio’s Club parado, abrir a porta mostra a página de início (checklist e botão Iniciar) em vez de
// "conexão recusada" (public/sw.js). Só no build: no `npm run dev` o Vite recarrega sozinho.
// Depois do `load`: o registro (e o download que ele dispara) não disputa banda com o primeiro carregamento da tela.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  const register = () => void navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
