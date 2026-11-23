import { mkdtempSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A marca própria da bateria. Cada rodada cria UMA pasta `myco-testrun-<pid>-XXXXXX` no TEMP e aponta TEMP/TMP/TMPDIR para ela
 * (`startTestRun`): tudo o que os testes (e os processos que eles abrem) criam em os.tmpdir() fica dentro dela. O pid é o do
 * processo do vitest: o varredor sabe se a rodada ainda está viva.
 */
export const TEST_RUN_PREFIX = 'myco-testrun-';

/**
 * Os nomes que os testes usavam ANTES da pasta da rodada (as entradas legadas que a bateria deixava no TEMP), um formato por vez:
 * `mkdtemp` (prefixo + 6 caracteres) ou a pasta de MYCO_HOME (`-home-<pid>-<hora>`). Só nomes exatos de teste; nunca o `myco-*`
 * genérico: uma worktree, um projeto ou qualquer outra pasta `myco-…` do TEMP não é dele e nunca é apagada.
 */
const LEGACY_TEST_DIRS: RegExp[] = [
  /^myco-(marks|srv|deny|deny1|deny-err|update|scope|override)-[A-Za-z0-9]{6}$/,
  /^myco-gitmcp(-launch|-e2e)?-[A-Za-z0-9]{6}$/,
  /^mcp-tree-[A-Za-z0-9]{6}$/,
  /^myco-(copy|mcpaccess|staff|gitmcp)-home-\d+-\d+$/,
];
const RUN_DIR = /^myco-testrun-(?:(\d+)-)?[A-Za-z0-9]{6}$/;

/** Uma pasta legada ou uma rodada sem pid só é apagada depois disto; mais novo pode ser de uma bateria em andamento. */
export const SWEEP_MIN_AGE_MS = 60 * 60_000;
/** Uma rodada cujo processo ainda existe só é apagada depois disto (um pid reaproveitado por outro programa não a segura para sempre). */
export const RUN_MAX_AGE_MS = 24 * 60 * 60_000;

export interface SweepOptions {
  /** A pasta varrida (só os filhos diretos). O padrão é o os.tmpdir(). */
  root?: string;
  minAgeMs?: number;
  now?: number;
  /** Quem apaga uma pasta (os testes trocam por um que falha). */
  remove?: (dir: string) => Promise<void>;
  /** Se o processo de uma rodada ainda existe (os testes trocam). */
  isAlive?: (pid: number) => boolean;
}

export interface SweepResult {
  removed: number;
  /** Quantas ficaram: presas por outro processo, sem permissão… */
  failed: number;
}

// No Windows um processo filho (git, node) ou o antivírus ainda segurando um arquivo faz o rm falhar com EBUSY/EPERM.
const removeDir = (dir: string) => fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // existe, só não é nosso
  }
}

/**
 * Apaga do TEMP o que é da bateria e ficou para trás:
 *  - pasta de rodada (`myco-testrun-<pid>-…`) de um processo que já morreu (bateria interrompida), na hora; a de um processo vivo, só se
 *    parada há mais de um dia; a sem pid, com mais de 1 hora;
 *  - pasta legada de teste (`LEGACY_TEST_DIRS`) com mais de 1 hora.
 * Nunca lança: o que não der para apagar (arquivo preso por um processo filho, por exemplo) conta em `failed` e fica para a próxima.
 */
export async function sweepTemp(opts: SweepOptions = {}): Promise<SweepResult> {
  const root = opts.root ?? os.tmpdir();
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.minAgeMs ?? SWEEP_MIN_AGE_MS);
  const remove = opts.remove ?? removeDir;
  const isAlive = opts.isAlive ?? pidAlive;
  const result: SweepResult = { removed: 0, failed: 0 };
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return result;
  }
  for (const name of names) {
    const run = RUN_DIR.exec(name);
    if (!run && !LEGACY_TEST_DIRS.some((re) => re.test(name))) continue;
    const full = path.join(root, name);
    try {
      // lstat: um link (junction, symlink) com esse nome não é pasta de teste, e apagá-lo não pode seguir para o destino.
      const st = await fs.lstat(full);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const pid = run?.[1] ? Number(run[1]) : 0;
      const stale = pid ? !isAlive(pid) || st.mtimeMs <= now - RUN_MAX_AGE_MS : st.mtimeMs <= cutoff;
      if (!stale) continue;
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
  /**
   * Devolve o TEMP de antes, apaga a pasta da rodada (com novas tentativas) e varre o que ficou para trás. Nunca lança. Se a pasta
   * da rodada não saiu, `left` traz o que restou nela (o motivo costuma estar nos nomes).
   */
  finish: () => Promise<SweepResult & { runDirLeft: boolean; left: string[] }>;
}

/**
 * Abre a rodada: cria a pasta própria dentro de `tmpRoot` e aponta TEMP/TMP/TMPDIR de `env` para ela (os workers do vitest e os
 * processos dos testes herdam). `env` e `tmpRoot` existem para o teste; a bateria usa o process.env e o os.tmpdir().
 */
export function startTestRun(env: NodeJS.ProcessEnv = process.env, tmpRoot: string = os.tmpdir(), opts: Omit<SweepOptions, 'root'> = {}): TestRun {
  const dir = mkdtempSync(path.join(tmpRoot, `${TEST_RUN_PREFIX}${process.pid}-`));
  const before = TEMP_VARS.map((k) => [k, env[k]] as const);
  for (const k of TEMP_VARS) env[k] = dir;
  const finish = async () => {
    for (const [k, v] of before) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    const remove = opts.remove ?? removeDir;
    let runDirLeft = false;
    let left: string[] = [];
    try {
      await remove(dir);
    } catch {
      runDirLeft = true;
      left = await fs.readdir(dir).catch(() => []);
    }
    const swept = await sweepTemp({ ...opts, root: tmpRoot }).catch(() => ({ removed: 0, failed: 0 }));
    return { ...swept, runDirLeft, left };
  };
  return { dir, finish };
}
