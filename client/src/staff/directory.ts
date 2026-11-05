import type { DirectoryPerson } from '../api';

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
