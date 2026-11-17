import type { TaskQuestion } from '../../../shared/model';

// Responder a dúvida escalada pelo detalhe da tarefa: o que você marca ou escreve e o corpo que a rota recebe
// (POST /api/projects/:id/tasks/:taskId/answer, a mesma do gestor; vinda do navegador pareado, a resposta vale como sua).
// Sem React, para testar.

/** Teto do texto da resposta (o servidor recusa acima disso; é o mesmo da dúvida escrita). */
export const ANSWER_MAX = 2000;
/** Teto de cada opção e de cada pergunta como chave (o servidor recusa acima disso). */
const PART_MAX = 500;

/** Opções marcadas por pergunta; o índice é a posição em `question.questions`. */
export type Picks = string[][];

export interface AnswerBody {
  questionId: string;
  answers?: Record<string, string | string[]>;
  text?: string;
}

/** Dúvida por opções com ao menos uma pergunta, ou dúvida escrita: as duas que a tela sabe responder. */
export function canAnswer(q: TaskQuestion): boolean {
  return q.source === 'ask' ? !!q.questions?.length : true;
}

export const emptyPicks = (q: TaskQuestion): Picks => (q.questions ?? []).map(() => []);

/** Marca ou desmarca uma opção. Escolha única: marcar outra troca, marcar a mesma tira. Várias: alterna só aquela. */
export function togglePick(picks: Picks, index: number, option: string, multi: boolean): Picks {
  return picks.map((list, i) => {
    if (i !== index) return list;
    const on = list.includes(option);
    if (multi) return on ? list.filter((x) => x !== option) : [...list, option];
    return on ? [] : [option];
  });
}

/**
 * O corpo da resposta, ou null enquanto falta algo: por opções, toda pergunta com ao menos uma opção marcada; escrita, texto não vazio
 * e até `ANSWER_MAX`. Múltipla escolha vai como lista, escolha única como o texto da opção; a chave é o texto da pergunta.
 */
export function answerBody(q: TaskQuestion, picks: Picks, text: string): AnswerBody | null {
  if (!canAnswer(q)) return null;
  if (q.source === 'ask') {
    const asked = q.questions ?? [];
    // Pares e Object.fromEntries no fim: a pergunta pode se chamar "__proto__", e `obj[k] = v` a perderia.
    const pairs: Array<[string, string | string[]]> = [];
    for (let i = 0; i < asked.length; i++) {
      const list = (picks[i] ?? []).filter((o) => asked[i]!.options.includes(o));
      if (!list.length || asked[i]!.question.length > PART_MAX || list.some((o) => o.length > PART_MAX)) return null;
      pairs.push([asked[i]!.question, asked[i]!.multiSelect ? list : list[0]!]);
    }
    return { questionId: q.id, answers: Object.fromEntries(pairs) };
  }
  const body = text.trim();
  return body && body.length <= ANSWER_MAX ? { questionId: q.id, text: body } : null;
}
