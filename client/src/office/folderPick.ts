import { ApiError, isPairingError, type PickFolderResult } from '../api';
import type { MsgKey } from '../i18n';

// "Novo projeto → pasta que já existe → Procurar…": a janela de escolher pasta abre NO COMPUTADOR DO SERVIDOR (o navegador não entrega o caminho
// absoluto de uma pasta). Este arquivo decide o que a tela mostra para cada resposta; a ligação com o React fica em FolderField.tsx.
//
// O texto de erro do servidor é pt-BR e não é traduzido: a frase sai do STATUS (chaves i18n), nunca de `err.message`.

/** O aviso sob o campo. `open` = a janela está aberta; os outros dizem por que não abriu. */
export type PickNote = 'open' | 'unsupported' | 'busy' | 'failed';

export interface PickView {
  /** A janela está aberta (o pedido segue pendente até ela fechar). */
  busy: boolean;
  /** Este computador não abre a janela: o botão fica desligado e a pessoa digita o caminho. */
  unsupported: boolean;
  note: PickNote | null;
}

export const PICK_IDLE: PickView = { busy: false, unsupported: false, note: null };

/** A frase de cada aviso. */
export const PICK_NOTE_TEXT: Record<PickNote, MsgKey> = {
  open: 'office.npBrowseOpen',
  unsupported: 'office.npBrowseUnsupported',
  busy: 'office.npBrowseBusy',
  failed: 'office.npBrowseFailed',
};

/** Só o computador de quem olha a tela pode abrir a janela: página aberta por outro endereço = servidor possivelmente em outra máquina. */
export function isLocalPage(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Como a recusa do servidor vira estado: já há uma janela aberta (409 `busy`) ou falha passageira mantêm o botão (a pessoa tenta de novo); servidor
 * que não tem a rota (404) ou não aceita este pedido (400/403) é o mesmo que "este computador não abre a janela". Recusa por pareamento não
 * ganha aviso: o do App já explica.
 */
export function viewForError(err: unknown): PickView {
  if (isPairingError(err)) return PICK_IDLE;
  const status = err instanceof ApiError ? err.status : null;
  if (status === 409 && (err as ApiError).code === 'busy') return { busy: false, unsupported: false, note: 'busy' };
  if (status === 400 || status === 403 || status === 404) return { busy: false, unsupported: true, note: 'unsupported' };
  return { busy: false, unsupported: false, note: 'failed' };
}

export interface FolderPicker {
  /** Abre a janela. Ignorado se já há uma aberta por aqui ou se o computador não abre (trava síncrona: dois cliques seguidos = um pedido). */
  pick: () => Promise<void>;
  /** A tela saiu: a resposta que chegar depois não mexe em nada. */
  dispose: () => void;
}

interface Deps {
  call: () => Promise<PickFolderResult>;
  /** Escolheu: preenche o campo. Cancelar nunca chama. */
  onPath: (path: string) => void;
  onView: (view: PickView) => void;
}

export function createFolderPicker({ call, onPath, onView }: Deps): FolderPicker {
  let running = false;
  let unsupported = false;
  let disposed = false;
  const show = (view: PickView) => {
    if (!disposed) onView(view);
  };

  return {
    async pick() {
      if (running || unsupported) return;
      running = true;
      show({ busy: true, unsupported: false, note: 'open' });
      try {
        const r = await call();
        if ('path' in r && typeof r.path === 'string' && r.path) {
          if (!disposed) onPath(r.path);
          show(PICK_IDLE);
        } else if ('unsupported' in r) {
          unsupported = true;
          show({ busy: false, unsupported: true, note: 'unsupported' });
        } else if ('cancelled' in r) {
          show(PICK_IDLE);
        } else {
          show({ busy: false, unsupported: false, note: 'failed' });
        }
      } catch (err) {
        const view = viewForError(err);
        unsupported = view.unsupported;
        show(view);
      } finally {
        running = false;
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
