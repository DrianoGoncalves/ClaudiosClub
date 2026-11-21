import { mkdtempSync, promises as fs, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Limpeza das pastas que os testes criam em os.tmpdir(). No Windows um processo filho (git, node) ou o antivírus ainda
// segurando um arquivo faz o rm falhar com EBUSY/EPERM: tenta de novo e, se não der, deixa a pasta (o teste não reprova por
// causa da faxina; no fim da bateria a pasta própria da rodada, com o que sobrou, é apagada por `globalTmp.ts`).
const RM = { recursive: true, force: true, maxRetries: 10, retryDelay: 200 } as const;

/** Apaga as pastas (e o que há dentro), com novas tentativas; nunca lança. */
export async function removeTemp(...dirs: Array<string | undefined>): Promise<void> {
  await Promise.all(dirs.map((d) => (d ? fs.rm(d, RM).catch(() => undefined) : undefined)));
}

/** O mesmo, síncrono (para `afterEach(() => ...)` de teste que usa `mkdtempSync`). */
export function removeTempSync(...dirs: Array<string | undefined>): void {
  for (const d of dirs) {
    if (!d) continue;
    try {
      rmSync(d, RM);
    } catch {
      // fica para a limpeza de fim de bateria
    }
  }
}

/**
 * Cria pastas em os.tmpdir() e as apaga todas no fim do arquivo, o teste passando ou não (um `rm` no fim do `it` não roda
 * quando uma asserção falha antes). Chame no topo do arquivo: `const tmp = tempDirs(); const dir = await tmp('myco-x-');`.
 */
export function tempDirs() {
  const dirs: string[] = [];
  afterAll(() => removeTemp(...dirs));
  const make = async (prefix: string): Promise<string> => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  make.sync = (prefix: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  return make;
}
