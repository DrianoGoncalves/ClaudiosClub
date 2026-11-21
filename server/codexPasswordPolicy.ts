import path from 'node:path';
import { runTool, type Runner } from './folderPicker';

// A sandbox do Codex no Windows roda os comandos como usuários locais (CodexSandboxOffline/CodexSandboxOnline) e atualiza a senha deles a cada
// preparação. Com a "duração mínima da senha" da política local acima de 0 dia, o Windows recusa a troca (códigos 2224/2245) e TODO comando de
// terminal do Codex falha com `helper_user_create_or_update_failed`; o funcionário só diz "terminal bloqueado".
//
// Este módulo só AVISA: lê a política (`net accounts`, só leitura) e guarda um aviso para a caixa do dono, com o comando que resolve. O Club nunca roda
// `net accounts /minpwage` nem altera política: isso exige administrador e muda a segurança da máquina. Fora do Windows nada roda e nada é avisado.

/** O comando que o dono roda, como administrador. O Club nunca o executa. */
export const PASSWORD_POLICY_FIX = 'net accounts /minpwage:0';
/** Id do item da caixa (um por máquina): é o que `POST /api/errors/dismiss` recebe. */
export const PASSWORD_POLICY_ID = 'codexsandbox:password-policy';

export const POLICY_OK_TTL_MS = 10 * 60_000;
export const POLICY_FAIL_TTL_MS = 2 * 60_000;
const READ_TIMEOUT_MS = 10_000;
/** `net accounts` imprime sempre 9 linhas "rótulo: valor"; menos que isso é saída que não se reconhece. */
const ROWS = 9;

const HELPER_FAILURE = /helper_user_create_or_update_failed/i;
const SANDBOX_USER = /CodexSandbox(?:Offline|Online)/i;
const USER_ERROR_CODE = /\b(?:2224|2245)\b/;

/** A saída de uma ferramenta do Codex diz que o sandbox não conseguiu criar/atualizar o usuário local dele (o erro, ou o código do Windows junto do nome do usuário). */
export function isPasswordPolicyFailure(text: string): boolean {
  return HELPER_FAILURE.test(text) || (SANDBOX_USER.test(text) && USER_ERROR_CODE.test(text));
}

/**
 * A duração mínima da senha, em dias, na saída do `net accounts`; null quando a saída não se reconhece. O texto é localizado ("Minimum password age",
 * "Duração mínima da senha"…) e a codificação do console varia, então nada depende do rótulo: lê-se a 2ª linha "rótulo: valor", que é a mesma em
 * todo idioma, e só o valor numérico dela.
 */
export function parseMinPasswordAge(output: string): number | null {
  const values = output
    .split(/\r?\n/)
    .map((line) => /^.*\S\s*:\s+(\S.*?)\s*$/.exec(line)?.[1])
    .filter((v): v is string => v !== undefined);
  if (values.length < ROWS) return null;
  return /^\d{1,5}$/.test(values[1]!) ? Number(values[1]) : null;
}

/** O aviso vivo da caixa (um por máquina). Só na memória: um reinício refaz a checagem. */
export interface PasswordPolicyAlert {
  /** Duração mínima lida, em dias; `null` = a leitura não deu. Maior que 0 é a causa conhecida; 0, a causa é outra regra de senha. */
  minPasswordAgeDays: number | null;
  /** Quem levantou: a checagem prévia (política > 0) ou o erro visto na saída do Codex. */
  source: 'check' | 'turn';
  at: string;
  /** A política passou a 0 depois de falhar: o aviso fica na caixa, marcado como resolvido (ISO de quando foi visto), até ser ignorado ou vencer o prazo (ver `server/inboxResolved.ts`). */
  resolvedAt?: string;
}

export interface PasswordPolicyOptions {
  /** Os testes trocam (para cobrir os três sistemas). */
  platform?: NodeJS.Platform;
  /** Roda o programa (padrão `runTool`); os testes trocam. */
  run?: Runner;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export class CodexPasswordPolicy {
  private alert: PasswordPolicyAlert | null = null;
  /** Ignorado pelo dono: não volta até a política passar (0) depois de ter falhado. */
  private dismissed = false;
  /** A última leitura trouxe mais que 0: a checagem seguinte que passar limpa o aviso (e o "ignorado"). */
  private bad = false;
  private last: { at: number; days: number | null } | null = null;
  private inflight: Promise<number | null> | null = null;

  constructor(private readonly opts: PasswordPolicyOptions = {}) {}

  /** O aviso para a caixa (null = nada a mostrar); com `resolvedAt`, o problema já passou. */
  current(): PasswordPolicyAlert | null {
    return this.alert;
  }

  /**
   * Checagem prévia (ao abrir conversa Codex e ao salvar ficha do Codex): lê a política, com cache, e levanta o aviso se a duração mínima passa de 0.
   * Aviso de pé e ainda pendente: a caixa também chama, para o dono que corrigiu a política sem abrir conversa Codex ver o aviso passar (a leitura é a mesma, com o mesmo cache).
   * Nunca lança: falha na leitura = sem aviso, só log.
   */
  async check(): Promise<void> {
    try {
      const days = await this.read(false);
      if (days !== null && days > 0) this.raise(days, 'check');
    } catch (err) {
      this.log(`checagem da política de senha falhou: ${(err as Error).message}`);
    }
  }

  /**
   * A saída de uma ferramenta do Codex trouxe o erro do usuário do sandbox (quem chama confere com `isPasswordPolicyFailure`): levanta o mesmo aviso. Um por máquina: com aviso vivo ou
   * ignorado não lê de novo (todo comando do turno falha igual). A leitura é fresca, para dizer se a causa é a duração mínima (>0) ou outra regra (0). Nunca lança.
   */
  async noteFailure(): Promise<void> {
    if (!this.windows || (this.alert && !this.alert.resolvedAt) || this.dismissed) return;
    try {
      this.raise(await this.read(true), 'turn');
    } catch (err) {
      this.log(`leitura da política de senha falhou: ${(err as Error).message}`);
      this.raise(null, 'turn');
    }
  }

  /** "Ignorar" no item da caixa: sai e não volta até a política passar depois de falhar (aviso já resolvido: sai e pronto, a política já passou). Falso = não há esse item (a tela está velha). */
  dismiss(id: string): boolean {
    if (id !== PASSWORD_POLICY_ID || !this.alert) return false;
    this.dismissed = !this.alert.resolvedAt;
    this.alert = null;
    return true;
  }

  private raise(days: number | null, source: PasswordPolicyAlert['source']) {
    if (this.dismissed) return;
    // O aviso resolvido não se reabre: falha de novo é problema novo, com a hora e a origem de agora.
    if (this.alert?.resolvedAt) this.alert = null;
    if (this.alert) {
      if (days !== null) this.alert.minPasswordAgeDays = days;
      return;
    }
    this.alert = { minPasswordAgeDays: days, source, at: new Date(this.now()).toISOString() };
    this.log(`o sandbox do Codex pode falhar: duração mínima da senha ${days ?? 'desconhecida'} (aviso na caixa)`);
  }

  /**
   * A duração mínima da senha, com cache (10 min; 2 min se a leitura falhou) e uma leitura por vez. Fora do Windows: nada roda (null). Passou (0) depois de falhar: marca o aviso como resolvido (`resolvedAt`;
   * a caixa o mostra assim até o dono ignorar ou vencer o prazo), também o que nasceu de uma leitura que falhou (null): a duração não é mais a causa suspeita e, se o erro seguir, o próximo do turno levanta
   * o aviso de novo, já com o valor lido. O que nasceu de uma leitura em 0 fica como está (outra regra: nada diz que passou).
   */
  private async read(fresh: boolean): Promise<number | null> {
    if (!this.windows) return null;
    if (!fresh && this.last && this.now() - this.last.at < (this.last.days === null ? POLICY_FAIL_TTL_MS : POLICY_OK_TTL_MS)) return this.last.days;
    this.inflight ??= this.readNow().finally(() => {
      this.inflight = null;
    });
    const days = await this.inflight;
    this.last = { at: this.now(), days };
    if (days === 0) {
      if (this.bad) {
        this.bad = false;
        this.dismissed = false;
        this.resolve();
      } else if (this.alert?.minPasswordAgeDays === null) this.resolve();
    } else if (days !== null) {
      this.bad = true;
    }
    return days;
  }

  /** A política passou: o aviso de pé vira resolvido (a hora é a da primeira leitura em 0; leitura seguinte não a muda). */
  private resolve() {
    if (this.alert && !this.alert.resolvedAt) {
      this.alert.resolvedAt = new Date(this.now()).toISOString();
      this.log('a política de senha passou (duração mínima 0): o aviso do sandbox do Codex ficou como resolvido');
    }
  }

  private async readNow(): Promise<number | null> {
    const system = path.win32.join(this.env.SystemRoot ?? this.env.windir ?? 'C:\\Windows', 'System32', 'net.exe');
    const r = await (this.opts.run ?? runTool)(system, ['accounts'], READ_TIMEOUT_MS);
    if (r.code !== 0 || r.timedOut || r.missing) {
      this.log(`net accounts não leu a política de senha (${r.timedOut ? 'demorou demais' : r.missing ? 'programa ausente' : `saída ${r.code}`})`);
      return null;
    }
    const days = parseMinPasswordAge(r.stdout);
    if (days === null) this.log('net accounts: saída que não se reconhece, sem aviso');
    return days;
  }

  private get windows() {
    return (this.opts.platform ?? process.platform) === 'win32';
  }

  private get env() {
    return this.opts.env ?? process.env;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private log(line: string) {
    (this.opts.log ?? ((l) => console.log(`[codex] ${l}`)))(line);
  }
}
