import type { AppConfig, Project } from '../../../shared/model';

// Abas do quadro: "Todos", um por workspace e "Sem workspace". Você agrupa os projetos como quiser
// (cliente, área, pessoal…). A aba escolhida fica no navegador e no endereço (#cliente-x), para dar
// para abrir duas janelas em workspaces diferentes.

export const TAB_ALL = 'all';
export const TAB_NONE = 'none';
const TAB_KEY = 'myco.workspaceTab';

export function readTab(): string {
  const hash = decodeURIComponent(window.location.hash.slice(1));
  if (hash) return hash;
  try {
    return localStorage.getItem(TAB_KEY) ?? TAB_ALL;
  } catch {
    return TAB_ALL;
  }
}

export function writeTab(tab: string) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // armazenamento indisponível: vale só nesta aba
  }
  const url = tab === TAB_ALL ? window.location.pathname + window.location.search : `#${encodeURIComponent(tab)}`;
  window.history.replaceState(null, '', url);
}

/**
 * Workspace de cada projeto do quadro (id → workspace ou null). Uma worktree segue o projeto de
 * onde saiu, que é quem está no workspace.
 */
export function workspaceByProject(projects: Project[], config: AppConfig | null): Map<string, string | null> {
  const map = config?.projectWorkspaces ?? {};
  const byPath = new Map(projects.map((p) => [p.path.toLowerCase(), p.id]));
  const out = new Map<string, string | null>();
  for (const p of projects) {
    const owner = (p.worktreeOf && byPath.get(p.worktreeOf.toLowerCase())) || p.id;
    out.set(p.id, map[owner] ?? null);
  }
  return out;
}

/** O projeto aparece na aba? Aba de workspace que não existe mais vale como "Todos". */
export function inTab(tab: string, workspace: string | null | undefined, config: AppConfig | null): boolean {
  if (tab === TAB_ALL) return true;
  if (tab === TAB_NONE) return !workspace;
  if (!config?.workspaces.some((w) => w.id === tab)) return true;
  return workspace === tab;
}
