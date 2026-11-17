import { runMemoriaMcpStdio } from './staff/memoriaMcp';

// Entrada do MCP da memória da própria ficha (o Claude Code ou o Codex do funcionário em plan sobe este processo; ver memoriaMcpServer).
// Empacotado em dist/memoria-mcp.mjs pelo build; em dev roda pelo tsx.

runMemoriaMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-memoria] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
