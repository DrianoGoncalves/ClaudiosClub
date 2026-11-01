import type { ChatItem } from '../../../shared/model';

// Achar, na conversa, o ponto que um aviso da caixa "precisa de mim" aponta: o balão (itemId) e, nas
// perguntas, o trecho dele (quote). Aqui só a parte sem DOM (testável); a rolagem está em useChatFocus.ts.

/** O alvo de um clique no aviso. `nonce` muda a cada clique: clicar de novo no mesmo aviso rola de novo. */
export interface ChatFocus {
  /** De quem é o aviso (projeto e funcionário; null = conversa sem ficha): o painel só aceita a conversa dele. */
  projectId: string;
  staffId: string | null;
  /** A conversa do aviso: o alvo só vale nela. */
  sessionId: string;
  /** Id do `ChatItem` a mostrar (cartão de permissão ou plano, balão da resposta). */
  itemId?: string;
  /** A pergunta detectada no texto da resposta (o começo dela basta para achar o trecho). */
  quote?: string;
  nonce: number;
}

/** Quantos caracteres do começo da pergunta valem para comparar. */
const NEEDLE_LENGTH = 40;
/** Só as últimas respostas entram na busca da pergunta quando o aviso não traz o balão. */
const RECENT_ANSWERS = 6;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** `&amp;` `&lt;` `&#39;`…: o texto que a tela mostra para a entidade; as desconhecidas ficam como estão. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** O que se lê, sem Markdown: sem link/ênfase/código/escape, entidades decodificadas, minúsculas, espaços normalizados. */
export function plainText(s: string): string {
  return decodeEntities(
    s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // link e imagem: fica o texto (o alt)
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]*)>/gi, '$1') // <https://…>: a tela mostra o endereço
      .replace(/\\([^\sa-z0-9])|[*_`~]/gi, (_, escaped?: string) => escaped ?? ''), // ênfase some; \* \_ …: fica o sinal, sem a barra
  )
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Só letras e números, minúsculas e sem acento: o que sobra quando pontuação e símbolos não contam. */
export function foldText(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** A chave de comparação, a mesma para a agulha e para o texto onde se procura. */
const key = (s: string) => foldText(plainText(s));

/** O começo da pergunta para procurar no texto, sem o marcador de lista ("3. ", "- ", "> "), que na tela é desenho. */
export function quoteNeedle(quote: string): string {
  return plainText(quote)
    .replace(/^(?:(?:[-+>#]+|\d+[.)])\s+)+/, '')
    .slice(0, NEEDLE_LENGTH)
    .trim();
}

/** Entre os trechos de um balão (parágrafo, item de lista…), o menor que traz o começo da pergunta; -1 se nenhum. */
export function findQuoteIndex(parts: string[], quote: string): number {
  const needle = foldText(quoteNeedle(quote));
  if (!needle) return -1;
  let best = -1;
  let bestLength = Infinity;
  parts.forEach((part, i) => {
    const text = key(part);
    // `<=`: num empate (item de lista e o parágrafo dentro dele), fica o mais interno.
    if (text.includes(needle) && text.length <= bestLength) {
      best = i;
      bestLength = text.length;
    }
  });
  return best;
}

/** Sem o id do balão: o balão mais recente, entre as últimas respostas, que traz a pergunta. */
export function findQuoteItem(items: ChatItem[], quote: string): string | null {
  const needle = foldText(quoteNeedle(quote));
  if (!needle) return null;
  const answers = items.filter((i): i is Extract<ChatItem, { kind: 'assistant' }> => i.kind === 'assistant' && !!i.text);
  for (const a of answers.slice(-RECENT_ANSWERS).reverse()) if (key(a.text).includes(needle)) return a.id;
  return null;
}

/** `scrollTop` que põe o trecho no centro da área visível; se ele for mais alto que ela, no começo. */
export function centerScrollTop(viewHeight: number, top: number, height: number, margin = 12): number {
  if (height > viewHeight - 2 * margin) return Math.max(0, top - margin);
  return Math.max(0, top - (viewHeight - height) / 2);
}

/** `scrollTop` que põe o FIM do trecho na parte de baixo da área visível (a pergunta fica no fim da resposta). */
export function endScrollTop(viewHeight: number, top: number, height: number, margin = 12): number {
  return Math.max(0, top + height - viewHeight + margin);
}
