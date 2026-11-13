import { z } from 'zod';
import type { AskedQuestion, QuestionAnnotations, QuestionAnswers } from '../../shared/model';

// Perguntas com opções do Claude Code (ferramenta AskUserQuestion). Chegam como um pedido de
// permissão; quem responde devolve as respostas dentro de `updatedInput`. O formato vem do
// Claude Code, então tudo que é lido daqui é validado e o que não for conhecido é ignorado.

export const ASK_TOOL = 'AskUserQuestion';

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 12;

/** Texto para exibir: sem espaço nas pontas, cortado no limite. */
function text(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/**
 * Texto que vira chave ou valor da resposta (a pergunta e o label da opção): sem trim e sem corte,
 * do jeito que o Claude Code mandou. Vazio (só espaço) ou longo demais é `undefined`, e aí a entrada
 * cai no cartão genérico em vez de ser cortada.
 */
function exact(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v : undefined;
}

/** Propriedade própria do objeto (sem puxar do protótipo, então "__proto__" não dá erro nem lixo). */
function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * As perguntas da entrada de AskUserQuestion, ou null se a entrada não faz sentido (aí o pedido
 * cai no cartão genérico de permissão). `kind` ausente é "choice".
 */
export function parseQuestions(input: unknown): AskedQuestion[] | null {
  const raw = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_QUESTIONS) return null;
  const out: AskedQuestion[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') return null;
    const q = r as Record<string, unknown>;
    const question = exact(q.question, 1_000);
    const kind = q.kind === undefined ? 'choice' : q.kind;
    if (!question || (kind !== 'choice' && kind !== 'text' && kind !== 'number')) return null;
    if (out.some((o) => o.question === question)) return null; // a pergunta é a chave da resposta
    const base = { question, header: text(q.header, 100) ?? '', kind, multiSelect: q.multiSelect === true } as const;
    const description = text(q.description, 1_000);
    const extra = description ? { description } : {};
    if (kind === 'text') {
      const placeholder = text(q.placeholder, 200);
      out.push({ ...base, multiSelect: false, options: [], ...extra, ...(placeholder && { placeholder }) });
    } else if (kind === 'number') {
      const min = num(q.min);
      const max = num(q.max);
      if (min === undefined || max === undefined || min > max) return null;
      const step = num(q.step);
      const defaultValue = num(q.defaultValue);
      const unit = text(q.unit, 20);
      out.push({
        ...base,
        multiSelect: false,
        options: [],
        ...extra,
        min,
        max,
        ...(step !== undefined && step > 0 && { step }),
        ...(defaultValue !== undefined && defaultValue >= min && defaultValue <= max && { defaultValue }),
        ...(unit && { unit }),
      });
    } else {
      if (!Array.isArray(q.options) || q.options.length < 1) return null;
      const options: AskedQuestion['options'] = [];
      for (const o of q.options.slice(0, MAX_OPTIONS)) {
        const op = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
        const label = exact(op.label, 200);
        if (!label || options.some((x) => x.label === label)) return null;
        const preview = text(op.preview, 20_000);
        options.push({ label, description: text(op.description, 1_000) ?? '', ...(preview && { preview }) });
      }
      out.push({ ...base, options, ...extra });
    }
  }
  return out;
}

/**
 * As respostas que valem: só de perguntas que existem, sem resposta vazia. Uma opção de escolha
 * única vira texto; várias, lista. As anotações só ficam para perguntas respondidas. Chave e valor
 * saem como vieram (são a pergunta e o label exatos); só o vazio é descartado.
 */
export function cleanAnswers(
  questions: AskedQuestion[],
  answers: unknown,
  annotations: unknown,
): { answers: QuestionAnswers; annotations: QuestionAnnotations } {
  const a = (answers && typeof answers === 'object' ? answers : {}) as Record<string, unknown>;
  const n = (annotations && typeof annotations === 'object' ? annotations : {}) as Record<string, unknown>;
  const outAnswers: Array<[string, string | string[]]> = [];
  const outNotes: Array<[string, { preview?: string; notes?: string }]> = [];
  for (const q of questions) {
    const v = own(a, q.question);
    const value: string | string[] = Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      : typeof v === 'string' && v.trim()
        ? v
        : '';
    if (Array.isArray(value) ? !value.length : !value) continue;
    outAnswers.push([q.question, value]);
    const note = own(n, q.question) as { preview?: unknown; notes?: unknown } | undefined;
    const preview = text(note?.preview, 20_000);
    const notes = text(note?.notes, 2_000);
    if (preview || notes) outNotes.push([q.question, { ...(preview && { preview }), ...(notes && { notes }) }]);
  }
  // Object.fromEntries (e não `obj[k] = v`) mantém "__proto__" como chave própria.
  return { answers: Object.fromEntries(outAnswers), annotations: Object.fromEntries(outNotes) };
}

/**
 * `answers` e `annotations` do corpo do pedido: um objeto cujas chaves são as perguntas. O
 * `z.record` do zod descarta a chave "__proto__", então aqui o objeto vira pares e volta por
 * Object.fromEntries. Para chaves comuns, o resultado é igual ao de z.record.
 */
function byQuestion<V extends z.ZodTypeAny>(value: V) {
  return z
    .unknown()
    .refine((v) => v !== null && typeof v === 'object' && !Array.isArray(v), 'esperado um objeto')
    .transform((v) => Object.entries(v as object))
    .pipe(z.array(z.tuple([z.string().max(1_000), value]) as z.ZodType<[string, z.output<V>], [string, z.input<V>]>))
    .transform((pairs) => Object.fromEntries(pairs));
}

export const AnswersField = byQuestion(z.union([z.string().max(5_000), z.array(z.string().max(5_000)).max(20)])).optional();
export const AnnotationsField = byQuestion(z.object({ preview: z.string().max(20_000).optional(), notes: z.string().max(5_000).optional() })).optional();
