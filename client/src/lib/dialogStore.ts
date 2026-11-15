// Pergunta e aviso no modal do design system, no lugar de window.confirm / window.alert. Sem tela aqui: a ponte entre quem
// pergunta (qualquer código do cliente, `await askConfirm(...)`) e o modal que o App monta uma vez (lib/DialogHost.tsx).
// Lógica pura, testada em tests/dialogStore.test.ts.

export interface DialogRequest {
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

function open(kind: DialogRequest['kind'], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Sem o modal montado (antes do App subir): recusa o confirm em vez de seguir sem o dono ter visto a pergunta.
    if (!sink) return resolve(false);
    sink({ kind, text, resolve });
  });
}

/** "OK / Cancelar" no modal. Fechar (Esc, clique fora, Cancelar) é false. Quebras de linha do texto são mantidas. */
export const askConfirm = (text: string): Promise<boolean> => open('confirm', text);

/** Aviso com um "OK" só. Termina quando o dono fecha. */
export const showAlert = (text: string): Promise<void> => open('alert', text).then(() => undefined);
