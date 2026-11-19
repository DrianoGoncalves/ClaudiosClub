import type { ChatItem, ChatSnapshot } from '../../../shared/model';
import { alertError, api, ApiError } from '../api';
import { t, type MsgKey } from '../i18n';
import { askConfirm, showAlert } from '../lib/dialogStore';

// "Excluir" a mensagem que o Claudio’s Club guardou até o funcionário terminar outra coisa. O fluxo mora aqui, sem React
// (testável sem DOM, tests/heldDiscardFlow.test.ts): o botão está em HeldDiscardButton.tsx; useChat.ts e ChatView.tsx só ligam estas funções ao estado.

/** O prefixo que o servidor põe no id do item guardado (`h:<id da mensagem>`). */
const HELD_PREFIX = 'h:';

/** Onde bater para excluir esta mensagem guardada; null se ela não pode ser excluída (e então não há botão). */
export function heldDiscardOf(item: ChatItem): { taskId: string; heldId: string } | null {
  if (item.kind !== 'user' || !item.held || item.heldDiscardable !== true || !item.heldTaskId) return null;
  if (!item.id.startsWith(HELD_PREFIX) || item.id.length === HELD_PREFIX.length) return null;
  return { taskId: item.heldTaskId, heldId: item.id.slice(HELD_PREFIX.length) };
}

/**
 * O servidor recusou com 409. São três motivos (a tarefa mudou de responsável; a mensagem já não está guardada; é resposta a uma
 * dúvida) e o status não diz qual: a tela não afirma nenhum, olha a conversa relida (ver `HeldDiscardResult`).
 */
export const heldIsGone = (e: unknown): boolean => e instanceof ApiError && e.status === 409;

/**
 * O que a exclusão deu.
 * - `discarded`: saiu da conversa;
 * - `gone`: o servidor recusou (409) e a conversa relida já não traz a mensagem entre as guardadas (não diz se foi enviada ou excluída: um
 *   dono de tarefa novo também a tira desta conversa);
 * - `kept`: o servidor recusou e a conversa relida ainda a traz guardada;
 * - `unknown`: o servidor recusou e a conversa não pôde ser relida, então não se sabe se ela continua guardada.
 * Outro erro (rede, 403, 404) não é resultado: sobe, para o alerta de erro.
 */
export type HeldDiscardResult = 'discarded' | 'gone' | 'kept' | 'unknown';

interface DiscardCtx {
  projectId: string;
  sessionId: string | null;
  /** Relê a conversa (e troca as guardadas pelas do servidor); null: a tela já passou para outra conversa enquanto lia. */
  reload: (sid: string) => Promise<ChatSnapshot | null>;
  /** Tira a mensagem das guardadas da tela. */
  drop: (id: string) => void;
}

/** Corpo do `discardHeld` do useChat. */
export async function discardHeldItem(item: ChatItem, { projectId, sessionId, reload, drop }: DiscardCtx): Promise<HeldDiscardResult> {
  const target = heldDiscardOf(item);
  if (!target || !sessionId) return 'unknown';
  try {
    await api.discardHeld(projectId, target.taskId, target.heldId);
  } catch (e) {
    if (!heldIsGone(e)) throw e;
    // Recusada: relê, e a mensagem aparece (ou some) conforme está agora. Se a leitura falha, o aviso diz isso em vez de afirmar o que não sabe.
    const snap = await reload(sessionId).catch(() => null);
    if (!snap) return 'unknown';
    return snap.held?.some((i) => i.id === item.id) ? 'kept' : 'gone';
  }
  drop(item.id);
  return 'discarded';
}

/** A frase do aviso de cada resultado (o `discarded` não tem: a mensagem some da tela). */
const NOTICE = {
  gone: 'chat.heldDiscardGone',
  kept: 'chat.heldDiscardKept',
  unknown: 'chat.heldDiscardUnsure',
} as const satisfies Record<Exclude<HeldDiscardResult, 'discarded'>, MsgKey>;

/**
 * O clique em "Excluir" do ChatView: pergunta (botão "Excluir"), exclui e avisa conforme o resultado; erro de rede, 403 e afins vão
 * ao alerta de erro. Um pedido por vez: o clique repetido (enquanto a pergunta está aberta ou o pedido a caminho) não faz nada.
 * `onBusy` recebe o id da mensagem enquanto o fluxo roda e `null` ao fim (o botão fica desligado).
 */
export function createHeldDiscarder(opts: { discard: (item: ChatItem) => Promise<HeldDiscardResult>; onBusy: (id: string | null) => void }) {
  let busy = false;
  return async (item: ChatItem): Promise<void> => {
    if (busy) return;
    busy = true;
    opts.onBusy(item.id);
    try {
      if (!(await askConfirm(t('chat.heldDiscardConfirm'), t('chat.heldDiscard')))) return;
      const result = await opts.discard(item);
      if (result !== 'discarded') await showAlert(t(NOTICE[result]));
    } catch (e) {
      alertError(e);
    } finally {
      busy = false;
      opts.onBusy(null);
    }
  };
}
