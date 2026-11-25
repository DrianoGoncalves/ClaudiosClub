import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHANGED_FILES_MAX, COMMIT_LIST_MAX, type TaskCommit, type TaskCommitLeft } from '../shared/model';
import { cleanEnv } from './auth';
import { pathKey, type OwnerWrite } from './ownerEdits';
import { cleanRel, isBlockedRel } from './projectFiles';

// Commit automático de uma tarefa pronta (TaskService.autoCommit chama; o projeto liga em `.myco/board.json`, ver boardConfig.ts). Um commit LOCAL, nunca push, só com os
// arquivos que a tarefa alterou (`Task.changedFiles`) e que ainda têm mudança no git. O projeto é de todos: o que é de outra tarefa aberta, do índice do usuário ou dele mesmo fica de fora.
//
// O commit sai de um índice temporário (`GIT_INDEX_FILE`, montado do HEAD só com os caminhos da tarefa), pelo `git commit` de verdade: os hooks do repositório rodam e uma falha deles é
// só aviso. O índice do usuário não é lido para montar o commit, então o que ele deixou staged não entra; depois do commit, só as linhas dos caminhos commitados são refeitas nele
// (`git reset -q HEAD -- <caminhos>`), senão o `git status` mostraria o inverso da mudança. Os caminhos são literais (`GIT_LITERAL_PATHSPECS`, `update-index` por stdin com NUL):
// `*`, `[`, `:` e espaço no nome valem como são. Renome e exclusão não precisam de tratamento à parte: sem `--find-renames`, o renome são dois caminhos (um novo e um que sumiu), e
// `update-index --add --remove` grava o que está no disco ou tira o que sumiu, caminho por caminho.
//
// Limites conhecidos: edição só por shell não está em `changedFiles` (com a vaga de escrita ligada, a foto do que já estava sujo quando a tarefa a ocupou traz esses arquivos, ver `CommitRequest.slot`
// e slotSnapshot.ts); editor externo não é visto (o do Club sim, ver ownerEdits.ts), e durante a vaga a edição externa é indistinguível da da tarefa; o HEAD pode mudar entre a leitura e o `git commit`
// (a janela é de milissegundos: conferimos antes e depois, e a diferença vira aviso). Quem decide se roda e grava o resultado na tarefa é o TaskService; aqui só há git.

/** O commit lê o HEAD uma vez, mas hooks lentos (lint, testes) rodam depois dele: cinco minutos. */
const COMMIT_TIMEOUT_MS = 5 * 60_000;
/** Caminhos por chamada ao git: 100 caminhos de 300 caracteres cabem folgados na linha de comando do Windows. */
const PATH_CHUNK = 100;
/** Tolerância na comparação do mtime com o da sua gravação (o disco pode arredondar). */
const OWNER_SLACK_MS = 2;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
/** Quantos arquivos por fora de `changedFiles` a foto da vaga pode trazer para um commit: acima disso é obra em massa (dependência, build, renome do projeto), e quem decide é você. */
export const EXTRA_MAX = 1000;

/** Estados do repositório em que um commit comum faria outra coisa (merge, rebase…) ou nem começaria (`index.lock`). */
const BUSY: Array<[string, string]> = [
  ['MERGE_HEAD', 'o repositório está no meio de um merge'],
  ['CHERRY_PICK_HEAD', 'o repositório está no meio de um cherry-pick'],
  ['REVERT_HEAD', 'o repositório está no meio de um revert'],
  ['rebase-merge', 'o repositório está no meio de um rebase'],
  ['rebase-apply', 'o repositório está no meio de um rebase'],
  ['index.lock', 'outro comando do git está rodando (index.lock)'],
];

/** O motivo em pt-BR (o histórico da tarefa e a caixa usam; a tela monta o dela pelo código, no idioma da página). */
export function whyText(l: TaskCommitLeft): string {
  switch (l.why) {
    case 'blocked':
      return 'barrado: segredo, dependência ou caminho inválido';
    case 'conflict':
      return 'em conflito';
    case 'staged':
      return 'staged por você, com mudança nova depois';
    case 'owner':
      return 'editado por você';
    case 'shared':
      return `também alterado por ${l.by}, ${l.by?.includes(',') ? 'que ainda não terminaram' : 'que ainda não terminou'}`;
  }
}

/** Os arquivos de fora em uma linha: "a.ts (motivo), b.ts (motivo) e mais N". */
export function leftText(left: TaskCommitLeft[], shown = 3): string {
  const more = left.length > shown ? ` e mais ${left.length - shown}` : '';
  return `${left.slice(0, shown).map((l) => `${l.path} (${whyText(l)})`).join(', ')}${more}`;
}

/**
 * Outra tarefa não encerrada que também alterou o arquivo. `stoppedAt` (ms): quando ela saiu de "fazendo" ou "planejando" pela última vez; null = ela ainda pode estar editando
 * (a fazer, fazendo, planejando) ou não dá para saber (histórico sem a saída). O git não diz de quem é cada trecho da mudança pendente: o critério é conservador (ver `sharedBlockers`).
 */
export interface SharedHold {
  id: string;
  stoppedAt: number | null;
}

/**
 * O que a foto da vaga de escrita (ver slotSnapshot.ts) achou além de `Task.changedFiles`: `extra` são os caminhos que mudaram ou ficaram sujos depois da foto; `skipped` é o motivo de a foto não valer
 * (`cap` sujeira demais para a foto, `git` o git não respondeu, `limit` arquivos demais por fora: `found` é quantos) e o commit segue só com `changedFiles`.
 */
export type SlotFound = { extra: string[] } | { skipped: 'cap' | 'git' | 'limit'; found?: number };

export interface CommitRequest {
  /** A raiz do projeto (o checkout principal; worktree não passa por aqui). */
  dir: string;
  taskId: string;
  title: string;
  /** `Task.changedFiles` (ausente = a tarefa não tem lista). */
  files: string[] | undefined;
  /** O que outra tarefa não encerrada também alterou: `pathKey(caminho)` → quem. */
  shared: ReadonlyMap<string, SharedHold[]>;
  /** O que você gravou pelo editor do Club (ver ownerEdits.ts). */
  ownerWrites: Record<string, OwnerWrite>;
  /** Só quando a tarefa ocupou a vaga de escrita e tem foto (ver `SlotFound`); ausente = o comportamento de sempre, só `files`. */
  slot?: SlotFound;
}

/** A nota de uma foto da vaga que não valeu, e se ela precisa de você: o que ficou por fora não dá para contar, e acima do limite ao menos se sabe que há. */
function skippedNote(s: Extract<SlotFound, { skipped: unknown }>): { note: string; alert: boolean } {
  if (s.skipped === 'limit') return { note: `${s.found} arquivos mudaram desde que a tarefa ocupou a vaga (limite ${EXTRA_MAX}): só os da lista da tarefa foram considerados`, alert: true };
  if (s.skipped === 'cap') return { note: 'a foto da vaga não coube (arquivos sujos demais): só os da lista da tarefa foram considerados', alert: false };
  return { note: 'a foto da vaga não pôde ser conferida (git): só os da lista da tarefa foram considerados', alert: false };
}

/** O que `Task.commit` guarda, menos a entrega (`for`) e a hora (`at`), que são do TaskService. */
export type CommitResult = Omit<TaskCommit, 'for' | 'at'>;

/** `<título> (<id>)`: sem IA, uma linha, comprida o bastante para o título inteiro e curta o bastante para o `git log`. */
export function commitMessage(title: string, taskId: string): string {
  const line = title.replace(/\s+/g, ' ').trim();
  const head = line.length > 200 ? `${line.slice(0, 199)}…` : line;
  return head ? `${head} (${taskId})` : `Tarefa (${taskId})`;
}

/**
 * Quantos dos arquivos da tarefa ainda têm mudança no git (só leitura: é como a caixa sabe que o aviso do commit já passou, ver `server/inboxResolved.ts`). null = não dá para dizer: sem lista,
 * lista no teto (pode estar cortada), caminho que não é do projeto, repositório fora de condição de commit (ver `inspectRepo`) ou git que falhou. Nunca lança.
 */
export async function pendingChanges(dir: string, files: string[] | undefined, view = false): Promise<number | null> {
  const list = [...new Set(files ?? [])];
  if (!list.length || list.length >= CHANGED_FILES_MAX) return null;
  const rels: string[] = [];
  for (const f of list) {
    const rel = safeRel(f);
    if (rel === null) return null;
    rels.push(rel);
  }
  try {
    if (view) {
      const { status } = await repoAndStatusForView(dir, rels);
      return status ? status.size : null;
    }
    const repo = await inspectRepo(dir);
    return repo.ok ? (await statusOf(dir, repo.prefix, rels)).size : null;
  } catch {
    return null;
  }
}

/** O `pendingChanges` da caixa (`InboxResolver.commit`): o repositório e o status do projeto divididos com as outras leituras da tela (ver `viewProbe`). */
export const pendingChangesForView = (dir: string, files: string[] | undefined): Promise<number | null> => pendingChanges(dir, files, true);

/** Faz o commit dos arquivos da tarefa, ou diz por que não fez. Nunca lança: o motivo vai em `note`. */
export async function commitTaskFiles(req: CommitRequest): Promise<CommitResult> {
  // A foto da vaga que não valeu entra na nota de qualquer resultado: sem ela, quem lê não sabe que o que a tarefa fez por script pode ter ficado de fora.
  const skipped = req.slot && 'skipped' in req.slot ? skippedNote(req.slot) : null;
  const none = (note: string, alert = false, left: TaskCommitLeft[] = []): CommitResult => ({ status: 'none', sha: null, files: [], left: cap(left), note: skipped ? `${note}; ${skipped.note}` : note, alert: alert || !!skipped?.alert });
  const listed = [...new Set(req.files ?? [])];
  // Com foto válida, o que a lista não traz vem dela (e a lista cortada não é problema: a foto olha o projeto todo).
  const extra = req.slot && 'extra' in req.slot ? req.slot.extra : null;
  if (!listed.length && !extra?.length) return none(extra ? 'a tarefa não tem lista de arquivos e a foto da vaga não achou arquivo alterado: nada foi commitado' : 'a tarefa não tem lista de arquivos (edição só por shell não é detectada): nada foi commitado');
  // No teto a lista foi cortada (ver CHANGED_FILES_MAX): o que sobrou fora dela não seria commitado e a tarefa pareceria inteira.
  if (!extra && listed.length >= CHANGED_FILES_MAX) return none(`a lista de arquivos chegou ao limite de ${CHANGED_FILES_MAX} e pode estar cortada: nada foi commitado`, true);

  const repo = await inspectRepo(req.dir);
  if (!repo.ok) return none(repo.note, repo.alert);

  const left: TaskCommitLeft[] = [];
  const seen = new Set<string>();
  const rels: string[] = [];
  for (const f of [...listed, ...(extra ?? [])]) {
    const rel = safeRel(f);
    if (rel === null) left.push({ path: f.slice(0, 200), why: 'blocked' });
    else if (!seen.has(pathKey(rel))) {
      seen.add(pathKey(rel));
      rels.push(rel);
    }
  }
  // Os que só a foto trouxe: não há prova de que foram da tarefa (o git não diz de quem é a mudança), então valem regras um pouco mais estritas (ver `leftOutWhy`).
  const fromPhoto = new Set((extra ?? []).map(pathKey));
  for (const f of listed) fromPhoto.delete(pathKey(f));

  try {
    const status = await statusOf(req.dir, repo.prefix, rels);
    const take: string[] = [];
    for (const rel of rels) {
      const key = pathKey(rel);
      const entry = status.get(key);
      if (!entry) continue; // sem mudança no git: já commitado ou desfeito
      const why = await leftOutWhy(req, entry, key, rel, fromPhoto.has(key));
      if (why) left.push({ path: entry.path, ...why });
      else take.push(entry.path);
    }
    if (!take.length) {
      return none(left.length ? 'nenhum arquivo da tarefa podia entrar no commit: nada foi commitado' : 'os arquivos da tarefa não têm mudança no git (já commitados ou desfeitos)', left.length > 0, left);
    }
    const made = await commitPaths(req.dir, repo.head, take, commitMessage(req.title, req.taskId));
    if (!made) return none('os arquivos da tarefa já estão no HEAD: nada a commitar', left.length > 0, left);
    const outside = take.filter((p) => fromPhoto.has(pathKey(p))).length;
    const notes: string[] = [];
    if (take.length > COMMIT_LIST_MAX) notes.push(`${take.length} arquivos no commit (a lista guarda ${COMMIT_LIST_MAX})`);
    if (outside) notes.push(`${outside} ${outside === 1 ? 'arquivo' : 'arquivos'} por fora da lista da tarefa, achados pela foto da vaga`);
    if (skipped) notes.push(skipped.note);
    if (made.problem) notes.push(made.problem);
    return {
      status: left.length ? 'partial' : 'committed',
      sha: made.sha,
      files: take.slice(0, COMMIT_LIST_MAX),
      left: cap(left),
      note: notes.length ? notes.join('; ') : null,
      alert: left.length > 0 || !!made.problem || !!skipped?.alert,
      ...(extra ? { extra: outside } : {}),
    };
  } catch (err) {
    return { status: 'failed', sha: null, files: [], left: cap(left), note: summarize(err), alert: true };
  }
}

/** O caminho como o git o vê (normalizado, com "/"), ou null quando não é um caminho do projeto (absoluto, com `..`, com NUL). */
function safeRel(f: string): string | null {
  try {
    return cleanRel(f) || null;
  } catch {
    return null;
  }
}

/**
 * Por que o arquivo fica de fora do commit, ou null se pode entrar. `fromPhoto`: o arquivo só veio da foto da vaga (não está na lista da tarefa); qualquer coisa staged nele já é escolha sua
 * (quem faz `git add` num arquivo que a tarefa nunca registrou está dizendo que é dele), e não só o staged com mudança por cima.
 */
async function leftOutWhy(req: CommitRequest, e: StatusEntry, key: string, rel: string, fromPhoto = false): Promise<Pick<TaskCommitLeft, 'why' | 'by'> | null> {
  if (isBlockedRel(rel)) return { why: 'blocked' };
  if (isConflict(e)) return { why: 'conflict' };
  const holding = await sharedBlockers(req.dir, rel, req.shared.get(key) ?? []);
  if (holding.length) return { why: 'shared', by: holding.join(', ') };
  // Staged e com mudança nova por cima (MM, AM…): o índice guarda uma escolha sua que o commit passaria por cima.
  if (e.x !== ' ' && e.x !== '?' && (e.y !== ' ' || fromPhoto)) return { why: 'staged' };
  if (await ownerWrote(req.dir, e.path, req.ownerWrites[key])) return { why: 'owner' };
  return null;
}

/** O arquivo ainda está como você o gravou pelo editor do Club (`w`, ver ownerEdits.ts)? O mtime ainda é o da sua gravação: a última mão nele foi a sua (a edição da tarefa, se houve, veio antes). */
export async function ownerWrote(dir: string, rel: string, w: OwnerWrite | undefined): Promise<boolean> {
  if (!w) return false;
  const st = await fs.stat(path.join(dir, rel)).catch(() => null);
  return !!st && st.mtimeMs <= w.mtimeMs + OWNER_SLACK_MS;
}

/**
 * Quando o HEAD levou `rel` pela última vez (ms; o git guarda em segundos), ou null: arquivo sem commit, caminho que o git não conhece ou git que falhou. Nunca lança.
 * `rel` é o caminho do projeto (o `-C` do git já está na raiz dele), literal.
 */
export async function lastCommitMs(dir: string, rel: string, git: GitRun = gitDefault): Promise<number | null> {
  try {
    const secs = Number((await git(dir, ['log', '-1', '--format=%ct', '--', rel], { env: LITERAL })).trim());
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Das outras tarefas abertas que alteraram `rel`, as que ainda podem ter mudança pendente nele (os ids, na ordem de `holds`). O git não atribui a mudança pendente a uma tarefa, então vale o
 * critério conservador: quem ainda pode editar (`stoppedAt` null) sempre barra; quem já parou (revisão, Aguardar) só barra se o arquivo NÃO teve commit depois da parada, porque um commit leva
 * o arquivo inteiro e o que ela editou antes dele já está dentro. Empate (o git conta em segundos), arquivo sem commit ou erro do git: barra. Limite aceito: um commit parcial por trecho
 * (`git add -p`) de um arquivo dela deixaria um trecho pendente e este critério o liberaria.
 */
async function sharedBlockers(dir: string, rel: string, holds: readonly SharedHold[]): Promise<string[]> {
  if (!holds.some((h) => h.stoppedAt !== null)) return holds.map((h) => h.id);
  const committed = await lastCommitMs(dir, rel);
  return holds.filter((h) => h.stoppedAt === null || committed === null || committed <= h.stoppedAt).map((h) => h.id);
}

export type Repo = { ok: true; head: string; prefix: string } | { ok: false; note: string; alert: boolean };

/** O repositório está em condição de receber o commit? `alert` falso: não há o que você fazer (não é um repositório). */
export async function inspectRepo(dir: string, git: GitRun = gitDefault): Promise<Repo> {
  if ((await git(dir, ['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() !== 'true') return { ok: false, note: 'o projeto não é um repositório git', alert: false };
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  if (!head) return { ok: false, note: 'o repositório ainda não tem nenhum commit: nada foi commitado', alert: true };
  if (!(await git(dir, ['symbolic-ref', '-q', 'HEAD']).then(() => true, () => false))) return { ok: false, note: 'o HEAD está destacado (fora de um branch): nada foi commitado', alert: true };
  for (const [name, why] of BUSY) {
    const p = (await git(dir, ['rev-parse', '--git-path', name]).catch(() => '')).trim();
    if (p && (await fs.stat(path.resolve(dir, p)).then(() => true, () => false))) return { ok: false, note: `${why}: nada foi commitado`, alert: true };
  }
  // Projeto numa subpasta do repositório: o `status` devolve caminhos a partir da raiz do repositório, e a tarefa guarda a partir do projeto.
  return { ok: true, head, prefix: (await git(dir, ['rev-parse', '--show-prefix']).catch(() => '')).trim() };
}

export interface StatusEntry {
  /** O caminho como o git o escreve (a partir do projeto). */
  path: string;
  x: string;
  y: string;
}

/** `git status` dos caminhos pedidos, por `pathKey`; arquivo sem mudança não aparece. Sem renome: um renome são dois caminhos. */
export async function statusOf(dir: string, prefix: string, rels: string[], git: GitRun = gitDefault): Promise<Map<string, StatusEntry>> {
  const out = new Map<string, StatusEntry>();
  for (let i = 0; i < rels.length; i += PATH_CHUNK) {
    const raw = await git(dir, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', ...rels.slice(i, i + PATH_CHUNK)], { env: LITERAL });
    for (const rec of raw.split('\0')) {
      if (rec.length < 4) continue;
      const rel = rec.slice(3);
      const p = prefix && rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
      out.set(pathKey(p), { path: p, x: rec[0]!, y: rec[1]! });
    }
  }
  return out;
}

/**
 * Leituras da tela (a caixa, o contador de commits pendentes, o aviso de commit parcial no quadro): o estado do repositório e o `git status` do projeto
 * inteiro, UMA vez por projeto para todos que perguntam enquanto a leitura está em curso. Antes, cada aviso de commit rodava sozinho os 11 comandos do
 * `inspectRepo` mais o `status`, todos em paralelo: com ~50 avisos eram ~540 processos git por leitura da caixa (e o contador e o quadro faziam o mesmo),
 * e no Windows com HDD a máquina inteira parava por minutos. O status inteiro (sem caminhos) custa o mesmo que o de poucos arquivos. Nada fica guardado
 * depois de pronto: a próxima leitura vê o git de agora (um commit à mão aparece na hora). O commit de verdade (`commitTaskFiles`) e o refazer não passam por aqui.
 */
type ViewProbe = { repo: Repo; status: Map<string, StatusEntry> | null };
const viewProbes = new Map<string, Promise<ViewProbe>>();

/** O repositório e o status inteiro (por `pathKey` do caminho a partir da raiz do repositório); em curso, quem chega espera a mesma leitura. */
function viewProbe(dir: string): Promise<ViewProbe> {
  const key = pathKey(path.resolve(dir));
  const running = viewProbes.get(key);
  if (running) return running;
  const probe = (async (): Promise<ViewProbe> => {
    const repo = await inspectRepo(dir);
    if (!repo.ok) return { repo, status: null };
    const raw = await git(dir, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { env: LITERAL });
    const status = new Map<string, StatusEntry>();
    for (const rec of raw.split('\0')) if (rec.length >= 4) status.set(pathKey(rec.slice(3)), { path: rec.slice(3), x: rec[0]!, y: rec[1]! });
    return { repo, status };
  })();
  viewProbes.set(key, probe);
  const done = () => {
    if (viewProbes.get(key) === probe) viewProbes.delete(key);
  };
  probe.then(done, done);
  return probe;
}

/** O `inspectRepo` das leituras da tela (ver `viewProbe`). */
export async function inspectRepoForView(dir: string): Promise<Repo> {
  return (await viewProbe(dir)).repo;
}

/**
 * O repositório e o `statusOf(rels)` da MESMA leitura da tela (ver `viewProbe`). Quem precisa dos dois usa este: chamar `inspectRepoForView` e depois
 * `statusForView` faria duas leituras (a primeira já terminou quando a segunda pergunta). `status` null: repositório fora de condição de commit.
 */
export async function repoAndStatusForView(dir: string, rels: string[]): Promise<{ repo: Repo; status: Map<string, StatusEntry> | null }> {
  const probe = await viewProbe(dir);
  return { repo: probe.repo, status: probe.repo.ok && probe.status ? pickStatus(probe.status, probe.repo.prefix, rels) : null };
}

/**
 * O `statusOf` das leituras da tela (ver `viewProbe`): o mesmo resultado (por `pathKey`, caminho a partir do projeto; um caminho pedido que é pasta cobre o que
 * está dentro, como o pathspec), tirado do status inteiro. Lança se o repositório não está em condição (quem chama já trata, como no `statusOf`).
 */
export async function statusForView(dir: string, prefix: string, rels: string[]): Promise<Map<string, StatusEntry>> {
  const { status } = await viewProbe(dir);
  if (!status) throw new Error('o git status não está disponível');
  return pickStatus(status, prefix, rels);
}

/** Do status inteiro (por `pathKey` a partir da raiz do repositório), o dos caminhos pedidos, como o `statusOf` os devolveria. */
function pickStatus(status: Map<string, StatusEntry>, prefix: string, rels: string[]): Map<string, StatusEntry> {
  const exact = new Set(rels.map((r) => pathKey(prefix + r)));
  const dirs = [...exact].map((k) => (k.endsWith('/') ? k : `${k}/`));
  const out = new Map<string, StatusEntry>();
  for (const [k, e] of status) {
    if (!exact.has(k) && !dirs.some((d) => k.startsWith(d))) continue;
    const p = prefix && e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path;
    out.set(pathKey(p), { path: p, x: e.x, y: e.y });
  }
  return out;
}

/**
 * Tudo o que tem mudança no git dentro do projeto, por `pathKey` (a foto da vaga, ver slotSnapshot.ts): sem pathspec, o `status` olha o repositório inteiro e aqui sobra o que é da pasta do projeto,
 * com o caminho a partir dela. Lança se o git falhar (não é repositório, tempo esgotado). Sem renome, como `statusOf`.
 */
export async function dirtyOf(dir: string, git: GitRun = gitDefault, timeoutMs?: number): Promise<Map<string, StatusEntry>> {
  const prefix = (await git(dir, ['rev-parse', '--show-prefix'], { timeoutMs })).trim();
  const raw = await git(dir, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { timeoutMs });
  const out = new Map<string, StatusEntry>();
  for (const rec of raw.split('\0')) {
    if (rec.length < 4) continue;
    const rel = rec.slice(3);
    if (prefix && !rel.startsWith(prefix)) continue;
    const p = prefix ? rel.slice(prefix.length) : rel;
    out.set(pathKey(p), { path: p, x: rec[0]!, y: rec[1]! });
  }
  return out;
}

/** Os estados "não mesclado" do `git status`: UU, AA, DD, AU, UA, DU, UD. */
export const isConflict = (e: StatusEntry): boolean => e.x === 'U' || e.y === 'U' || (e.x === 'A' && e.y === 'A') || (e.x === 'D' && e.y === 'D');

/**
 * Monta o índice temporário (HEAD + só estes caminhos, como estão no disco) e commita. Null: com esses caminhos a árvore é a do HEAD (nada a commitar). `problem` é o que deu
 * errado DEPOIS de o commit existir (o HEAD já era outro, ou o índice não foi refeito): o commit vale, e o aviso diz o que conferir. Lança se o git recusou (hook, identidade…).
 */
export async function commitPaths(dir: string, head: string, paths: string[], message: string, git: GitRun = gitDefault): Promise<{ sha: string; problem: string | null } | null> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    await git(dir, ['read-tree', head], { env });
    await git(dir, ['update-index', '--add', '--remove', '-z', '--stdin'], { env, input: `${paths.join('\0')}\0` });
    const tree = (await git(dir, ['write-tree'], { env })).trim();
    if (tree === (await git(dir, ['rev-parse', `${head}^{tree}`])).trim()) return null;
    // O commit nasce do HEAD de agora: se um commit seu entrou no meio, a árvore do índice temporário (do HEAD velho) desfaria o seu.
    if ((await git(dir, ['rev-parse', 'HEAD'])).trim() !== head) throw new Error('o HEAD mudou enquanto o commit era preparado: nada foi commitado');
    await git(dir, ['commit', '-q', '-m', message], { env, timeoutMs: COMMIT_TIMEOUT_MS });
  } finally {
    // maxRetries: no Windows o git que acabou de sair (ou o antivírus) ainda pode segurar o índice por um instante (EBUSY/EPERM).
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
  const sha = (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
  if ((await git(dir, ['rev-parse', 'HEAD^']).catch(() => '')).trim() !== head) return { sha, problem: 'o HEAD mudou durante o commit: confira o histórico (git log) e o git status' };
  // O índice de verdade ainda tem a versão velha destes caminhos: sem refazer, o git status mostraria a mudança ao contrário.
  try {
    for (let i = 0; i < paths.length; i += PATH_CHUNK) await git(dir, ['reset', '-q', 'HEAD', '--', ...paths.slice(i, i + PATH_CHUNK)], { env: LITERAL });
  } catch (err) {
    return { sha, problem: `o índice do git não foi atualizado (${summarize(err)}): rode git reset -q para os arquivos do commit` };
  }
  return { sha, problem: null };
}

const cap = (left: TaskCommitLeft[]): TaskCommitLeft[] => left.slice(0, COMMIT_LIST_MAX).map((l) => ({ ...l, path: l.path.slice(0, 300) }));

/** O erro do git em uma linha: as primeiras linhas da saída dele (um hook que falha escreve o motivo ali), cortadas. */
export function summarize(err: unknown): string {
  const lines = ((err as Error)?.message ?? String(err))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' / ');
  return lines.length > 300 ? `${lines.slice(0, 299)}…` : lines || 'erro desconhecido do git';
}

export interface GitOpts {
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

/** O executor do git: os pontos de entrada exportados aceitam outro (o MCP de git passa o dele, sem hooks e com ambiente controlado). */
export type GitRun = (cwd: string, args: string[], opts?: GitOpts) => Promise<string>;

export const gitDefault: GitRun = (cwd, args, opts) => git(cwd, args, opts);

function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      { env: { ...cleanEnv(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', ...opts.env }, windowsHide: true, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error([stderr, stdout].map((s) => s.trim()).filter(Boolean).join('\n') || err.message));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.on('error', () => {}); // o git saiu sem ler tudo (erro de caminho): o motivo vem no callback acima, não aqui
      child.stdin?.end(opts.input);
    }
  });
}
