// Skill marcada na ficha que a lista de skills não oferece (apagada ou renomeada, ou sincronizada da conta): a ficha continua
// mostrando a linha, para a pessoa poder desmarcar. Tudo por ref (`global:<nome>` / `project:<nome>`): o mesmo nome nos dois
// escopos são duas skills. A lista nunca oferece as sincronizadas; essas aparecem como são, sem acusar que sumiram.

import { formatSkillRef, parseSkillRef, type SkillCatalog } from './skillRefs';

/** As marcadas (já em ref) que a lista não oferece. */
export function goneSkills(marked: readonly string[], catalog: SkillCatalog): string[] {
  const offered = new Set(catalog.offered.map((o) => o.ref));
  return marked.filter((ref) => !offered.has(ref));
}

/**
 * Só dá para dizer "não existe mais" quando a skill não está no escopo dela: nem na pasta, nem entre as sincronizadas (essas
 * existem, só não são oferecidas). Projeto sem inventário lido: não dá para saber, então não acusa. Nome sem escopo (o
 * inventário não foi lido na hora de converter) pode ser de qualquer escopo: só acusa se o projeto foi lido e não tem.
 */
export function skillIsGone(ref: string, catalog: SkillCatalog): boolean {
  if (catalog.all.has(ref)) return false;
  const parsed = parseSkillRef(ref);
  if (parsed?.scope === 'global') return true;
  if (!parsed && (catalog.all.has(formatSkillRef('global', ref)) || catalog.all.has(formatSkillRef('project', ref)))) return false;
  return catalog.projectRead;
}
