// Limites do gate de recursos da fila: os mesmos do servidor (server/config.ts), para o campo já gravar um valor aceito.

export const RAM_GB_MIN = 0.5;
export const RAM_GB_MAX = 64;
export const MAX_CHATS_MAX = 50;

/** RAM livre mínima em GB: 0 desliga; de 0,5 a 64, com uma casa. Texto vazio ou inválido = null (volta ao valor salvo). */
export function normalizeRamGb(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.min(RAM_GB_MAX, Math.max(RAM_GB_MIN, Math.round(n * 10) / 10));
}

/** Teto de conversas: inteiro de 0 (sem teto) a 50. Texto vazio ou inválido = null. */
export function normalizeMaxChats(raw: string): number | null {
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) return null;
  return Math.min(MAX_CHATS_MAX, Math.max(0, Math.round(n)));
}
