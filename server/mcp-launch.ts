import { runMcpLaunchCli } from './staff/mcpLaunch';

// Entrada do lançador dos MCPs da biblioteca (ver mcpLaunch.ts). O Claude Code sobe este processo (stdio) ou o roda
// com --headers (cabeçalhos). Empacotado em dist/mcp-launch.mjs pelo build; em dev roda pelo tsx.
// Sem process.exit: o stdout do --headers precisa terminar de sair (num pipe do Windows a escrita é assíncrona).

runMcpLaunchCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
