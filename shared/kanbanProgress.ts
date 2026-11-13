// Progresso do kanban de um projeto: cada coluna vale pontos e a barra mostra quanto do lote atual já andou até
// Pronto. O servidor calcula (summary de tarefas) e a tela só desenha; a conta mora aqui para ser uma só.
import type { TaskProgress, TaskStatus } from './model';

/** Peso de cada etapa (o que a tarefa ganha ao sair dela): Aguardar 1, A fazer 3, Fazendo 2, Revisão 1. */
export const STAGE_WEIGHTS = { waiting: 1, todo: 3, doing: 2, review: 1 } as const;

/**
 * Pontos por coluna: a soma dos pesos das etapas já vencidas (Aguardar 0, A fazer 1, Fazendo 4, Revisão 6, Pronto 7).
 * "Planejando" é a coluna Fazendo na tela, então vale o mesmo.
 */
export const STATUS_POINTS: Record<TaskStatus, number> = (() => {
  const w = STAGE_WEIGHTS;
  const doing = w.waiting + w.todo;
  return { waiting: 0, todo: w.waiting, planning: doing, doing, review: doing + w.doing, done: doing + w.doing + w.review };
})();
const MAX_POINTS = STATUS_POINTS.done;

/** O que a conta lê de uma tarefa (a `Task` serve). */
export interface ProgressTask {
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  history?: Array<{ at: string; status: TaskStatus }>;
}

/** Quando a tarefa ficou pronta: a última vez que entrou em Pronto no histórico; sem ela, a última mudança. NaN = data ilegível. */
function doneAt(task: ProgressTask): number {
  const entry = [...(task.history ?? [])].reverse().find((h) => h.status === 'done');
  return Date.parse(entry?.at ?? task.updatedAt);
}

/**
 * Pontos do lote atual sobre o máximo (7 por tarefa). O lote é o que está aberto mais o que ficou pronto depois da
 * criação da tarefa aberta mais antiga; as prontas de antes ficam de fora (senão a barra ficaria sempre perto de
 * 100%). Sem tarefa aberta devolve null: não há o que zerar, não há barra.
 */
export function kanbanProgress(tasks: readonly ProgressTask[]): TaskProgress | null {
  const open = tasks.filter((x) => x.status !== 'done');
  if (open.length === 0) return null;
  const since = Math.min(...open.map((x) => Date.parse(x.createdAt)));
  // Data ilegível (NaN) nunca passa na comparação: a tarefa fica fora do lote em vez de inflar a barra.
  const batch = [...open, ...tasks.filter((x) => x.status === 'done' && doneAt(x) >= since)];
  return { points: batch.reduce((sum, x) => sum + STATUS_POINTS[x.status], 0), max: MAX_POINTS * batch.length };
}

/** 0–99 (arredonda para baixo: com tarefa aberta nunca chega a 100%). */
export const progressPercent = (p: TaskProgress): number => (p.max > 0 ? Math.floor((p.points * 100) / p.max) : 0);

/** Tarefas do lote, abertas e prontas. */
export const progressTotal = (p: TaskProgress): number => Math.round(p.max / MAX_POINTS);
