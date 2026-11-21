import { startTestRun } from './tmpSweep';

// globalSetup do vitest. No começo, cria a pasta própria da rodada (`myco-testrun-*`) e aponta TEMP/TMP/TMPDIR para ela: o que os
// testes criam em os.tmpdir() cai ali dentro. No fim apaga essa pasta e as de rodadas antigas (mais de 1 hora) que ficaram para trás.
// Só toca no que tem a marca da bateria; nunca em outro `myco-*` do TEMP. Não reprova a bateria se algo estiver preso.
export default function setup() {
  const run = startTestRun();
  return async () => {
    const { removed, failed, runDirLeft } = await run.finish().catch(() => ({ removed: 0, failed: 0, runDirLeft: true }));
    if (runDirLeft) console.log(`[tests] TEMP: não deu para apagar a pasta desta rodada (presa por algum processo): ${run.dir}`);
    if (removed || failed) console.log(`[tests] TEMP: ${removed} pasta(s) de rodadas antigas apagadas${failed ? `, ${failed} não deu para apagar (presas)` : ''}`);
  };
}
