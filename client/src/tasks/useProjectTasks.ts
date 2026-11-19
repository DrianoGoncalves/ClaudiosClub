import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '../../../shared/model';
import { api } from '../api';
import { pollVisible } from '../usePoll';

// As tarefas de alguns projetos, para quem não é o quadro e precisa de um dado delas: a conversa (o balão do follow-up sabe se a tarefa de origem já está Finalizada, qual é o
// responsável dela e o texto inteiro do follow-up) e a caixa. Lê de novo de tempos em tempos e sob demanda (`reload`, depois de uma decisão); projeto que falha fica como estava.
// `settled`: os projetos cuja primeira leitura já terminou (deu certo ou não). Até lá a tarefa é desconhecida, e decidir um follow-up com ela desconhecida erraria (sem "Finalizado", texto cortado).

const EVERY_MS = 20_000;

/** A tarefa `taskId` do projeto, se já foi lida. */
export const taskIn = (byProject: ReadonlyMap<string, Task[]>, projectId: string, taskId: string): Task | null => byProject.get(projectId)?.find((x) => x.id === taskId) ?? null;

/** `enabled` falso (ou nenhum projeto) não lê nada. */
export function useProjectTasks(
  projectIds: readonly string[],
  enabled = true,
): { byProject: ReadonlyMap<string, Task[]>; settled: ReadonlySet<string>; reload: () => Promise<void> } {
  const key = enabled ? [...new Set(projectIds)].sort().join('\n') : '';
  const [byProject, setByProject] = useState<ReadonlyMap<string, Task[]>>(() => new Map());
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
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
    setByProject((prev) => {
      const next = new Map(prev);
      for (const [id, tasks] of got) if (tasks) next.set(id, tasks);
      return next;
    });
    setSettled((prev) => new Set([...prev, ...ids]));
  }, [key]);

  useEffect(() => {
    if (!key) return;
    void reload();
    return pollVisible(() => void reload(), EVERY_MS);
  }, [key, reload]);

  return { byProject, settled, reload };
}
