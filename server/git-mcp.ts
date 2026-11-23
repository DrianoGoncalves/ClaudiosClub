import { runGitMcpStdio } from './staff/gitMcp';

// Entrada do MCP de git (o Claude Code ou o Codex do funcionário sobe este processo; ver gitMcpServer). Só roda empacotado, em
// dist/git-mcp.mjs, copiado para a pasta da conversa: o código que usa as credenciais do dono não é o que o agente edita.

runGitMcpStdio(process.argv.slice(2)).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`[myco-git] ${err instanceof Error ? err.message : 'erro'}\n`);
    process.exit(1);
  },
);
