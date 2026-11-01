import { pathKey, worktreeParent } from './adapters/claude/paths';
import type { ProjectRef } from './adapters/claude/projects';
import { hasStaffFiles } from './staff/store';

// Quais dos projetos que o Claude Code conhece entram no quadro. O Claude Code lembra de toda pasta onde
// já rodou, e isso polui: no quadro entram só o demo, as pastas abertas pelo "Novo projeto" ou importadas
// (config.json → extraProjects) e os projetos que já têm equipe (`.myco/staff`). O resto o usuário importa.

export interface BoardRules {
  /** Pastas que entram sempre (o demo e as de `extraProjects`). */
  pinned: () => Promise<string[]>;
  /** O projeto tem fichas de equipe? Padrão: há arquivo de ficha em `.myco/staff`. */
  hasStaff?: (dir: string) => Promise<boolean>;
}

/**
 * Filtro dos projetos descobertos. Worktree (`.claude/worktrees/…`) entra se o projeto-pai entra, e só
 * por ele: a cópia do `.myco/staff` que o git leva para dentro da worktree não a promove sozinha.
 * Exceção: uma worktree que o próprio usuário pôs em `pinned` (abriu pelo "+ projeto") continua entrando.
 */
export function boardFilter(rules: BoardRules): (refs: ProjectRef[]) => Promise<ProjectRef[]> {
  const hasStaff = rules.hasStaff ?? hasStaffFiles;
  return async (refs) => {
    const pinned = new Set((await rules.pinned()).map(pathKey));
    const kept = new Set<string>();
    await Promise.all(
      refs
        .filter((r) => !worktreeParent(r.path))
        .map(async (r) => {
          if (pinned.has(pathKey(r.path)) || (await hasStaff(r.path))) kept.add(pathKey(r.path));
        }),
    );
    return refs.filter((r) => pinned.has(pathKey(r.path)) || kept.has(pathKey(worktreeParent(r.path) ?? r.path)));
  };
}
