import { runGptMcpStdio } from './staff/gptMcp';

// Entrada do MCP do GPT (o Claude Code do funcionário sobe este processo; ver gptMcpServerConfig).
// Empacotado em dist/gpt-mcp.mjs pelo build; em dev roda pelo tsx. SIGTERM/SIGINT/SIGHUP e o fim do stdin encerram o codex em andamento.

runGptMcpStdio(process.argv.slice(2), process.stdin, process.stdout, { handleSignals: true }).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-gpt] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
