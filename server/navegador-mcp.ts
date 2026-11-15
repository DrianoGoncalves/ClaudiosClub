import { parseProxyArgs, runNavegadorProxy } from './navegadorMcp';

// Entrada do proxy preguiçoso do MCP do navegador limpo (ver navegadorMcp.ts): `[--cache-dir <pasta>] -- <comando> <argumentos…>`.
// Empacotado em dist/navegador-mcp.mjs pelo build; em dev roda pelo tsx. SIGTERM/SIGINT/SIGHUP e o fim do stdin encerram o servidor de verdade.

try {
  const real = parseProxyArgs(process.argv.slice(2));
  runNavegadorProxy({ ...real, handleSignals: true }).then(
    () => process.exit(0),
    (err: unknown) => {
      process.stderr.write(`[myco-navegador] ${err instanceof Error ? err.message : 'erro'}\n`);
      process.exit(1);
    },
  );
} catch (err) {
  process.stderr.write(`[myco-navegador] ${err instanceof Error ? err.message : 'erro'}\n`);
  process.exit(1);
}
