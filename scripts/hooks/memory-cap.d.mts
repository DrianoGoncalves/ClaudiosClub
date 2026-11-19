// Tipos de memory-cap.mjs (o servidor importa o .mjs; o hook roda ele direto, sem build).

export const MEMORY_INDEX_MAX_LINES: number;
export const MEMORY_INDEX_MAX_BYTES: number;
export const MEMORY_DETAIL_MAX_BYTES: number;

/** `index` = o índice `<id>.memory.md`; `detail` = um arquivo de `<id>.memory/`. */
export type MemoryKind = 'index' | 'detail';

export interface MemorySize {
  bytes: number;
  lines: number;
}

export type MemoryVerdict = { ok: true; over: boolean } | { ok: false; currentOver: boolean };

export function memoryMeasure(text: string): MemorySize;
export function memoryOver(kind: MemoryKind, m: MemorySize): boolean;
export function memoryLimitText(kind: MemoryKind): string;
export function memorySizeText(m: MemorySize): string;
export function memoryJudge(kind: MemoryKind, next: MemorySize, current: MemorySize | null): MemoryVerdict;
export function memoryRefusal(kind: MemoryKind, next: MemorySize, o: { currentOver: boolean; detailDir: string }): string;
