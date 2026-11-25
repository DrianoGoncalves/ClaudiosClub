// Conversa parada fecha mais cedo quando falta memória. Cada conversa aberta segura o processo do Claude Code (~580 MB, fora os MCPs) até 15 min depois do último
// turno. Em 25/11/2026, com 7 abertas (4 paradas) numa máquina de 8 GB, o Windows paginava sem parar no HDD. Com a RAM livre abaixo do mínimo da config
// (`minFreeRamGb`, o mesmo da fila), a rodada do `reap` fecha a parada há mais tempo. A sessão fica no disco: a próxima mensagem reabre a conversa (~14 s no HDD),
// sem custo extra de tokens (o cache do prompt expira em minutos de qualquer jeito).

/** Conversa parada há menos que isso não fecha por memória: o dono pode estar lendo a resposta que acabou de chegar. */
export const MEMORY_PRESSURE_IDLE_MS = 2 * 60_000;

export interface ReapCandidate {
  sessionId: string;
  running: boolean;
  /** Turno em andamento, pergunta ou permissão sem resposta, ou tarefa em segundo plano: fechar interromperia. */
  working: boolean;
  lastActivity: number;
}

/** A conversa a fechar quando falta memória: aberta, parada há mais de `minIdleMs`, a parada há mais tempo primeiro; null se nenhuma pode sair. */
export function pickIdleForMemory<T extends ReapCandidate>(chats: Iterable<T>, now: number, minIdleMs = MEMORY_PRESSURE_IDLE_MS): T | null {
  let best: T | null = null;
  for (const c of chats) {
    if (!c.running || c.working || now - c.lastActivity < minIdleMs) continue;
    if (!best || c.lastActivity < best.lastActivity) best = c;
  }
  return best;
}

/** Memória agora: livre e o mínimo da config, em bytes. Null quando a regra está desligada (`minFreeRamGb` 0 ou o portão de recursos desligado). */
export type MemoryReading = { freeBytes: number; minBytes: number } | null;
