import type { StaffProfile } from '../../../shared/model';
import type { DirectoryPerson } from '../api';

type HireSource = { projectId: string; staffId: string | null };

/**
 * O "+" do organograma foi solto: sobre funcionário de outro projeto = copiar para cá; o "+" de um
 * funcionário sobre colega do mesmo projeto = vínculo; no vazio (ou no próprio projeto) = opções de contratar.
 */
export function hireDrop(from: HireSource, onto: HireSource | null):
  | { kind: 'copy'; fromProjectId: string; staffId: string }
  | { kind: 'link'; staffId: string }
  | { kind: 'options' } {
  if (onto?.staffId && onto.projectId !== from.projectId) return { kind: 'copy', fromProjectId: onto.projectId, staffId: onto.staffId };
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
