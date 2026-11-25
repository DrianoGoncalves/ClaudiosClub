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
    // Os 5 s padrão do vitest estouram sob carga (suíte inteira com 3 workers numa máquina de 4 CPUs, git e spawn lentos): o teste caía sem estar errado e o resultado da
    // entrega virava "falhou". 30 s dão folga sem esconder travamento de verdade (teste parado ainda cai); quem precisa de mais declara no próprio `it`.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // No máximo 2 processos de teste na máquina local (HDD, 4 núcleos, 8 GB): 3 workers de ~350 MB cada, com os funcionários trabalhando, faziam o Windows paginar e tudo
    // travar. No GitHub Actions fica o padrão do vitest. Olha o GITHUB_ACTIONS, não o CI: o Club roda as suítes com CI=1 (ver `spawnTests`). `MYCO_TEST_WORKERS` troca o
    // número (SPEC "Desempenho" 9).
    maxWorkers: process.env.GITHUB_ACTIONS ? undefined : Number(process.env.MYCO_TEST_WORKERS) || 2,
  },
});
