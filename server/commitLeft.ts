import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { CHANGED_FILES_MAX, COMMIT_LIST_MAX, isClosed, type CommitLeft, type CommitLeftBlocker, type CommitLeftFile, type CommitLeftoverFile, type CommitLeftovers, type Task, type TaskCommitLeft } from '../shared/model';
import { gitDefault, inspectRepo, isConflict, statusOf, type GitRun, type Repo, type StatusEntry } from './autoCommit';
import { CHECK_DEADLINE_MS, COMMIT_CHECK_TTL_MS, settleWithin } from './inboxResolved';
import { pathKey } from './ownerEdits';
import { cleanRel, isBlockedRel } from './projectFiles';
import type { CommitAlert } from './tasks';

// O aviso de commit parcial como o dono precisa lê-lo (`Task.commitLeft`, só leitura, nada gravado) e o "refazer o commit das sobras" (o plano que o TaskService executa na fila de commits).
// O commit automático deixa arquivos de fora (`Task.commit.left`) por vários motivos; o que o dono precisa saber é outra coisa:
//   - waiting: algum arquivo de fora ainda é tocado (`changedFiles`) por um card aberto. Só ciência: o refazer espera esses cards fecharem, e o aviso nem entra na caixa;
//   - ready:   nenhum card aberto toca os arquivos de fora e eles seguem com mudança no git. Decisão do dono: refazer o commit das sobras pelo botão, ou ignorar;
//   - failed:  o git falhou, o repositório não estava em condição, ou o commit saiu mas o índice não foi refeito. Erro.
// Sem sobra com mudança no git o problema passou (commitada à mão, ou desfeita: o git não distingue) e não há estado; o item da caixa segue pelo `resolvedAt` (server/inboxResolved.ts).
// Só olha para os arquivos de `left`, todos os motivos (shared, owner, staged, conflict, blocked). Card cancelado não trava (conta como fechado em `isClosed`), mas pode ter deixado mudança no disco: o commit
// leva o arquivo inteiro, então ele sai em `cancelledBy` e o dono confirma vendo o diff.

/** Tamanho do diff de um arquivo e de todos os arquivos no preview. */
export const DIFF_FILE_MAX = 64 * 1024;
export const DIFF_TOTAL_MAX = 400 * 1024;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };

/** O caminho limpo (como o git o vê), ou null quando não é um caminho do projeto (absoluto, com `..`, com NUL). */
const relOf = (p: string): string | null => {
  try {
    return cleanRel(p) || null;
  } catch {
    return null;
  }
};

/**
 * Por que o botão não leva o arquivo AGORA, ou null se pode levar: segredo/dependência/caminho inválido (pelo caminho: a mesma checagem da leitura de arquivos do projeto e do commit automático),
 * conflito no git, ou staged por você com mudança nova por cima (o índice guarda uma escolha sua que o commit passaria por cima). O motivo gravado em `left` não decide: o que vale é o estado de agora.
 */
function refusal(file: string, e: StatusEntry | undefined): 'blocked' | 'conflict' | 'staged' | null {
  if (isBlockedRel(file)) return 'blocked';
  if (!e) return null;
  if (isConflict(e)) return 'conflict';
  if (e.x !== ' ' && e.x !== '?' && e.y !== ' ') return 'staged';
  return null;
}

/**
 * O estado do aviso de commit de `task` (null: sem aviso de pé, ou nenhuma sobra com mudança no git). `all` é o quadro (para achar os cards abertos e os cancelados que tocam as sobras);
 * `status` é o `git status` dos arquivos de `left` por `pathKey` (null = não deu para ler: tudo conta como ainda com mudança, e o botão revalida na hora).
 */
export function deriveCommitLeft(task: Task, all: readonly Task[], status: ReadonlyMap<string, StatusEntry> | null): CommitLeft | null {
  const c = task.commit;
  if (!c?.alert) return null;
  const truncated = c.left.length >= COMMIT_LIST_MAX ? ({ truncated: true } as const) : {};
  // Falhou, ou o aviso é de repositório/lista (alerta sem sobra: merge no meio, HEAD solto, lista no teto) ou do índice que não foi refeito: não há o que esperar nem refazer pelo botão.
  if (c.status === 'failed' || !c.left.length) {
    return { state: 'failed', sha: c.sha, files: c.left.map((l) => ({ path: l.path, why: l.why, by: [], redo: false })), blockers: [], canRedo: false, ...truncated, ...(c.note && { note: c.note }) };
  }
  const others = all.filter((o) => o.id !== task.id);
  // Card aberto com a lista de arquivos no teto pode ter mais do que ela guarda: conta como tocando tudo.
  const open = others.filter((o) => !isClosed(o)).map((o) => ({ o, keys: new Set((o.changedFiles ?? []).map(pathKey)), any: (o.changedFiles?.length ?? 0) >= CHANGED_FILES_MAX }));
  const cancelled = others.filter((o) => o.status === 'cancelled').map((o) => ({ id: o.id, keys: new Set((o.changedFiles ?? []).map(pathKey)) }));
  const files: CommitLeftFile[] = [];
  const touched = new Map<string, string[]>();
  for (const l of c.left) {
    const rel = relOf(l.path);
    const key = pathKey(rel ?? l.path);
    const entry = rel !== null && status ? status.get(key) : undefined;
    if (rel !== null && status && !entry) continue; // sem mudança no git: já commitado ou desfeito
    const why = refusal(l.path, entry);
    const by = open.filter((x) => x.any || x.keys.has(key)).map((x) => x.o.id);
    const cancelledBy = cancelled.filter((x) => x.keys.has(key)).map((x) => x.id);
    files.push({ path: l.path, why: why ?? l.why, by, ...(cancelledBy.length && { cancelledBy }), redo: why === null });
    for (const id of by) touched.set(id, [...(touched.get(id) ?? []), l.path]);
  }
  if (!files.length) return null;
  const blockers: CommitLeftBlocker[] = open.filter((x) => touched.has(x.o.id)).map((x) => ({ id: x.o.id, title: x.o.title.slice(0, 200), status: x.o.status, paths: touched.get(x.o.id)! }));
  const state = blockers.length ? 'waiting' : 'ready';
  return { state, sha: c.sha, files, blockers, canRedo: state === 'ready' && files.some((f) => f.redo), ...truncated };
}

/** O `git status` dos arquivos de fora e o estado do repositório. Nunca lança: `status` null = não deu para ler (repositório fora de condição de commit, ou o git falhou). */
async function readLeft(dir: string, left: readonly TaskCommitLeft[], git: GitRun): Promise<{ repo: Repo | null; status: Map<string, StatusEntry> | null }> {
  try {
    const repo = await inspectRepo(dir, git);
    if (!repo.ok) return { repo, status: null };
    const rels = [...new Set(left.map((l) => relOf(l.path)).filter((r): r is string => r !== null))];
    return { repo, status: rels.length ? await statusOf(dir, repo.prefix, rels, git) : new Map() };
  } catch {
    return { repo: null, status: null };
  }
}

/** O `git status` das sobras, guardado por aviso (`projeto:tarefa@at#refeitos`): a caixa é lida a cada poucos segundos e o git não precisa ser consultado todas as vezes. Só na memória. */
export class CommitLeftCache {
  private readonly entries = new Map<string, { at: number; status: Map<string, StatusEntry> | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** O status guardado, ou `load` (com o prazo do git lento: passou dele, vale "não sei" e a próxima leitura tenta de novo depois do TTL). */
  async status(key: string, load: () => Promise<Map<string, StatusEntry> | null>): Promise<Map<string, StatusEntry> | null> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < COMMIT_CHECK_TTL_MS) return hit.status;
    const status = await settleWithin(load(), CHECK_DEADLINE_MS, null);
    this.entries.set(key, { at: this.now(), status });
    return status;
  }

  /** Esquece os avisos do projeto (`prefix`) que a leitura mais recente não viu (resolvidos, ignorados, tarefa apagada). */
  sweep(prefix: string, seen: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix) && !seen.has(key)) this.entries.delete(key);
  }
}

const sharedCache = new CommitLeftCache();

export interface CommitLeftDeps {
  cache?: CommitLeftCache;
  git?: GitRun;
}

/**
 * A listagem de tarefas com `Task.commitLeft` (só as que têm aviso de commit de pé). O git só é consultado para quem tem sobras, uma vez por TTL (ver `CommitLeftCache`). Erro ao calcular: a lista
 * sai como estava (o estado é um complemento, nunca derruba o quadro).
 */
export async function withCommitLeft(tasks: Task[], projectId: string, dir: string, deps: CommitLeftDeps = {}): Promise<Task[]> {
  if (!tasks.some((t) => t.commit?.alert)) return tasks;
  try {
    const cache = deps.cache ?? sharedCache;
    const seen = new Set<string>();
    const out = await Promise.all(
      tasks.map(async (t) => {
        const c = t.commit;
        if (!c?.alert) return t;
        let status: Map<string, StatusEntry> | null = null;
        if (c.status !== 'failed' && c.left.length) {
          const key = `${projectId}:${t.id}@${c.at}#${c.redos?.length ?? 0}`;
          seen.add(key);
          status = await cache.status(key, async () => (await readLeft(dir, c.left, deps.git ?? gitDefault)).status);
        }
        const view = deriveCommitLeft(t, tasks, status);
        return view ? { ...t, commitLeft: view } : t;
      }),
    );
    cache.sweep(`${projectId}:`, seen);
    return out;
  } catch {
    return tasks;
  }
}

/**
 * Os arquivos que dizem se o aviso de commit já passou (ver `InboxResolver.commit`): num aviso de sobras, só as sobras (os commitados não contam); nos outros (git falhou, repositório fora de
 * condição), os da tarefa, como sempre foi.
 */
export const resolveBy = (t: Task): Pick<Task, 'changedFiles'> => (t.commit && t.commit.status !== 'failed' && t.commit.left.length ? { changedFiles: t.commit.left.map((l) => l.path) } : t);

/** Os avisos de commit que entram na lista da caixa: os que esperam outro card (`waiting`) ficam de fora (só ciência: estado na tarefa e contagem). */
export const commitInboxAlerts = (alerts: CommitAlert[]): CommitAlert[] => alerts.filter((a) => a.task.commitLeft?.state !== 'waiting');

/** Quantas tarefas (já com `commitLeft`) esperam outro card para as sobras serem commitadas e ainda não foram dispensadas pelo dono. */
export const commitWaitingCount = (tasks: readonly Task[]): number => tasks.filter((t) => t.commit?.alert && !t.commit.ack && t.commitLeft?.state === 'waiting').length;

/** O que o refazer vai fazer agora, lido do disco e do git neste instante (sem cache). Nada daqui chega do corpo do pedido. */
export interface LeftPlan {
  view: CommitLeft | null;
  /** O repositório não está em condição de receber um commit (merge no meio, HEAD solto…): o motivo. */
  repoNote?: string;
  /** O HEAD completo; null quando o repositório não está em condição. */
  head: string | null;
  /** O `git status` dos arquivos de fora; null = não deu para ler. */
  status: Map<string, StatusEntry> | null;
  /** Os arquivos que o botão levaria, como o git os escreve (só com `view.state === 'ready'`; cada um está em `left` da tarefa, com `redo` verdadeiro e mudança no git). */
  take: string[];
  /** O que de `left` ainda tem mudança e o botão não leva (com o motivo de agora). */
  remaining: TaskCommitLeft[];
  /** Os arquivos de fora que já não têm mudança no git. */
  dropped: string[];
  /** HEAD mais o conteúdo de cada arquivo de `take` (vazio sem `take`): o preview o entrega e o POST o confere. */
  digest: string;
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve) => {
    const h = createHash('sha256');
    const s = createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', () => resolve('gone')); // apagado (ou pasta): o hash de "sumiu" também é um estado
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** O plano do refazer para `task`, com `all` o quadro de agora. Nunca lança. */
export async function planLeftovers(dir: string, task: Task, all: readonly Task[], git: GitRun = gitDefault): Promise<LeftPlan> {
  const left = task.commit?.left ?? [];
  const { repo, status } = await readLeft(dir, left, git);
  const view = deriveCommitLeft(task, all, status);
  const plan: LeftPlan = { view, head: repo?.ok ? repo.head : null, ...(repo && !repo.ok && { repoNote: repo.note }), status, take: [], remaining: [], dropped: [], digest: '' };
  if (!status) return plan;
  for (const l of left) {
    const rel = relOf(l.path);
    if (rel !== null && !status.get(pathKey(rel))) plan.dropped.push(l.path);
  }
  if (view?.state !== 'ready' || !plan.head) return plan;
  const byKey = new Map(view.files.map((f) => [pathKey(relOf(f.path) ?? f.path), f]));
  const seen = new Set<string>();
  for (const l of left) {
    const key = pathKey(relOf(l.path) ?? l.path);
    const f = byKey.get(key);
    if (!f || seen.has(key)) continue;
    seen.add(key);
    const entry = status.get(key);
    if (f.redo && entry) plan.take.push(entry.path);
    else plan.remaining.push({ path: l.path, why: f.why });
  }
  if (plan.take.length) {
    const h = createHash('sha256').update(plan.head);
    for (const p of [...plan.take].sort()) {
      const e = status.get(pathKey(p))!;
      h.update(`\0${p}\0${e.x}${e.y}\0${await hashFile(path.join(dir, p))}`);
    }
    plan.digest = h.digest('hex').slice(0, 32);
  }
  return plan;
}

const statusLetter = (e: StatusEntry): 'M' | 'A' | 'D' => (e.x === '?' || e.x === 'A' ? 'A' : e.x === 'D' || e.y === 'D' ? 'D' : 'M');

/** O diff de um arquivo SEM rastreio (o git diff não o mostra): "arquivo novo" montado do disco, sem seguir link simbólico e sem ler mais que o teto. */
async function newFileDiff(dir: string, rel: string): Promise<{ diff: string; binary?: true; diffTruncated?: true }> {
  const abs = path.join(dir, rel);
  const st = await fs.lstat(abs).catch(() => null);
  if (!st) return { diff: '' };
  if (st.isSymbolicLink()) return { diff: `+${await fs.readlink(abs).catch(() => '')}\n` };
  if (!st.isFile()) return { diff: '' };
  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, DIFF_FILE_MAX));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.subarray(0, 8000).includes(0)) return { diff: '', binary: true };
    const lines = head.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    const text = `diff --git a/${rel} b/${rel}\nnew file\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    return text.length > DIFF_FILE_MAX || st.size > DIFF_FILE_MAX ? { diff: text.slice(0, DIFF_FILE_MAX), diffTruncated: true } : { diff: text };
  } finally {
    await fh.close();
  }
}

/**
 * O diff do arquivo contra o HEAD (o que o commit levaria: o arquivo inteiro como está no disco). Sem `diff.external` nem `textconv` do repositório (rodariam programa dele), sem cor e sem renome.
 * Binário: vazio, marcado. Falha do git: vazio (o preview mostra o arquivo sem diff, e o POST segue valendo pelo `digest`).
 */
async function trackedDiff(dir: string, rel: string, git: GitRun): Promise<{ diff: string; binary?: true; diffTruncated?: true }> {
  const out = await git(dir, ['-c', 'core.quotepath=false', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--', rel], { env: LITERAL }).catch(() => '');
  if (/^Binary files /m.test(out)) return { diff: '', binary: true };
  return out.length > DIFF_FILE_MAX ? { diff: out.slice(0, DIFF_FILE_MAX), diffTruncated: true } : { diff: out };
}

/**
 * O preview do refazer (`GET .../commit-leftovers`). O diff só vem de arquivo que o botão levaria (`redo`), então nunca de segredo (a checagem é a do caminho, a mesma de `files/read`, e vale mesmo
 * quando o motivo gravado era outro), nem de arquivo em conflito ou staged por você. Teto de 64 KB por arquivo e 400 KB no todo: passou, o arquivo sai sem diff e marcado.
 */
export async function leftoversPreview(dir: string, task: Task, plan: LeftPlan, git: GitRun = gitDefault): Promise<CommitLeftovers> {
  const view = plan.view;
  const head = (plan.head ?? '').slice(0, 7);
  const sha = task.commit?.sha ?? null;
  if (!view) return { taskId: task.id, sha, canRedo: false, head, digest: '', files: [], blockers: [], dropped: plan.dropped };
  let used = 0;
  const files: CommitLeftoverFile[] = [];
  for (const f of view.files) {
    const rel = relOf(f.path);
    const entry = rel !== null ? plan.status?.get(pathKey(rel)) : undefined;
    const base = { ...f, status: entry ? statusLetter(entry) : ('M' as const), diff: '' };
    if (!f.redo || !entry || rel === null || view.state !== 'ready' || isBlockedRel(f.path)) {
      files.push(base);
      continue;
    }
    if (used >= DIFF_TOTAL_MAX) {
      files.push({ ...base, diffTruncated: true });
      continue;
    }
    const d = entry.x === '?' ? await newFileDiff(dir, entry.path).catch(() => ({ diff: '' as string })) : await trackedDiff(dir, entry.path, git);
    used += d.diff.length;
    files.push({ ...base, ...d });
  }
  // Sem `take` (o git não respondeu, ou o repositório não está em condição) não há o que confirmar: o botão não se oferece.
  const canRedo = view.canRedo && plan.take.length > 0;
  return {
    taskId: task.id,
    state: view.state,
    sha,
    canRedo,
    head,
    digest: canRedo ? plan.digest : '',
    files,
    blockers: view.blockers,
    dropped: plan.dropped,
    ...(view.truncated && { truncated: true as const }),
  };
}
