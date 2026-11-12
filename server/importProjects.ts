import path from 'node:path';
import { z } from 'zod';
import { encodeProjectDir, pathKey } from './adapters/claude/paths';
import { listCodexProjects, type CodexProjectsOptions } from './adapters/codex/projects';
import type { ToolAdapter } from './adapters/types';
import { addExtraProject, readConfig, setArchived, setProjectWorkspace } from './config';
import { ProjectError } from './newProject';

// "Importar": o quadro só mostra o que tem equipe, o demo e as pastas de `extraProjects`.
// Importar é pôr a pasta nessa lista (a mesma do "Novo projeto"); nada é copiado nem alterado no projeto.
// Fontes: o que o Claude Code conhece e o que o Codex conhece (config.toml e rollouts).

export const ImportInput = z.object({
  paths: z.array(z.string().trim().min(1).max(400)).min(1, 'escolha ao menos um projeto').max(500),
  workspaceId: z.string().max(40).nullable().default(null),
});

type Source = Pick<ToolAdapter, 'listProjects' | 'listImportable' | 'forgetProjects'>;

export type ImportSource = 'claude' | 'codex';

/** Um projeto fora do quadro que o Claude Code e/ou o Codex conhecem. */
export interface ImportableProject {
  id: string;
  name: string;
  path: string;
  lastActivityAt: string | null;
  /** De onde veio a pasta. Pasta que as duas conhecem sai com as duas. */
  sources: ImportSource[];
}

export interface ImportOptions extends CodexProjectsOptions {
  /** Pasta do Codex (padrão: CODEX_HOME ou ~/.codex). */
  codexHome?: string;
}

const later = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Os importáveis de todas as fontes, por pasta. "Fora do quadro" é o mesmo do Claude Code: fora da lista do quadro
 * (`listProjects`), que também traz o demo, as de `extraProjects` e as que têm equipe.
 */
async function importState(adapter: Source, opts: ImportOptions) {
  const [claude, board, codex] = await Promise.all([
    adapter.listImportable(),
    adapter.listProjects(),
    listCodexProjects(opts.codexHome, { includeTemp: opts.includeTemp }),
  ]);
  const onBoard = new Set(board.map((p) => pathKey(p.path)));
  const byKey = new Map<string, ImportableProject>();
  for (const p of claude) {
    byKey.set(pathKey(p.path), { id: p.id, name: p.name, path: p.path, lastActivityAt: p.lastActivityAt, sources: ['claude'] });
  }
  for (const c of codex) {
    const key = pathKey(c.path);
    if (onBoard.has(key)) continue;
    const at = c.lastActivityAt ?? null;
    const hit = byKey.get(key);
    if (hit) {
      hit.sources.push('codex');
      hit.lastActivityAt = later(hit.lastActivityAt, at);
    } else {
      // Mesmo id e nome do Claude Code (pasta codificada e basename), para a pasta ser a mesma nas duas fontes.
      byKey.set(key, { id: encodeProjectDir(c.path), name: path.basename(c.path), path: c.path, lastActivityAt: at, sources: ['codex'] });
    }
  }
  const list = [...byKey.values()].sort(
    (a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.name.localeCompare(b.name),
  );
  return { list, board };
}

/** Só o que a tela precisa para listar: o nome, a pasta, quando foi usado por último e de onde veio. */
export async function importableList(adapter: Source, opts: ImportOptions = {}): Promise<ImportableProject[]> {
  return (await importState(adapter, opts)).list;
}

/**
 * Põe no quadro os projetos pedidos. Só vale caminho que está na lista de importáveis (o que o Claude Code ou o Codex
 * conhece e ainda não está no quadro); um que já entrou (outra aba, clique repetido) é ignorado sem erro.
 * Devolve os ids na ordem do pedido.
 */
export async function importProjects(
  adapter: Source,
  body: unknown,
  configFile?: string,
  opts: ImportOptions = {},
): Promise<{ projectIds: string[]; imported: number }> {
  const parsed = ImportInput.safeParse(body);
  if (!parsed.success) throw new ProjectError(parsed.error.issues[0]?.message ?? 'pedido inválido');
  const { paths, workspaceId } = parsed.data;

  const [{ list: importable, board }, config] = await Promise.all([importState(adapter, opts), readConfig(configFile)]);
  if (workspaceId && !config.workspaces.some((w) => w.id === workspaceId)) throw new ProjectError('workspace não encontrado');

  const find = <T extends { path: string }>(list: T[], p: string) => list.find((x) => pathKey(x.path) === pathKey(p));
  const onBoardRoots = board.filter((x) => !x.worktreeOf);
  const toAdd: ImportableProject[] = [];
  const ids: string[] = [];
  for (const p of paths) {
    const fresh = find(importable, p);
    const already = fresh ? undefined : find(onBoardRoots, p);
    if (!fresh && !already) throw new ProjectError(`${p}: não é um projeto do Claude Code nem do Codex que dê para importar`);
    const project = (fresh ?? already)!;
    if (ids.includes(project.id)) continue;
    ids.push(project.id);
    if (fresh) toAdd.push(fresh);
  }

  // Um de cada vez: cada um regrava o config.json.
  for (const p of toAdd) await addExtraProject(p.path, configFile);
  adapter.forgetProjects();
  for (const p of toAdd) {
    if (workspaceId) await setProjectWorkspace(p.id, workspaceId, configFile);
    // Estava arquivado: importar de novo traz de volta ao quadro.
    if (config.archived.projects.includes(p.id)) await setArchived({ kind: 'project', id: p.id, archived: false }, configFile);
  }
  return { projectIds: ids, imported: toAdd.length };
}
