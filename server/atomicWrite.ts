import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Fila por arquivo (no processo): gravações no mesmo caminho rodam uma de cada vez.
// A entrada sai do mapa quando a fila esvazia.
const writeQueues = new Map<string, Promise<void>>();
// No Windows o rename pode falhar enquanto outro processo segura o destino (antivírus, indexador, leitor): sob carga, mais que uns centésimos de segundo.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 12;
const RENAME_BASE_MS = 25;
const RENAME_MAX_WAIT_MS = 1000; // teto por espera
// Esperas: 25, 50, 100, 200, 400, 800 e depois 1000 ms (com jitter de 50–100%): de ~3,3 a ~6,6 s no total.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** O arquivo de estado seguiu ocupado por outro processo até acabarem as tentativas. A API responde 503 (tentar de novo é seguro: nada foi gravado). */
export class StateBusyError extends Error {
  /** Segundos até valer a pena tentar de novo (cabeçalho `retry-after`). */
  readonly retryAfter = 5;
  constructor(
    /** Só para o log do servidor: não entra na mensagem, que vai para quem chamou. */
    readonly file: string,
    cause: unknown,
  ) {
    super('arquivo ocupado, tente de novo', { cause });
    this.name = 'StateBusyError';
  }
}

/** Troca `tmp` por `file`, repetindo enquanto o Windows recusa por EPERM/EACCES/EBUSY. Esgotadas as tentativas: `StateBusyError`; outro erro sai como veio. */
export async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RENAME_RETRY_CODES.has(code)) throw err;
      if (attempt >= RENAME_ATTEMPTS) throw new StateBusyError(file, err);
      await sleep(Math.min(RENAME_BASE_MS * 2 ** (attempt - 1), RENAME_MAX_WAIT_MS) * (0.5 + Math.random() / 2));
    }
  }
}

async function writeOnce(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined); // não deixa o .tmp largado
    throw err;
  }
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  const resolved = path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const run = (writeQueues.get(key) ?? Promise.resolve()).then(() => writeOnce(file, text));
  // A cauda nunca rejeita: a falha de uma gravação não trava as seguintes.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}
