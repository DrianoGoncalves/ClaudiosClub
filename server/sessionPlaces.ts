import path from 'node:path';
import type { LiveSession, Project, StaffProfile } from '../shared/model';
import { encodeProjectDir, pathKey } from './adapters/claude/paths';

/**
 * Dono (funcionário/projeto) e nome de cada sessão. `hidden` = a sessão não aparece na caixa nem nos
 * avisos: está arquivada (ela ou o projeto) ou é de um projeto que o Claude Code conhece e está fora do
 * quadro (`offBoard`: os ids dele). Sessão de projeto desconhecido continua aparecendo.
 */
export function sessionPlaces(projects: Project[], staffList: StaffProfile[], archived: ReadonlySet<string>, offBoard: ReadonlySet<string> = new Set()) {
  const parents = mycoWorktreeParents(projects);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const byPath = new Map(projects.map((p) => [pathKey(p.path), p.id]));
  const owner = new Map<string, { projectId: string; staffId: string; name: string }>();
  for (const s of staffList) for (const ss of s.sessions) owner.set(ss.id, { projectId: s.projectId, staffId: s.id, name: s.name });

  const where = (sessionId: string, l?: LiveSession) => {
    const own = owner.get(sessionId);
    let projectId = own?.projectId ?? (l?.cwd ? (byPath.get(pathKey(l.cwd)) ?? encodeProjectDir(l.cwd)) : '');
    projectId = parents.get(projectId) ?? projectId;
    return {
      projectId,
      projectName: projectName.get(projectId) ?? '',
      sessionId,
      staffId: own?.staffId ?? null,
      name: own?.name ?? l?.name?.trim() ?? `sessão ${sessionId.slice(0, 8)}`,
    };
  };
  const hidden = (w: { projectId: string; staffId: string | null; sessionId: string }) =>
    offBoard.has(w.projectId) ||
    archived.has(w.projectId) ||
    archived.has(w.sessionId) ||
    (w.staffId !== null && archived.has(`staff:${w.staffId}`));
  return { where, hidden };
}

/** Worktrees criadas pelo Claudio’s Club (…/.claude/worktrees/myco-<ficha>) → id do projeto principal. */
export function mycoWorktreeParents(projects: Project[]): Map<string, string> {
  const byPath = new Map(projects.map((p) => [pathKey(p.path), p.id]));
  const out = new Map<string, string>();
  for (const p of projects) {
    if (!p.worktreeOf || !path.basename(p.path).startsWith('myco-')) continue;
    const parent = byPath.get(pathKey(p.worktreeOf));
    if (parent) out.set(p.id, parent);
  }
  return out;
}
