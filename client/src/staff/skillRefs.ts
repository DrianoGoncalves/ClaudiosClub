// Skills da ficha com escopo, como o servidor grava (server/skillAccess.ts): `global:<nome>` (a Global: conta e sincronizadas) e
// `project:<nome>` (a do projeto). Ficha antiga guarda só o nome; aqui ele é reconhecido pela mesma regra do servidor.

import type { Skill } from '../../../shared/model';
import type { MsgKey } from '../i18n';

export type SkillScopeName = 'global' | 'project';

export const SKILL_SCOPE_LABEL = { global: 'staff.skillScopeGlobal', project: 'staff.skillScopeProject' } as const satisfies Record<SkillScopeName, MsgKey>;

/** Uma skill que existe agora, no escopo dela. `synced`: sincronizada da conta (Global; a lista não a oferece, mas ela existe). */
export interface SkillOption {
  ref: string;
  scope: SkillScopeName;
  name: string;
  synced: boolean;
}

/** O que existe agora (para dizer o que a ficha pode marcar e o que sumiu). `projectRead`: o inventário do projeto foi lido. */
export interface SkillCatalog {
  /** Todas as que existem, as sincronizadas também. */
  all: Map<string, SkillOption>;
  /** As que a lista oferece (sem as sincronizadas), por nome e Global antes de Projeto. */
  offered: SkillOption[];
  projectRead: boolean;
  /** Os nomes por escopo, para converter o nome antigo (sem escopo). */
  known: { globalNames: string[]; projectNames: string[] };
}

export const formatSkillRef = (scope: SkillScopeName, name: string): string => `${scope}:${name}`;

/** Já tem escopo (ref), mesmo que o nome não exista. */
export const isSkillRef = (s: string): boolean => s.startsWith('global:') || s.startsWith('project:');

/** O escopo e o nome de uma ref; `null` para o nome antigo, sem escopo. */
export function parseSkillRef(raw: string): { scope: SkillScopeName; name: string } | null {
  if (!isSkillRef(raw)) return null;
  const i = raw.indexOf(':');
  return { scope: raw.slice(0, i) as SkillScopeName, name: raw.slice(i + 1) };
}

/** O nome sem o escopo (o nome antigo já é só o nome). */
export const skillName = (raw: string): string => parseSkillRef(raw)?.name ?? raw;

/**
 * Monta o catálogo: `project` = skills da pasta do projeto (`undefined`: o inventário não foi lido), `user` = as da conta e as
 * sincronizadas, que juntas são a Global.
 */
export function skillCatalog(project: readonly Pick<Skill, 'name'>[] | undefined, user: readonly Pick<Skill, 'name' | 'scope'>[]): SkillCatalog {
  const all = new Map<string, SkillOption>();
  const add = (scope: SkillScopeName, name: string, synced: boolean) => {
    const ref = formatSkillRef(scope, name);
    if (!all.has(ref)) all.set(ref, { ref, scope, name, synced });
  };
  for (const s of user) add('global', s.name, s.scope === 'synced');
  for (const s of project ?? []) add('project', s.name, false);
  const options = [...all.values()];
  const offered = options
    .filter((o) => !o.synced)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope === b.scope ? 0 : a.scope === 'global' ? -1 : 1));
  return {
    all,
    offered,
    projectRead: project !== undefined,
    known: {
      globalNames: options.filter((o) => o.scope === 'global').map((o) => o.name),
      projectNames: options.filter((o) => o.scope === 'project').map((o) => o.name),
    },
  };
}

/**
 * Nome antigo: Global se existe lá; senão Projeto, se existe lá; senão Global (a ficha mostra que não existe). Igual ao servidor.
 * Sem o inventário do projeto lido não dá para saber se o nome é dele: fica como está e o servidor converte ao salvar.
 */
export function resolveLegacySkill(name: string, catalog: SkillCatalog): string {
  if (catalog.known.globalNames.includes(name)) return formatSkillRef('global', name);
  if (catalog.known.projectNames.includes(name)) return formatSkillRef('project', name);
  return catalog.projectRead ? formatSkillRef('global', name) : name;
}

/** A lista com os nomes antigos convertidos em ref; as refs ficam como estão e o repetido vira um só. */
export function normalizeSkills(skills: readonly string[], catalog: SkillCatalog): string[] {
  const out: string[] = [];
  for (const s of skills) {
    const ref = isSkillRef(s) ? s : resolveLegacySkill(s, catalog);
    if (!out.includes(ref)) out.push(ref);
  }
  return out;
}

/** As skills de um cargo (só nomes) somadas às já marcadas: entram as que a lista oferece, cada uma na ref do escopo dela. */
export function templateSkills(roleSkills: readonly string[], marked: readonly string[], catalog: SkillCatalog): string[] {
  const offered = new Set(catalog.offered.map((o) => o.ref));
  return [...new Set([...marked, ...normalizeSkills(roleSkills, catalog).filter((ref) => offered.has(ref))])];
}

/** O nome de cada skill para mostrar; o mesmo nome nos dois escopos leva o escopo ao lado, para as duas não parecerem a mesma. */
export function skillLabels(skills: readonly string[], scopeLabel: (scope: SkillScopeName) => string): string[] {
  const count = new Map<string, number>();
  for (const s of skills) count.set(skillName(s), (count.get(skillName(s)) ?? 0) + 1);
  return skills.map((s) => {
    const ref = parseSkillRef(s);
    return ref && (count.get(ref.name) ?? 0) > 1 ? `${ref.name} (${scopeLabel(ref.scope)})` : skillName(s);
  });
}
