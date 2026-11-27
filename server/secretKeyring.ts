import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Chaveiro do sistema no Linux (Secret Service: GNOME Keyring, KWallet 6, KeePassXC), pelo `secret-tool` do libsecret. É o equivalente do DPAPI do Windows
// para o cofre de segredos (server/secretVault.ts): o valor fica cifrado pelo chaveiro, preso ao login do usuário. Sem shell: os argumentos vão em lista.
// O valor entra só pela entrada padrão (nunca em argumento, variável de ambiente ou log), em base64 (o `secret-tool` pode manter ou tirar o
// fim de linha, e o base64 não se importa). Nenhuma mensagem de erro daqui leva o valor nem a saída do programa: só o motivo.

/** Por que o chaveiro não serviu. */
export type KeyringReason = 'no-tool' | 'no-bus' | 'no-service' | 'locked' | 'timeout' | 'failed';

const WHY: Record<KeyringReason, string> = {
  'no-tool': 'o programa secret-tool (libsecret) não está instalado',
  'no-bus': 'não há sessão de usuário com barramento D-Bus, como num servidor sem sessão gráfica',
  'no-service': 'nenhum chaveiro (Secret Service) está rodando nesta sessão',
  locked: 'o chaveiro está bloqueado ou o desbloqueio foi cancelado',
  timeout: 'o chaveiro não respondeu a tempo, talvez bloqueado',
  failed: 'o chaveiro recusou a operação',
};

export class KeyringError extends Error {
  constructor(readonly reason: KeyringReason) {
    super(WHY[reason]);
    this.name = 'KeyringError';
  }
}

/** O que o cofre precisa do chaveiro. Os testes trocam por um de memória. */
export interface Keyring {
  /** Guarda (ou troca) o valor do item `id`. */
  store(id: string, value: string): Promise<void>;
  /** O valor, ou null se o item não existe. */
  lookup(id: string): Promise<string | null>;
  /** Apaga o item (sem erro se ele não existe). */
  clear(id: string): Promise<void>;
  /** O chaveiro responde? Só consulta um item que não existe: não grava e não pede senha. Lança `KeyringError` se não serve. */
  probe(): Promise<void>;
}

export interface SecretToolOptions {
  /** Programa (padrão `secret-tool` do PATH). */
  bin?: string;
  /** Ambiente de base (padrão o do processo). */
  env?: NodeJS.ProcessEnv;
  /** Prazo da leitura, com 1 nova tentativa se estourar: o lançamento de um MCP não espera o chaveiro bloqueado por 30 s. */
  readTimeoutMs?: number;
  /** Depois de uma leitura que estourou o prazo nas duas tentativas, as leituras seguintes falham na hora por este tempo (padrão 30 s): vários MCPs no mesmo lançamento não esperam 10 s cada um com o chaveiro bloqueado. */
  readBreakMs?: number;
  /** Rótulo do item (o que o usuário vê no gerenciador de chaves). Padrão: o do Claudio’s Club. */
  label?: string;
  /** Prazo da escrita e do apagar (o usuário pode estar digitando a senha de desbloqueio). */
  writeTimeoutMs?: number;
}

const READ_TIMEOUT_MS = 5_000;
const READ_BREAK_MS = 30_000;
const WRITE_TIMEOUT_MS = 15_000;
const MAX_OUT = 64 * 1024;
const APP = 'claudios-club';
const LABEL = "Claudio's Club (cofre de segredos)";
/** O item que o `probe` procura: nunca existe. */
const PROBE_ID = 'probe-inexistente';

/**
 * O processo filho do MCP pode vir sem `DBUS_SESSION_BUS_ADDRESS` (o Claude Code filtra o ambiente de alguns filhos). No Linux com systemd o barramento da
 * sessão está em `$XDG_RUNTIME_DIR/bus` (padrão `/run/user/<uid>/bus`): usa esse, se o socket existe. Sem ele, o `secret-tool` tentaria subir um D-Bus
 * pelo X11 e falharia.
 */
export function withBusEnv(base: NodeJS.ProcessEnv, uid: number | undefined = process.getuid?.()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: 'C', LANGUAGE: 'C' };
  if (env.DBUS_SESSION_BUS_ADDRESS) return env;
  const runtime = env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : '');
  // Só caminho simples: no endereço do D-Bus `%`, `,`, `;` e `=` precisam de escape.
  if (!runtime || !/^[A-Za-z0-9/_.-]+$/.test(runtime)) return env;
  const sock = path.join(runtime, 'bus');
  if (!existsSync(sock)) return env;
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${sock}`;
  env.XDG_RUNTIME_DIR ||= runtime;
  return env;
}

/** O motivo pelo texto de erro do `secret-tool` (em inglês: roda com LC_ALL=C). O texto em si nunca sai daqui. */
export function classifyStderr(err: string): KeyringReason {
  if (/autolaunch|cannot (open|connect)|could not connect|failed to connect|no such file or directory|connection refused|DBUS_SESSION_BUS_ADDRESS|bus address/i.test(err)) return 'no-bus';
  if (/ServiceUnknown|not provided by any \.service|org\.freedesktop\.secrets|no such (object|interface)|name .* (is not|was not)/i.test(err)) return 'no-service';
  if (/locked|dismissed|cancel|prompt/i.test(err)) return 'locked';
  return 'failed';
}

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, stdin: string | null, timeoutMs: number): Promise<Run> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      return reject(new KeyringError('no-tool'));
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new KeyringError('timeout')));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      if (out.length < MAX_OUT) out += d;
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      if (err.length < MAX_OUT) err += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish(() => reject(new KeyringError(e.code === 'ENOENT' || e.code === 'EACCES' ? 'no-tool' : 'failed'))));
    child.on('close', (code) => finish(() => resolve({ code, out, err })));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

/** O chaveiro do sistema pelo `secret-tool`. */
export function createSecretToolKeyring(o: SecretToolOptions = {}): Keyring {
  const bin = o.bin ?? 'secret-tool';
  const readMs = o.readTimeoutMs ?? READ_TIMEOUT_MS;
  const writeMs = o.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  const label = o.label ?? LABEL;
  const breakMs = o.readBreakMs ?? READ_BREAK_MS;
  let readDownUntil = 0;
  const env = () => withBusEnv(o.env ?? process.env);
  const attrs = (id: string) => ['application', APP, 'id', id];

  /** Leitura: 1 nova tentativa só se estourou o prazo; estourando as duas, o disjuntor segura as próximas leituras por `readBreakMs`. */
  async function read(args: string[]): Promise<Run> {
    if (Date.now() < readDownUntil) throw new KeyringError('timeout');
    try {
      let r: Run;
      try {
        r = await run(bin, args, env(), null, readMs);
      } catch (e) {
        if (!(e instanceof KeyringError) || e.reason !== 'timeout') throw e;
        r = await run(bin, args, env(), null, readMs);
      }
      readDownUntil = 0;
      return r;
    } catch (e) {
      if (e instanceof KeyringError && e.reason === 'timeout') readDownUntil = Date.now() + breakMs;
      throw e;
    }
  }

  return {
    async store(id, value) {
      const r = await run(bin, ['store', `--label=${label}`, ...attrs(id)], env(), Buffer.from(value, 'utf8').toString('base64'), writeMs);
      if (r.code !== 0) throw new KeyringError(classifyStderr(r.err));
    },

    async lookup(id) {
      const r = await read(['lookup', ...attrs(id)]);
      // Saída 1 sem mensagem = o item não existe; com mensagem = o chaveiro não respondeu.
      if (r.code === 1 && !r.err.trim() && !r.out.trim()) return null;
      if (r.code !== 0) throw new KeyringError(classifyStderr(r.err));
      const b64 = r.out.trim();
      if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new KeyringError('failed');
      return Buffer.from(b64, 'base64').toString('utf8');
    },

    async clear(id) {
      const r = await run(bin, ['clear', ...attrs(id)], env(), null, writeMs);
      if (r.code !== 0 && (r.err.trim() || r.code !== 1)) throw new KeyringError(classifyStderr(r.err));
    },

    async probe() {
      await this.lookup(PROBE_ID);
    },
  };
}

let system: Keyring | null = null;
/** O chaveiro do sistema (um só por processo). */
export function systemKeyring(): Keyring {
  return (system ??= createSecretToolKeyring());
}
