import type { Task } from '../../../shared/model';
import { t } from '../i18n';

// Ordem da fila de A fazer (contrato: server/tasks.ts `reorder`, rota POST .../tasks/:id/order). O servidor numera a fila de cada funcionário
// (`Task.queuePos`, 1 = a próxima) e decide quem pode mexer; aqui só se escolhe o movimento e se escreve o que ele gravou no histórico.

type Q = Pick<Task, 'id' | 'staffId' | 'queuePos'>;

/** O corpo do pedido: a uma posição (soltar o cartão arrastado) ou um lugar acima/abaixo (teclado). */
export type OrderBody = { to: number } | { step: 'up' | 'down' };

/** Quais passos o cartão ainda aceita pelo teclado (o servidor recusa o que não muda nada). */
export interface OrderMoves {
  up: boolean;
  down: boolean;
}

/** Posição do cartão na fila do funcionário (1 = a próxima); 0 = fora da fila. */
export const queuePosOf = (t: Pick<Task, 'queuePos'>): number => t.queuePos ?? 0;

/** Quantos cartões a fila do funcionário tem (o servidor numera sem buracos). */
export function queueSize(tasks: Q[], staffId: string | null): number {
  return staffId ? tasks.filter((o) => o.staffId === staffId && queuePosOf(o) > 0).length : 0;
}

/** Os passos do cartão; null = nada para mover (fora da fila, ou sozinho nela). */
export function orderMoves(task: Q, tasks: Q[]): OrderMoves | null {
  const pos = queuePosOf(task);
  if (pos === 0 || queueSize(tasks, task.staffId) < 2) return null;
  return { up: pos > 1, down: pos < queueSize(tasks, task.staffId) };
}

/** Alt + seta com o cartão em foco: o passo que ela pede (o caminho do teclado, já que o cartão não tem botão de ordem). */
export const stepOfKey = (key: string, alt: boolean): 'up' | 'down' | null => (!alt ? null : key === 'ArrowUp' ? 'up' : key === 'ArrowDown' ? 'down' : null);

/**
 * Soltar `dragged` antes de `target`, ou depois dele (`after`: a metade de baixo do alvo): a posição que o cartão passa a ter na fila, ou null quando
 * não vale (outra fila, o mesmo cartão, fora da fila) ou não muda nada (já está ali).
 */
export function dropPosition(dragged: Q | undefined, target: Q, after = false): number | null {
  if (!dragged || dragged.id === target.id || !dragged.staffId || dragged.staffId !== target.staffId) return null;
  const from = queuePosOf(dragged);
  const at = queuePosOf(target);
  if (from === 0 || at === 0) return null;
  // O lugar em que o cartão entra, na numeração de agora; tirá-lo de cima do alvo puxa o alvo uma posição para cima.
  const slot = after ? at + 1 : at;
  const to = slot > from ? slot - 1 : slot;
  return to === from ? null : to;
}

/** O lado do alvo em que o arrasto cai: a metade de baixo do cartão vale "depois"; a bandeja de subtarefas, colada embaixo dele, é parte do cartão e vale "depois" inteira. */
export const dropAfter = (clientY: number, card: { top: number; height: number }, onTray: boolean): boolean => onTray || clientY > card.top + card.height / 2;

// O histórico guarda a frase pronta em português (server/tasks.ts `reorder` e `suggestOrder`); a tela a lê de volta para escrever no idioma dela.
// Frase que não bate (servidor mudou o texto) volta como veio.

/** Quem mexeu na fila, ou sugeriu, segundo a nota do histórico. */
export type OrderNote =
  | { kind: 'moved'; owner: string; by: string; from: number; to: number; of: number }
  | { kind: 'suggested'; who: string; move: 'top' | 'up' | 'down'; reason: string };

const SUGGEST_MOVES: Record<string, 'top' | 'up' | 'down'> = { 'passar para o topo': 'top', subir: 'up', descer: 'down' };

export function parseOrderNote(note: string | undefined): OrderNote | null {
  const moved = /^fila de (.+) reordenada por (.+): posição (\d+) → (\d+) de (\d+)$/.exec(note ?? '');
  if (moved) return { kind: 'moved', owner: moved[1]!, by: moved[2]!, from: Number(moved[3]), to: Number(moved[4]), of: Number(moved[5]) };
  const suggested = /^(.+) sugeriu (passar para o topo|subir|descer) na fila: (.+)$/.exec(note ?? '');
  if (suggested) return { kind: 'suggested', who: suggested[1]!, move: SUGGEST_MOVES[suggested[2]!]!, reason: suggested[3]! };
  return null;
}

/**
 * A linha do histórico para a nota de ordem: quem mexeu, ou quem sugeriu, no idioma da tela. `by` do histórico diz se foi você ('you'); o gestor
 * que pediu o cartão entra como 'auto' e vem pelo nome na nota. null = não é nota de ordem (a linha segue como as outras).
 */
export function orderNoteText(note: string | undefined, by: 'you' | 'auto'): string | null {
  const n = parseOrderNote(note);
  if (!n) return null;
  if (n.kind === 'suggested') return t('tasks.orderNoteSuggested', { who: n.who, move: t(`tasks.orderSuggest.${n.move}`), reason: n.reason });
  return t('tasks.orderNoteMoved', { owner: n.owner, by: by === 'you' ? t('tasks.byYou') : n.by, from: n.from, to: n.to, of: n.of });
}
