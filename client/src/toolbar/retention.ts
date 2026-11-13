import type { RetentionPreview } from '../../../shared/model';

// Conversas antigas (Config): limites e regras do servidor (server/config.ts, server/retentionSweep.ts), para o campo já gravar um valor aceito.

export const RETENTION_DAYS_MAX = 365;

/** Inteiro de 0 (desligado) a 365. Texto vazio ou inválido = null (o campo volta ao valor salvo). */
export function normalizeRetentionDays(raw: string): number | null {
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) return null;
  return Math.min(RETENTION_DAYS_MAX, Math.max(0, Math.round(n)));
}

/** Com os dois prazos ligados, apagar tem de passar de arquivar: o servidor recusa o contrário. */
export function retentionOrderBroken(archiveAfterDays: number, deleteAfterDays: number): boolean {
  return archiveAfterDays > 0 && deleteAfterDays > 0 && deleteAfterDays <= archiveAfterDays;
}

/** A prévia só vale para o prazo com que foi feita: mudou o prazo, é preciso ver de novo antes de ligar. */
export function previewFor(preview: RetentionPreview | null, deleteAfterDays: number): RetentionPreview | null {
  return preview && deleteAfterDays > 0 && preview.deleteAfterDays === deleteAfterDays ? preview : null;
}

/** Total da prévia, dos dois motores. */
export function previewTotal(preview: Pick<RetentionPreview, 'claude' | 'codex'>): { count: number; bytes: number } {
  return { count: preview.claude.count + preview.codex.count, bytes: preview.claude.bytes + preview.codex.bytes };
}

/** Projetos que a prévia não conseguiu conferir; servidor sem o campo = nenhum. */
export function skippedProjects(preview: Pick<RetentionPreview, 'skipped'> | { skipped?: undefined }): string[] {
  return Array.isArray(preview.skipped) ? preview.skipped.filter((x) => typeof x === 'string' && x !== '') : [];
}
