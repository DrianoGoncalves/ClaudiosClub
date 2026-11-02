import type { AskedQuestion, QuestionAnnotations, QuestionAnswers } from '../../../shared/model';

// O que o cartão de pergunta (QuestionCard) guarda enquanto você responde, e como isso vira as
// respostas que o Claude lê. Sem React aqui, para testar.

/** `picked`: opções marcadas (uma só, ou várias no multiSelect). `typed`: "outra resposta", o texto livre ou o número. */
export interface Draft {
  picked: string[];
  typed: string;
}

export function initialDrafts(questions: AskedQuestion[]): Draft[] {
  return questions.map((q) => ({ picked: [], typed: q.kind === 'number' && q.defaultValue !== undefined ? String(q.defaultValue) : '' }));
}

/** O número escrito: vazio (sem resposta), válido (dentro de min..max) ou inválido. */
export function numberState(q: AskedQuestion, typed: string): 'empty' | 'ok' | 'invalid' {
  if (!typed.trim()) return 'empty';
  const n = Number(typed);
  return Number.isFinite(n) && n >= (q.min ?? -Infinity) && n <= (q.max ?? Infinity) ? 'ok' : 'invalid';
}

/** A opção cuja prévia aparece: só na escolha única, e some se você escreveu outra resposta. */
export function previewOption(q: AskedQuestion, d: Draft) {
  if (q.kind !== 'choice' || q.multiSelect || d.typed.trim()) return undefined;
  const o = q.options.find((x) => x.label === d.picked[0]);
  return o?.preview ? o : undefined;
}

/**
 * Respostas para o Claude: escolha única = o texto da opção (ou o que você escreveu no lugar);
 * várias = lista, com o que você escreveu entrando junto; texto e número = o que está na caixa.
 * Pergunta sem resposta não entra. `invalid`: algum número fora de min..max.
 */
export function collectAnswers(questions: AskedQuestion[], drafts: Draft[]): { answers: QuestionAnswers; annotations: QuestionAnnotations; invalid: boolean } {
  // Pares e Object.fromEntries no fim: a pergunta pode se chamar "__proto__", e `obj[k] = v` a perderia.
  const answers: Array<[string, string | string[]]> = [];
  const annotations: Array<[string, { preview: string }]> = [];
  let invalid = false;
  questions.forEach((q, i) => {
    const d = drafts[i] ?? { picked: [], typed: '' };
    const typed = d.typed.trim();
    if (q.kind === 'text') {
      if (typed) answers.push([q.question, typed]);
    } else if (q.kind === 'number') {
      const state = numberState(q, d.typed);
      if (state === 'invalid') invalid = true;
      if (state === 'ok') answers.push([q.question, String(Number(d.typed))]);
    } else if (q.multiSelect) {
      const list = q.options.filter((o) => d.picked.includes(o.label)).map((o) => o.label);
      if (typed && !list.includes(typed)) list.push(typed);
      if (list.length) answers.push([q.question, list]);
    } else {
      const value = typed || d.picked[0];
      if (value) answers.push([q.question, value]);
      const preview = previewOption(q, d)?.preview;
      if (preview) annotations.push([q.question, { preview }]);
    }
  });
  return { answers: Object.fromEntries(answers), annotations: Object.fromEntries(annotations), invalid };
}

/** A resposta gravada de uma pergunta, se houver. Propriedade própria: "__proto__" não puxa o protótipo. */
export function answerOf(answers: QuestionAnswers, question: string): string | string[] | undefined {
  return Object.hasOwn(answers, question) ? answers[question] : undefined;
}

/**
 * A prévia da opção para o iframe (sem scripts). Texto puro, sem tags, vira bloco monoespaçado.
 * A CSP vem antes do conteúdo: nada de fora carrega (imagem, fonte, link); só `data:` em imagem.
 */
export function previewDoc(preview: string): string {
  const html = /<[a-z!][^>]*>/i.test(preview)
    ? preview
    : `<pre style="margin:0;white-space:pre-wrap;font:12px ui-monospace,Consolas,monospace">${preview.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`;
  return `<!doctype html>${csp}<meta charset="utf-8"><body style="margin:8px;font:13px system-ui,sans-serif;color:#1f2328;background:#fff">${html}`;
}

/** Como a resposta aparece no cartão já respondido. */
export function answerText(a: string | string[] | undefined): string | null {
  if (a === undefined) return null;
  return Array.isArray(a) ? a.join(', ') : a;
}
