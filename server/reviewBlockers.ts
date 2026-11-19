import type { Rejection, ReviewBlocker } from '../shared/model';

// A reprovação da revisão com itens (t-33b84c): o revisor fecha o REPROVADO com um bloco `[BLOQUEADORES]`, uma linha por 🔴 (id estável Rn, arquivo:linha, problema,
// como provar). Aqui ficam só as funções puras (ler o bloco, cortar o texto sem perder 🔴, o que o revisor lê); quem grava e manda é `TaskService.reject` / `requestReview`.

/** Marcas do bloco. */
export const BLOCK_OPEN = '[BLOQUEADORES]';
export const BLOCK_CLOSE = '[/BLOQUEADORES]';
/** Linhas do bloco: acima disso o bloco vale como malformado (um revisor com 30 bloqueadores não está dando itens, está devolvendo a tarefa). */
export const BLOCKERS_MAX = 30;
/** O texto do revisor que vai ao executor: acima disso só a parte sem 🔴 é cortada (ver `fitReviewText`). */
export const FORWARD_MAX = 4000;
/** A resposta do executor que o card guarda, para o pedido da rodada seguinte. */
export const REPLY_MAX = 6000;
/** Reprovações guardadas por card (as mais antigas saem). */
export const REJECTIONS_MAX = 10;
/** Tamanho de cada campo de uma linha do bloco, guardado no card (o texto completo do revisor segue ao executor de qualquer jeito). */
const FIELD_MAX = { where: 200, problem: 600, proof: 600 } as const;

const LINES = /\r\n|[\r\n\v\f\u0085\p{Zl}\p{Zp}]/u;
/** A linha só com a marca, tolerando markdown em volta (`**[BLOQUEADORES]**`, `> `, crase). */
const markOf = (line: string): string => line.replace(/[\s*_`>#-]/g, '').toUpperCase();
const FENCE = /^\s*(`{3,}|~{3,})/;
const ID = /^R([1-9]\d{0,2})$/i;
const CUT_MARK = '[… trecho sem 🔴 cortado …]';

export interface ParsedBlock {
  status: Rejection['block'];
  blockers: ReviewBlocker[];
  /** Por que veio malformado, ou o que não bateu com as rodadas anteriores (id reaproveitado): vai ao executor e fica no card. */
  warnings: string[];
  /** O texto do revisor sem o bloco (com bloco `ok`, as linhas dele já estão na lista; senão, o texto inteiro). */
  rest: string;
}

/** O que a rodada anterior deixou: os ids abertos (que um bloco novo pode repetir) e o maior número já usado (os novos têm de passar dele). */
export interface PriorBlockers {
  open: string[];
  maxId: number;
}

/** A rodada anterior, para a regra dos ids: os abertos são os da última reprovação; o maior é o de todas as guardadas. */
export function priorBlockers(rejections: Rejection[] | undefined): PriorBlockers {
  const all = rejections ?? [];
  const nums = all.flatMap((r) => r.blockers.map((b) => Number(b.id.slice(1))));
  return { open: (all.at(-1)?.blockers ?? []).map((b) => b.id), maxId: nums.length ? Math.max(...nums) : 0 };
}

const squash = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/**
 * Lê o bloco de bloqueadores do texto do revisor. `absent`: sem marca nenhuma. `malformed`: marca solta ou repetida, fora de ordem, bloco vazio ou grande demais, linha sem os 4
 * campos (`Rn | arquivo:linha | problema | como provar`), id que não é `R<n>` (n de 1 a 999, sem zero à esquerda) ou repetido. Id que já foi usado e não estava aberto na rodada anterior
 * NÃO invalida o bloco (o atrito não compensa): vira aviso em `warnings`, e o executor lê o que valeu. O excedente de campos (um " | " dentro do texto) é colado no último.
 */
export function parseBlockers(text: string, prior: PriorBlockers = { open: [], maxId: 0 }): ParsedBlock {
  const lines = text.split(LINES);
  const opens = lines.flatMap((l, i) => (markOf(l) === BLOCK_OPEN.toUpperCase() ? [i] : []));
  const closes = lines.flatMap((l, i) => (markOf(l) === BLOCK_CLOSE.toUpperCase() ? [i] : []));
  const bad = (why: string): ParsedBlock => ({ status: 'malformed', blockers: [], warnings: [why], rest: text });
  if (!opens.length && !closes.length) return { status: 'absent', blockers: [], warnings: [], rest: text };
  if (opens.length !== 1 || closes.length !== 1) return bad(opens.length > 1 || closes.length > 1 ? 'mais de um bloco de bloqueadores' : 'bloco de bloqueadores sem abertura ou sem fechamento');
  const [from, to] = [opens[0]!, closes[0]!];
  if (to < from) return bad('o fechamento do bloco vem antes da abertura');

  const blockers: ReviewBlocker[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const [n, raw] of lines.slice(from + 1, to).entries()) {
    if (!raw.trim() || FENCE.test(raw)) continue;
    const cells = raw
      .replace(/^[\s>*+•-]*(?:🔴\s*)?/u, '')
      .replace(/^\|\s*|\s*\|\s*$/g, '')
      .split(/\s*\|\s*/);
    const where = `linha ${n + 1} do bloco`;
    if (cells.length < 4) return bad(`${where}: faltam campos (o formato é "Rn | arquivo:linha | problema | como provar")`);
    const id = ID.exec(cells[0]!.replace(/[*_`]/g, '').trim());
    if (!id) return bad(`${where}: o id "${squash(cells[0]!, 20)}" não é R1, R2…`);
    const [, file, problem, ...proof] = cells.map((c) => c.trim());
    if (!file || !problem || !proof.join(' | ')) return bad(`${where}: campo vazio`);
    const key = `R${id[1]}`;
    if (seen.has(key)) return bad(`${key} aparece duas vezes`);
    seen.add(key);
    if (!prior.open.includes(key) && Number(id[1]) <= prior.maxId) warnings.push(`${key} já foi usado numa rodada anterior e não estava aberto: confira se é o mesmo item reaberto ou um novo com número repetido`);
    blockers.push({ id: key, where: squash(file, FIELD_MAX.where), problem: squash(problem, FIELD_MAX.problem), proof: squash(proof.join(' | '), FIELD_MAX.proof) });
  }
  if (!blockers.length) return bad('o bloco está vazio');
  if (blockers.length > BLOCKERS_MAX) return bad(`bloqueadores demais (${blockers.length}; o máximo é ${BLOCKERS_MAX})`);
  const rest = [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { status: 'ok', blockers, warnings, rest };
}

/**
 * O texto do revisor para o executor, cabendo em `max` sem perder 🔴: separado em parágrafos (linha em branco), todo parágrafo com 🔴 fica inteiro (mesmo que passe do limite);
 * os outros entram na ordem enquanto couberem no que sobra, e cada trecho cortado vira um marcador. `cut`: os caracteres que saíram (0 = nada), para a mensagem avisar.
 */
export function fitReviewText(text: string, max = FORWARD_MAX): { text: string; cut: number } {
  const paras = text.trim().split(/\n[^\S\n]*\n\s*/).filter((p) => p.trim());
  const whole = paras.join('\n\n');
  if (whole.length <= max) return { text: whole, cut: 0 };
  let budget = max - paras.filter((p) => p.includes('🔴')).reduce((sum, p) => sum + p.length + 2, 0);
  const out: string[] = [];
  let cut = 0;
  let gap = false;
  for (const p of paras) {
    if (p.includes('🔴')) {
      out.push(p);
      gap = false;
    } else if (p.length + 2 <= budget) {
      budget -= p.length + 2;
      out.push(p);
      gap = false;
    } else {
      cut += p.length;
      if (!gap) out.push(CUT_MARK);
      gap = true;
    }
  }
  return { text: out.join('\n\n'), cut };
}

/** Os ids `Rn` que o texto cita (maiúsculos, sem repetir), lidos do texto inteiro. */
export function citedIds(text: string): string[] {
  return [...new Set((text.match(/\bR[1-9]\d{0,2}\b/gi) ?? []).map((id) => id.toUpperCase()))];
}

/**
 * A dúvida escrita (`DÚVIDA: …`) é sobre um 🔴 da reprovação `rej`? Sim se começa pelo id de um item aberto (`DÚVIDA: R2 — …`, ou `R1, R3`) e, sem bloco válido (não há ids), se
 * começa pelo 🔴. Só o começo vale: citar `R2` no meio do texto não manda a dúvida ao revisor.
 */
export function doubtIsAboutRejection(doubt: string, rej: Rejection): boolean {
  const body = doubt.replace(/^[^\S\n]*\**D[ÚU]VIDA:\s*\**\s*/i, '');
  if (rej.block !== 'ok') return body.startsWith('🔴');
  const lead = /^((?:R[1-9]\d{0,2}\b[\s,;/&e]*)+)/i.exec(body);
  return !!lead && citedIds(lead[1]!).some((id) => rej.blockers.some((b) => b.id === id));
}

/** O próximo id livre, para o revisor numerar os 🔴 novos. */
export const nextBlockerId = (prior: PriorBlockers): string => `R${prior.maxId + 1}`;

/** O formato que o pedido de revisão exige do REPROVADO. */
export const BLOCKERS_FORMAT = [
  'Se for REPROVADO, feche a resposta com o bloco de bloqueadores, exatamente neste formato: um bloco só, sem cerca de código, sem linha em branco dentro, uma linha por 🔴, os 4 campos separados por " | " (nunca " | " dentro de um campo):',
  BLOCK_OPEN,
  'R1 | arquivo:linha | o problema, em uma frase | como provar que foi corrigido (comando, teste ou o que ver no código)',
  BLOCK_CLOSE,
  'Todo 🔴 dos seus achados tem a sua linha no bloco, e só eles; os ids são R1, R2… na ordem. Em APROVADO não há bloco.',
].join('\n');
