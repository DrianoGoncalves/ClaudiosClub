import type { ExtensionInfo, ExtensionPairing } from '../api';

// Regras da tela da extensão do Chrome (Configurações → Geral), sem React: o código de pareamento, o limite e o que mudou na lista.

/** Pareamentos ao mesmo tempo (MAX_EXTENSION_PAIRINGS em server/extension/tokens.ts): acima disso, o servidor recusa. */
export const MAX_PAIRINGS = 5;

/** Quanto o código de pareamento vale no servidor (CODE_TTL_MS): só para a tela não mostrar um código já vencido. */
export const CODE_TTL_MS = 5 * 60_000;

/** De quanto em quanto a tela relê os pareamentos enquanto mostra um código (a extensão pode parear a qualquer hora). */
export const PAIR_POLL_MS = 3000;

/** Segundos que faltam para o código vencer (0 = venceu). */
export function codeSecondsLeft(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

/** "4:32". */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** O pareamento que não estava na lista de antes (a extensão digitou o código); null se nada mudou. */
export function newPairing(beforeIds: readonly string[], now: readonly ExtensionPairing[]): ExtensionPairing | null {
  return now.find((p) => !beforeIds.includes(p.id)) ?? null;
}

/** Gerar código vale quando a extensão está nesta versão e ainda cabe um pareamento. */
export function canGenerate(info: ExtensionInfo | null): boolean {
  return !!info && info.available && info.pairings.length < MAX_PAIRINGS;
}

/** O servidor aceita no máximo 40 caracteres; o que a pessoa digita só perde os espaços das pontas. */
export const cleanLabel = (value: string): string => value.trim().slice(0, 40);

/** Nome do arquivo baixado (o mesmo do Content-Disposition do servidor). */
export const DOWNLOAD_NAME = 'claudios-club-extensao.zip';
