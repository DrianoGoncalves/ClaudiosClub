import { ApiError, type GithubAlert, type GithubDiffItem, type GithubSkillStatus, type GithubTarget } from '../api';
import { locale, t } from '../i18n';

// Regras puras da tela de skills do GitHub (prévia, instalar, atualizar). A recusa de verdade é do servidor; aqui só se
// decide o que mostrar e como (ordem dos alertas, o que pede ciência, o texto de cada erro).

export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * "Há versão nova": o resultado da checagem diária diz que sim E o commit que ela achou não é o que já está instalado.
 * O resultado gravado fica velho depois de aplicar (a próxima checagem só vem no dia seguinte), então só o selo não basta.
 */
export const hasNewVersion = (s: GithubSkillStatus): boolean => !!s.update?.available && s.update.latestSha !== s.origin.sha;

/** O link da origem só vira `<a>` se for do GitHub por https (o metadado fica numa pasta que um agente pode mexer). */
export function safeRepoUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'www.github.com') && !u.username && !u.password && !u.port ? u.href : null;
  } catch {
    return null;
  }
}

/** `dono/repositorio` do link (sem `.git`), ou null se não for um link do GitHub. */
export function repoLabel(url: string): string | null {
  const safe = safeRepoUrl(url);
  if (!safe) return null;
  const [owner, repo] = new URL(safe).pathname.split('/').filter(Boolean);
  return owner && repo ? `${owner}/${repo.replace(/\.git$/, '')}` : null;
}

const LEVEL_ORDER: Record<GithubAlert['level'], number> = { danger: 0, warn: 1, info: 2 };

/** Os mais graves primeiro; entre iguais, a ordem que o servidor mandou. */
export const sortAlerts = (alerts: GithubAlert[]): GithubAlert[] => [...alerts].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

export type AlertRow = { kind: 'one'; alert: GithubAlert } | { kind: 'group'; code: 'executable' | 'binary'; level: GithubAlert['level']; files: string[] };

/** Só estes dois se repetem por arquivo (uma skill com 10 scripts daria 10 linhas iguais); a partir de 3, viram uma linha com a lista. */
const GROUPABLE = new Set(['executable', 'binary']);
const GROUP_FROM = 3;

/** Os alertas já ordenados (grave primeiro); os repetitivos por arquivo vêm juntos, na posição do primeiro. */
export function alertRows(alerts: GithubAlert[]): AlertRow[] {
  const sorted = sortAlerts(alerts);
  const rows: AlertRow[] = [];
  for (const a of sorted) {
    const files = GROUPABLE.has(a.code) && a.file ? sorted.filter((x) => x.code === a.code && x.file).map((x) => x.file as string) : [];
    if (files.length < GROUP_FROM) {
      rows.push({ kind: 'one', alert: a });
    } else if (!rows.some((r) => r.kind === 'group' && r.code === a.code)) {
      rows.push({ kind: 'group', code: a.code as 'executable' | 'binary', level: a.level, files });
    }
  }
  return rows;
}

/** Hooks ou comando que roda ao chamar a skill: instalar só com a ciência marcada. */
export const hasDanger = (alerts: GithubAlert[]): boolean => alerts.some((a) => a.level === 'danger');

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Nome da pasta de destino (o servidor confere de novo): a biblioteca é minúscula; a conta não aceita `synced`. */
export function folderNameOk(scope: GithubTarget['scope'], name: string): boolean {
  if (scope === 'library') return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
  if (scope === 'user' && name.toLowerCase() === 'synced') return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

export interface PatchLine {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
}

/** O patch unificado do servidor em linhas (`@@` cabeçalho de trecho, `+` entra, `-` sai, resto contexto). */
export function patchLines(patch: string): PatchLine[] {
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l): PatchLine => {
    if (l.startsWith('@@')) return { kind: 'hunk', text: l };
    if (l.startsWith('+')) return { kind: 'add', text: l.slice(1) };
    if (l.startsWith('-')) return { kind: 'del', text: l.slice(1) };
    return { kind: 'ctx', text: l.slice(1) };
  });
}

export function diffCounts(diff: GithubDiffItem[]): { added: number; removed: number; changed: number } {
  return {
    added: diff.filter((d) => d.status === 'added').length,
    removed: diff.filter((d) => d.status === 'removed').length,
    changed: diff.filter((d) => d.status === 'changed').length,
  };
}

/** Valor de uma chave do cabeçalho, em uma linha curta (`null` = não existia). */
export function frontmatterText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** O que o erro de uma ação do GitHub é: limite de consultas (com a hora em que volta), prévia velha, skill mexida aqui, ou outro. */
export type GithubErrorKind = { kind: 'rate'; clock: string | null } | { kind: 'changed' } | { kind: 'modified' } | { kind: 'other'; message: string };

export function githubError(e: unknown): GithubErrorKind | null {
  if (e instanceof ApiError) {
    if (e.status === 429) return { kind: 'rate', clock: resetClock(e.details.resetAt) };
    if (e.status === 409 && e.code === 'changed') return { kind: 'changed' };
    if (e.status === 409 && e.code === 'modified') return { kind: 'modified' };
  }
  // Navegador sem pareamento: a recusa vem sem texto (o aviso do App já explica), então aqui não há o que mostrar.
  const message = (e as Error).message;
  return message ? { kind: 'other', message } : null;
}

/** A frase de um erro do GitHub: o que a tela sabe explicar tem texto próprio; o resto é a mensagem do servidor. */
export function errorText(e: GithubErrorKind): string {
  switch (e.kind) {
    case 'rate':
      return e.clock ? t('gh.rateClock', { clock: e.clock }) : t('gh.rate');
    case 'changed':
      return t('gh.stale');
    case 'modified':
      return t('gh.modifiedWarn');
    default:
      return e.message;
  }
}

function resetClock(resetAt: unknown): string | null {
  const ms = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}
