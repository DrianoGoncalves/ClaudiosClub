import { GitFailure, gitReason, hasWorktree, runGit, worktreeFor, type GitRun } from './staff/worktree';

// A base da worktree de um funcionário ao começar um card: a worktree é sempre a mesma (ver staff/worktree.ts), então ela fica onde o último card a deixou, e o checkout principal
// segue andando (outros cards aprovados, commits). Começar numa base velha faz o tsc/os testes acusarem erro que não é do card e a junção conflitar.
// Aqui a worktree só AVANÇA, e só quando isso não perde nada: limpa (nada por commitar) e sem commit próprio por juntar. Nunca bloqueia o início: o que não dá para avançar vira nota.

const NOT_MYCO = [':(exclude).myco', ':(exclude).myco/**'];

/** Quantos arquivos o aviso lista; o resto vira "e mais N". */
const FILES_SHOWN = 12;

/** O que se fez com a worktree: `none` (não existe, ou não deu para ler), `current` (já tem o HEAD do principal), `advanced`, `kept` (fica onde está, e `why` diz por quê) ou `failed`. */
export type BaseSync =
  | { state: 'none' | 'current' }
  | { state: 'advanced'; from: string; to: string }
  | { state: 'kept'; why: 'dirty' | 'diverged'; at: string; head: string }
  | { state: 'failed'; at: string; head: string; reason: string };

export interface WorktreeBase {
  sync: BaseSync;
  /** Arquivos rastreados com mudança não commitada no checkout principal (a worktree nunca os tem). Fora `.myco/`. */
  mainDirty: string[];
}

export type SyncWorktree = (projectPath: string, staffId: string) => Promise<WorktreeBase>;

/**
 * Põe a worktree do funcionário no HEAD do checkout principal (fast-forward) se ela está limpa e o branch dela não tem commit próprio por juntar, e lê o que o principal tem
 * de mudança não commitada em arquivo rastreado (a base não o inclui). Qualquer falha de leitura vira `none`: quem chama segue o início do card.
 */
export async function syncWorktree(projectPath: string, staffId: string, git: GitRun = runGit): Promise<WorktreeBase> {
  const wt = worktreeFor(projectPath, staffId);
  const none: WorktreeBase = { sync: { state: 'none' }, mainDirty: [] };
  if (!(await hasWorktree(wt.path))) return none;
  const mainHead = await head(git, projectPath);
  const wtHead = await head(git, wt.path);
  if (!mainHead || !wtHead) return none;
  const mainDirty = await trackedChanges(git, projectPath);
  const at = wtHead.slice(0, 7);
  const to = mainHead.slice(0, 7);
  if (mainHead === wtHead) return { sync: { state: 'current' }, mainDirty };

  // O branch da worktree está atrás do principal (todo commit dele já está lá)? Só então há o que avançar sem perder nada.
  const behind = await isAncestor(git, projectPath, wtHead, mainHead);
  if (behind === null) return { sync: { state: 'none' }, mainDirty };
  if (!behind) {
    // O principal é que está atrás (o branch tem só commits próprios por cima dele): a base já inclui o principal. Os dois com commits de fora: divergiram.
    const ahead = await isAncestor(git, projectPath, mainHead, wtHead);
    return { sync: ahead === false ? { state: 'kept', why: 'diverged', at, head: to } : { state: 'current' }, mainDirty };
  }
  if ((await trackedChanges(git, wt.path, true)).length) return { sync: { state: 'kept', why: 'dirty', at, head: to }, mainDirty };
  try {
    await git(wt.path, ['merge', '--ff-only', mainHead]);
  } catch (err) {
    return { sync: { state: 'failed', at, head: to, reason: gitReason((err as Error).message) }, mainDirty };
  }
  return { sync: { state: 'advanced', from: at, to }, mainDirty };
}

/** O HEAD de `dir`, ou null se não der para ler. */
async function head(git: GitRun, dir: string): Promise<string | null> {
  return (await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim() || null;
}

/** `ancestor` é ancestral de `of`? Código de saída 1 = não; qualquer outra falha (commit que o repositório não conhece) = null: não dá para dizer. */
async function isAncestor(git: GitRun, dir: string, ancestor: string, of: string): Promise<boolean | null> {
  try {
    await git(dir, ['merge-base', '--is-ancestor', ancestor, of]);
    return true;
  } catch (err) {
    return err instanceof GitFailure && err.code === 1 ? false : null;
  }
}

/** Arquivos com mudança não commitada em `dir`, fora `.myco/`. Sem `untracked`, só os rastreados (o que o principal tem de não commitado e a worktree não herda). */
async function trackedChanges(git: GitRun, dir: string, untracked = false): Promise<string[]> {
  const out = await git(dir, ['status', '--porcelain', '-z', untracked ? '--untracked-files=normal' : '--untracked-files=no', '--', '.', ...NOT_MYCO]).catch(() => '');
  const fields = out.split('\0').filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    files.push(entry.slice(3));
    // Renomeado ou copiado: o nome de origem vem no campo seguinte, sem o código de duas letras.
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return files;
}

/** Nome de arquivo que cabe numa linha de aviso sem quebrar a linha nem o texto (como `SAFE_NAME` das tarefas). */
const SAFE_FILE = /^[^"`$\\\r\n\0]+$/;

const listFiles = (files: string[]): string => {
  const safe = files.filter((f) => SAFE_FILE.test(f));
  const shown = safe.slice(0, FILES_SHOWN).map((f) => `\`${f}\``).join(', ');
  const more = files.length - Math.min(safe.length, FILES_SHOWN);
  return more > 0 ? `${shown}${shown ? ' ' : ''}e mais ${more}` : shown;
};

/** A nota do histórico do card: o que se fez com a base. Vazio quando não há o que dizer (já estava no HEAD, ou nada a ler). */
export function baseNote(base: WorktreeBase): string {
  const { sync, mainDirty } = base;
  const parts: string[] = [];
  if (sync.state === 'advanced') parts.push(`worktree avançada para o HEAD do principal (${sync.from} → ${sync.to})`);
  else if (sync.state === 'kept') {
    parts.push(
      sync.why === 'dirty'
        ? `worktree fica na base antiga (${sync.at}; o principal está em ${sync.head}): tem mudança não commitada`
        : `worktree fica na base antiga (${sync.at}; o principal está em ${sync.head}): o branch dela tem commits por juntar e o principal seguiu por outro caminho, a junção pode conflitar`,
    );
  } else if (sync.state === 'failed') parts.push(`não deu para avançar a worktree para o HEAD do principal (${sync.at} → ${sync.head}): ${sync.reason}`);
  if (mainDirty.length) parts.push(`a base não inclui mudança não commitada do principal em ${mainDirty.length} ${mainDirty.length === 1 ? 'arquivo' : 'arquivos'}: ${listFiles(mainDirty)}`);
  return parts.join('; ');
}

/** O aviso para a conversa do card (vai no texto de partida), ou null quando a base não tem nada que o funcionário precise saber. */
export function baseWarning(base: WorktreeBase): string | null {
  const { sync, mainDirty } = base;
  const lines: string[] = [];
  if (sync.state === 'kept' || sync.state === 'failed') {
    lines.push(`Sua worktree não avançou para o HEAD do principal (${sync.head}) e segue na base ${sync.at}: ${sync.state === 'failed' ? sync.reason : sync.why === 'dirty' ? 'ela tem mudança não commitada' : 'o branch tem commits por juntar'}. Erro de tsc/teste em código que você não tocou pode ser dessa diferença.`);
  }
  if (mainDirty.length) {
    lines.push(
      `Aviso da base: o checkout principal tem mudança não commitada em ${mainDirty.length} ${mainDirty.length === 1 ? 'arquivo rastreado' : 'arquivos rastreados'} (${listFiles(mainDirty)}) e a sua worktree NÃO a inclui. Se o card depender dela, avise quem pediu em vez de refazê-la; erro de tsc/teste que dependa dela não é seu.`,
    );
  }
  return lines.length ? lines.join(' ') : null;
}
