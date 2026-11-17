// Progresso do kanban de um projeto: cada tarefa em andamento vale 3 pontos e a barra mostra quanto delas já andou. O servidor
// calcula (summary de tarefas) e a tela só desenha; a conta mora aqui para ser uma só.
import type { TaskProgress, TaskStatus } from './model';

/** Quanto cada tarefa na conta vale no total. */
export const TASK_POINTS = 3;

/**
 * Pontos ganhos por coluna: A fazer 0, Fazendo 1, Revisão 2. "Planejando" é a coluna Fazendo na tela, então vale o mesmo.
 * Status fora daqui (Aguardar, Pronto e Cancelada) não entra na conta: nem os pontos nem o máximo.
 */
export const STATUS_POINTS: Partial<Record<TaskStatus, number>> = { todo: 0, planning: 1, doing: 1, review: 2 };

/** O que a conta lê de uma tarefa (a `Task` serve). */
export interface ProgressTask {
  status: TaskStatus;
}

/**
 * Pontos sobre o máximo (3 por tarefa na conta). Só entram A fazer, Fazendo/Planejando e Revisão; sem nenhuma delas devolve
 * null (não há barra). Revisão reprovada volta para Fazendo e a barra recua (2 → 1 de 3).
 */
export function kanbanProgress(tasks: readonly ProgressTask[]): TaskProgress | null {
  let counted = 0;
  let points = 0;
  for (const x of tasks) {
    const own = STATUS_POINTS[x.status];
    if (own === undefined) continue;
    counted += 1;
    points += own;
  }
  return counted === 0 ? null : { points, max: TASK_POINTS * counted };
}

/** 0–100 (arredonda para baixo). */
export const progressPercent = (p: TaskProgress): number => (p.max > 0 ? Math.floor((p.points * 100) / p.max) : 0);

/** Tarefas na conta. */
export const progressTotal = (p: TaskProgress): number => Math.round(p.max / TASK_POINTS);
