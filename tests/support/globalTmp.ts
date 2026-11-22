import { startTestRun } from './tmpSweep';

// globalSetup do vitest. No começo, cria a pasta própria da rodada (`myco-testrun-<pid>-*`) e aponta TEMP/TMP/TMPDIR para ela: o que
// os testes criam em os.tmpdir() cai ali dentro. No fim apaga essa pasta e o que ficou para trás de baterias interrompidas (rodadas de
// processos mortos) e as pastas legadas de teste com mais de 1 hora. Só toca em nomes de teste; nunca em outro `myco-*` do TEMP.
// Não reprova a bateria se algo estiver preso.
export default function setup() {
  const run = startTestRun();
  return async () => {
    const r = await run.finish().catch(() => ({ removed: 0, failed: 0, runDirLeft: true, left: [] as string[] }));
    if (r.runDirLeft) console.log(`[tests] TEMP: não deu para apagar a pasta desta rodada (presa por algum processo): ${run.dir}${r.left.length ? ` (restou: ${r.left.slice(0, 8).join(', ')})` : ''}`);
    if (r.removed || r.failed) console.log(`[tests] TEMP: ${r.removed} pasta(s) de teste antigas apagadas${r.failed ? `, ${r.failed} não deu para apagar (presas)` : ''}`);
  };
}
