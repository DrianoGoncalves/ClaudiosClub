import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/caveat/400.css';
import '@fontsource/caveat/700.css';
import '@xyflow/react/dist/style.css';
import { App } from './App';
import './styles.css';

// Com o Claudio’s Club parado, abrir a porta mostra a página de início (checklist e botão Iniciar) em vez de
// "conexão recusada" (public/sw.js). Só no build: no `npm run dev` o Vite recarrega sozinho.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
