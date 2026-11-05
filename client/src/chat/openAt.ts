import type { ChatItem } from '../../../shared/model';

// Onde a conversa abre sem pendência: na última mensagem enviada a ele (a sua, ou um aviso da plataforma, como a
// entrega de uma tarefa), no topo, com a resposta logo abaixo para ler do começo. Aqui só a parte sem DOM
// (testável); a rolagem está em useOpenAt.ts.

/** Quanto da altura a mensagem ocupa, no máximo, antes da resposta. */
const PROMPT_SHARE = 0.4;

/** A última mensagem enviada a ele; as guardadas pelo Claudio’s Club ainda não foram. null = nenhuma. */
export function lastPromptId(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === 'user' && !item.held) return item.id;
  }
  return null;
}

/** `scrollTop` que põe a mensagem no topo da área; se ela for longa, só o fim dela, para a resposta aparecer logo. */
export function promptScrollTop(viewHeight: number, top: number, height: number, margin = 12): number {
  return Math.max(0, top - margin, top + height - viewHeight * PROMPT_SHARE);
}
