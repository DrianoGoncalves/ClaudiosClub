import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Fila por arquivo (no processo): gravações no mesmo caminho rodam uma de cada vez.
// A entrada sai do mapa quando a fila esvazia.
const writeQueues = new Map<string, Promise<void>>();
// No Windows o rename pode falhar um instante (antivírus/indexador segurando o destino).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// Com um arquivo de MB num HDD, o antivírus segura o destino por mais de 650 ms e a gravação se perdia (EPERM no log): agora até ~3 s.
const RENAME_ATTEMPTS = 9;
const RENAME_BASE_MS = 20; // esperas: ~20, 40, 80, 160, 320, 640, 1000, 1000 ms (com jitter de 50–100%): < 3,3 s no total
const RENAME_MAX_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !RENAME_RETRY_CODES.has(code)) throw err;
      if (attempt >= RENAME_ATTEMPTS) {
        console.warn(`[gravar] ${file}: ${code} em ${attempt} tentativas de troca; esta gravação não entrou`);
        throw err;
      }
      await sleep(Math.min(RENAME_MAX_WAIT_MS, RENAME_BASE_MS * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
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
