// A entrada de uma chamada de AskUserQuestion, lida para a tela: em vez do JSON, os campos que a pessoa entende.
// Leitura solta de propósito (diferente do cartão de resposta): mostra o que houver, e sem perguntas legíveis devolve null.

export interface ReadableAsk {
  question: string;
  header?: string;
  description?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
  /** Pergunta de texto livre ou de número (o cartão de resposta aceita as duas). */
  kind?: 'text' | 'number';
  placeholder?: string;
  min?: number;
  max?: number;
  unit?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** As perguntas do JSON da entrada, ou null se não for esse formato (o texto cru fica como está). */
export function readAsk(input: string): ReadableAsk[] | null {
  let raw: unknown;
  try {
    raw = (JSON.parse(input) as { questions?: unknown } | null)?.questions;
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const out: ReadableAsk[] = [];
  for (const r of raw) {
    const q = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const question = str(q.question);
    if (!question) continue;
    const options = (Array.isArray(q.options) ? q.options : []).flatMap((o) => {
      const op = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
      const label = str(op.label);
      return label ? [{ label, ...(str(op.description) && { description: str(op.description) }) }] : [];
    });
    out.push({
      question,
      multiSelect: q.multiSelect === true,
      options,
      ...(str(q.header) && { header: str(q.header) }),
      ...(str(q.description) && { description: str(q.description) }),
      ...((q.kind === 'text' || q.kind === 'number') && { kind: q.kind }),
      ...(str(q.placeholder) && { placeholder: str(q.placeholder) }),
      ...(num(q.min) !== undefined && { min: num(q.min) }),
      ...(num(q.max) !== undefined && { max: num(q.max) }),
      ...(str(q.unit) && { unit: str(q.unit) }),
    });
  }
  return out.length ? out : null;
}
