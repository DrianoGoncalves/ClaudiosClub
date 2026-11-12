import { runSshMcpStdio } from './staff/sshMcp';

// Entrada do MCP de SSH (o Claude Code do funcionário sobe este processo; ver sshMcpServerConfig).
// Empacotado em dist/ssh-mcp.mjs pelo build; em dev roda pelo tsx.

runSshMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-ssh] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
