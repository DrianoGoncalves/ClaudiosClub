import type { StaffProfile } from '../../../shared/model';
import type { DirectoryPerson, DirectoryStaff, StaffRef } from '../api';

type HireSource = { projectId: string; staffId: string | null };

/**
 * O "+" do organograma foi solto: sobre funcionário de outro projeto = copiar para cá; o "+" de um
 * funcionário sobre colega do mesmo projeto = vínculo; no vazio (ou no próprio projeto) = opções de contratar.
 * A cópia vinda do "+" de um funcionário já entra subordinada a ele.
 */
export function hireDrop(from: HireSource, onto: HireSource | null):
  | { kind: 'copy'; fromProjectId: string; staffId: string; reportsTo: string[] }
  | { kind: 'link'; staffId: string }
  | { kind: 'options' } {
  if (onto?.staffId && onto.projectId !== from.projectId)
    return { kind: 'copy', fromProjectId: onto.projectId, staffId: onto.staffId, reportsTo: from.staffId ? [from.staffId] : [] };
  if (from.staffId && onto?.staffId && onto.staffId !== from.staffId) return { kind: 'link', staffId: onto.staffId };
  return { kind: 'options' };
}

/** A ficha do quadro no formato do índice da empresa (a confirmação de cópia não espera a lista). */
export const directoryPerson = (s: StaffProfile, projectName: string): DirectoryPerson => ({
  projectId: s.projectId,
  projectName,
  staffId: s.id,
  name: s.name,
  role: s.role,
  mission: s.mission,
  hasPortrait: !!s.portrait,
  updatedAt: s.updatedAt,
});

/** Corpo do POST da cópia: `reportsTo` só vai quando há chefe (do "+" do projeto, entra sem chefe). */
export const copyBody = (picked: DirectoryPerson, withMemory: boolean, reportsTo: string[]) => ({
  fromProjectId: picked.projectId,
  staffId: picked.staffId,
  withMemory,
  ...(reportsTo.length ? { reportsTo } : {}),
});

/** Sem acento e em minúsculas: "Gestão" acha "gestao". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Fichas que dá para copiar para este projeto: as dos outros projetos, filtradas pela busca
 * (cada palavra tem que estar no nome, no cargo ou no projeto), em ordem de nome.
 */
export function copyCandidates(people: DirectoryPerson[], projectId: string, query: string): DirectoryPerson[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return people
    .filter((p) => p.projectId !== projectId)
    .filter((p) => {
      const hay = fold(`${p.name} ${p.role} ${p.projectName}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.projectName.localeCompare(b.projectName));
}

// ---- RH: todas as fichas da empresa, com as cópias da mesma pessoa juntas ----

/** Servidor antigo (sem os campos novos) ou ficha antiga: sem vínculo, ativa, sem chefe. */
const personOf = (p: DirectoryStaff) => p.personId ?? null;
const isRef = (p: DirectoryStaff, ref: StaffRef) => p.projectId === ref.projectId && p.staffId === ref.staffId;
const byName = (a: DirectoryStaff, b: DirectoryStaff) => a.name.localeCompare(b.name) || a.projectName.localeCompare(b.projectName);

export interface HrGroup {
  /** `personId`, ou projeto/id da ficha sem vínculo. */
  key: string;
  personId: string | null;
  /** As fichas que passaram na busca e no filtro. */
  people: DirectoryStaff[];
  /** Quantas fichas a pessoa tem ao todo (mesmo as filtradas fora). */
  total: number;
}

/**
 * A lista do RH: cópias da mesma pessoa num grupo só, em ordem de nome. A busca (nome, cargo ou projeto) e o
 * filtro de projeto valem por ficha; o grupo aparece se sobrar alguma, e `total` continua contando todas.
 */
export function hrGroups(people: DirectoryStaff[], query: string, projectId: string | null): HrGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const groups = new Map<string, HrGroup>();
  for (const p of [...people].sort(byName)) {
    const personId = personOf(p);
    const key = personId ?? `${p.projectId}/${p.staffId}`;
    const group = groups.get(key) ?? { key, personId, people: [], total: 0 };
    group.total++;
    const hay = fold(`${p.name} ${p.role} ${p.projectName}`);
    if ((!projectId || p.projectId === projectId) && words.every((w) => hay.includes(w))) group.people.push(p);
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.people.length);
}

/** As outras fichas da mesma pessoa (para "aplicar também nas outras N cópias"). */
export function copiesOf(people: DirectoryStaff[], ref: StaffRef): DirectoryStaff[] {
  const me = people.find((p) => isRef(p, ref));
  const personId = me && personOf(me);
  return personId ? people.filter((p) => personOf(p) === personId && !isRef(p, ref)) : [];
}

/** Subordinados que ficam sem chefe se esta ficha sair: no mesmo projeto, ele é o único chefe deles. */
export function orphansOf(people: DirectoryStaff[], ref: StaffRef): DirectoryStaff[] {
  return people.filter((p) => {
    const bosses = p.reportsTo ?? [];
    return p.projectId === ref.projectId && bosses.length > 0 && bosses.every((id) => id === ref.staffId);
  });
}

/**
 * Com quem dá para ligar esta ficha: as de outros projetos que ainda não são a mesma pessoa (cada pessoa tem uma
 * ficha por projeto), filtradas pela busca, em ordem de nome.
 */
export function linkCandidates(people: DirectoryStaff[], ref: StaffRef, query: string): DirectoryStaff[] {
  const me = people.find((p) => isRef(p, ref));
  const personId = me && personOf(me);
  const words = fold(query).split(/\s+/).filter(Boolean);
  return people
    .filter((p) => p.projectId !== ref.projectId && (!personId || personOf(p) !== personId))
    .filter((p) => {
      const hay = fold(`${p.name} ${p.role} ${p.projectName}`);
      return words.every((w) => hay.includes(w));
    })
    .sort(byName);
}
