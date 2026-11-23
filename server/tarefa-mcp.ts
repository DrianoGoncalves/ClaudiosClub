import { runTarefaMcpStdio } from './staff/tarefaMcp';

// Entrada do MCP de tarefa (o Claude Code do funcionário sobe este processo; ver tarefaMcpServer). Empacotado em dist/tarefa-mcp.mjs pelo build; em dev roda pelo tsx.

runTarefaMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-tarefa] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
