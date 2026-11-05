import { type RefObject, useLayoutEffect, useRef } from 'react';
import type { ChatItem } from '../../../shared/model';
import { lastPromptId, promptScrollTop } from './openAt';

// Ao abrir sem pendência, a conversa fica na última mensagem enviada a ele, no topo, com a resposta logo abaixo (ver
// openAt.ts). Com o processo aberto, o fim da conversa chega pelo SSE depois do histórico: a posição se refaz a cada
// atualização até a pessoa assumir a rolagem (roda, toque, clique, tecla ou foco na lista) ou mandar mensagem.

/** O que conta como a pessoa assumir a rolagem: daí em diante vale o de sempre (grudar no fim só quando está lá). */
const TAKE_OVER = ['wheel', 'pointerdown', 'keydown', 'focusin'] as const;

export function useOpenAt(o: {
  list: RefObject<HTMLDivElement>;
  stick: { current: boolean };
  items: ChatItem[];
  loading: boolean;
  /** Pendência (pergunta ou permissão esperando você), ou aviso que aponta um balão: abre no fim, como antes. */
  atEnd: boolean;
  /** Depois de rolar: a seta "ir para o fim" aparece quando não está no fim. */
  onAway: (away: boolean) => void;
}) {
  const { list, stick } = o;
  /** Segurando a conversa na mensagem: enquanto isso, as respostas novas não puxam a rolagem para o fim. */
  const holding = useRef(true);

  // Antes da pintura: a conversa não aparece no fim para depois pular, e o "está no fim" sai da posição já certa.
  useLayoutEffect(() => {
    const root = list.current;
    if (!holding.current || o.loading || !root) return;
    const id = o.atEnd ? null : lastPromptId(o.items);
    const bubble = id ? [...root.querySelectorAll<HTMLElement>('[data-item-id]')].find((b) => b.dataset.itemId === id) : undefined;
    if (bubble) {
      const box = root.getBoundingClientRect();
      const rect = bubble.getBoundingClientRect();
      root.scrollTop = promptScrollTop(root.clientHeight, rect.top - box.top - root.clientTop + root.scrollTop, rect.height);
    } else {
      // Pendência, ou ainda nenhuma mensagem enviada a ele (conversa nova, ou ela vem pelo SSE): no fim.
      root.scrollTop = root.scrollHeight;
      if (o.atEnd) holding.current = false;
    }
    const end = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    stick.current = end;
    o.onAway(!end);
  });

  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    const release = () => {
      holding.current = false;
    };
    for (const type of TAKE_OVER) root.addEventListener(type, release, { passive: true });
    return () => {
      for (const type of TAKE_OVER) root.removeEventListener(type, release);
    };
  }, [list]);

  return {
    /** Segurando na mensagem: o "grudar no fim" espera. */
    holding: () => holding.current,
    /** Mandou mensagem: larga a mensagem e volta a acompanhar o fim. */
    release: () => {
      if (!holding.current) return;
      holding.current = false;
      stick.current = true;
    },
  };
}
