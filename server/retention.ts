import type { StaffProfile, Task } from '../shared/model';

// Conversas que a retenção NUNCA arquiva, mesmo paradas além do prazo:
// - a última de cada ficha (o cartão do funcionário precisa de uma sessão para aparecer; ver layout.ts);
// - as ligadas a tarefa não concluída (a conversa da execução, a da revisão, a do deploy e a do gestor numa dúvida).

/** Os ids de sessão que não podem sair da lista pela retenção (o conjunto de um projeto). */
export function retainedSessionIds(staff: ReadonlyArray<Pick<StaffProfile, 'sessions'>>, tasks: ReadonlyArray<Task>): Set<string> {
  const keep = new Set<string>();
  for (const s of staff) {
    // A ordem da ficha é cronológica (a última é a mais recente; ver chatSpawn e index.ts).
    const last = s.sessions.at(-1);
    if (last) keep.add(last.id);
  }
  for (const t of tasks) {
    // Status desconhecido conta como não concluída: só `done` solta a proteção.
    if (t.status === 'done') continue;
    // Conversa do motor da ficha que ficou para trás (troca de motor) e a conversa do gestor em que a tarefa foi pedida.
    for (const id of [t.sessionId, t.review?.sessionId, t.deploy?.sessionId, t.question?.managerSession, t.fallback?.fromSession, t.requestedSession]) {
      if (id) keep.add(id);
    }
  }
  return keep;
}
