import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { gitReason, hasWorktree, runGit, type GitRun, type Worktree } from './staff/worktree';

// A worktree de um CARD: cada tarefa que edita código trabalha numa cópia git só dela (`<projeto>/.claude/worktrees/myco-card-<id>`, branch `myco-card/<id>`), criada a partir do HEAD do
// checkout principal quando o card começa. Diferente da worktree da ficha (staff/worktree.ts), que é uma por funcionário e serve a todos os cards dele, esta nasce e morre com o card:
// aprovado e junto (ou cancelado) ela é apagada. O `myco-` no nome mantém as sessões dela ligadas ao projeto (ver `mycoWorktreeParents`); o branch fica fora de `myco/` para não colidir
// com o de uma ficha. As dependências (`node_modules`, `vendor`) entram por junção para as do projeto, sem copiar, e só quando o git as ignora (senão apareceriam como mudança do card).

/** Os ids de tarefa que viram nome de pasta e de branch: nada de separador, ponto duplo ou espaço. */
const SAFE_TASK_ID = /^[a-z0-9][a-z0-9-]{0,59}$/i;

/** Pastas de dependências ligadas por junção ao projeto. */
export const LINKED_DEPS = ['node_modules', 'vendor'] as const;

/** O `git worktree add` baixa todos os arquivos: num projeto grande, com a máquina carregada, passa dos 30 s dos outros comandos. */
const ADD_TIMEOUT_MS = 5 * 60_000;

/** O espaço livre mínimo para abrir uma worktree: o maior entre este piso e cinco vezes o tamanho dos arquivos versionados. */
export const MIN_FREE_BYTES = 1024 ** 3;
const FREE_FACTOR = 5;

/** A faixa de portas que o Club reserva aos servidores de tela dos cards (uma por card; ver `allocateCardPort`). */
export const CARD_PORTS = { from: 43000, to: 43999 } as const;

/** Quantas entradas a procura por junções percorre antes de desistir (fail closed: sem ter olhado tudo, não se apaga a pasta). */
const SCAN_MAX = 300_000;

export class CardWorktreeError extends Error {}

export const cardWorktreeFor = (projectPath: string, taskId: string): Worktree => {
  if (!SAFE_TASK_ID.test(taskId)) throw new CardWorktreeError(`id de tarefa inválido para nome de pasta: ${taskId.slice(0, 40)}`);
  return { path: path.join(projectPath, '.claude', 'worktrees', `myco-card-${taskId}`), branch: `myco-card/${taskId}` };
};

/** O ref em que o trabalho de um card cancelado fica guardado depois de o branch sair (`git branch resgate refs/myco/cancelled/<id>` o traz de volta). */
export const rescueRefFor = (taskId: string): string => `refs/myco/cancelled/${taskId}`;

export type CardAvailability = { ok: true } | { ok: false; reason: string };

/** O espaço livre, em bytes, no disco da pasta (null se não deu para ler). */
export type FreeBytes = (dir: string) => Promise<number | null>;

export const freeBytes: FreeBytes = async (dir) => {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
};

/** O tamanho, em bytes, dos arquivos versionados no HEAD (`ls-tree -r -l`): é o que uma worktree nova baixa. 0 se não deu para ler. */
async function trackedBytes(git: GitRun, projectPath: string): Promise<number> {
  const out = await git(projectPath, ['ls-tree', '-r', '-l', 'HEAD']).catch(() => '');
  let total = 0;
  for (const line of out.split('\n')) {
    const size = Number(/^\S+\s+\S+\s+\S+\s+(\d+)\t/.exec(line)?.[1]);
    if (Number.isFinite(size)) total += size;
  }
  return total;
}

/** O projeto aguenta uma worktree de card agora? É repositório git, tem commit e tem disco. Quando não, o motivo (a tarefa edita no principal, como antes, e o motivo fica no card). */
export async function cardWorktreeAvailable(projectPath: string, git: GitRun = runGit, free: FreeBytes = freeBytes): Promise<CardAvailability> {
  const inside = await git(projectPath, ['rev-parse', '--is-inside-work-tree']).catch(() => '');
  if (inside.trim() !== 'true') return { ok: false, reason: 'o projeto não é um repositório git' };
  if (!(await git(projectPath, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false))) return { ok: false, reason: 'o repositório ainda não tem nenhum commit' };
  const left = await free(projectPath);
  if (left !== null) {
    const need = Math.max(MIN_FREE_BYTES, FREE_FACTOR * (await trackedBytes(git, projectPath)));
    if (left < need) return { ok: false, reason: `pouco espaço em disco (${mb(left)} livres, a worktree pede ${mb(need)})` };
  }
  return { ok: true };
}

const mb = (n: number): string => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

export interface CardWorktree extends Worktree {
  /** O HEAD de onde o card partiu (o do principal quando a worktree nasceu; o branch, se já existia). */
  base: string | null;
  /** As pastas de dependências ligadas por junção. */
  linked: string[];
}

/** Uma criação por worktree de cada vez (como `ensureWorktree`): o segundo `worktree add` falharia com "already exists" depois de a pasta já existir. */
const creating = new Map<string, Promise<CardWorktree>>();

/**
 * Cria a worktree do card se ainda não existir (idempotente: reinício, retomada e ajuste reencontram a mesma). Parte do HEAD do principal de agora. Pasta parcial (o Club caiu no meio do
 * `worktree add`) é refeita; branch que sobrou sem pasta é reaproveitado. Erro de git vira `CardWorktreeError` com a explicação: quem chama cai no principal, com o motivo.
 */
export function ensureCardWorktree(projectPath: string, taskId: string, git: GitRun = runGit): Promise<CardWorktree> {
  const key = cardWorktreeFor(projectPath, taskId).path;
  const running = creating.get(key);
  if (running) return running;
  const run = create(projectPath, taskId, git).finally(() => creating.delete(key));
  creating.set(key, run);
  return run;
}

async function create(projectPath: string, taskId: string, git: GitRun): Promise<CardWorktree> {
  const wt = cardWorktreeFor(projectPath, taskId);
  const head = async (dir: string) => (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || null;
  if (await hasWorktree(wt.path)) return { ...wt, base: await head(wt.path), linked: await linkDeps(projectPath, wt.path, git) };
  // Pasta que não é worktree (criação cortada no meio): sai antes de refazer, junções primeiro (ver `unlinkAll`).
  if (await fs.stat(wt.path).then(() => true, () => false)) {
    const gone = await unlinkAll(wt.path);
    if (!gone.ok) throw new CardWorktreeError(`sobrou uma pasta incompleta em ${wt.path} e não deu para limpá-la: ${gone.reason}`);
    await fs.rm(wt.path, { recursive: true, force: true });
  }
  await git(projectPath, ['worktree', 'prune']).catch(() => '');
  const branchExists = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).then(() => true, () => false);
  await fs.mkdir(path.dirname(wt.path), { recursive: true });
  try {
    await git(projectPath, branchExists ? ['worktree', 'add', wt.path, wt.branch] : ['worktree', 'add', '-b', wt.branch, wt.path, 'HEAD'], ADD_TIMEOUT_MS);
  } catch (err) {
    throw new CardWorktreeError(`não deu para criar a worktree do card: ${gitReason((err as Error).message)}`);
  }
  return { ...wt, base: await head(wt.path), linked: await linkDeps(projectPath, wt.path, git) };
}

/** Liga por junção as dependências que o projeto tem e o git ignora. O que falhar fica de fora (o card instala por conta própria): nunca derruba a criação. Devolve os nomes ligados. */
async function linkDeps(projectPath: string, wtPath: string, git: GitRun): Promise<string[]> {
  const linked: string[] = [];
  for (const name of LINKED_DEPS) {
    const src = path.join(projectPath, name);
    const dest = path.join(wtPath, name);
    try {
      if (!(await fs.stat(src)).isDirectory()) continue;
      // Já existe (a worktree reencontrada): só confere.
      if (await fs.lstat(dest).then(() => true, () => false)) {
        if ((await fs.lstat(dest)).isSymbolicLink()) linked.push(name);
        continue;
      }
      // Só se o git ignora: o link não pode aparecer como mudança do card (e entrar no commit da entrega).
      await git(projectPath, ['check-ignore', '-q', name]);
      await fs.symlink(src, dest, 'junction');
      linked.push(name);
    } catch {
      // sem a pasta, não ignorada ou sem permissão: o card segue sem ela
    }
  }
  return linked;
}

/**
 * Todo link simbólico e toda junção sob `root`, sem descer neles. No Windows o git SEGUE junções ao apagar a pasta (`worktree remove`, `rm -r`): a junção de `node_modules` apagou o conteúdo da
 * pasta do projeto uma vez. Então os links saem ANTES, e quem apaga só apaga se não restou nenhum. Passou de `SCAN_MAX` entradas: devolve `complete: false` (não se apaga sem ter olhado).
 */
async function findLinks(root: string): Promise<{ links: string[]; complete: boolean }> {
  const links: string[] = [];
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (dir === root && name === '.git') continue;
      if (++seen > SCAN_MAX) return { links, complete: false };
      const full = path.join(dir, name);
      const st = await fs.lstat(full).catch(() => null);
      if (!st) continue;
      if (st.isSymbolicLink()) links.push(full);
      else if (st.isDirectory()) stack.push(full);
    }
  }
  return { links, complete: true };
}

/** Remove cada link (sem seguir): `rmdir` apaga a junção sem tocar no destino; `unlink` cobre o link simbólico de arquivo. Confere que sumiram. */
async function unlinkAll(root: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { links, complete } = await findLinks(root);
  if (!complete) return { ok: false, reason: 'a pasta tem arquivos demais para conferir se há junções nela' };
  for (const link of links) {
    await fs.rmdir(link).catch(() => fs.unlink(link)).catch(() => {});
    if (await fs.lstat(link).then(() => true, () => false)) return { ok: false, reason: `não deu para desfazer o link ${path.relative(root, link)}` };
  }
  return { ok: true };
}

export interface CardRemoval {
  removed: boolean;
  /** O que impediu (pasta em uso, link que não saiu, git que falhou): a limpeza fica pendente e é refeita. */
  reason?: string;
  /** O branch ficou (não está todo no principal e a remoção não era para descartar). */
  branchKept?: boolean;
}

/**
 * Apaga a worktree do card e o branch. `discard`: card cancelado, o trabalho não vai ao principal: o que está na pasta é commitado e guardado em `refs/myco/cancelled/<id>` antes de o branch sair,
 * para um cancelamento por engano não perder nada. Sem `discard` (card junto ao principal), o branch só sai se já está todo nele (`branch -d`). Ordem fixa: links, worktree, branch. Falha no meio
 * devolve o motivo e não apaga o que vem depois; chamar de novo continua de onde parou.
 */
export async function removeCardWorktree(projectPath: string, taskId: string, opts: { discard?: boolean; git?: GitRun } = {}): Promise<CardRemoval> {
  const git = opts.git ?? runGit;
  const wt = cardWorktreeFor(projectPath, taskId);
  const there = await fs.stat(wt.path).then((s) => s.isDirectory(), () => false);
  if (there) {
    if (opts.discard && (await hasWorktree(wt.path))) {
      // O que não foi commitado também fica no resgate. Os links ainda estão aqui, mas `node_modules`/`vendor` são ignorados: o `add -A` não os leva.
      await git(wt.path, ['add', '-A', '--', '.', ':(exclude).myco', ':(exclude).myco/**']).catch(() => '');
      await git(wt.path, ['-c', 'user.name=Claudio’s Club', '-c', 'user.email=club@localhost', 'commit', '-q', '-m', `Cancelado (${taskId}): trabalho guardado`]).catch(() => '');
      const tip = await headOf(git, wt.path).catch(() => '');
      if (tip) await git(projectPath, ['update-ref', rescueRefFor(taskId), tip]).catch(() => '');
    }
    const gone = await unlinkAll(wt.path);
    if (!gone.ok) return { removed: false, reason: gone.reason };
    try {
      await git(projectPath, ['worktree', 'remove', '--force', wt.path], ADD_TIMEOUT_MS);
    } catch (err) {
      return { removed: false, reason: gitReason((err as Error).message) };
    }
    // `worktree remove` pode deixar a pasta (arquivo aberto no Windows): sem ela inteira fora, a limpeza não terminou.
    if (await fs.stat(wt.path).then(() => true, () => false)) return { removed: false, reason: 'a pasta da worktree continua lá (algo a mantém aberta)' };
  }
  await git(projectPath, ['worktree', 'prune']).catch(() => '');
  const exists = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).then(() => true, () => false);
  if (!exists) return { removed: true };
  try {
    await git(projectPath, ['branch', opts.discard ? '-D' : '-d', wt.branch]);
  } catch {
    return { removed: true, branchKept: true };
  }
  return { removed: true };
}

const headOf = async (git: GitRun, dir: string): Promise<string> => (await git(dir, ['rev-parse', 'HEAD'])).trim();

/** Os ids dos cards que têm pasta de worktree em `<projeto>/.claude/worktrees` (para a varredura de órfãs). */
export async function listCardWorktrees(projectPath: string): Promise<string[]> {
  const names = await fs.readdir(path.join(projectPath, '.claude', 'worktrees')).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('myco-card-')).map((n) => n.slice('myco-card-'.length)).filter((id) => SAFE_TASK_ID.test(id));
}

/** A porta está livre em 127.0.0.1? */
export type PortProbe = (port: number) => Promise<boolean>;

export const portIsFree: PortProbe = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

/** Uma porta da faixa do Club que nenhum outro card tem (`taken`) e que está livre agora; começa de um ponto que depende do card, para dois cards não disputarem a mesma. Null se a faixa acabou. */
export async function allocateCardPort(taskId: string, taken: Iterable<number>, probe: PortProbe = portIsFree): Promise<number | null> {
  const used = new Set(taken);
  const size = CARD_PORTS.to - CARD_PORTS.from + 1;
  let seed = 0;
  for (const ch of taskId) seed = (seed * 31 + ch.charCodeAt(0)) % size;
  for (let i = 0; i < size; i++) {
    const port = CARD_PORTS.from + ((seed + i) % size);
    if (!used.has(port) && (await probe(port))) return port;
  }
  return null;
}
