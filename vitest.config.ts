import { defineConfig } from 'vitest/config';

// Separado do vite.config.ts, cujo `root` é a pasta do cliente.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Cada rodada ganha uma pasta própria no TEMP (os.tmpdir() dos testes) e a apaga no fim; só ela e as antigas (>1 h) com essa marca
    // são varridas (ver tests/support/tmpSweep.ts).
    globalSetup: ['tests/support/globalTmp.ts'],
  },
});
