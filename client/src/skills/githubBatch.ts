import type { GithubAlert, GithubBatchItem, GithubBatchResult, GithubChoose, GithubPreview, GithubTarget } from '../api';
import { folderNameOk, githubError, hasDanger, resetClock, type GithubErrorKind } from './githubSkill';

// Regras puras de instalar várias skills de um link do GitHub: marcar na lista, a prévia de cada uma, quais entram no lote
// e o resultado por skill. A recusa de verdade é do servidor (cada item refaz as mesmas conferências da instalação de uma só).

/** Marca ou desmarca uma skill da lista (a ordem de marcação não importa: quem usa pede na ordem da lista). */
export const togglePick = (picks: string[], path: string): string[] => (picks.includes(path) ? picks.filter((p) => p !== path) : [...picks, path]);

/** "Selecionar todas": com todas marcadas, desmarca; com nenhuma ou só algumas, marca todas. */
export const togglePickAll = (all: string[], picks: string[]): string[] => (all.length > 0 && all.every((p) => picks.includes(p)) ? [] : [...all]);

/** Uma skill do lote depois da prévia: a prévia, ou o motivo de ela não ter vindo. */
export type BatchRow = { path: string; name: string; preview: GithubPreview; error?: undefined } | { path: string; name: string; preview?: undefined; error: GithubErrorKind };

/** O nome da pasta de destino vale neste escopo? Sem isso o servidor recusa o item; quem quer trocar o nome instala essa skill sozinha. */
export const rowNameOk = (scope: GithubTarget['scope'], row: BatchRow): boolean => !!row.preview && folderNameOk(scope, row.preview.name);

/** Nasce marcada a skill que dá para instalar e não tem alerta de perigo: essa só entra se o usuário marcar de novo. */
export function defaultInclude(scope: GithubTarget['scope'], rows: BatchRow[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((r) => [r.path, rowNameOk(scope, r) && !hasDanger(r.preview?.alerts ?? [])]));
}

/** Os alertas de todas as prévias (marcadas ou não), por nível: o perigo de uma desmarcada continua à vista. */
export function alertTotals(rows: BatchRow[]): Record<GithubAlert['level'], number> {
  const totals = { danger: 0, warn: 0, info: 0 };
  for (const r of rows) for (const a of r.preview?.alerts ?? []) totals[a.level] += 1;
  return totals;
}

/** O nível mais grave de uma lista de alertas (null = sem alerta): o selo da linha do acordeão. */
export function worstLevel(alerts: GithubAlert[]): GithubAlert['level'] | null {
  return (['danger', 'warn', 'info'] as const).find((l) => alerts.some((a) => a.level === l)) ?? null;
}

/**
 * A prévia de cada skill marcada, uma depois da outra (o servidor guarda a árvore e os arquivos em cache, então a 2ª em diante quase não gasta
 * consulta ao GitHub). Falha de uma não para as outras; o limite de consultas para: as que faltam ficam com o aviso do limite, sem buscar.
 * Devolve null quando a recusa vem sem texto (navegador sem pareamento: vale para todas, o aviso do App explica e não há o que listar).
 */
export async function previewRows(
  skills: Array<{ path: string; name: string }>,
  fetchPreview: (path: string) => Promise<GithubPreview | GithubChoose>,
  notSkill: string,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchRow[] | null> {
  const rows: BatchRow[] = [];
  let limit: GithubErrorKind | null = null;
  onProgress?.(0, skills.length);
  for (const s of skills) {
    if (limit) {
      rows.push({ path: s.path, name: s.name, error: limit });
      continue;
    }
    try {
      const res = await fetchPreview(s.path);
      rows.push(res.kind === 'preview' ? { path: s.path, name: res.name, preview: res } : { path: s.path, name: s.name, error: { kind: 'other', message: notSkill } });
    } catch (e) {
      const err = githubError(e);
      if (!err) return null;
      rows.push({ path: s.path, name: s.name, error: err });
      if (err.kind === 'rate') limit = err;
    }
    onProgress?.(rows.length, skills.length);
  }
  return rows;
}

/** O que vai para o servidor: só a skill marcada que dá para instalar (o commit e o digest são os da prévia dela). */
export function batchItems(scope: GithubTarget['scope'], rows: BatchRow[], include: Record<string, boolean>): GithubBatchItem[] {
  const items: GithubBatchItem[] = [];
  for (const r of rows) {
    if (r.preview && include[r.path] && rowNameOk(scope, r)) {
      const { source, digest, name } = r.preview;
      items.push({ path: source.path, ref: source.ref, sha: source.sha, digest, name });
    }
  }
  return items;
}

/** Quantas skills com alerta de perigo estão fora do lote (desmarcadas, ou com nome que não vale no escopo): a nota do topo só vale enquanto houver alguma. */
export const dangerOutCount = (scope: GithubTarget['scope'], rows: BatchRow[], include: Record<string, boolean>): number =>
  rows.filter((r) => r.preview && hasDanger(r.preview.alerts) && !(include[r.path] && rowNameOk(scope, r))).length;

/** O resultado de uma skill do lote, para a tela: instalou (com o commit) ou falhou (com o motivo). */
export type BatchOutcome = { path: string; name: string; ok: true; sha: string } | { path: string; name: string; ok: false; error: GithubErrorKind };

/** A falha de um item como a tela explica: prévia velha, skill mexida e limite do GitHub têm texto próprio; o resto é a frase do servidor. */
export function batchErrorKind(r: Extract<GithubBatchResult, { status: 'error' }>): GithubErrorKind {
  if (r.code === 'changed') return { kind: 'changed' };
  if (r.code === 'modified') return { kind: 'modified' };
  if (r.code === 'rate-limited') return { kind: 'rate', clock: resetClock(r.resetAt) };
  return { kind: 'other', message: r.error };
}

/** Um resultado por item enviado, na ordem em que foram enviados; item sem resposta do servidor aparece como falha (não some em silêncio). */
export function batchOutcomes(items: GithubBatchItem[], results: GithubBatchResult[], missing: string): BatchOutcome[] {
  return items.map((item): BatchOutcome => {
    const r = results.find((x) => x.path === item.path);
    if (r?.status === 'installed') return { path: item.path, name: r.name, ok: true, sha: r.sha };
    return { path: item.path, name: item.name, ok: false, error: r ? batchErrorKind(r) : { kind: 'other', message: missing } };
  });
}

/** O envio do lote: os resultados por skill (e se alguma instalou, para quem chamou reler a lista) ou o erro do envio, que fica na prévia com o motivo. */
export type BatchRun = { ok: true; outcomes: BatchOutcome[]; installed: boolean } | { ok: false; error: GithubErrorKind | null };

/** Envia o lote. Rede caída ou recusa do servidor (corpo inteiro) não perde a prévia: volta como `error`; a falha de um item é `outcomes`, não `error`. */
export async function runBatch(items: GithubBatchItem[], send: (items: GithubBatchItem[]) => Promise<{ results: GithubBatchResult[] }>, missing: string): Promise<BatchRun> {
  try {
    const { results } = await send(items);
    return { ok: true, outcomes: batchOutcomes(items, results, missing), installed: results.some((r) => r.status === 'installed') };
  } catch (e) {
    return { ok: false, error: githubError(e) };
  }
}

/** Marcadas ao voltar à lista depois do lote: só as que falharam (as instaladas já existem; marcar de novo daria "já existe"). */
export const retryPicks = (outcomes: BatchOutcome[]): string[] => outcomes.filter((o) => !o.ok).map((o) => o.path);
