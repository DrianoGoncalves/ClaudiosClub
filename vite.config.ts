import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.MYCO_PORT ?? 4848);

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // Porta fixa: ocupada, o Vite para com erro em vez de pular para 5174, 5175…
    port: 5173,
    strictPort: true,
    // Endereço fixo em desenvolvimento: http://claudio.localhost:5173 (ver server/index.ts).
    allowedHosts: ['claudio.localhost', 'myco.localhost'],
    open: false,
    proxy: { '/api': `http://127.0.0.1:${serverPort}` },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});
