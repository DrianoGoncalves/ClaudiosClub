import type { LiveSession, StaffProfile } from '../../../shared/model';

/** Mais ativo primeiro: trabalhando, esperando, parado; sem status por último. */
const RANK: Record<string, number> = { busy: 3, waiting: 2, idle: 1 };

/** Uma linha do hover de "ao vivo": quem é, o status mais ativo entre as conversas abertas dele e quantas são. */
export type LiveLine = { name: string; status: string | null; conversations: number };

/**
 * Quem está ao vivo na sala, uma linha por funcionário: as conversas abertas dele (cada uma é um processo)
 * viram uma só, com o status da mais ativa. Conversa sem ficha continua uma linha por conversa.
 * O dono vem da ficha (`sessions`); sem isso, do nome da conversa, que é o do funcionário.
 */
export function liveLines(live: LiveSession[], staff: StaffProfile[]): LiveLine[] {
  const ownerOf = new Map<string, StaffProfile>();
  for (const st of staff) for (const s of st.sessions) ownerOf.set(s.id, st);
  const byName = new Map(staff.map((st) => [st.name, st]));

  const lines = new Map<string, LiveLine & { ids: Set<string> }>();
  for (const s of live) {
    const owner = ownerOf.get(s.sessionId) ?? (s.name ? byName.get(s.name) : undefined);
    const key = owner ? `staff:${owner.id}` : `session:${s.sessionId}`;
    const line = lines.get(key) ?? { name: owner?.name ?? s.name ?? s.sessionId.slice(0, 8), status: null, conversations: 0, ids: new Set<string>() };
    // O mesmo sessionId com dois processos vivos (retomada) é uma conversa só.
    if (!line.ids.has(s.sessionId)) {
      line.ids.add(s.sessionId);
      line.conversations++;
    }
    if (line.status === null || (RANK[s.status ?? ''] ?? 0) > (RANK[line.status] ?? 0)) line.status = s.status ?? line.status;
    lines.set(key, line);
  }
  return [...lines.values()].map(({ name, status, conversations }) => ({ name, status, conversations }));
}
