import type { ChatEvent, ChatItem } from '../../../shared/model';

// Conversa comprida pesa na aba (cada mensagem é um bloco de DOM com Markdown): a tela pinta só o fim da lista, com um botão
// para trazer os anteriores. O que pesa é o DOM, e ele fica limitado aqui; os itens em si ficam todos (o servidor é que corta
// a memória dele, e o snapshot completa o resto pelo transcript). A tela NÃO corta o que chega ao vivo: o histórico ficaria no
// ponto em que foi lido e o que saísse daqui sumiria da conversa, sem aviso. Aqui só a conta (testável, sem DOM); o uso está em
// useChat.ts (juntar) e ChatView.tsx (pintar).

/** Quantos itens do fim a lista pinta de começo, e quantos mais cada clique em "mostrar anteriores" traz. */
export const WINDOW_STEP = 200;

/** Um pedido seu sem resposta (permissão, pergunta, plano) nunca some da lista, por mais antigo que seja. */
const asksYou = (i: ChatItem): boolean => i.kind === 'permission' && i.status === 'pending';

/**
 * Um evento do stream aplicado ao que veio ao vivo. O item que chega com um id que já existe o troca (o texto recomeça); a delta
 * soma ao texto da resposta que está chegando. O stream da tela começa no `seq` do snapshot (ver ChatSnapshot.live), então os
 * itens do snapshot e estes eventos se encaixam sem repetir nem faltar.
 */
export function applyLive(items: ChatItem[], e: ChatEvent): ChatItem[] {
  if (e.type === 'item') {
    const i = items.findIndex((x) => x.id === e.item.id);
    if (i === -1) return [...items, e.item];
    const next = items.slice();
    next[i] = e.item;
    return next;
  }
  if (e.type === 'delta') return items.map((x) => (x.id === e.id && x.kind === 'assistant' ? { ...x, text: x.text + e.text } : x));
  return items;
}

/**
 * O histórico (transcript) e o que veio ao vivo, numa lista só. O servidor corta o histórico no instante em que o primeiro item
 * ao vivo começa; a folga de milissegundos entre os dois relógios pode repetir o item da emenda (uma ferramenta tem o mesmo id
 * nos dois): fica o ao vivo, que é o mais novo.
 */
export function mergeItems(history: ChatItem[], live: ChatItem[], held: ChatItem[]): ChatItem[] {
  if (!live.length) return [...history, ...held];
  const ids = new Set(live.map((i) => i.id));
  return [...history.filter((i) => !ids.has(i.id)), ...live, ...held];
}

/**
 * O processo se foi (o snapshot veio sem `live`): o transcript já tem as mensagens, as respostas e as ferramentas, então o que
 * sobrou ao vivo só repetiria. Fica o que só existe ao vivo e não está no histórico: os avisos do servidor (o erro com que a
 * conversa terminou, a negação de uma ferramenta, "turno interrompido"). Não ficam os avisos que o servidor refaz sozinho sem o
 * processo (o botão de cancelar o "continue" e o despertador voltam do que está guardado, já no histórico) nem um aviso de texto
 * igual a um que o histórico já traz (a compactação está nos dois lados, com ids diferentes).
 */
export function liveOnlyNotices(live: ChatItem[], history: ChatItem[]): ChatItem[] {
  const inHistory = new Set(history.flatMap((i) => (i.kind === 'notice' ? [i.text] : [])));
  return live.filter((i) => i.kind === 'notice' && !i.action && !i.wake && !inHistory.has(i.text));
}

export interface ChatWindow {
  /** O que pintar, na ordem da conversa. */
  items: ChatItem[];
  /** Quantos itens ficaram de fora (os pedidos sem resposta, que são pintados mesmo antigos, não contam). */
  hidden: number;
  /** Quantos itens do fim a janela cobre (cresce além do pedido quando um `anchor` está mais acima). */
  shown: number;
}

/**
 * A janela da lista: os últimos `shown` itens. `anchors` são ids que precisam estar na tela (o balão que um aviso da caixa
 * "precisa de mim" aponta): a janela abre até o mais antigo deles. Pedido sem resposta fora da janela é pintado do mesmo jeito.
 */
export function renderWindow(items: ChatItem[], shown: number, anchors: ReadonlyArray<string | null | undefined> = []): ChatWindow {
  let start = Math.max(0, items.length - shown);
  for (const id of anchors) {
    if (!id) continue;
    const at = items.findIndex((i) => i.id === id);
    if (at !== -1 && at < start) start = at;
  }
  if (start === 0) return { items, hidden: 0, shown: items.length };
  let hidden = start;
  const out: ChatItem[] = [];
  items.forEach((it, i) => {
    if (i >= start) out.push(it);
    else if (asksYou(it)) {
      out.push(it);
      hidden--;
    }
  });
  return { items: out, hidden, shown: items.length - start };
}
