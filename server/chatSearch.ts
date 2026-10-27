import type { ConversationHit } from '../shared/model';
import { tryJson } from './adapters/claude/fsutil';
import { tailLines } from './chat/history';
import { isInjectedUserText } from './chat/items';

// Busca nas conversas dos funcionários (Ctrl+K): o texto seu e o deles, do fim de cada transcript.

const MAX_HITS = 30;
const PER_SESSION = 3;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface SearchTarget {
  projectId: string;
  staffId: string;
  staffName: string;
  sessionId: string;
  file: string;
}

export async function searchConversations(targets: SearchTarget[], query: string): Promise<ConversationHit[]> {
  const q = fold(query.trim());
  if (q.length < 3) return [];
  const hits: ConversationHit[] = [];
  for (const t of targets) {
    let found = 0;
    let title: string | null = null;
    for (const raw of await tailLines(t.file, 3 * 1024 * 1024)) {
      const l = tryJson(raw) as { type?: string; customTitle?: string; timestamp?: string; isSidechain?: boolean; message?: { content?: unknown } } | null;
      if (!l || l.isSidechain) continue;
      if (l.type === 'custom-title' && l.customTitle) title = l.customTitle;
      if ((l.type !== 'user' && l.type !== 'assistant') || found >= PER_SESSION) continue;
      const text = textOf(l.message?.content);
      const at = fold(text).indexOf(q);
      if (at < 0) continue;
      found++;
      hits.push({ projectId: t.projectId, staffId: t.staffId, staffName: t.staffName, sessionId: t.sessionId, title: null, snippet: snippet(text, at, q.length), at: l.timestamp ?? null });
    }
    for (const h of hits) if (h.sessionId === t.sessionId) h.title = title;
  }
  return hits.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, MAX_HITS);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return isInjectedUserText(content) ? '' : content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && !isInjectedUserText(b.text))
    .map((b) => b.text)
    .join(' ');
}

/** "…um pedaço com o achado no meio…" (a acentuação não muda o tamanho do texto, então o índice vale). */
function snippet(text: string, at: number, len: number): string {
  const start = Math.max(0, at - 60);
  const end = Math.min(text.length, at + len + 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
