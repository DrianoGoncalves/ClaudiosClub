import { type RefObject, useEffect, useRef } from 'react';
import type { ChatItem } from '../../../shared/model';
import { centerScrollTop, type ChatFocus, endScrollTop, findQuoteIndex, findQuoteItem } from './chatFocus';

// Clicou num aviso da caixa "precisa de mim": rola a conversa até o balão que o causou (a pergunta, o
// cartão de permissão ou de plano) e o faz piscar. O balão pode chegar depois do histórico (itens ao vivo
// vêm pelo SSE), então a busca se repete a cada atualização por um tempo curto.

/** Quanto esperar o balão aparecer antes de desistir (a conversa fica no fim, como sem aviso). */
const WAIT_MS = 2000;
/** Quanto o balão fica destacado (igual à animação `msg-flash` em styles.css). */
const FLASH_MS = 2500;
/** Os trechos de um balão onde a pergunta pode estar. */
const PARTS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre';

interface Located {
  bubble: HTMLElement;
  /** O trecho da pergunta, ou o próprio balão. */
  target: HTMLElement;
  /** Achou o que foi pedido (o trecho, quando há pergunta). */
  exact: boolean;
  /** Pergunta não achada: o último trecho do balão, onde ela costuma estar (o fim da resposta). */
  end?: HTMLElement;
}

function locate(root: HTMLElement, items: ChatItem[], focus: ChatFocus): Located | null {
  const bubbles = [...root.querySelectorAll<HTMLElement>('[data-item-id]')];
  const byId = (id: string) => bubbles.find((b) => b.dataset.itemId === id) ?? null;
  const bubble = (focus.itemId ? byId(focus.itemId) : null) ?? (focus.quote ? byId(findQuoteItem(items, focus.quote) ?? '') : null);
  if (!bubble) return null;
  if (!focus.quote) return { bubble, target: bubble, exact: true };
  const parts = [...bubble.querySelectorAll<HTMLElement>(PARTS)];
  const at = findQuoteIndex(parts.map((p) => p.textContent ?? ''), focus.quote);
  if (at >= 0) return { bubble, target: parts[at]!, exact: true };
  return { bubble, target: bubble, exact: false, end: parts[parts.length - 1] ?? bubble };
}

/** Altura da margem que a rolagem deixa em volta do trecho. */
const MARGIN = 12;

/** Onde rolar: o trecho no centro; se a pergunta não foi achada num balão mais alto que a área, o fim dele. */
function scrollTopFor(root: HTMLElement, hit: Located): number {
  const box = root.getBoundingClientRect();
  const topOf = (el: HTMLElement) => el.getBoundingClientRect().top - box.top - root.clientTop + root.scrollTop;
  const view = root.clientHeight;
  const target = hit.target.getBoundingClientRect();
  if (hit.end && target.height > view - 2 * MARGIN) {
    return endScrollTop(view, topOf(hit.end), hit.end.getBoundingClientRect().height, MARGIN);
  }
  return centerScrollTop(view, topOf(hit.target), target.height, MARGIN);
}

/**
 * `release`: devolve o "grudar no fim" (ao rolar até o fim ou mandar mensagem). Enquanto o alvo está em
 * foco, `stick` fica desligado para as respostas novas não puxarem a rolagem de volta.
 */
export function useChatFocus(o: {
  list: RefObject<HTMLDivElement>;
  stick: { current: boolean };
  items: ChatItem[];
  loading: boolean;
  sessionId: string | null;
  focus: ChatFocus | null | undefined;
  /** O alvo foi atendido (ou o tempo acabou): quem o mandou pode largá-lo. */
  onDone?: () => void;
  /** Depois de rolar: a seta "ir para o fim" aparece quando não está no fim. */
  onAway: (away: boolean) => void;
}) {
  const { list, stick, focus, loading } = o;
  const focused = useRef(false);
  const scrolled = useRef<{ focus: ChatFocus; exact: boolean } | null>(null);
  const flashing = useRef<{ el: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
  const onDone = useRef(o.onDone);
  onDone.current = o.onDone;

  // Passou o tempo e o balão não apareceu (outra conversa, mais de 200 mensagens atrás): fica no fim.
  useEffect(() => {
    if (!focus || loading) return;
    const timer = setTimeout(() => onDone.current?.(), WAIT_MS);
    return () => clearTimeout(timer);
  }, [focus, loading]);

  useEffect(() => {
    const root = list.current;
    if (!focus || loading || !root || focus.sessionId !== o.sessionId) return;
    // Aviso sem ponto na conversa (erro, sessão de fora): ela só abre, no fim.
    if (!focus.itemId && !focus.quote) return onDone.current?.();
    const prev = scrolled.current?.focus === focus ? scrolled.current : null;
    if (prev?.exact) return;
    const hit = locate(root, o.items, focus);
    // Já está no balão e o texto dele ainda não chegou inteiro (resposta chegando): espera a pergunta aparecer.
    if (!hit || (prev && !hit.exact)) return;
    const first = !prev;
    scrolled.current = { focus, exact: hit.exact };

    root.scrollTop = scrollTopFor(root, hit);
    const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight < 40;
    focused.current = !atEnd;
    stick.current = atEnd;
    o.onAway(!atEnd);

    if (first) {
      if (flashing.current) {
        clearTimeout(flashing.current.timer);
        flashing.current.el.classList.remove('is-flash');
      }
      hit.bubble.classList.remove('is-flash');
      void hit.bubble.offsetWidth; // reinicia a animação se o mesmo balão pisca de novo
      hit.bubble.classList.add('is-flash');
      const el = hit.bubble;
      flashing.current = { el, timer: setTimeout(() => el.classList.remove('is-flash'), FLASH_MS) };
    }
    if (hit.exact) onDone.current?.();
  });

  useEffect(
    () => () => {
      if (flashing.current) clearTimeout(flashing.current.timer);
    },
    [],
  );

  return {
    release: () => {
      if (!focused.current) return;
      focused.current = false;
      stick.current = true;
    },
  };
}
