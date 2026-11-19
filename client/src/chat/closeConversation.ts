import { api, ApiError, type ArchiveClosing, type ChatCloseResult } from '../api';
import { t, type MsgKey } from '../i18n';
import { askConfirm, showAlert } from '../lib/dialogStore';

// Fechar uma conversa (libera o processo e os MCPs dela; o histórico fica no disco) e arquivar (que também fecha). O servidor decide o que
// pode fechar (server/chat/manager.ts `close`): parada fecha; trabalhando pede `confirm`; efeito fora do projeto recusa mesmo confirmado.

/** A recusa do servidor (409): `working` = faltou confirmar; `uncertain` = cortar agora poderia deixar pela metade uma ação com efeito fora do projeto. */
export type CloseRefusal = { code: 'working' } | { code: 'uncertain'; action: string | null };

export function closeRefusal(e: unknown): CloseRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  if (e.code === 'working') return { code: 'working' };
  if (e.code === 'uncertain') return { code: 'uncertain', action: typeof e.details.action === 'string' && e.details.action ? e.details.action : null };
  return null;
}

/** A conversa trabalha: turno em andamento, pedido esperando resposta ou algo em segundo plano (o servidor confere de novo ao fechar). */
export const isWorking = (s: { busy: boolean; background?: readonly unknown[] } | null | undefined, pending = false): boolean =>
  !!s && (s.busy || pending || (s.background?.length ?? 0) > 0);

/** Texto do motivo de recusa que a tela mostra; o servidor só manda a ação em pt, então o resto vem do idioma da tela. */
export function refusalText(r: CloseRefusal, fallback: string): string {
  return r.code === 'uncertain' && r.action ? t('chat.closeUncertain', { action: r.action }) : r.code === 'uncertain' ? t('chat.closeUncertainNoAction') : fallback;
}

/** As perguntas do fluxo: `working` quando ela trabalha (o risco), `idle` (opcional) quando está parada (o aviso de arquivar). */
export interface CloseAsk {
  working: MsgKey;
  idle?: MsgKey;
}

/**
 * Roda `act` (fechar ou arquivar) com a confirmação certa. Trabalhando, pergunta o risco antes e manda `confirm`; parada, fecha direto (ou só avisa, se
 * `ask.idle`). Se o servidor disser que ela trabalha (começou depois do clique), pergunta e repete; se recusar por efeito incerto, mostra o motivo.
 * Devolve o resultado, ou null se você desistiu ou o servidor recusou (o motivo já foi mostrado e nada mudou). Outro erro sobe.
 */
export async function runClose<T>(working: boolean, ask: CloseAsk, act: (confirm: boolean) => Promise<T>): Promise<{ done: T } | null> {
  let confirmed = false;
  let warned = false;
  for (;;) {
    if (working && !confirmed) {
      if (!(await askConfirm(t(ask.working)))) return null;
      confirmed = true;
    } else if (!working && !warned && ask.idle) {
      if (!(await askConfirm(t(ask.idle)))) return null;
      warned = true;
    }
    try {
      return { done: await act(confirmed) };
    } catch (e) {
      const refusal = closeRefusal(e);
      if (!refusal) throw e;
      if (refusal.code === 'working' && !confirmed) {
        working = true;
        continue;
      }
      await showAlert(refusalText(refusal, (e as Error).message));
      return null;
    }
  }
}

/** Fecha a conversa (botão Fechar). */
export const closeConversation = (sessionId: string, working: boolean): Promise<{ done: ChatCloseResult } | null> =>
  runClose(working, { working: 'chat.closeConfirmWorking' }, (confirm) => api.chatClose(sessionId, confirm));

/** Depois de arquivar funcionário ou projeto: as conversas que trabalhavam seguem abertas (só as paradas fecham), e quem arquivou precisa saber. */
export async function noteStillWorking(closing: ArchiveClosing | undefined): Promise<void> {
  if (closing && closing.working > 0) await showAlert(t('chat.archiveStillWorking', { n: closing.working }));
}
