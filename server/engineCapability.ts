import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CodexRunner } from './adapters/codex';
import { CODEX_PROFILE, codexWindowsSandboxArgs } from './chat/codexArgs';
import { resolveCodexAgents } from './staff/codexAgents';
import { StaffError } from './staff/store';

// O que a conversa do Codex confere antes de rodar: a sandbox (no Windows) e os agents da ficha. Quando não dá, a conversa recusa com o
// motivo, em vez de o Codex falhar no meio.
//
// No Windows a sandbox elevada é uma configuração global: duas conversas ao mesmo tempo, com rede loopback, refazem o provisionamento uma da
// outra e as duas falham. Por isso a sonda não roda com outra conversa do Codex viva, e uma falha real segura novas tentativas por um tempo.

export type CapabilityReason = 'sandbox' | 'agents' | 'model';

export class CapabilityError extends StaffError {
  constructor(
    readonly reason: CapabilityReason,
    message: string,
  ) {
    super(message);
  }
}

const SANDBOX_FAILURE = /Failed to create unified exec process|sandbox setup is missing|orchestrator_helper_incomplete|sandbox_users\.json|setup marker/i;

/** A saída do Codex diz que a sandbox quebrou (provisionamento concorrente ou preparação que falta). */
export function isSandboxFailure(text: string): boolean {
  return SANDBOX_FAILURE.test(text);
}

export const CAPABILITY_OK_TTL_MS = 5 * 60_000;
export const CAPABILITY_FAIL_TTL_MS = 2 * 60_000;
export const CAPABILITY_FAILURE_HOLD_MS = 5 * 60_000;

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_OK = 'myco-ok';
const MSG_MAX = 200;

export class CodexCapability {
  private probes = new Map<string, { at: number; error: string | null }>();
  private failure: { at: number; message: string } | null = null;

  constructor(
    private readonly run: CodexRunner,
    private readonly opts: { now?: () => number; platform?: NodeJS.Platform; liveCodex?: () => string[] } = {},
  ) {}

  /**
   * Confere a sandbox antes de rodar. Lança CapabilityError se não dá para rodar agora. `exceptSession` é a própria conversa: não conta como
   * "outra" viva. Sem cache para a conferência de outra conversa; só a sonda fica guardada.
   */
  async sandbox(o: { cwd: string; profileArgs: string[]; version: string; exceptSession?: string }): Promise<void> {
    const now = this.now();
    const win = this.platform === 'win32';
    if (win && (this.opts.liveCodex?.() ?? []).some((id) => id !== o.exceptSession)) {
      throw new CapabilityError('sandbox', 'outra conversa do Codex está rodando agora; no Windows duas ao mesmo tempo derrubam a sandbox uma da outra');
    }
    if (this.failure && now - this.failure.at < CAPABILITY_FAILURE_HOLD_MS) {
      throw new CapabilityError('sandbox', `a sandbox do Codex falhou numa conversa há pouco: ${this.failure.message.slice(0, MSG_MAX)}`);
    }
    // Sonda só no Windows: fora dele não está verificado que ela diz algo útil.
    if (!win) return;
    const dir = path.resolve(o.cwd);
    const key = `${o.version}|${createHash('sha1').update(o.profileArgs.join('\0')).digest('hex')}|${dir.toLowerCase()}`;
    const hit = this.probes.get(key);
    if (hit && now - hit.at < (hit.error ? CAPABILITY_FAIL_TTL_MS : CAPABILITY_OK_TTL_MS)) {
      if (hit.error) throw new CapabilityError('sandbox', hit.error);
      return;
    }
    const r = await this.run(
      ['sandbox', '-C', o.cwd, '-P', CODEX_PROFILE, ...o.profileArgs, ...codexWindowsSandboxArgs('win32'), 'cmd', '/c', 'echo myco-ok'],
      '',
      PROBE_TIMEOUT_MS,
    );
    if (r.code === 0 && !r.timedOut && !r.spawnError && r.stdout.includes(PROBE_OK)) {
      this.probes.set(key, { at: now, error: null });
      return;
    }
    const why = (r.stderr.trim() || r.spawnError?.message || (r.timedOut ? 'demorou demais' : `saída ${r.code}`)).slice(0, MSG_MAX);
    const error = `a sandbox do Codex não abriu: ${why}`;
    this.probes.set(key, { at: now, error });
    throw new CapabilityError('sandbox', error);
  }

  /** Uma conversa falhou com a sandbox: esquece as sondas e segura novas conferências por CAPABILITY_FAILURE_HOLD_MS. */
  reportFailure(message: string): void {
    this.probes.clear();
    this.failure = { at: this.now(), message };
  }

  /** Os agents da ficha existem para o Codex? Sem agents, passa; os presets (nativos) não são conferidos no disco. */
  async agents(o: { wanted: string[]; presets: string[]; multiAgent: boolean; dirs: { cwd: string; projectPath: string; userAgentsDir: string } }): Promise<void> {
    if (!o.wanted.length) return;
    if (!o.multiAgent) throw new CapabilityError('agents', 'este Codex não tem subagents (multi_agent): os agents da ficha não rodariam');
    const { missing } = await resolveCodexAgents(
      o.wanted.filter((n) => !o.presets.includes(n)),
      o.dirs,
    );
    if (missing.length) throw new CapabilityError('agents', `o Codex não tem os agents da ficha: ${missing.join(', ')}`);
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private get platform(): NodeJS.Platform {
    return this.opts.platform ?? process.platform;
  }
}
