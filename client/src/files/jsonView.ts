// Regras puras da visualização de .json: ler o texto (só JSON.parse, nunca eval) e dizer onde o erro está.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonContainer = JsonValue[] | { [key: string]: JsonValue };

export type JsonParse =
  | { ok: true; value: JsonValue }
  | { ok: false; empty: true }
  | { ok: false; empty: false; message: string; line: number | null; column: number | null };

/** Até este tanto de nós a árvore abre inteira; acima disso só a raiz abre (o resto abre sob demanda). */
export const OPEN_ALL_MAX = 200;
/** Filhos mostrados por vez em cada objeto/lista; "mostrar mais" dobra. */
export const PAGE = 100;
/** Texto maior que isto aparece cortado, com "mostrar tudo". */
export const STRING_MAX = 1000;

export const isContainer = (v: JsonValue): v is JsonContainer => v !== null && typeof v === 'object';

/** Linha e coluna (a partir de 1) de um deslocamento no texto. */
function lineColumn(text: string, offset: number): { line: number; column: number } {
  const upTo = text.slice(0, Math.min(Math.max(offset, 0), text.length));
  const line = upTo.split('\n').length;
  return { line, column: upTo.length - (upTo.lastIndexOf('\n') + 1) + 1 };
}

class Reject extends Error {
  constructor(readonly at: number) {
    super('json');
  }
}

/**
 * Deslocamento do primeiro caractere que o JSON não aceita, ou null. Só serve para apontar o erro quando o motor não diz onde
 * (o V8 não diz em "Unexpected token ',' … is not valid JSON", que é o caso de vírgula sobrando ou valor faltando; o Safari nunca diz).
 */
export function findJsonError(s: string): number | null {
  let i = 0;
  // `function` (e não const): só assim o TS entende que depois do reject() nada segue.
  function reject(): never {
    throw new Reject(i);
  }
  const space = () => {
    while (i < s.length && ' \t\n\r'.includes(s[i]!)) i++;
  };
  const string = () => {
    i++;
    for (;;) {
      const c = s[i];
      if (c === undefined || c < ' ') reject();
      if (c === '"') return void i++;
      if (c === '\\') {
        i++;
        const e = s[i];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) reject();
          i += 4;
        } else if (e === undefined || !'"\\/bfnrt'.includes(e)) reject();
      }
      i++;
    }
  };
  const number = () => {
    const m = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const hit = m.exec(s);
    if (!hit) {
      i += s[i] === '-' ? 1 : 0;
      reject();
    }
    i += hit![0].length;
  };
  const value = (): void => {
    space();
    const c = s[i];
    if (c === '{') {
      i++;
      space();
      if (s[i] === '}') return void i++;
      for (;;) {
        space();
        if (s[i] !== '"') reject();
        string();
        space();
        if (s[i] !== ':') reject();
        i++;
        value();
        space();
        if (s[i] === ',') i++;
        else if (s[i] === '}') return void i++;
        else reject();
      }
    }
    if (c === '[') {
      i++;
      space();
      if (s[i] === ']') return void i++;
      for (;;) {
        value();
        space();
        if (s[i] === ',') i++;
        else if (s[i] === ']') return void i++;
        else reject();
      }
    }
    if (c === '"') return string();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return number();
    for (const word of ['true', 'false', 'null']) {
      if (s.startsWith(word, i)) return void (i += word.length);
    }
    reject();
  };
  try {
    value();
    space();
    if (i < s.length) reject();
    return null;
  } catch (e) {
    return e instanceof Reject ? e.at : null;
  }
}

/** O motor diz a posição de um jeito (V8: "position 12" e, nas versões novas, "(line 2 column 5)"; Firefox: "line 2 column 5"); sem isso, o `findJsonError` procura. */
function locate(message: string, text: string): { line: number | null; column: number | null } {
  const lc = /line (\d+) column (\d+)/i.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  const pos = /position (\d+)/i.exec(message);
  const at = pos ? Number(pos[1]) : findJsonError(text);
  return at === null ? { line: null, column: null } : lineColumn(text, at);
}

/** BOM do começo não faz parte do JSON (e o JSON.parse o recusa). */
export function parseJson(text: string): JsonParse {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src.trim() === '') return { ok: false, empty: true };
  try {
    return { ok: true, value: JSON.parse(src) as JsonValue };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, empty: false, message, ...locate(message, src) };
  }
}

/** Conta os nós, mas para quando passa de `limit` (a profundidade da recursão fica no limite, e o custo também). */
export function countNodes(value: JsonValue, limit: number): number {
  let n = 0;
  const walk = (v: JsonValue) => {
    if (++n > limit || !isContainer(v)) return;
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      walk(child);
      if (n > limit) return;
    }
  };
  walk(value);
  return n;
}

/** Abre a árvore inteira só quando é pequena. */
export const opensAll = (value: JsonValue): boolean => countNodes(value, OPEN_ALL_MAX) <= OPEN_ALL_MAX;
