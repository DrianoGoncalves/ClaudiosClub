import { promises as fs } from 'node:fs';
import type { ChatItem, ContextUsage } from '../../shared/model';
import { tryJson } from '../adapters/claude/fsutil';
import { contextWindowFor } from '../adapters/claude/pricing';
import { inputText, isInjectedUserText, resultText, stripCheckpoint, toolSummary } from './items';

// Histórico da conversa a partir do transcript (~/.claude/projects/.../<sessão>.jsonl).
// Transcripts passam de MB: lê só o final e devolve as últimas mensagens.

const TAIL_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS = 200;

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { id?: string; model?: string; content?: unknown; usage?: Usage };
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export async function readHistory(
  file: string,
  opts: { before?: string } = {},
): Promise<{ items: ChatItem[]; context: ContextUsage | null }> {
  const lines = await tailLines(file, TAIL_BYTES);
  const items: ChatItem[] = [];
  const byId = new Map<string, ChatItem>();
  let context: ContextUsage | null = null;

  const put = (item: ChatItem) => {
    const prev = byId.get(item.id);
    if (prev) Object.assign(prev, item);
    else {
      byId.set(item.id, item);
      items.push(item);
    }
  };

  for (const raw of lines) {
    const l = tryJson(raw) as Line | null;
    if (!l || l.isSidechain || (opts.before && l.timestamp && l.timestamp >= opts.before)) continue;
    const at = l.timestamp ?? null;

    if (l.type === 'system' && raw.includes('"compact_boundary"')) {
      put({ kind: 'notice', id: `n:${at}`, text: 'Conversa compactada', tone: 'info', at });
      continue;
    }
    if (l.type === 'user' && l.message && !l.isMeta && !l.isCompactSummary) {
      const content = l.message.content;
      // O id da mensagem vai junto: "voltar até aqui" desfaz as edições feitas depois dela.
      const uuid = l.uuid ? { uuid: l.uuid } : {};
      if (typeof content === 'string') {
        if (!isInjectedUserText(content)) put({ kind: 'user', id: `u:${at}:${items.length}`, text: content, at, ...uuid });
        continue;
      }
      if (!Array.isArray(content)) continue;
      // Prints colados vêm como blocos de imagem antes do texto: viram uma contagem na mensagem.
      const blocks = content as Array<Record<string, unknown>>;
      const images = blocks.filter((b) => b.type === 'image').length;
      const docs = blocks.filter((b) => b.type === 'document').map((b) => (typeof b.title === 'string' ? b.title : 'arquivo'));
      const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && !isInjectedUserText(b.text as string));
      if ((images || docs.length) && !texts.length) put({ kind: 'user', id: `u:${at}:${items.length}`, text: '', at, ...(images && { images }), ...(docs.length && { files: docs }), ...uuid });
      texts.forEach((b, i) =>
        put({
          kind: 'user',
          id: `u:${at}:${items.length}`,
          text: b.text as string,
          at,
          ...(i === 0 && images && { images }),
          ...(i === 0 && docs.length && { files: docs }),
          ...(i === 0 && uuid),
        }),
      );
      for (const b of blocks) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const tool = byId.get(`t:${b.tool_use_id}`);
          if (tool?.kind === 'tool') {
            tool.result = resultText(b.content);
            tool.isError = b.is_error === true;
          }
        }
      }
      continue;
    }
    if (l.type === 'assistant' && l.message) {
      const msgId = l.message.id ?? `${at}`;
      const u = l.message.usage;
      if (u && l.message.model && !l.message.model.startsWith('<')) {
        const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        const window = contextWindowFor(l.message.model);
        if (used > 0) context = { used, window, percent: Math.round((used / window) * 100) };
      }
      for (const b of (Array.isArray(l.message.content) ? l.message.content : []) as Array<Record<string, unknown>>) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const id = `a:${msgId}`;
          const prev = byId.get(id);
          const own = stripCheckpoint(b.text as string);
          const text = prev?.kind === 'assistant' && prev.text !== own ? `${prev.text}\n\n${own}` : own;
          put({ kind: 'assistant', id, text, at });
        } else if (b.type === 'tool_use' && typeof b.id === 'string') {
          const name = typeof b.name === 'string' ? b.name : 'ferramenta';
          put({ kind: 'tool', id: `t:${b.id}`, name, summary: toolSummary(name, b.input), input: inputText(b.input), result: null, isError: false, at });
        }
      }
    }
  }
  return { items: items.slice(-MAX_ITEMS), context };
}

export async function tailLines(file: string, bytes: number): Promise<string[]> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return [];
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // primeira linha cortada
    return lines.filter(Boolean);
  } finally {
    await fh.close();
  }
}
