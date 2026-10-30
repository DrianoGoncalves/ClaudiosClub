import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/root';

// Servidor e vigia num arquivo .mjs cada, rodados com o node puro. Pelo tsx, cada processo carrega o transpilador e
// um esbuild ao lado: ~40 MB a mais, o tempo todo. O pacote só junta o nosso código (sem checar tipos: isso é o
// tsc do npm run build); as dependências seguem vindo do node_modules. Uso: tsx scripts/bundle.ts

export const SERVER_BUNDLE = path.join(ROOT, 'dist', 'server.mjs');
export const DAEMON_BUNDLE = path.join(ROOT, 'dist', 'daemon.mjs');

/** Ao lado do pacote, os arquivos que entraram nele: é por eles que se sabe se ficou velho. */
const inputsFile = (out: string) => out.replace(/\.mjs$/, '.inputs.json');

/** O pacote falta ou algum arquivo dele (ou o package-lock.json) mudou desde o build? */
export function bundleStale(out: string): boolean {
  const built = fs.statSync(out, { throwIfNoEntry: false });
  if (!built) return true;
  let inputs: string[];
  try {
    inputs = JSON.parse(fs.readFileSync(inputsFile(out), 'utf8')) as string[];
  } catch {
    return true;
  }
  // Arquivo apagado conta como mudança.
  return [...inputs, 'package-lock.json'].some((f) => (fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.mtimeMs ?? Infinity) > built.mtimeMs);
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
}

if (path.basename(process.argv[1] ?? '') === 'bundle.ts') await bundleAll();
