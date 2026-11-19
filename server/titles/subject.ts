import { hasCheckpoint, isInjectedUserText, stripCheckpoint } from '../chat/items';

// Assunto da conversa, com a mesma regra para o Claude e para o Codex. Cada motor lê o próprio formato (transcript ou
// rollout) e manda as mensagens em ordem; daqui sai o assunto atual e a mensagem que o começou.

/** Uma mensagem do texto da conversa. `key` é o id estável dela (uuid do transcript; ordinal do rollout). */
export interface SubjectEvent {
  role: 'user' | 'assistant';
  text: string;
  key: string;
}

/**
 * Tarefa: o título é o assunto (não gera título).
 * Revisão: a conversa abriu com o pedido de revisão de `task` (o título da tarefa, sem prefixo); não gera título, e a tela
 * monta "<coluna Revisão> - <tarefa>" (`Session.reviewTask`).
 * Livre: começou numa mensagem sua; `reply` é a 1ª resposta do assistente.
 */
export type Subject =
  | { kind: 'task'; title: string }
  | { kind: 'review'; task: string }
  | { kind: 'free'; key: string; text: string; reply?: string };

export interface SubjectState {
  topic: string | null;
  /** Depois de um ponto de corte: o próximo assunto é a próxima mensagem substantiva. */
  waiting: boolean;
  subject: Subject | null;
}

export interface SubjectView {
  topic: string | null;
  subject: Subject | null;
}

/** Limites do que vai ao gerador de título (ver titles/generator.ts): o resto da mensagem não fica guardado. */
export const START_MAX = 1200;
export const REPLY_MAX = 600;
const TOPIC_MAX = 80;

const TASK = /^\[Tarefa "(.+?)"\]/;
/** O pedido de revisão que o Club manda ao revisor (ver TaskService.requestReview). */
const REVIEW = /^\[Revisão da tarefa "(.+?)"\]/;
/** A saudação de sessão nova ("Olá, X. Leia sua memória…") não é assunto. */
const GREETING = /^Olá, [^.]+\. Leia sua (memória|ficha)/;

/** Palavras de confirmação (pt/en/es), sem acento. Lista fechada: "Corrige o bug" é assunto, "ok, valeu" não. */
const CONFIRMATION_WORDS = new Set(
  'ok okay oks blz beleza certo certinho perfeito otimo show top valeu vlw obrigado obrigada brigado grato sim nao pode seguir segue siga continua continue manda bora aprovado aprovada entendi combinado feito isso fechado thanks thank you yes no go ahead great nice gracias si vale perfecto listo de acordo'.split(' '),
);

export function initialSubjectState(): SubjectState {
  return { topic: null, waiting: false, subject: null };
}

export function subjectView(st: SubjectState): SubjectView {
  return { topic: st.topic, subject: st.subject };
}

/** O título da tarefa em revisão (`Session.reviewTask`) se a conversa é de revisão e não virou de assunto; senão null. */
export function reviewTaskOf(view: SubjectView): string | null {
  return view.subject?.kind === 'review' ? view.subject.task : null;
}

/** Aplica uma mensagem ao estado. A ordem das chamadas é a ordem da conversa. */
export function feedSubject(st: SubjectState, ev: SubjectEvent): void {
  if (ev.role === 'assistant') {
    if (hasCheckpoint(ev.text)) st.waiting = true;
    // Só a 1ª resposta do assistente depois do início (o turno que fecha o assunto, ou o que começou a responder).
    if (st.subject?.kind === 'free' && st.subject.reply === undefined) {
      const reply = stripCheckpoint(ev.text).trim();
      if (reply) st.subject = { ...st.subject, reply: reply.slice(0, REPLY_MAX) };
    }
    return;
  }
  const text = ev.text.trim();
  const task = TASK.exec(text);
  if (task) {
    st.topic = clipTopic(task[1]!);
    st.waiting = false;
    st.subject = { kind: 'task', title: st.topic };
    return;
  }
  // Só como abertura da conversa: a mesma linha volta à conversa de trabalho quando a revisão reprova, e ali não troca o assunto.
  const review = st.topic === null ? REVIEW.exec(text) : null;
  if (review) {
    st.topic = clipTopic(review[1]!);
    st.waiting = false;
    st.subject = { kind: 'review', task: st.topic };
    return;
  }
  // Pula o que o Claude Code ou o Claudio’s Club injetam, e a saudação.
  if (!text || isInjectedUserText(text) || text.startsWith('[MyCo]') || GREETING.test(text)) return;
  if (st.waiting) {
    if (isShortConfirmation(text)) return;
    st.waiting = false;
    startFree(st, ev.key, text);
    return;
  }
  // Sem virada: só a 1ª mensagem sua define o assunto.
  if (st.topic === null) startFree(st, ev.key, text);
}

function startFree(st: SubjectState, key: string, text: string): void {
  st.topic = clipTopic(text.split(/\r?\n/)[0]!);
  st.subject = { kind: 'free', key, text: text.slice(0, START_MAX) };
}

/** "ok", "obrigado", "pode seguir": só palavras de confirmação, sem pergunta. Não é um assunto novo. */
function isShortConfirmation(text: string): boolean {
  if (text.includes('?')) return false;
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return words.length <= 4 && words.every((w) => CONFIRMATION_WORDS.has(w));
}

function clipTopic(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > TOPIC_MAX ? `${one.slice(0, TOPIC_MAX - 1)}…` : one;
}
