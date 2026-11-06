import type { StaffProfile } from '../../../shared/model';
import type { PERSON_FIELDS } from '../../../shared/person';
import type { DirectoryPerson, DirectoryStaff, StaffRef } from '../api';
import type { MsgKey } from '../i18n';

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
const byName = (a: DirectoryStaff, b: DirectoryStaff) => a.name.localeCompare(b.name) || a.projectName.localeCompare(b.projectName);

export interface HrGroup {
  /** `personId`, ou projeto/id da ficha sem vínculo. */
  key: string;
  personId: string | null;
  /** As fichas que passaram na busca e no filtro. */
  people: DirectoryStaff[];
  /** Todas as fichas da pessoa (uma por projeto), mesmo as filtradas fora. */
  all: DirectoryStaff[];
  /** Quantas fichas a pessoa tem ao todo (mesmo as filtradas fora). */
  total: number;
}

/** A pessoa a que a ficha pertence: o `personId`, ou ela mesma quando não tem vínculo. */
export const personKey = (p: DirectoryStaff) => personOf(p) ?? `${p.projectId}/${p.staffId}`;

/**
 * A lista do RH: cópias da mesma pessoa num grupo só (uma linha por pessoa), em ordem de nome. A busca (nome, cargo ou
 * projeto) e o filtro de projeto valem por ficha; o grupo aparece se sobrar alguma, e `all`/`total` continuam com todas.
 */
export function hrGroups(people: DirectoryStaff[], query: string, projectId: string | null): HrGroup[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const groups = new Map<string, HrGroup>();
  for (const p of [...people].sort(byName)) {
    const key = personKey(p);
    const group = groups.get(key) ?? { key, personId: personOf(p), people: [], all: [], total: 0 };
    group.total++;
    group.all.push(p);
    const hay = fold(`${p.name} ${p.role} ${p.projectName}`);
    if ((!projectId || p.projectId === projectId) && words.every((w) => hay.includes(w))) group.people.push(p);
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.people.length);
}

/** Subordinados que ficam sem chefe se esta ficha sair: no mesmo projeto, ele é o único chefe deles. */
export function orphansOf(people: DirectoryStaff[], ref: StaffRef): DirectoryStaff[] {
  return people.filter((p) => {
    const bosses = p.reportsTo ?? [];
    return p.projectId === ref.projectId && bosses.length > 0 && bosses.every((id) => id === ref.staffId);
  });
}

/**
 * Com quem dá para ligar esta pessoa: as fichas de quem ainda não é ela e não tem ficha em nenhum projeto dela (cada
 * pessoa tem uma ficha por projeto), filtradas pela busca, em ordem de nome.
 */
export function linkTargets(people: DirectoryStaff[], group: Pick<HrGroup, 'key' | 'all'>, query: string): DirectoryStaff[] {
  const mine = new Set(group.all.map((p) => p.projectId));
  const clash = new Set(people.filter((p) => mine.has(p.projectId)).map(personKey));
  const words = fold(query).split(/\s+/).filter(Boolean);
  return people
    .filter((p) => !clash.has(personKey(p)))
    .filter((p) => {
      const hay = fold(`${p.name} ${p.role} ${p.projectName}`);
      return words.every((w) => hay.includes(w));
    })
    .sort(byName);
}

/** As fichas da mesma pessoa que esta (ela inclusive), em ordem de projeto. */
export const personGroup = (people: DirectoryStaff[], of: DirectoryStaff): DirectoryStaff[] =>
  people.filter((p) => personKey(p) === personKey(of)).sort(byName);

/**
 * Fichas que provavelmente são a mesma pessoa: mesmo nome (sem acento nem caixa), sem vínculo com esta, em projetos
 * que ela ainda não tem. Vem um grupo por pessoa (as fichas dela juntas); dois candidatos no mesmo projeto não entram
 * os dois, para não juntar duas fichas de um projeto na mesma pessoa.
 */
export function sameNameGroups(people: DirectoryStaff[], group: Pick<HrGroup, 'key' | 'all'>): DirectoryStaff[][] {
  const name = fold(group.all[0]?.name.trim() ?? '');
  if (!name) return [];
  const taken = new Set(group.all.map((p) => p.projectId));
  const others = new Map<string, DirectoryStaff[]>();
  for (const p of [...people].sort(byName)) {
    const key = personKey(p);
    if (key !== group.key) others.set(key, [...(others.get(key) ?? []), p]);
  }
  const out: DirectoryStaff[][] = [];
  for (const g of others.values()) {
    if (!g.some((p) => fold(p.name.trim()) === name) || g.some((p) => taken.has(p.projectId))) continue;
    g.forEach((p) => taken.add(p.projectId));
    out.push(g);
  }
  return out;
}

// ---- Campos da pessoa: o que a edição de uma ficha leva às outras ----

export type PersonField = (typeof PERSON_FIELDS)[number];
export type PersonValues = Pick<StaffProfile, PersonField>;

/** O rótulo de cada campo da pessoa (no aviso de "vai sobrescrever"). */
export const PERSON_FIELD_LABEL: Record<PersonField, MsgKey> = {
  name: 'hr.fieldName',
  role: 'hr.fieldRole',
  mission: 'hr.fieldMission',
  doneWhen: 'hr.fieldDoneWhen',
  rules: 'hr.fieldRules',
  model: 'hr.fieldModel',
  effort: 'hr.fieldEffort',
  playbook: 'hr.fieldPlaybook',
};

/** O valor como o servidor compara: lista vira texto, vazio e null são o mesmo, espaço nas pontas não conta. */
const plain = (p: PersonValues, field: PersonField): string => {
  const v = p[field];
  return Array.isArray(v) ? v.map((l) => l.trim()).filter(Boolean).join('\n') : (v ?? '').trim();
};

/** Em quais campos da pessoa as `others` diferem de `mine`, com as fichas que diferem em cada um. */
export function differingFields<T extends PersonValues>(mine: PersonValues, others: T[]): Array<{ field: PersonField; others: T[] }> {
  const out: Array<{ field: PersonField; others: T[] }> = [];
  for (const field of PERSON_FIELD_ORDER) {
    const differ = others.filter((o) => plain(o, field) !== plain(mine, field));
    if (differ.length) out.push({ field, others: differ });
  }
  return out;
}

/** Os campos da pessoa em que as fichas não são todas iguais. */
export function fieldsThatDiffer(profiles: PersonValues[]): PersonField[] {
  const [first, ...rest] = profiles;
  return first ? differingFields(first, rest).map((d) => d.field) : [];
}

const PERSON_FIELD_ORDER = Object.keys(PERSON_FIELD_LABEL) as PersonField[];