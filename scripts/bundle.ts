import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/root';

// Servidor e vigia num arquivo .mjs cada, rodados com o node puro. Pelo tsx, cada processo carrega o transpilador e
// um esbuild ao lado: ~40 MB a mais, o tempo todo. O pacote só junta o nosso código (sem checar tipos: isso é o
// tsc do npm run build); as dependências seguem vindo do node_modules. Uso: tsx scripts/bundle.ts

export const SERVER_BUNDLE = path.join(ROOT, 'dist', 'server.mjs');
export const DAEMON_BUNDLE = path.join(ROOT, 'dist', 'daemon.mjs');
/** MCP de FTP que as sessões dos funcionários sobem (server/staff/ftpMcp.ts acha o pacote aqui). */
export const FTP_MCP_BUNDLE = path.join(ROOT, 'dist', 'ftp-mcp.mjs');
/** MCP do GPT (`perguntar_gpt`) que as sessões dos funcionários sobem (server/staff/gptMcp.ts acha o pacote aqui). */
export const GPT_MCP_BUNDLE = path.join(ROOT, 'dist', 'gpt-mcp.mjs');
/** MCP de SSH que as sessões dos funcionários sobem (server/staff/sshMcp.ts acha o pacote aqui). */
export const SSH_MCP_BUNDLE = path.join(ROOT, 'dist', 'ssh-mcp.mjs');
/** Lançador dos MCPs da biblioteca (server/staff/mcpLaunch.ts acha o pacote aqui). */
export const MCP_LAUNCH_BUNDLE = path.join(ROOT, 'dist', 'mcp-launch.mjs');

/** Ao lado do pacote, os arquivos que entraram nele: é por eles que se sabe se ficou velho. */
const inputsFile = (out: string) => out.replace(/\.mjs$/, '.inputs.json');

/** O pacote falta ou algum arquivo dele (ou o package-lock.json) mudou desde o build? */
export function bundleStale(out: string, root = ROOT): boolean {
  const built = fs.statSync(out, { throwIfNoEntry: false });
  if (!built) return true;
  const inputs = bundleInputs(out);
  if (!inputs) return true;
  // Arquivo apagado conta como mudança.
  return [...inputs, 'package-lock.json'].some((f) => (fs.statSync(path.join(root, f), { throwIfNoEntry: false })?.mtimeMs ?? Infinity) > built.mtimeMs);
}

/** Os arquivos (relativos à raiz) que entraram no pacote no último build; null sem a lista. */
export function bundleInputs(out: string): string[] | null {
  try {
    const list = JSON.parse(fs.readFileSync(inputsFile(out), 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : null;
  } catch {
    return null;
  }
}

/** Gera o pacote de `entry` (relativo à raiz) em `out`. Síncrono: não deixa um processo do esbuild aberto. */
export async function bundle(entry: string, out: string): Promise<void> {
  const { buildSync } = await import('esbuild');
  const result = buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    metafile: true,
    logLevel: 'warning',
  });
  fs.writeFileSync(inputsFile(out), JSON.stringify(Object.keys(result.metafile.inputs)));
}

export async function bundleAll(): Promise<void> {
  await bundle('server/index.ts', SERVER_BUNDLE);
  await bundle('scripts/daemon.ts', DAEMON_BUNDLE);
  await bundle('server/ftp-mcp.ts', FTP_MCP_BUNDLE);
  await bundle('server/gpt-mcp.ts', GPT_MCP_BUNDLE);
  await bundle('server/ssh-mcp.ts', SSH_MCP_BUNDLE);
  await bundle('server/mcp-launch.ts', MCP_LAUNCH_BUNDLE);
}

if (path.basename(process.argv[1] ?? '') === 'bundle.ts') await bundleAll();
