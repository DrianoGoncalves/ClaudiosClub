import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CodexUsage, CodexUsageReason, CodexVersion, UsageLimit } from '../shared/model';
import { codexEnv, type CodexStatus } from './adapters/codex';
import { ROOT } from './root';

// Limites de uso do Codex (assinatura ChatGPT), no mesmo formato dos do Claude (server/usage.ts).
// Lê pelo `codex app-server` (JSON-RPC, uma mensagem por linha no stdio) e só roda com `codexReview` ligado.
// O app-server não aceita `--ignore-user-config`, então ele lê o ~/.codex/config.toml (só leitura; nada é gravado).

/** Cache dos limites lidos. Falha vale menos, para a tela notar logo que o login voltou. */
const OK_TTL = 3 * 60_000;
const FAIL_TTL = 30_000;
/** Teto de uma leitura inteira (as duas tentativas somadas). */
const READ_TIMEOUT = 20_000;
/** Quanto a rota espera a leitura antes de entregar o que tem (os dados do Claude não esperam o Codex). */
const ROUTE_WAIT = 2_500;
const RETRY_DELAY = 1_000;
const MISE_PATH = /[\\/]mise[\\/](installs|shims)[\\/]/i;

export type RateLimitsRead = { ok: true; result: unknown } | { ok: false; error: string; fatal?: boolean };

type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

// ---- Conversão da resposta -------------------------------------------------------------------------------------

const Window = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  resetsAt: z.number().nullish(),
});
const RateLimitsResult = z.object({ rateLimits: z.object({ primary: Window.nullish(), secondary: Window.nullish() }) });

/** `kind` do medidor pela duração da janela; sem duração, a primária é a de 5h e a secundária a semanal. */
function limitKind(mins: number | null | undefined, slot: 'primary' | 'secondary'): string {
  if (mins === 300) return 'five_hour';
  if (mins === 10_080) return 'seven_day';
  if (mins == null) return slot === 'primary' ? 'five_hour' : 'seven_day';
  return `window_${mins}m`;
}

/** Resposta de `account/rateLimits/read` → limites no formato do Claude (`resetsAt` em epoch de segundos vira ISO). */
export function limitsFromRateLimits(result: unknown): UsageLimit[] | null {
  const parsed = RateLimitsResult.safeParse(result);
  if (!parsed.success) return null;
  const limits: UsageLimit[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = parsed.data.rateLimits[slot];
    if (!w) continue;
    limits.push({
      kind: limitKind(w.windowDurationMins, slot),
      percentUsed: Math.min(100, Math.max(0, w.usedPercent)),
      resetsAt: w.resetsAt == null ? null : new Date(w.resetsAt * 1000).toISOString(),
    });
  }
  return limits;
}

// ---- Versão ----------------------------------------------------------------------------------------------------

function semver(v: string | null | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isOutdated(installed: string | null | undefined, latest: string | null | undefined): boolean {
  const a = semver(installed);
  const b = semver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

/** `mise upgrade codex` se o binário está num caminho do mise (installs ou shims), senão `codex update`. */
export function upgradeCommandFor(binPaths: Array<string | null | undefined>): string {
  return binPaths.some((p) => p && MISE_PATH.test(p)) ? 'mise upgrade codex' : 'codex update';
}

/** `codex-cli 0.167.0` → `0.167.0`. */
export function parseInstalledVersion(stdout: string): string | null {
  return /(\d+\.\d+\.\d+[^\s]*)/.exec(stdout)?.[1] ?? null;
}

/** O `codex` instalado: versão e caminho (o do PATH e o real, depois dos links). `missing`: não há o CLI. */
export interface InstalledCodex {
  missing: boolean;
  version: string | null;
  binPaths: string[];
}

async function findOnPath(): Promise<string[]> {
  const win = process.platform === 'win32';
  const names = win ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      const ok = await fs.access(file, win ? fs.constants.F_OK : fs.constants.X_OK).then(() => true, () => false);
      if (!ok) continue;
      const real = await fs.realpath(file).catch(() => file);
      return real === file ? [file] : [file, real];
    }
  }
  return [];
}

function execCodexVersion(): Promise<{ code: number | null; stdout: string; stderr: string; enoent: boolean }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    execFile('codex', ['--version'], { env: codexEnv(), timeout: 10_000, windowsHide: true, shell: win }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
        enoent: e?.code === 'ENOENT',
      });
    });
  });
}

export async function readInstalled(): Promise<InstalledCodex> {
  const r = await execCodexVersion();
  const missing = r.enoent || r.code === 9009 || r.code === 127 || /not recognized|reconhecido|command not found/i.test(r.stderr);
  if (missing) return { missing: true, version: null, binPaths: [] };
  return { missing: false, version: parseInstalledVersion(r.stdout), binPaths: await findOnPath() };
}

/** A última versão que o próprio Codex anotou em ~/.codex/version.json (ou CODEX_HOME). */
export async function readLatestVersion(file = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'version.json')): Promise<string | null> {
  try {
    const parsed = z.object({ latest_version: z.string() }).safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    return parsed.success ? parsed.data.latest_version : null;
  } catch {
    return null;
  }
}

// ---- app-server ------------------------------------------------------------------------------------------------

function appVersion(): Promise<string> {
  return fs.readFile(path.join(ROOT, 'package.json'), 'utf8').then(
    (t) => (JSON.parse(t) as { version?: string }).version ?? '0',
    () => '0',
  );
}

/** Uma tentativa: abre o `codex app-server`, faz o handshake, lê `account/rateLimits/read` e encerra o processo. */
export function readRateLimitsOnce(clientVersion: string, timeoutMs: number, spawnFn: SpawnFn = spawn): Promise<RateLimitsRead> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    let child: ChildProcess;
    try {
      child = spawnFn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env: codexEnv(), windowsHide: true, shell: win });
    } catch (err) {
      return resolve({ ok: false, error: (err as Error).message, fatal: true });
    }
    let done = false;
    let buf = '';
    const finish = (r: RateLimitsRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      try {
        child.stdin?.destroy();
      } catch {
        // já fechado
      }
      child.kill();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'o Codex não respondeu a tempo' }), timeoutMs);
    const send = (m: unknown) => {
      if (!done) child.stdin?.write(JSON.stringify(m) + '\n');
    };
    const fail = (what: string, e: unknown) => {
      const msg = (e as { message?: unknown } | null)?.message;
      finish({ ok: false, error: `${what}: ${typeof msg === 'string' ? msg : 'erro'}`.slice(0, 200) });
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish({ ok: false, error: err.message, fatal: err.code === 'ENOENT' }));
    child.on('close', () => finish({ ok: false, error: 'o Codex encerrou sem responder' }));
    child.stdin?.on('error', () => {});
    child.stdout?.on('data', (d: Buffer | string) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { id?: number; result?: unknown; error?: unknown };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error) return fail('initialize', m.error);
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: {} });
        } else if (m.id === 2) {
          return m.error ? fail('account/rateLimits/read', m.error) : finish({ ok: true, result: m.result });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'claudios', version: clientVersion } } });
  });
}

/** Lê os limites; erro passageiro de rede (-32603) na primeira vez é comum, então tenta de novo dentro do mesmo teto. */
export async function readRateLimits(
  clientVersion: string,
  timeoutMs = READ_TIMEOUT,
  spawnFn: SpawnFn = spawn,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RateLimitsRead> {
  const start = Date.now();
  const first = await readRateLimitsOnce(clientVersion, timeoutMs, spawnFn);
  if (first.ok || first.fatal) return first;
  const left = timeoutMs - (Date.now() - start) - RETRY_DELAY;
  if (left < 3_000) return first;
  await sleep(RETRY_DELAY);
  return readRateLimitsOnce(clientVersion, left, spawnFn);
}

// ---- Leitor com cache ------------------------------------------------------------------------------------------

export interface CodexUsageDeps {
  /** `codex login status` (CodexAdapter.check). */
  check: () => Promise<CodexStatus>;
  installed?: () => Promise<InstalledCodex>;
  latest?: () => Promise<string | null>;
  readLimits?: () => Promise<RateLimitsRead>;
  now?: () => number;
}

function failure(reason: CodexUsageReason, detail: string | null, version: CodexVersion | null = null, upgradeCommand: string | null = null): CodexUsage {
  return { connected: false, reason, detail, limits: [], updatedAt: null, version, upgradeCommand };
}

const LOADING: CodexUsage = failure('loading', null);

export class CodexUsageReader {
  private cache: { at: number; ttl: number; value: CodexUsage } | null = null;
  private inflight: Promise<CodexUsage> | null = null;

  constructor(private readonly deps: CodexUsageDeps) {}

  /**
   * Os limites do Codex para o campo `codex` de /api/usage; null com `enabled` desligado (nada é aberto nem lido).
   * Nunca lança e espera no máximo `waitMs`: passado isso, entrega a última leitura (ou `loading`) e a leitura segue no
   * fundo para a próxima chamada.
   */
  async read(enabled: boolean, waitMs = ROUTE_WAIT): Promise<CodexUsage | null> {
    if (!enabled) {
      this.cache = null;
      return null;
    }
    const c = this.cache;
    if (c && this.now() - c.at < c.ttl) return c.value;
    const fallback = c?.value ?? LOADING;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<CodexUsage>((r) => (timer = setTimeout(() => r(fallback), waitMs)));
    try {
      return await Promise.race([this.refresh(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private refresh(): Promise<CodexUsage> {
    this.inflight ??= this.load()
      .catch((err) => failure('error', (err as Error).message.slice(0, 200)))
      .then((value) => {
        this.cache = { at: this.now(), ttl: value.connected ? OK_TTL : FAIL_TTL, value };
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async load(): Promise<CodexUsage> {
    const inst = await (this.deps.installed ?? readInstalled)();
    if (inst.missing) return failure('not_installed', 'o Codex CLI não está instalado');
    const latest = await (this.deps.latest ?? readLatestVersion)();
    const version: CodexVersion = { installed: inst.version, latest, outdated: isOutdated(inst.version, latest) };
    const upgradeCommand = upgradeCommandFor(inst.binPaths);
    const status = await this.deps.check();
    if (!status.available) {
      const reason = /não está instalado/.test(status.reason ?? '') ? 'not_installed' : 'not_logged_in';
      return failure(reason, status.reason, version, upgradeCommand);
    }
    const read = await (this.deps.readLimits ?? (async () => readRateLimits(await appVersion())))();
    if (!read.ok) return failure('error', read.error, version, upgradeCommand);
    const limits = limitsFromRateLimits(read.result);
    if (!limits) return failure('error', 'resposta inesperada do Codex', version, upgradeCommand);
    return { connected: true, reason: null, detail: null, limits, updatedAt: new Date(this.now()).toISOString(), version, upgradeCommand };
  }
}
