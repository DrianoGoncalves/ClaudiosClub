import { runGptMcpLazy } from './staff/gptMcpLite';

// Entrada do MCP do GPT (o Claude Code do funcionário sobe este processo; ver gptMcpServerConfig).
// Empacotado em dist/gpt-mcp.mjs (+ dist/gpt-mcp-core.mjs, o MCP inteiro) pelo build; em dev roda pelo tsx.
// Parado, só responde initialize, ping e tools/list (ver gptMcpLite.ts); o MCP inteiro carrega na primeira pergunta ao GPT.
// SIGTERM/SIGINT/SIGHUP e o fim do stdin encerram o codex em andamento (já com o MCP inteiro no ar; antes disso não há o que encerrar).

runGptMcpLazy(process.argv.slice(2), process.stdin, process.stdout, { handleSignals: true }).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-gpt] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
