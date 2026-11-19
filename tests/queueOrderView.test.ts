import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropAfter, dropPosition, orderMoves, orderNoteText, parseOrderNote, queuePosOf, queueSize, stepOfKey } from '../client/src/tasks/queueOrder';

// Ordem da fila de A fazer na tela: os passos que o teclado aceita, onde o cartão cai ao ser solto e como a nota do histórico aparece.

const c = (id: string, staffId: string | null, queuePos?: number) => ({ id, staffId, queuePos });
const board = [c('a1', 'ana', 1), c('a2', 'ana', 2), c('a3', 'ana', 3), c('b1', 'bia', 1), c('solta', 'ana'), c('sem', null)];

describe('orderMoves', () => {
  it('o primeiro só desce; o do meio sobe e desce; o último só sobe', () => {
    expect(orderMoves(board[0]!, board)).toEqual({ up: false, down: true });
    expect(orderMoves(board[1]!, board)).toEqual({ up: true, down: true });
    expect(orderMoves(board[2]!, board)).toEqual({ up: true, down: false });
  });

  it('sozinho na fila, fora da fila ou sem responsável: nada para mover', () => {
    expect(orderMoves(board[3]!, board)).toBeNull();
    expect(orderMoves(board[4]!, board)).toBeNull();
    expect(orderMoves(board[5]!, board)).toBeNull();
  });

  it('a fila é de cada funcionário: o tamanho não mistura', () => {
    expect(queueSize(board, 'ana')).toBe(3);
    expect(queueSize(board, 'bia')).toBe(1);
    expect(queueSize(board, null)).toBe(0);
  });
});

describe('dropPosition (arrastar o cartão até a posição)', () => {
  const [a1, a2, a3] = board;

  it('subindo: antes do alvo é a posição dele; depois do alvo é a seguinte', () => {
    expect(dropPosition(a3, a1!)).toBe(1);
    expect(dropPosition(a3, a1!, true)).toBe(2);
    expect(dropPosition(a3, a2!)).toBe(2);
  });

  it('descendo: antes do alvo é uma a menos (o próprio cartão sai de cima); depois do alvo é a dele', () => {
    expect(dropPosition(a1, a3!)).toBe(2);
    expect(dropPosition(a1, a3!, true)).toBe(3);
    expect(dropPosition(a1, a2!, true)).toBe(2);
  });

  it('o lugar onde ele já está não vale (nada a mover)', () => {
    expect(dropPosition(a2, a1!, true)).toBeNull();
    expect(dropPosition(a2, a3!)).toBeNull();
    expect(dropPosition(a1, a2!)).toBeNull();
    expect(dropPosition(a3, a2!, true)).toBeNull();
  });

  it('outra fila, o mesmo cartão, cartão fora da fila ou nada arrastado: não vale', () => {
    expect(dropPosition(board[0], board[3]!)).toBeNull();
    expect(dropPosition(board[0], board[0]!)).toBeNull();
    expect(dropPosition(board[4], board[0]!)).toBeNull();
    expect(dropPosition(board[0], board[4]!)).toBeNull();
    expect(dropPosition(undefined, board[0]!)).toBeNull();
    expect(dropPosition(board[5], board[5]!)).toBeNull();
  });

  it('numa fila de 4, todo lugar de soltura dá a posição que o servidor vai gravar', () => {
    const q = [1, 2, 3, 4].map((n) => c(`q${n}`, 'ana', n));
    // Simula a fila: tira o arrastado e o põe antes/depois do alvo; a posição final tem de ser a que dropPosition devolve.
    for (const from of q) {
      for (const target of q) {
        for (const after of [false, true]) {
          const to = dropPosition(from, target, after);
          if (from.id === target.id) continue;
          const rest = q.filter((x) => x.id !== from.id);
          const at = rest.findIndex((x) => x.id === target.id) + (after ? 1 : 0);
          const expected = at + 1;
          expect(to).toBe(expected === queuePosOf(from) ? null : expected);
        }
      }
    }
  });
});

describe('dropAfter (o lado em que o arrasto cai sobre a pilha do cartão)', () => {
  const box = { top: 100, height: 60 };

  it('sobre o cartão: a metade de cima é "antes", a de baixo é "depois"', () => {
    expect(dropAfter(110, box, false)).toBe(false);
    expect(dropAfter(130, box, false)).toBe(false);
    expect(dropAfter(131, box, false)).toBe(true);
    expect(dropAfter(155, box, false)).toBe(true);
  });

  it('sobre a bandeja de subtarefas: sempre "depois", mesmo se o ponteiro estiver acima da metade do cartão', () => {
    expect(dropAfter(165, box, true)).toBe(true);
    expect(dropAfter(0, box, true)).toBe(true);
  });

  it('soltar sobre a bandeja põe o cartão depois do dono dela (traço de baixo)', () => {
    const [a1, a2, a3] = board;
    expect(dropPosition(a3, a1!, dropAfter(170, box, true))).toBe(2);
    expect(dropPosition(a1, a2!, dropAfter(170, box, true))).toBe(2);
    // Já está logo depois dele: nada a mover, e o traço não aparece.
    expect(dropPosition(a2, a1!, dropAfter(170, box, true))).toBeNull();
  });
});

describe('stepOfKey (o teclado, já que o cartão não tem botão de ordem)', () => {
  it('Alt + seta: sobe ou desce um lugar', () => {
    expect(stepOfKey('ArrowUp', true)).toBe('up');
    expect(stepOfKey('ArrowDown', true)).toBe('down');
  });

  it('seta sem Alt, ou outra tecla: não é pedido de ordem', () => {
    expect(stepOfKey('ArrowUp', false)).toBeNull();
    expect(stepOfKey('ArrowLeft', true)).toBeNull();
    expect(stepOfKey('Enter', true)).toBeNull();
  });
});

describe('parseOrderNote (as frases que o servidor grava no histórico)', () => {
  it('reordenada: de quem é a fila, quem mexeu e de onde para onde', () => {
    expect(parseOrderNote('fila de Beakman reordenada por você: posição 3 → 1 de 4')).toEqual({ kind: 'moved', owner: 'Beakman', by: 'você', from: 3, to: 1, of: 4 });
    expect(parseOrderNote('fila de Ana Maria reordenada por Denzel: posição 1 → 2 de 2')).toMatchObject({ owner: 'Ana Maria', by: 'Denzel' });
  });

  it('sugestão: quem sugeriu, o movimento e o motivo (que pode ter dois-pontos)', () => {
    expect(parseOrderNote('Beakman sugeriu passar para o topo na fila: bloqueia o deploy: urgente')).toEqual({
      kind: 'suggested',
      who: 'Beakman',
      move: 'top',
      reason: 'bloqueia o deploy: urgente',
    });
    expect(parseOrderNote('Beakman sugeriu subir na fila: x')).toMatchObject({ move: 'up' });
    expect(parseOrderNote('Beakman sugeriu descer na fila: x')).toMatchObject({ move: 'down' });
  });

  it('outra nota, ou nenhuma: não é de ordem', () => {
    expect(parseOrderNote('em a fazer fora da fila: entrou na fila')).toBeNull();
    expect(parseOrderNote(undefined)).toBeNull();
    expect(parseOrderNote('')).toBeNull();
  });
});

describe('orderNoteText nos 3 idiomas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });
  const inLocale = async (locale: string) => {
    vi.resetModules();
    vi.stubGlobal('window', { localStorage: { getItem: () => locale } });
    return import('../client/src/tasks/queueOrder');
  };
  const moved = 'fila de Beakman reordenada por você: posição 3 → 1 de 4';
  const movedByManager = 'fila de Beakman reordenada por Denzel: posição 3 → 1 de 4';
  const suggested = 'Beakman sugeriu subir na fila: bloqueia o deploy';

  it.each([
    ['pt-BR', 'fila de Beakman reordenada por você: posição 3 → 1 de 4', 'fila de Beakman reordenada por Denzel: posição 3 → 1 de 4', 'Beakman sugeriu subir na fila: bloqueia o deploy'],
    ['en', 'Beakman’s queue reordered by you: position 3 → 1 of 4', 'Beakman’s queue reordered by Denzel: position 3 → 1 of 4', 'Beakman suggested moving it up the queue: bloqueia o deploy'],
    ['es', 'cola de Beakman reordenada por tú: posición 3 → 1 de 4', 'cola de Beakman reordenada por Denzel: posición 3 → 1 de 4', 'Beakman sugirió subirla en la cola: bloqueia o deploy'],
  ])('%s', async (locale, you, manager, suggest) => {
    const mod = await inLocale(locale);
    // Do navegador (by 'you') vem "você" na nota; a tela troca pelo idioma dela. Do gestor (by 'auto'), fica o nome.
    expect(mod.orderNoteText(moved, 'you')).toBe(you);
    expect(mod.orderNoteText(movedByManager, 'auto')).toBe(manager);
    expect(mod.orderNoteText(suggested, 'auto')).toBe(suggest);
  });

  it('nota de outro assunto: null (a linha do histórico segue como as outras)', () => {
    expect(orderNoteText('retomada na fila', 'auto')).toBeNull();
  });
});
