import type { ChatItem } from '../../../shared/model';

// Conversa comprida pesa na aba (cada mensagem é um bloco de DOM com Markdown): a tela guarda só os itens recentes do que
// chega ao vivo e pinta só o fim da lista, com um botão para trazer os anteriores. Aqui só a conta (testável, sem DOM); o
// uso está em useChat.ts (guardar) e ChatView.tsx (pintar).

/**
 * Quantos itens do que chega ao vivo a tela guarda. É o mesmo número do servidor (MAX_LIVE_ITEMS em server/chat/process.ts):
 * o que sai daqui já saiu de lá, e volta do transcript quando a conversa é relida (o snapshot põe o histórico até onde o
 * stream começa).
 */
export const LIVE_KEEP = 400;

/** Quantos itens do fim a lista pinta de começo, e quantos mais cada clique em "mostrar anteriores" traz. */
export const WINDOW_STEP = 200;

/** Um pedido seu sem resposta (permissão, pergunta, plano) nunca some da lista, por mais antigo que seja. */
const asksYou = (i: ChatItem): boolean => i.kind === 'permission' && i.status === 'pending';

/**
 * Corta o que veio ao vivo para os últimos `keep` itens. Ficam além do limite os pedidos sem resposta e as ferramentas
 * que ainda rodam (sem resultado): o resultado, ao chegar, troca o item pelo id.
 */
export function trimLive(items: ChatItem[], keep = LIVE_KEEP): ChatItem[] {
  if (items.length <= keep) return items;
  const first = items.length - keep;
  return items.filter((it, i) => i >= first || asksYou(it) || (it.kind === 'tool' && it.result === null));
}

/**
 * O histórico (transcript) e o que veio ao vivo, numa lista só. O servidor corta o histórico no instante em que o stream
 * começa; a folga de milissegundos entre os dois relógios pode repetir o item da emenda (uma ferramenta tem o mesmo id nos
 * dois): fica o ao vivo, que é o mais novo.
 */
export function mergeItems(history: ChatItem[], live: ChatItem[], held: ChatItem[]): ChatItem[] {
  if (!live.length) return [...history, ...held];
  const ids = new Set(live.map((i) => i.id));
  return [...history.filter((i) => !ids.has(i.id)), ...live, ...held];
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
