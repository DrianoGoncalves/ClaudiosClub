import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureMycoGitignore } from './mycoGitignore';

// Registro das execuções de tarefa: `<projeto>/.myco/task-runs.jsonl`, uma linha JSON por evento. Só cresce (append-only):
// `start` quando a tentativa abre (começar, fila, retomada, ajuste) e `end` quando ela fecha (entregue, parada, limite,
// cancelada). Os dois têm o mesmo `runId`. Queda no meio da escrita deixa uma linha pela metade: a leitura a ignora, e a
// próxima gravação começa em linha nova. Acima de ~2 MB, o arquivo vira `.1` (só um antigo; o anterior é descartado).

export type RunTrigger = 'queue' | 'manual' | 'resume' | 'adjust' | 'routine';
export type RunOutcome = 'delivered' | 'stopped' | 'limit' | 'cancelled' | 'failed';

export interface TaskRunEvent {
  ev: 'start' | 'end';
  runId: string;
  taskId: string;
  staffId: string;
  sessionId?: string;
  /** Só no `start`: o que abriu a tentativa. */
  trigger?: RunTrigger;
  /** Só no `end`: como a tentativa fechou. */
  outcome?: RunOutcome;
  note?: string;
  idemKey?: string;
  /** Versões das skills usadas na execução (quem preenche é outro item; aqui só o campo). */
  skills?: Record<string, string>;
  at: string;
}

export const RUNS_FILE = 'task-runs.jsonl';
/** Acima disto, o arquivo gira para `.1` antes da próxima linha. */
export const RUNS_ROTATE_BYTES = 2 * 1024 * 1024;

/** Escrita por arquivo, na ordem de chegada: duas linhas nunca se intercalam. */
const queues = new Map<string, Promise<unknown>>();

const runsFile = (dir: string) => path.join(dir, '.myco', RUNS_FILE);

export function newRunId(): string {
  return `r-${randomBytes(4).toString('hex')}`;
}

/** Acrescenta um evento ao fim do arquivo. Gira o arquivo antes se ele passou do tamanho, e fecha a linha anterior se ela ficou pela metade. */
export function appendRun(dir: string, ev: TaskRunEvent): Promise<void> {
  const file = runsFile(dir);
  const prev = queues.get(file) ?? Promise.resolve();
  const run = prev.then(async () => {
    await ensureMycoGitignore(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { size, clean: endsClean } = await tail(file);
    let clean = endsClean;
    if (size > RUNS_ROTATE_BYTES) {
      await fs.rename(file, `${file}.1`);
      clean = true;
    }
    await fs.appendFile(file, (clean ? '' : '\n') + JSON.stringify(ev) + '\n', 'utf8');
  });
  queues.set(file, run.catch(() => {}));
  return run;
}

/** Os eventos do arquivo (o `.1` antes, se houver), na ordem; com `taskId`, só os dessa tarefa. Linha quebrada ou inválida é pulada. */
export async function readRuns(dir: string, taskId?: string): Promise<TaskRunEvent[]> {
  const file = runsFile(dir);
  const raws = await Promise.all([fs.readFile(`${file}.1`, 'utf8').catch(() => ''), fs.readFile(file, 'utf8').catch(() => '')]);
  const out: TaskRunEvent[] = [];
  for (const raw of raws)
    for (const line of raw.split('\n')) {
      const ev = parseRun(line);
      if (ev && (!taskId || ev.taskId === taskId)) out.push(ev);
    }
  return out;
}

function parseRun(line: string): TaskRunEvent | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const ev = JSON.parse(s) as Partial<TaskRunEvent> | null;
    if (!ev || (ev.ev !== 'start' && ev.ev !== 'end')) return null;
    if (typeof ev.runId !== 'string' || typeof ev.taskId !== 'string' || typeof ev.at !== 'string') return null;
    return ev as TaskRunEvent;
  } catch {
    return null;
  }
}

/** Tamanho do arquivo e se ele termina em quebra de linha (ausente = 0 bytes, limpo). */
async function tail(file: string): Promise<{ size: number; clean: boolean }> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return { size: 0, clean: true };
  try {
    const { size } = await fh.stat();
    if (!size) return { size, clean: true };
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    return { size, clean: last[0] === 0x0a };
  } finally {
    await fh.close();
  }
}
