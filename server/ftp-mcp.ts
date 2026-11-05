import { runFtpMcpStdio } from './staff/ftpMcp';

// Entrada do MCP de FTP (o Claude Code do funcionário sobe este processo; ver ftpMcpServerConfig).
// Empacotado em dist/ftp-mcp.mjs pelo build; em dev roda pelo tsx.

runFtpMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-ftp] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
