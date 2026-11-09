import { execFile } from 'node:child_process';
import { openCliLoginTerminal } from './auth';

// Instalar e entrar no Codex pelo Claudio’s Club, sem o usuário ir ao terminal. A instalação roda `npm i -g @openai/codex` (argumentos
// fixos: nada do pedido entra no comando). O login abre a mesma janela do login do Claude (auth.ts) e quem conclui é o usuário, no navegador.
// Os dois só valem pelo navegador pareado: quem chega de fora (funcionário, sandbox) recebe o erro, e a rota não entra em apiPolicy.ts.

export class CodexSetupError extends Error {}

const INSTALL_TIMEOUT = 5 * 60_000;
export const CODEX_LOGIN_COMMAND = 'codex login';

export interface InstallOutcome {
  ok: boolean;
  /** Texto curto para o usuário; null quando deu certo. */
  error: string | null;
}

/** A primeira linha útil do erro do npm, curta. */
const firstLine = (text: string) => (text.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();

/** `npm i -g @openai/codex`. No Windows o npm é um .cmd: sem shell não o acha (os argumentos são fixos, sem aspas). */
export function npmInstallCodex(): Promise<InstallOutcome> {
  const win = process.platform === 'win32';
  return new Promise((resolve) =>
    execFile(
      'npm',
      ['install', '-g', '@openai/codex'],
      { windowsHide: true, timeout: INSTALL_TIMEOUT, maxBuffer: 16 * 1024 * 1024, shell: win },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true, error: null });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return resolve({ ok: false, error: 'o npm não foi encontrado: instale o Node.js' });
        if (e.killed) return resolve({ ok: false, error: 'a instalação demorou demais (5 min)' });
        resolve({ ok: false, error: `não consegui instalar o Codex: ${firstLine(String(stderr)) || e.message}`.slice(0, 200) });
      },
    ),
  );
}

export interface CodexSetupDeps {
  /** O `codex` já está no PATH? Se sim, a instalação não roda o npm de novo. */
  installed: () => Promise<boolean>;
  /** Roda a instalação (o npm, por padrão). Os testes trocam. */
  install?: () => Promise<InstallOutcome>;
  /** Depois de instalar: esquece as leituras guardadas do Codex, para o header refletir já. */
  afterInstall?: () => Promise<void>;
  /** Abre o login num terminal (o mesmo mecanismo do Claude). */
  openLogin?: () => { ok: boolean; error: string | null };
}

export class CodexSetup {
  private running: Promise<InstallOutcome> | null = null;

  constructor(private readonly deps: CodexSetupDeps) {}

  /**
   * Instala o Codex se faltar. Um pedido por vez: enquanto uma instalação roda, pedido repetido espera a mesma (sem outro npm).
   * Só pelo navegador pareado.
   */
  async install(fromBrowser: boolean): Promise<InstallOutcome> {
    if (!fromBrowser) throw new CodexSetupError('só pelo Claudio’s Club');
    this.running ??= this.doInstall().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Abre a janela do `codex login`. Quem conclui é o usuário; a tela confere o status depois. Só pelo navegador pareado. */
  login(fromBrowser: boolean): { ok: boolean; error: string | null } {
    if (!fromBrowser) throw new CodexSetupError('só pelo Claudio’s Club');
    return (this.deps.openLogin ?? (() => openCliLoginTerminal(CODEX_LOGIN_COMMAND, 'login no Codex')))();
  }

  private async doInstall(): Promise<InstallOutcome> {
    try {
      if (await this.deps.installed()) return { ok: true, error: null };
      const r = await (this.deps.install ?? npmInstallCodex)();
      if (r.ok) await this.deps.afterInstall?.().catch(() => {});
      return r;
    } catch (err) {
      return { ok: false, error: `não consegui instalar o Codex: ${(err as Error).message}`.slice(0, 200) };
    }
  }
}
