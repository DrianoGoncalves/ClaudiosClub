import { describe, expect, it } from 'vitest';
import {
  answerHead,
  askConfirm,
  BACKDROP_GRACE_MS,
  canDismissByBackdrop,
  guardEscape,
  isInsideDialog,
  nextFocusIndex,
  onDialogRequest,
  showAlert,
  type DialogRequest,
} from '../client/src/lib/dialogStore';

describe('dialogStore (modal no lugar de window.confirm/alert)', () => {
  it('sem o modal montado, o confirm é recusado (nunca segue sem o dono ver)', async () => {
    expect(await askConfirm('Apagar?')).toBe(false);
  });

  it('o confirm espera a resposta do modal', async () => {
    const seen: string[] = [];
    const off = onDialogRequest((r) => {
      seen.push(`${r.kind}:${r.text}`);
      r.resolve(r.text === 'sim');
    });
    expect(await askConfirm('sim')).toBe(true);
    expect(await askConfirm('não')).toBe(false);
    await showAlert('erro');
    expect(seen).toEqual(['confirm:sim', 'confirm:não', 'alert:erro']);
    off();
    expect(await askConfirm('sim')).toBe(false);
  });
});

describe('fila do modal (answerHead)', () => {
  const mk = (id: number, log: string[]): DialogRequest => ({
    id,
    kind: 'confirm',
    text: `p${id}`,
    resolve: (ok) => log.push(`${id}:${ok}`),
  });

  it('duas respostas seguidas respondem pedidos diferentes, em ordem, sem perder nenhum', () => {
    const log: string[] = [];
    let list = [mk(1, log), mk(2, log), mk(3, log)];
    // Esc + clique antes do re-render: cada resposta parte da lista que a anterior devolveu.
    list = answerHead(list, false);
    list = answerHead(list, true);
    expect(log).toEqual(['1:false', '2:true']);
    expect(list.map((r) => r.id)).toEqual([3]);
    list = answerHead(list, false);
    expect(log).toEqual(['1:false', '2:true', '3:false']);
    expect(list).toEqual([]);
  });

  it('fila vazia: nada a responder', () => {
    expect(answerHead([], true)).toEqual([]);
  });

  it('o pedido chega com id crescente', async () => {
    const ids: number[] = [];
    const off = onDialogRequest((r) => {
      ids.push(r.id);
      r.resolve(true);
    });
    await askConfirm('a');
    await askConfirm('b');
    off();
    expect(ids[1]!).toBeGreaterThan(ids[0]!);
  });
});

describe('Esc isolado no modal (guardEscape)', () => {
  const key = (k: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: k });

  it('Esc fecha só o modal: listeners de trás não recebem', () => {
    const win = new EventTarget();
    let closed = 0;
    const off = guardEscape(win, () => closed++);
    const behind: string[] = [];
    // Painel por trás, registrado depois (como os useEffect dos painéis), na captura e na bolha.
    win.addEventListener('keydown', () => behind.push('captura'), true);
    win.addEventListener('keydown', () => behind.push('bolha'));
    const ev = key('Escape');
    win.dispatchEvent(ev);
    expect(closed).toBe(1);
    expect(behind).toEqual([]);
    expect(ev.defaultPrevented).toBe(true);
    off();
  });

  it('outras teclas passam; depois de fechar o guard, o Esc volta aos painéis', () => {
    const win = new EventTarget();
    let closed = 0;
    const off = guardEscape(win, () => closed++);
    const behind: string[] = [];
    win.addEventListener('keydown', (e) => behind.push((e as KeyboardEvent).key));
    win.dispatchEvent(key('Enter'));
    expect(closed).toBe(0);
    off();
    win.dispatchEvent(key('Escape'));
    expect(closed).toBe(0);
    expect(behind).toEqual(['Enter', 'Escape']);
  });
});

describe('proteções do modal', () => {
  it('fundo só cancela depois da carência (duplo clique não cancela)', () => {
    expect(canDismissByBackdrop(1000, 1050)).toBe(false);
    expect(canDismissByBackdrop(1000, 1000 + BACKDROP_GRACE_MS)).toBe(true);
  });

  it('Tab dá a volta dentro do modal', () => {
    expect(nextFocusIndex(2, 1, false)).toBe(0);
    expect(nextFocusIndex(2, 0, true)).toBe(1);
    expect(nextFocusIndex(2, -1, false)).toBe(0);
    expect(nextFocusIndex(2, -1, true)).toBe(1);
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });

  it('isInsideDialog: só o que está sob o modal', () => {
    const inside = { closest: (sel: string) => (sel === '[data-dialog-host]' ? {} : null) };
    expect(isInsideDialog(inside as unknown as EventTarget)).toBe(true);
    expect(isInsideDialog({ closest: () => null } as unknown as EventTarget)).toBe(false);
    expect(isInsideDialog(null)).toBe(false);
  });
});
