// Limites do teto por turno: os mesmos do servidor (server/config.ts), para o campo já gravar um valor aceito.

export const TURN_TOOLS_MAX = 100000;
export const TURN_MINUTES_MAX = 1440;

/** Inteiro de 0 (desligado) até `max`. Texto vazio ou inválido = null (volta ao valor salvo). */
function normalizeCap(raw: string, max: number): number | null {
  const text = raw.trim();
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) return null;
  return Math.min(max, Math.max(0, Math.round(n)));
}

/** Teto de ferramentas por turno: 0 desliga, até 100000. */
export const normalizeTurnTools = (raw: string) => normalizeCap(raw, TURN_TOOLS_MAX);

/** Teto de minutos por turno: 0 desliga, até 1440 (24 h). */
export const normalizeTurnMinutes = (raw: string) => normalizeCap(raw, TURN_MINUTES_MAX);
