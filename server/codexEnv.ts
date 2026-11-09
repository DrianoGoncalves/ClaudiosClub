import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';
import { defaultRunner, type CodexRunner } from './adapters/codex';

// O que o motor Codex confere no `codex` instalado antes de rodar: a versão mínima e o recurso `network_proxy`.
//
// - Versão: o motor foi feito e provado a partir do Codex CLI 0.156.1 (perfil de permissões, `exec --json`, `exec resume`). Abaixo disso
//   a engine codex é recusada, com a mensagem de como atualizar.
// - `network_proxy`: a rede local só é segura com ele ligado. O perfil usa `network={enabled=true,domains={"127.0.0.2"="allow"}}` e
//   `--enable network_proxy`; num Codex em que o recurso mudou ou saiu, `enabled=true` sem o proxy liberaria a rede inteira. Por isso
//   `codex features list` é conferido (com cache) e, sem o recurso, a conversa roda com a rede desligada e um aviso.

/** Versão mínima do Codex CLI para o motor dos funcionários. */
export const CODEX_MIN_VERSION = '0.156.1';
/** Quanto tempo uma conferência que deu certo vale (o Codex só muda quando o usuário atualiza). */
export const CODEX_ENV_TTL = 5 * 60_000;

export interface CodexEnvStatus {
  /** O Codex não serve para o motor (ausente, antigo, ilegível): o texto é para o usuário e a conversa não abre. null = serve. */
  error: string | null;
  version: string | null;
  /** `network_proxy` presente e utilizável: só então a rede local (`loopback`) pode ser usada. */
  networkProxy: boolean;
  /** Aviso para a conversa (ex.: segue sem rede porque falta o `network_proxy`). */
  notice: string | null;
}

/**
 * A conferência do Codex mais o endereço dele: a sandbox só alcança o Claudio’s Club em `address` (127.0.0.2:<porta>, ver server/callers.ts). Se o
 * servidor não conseguiu escutar ali (o macOS sem o alias do 127.0.0.2, por exemplo), a conversa roda sem rede nenhuma e avisa, em vez de rodar
 * com uma rede que não chega à API. Sem o `network_proxy`, ou com erro, a conferência já diz tudo e passa como veio.
 */
export function withAppAddress(status: CodexEnvStatus, listener: { up: boolean; error: string | null }, address: string): CodexEnvStatus {
  if (status.error || !status.networkProxy || listener.up) return status;
  return {
    ...status,
    networkProxy: false,
    notice: `O Claudio’s Club não conseguiu escutar em ${address}${listener.error ? ` (${listener.error})` : ''}, o endereço que a sandbox do Codex alcança: esta conversa roda sem rede nenhuma. O curl para a API (tarefas e despertador) não vai funcionar. No macOS: sudo ifconfig lo0 alias ${address.split(':')[0]} up, e reinicie o Claudio’s Club.`,
  };
}

/** `codex-cli 0.167.0` → [0, 167, 0]; sem número, null. */
export function parseCodexVersion(stdout: string): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negativo se `a` é mais antiga que `b`. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Os estágios em que o `network_proxy` vale. `removed` (o `--enable` vira letra morta), `deprecated` e `under development` ficam de fora. */
const USABLE_STAGES = new Set(['experimental', 'stable']);

/** `codex features list`: uma linha por recurso, `nome  estágio  true|false` → nome → estágio. */
export function parseCodexFeatures(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(.+?)\s+(true|false)\s*$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!.trim().toLowerCase());
  }
  return out;
}

/** Como atualizar: `mise upgrade codex` se o binário vive numa pasta do mise (ou veio pelo shim dele), senão `codex update`. */
export function codexUpgradeHint(binaryPaths: ReadonlyArray<string | null>): string {
  return binaryPaths.some((p) => p && /[\\/]mise[\\/]/i.test(p)) ? 'mise upgrade codex' : 'codex update';
}

/** Onde o `codex` está no PATH (o caminho que o shell acharia e o real, depois dos links); [] se não achou. */
export async function locateCodex(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const names = platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex.ps1', 'codex'] : ['codex'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (!(await fs.access(file, fsc.X_OK).then(() => true, () => false))) continue;
      const real = await fs.realpath(file).catch(() => null);
      return real && real !== file ? [file, real] : [file];
    }
  }
  return [];
}

export class CodexEnv {
  private cache: { at: number; value: CodexEnvStatus } | null = null;

  constructor(
    private readonly run: CodexRunner = defaultRunner(),
    private readonly opts: { now?: () => number; locate?: () => Promise<string[]>; minVersion?: string } = {},
  ) {}

  /** Nunca lança. Só o que deu certo fica guardado: depois de atualizar o Codex, a próxima conversa já confere de novo. */
  async status(fresh = false): Promise<CodexEnvStatus> {
    const now = this.opts.now?.() ?? Date.now();
    if (!fresh && this.cache && now - this.cache.at < CODEX_ENV_TTL) return this.cache.value;
    const value = await this.inspect();
    if (!value.error) this.cache = { at: now, value };
    return value;
  }

  private async inspect(): Promise<CodexEnvStatus> {
    const fail = (error: string): CodexEnvStatus => ({ error, version: null, networkProxy: false, notice: null });
    const v = await this.run(['--version'], '', 15_000);
    if (v.spawnError) return fail(v.spawnError.code === 'ENOENT' ? 'o Codex CLI não está instalado (npm i -g @openai/codex)' : `não consegui rodar o codex: ${v.spawnError.message}`);
    if (v.timedOut || v.code !== 0) return fail(`não consegui conferir a versão do Codex (${v.timedOut ? 'demorou demais' : `saída ${v.code}`})`);
    const version = parseCodexVersion(v.stdout);
    if (!version) return fail(`não reconheci a versão do Codex (saída: ${JSON.stringify(v.stdout.trim().slice(0, 80))}): não rodo o motor Codex sem saber qual é`);
    const min = this.opts.minVersion ?? CODEX_MIN_VERSION;
    const shown = version.join('.');
    if (compareVersions(version, parseCodexVersion(min)!) < 0) {
      const hint = codexUpgradeHint(await (this.opts.locate ?? locateCodex)().catch(() => []));
      return { ...fail(`O Codex ${shown} é antigo demais para rodar funcionários no Claudio’s Club (o mínimo é ${min}). Atualize com: ${hint}`), version: shown };
    }
    // Rede local: só com o `network_proxy` no Codex instalado. Sem ele (ou sem conseguir conferir), a conversa segue com a rede desligada.
    const f = await this.run(['features', 'list'], '', 20_000);
    const stage = f.spawnError || f.timedOut || f.code !== 0 ? undefined : parseCodexFeatures(f.stdout).get('network_proxy');
    const networkProxy = !!stage && USABLE_STAGES.has(stage);
    return {
      error: null,
      version: shown,
      networkProxy,
      notice: networkProxy
        ? null
        : `Este Codex (${shown}) ${stage ? `tem o recurso network_proxy como "${stage}", que não uso` : 'não tem o recurso network_proxy (ou não consegui conferir)'}: a conversa roda sem rede nenhuma, nem a local. O curl para a API do Claudio’s Club (tarefas e despertador) não vai funcionar nesta conversa.`,
    };
  }
}
