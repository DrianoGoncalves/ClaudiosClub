import { defineConfig } from 'vitest/config';

// Separado do vite.config.ts, cujo `root` é a pasta do cliente.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
