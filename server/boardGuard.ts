import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Task } from '../shared/model';
import { writeAtomic } from './atomicWrite';

// Proteção do quadro de tarefas (`.myco/tasks.json`) contra gravação que não chegou ao disco (queda de energia: em 23/11/2026 o arquivo voltou com 6,3 MB de zeros).
//   - Cópias: depois de cada gravação boa, no máximo uma a cada `TASKS_BACKUP_EVERY_MS`, em `.myco/backups/tasks/`. Ficam as `TASKS_BACKUP_RECENT` mais novas e
//     a última de cada dia por `TASKS_BACKUP_DAYS` dias.
//   - Arquivo que não lê como lista (zerado, cortado, JSON quebrado): o estragado é guardado ao lado (`tasks.json.corrompido-<data>`, uma vez por versão) e volta a cópia
//     boa mais nova (ou, sem cópia, a última versão que o servidor tinha lido). Sem nenhuma das duas, o quadro fica marcado como corrompido: as gravações são recusadas
//     (nunca uma lista nova por cima do estragado) e as leituras não relêem o arquivo enquanto ele não mudar, até alguém consertá-lo.
//   - Cada caso vira um aviso na caixa "precisa de mim" (`boardIncidents`).
// Nada aqui lança para quem só lê: falha ao pôr a cópia no lugar (arquivo preso, disco cheio) fica marcada e é tentada de novo depois de `RESTORE_RETRY_MS`.
// Vale igual para o arquivo morto (`.myco/tasks-arquivo.json`, as tarefas fechadas antigas, ver `coldAfterMs` em tasks.ts): cópias em `.myco/backups/tasks-arquivo/`
// (uma a cada entrada de tarefa nele, sem o limite de 10 min), estragado guardado ao lado, aviso próprio. O morto que já existiu (tem cópia) e sumiu conta como estragado:
// sumir não é "quadro novo", e a próxima entrada recriaria o arquivo sem as tarefas dele. Ver SPEC "Desempenho" 1 e 6.

export const TASKS_BACKUP_EVERY_MS = 10 * 60_000;
export const TASKS_BACKUP_RECENT = 6;
export const TASKS_BACKUP_DAYS = 7;
/** Restauração que falhou ao gravar: espera isso antes de tentar de novo (as leituras no meio não relêem nem copiam o arquivo). */
export const RESTORE_RETRY_MS = 60_000;
/** Quantos arquivos estragados guardados (`tasks.json.corrompido-*`) ficam no `.myco`. */
const CORRUPT_KEEP = 3;
const TMP_MAX_AGE_MS = 60 * 60_000;

/** Os arquivos do quadro, pelo nome sem `.json`: o ativo e o arquivo morto. */
export type BoardFile = 'tasks' | 'tasks-arquivo';
export const boardFilePath = (dir: string, name: BoardFile = 'tasks') => path.join(dir, '.myco', `${name}.json`);
export const tasksBackupDir = (dir: string, name: BoardFile = 'tasks') => path.join(dir, '.myco', 'backups', name);
const backupName = (name: BoardFile) => new RegExp(`^${name}-(\\d{8}-\\d{6})\\.json$`);
/** `AAAAMMDD-HHmmss` em UTC: ordena como texto. */
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const fromStamp = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
const dirKey = (dir: string) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir));
/** A chave de um arquivo do quadro nos mapas daqui. A do ativo é a pasta (como antes do arquivo morto: o id do aviso não muda). */
const keyOf = (dir: string, name: BoardFile = 'tasks') => (name === 'tasks' ? dirKey(dir) : `${dirKey(dir)}|${name}`);

/** O quadro está corrompido e não há o que pôr no lugar: nada foi gravado. A API responde 503. */
export class BoardCorruptError extends Error {
  constructor(readonly file: string) {
    super('o quadro de tarefas está corrompido e não há cópia boa para voltar: nada foi gravado (veja o aviso na caixa)');
    this.name = 'BoardCorruptError';
  }
}

export interface BoardIncident {
  /** `board:<projeto>:<data>`: o id do aviso na caixa. */
  id: string;
  dir: string;
  /** Qual dos arquivos do quadro: o ativo ou o arquivo morto. */
  file: BoardFile;
  kind: 'restored' | 'corrupt';
  at: string;
  /** De onde voltou: o nome da cópia, ou `memoria` (a última versão lida pelo servidor). */
  from: string | null;
  /** Quando foi feita a cópia que voltou (ISO), se for de arquivo. */
  fromAt: string | null;
  /** Onde ficou o arquivo estragado (caminho completo), ou null se não deu para guardar. */
  kept: string | null;
  /** O arquivo morto sumiu (apagado, quarentena do antivírus) depois de já ter existido: tratado como estragado. */
  missing?: boolean;
  /** "corrompido": a versão do arquivo (do `stat`) que não lê. Enquanto for a mesma, ninguém relê o arquivo. */
  version: string | null;
  /** "corrompido" porque a cópia não pôde ser gravada (e não por falta de cópia): quando tentar de novo (ms). */
  retryAt: number | null;
}

const incidents = new Map<string, BoardIncident>();
const lastBackup = new Map<string, number>();
const recovering = new Map<string, Promise<Task[] | null>>();

export const boardIncidents = (): BoardIncident[] => [...incidents.values()];
export const isBoardCorrupt = (dir: string, name: BoardFile = 'tasks'): boolean => incidents.get(keyOf(dir, name))?.kind === 'corrupt';

/**
 * A versão do arquivo que já se sabe corrompida e sem conserto agora (ou null): quem lê compara com o `stat` e, igual, nem abre o arquivo.
 * A restauração que falhou ao gravar volta a ser tentada depois de `retryAt`.
 */
export function knownCorruptVersion(dir: string, now = Date.now(), name: BoardFile = 'tasks'): string | null {
  const inc = incidents.get(keyOf(dir, name));
  if (inc?.kind !== 'corrupt' || !inc.version) return null;
  return inc.retryAt !== null && now >= inc.retryAt ? null : inc.version;
}

/** O arquivo voltou a ler (consertado à mão, restaurado ou apagado para recomeçar): o aviso de "corrompido" sai. O de "restaurado" fica até o dono ignorar. */
export function boardReadOk(dir: string, name: BoardFile = 'tasks'): void {
  if (isBoardCorrupt(dir, name)) incidents.delete(keyOf(dir, name));
}

/** O dono ignorou o aviso na caixa. */
export function dismissBoardIncident(id: string): boolean {
  for (const [k, v] of incidents) {
    if (v.id !== id) continue;
    // "Corrompido" não some só por ignorar: o quadro segue sem gravar. Some quando o arquivo volta a ler.
    if (v.kind === 'corrupt') return false;
    incidents.delete(k);
    return true;
  }
  return false;
}

/** Só os testes: esquece avisos e o relógio das cópias. */
export function resetBoardGuard(): void {
  incidents.clear();
  lastBackup.clear();
  recovering.clear();
}

/**
 * Guarda uma cópia do arquivo do quadro recém-gravado (`text`), no máximo uma a cada `everyMs` por arquivo, e apaga as que passaram da conta. Devolve se gravou.
 * O arquivo morto passa `everyMs` 0: ele muda pouco, e a cópia dele tem de ter tudo o que já saiu do ativo (restaurar uma cópia velha do morto perderia as tarefas que
 * entraram nele depois dela). Falha aqui nunca derruba a gravação do quadro: quem chama só registra no log (e a próxima gravação tenta de novo).
 */
export async function backupTasks(dir: string, text: string, now = Date.now(), name: BoardFile = 'tasks', everyMs = TASKS_BACKUP_EVERY_MS): Promise<boolean> {
  const key = keyOf(dir, name);
  if (now - (lastBackup.get(key) ?? -Infinity) < everyMs) return false;
  lastBackup.set(key, now);
  const bdir = tasksBackupDir(dir, name);
  try {
    await writeAtomic(path.join(bdir, `${name}-${stamp(new Date(now))}.json`), text);
  } catch (err) {
    lastBackup.delete(key);
    throw err;
  }
  await pruneBackups(bdir, now, name);
  return true;
}

/** Há cópia desse arquivo do quadro? (Do arquivo morto: ele já existiu, e sumir não é "quadro novo".) */
export async function hasBackups(dir: string, name: BoardFile): Promise<boolean> {
  return (await backupNames(tasksBackupDir(dir, name), name)).length > 0;
}

async function backupNames(bdir: string, name: BoardFile): Promise<string[]> {
  const re = backupName(name);
  return (await fs.readdir(bdir).catch(() => [] as string[])).filter((n) => re.test(n)).sort().reverse();
}

async function pruneBackups(bdir: string, now: number, name: BoardFile): Promise<void> {
  const re = backupName(name);
  const all = await fs.readdir(bdir).catch(() => [] as string[]);
  const names = all.filter((n) => re.test(n)).sort().reverse();
  const keep = new Set(names.slice(0, TASKS_BACKUP_RECENT));
  const firstDay = stamp(new Date(now - TASKS_BACKUP_DAYS * 86_400_000)).slice(0, 8);
  const days = new Set<string>();
  for (const n of names) {
    const day = re.exec(n)![1]!.slice(0, 8);
    if (day >= firstDay && !days.has(day)) {
      days.add(day);
      keep.add(n);
    }
  }
  for (const n of names) if (!keep.has(n)) await fs.rm(path.join(bdir, n), { force: true }).catch(() => undefined);
  // Temporário largado por uma gravação que caiu no meio.
  for (const n of all.filter((x) => x.endsWith('.tmp'))) {
    const st = await fs.stat(path.join(bdir, n)).catch(() => null);
    if (st && now - st.mtimeMs > TMP_MAX_AGE_MS) await fs.rm(path.join(bdir, n), { force: true }).catch(() => undefined);
  }
}

type Current = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; tasks: Task[] } | { kind: 'bad' };

async function readNow(file: string, parse: (raw: string) => Task[] | null): Promise<Current> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  const tasks = parse(raw);
  return tasks ? { kind: 'ok', tasks } : { kind: 'bad' };
}

/** Guarda o estragado ao lado (para quem quiser recuperar à mão) e deixa só os `CORRUPT_KEEP` mais novos. */
async function keepCorrupt(file: string, at: Date): Promise<string | null> {
  const kept = `${file}.corrompido-${stamp(at)}`;
  try {
    await fs.copyFile(file, kept);
  } catch {
    return null;
  }
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrompido-`;
  const old = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(prefix)).sort().reverse().slice(CORRUPT_KEEP);
  for (const n of old) await fs.rm(path.join(dir, n), { force: true }).catch(() => undefined);
  return kept;
}

/**
 * O `tasks.json` de `dir` não lê como lista (`version`: o `stat` dele). Guarda o estragado ao lado e põe no lugar a cópia boa mais nova (ou `lastGood`, a última versão
 * que o servidor leu). Devolve as tarefas que valem agora, ou null (nada bom: o quadro fica marcado como corrompido). Nunca lança. Uma recuperação por projeto de cada vez;
 * quem chega no meio espera a mesma.
 */
export function recoverTasks(
  dir: string,
  parse: (raw: string) => Task[] | null,
  lastGood: Task[] | null = null,
  version: string | null = null,
  board: BoardFile = 'tasks',
  /** O arquivo sumido também está estragado (o morto que já existiu: ver `hasBackups`). Sem isso, sumido é quadro novo. */
  missingIsBad = false,
): Promise<Task[] | null> {
  const key = keyOf(dir, board);
  const running = recovering.get(key);
  if (running) return running;
  const run = doRecover(dir, parse, lastGood, version, board, missingIsBad)
    .catch((err: Error) => {
      console.error(`[quadro] a recuperação de ${boardFilePath(dir, board)} falhou: ${err.message}`);
      return lastGood ? [...lastGood] : null;
    })
    .finally(() => recovering.delete(key));
  recovering.set(key, run);
  return run;
}

async function doRecover(
  dir: string,
  parse: (raw: string) => Task[] | null,
  lastGood: Task[] | null,
  version: string | null,
  board: BoardFile,
  missingIsBad: boolean,
): Promise<Task[] | null> {
  const file = boardFilePath(dir, board);
  const key = keyOf(dir, board);
  const bdir = tasksBackupDir(dir, board);
  // Outro leitor já recuperou, alguém consertou à mão ou apagou para recomeçar enquanto este esperava a vez.
  const current = await readNow(file, parse);
  const missing = current.kind === 'missing' && missingIsBad;
  if (current.kind === 'missing' && !missing) {
    boardReadOk(dir, board);
    return [];
  }
  if (current.kind === 'ok') {
    boardReadOk(dir, board);
    return current.tasks;
  }
  const prev = incidents.get(key);
  const at = new Date();
  const id = prev?.id ?? `board:${createHash('sha1').update(key).digest('hex').slice(0, 10)}:${stamp(at)}`;
  // O estragado é guardado uma vez por versão (cada leitura não copia de novo os MB dele).
  const kept = prev?.kept && prev.version === version ? prev.kept : current.kind === 'bad' ? await keepCorrupt(file, at) : null;

  /** Põe `text` no lugar, conferindo antes se o arquivo não foi consertado no meio. */
  const restore = async (text: string): Promise<'written' | 'fixed' | 'failed'> => {
    const again = await readNow(file, parse);
    if (again.kind === 'ok' || (again.kind === 'missing' && !missingIsBad)) return 'fixed';
    try {
      await writeAtomic(file, text);
      return 'written';
    } catch (err) {
      console.error(`[quadro] não deu para pôr a cópia no lugar de ${file}: ${(err as Error).message}; tento de novo em ${RESTORE_RETRY_MS / 1000} s`);
      return 'failed';
    }
  };
  const fixedMeanwhile = async () => {
    const now = await readNow(file, parse);
    boardReadOk(dir, board);
    return now.kind === 'ok' ? now.tasks : [];
  };

  let failed = false;
  for (const copy of await backupNames(bdir, board)) {
    const text = await fs.readFile(path.join(bdir, copy), 'utf8').catch(() => null);
    const tasks = text !== null ? parse(text) : null;
    if (!tasks || text === null) continue;
    const r = await restore(text);
    if (r === 'fixed') return fixedMeanwhile();
    if (r === 'failed') {
      failed = true;
      break; // a gravação falhou (arquivo preso, disco cheio): as outras cópias falhariam igual
    }
    const fromAt = fromStamp(backupName(board).exec(copy)![1]!).toISOString();
    incidents.set(key, { id, dir, file: board, kind: 'restored', at: at.toISOString(), from: copy, fromAt, kept, version: null, retryAt: null, ...(missing && { missing: true }) });
    console.warn(`[quadro] ${file} não lia como lista: voltou a cópia ${copy}${kept ? `; o estragado ficou em ${kept}` : ''}`);
    return tasks;
  }
  if (!failed && lastGood) {
    const r = await restore(JSON.stringify(lastGood, null, 2) + '\n');
    if (r === 'fixed') return fixedMeanwhile();
    if (r === 'written') {
      incidents.set(key, { id, dir, file: board, kind: 'restored', at: at.toISOString(), from: 'memoria', fromAt: null, kept, version: null, retryAt: null, ...(missing && { missing: true }) });
      console.warn(`[quadro] ${file} não lia como lista e não havia cópia: voltou a última versão lida pelo servidor${kept ? `; o estragado ficou em ${kept}` : ''}`);
      return [...lastGood];
    }
    failed = true;
  }
  // Nada voltou: marca com a versão do arquivo, para as leituras seguintes nem abrirem o arquivo enquanto ele não mudar.
  if (prev?.kind !== 'corrupt')
    console.error(`[quadro] ${file} ${missing ? 'sumiu' : 'não lê como lista'} e ${failed ? 'a cópia não pôde ser gravada' : 'não há cópia boa'}: gravações recusadas até o arquivo ser consertado`);
  incidents.set(key, {
    id,
    dir,
    file: board,
    kind: 'corrupt',
    at: prev?.kind === 'corrupt' ? prev.at : at.toISOString(),
    from: null,
    fromAt: null,
    kept,
    version,
    retryAt: failed ? Date.now() + RESTORE_RETRY_MS : null,
    ...(missing && { missing: true }),
  });
  // A última versão lida vale para quem só lê enquanto a cópia não entra (a próxima gravação a põe no disco, se o arquivo soltar).
  return failed && lastGood ? [...lastGood] : null;
}

/** O texto do aviso na caixa (pt-BR, como os demais avisos montados no servidor). */
export function boardIncidentSummary(inc: BoardIncident): string {
  const kept = inc.kept ? ` O arquivo estragado ficou em .myco/${path.basename(inc.kept)}.` : '';
  if (inc.file === 'tasks-arquivo') {
    const what = 'O arquivo morto do quadro (as tarefas fechadas antigas, .myco/tasks-arquivo.json)';
    const how = (now: boolean) =>
      inc.missing ? `${now ? 'sumiu' : 'tinha sumido'} (apagado à mão ou posto em quarentena pelo antivírus)` : `${now ? 'está' : 'estava'} corrompido (gravação que não chegou ao disco, como numa queda de energia)`;
    if (inc.kind === 'corrupt') {
      const why = inc.retryAt !== null ? 'e a cópia boa não pôde ser posta no lugar agora (arquivo preso ou disco cheio): tento de novo em instantes' : 'e não há cópia boa';
      // O quadro é um só: sem o morto, a fila liberaria quem espera por uma cancelada que está nele. Nada aparece e nada é gravado, como com o tasks.json estragado.
      const out = 'Para seguir sem as tarefas dele, tire do .myco o tasks-arquivo.json e a pasta backups/tasks-arquivo (guarde-os fora, se quiser tentar recuperar).';
      return `${what} ${how(true)} ${why}. Até lá, as tarefas não aparecem e nenhuma mudança é gravada. ${out}${kept}`;
    }
    const when = inc.fromAt ? new Date(inc.fromAt).toLocaleString('pt-BR') : null;
    return `${what} ${how(false)} e voltou ${inc.from === 'memoria' ? 'da última versão que o servidor tinha lido' : `da cópia de ${when}`}.${kept}`;
  }
  if (inc.kind === 'corrupt') {
    if (inc.retryAt !== null)
      return `O quadro de tarefas está corrompido (gravação que não chegou ao disco, como numa queda de energia) e a cópia boa não pôde ser posta no lugar agora (arquivo preso ou disco cheio): tento de novo em instantes. Até lá, nenhuma mudança é gravada.${kept}`;
    return `O quadro de tarefas está corrompido (gravação que não chegou ao disco, como numa queda de energia) e não há cópia boa: as tarefas não aparecem e nenhuma mudança é gravada até o .myco/tasks.json ser consertado.${kept}`;
  }
  const when = inc.fromAt ? new Date(inc.fromAt).toLocaleString('pt-BR') : null;
  const from = inc.from === 'memoria' ? 'da última versão que o servidor tinha lido' : `da cópia de ${when}`;
  return `O quadro de tarefas estava corrompido (gravação que não chegou ao disco, como numa queda de energia) e voltou ${from}. O que mudou depois disso se perdeu.${kept}`;
}
