import { promises as fs, type Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import type { ChatItem, Session } from '../../../shared/model';
import { itemFromCodex, type CodexItem } from '../../chat/codexEvents';
import { readCodexThread } from '../../chat/codexProcess';
import { MAX_ITEMS, TAIL_BYTES, tailLines } from '../../chat/history';
import { isInjectedUserText, STAFF_NOTICE } from '../../chat/items';
import { tryJson } from '../claude/fsutil';

// Adaptador do formato do Codex. A conversa de um funcionário no motor Codex não tem transcript em ~/.claude/projects:
// o Codex grava um "rollout" em ${CODEX_HOME}/sessions/AAAA/MM/DD/rollout-<data>-<threadId>.jsonl (uma linha JSON por
// evento). Só este arquivo conhece esse formato; o resto do Claudio’s Club vê os mesmos itens do chat.
//
// Linhas usadas: {timestamp, ordinal, type:"event_msg", payload:{type:"item_completed", item}}. Tipos de item:
//   UserMessage {content:[{type:"text",text}]}; AgentMessage {content:[{type:"Text",text}]};
//   CommandExecution {command: argv, aggregated_output, exit_code, status}; FileChange {changes: {caminho: {type}}, status};
//   McpToolCall {server, tool, arguments, result: {content}, error: {message}, status}; ContextCompaction (vira aviso).
// Os demais (Reasoning, Extension, SubAgentActivity, ImageView…) ficam de fora.

/** Fim da ficha no começo do prompt da 1ª mensagem (ver promptWithInstructions em codexArgs.ts). */
const FICHA_END = '[Fim das instruções. A mensagem começa abaixo.]\n\n';
/** O começo do arquivo basta para achar a 1ª mensagem do usuário (vem depois do cabeçalho da sessão). */
const HEAD_BYTES = 1024 * 1024;
const TOPIC_MAX = 80;
const THREAD_FILE = 'codex-thread.json';
/** O Codex compacta rollouts antigos em `.jsonl.zst`. Acima disso (compactado), não se lê: vira vazio. */
const ZST_MAX_BYTES = 20 * 1024 * 1024;

/** `zlib.zstdDecompress` (Node 22.15+). Sem ele, os `.zst` não têm histórico (sem erro). */
const zstdDecompress = (zlib as unknown as { zstdDecompress?: (buf: Buffer, cb: (err: Error | null, out: Buffer) => void) => void }).zstdDecompress;
const decompressZst = zstdDecompress ? promisify(zstdDecompress) : null;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** Onde o Codex guarda as conversas: CODEX_HOME, ou ~/.codex. */
export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

/** O id da conversa do Codex (o que o `resume` retoma), guardado em `<runDir>/<sessão>/codex-thread.json`. */
export function codexThreadOf(runDir: string, sessionId: string): Promise<string | null> {
  return readCodexThread(path.join(runDir, sessionId, THREAD_FILE));
}

const found = new Map<string, string>();

/**
 * O rollout de uma conversa pelo id (o nome termina em `-<id>.jsonl` ou `-<id>.jsonl.zst`, se o Codex compactou). Procura do
 * dia mais novo para trás, e prefere o `.jsonl` se houver os dois. O achado fica em cache; se o arquivo sumiu (foi
 * compactado ou movido), o cache é descartado e a busca recomeça. Sem arquivo, null.
 */
export async function findRollout(threadId: string, home = codexHome()): Promise<string | null> {
  if (!/^[0-9A-Za-z-]+$/.test(threadId)) return null;
  const key = `${home}\n${threadId}`;
  const hit = found.get(key);
  if (hit && (await fs.stat(hit).then(() => true, () => false))) return hit;
  found.delete(key);
  const suffix = `-${threadId}.jsonl`;
  const root = path.join(home, 'sessions');
  for (const y of await subdirs(root))
    for (const m of await subdirs(path.join(root, y)))
      for (const d of await subdirs(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const names = (await fs.readdir(dir).catch((): string[] => [])).filter((n) => n.startsWith('rollout-'));
        const name = names.find((n) => n.endsWith(suffix)) ?? names.find((n) => n.endsWith(`${suffix}.zst`));
        if (name) {
          const file = path.join(dir, name);
          found.set(key, file);
          return file;
        }
      }
  return null;
}

/** Pastas filhas, da mais nova para a mais antiga (AAAA, MM e DD têm largura fixa, a ordem por nome serve). */
async function subdirs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
}

/** Texto dos blocos de um conteúdo (`text` de cada bloco, na ordem). */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => rec(b).text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n\n');
}

/** Um item concluído de uma linha do rollout; null para as outras linhas. */
function completedItem(raw: string): { at: string | null; ordinal: number | null; item: Rec } | null {
  const ev = rec(tryJson(raw));
  const payload = rec(ev.payload);
  if (ev.type !== 'event_msg' || payload.type !== 'item_completed') return null;
  const item = rec(payload.item);
  if (typeof item.type !== 'string') return null;
  return {
    at: typeof ev.timestamp === 'string' ? ev.timestamp : null,
    ordinal: typeof ev.ordinal === 'number' ? ev.ordinal : null,
    item,
  };
}

/**
 * Mensagem que a pessoa escreveu: sem a ficha (na 1ª) e sem os avisos do Claudio’s Club que o chat junta ao prompt
 * (no Codex vão no mesmo texto, em parágrafos antes do que foi digitado). `fromStaff`: veio de outro funcionário.
 */
function userMessage(content: unknown): { text: string; fromStaff: boolean } {
  let text = textOf(content);
  const end = text.indexOf(FICHA_END);
  if (end !== -1) text = text.slice(end + FICHA_END.length);
  const paras = text.split('\n\n');
  const fromStaff = paras.some((p) => p.trimStart().startsWith(STAFF_NOTICE));
  while (paras.length && paras[0]!.trimStart().startsWith('[MyCo]')) paras.shift();
  return { text: paras.join('\n\n'), fromStaff };
}

/** A mensagem do usuário que vai para o histórico; null se não há texto (ou é texto injetado). */
function userOf(item: Rec): { text: string; fromStaff: boolean } | null {
  const m = userMessage(item.content);
  return m.text.trim() && !isInjectedUserText(m.text) ? m : null;
}

/** O argv do comando: o que vem depois de `-Command`/`-c` (PowerShell ou shell); senão, o argv junto. */
function commandOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return '';
  const argv = v.filter((a): a is string => typeof a === 'string');
  if (argv.length >= 2 && /^-(command|c|lc)$/i.test(argv[argv.length - 2]!)) return argv[argv.length - 1]!;
  return argv.join(' ');
}

/** Alterações do arquivo: o rollout indexa por caminho (`{caminho: {type}}`); o itemFromCodex quer lista. */
function changesOf(v: unknown): Array<{ path: string; kind: string }> {
  return Object.entries(rec(v)).map(([p, c]) => {
    const kind = rec(c).type;
    return { path: p, kind: typeof kind === 'string' ? kind : 'update' };
  });
}

/** Converte o item do rollout para o formato do `codex exec --json`, para o itemFromCodex (cartões iguais aos do vivo). */
function toCodex(item: Rec): CodexItem | null {
  const id = typeof item.id === 'string' ? item.id : undefined;
  switch (item.type) {
    case 'AgentMessage':
      return { type: 'agent_message', id, text: textOf(item.content) };
    case 'CommandExecution':
      return { type: 'command_execution', id, command: commandOf(item.command), aggregated_output: item.aggregated_output, exit_code: item.exit_code, status: item.status };
    case 'FileChange':
      return { type: 'file_change', id, changes: changesOf(item.changes), status: item.status };
    case 'McpToolCall':
      return { type: 'mcp_tool_call', id, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: item.status };
    default:
      return null;
  }
}

/**
 * Histórico de uma conversa do Codex, do fim do rollout (como o readHistory do Claude). `before`: só o que veio antes
 * desse instante. Linha corrompida ou tipo desconhecido é pulado; arquivo ausente dá lista vazia.
 */
export async function readCodexHistory(file: string, opts: { before?: string } = {}): Promise<{ items: ChatItem[]; context: null }> {
  const lines = await rolloutLines(file, 'tail', TAIL_BYTES);
  const items: ChatItem[] = [];
  lines.forEach((raw, i) => {
    const ev = completedItem(raw);
    if (!ev || (opts.before && ev.at && ev.at >= opts.before)) return;
    const at = ev.at;
    // O ordinal do próprio rollout identifica a linha (estável entre leituras, ao contrário do índice da janela).
    const key = String(ev.ordinal ?? i);
    const it = ev.item;
    if (it.type === 'UserMessage') {
      const u = userOf(it);
      if (u) items.push({ kind: 'user', id: `u:${key}`, text: u.text, at, ...(u.fromStaff ? { fromStaff: true } : {}) });
      return;
    }
    if (it.type === 'ContextCompaction') {
      items.push({ kind: 'notice', id: `n:${key}`, text: 'Conversa compactada', tone: 'info', at });
      return;
    }
    const c = toCodex(it);
    const card = c ? itemFromCodex(c, key, at ?? '', 'completed') : null;
    if (card) items.push(card);
  });
  return { items: items.slice(-MAX_ITEMS), context: null };
}

/**
 * Histórico pela sessão do Claudio’s Club: lê o thread do Codex em `runDir` e o rollout dele. Null se a sessão não tem
 * thread do Codex (então não é do Codex: quem chama segue pelo transcript do Claude).
 */
export async function codexHistoryOf(runDir: string, sessionId: string, opts: { before?: string } = {}): Promise<{ items: ChatItem[]; context: null } | null> {
  const threadId = await codexThreadOf(runDir, sessionId);
  if (!threadId) return null;
  const file = await findRollout(threadId);
  return file ? readCodexHistory(file, opts) : { items: [], context: null };
}

/** Assunto: a 1ª linha da 1ª mensagem do usuário (sem a ficha), até 80 caracteres. */
function clipTopic(text: string): string {
  const one = (text.trim().split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  return one.length > TOPIC_MAX ? `${one.slice(0, TOPIC_MAX - 1)}…` : one;
}

/** Primeiros `bytes` do arquivo como linhas (a última, cortada no limite, sai). */
async function readHead(file: string, bytes: number): Promise<string[]> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return [];
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === bytes) lines.pop();
    return lines.filter(Boolean);
  } finally {
    await fh.close();
  }
}

/** O rollout compactado inteiro, descompactado; null sem zstd no Node, se passa de ZST_MAX_BYTES ou se não lê. */
async function readZst(file: string): Promise<Buffer | null> {
  if (!decompressZst) return null;
  const st = await fs.stat(file).catch(() => null);
  if (!st || st.size > ZST_MAX_BYTES) return null;
  const raw = await fs.readFile(file).catch(() => null);
  if (!raw) return null;
  return decompressZst(raw).catch(() => null);
}

/**
 * Linhas de um rollout: o fim (`tail`) ou o começo (`head`) nos primeiros `bytes`, como no tailLines do Claude. `.zst` é
 * descompactado antes e fatiado do mesmo jeito.
 */
async function rolloutLines(file: string, where: 'tail' | 'head', bytes: number): Promise<string[]> {
  if (!file.endsWith('.zst')) return where === 'tail' ? tailLines(file, bytes) : readHead(file, bytes);
  const text = await readZst(file);
  if (!text) return [];
  const cut = text.length > bytes;
  const slice = where === 'tail' ? text.subarray(Math.max(0, text.length - bytes)) : text.subarray(0, bytes);
  const lines = slice.toString('utf8').split('\n');
  if (cut) {
    if (where === 'tail') lines.shift();
    else lines.pop();
  }
  return lines.filter(Boolean);
}

/** Assunto e começo do rollout. Só cacheado quando achou o assunto (até lá, a 1ª mensagem ainda pode não ter sido escrita). */
const heads = new Map<string, { topic: string | null; startedAt: string | null }>();

async function headInfo(file: string): Promise<{ topic: string | null; startedAt: string | null }> {
  const hit = heads.get(file);
  if (hit) return hit;
  let startedAt: string | null = null;
  let topic: string | null = null;
  for (const raw of await rolloutLines(file, 'head', HEAD_BYTES)) {
    const ts = rec(tryJson(raw)).timestamp;
    if (!startedAt && typeof ts === 'string') startedAt = ts;
    const c = completedItem(raw);
    if (c?.item.type !== 'UserMessage') continue;
    const u = userOf(c.item);
    if (u) {
      topic = clipTopic(u.text);
      break;
    }
  }
  const info = { topic, startedAt };
  if (topic) heads.set(file, info);
  return info;
}

export interface CodexRolloutSummary {
  topic: string | null;
  /** Primeiro registro do rollout (a hora em que a conversa começou). */
  startedAt: string | null;
  /** Último gravado (mtime). */
  updatedAt: string;
  sizeBytes: number;
}

/** O resumo para a lista de sessões: assunto, início, última gravação e tamanho. Null se o arquivo não existe. */
export async function rolloutSummary(file: string): Promise<CodexRolloutSummary | null> {
  const st = await fs.stat(file).catch(() => null);
  if (!st) return null;
  const head = await headInfo(file);
  return { topic: head.topic, startedAt: head.startedAt, updatedAt: st.mtime.toISOString(), sizeBytes: st.size };
}

/**
 * A sessão do quadro para uma conversa do Codex (ela não tem transcript do Claude). O título é o nome do funcionário;
 * sem rollout (ainda sem mensagem, por exemplo), vale a hora da ficha.
 */
export async function codexSession(runDir: string, name: string, entry: { id: string; startedAt: string }): Promise<Session> {
  const threadId = await codexThreadOf(runDir, entry.id);
  const file = threadId ? await findRollout(threadId) : null;
  const sum = file ? await rolloutSummary(file) : null;
  return {
    id: entry.id,
    title: name,
    topic: sum?.topic ?? null,
    entrypoint: 'codex',
    gitBranch: null,
    version: null,
    startedAt: sum?.startedAt ?? entry.startedAt,
    updatedAt: sum?.updatedAt ?? entry.startedAt,
    sizeBytes: sum?.sizeBytes ?? 0,
    subagentCount: 0,
    live: null,
  };
}
