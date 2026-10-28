import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Agent } from '../../../shared/model';
import { errorMessage, linkInfo, listDir } from './fsutil';
import { parseFrontmatter, str, strList } from './frontmatter';

/** Lê `<dir>/*.md`. Arquivos via symlink/hardlink são carregados pelo Claude Code (ver docs/formatos.md). */
export async function readAgentsDir(dir: string, scope: Agent['scope']): Promise<Agent[]> {
  const entries = await listDir(dir);
  const agents = await Promise.all(
    entries
      .filter((e) => e.name.endsWith('.md') && (e.isFile() || e.isSymbolicLink()))
      .map((e) => readAgent(path.join(dir, e.name), scope)),
  );
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

async function readAgent(filePath: string, scope: Agent['scope']): Promise<Agent> {
  const base = {
    id: `${scope}:${filePath}`,
    scope,
    filePath,
    duplicate: false,
  };
  const fallbackName = path.basename(filePath, '.md');
  try {
    const [text, link] = await Promise.all([fs.readFile(filePath, 'utf8'), linkInfo(filePath)]);
    const { data } = parseFrontmatter(text);
    return {
      ...base,
      name: str(data.name) ?? fallbackName,
      description: str(data.description),
      tools: strList(data.tools),
      model: str(data.model),
      effort: str(data.effort),
      link,
      error: null,
    };
  } catch (err) {
    // Ex.: symlink quebrado (origem apagada ou movida).
    return {
      ...base,
      name: fallbackName,
      description: null,
      tools: null,
      model: null,
      effort: null,
      link: await linkInfo(filePath).catch(() => ({ kind: 'file' as const, target: null })),
      error: errorMessage(err),
    };
  }
}

/** O Claude Code identifica agents pelo `name`; com nomes repetidos só um é carregado. */
export function markDuplicates(agents: Agent[]): Agent[] {
  const counts = new Map<string, number>();
  for (const a of agents) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
  return agents.map((a) => ({ ...a, duplicate: (counts.get(a.name) ?? 0) > 1 }));
}
