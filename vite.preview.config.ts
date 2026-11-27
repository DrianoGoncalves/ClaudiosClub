import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mockApi } from './scripts/preview/mockApi';

// Prévia de interface (npm run preview:ui): serve o front com API simulada e dados fictícios.
// SEM proxy: /api é respondido aqui mesmo por scripts/preview/mockApi.ts, e nenhum servidor do Club roda.
// Porta própria e fixa (5199), diferente do dev (5173) e do Club (4848).
export default defineConfig({
  root: 'client',
  plugins: [react(), mockApi()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true, open: false },
});
