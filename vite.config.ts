import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { registerOrigin } from './scripts/hooks/club-origins.mjs';

const serverPort = Number(process.env.MYCO_PORT ?? 4848);

// Este Vite serve a tela do Club com proxy de /api para o servidor: quem abre 127.0.0.1:<porta> aqui vê a tela do dono (o cookie do pareamento vale
// para o host em qualquer porta). Ao abrir a porta ele grava a origem no registro que o bloqueio do navegador dos funcionários lê
// (server/clubAddress.ts). Só o servidor de desenvolvimento: `vite build` não chama este plugin. A prévia de interface (vite.preview.config.ts, sem
// proxy) tem outra configuração e não registra.
const registerClubOrigin = (): Plugin => ({
  name: 'myco-club-origin',
  apply: 'serve',
  configureServer(server) {
    const http = server.httpServer;
    http?.once('listening', () => {
      const addr = http.address();
      const unregister = addr && typeof addr === 'object' ? registerOrigin({ kind: 'vite', port: addr.port, proxyTo: serverPort }) : null;
      if (unregister) http.once('close', unregister);
    });
  },
});

export default defineConfig({
  root: 'client',
  plugins: [react(), registerClubOrigin()],
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
