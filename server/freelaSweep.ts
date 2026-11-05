import type { Project, StaffProfile } from '../shared/model';
import type { ToolAdapter } from './adapters/types';
import { autoArchiveFreelas, readConfig } from './config';

const DAY_MS = 86_400_000;

export interface FreelaSweepDeps {
  adapter: Pick<ToolAdapter, 'listProjects' | 'getProjectSessions' | 'listLiveSessions'>;
  staff: { listAll: (projects: Project[]) => Promise<StaffProfile[]> };
  /** Arquivo de config (os testes trocam). */
  configFile?: string;
}

/**
 * Freela = conversa sem ficha (o cartão "fantasma" do quadro: nenhuma ficha lista a sessão). Se ela não
 * está aberta agora e parou há mais de `freelaArchiveDays` dias, vai para `archived.sessions` (some do
 * quadro, aparece em "mostrar arquivados", dá para desarquivar). Quem desarquiva só é arquivado de novo
 * depois de atividade nova (ver `freelaAutoArchived`). 0 dias = desligado. Devolve os ids arquivados.
 */
export async function sweepFreelas(deps: FreelaSweepDeps, now = new Date()): Promise<string[]> {
  const config = await readConfig(deps.configFile);
  const days = config.freelaArchiveDays;
  if (days <= 0) return [];

  const projects = await deps.adapter.listProjects();
  const [staffList, live] = await Promise.all([deps.staff.listAll(projects), deps.adapter.listLiveSessions()]);
  const owned = new Set(staffList.flatMap((s) => s.sessions.map((x) => x.id)));
  const alive = new Set(live.filter((l) => l.alive).map((l) => l.sessionId));
  const archived = new Set(config.archived.sessions);
  const archivedProjects = new Set(config.archived.projects);
  const limit = now.getTime() - days * DAY_MS;

  const existing = new Set<string>();
  let complete = true;
  const found: Array<{ id: string; updatedAt: string }> = [];
  for (const p of projects) {
    const sessions = await deps.adapter.getProjectSessions(p.id).catch(() => null);
    if (!sessions) {
      complete = false; // não deu para listar: o controle não pode esquecer ninguém desse projeto
      continue;
    }
    for (const s of sessions) {
      existing.add(s.id);
      if (owned.has(s.id) || alive.has(s.id) || s.live?.alive) continue;
      if (archived.has(s.id) || archivedProjects.has(p.id)) continue;
      // Desarquivada por você: espera atividade nova.
      if (config.freelaAutoArchived[s.id] === s.updatedAt) continue;
      const at = Date.parse(s.updatedAt);
      if (Number.isNaN(at) || at >= limit) continue;
      found.push({ id: s.id, updatedAt: s.updatedAt });
    }
  }
  const after = await autoArchiveFreelas(found, complete ? existing : null, deps.configFile);
  const nowArchived = new Set(after.archived.sessions);
  return found.filter((f) => nowArchived.has(f.id)).map((f) => f.id);
}
