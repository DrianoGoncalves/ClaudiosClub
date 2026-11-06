import type { StaffProfile } from '../../../shared/model';

/** O que o guia (SPEC.md) pede a um funcionário: testar a compreensão, achar divergências ou escrever um rascunho. */
export type GuideAction = 'test' | 'drift' | 'draft';

/** Quem faz por padrão: o do topo do organograma (sem chefe na equipe); com vários, o primeiro. Sem ninguém no topo, o primeiro. */
export function defaultGuideStaff(staff: Pick<StaffProfile, 'id' | 'reportsTo'>[]): string | null {
  const ids = new Set(staff.map((s) => s.id));
  const top = staff.find((s) => !s.reportsTo.some((m) => m !== s.id && ids.has(m)));
  return (top ?? staff[0])?.id ?? null;
}
