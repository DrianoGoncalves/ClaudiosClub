import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tryJson } from './adapters/claude/fsutil';

// "O que mudou" numa conversa: os arquivos que o funcionário editou nela (Edit, Write, MultiEdit,
// NotebookEdit), lidos do transcript. No próprio projeto, sem worktree, é o que separa o trabalho
// dele do dos outros (e do seu).

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Caminhos relativos a `root` (com /), na ordem em que apareceram; fora de `root`, de fora. Lê o transcript
 * principal e, depois, os jsonl dos subagents dele (`<sessão>/subagents/*.jsonl`): o que o orquestrador
 * delegou também é trabalho da conversa. Sem a pasta, só o principal.
 */
export async function touchedFiles(transcript: string, root: string): Promise<string[]> {
  const subDir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  const subs = await fs
    .readdir(subDir, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map((e) => path.join(subDir, e.name))
        .sort(),
      () => [] as string[],
    );
  const raws = await Promise.all([transcript, ...subs].map((f) => fs.readFile(f, 'utf8').catch(() => '')));
  const out = new Set<string>();
  for (const raw of raws) {
    for (const line of raw.split('\n')) {
      if (!line.includes('"tool_use"')) continue;
      const l = tryJson(line) as { type?: string; isSidechain?: boolean; message?: { content?: unknown } } | null;
      if (!l || l.type !== 'assistant' || !Array.isArray(l.message?.content)) continue;
      for (const b of l.message.content as Array<Record<string, unknown>>) {
        if (b.type !== 'tool_use' || !EDIT_TOOLS.has(String(b.name))) continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
        if (!file) continue;
        const rel = path.relative(root, path.resolve(root, file));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) out.add(rel.split(path.sep).join('/'));
      }
    }
  }
  return [...out];
}
