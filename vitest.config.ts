import { defineConfig } from 'vitest/config';

// Separado do vite.config.ts, cujo `root` é a pasta do cliente.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Cada rodada ganha uma pasta própria no TEMP (os.tmpdir() dos testes) e a apaga no fim, junto com as sobras de baterias interrompidas
    // e as pastas legadas de teste com mais de 1 h; nunca outro `myco-*` (ver tests/support/tmpSweep.ts).
    globalSetup: ['tests/support/globalTmp.ts'],
  },
});
