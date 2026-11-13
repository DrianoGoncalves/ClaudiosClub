// Conversas antigas no seletor do funcionário: a retenção (server/retention.ts) tira da lista do quadro a conversa parada há mais de
// `archiveAfterDays`, mas a ficha (`staff.sessions`) segue com todas. O seletor lista só as do quadro, até alguém pedir "Mostrar antigas".

const DAY_MS = 86_400_000;

/**
 * Ids das conversas da ficha que a retenção deixou fora da lista: o quadro não as traz (`listed`) e elas começaram antes do prazo
 * (a que ainda não gravou nada não está no quadro, mas é recente). A última da ficha nunca sai, como no servidor. Sem prazo (0), nada sai.
 */
export function leftOutByRetention(
  sessions: ReadonlyArray<{ id: string; startedAt: string }>,
  listed: ReadonlySet<string>,
  archiveAfterDays: number,
  now = Date.now(),
): Set<string> {
  const out = new Set<string>();
  if (!(archiveAfterDays > 0)) return out;
  const cutoff = now - archiveAfterDays * DAY_MS;
  const last = sessions.at(-1)?.id;
  for (const s of sessions) {
    if (s.id === last || listed.has(s.id)) continue;
    const started = Date.parse(s.startedAt);
    if (Number.isFinite(started) && started < cutoff) out.add(s.id);
  }
  return out;
}
