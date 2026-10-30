import fs from 'node:fs';
import path from 'node:path';

/**
 * Raiz do projeto: a primeira pasta com package.json acima deste arquivo. Vale rodando do .ts (tsx, testes) e do
 * pacote em dist/server.mjs, onde import.meta.dirname de cada arquivo vira a pasta dist/.
 */
export const ROOT = findRoot(import.meta.dirname);

function findRoot(dir: string): string {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(import.meta.dirname, '..');
  }
}
