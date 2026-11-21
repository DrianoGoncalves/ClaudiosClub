import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../../../shared/model';
import { api } from '../api';
import { pollVisible } from '../usePoll';

// As tarefas de alguns projetos, para quem não é o quadro e precisa de um dado delas: a conversa (o balão do follow-up sabe se a tarefa de origem já está Finalizada, qual é o
// responsável dela e o texto inteiro do follow-up) e a caixa. Lê de novo de tempos em tempos e sob demanda (`reload`, depois de uma decisão); projeto que falha fica como estava.
// Um projeto só entra em `byProject` quando a leitura deu certo: quem decide um follow-up espera por isso (`byProject.has`), porque com a tarefa desconhecida erraria (sem "Finalizado", texto
// cortado). Leitura que falha deixa o projeto desconhecido, e as saídas seguem desligadas até uma leitura dar certo (a de 20 em 20 s tenta de novo).

const EVERY_MS = 20_000;

/** A tarefa `taskId` do projeto, se já foi lida. */
export const taskIn = (byProject: ReadonlyMap<string, Task[]>, projectId: string, taskId: string): Task | null => byProject.get(projectId)?.find((x) => x.id === taskId) ?? null;

/** O que a leitura deixa em `byProject`: só os projetos que leram (`null` = falhou). Quem falhou fica como estava: sem leitura antes, segue desconhecido (as saídas do follow-up ficam desligadas). */
export function mergeRead(prev: ReadonlyMap<string, Task[]>, got: readonly (readonly [string, Task[] | null])[]): Map<string, Task[]> {
  const next = new Map(prev);
  for (const [id, tasks] of got) if (tasks) next.set(id, tasks);
  return next;
}

/** `enabled` falso (ou nenhum projeto) não lê nada. `seed`: o que já foi lido (só teste: a renderização sem efeitos não lê). */
export function useProjectTasks(
  projectIds: readonly string[],
  enabled = true,
  seed?: ReadonlyMap<string, Task[]>,
): { byProject: ReadonlyMap<string, Task[]>; reload: () => Promise<void> } {
  const key = enabled ? [...new Set(projectIds)].sort().join('\n') : '';
  const [byProject, setByProject] = useState<ReadonlyMap<string, Task[]>>(() => seed ?? new Map());
  const alive = useRef(true);
  /** A leitura mais nova vale: uma que começou antes de uma decisão e termina depois da releitura que a seguiu não pode repor o estado velho. */
  const latest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const ids = key ? key.split('\n') : [];
    const got = await Promise.all(ids.map(async (id) => [id, await api.tasks(id).catch(() => null)] as const));
    if (!alive.current || mine !== latest.current) return;
    setByProject((prev) => mergeRead(prev, got));
  }, [key]);

  useEffect(() => {
    if (!key) return;
    void reload();
    return pollVisible(() => void reload(), EVERY_MS);
  }, [key, reload]);

  return { byProject, reload };
}
