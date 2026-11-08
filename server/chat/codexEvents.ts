import type { ChatItem } from '../../shared/model';
import { clip, inputText, toolSummary } from './items';

// Eventos do `codex exec --json` (uma linha JSON cada) → itens da conversa. Só funções puras, sem processo.
//
// Formato visto no Codex CLI 0.156.1 (amostras em tests/fixtures/codex/):
//   {"type":"thread.started","thread_id":"…"}                       começa a conversa (o id serve para o `exec resume`)
//   {"type":"turn.started"}
//   {"type":"item.started"|"item.updated"|"item.completed","item":{"id":"item_0","type":…}}
//   {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}
//   {"type":"turn.failed","error":{"message":…}}  e  {"type":"error","message":…}
// Tipos de item: agent_message {text}, reasoning {text}, command_execution {command, aggregated_output, exit_code, status},
// file_change {changes:[{path, kind: add|delete|update}], status}, mcp_tool_call {server, tool, arguments, result|error, status},
// web_search {query}, todo_list {items:[{text, completed}]}, error {message}. Os ids (`item_0`…) recomeçam a cada execução.

export type CodexPhase = 'started' | 'updated' | 'completed';

export interface CodexItem {
  id?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * O Codex mostra o comando como `/usr/bin/bash -lc 'ls -la'`: para a conversa interessa só o `ls -la`. Outro formato
 * (PowerShell, comando sem invólucro) fica como veio.
 */
export function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!m) return command;
  const body = m[1]!.trim();
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'\\''/g, "'");
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return body;
}

/** Ids dos itens se repetem entre execuções (`item_0`): o `key` da execução os torna únicos na conversa. */
export const itemId = (kind: 'a' | 't' | 'n', key: string, raw: CodexItem) => `${kind}:${key}:${asString(raw.id) || 'item'}`;

/** Texto de uma resposta do servidor MCP: blocos de texto (e `[tipo]` para o resto). */
function mcpResultText(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = asRecord(b);
      return block.type === 'text' && typeof block.text === 'string' ? block.text : block.type ? `[${asString(block.type)}]` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function tool(key: string, raw: CodexItem, at: string, name: string, input: unknown, summary: string, result: string | null, isError: boolean): ChatItem {
  return { kind: 'tool', id: itemId('t', key, raw), name, summary, input: inputText(input, name), result: result === null ? null : clip(result, 4_000), isError, at };
}

/** Resumo de um `file_change`: "add a.txt" ou "3 arquivos: a.txt, b.txt…". */
function changesSummary(changes: Array<{ path: string; kind: string }>): string {
  if (!changes.length) return 'alterações';
  const base = (p: string) => p.split(/[\\/]/).at(-1) || p;
  if (changes.length === 1) return `${changes[0]!.kind} ${base(changes[0]!.path)}`.slice(0, 160);
  return `${changes.length} arquivos: ${changes.map((c) => base(c.path)).join(', ')}`.slice(0, 160);
}

/**
 * Um item do Codex como item da conversa; null para o que não aparece (raciocínio, tipo desconhecido, mensagem vazia).
 * `agent_message` vira resposta; os de ferramenta (comando, edição, MCP, busca, lista) viram o cartão de ferramenta com
 * os mesmos nomes do Claude (Bash, Edit, WebSearch, TodoWrite, `mcp__servidor__ferramenta`); `error` é aviso (não é o fim do turno).
 */
export function itemFromCodex(raw: unknown, key: string, at: string, phase: CodexPhase): ChatItem | null {
  const it = asRecord(raw) as CodexItem;
  const done = phase === 'completed';
  switch (it.type) {
    case 'agent_message': {
      const text = asString(it.text);
      return text.trim() ? { kind: 'assistant', id: itemId('a', key, it), text, at } : null;
    }
    case 'command_execution': {
      const command = unwrapShell(asString(it.command));
      const exit = typeof it.exit_code === 'number' ? it.exit_code : null;
      const status = asString(it.status);
      const finished = done || (status !== '' && status !== 'in_progress');
      const failed = status === 'failed' || status === 'declined' || (exit !== null && exit !== 0);
      let out = asString(it.aggregated_output).trimEnd();
      if (finished && status === 'declined') out = [out, '[recusado pela sandbox]'].filter(Boolean).join('\n');
      else if (finished && failed && exit !== null) out = [out, `[código de saída ${exit}]`].filter(Boolean).join('\n');
      return tool(key, it, at, 'Bash', { command }, toolSummary('Bash', { command }), finished ? out : null, finished && failed);
    }
    case 'file_change': {
      const changes = (Array.isArray(it.changes) ? it.changes : []).map((c) => ({ path: asString(asRecord(c).path), kind: asString(asRecord(c).kind) || 'update' }));
      const status = asString(it.status);
      const finished = done || (status !== '' && status !== 'in_progress');
      const failed = status === 'failed';
      return tool(key, it, at, 'Edit', { changes }, changesSummary(changes), finished ? (failed ? 'A edição falhou.' : `${changes.length} ${changes.length === 1 ? 'arquivo alterado' : 'arquivos alterados'}`) : null, finished && failed);
    }
    case 'mcp_tool_call': {
      const server = asString(it.server) || 'mcp';
      const name = `mcp__${server}__${asString(it.tool) || 'ferramenta'}`;
      const status = asString(it.status);
      const finished = done || (status !== '' && status !== 'in_progress');
      const error = asString(asRecord(it.error).message);
      const failed = status === 'failed' || !!error;
      return tool(key, it, at, name, it.arguments ?? {}, toolSummary(name, it.arguments), finished ? error || mcpResultText(it.result) : null, finished && failed);
    }
    case 'web_search': {
      const query = asString(it.query);
      return tool(key, it, at, 'WebSearch', { query }, toolSummary('WebSearch', { query }), done ? '' : null, false);
    }
    case 'todo_list': {
      const todos = (Array.isArray(it.items) ? it.items : []).map((i) => ({ content: asString(asRecord(i).text), status: asRecord(i).completed === true ? 'completed' : 'pending' }));
      const finished = todos.filter((t) => t.status === 'completed').length;
      // Atualizada no mesmo id (item.updated): o cartão troca; sem resultado ela "está andando" até o item.completed.
      return tool(key, it, at, 'TodoWrite', { todos }, `${finished}/${todos.length} concluídos`, done ? '' : null, false);
    }
    case 'error': {
      const message = asString(it.message).trim();
      return message ? { kind: 'notice', id: itemId('n', key, it), text: message, tone: 'warn', at } : null;
    }
    default:
      return null;
  }
}

/** Tipos que contam como uma ida e volta ao modelo no turno (cada ferramenta usada pede outra chamada). */
export function isToolCall(raw: unknown): boolean {
  const type = asRecord(raw).type;
  return type === 'command_execution' || type === 'file_change' || type === 'mcp_tool_call' || type === 'web_search';
}

/**
 * Uso de contexto estimado. O `usage` do `turn.completed` soma todas as chamadas ao modelo do turno (cada uma relê a conversa);
 * o exec não diz quantas foram. A estimativa divide pelas ferramentas usadas mais a resposta final, que dá o tamanho da conversa
 * sem inflar com o número de comandos.
 */
export function contextUsed(usage: unknown, toolCalls: number): number | null {
  const input = asRecord(usage).input_tokens;
  return typeof input === 'number' && input > 0 ? Math.round(input / (toolCalls + 1)) : null;
}

const MODEL_GONE =
  /\bmodel\b.{0,80}\b(?:not supported|unsupported|not found|does not exist|is not available|unavailable)\b|(?:do(?:es)? not have|no) access to (?:the )?(?:model|gpt)/i;

/**
 * A execução falhou porque a conta não aceita o modelo (`model_not_found`, "The 'gpt-6.1-sol' model is not supported when using Codex with
 * a ChatGPT account"; ver tests/fixtures/codex/falha-modelo.jsonl)? É o que o plano B do motor confere antes de trocar de modelo.
 */
export function isModelUnavailable(message: unknown): boolean {
  const raw = asString(message).trim();
  let text = raw;
  let kind = '';
  try {
    const outer = asRecord(JSON.parse(raw));
    const inner = asRecord(outer.error);
    text = asString(inner.message) || asString(outer.message) || raw;
    kind = `${asString(inner.type)} ${asString(inner.code)} ${asString(outer.code)}`;
  } catch {
    // texto simples
  }
  return /model_not_found/i.test(kind) || MODEL_GONE.test(text);
}

export interface CodexFailure {
  /** Texto para a conversa (em português quando é o limite de uso). */
  text: string;
  /** Limite de uso (cota do ChatGPT) estourado. */
  limit: boolean;
}

const LIMIT = /usage[_ ]limit|rate[_ ]limit|limit (?:has been )?reached|hit your .{0,30}limit|insufficient_quota|exceeded your (?:current )?quota/i;

/** "daqui a 3 h 20 min", a partir dos segundos que o Codex manda em `resets_in_seconds`. */
function inTime(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  return [d ? `${d} d` : '', h ? `${h} h` : '', m && !d ? `${m} min` : ''].filter(Boolean).join(' ');
}

/**
 * A mensagem do `turn.failed`/`error` chega como texto, muitas vezes um JSON dentro dele (`{"type":"error","status":400,
 * "error":{"type":…,"message":…}}`): tira a mensagem de dentro. Limite de uso (cota do ChatGPT) é reconhecido e avisa como erro
 * da conversa; o Claudio’s Club não continua sozinho (v1).
 */
export function parseCodexFailure(message: unknown): CodexFailure {
  const raw = asString(message).trim();
  let text = raw;
  let kind = '';
  let resets: number | null = null;
  try {
    const outer = asRecord(JSON.parse(raw));
    const inner = asRecord(outer.error);
    text = asString(inner.message) || asString(outer.message) || raw;
    kind = [asString(inner.type), asString(inner.code), asString(outer.status)].join(' ');
    const r = inner.resets_in_seconds ?? outer.resets_in_seconds;
    resets = typeof r === 'number' && r > 0 ? r : null;
  } catch {
    // texto simples
  }
  const limit = LIMIT.test(`${kind} ${text}`);
  if (!limit) return { text: text || 'O turno terminou com erro.', limit: false };
  return { text: `Limite de uso do Codex atingido${resets ? ` (volta em ${inTime(resets)})` : ''}: ${text || 'sem detalhe'}. A conversa não continua sozinha: mande outra mensagem quando o limite voltar.`, limit: true };
}
