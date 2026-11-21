import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A marca própria da bateria. Cada rodada cria UMA pasta `myco-testrun-XXXXXX` no TEMP e aponta TEMP/TMP/TMPDIR para ela
 * (`startTestRun`): tudo o que os testes (e os processos que eles abrem) criam em os.tmpdir() fica dentro dela. O varredor só
 * toca em pastas com este prefixo, que nada mais usa. Qualquer outro `myco-*` do TEMP (uma worktree, um projeto, o que for)
 * não é dele e nunca é apagado.
 */
export const TEST_RUN_PREFIX = 'myco-testrun-';

/** Uma rodada que ficou para trás (processo morto à força) só é apagada depois disto; mais novo pode ser de uma bateria em andamento. */
export const SWEEP_MIN_AGE_MS = 60 * 60_000;

export interface SweepOptions {
  /** A pasta varrida (só os filhos diretos). O padrão é o os.tmpdir(). */
  root?: string;
  minAgeMs?: number;
  now?: number;
  /** Quem apaga uma pasta (os testes trocam por um que falha). */
  remove?: (dir: string) => Promise<void>;
}

export interface SweepResult {
  removed: number;
  /** Quantas ficaram: presas por outro processo, sem permissão… */
  failed: number;
}

// No Windows um processo filho (git, node) ou o antivírus ainda segurando um arquivo faz o rm falhar com EBUSY/EPERM.
const removeDir = (dir: string) => fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

/**
 * Apaga do TEMP as pastas de rodadas de teste (`myco-testrun-*`) com mais de 1 hora: sobras de uma bateria que não chegou ao
 * fim. Nunca lança: o que não der para apagar conta em `failed` e fica para a próxima rodada.
 */
export async function sweepTemp(opts: SweepOptions = {}): Promise<SweepResult> {
  const root = opts.root ?? os.tmpdir();
  const cutoff = (opts.now ?? Date.now()) - (opts.minAgeMs ?? SWEEP_MIN_AGE_MS);
  const remove = opts.remove ?? removeDir;
  const result: SweepResult = { removed: 0, failed: 0 };
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(TEST_RUN_PREFIX)) continue;
    const full = path.join(root, name);
    try {
      // lstat: um link (junction, symlink) com esse nome não é pasta de rodada, e apagá-lo não pode seguir para o destino.
      const st = await fs.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink() || st.mtimeMs > cutoff) continue;
      await remove(full);
      result.removed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

const TEMP_VARS = ['TEMP', 'TMP', 'TMPDIR'] as const;

export interface TestRun {
  /** A pasta desta rodada: o os.tmpdir() dos testes enquanto ela durar. */
  dir: string;
  /** Devolve o TEMP de antes, apaga a pasta da rodada (com novas tentativas) e varre as rodadas antigas. Nunca lança. */
  finish: () => Promise<SweepResult & { runDirLeft: boolean }>;
}

/**
 * Abre a rodada: cria a pasta própria dentro de `tmpRoot` e aponta TEMP/TMP/TMPDIR de `env` para ela (os workers do vitest e os
 * processos dos testes herdam). `env` e `tmpRoot` existem para o teste; a bateria usa o process.env e o os.tmpdir().
 */
export function startTestRun(env: NodeJS.ProcessEnv = process.env, tmpRoot: string = os.tmpdir(), opts: Omit<SweepOptions, 'root'> = {}): TestRun {
  const dir = mkdtempSync(path.join(tmpRoot, TEST_RUN_PREFIX));
  const before = TEMP_VARS.map((k) => [k, env[k]] as const);
  for (const k of TEMP_VARS) env[k] = dir;
  const finish = async () => {
    for (const [k, v] of before) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const remove = opts.remove ?? removeDir;
    let runDirLeft = false;
    try {
      await remove(dir);
    } catch {
      runDirLeft = true;
    }
    const swept = await sweepTemp({ ...opts, root: tmpRoot }).catch(() => ({ removed: 0, failed: 0 }));
    return { ...swept, runDirLeft };
  };
  return { dir, finish };
}
