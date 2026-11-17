import type { TaskStatus } from '../../../shared/model';

/**
 * O laranja de espera (selos e textos do porquê de a tarefa não andar) é só da fila "A fazer":
 * ali ele ajuda a achar de relance o que não anda; nas outras colunas viraria ruído.
 */
export const waitWarm = (status: TaskStatus): boolean => status === 'todo';

/** Classe `task-wait` (o laranja) quando for o caso; vazia nas outras colunas, que ficam no visual neutro. */
export const waitClass = (warm: boolean | undefined): string => (warm ? ' task-wait' : '');
