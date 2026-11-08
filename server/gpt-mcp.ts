import { runGptMcpStdio } from './staff/gptMcp';

// Entrada do MCP do GPT (o Claude Code do funcionário sobe este processo; ver gptMcpServerConfig).
// Empacotado em dist/gpt-mcp.mjs pelo build; em dev roda pelo tsx.

runGptMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-gpt] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
