// Pergunta e aviso no modal do design system, no lugar de window.confirm / window.alert. Sem tela aqui: a ponte entre quem
// pergunta (qualquer código do cliente, `await askConfirm(...)`) e o modal que o App monta uma vez (lib/DialogHost.tsx).
// Lógica pura, testada em tests/dialogStore.test.ts.

export interface DialogRequest {
  /** Chave do pedido na fila (remonta os botões e refaz o foco quando o próximo assume). */
  id: number;
  kind: 'confirm' | 'alert';
  text: string;
  /** Quem chamou espera isto: o confirm responde true/false, o alert só termina. */
  resolve: (ok: boolean) => void;
}

let sink: ((req: DialogRequest) => void) | null = null;

/** O DialogHost se registra aqui; devolve o cancelamento do registro. */
export function onDialogRequest(fn: (req: DialogRequest) => void): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

let nextId = 1;

function open(kind: DialogRequest['kind'], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Sem o modal montado (antes do App subir): recusa o confirm em vez de seguir sem o dono ter visto a pergunta.
    if (!sink) return resolve(false);
    sink({ id: nextId++, kind, text, resolve });
  });
}

/** "OK / Cancelar" no modal. Fechar (Esc, clique fora, Cancelar) é false. Quebras de linha do texto são mantidas. */
export const askConfirm = (text: string): Promise<boolean> => open('confirm', text);

/** Aviso com um "OK" só. Termina quando o dono fecha. */
export const showAlert = (text: string): Promise<void> => open('alert', text).then(() => undefined);

// ---- fila e proteções do modal (usadas pelo DialogHost; puras para testar sem tela) ----

/**
 * Responde o pedido da frente da fila e devolve o resto. Resolve a cabeça da lista que recebe, não a de um closure:
 * duas respostas antes do re-render (Esc + clique) respondem dois pedidos diferentes, nenhum fica sem resposta.
 */
export function answerHead(list: DialogRequest[], ok: boolean): DialogRequest[] {
  const [head, ...rest] = list;
  head?.resolve(ok);
  return rest;
}

/** Cliques no fundo logo depois de abrir não cancelam: o 2º clique de um duplo clique cairia no fundo do modal recém-aberto. */
export const BACKDROP_GRACE_MS = 400;
export const canDismissByBackdrop = (openedAt: number, now: number): boolean => now - openedAt >= BACKDROP_GRACE_MS;

/** Marca do modal no DOM: painéis e menus que fecham ao clicar fora ignoram cliques aqui dentro. */
export const DIALOG_ATTR = 'data-dialog-host';
export function isInsideDialog(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(`[${DIALOG_ATTR}]`);
}

/**
 * Esc com o modal aberto é só do modal: escuta na captura (antes de qualquer listener de document/React) e corta a
 * propagação, então painéis, menus e editores por trás não reagem. Devolve o cancelamento.
 */
export function guardEscape(target: EventTarget, onEscape: () => void): () => void {
  const onKey = (e: Event) => {
    if ((e as KeyboardEvent).key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    onEscape();
  };
  target.addEventListener('keydown', onKey, { capture: true });
  return () => target.removeEventListener('keydown', onKey, { capture: true });
}

/** Próximo botão ao apertar Tab dentro do modal: dá a volta em vez de sair para a tela de trás. */
export function nextFocusIndex(count: number, current: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}
