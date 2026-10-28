import type { AppConfig, Project } from '../../../shared/model';

// Abas do quadro: "Todas", uma por empresa e "Sem empresa". A aba escolhida fica no navegador e no
// endereço (#acme), para dar para abrir duas janelas em empresas diferentes.

export const TAB_ALL = 'all';
export const TAB_NONE = 'none';
const TAB_KEY = 'myco.companyTab';

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
 * Empresa de cada projeto do quadro (id → empresa ou null). Uma worktree segue o projeto de onde
 * saiu, que é quem está na empresa.
 */
export function companyByProject(projects: Project[], config: AppConfig | null): Map<string, string | null> {
  const map = config?.projectCompanies ?? {};
  const byPath = new Map(projects.map((p) => [p.path.toLowerCase(), p.id]));
  const out = new Map<string, string | null>();
  for (const p of projects) {
    const owner = (p.worktreeOf && byPath.get(p.worktreeOf.toLowerCase())) || p.id;
    out.set(p.id, map[owner] ?? null);
  }
  return out;
}

/** O projeto aparece na aba? Aba de empresa que não existe mais vale como "Todas". */
export function inTab(tab: string, company: string | null | undefined, config: AppConfig | null): boolean {
  if (tab === TAB_ALL) return true;
  if (tab === TAB_NONE) return !company;
  if (!config?.companies.some((c) => c.id === tab)) return true;
  return company === tab;
}
