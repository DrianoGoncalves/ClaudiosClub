import { z } from 'zod';
import type { Project } from '../shared/model';
import { pathKey } from './adapters/claude/paths';
import type { ToolAdapter } from './adapters/types';
import { addExtraProject, readConfig, setArchived, setProjectWorkspace } from './config';
import { ProjectError } from './newProject';

// "Importar do Claude Code": o quadro só mostra o que tem equipe, o demo e as pastas de `extraProjects`.
// Importar é pôr a pasta nessa lista (a mesma do "Novo projeto"); nada é copiado nem alterado no projeto.

export const ImportInput = z.object({
  paths: z.array(z.string().trim().min(1).max(400)).min(1, 'escolha ao menos um projeto').max(500),
  workspaceId: z.string().max(40).nullable().default(null),
});

type Source = Pick<ToolAdapter, 'listProjects' | 'listImportable' | 'forgetProjects'>;

/** Só o que a tela precisa para listar: o nome, a pasta e quando foi usado por último. */
export async function importableList(adapter: Source) {
  return (await adapter.listImportable()).map((p) => ({ id: p.id, name: p.name, path: p.path, lastActivityAt: p.lastActivityAt }));
}

/**
 * Põe no quadro os projetos pedidos. Só vale caminho que está na lista de importáveis (o que o Claude Code
 * conhece e ainda não está no quadro); um que já entrou (outra aba, clique repetido) é ignorado sem erro.
 * Devolve os ids na ordem do pedido.
 */
export async function importProjects(adapter: Source, body: unknown, configFile?: string): Promise<{ projectIds: string[]; imported: number }> {
  const parsed = ImportInput.safeParse(body);
  if (!parsed.success) throw new ProjectError(parsed.error.issues[0]?.message ?? 'pedido inválido');
  const { paths, workspaceId } = parsed.data;

  const [importable, onBoard, config] = await Promise.all([adapter.listImportable(), adapter.listProjects(), readConfig(configFile)]);
  if (workspaceId && !config.workspaces.some((w) => w.id === workspaceId)) throw new ProjectError('workspace não encontrado');

  const find = (list: Project[], p: string) => list.find((x) => pathKey(x.path) === pathKey(p));
  const toAdd: Project[] = [];
  const ids: string[] = [];
  for (const p of paths) {
    const fresh = find(importable, p);
    const already = fresh ? undefined : find(onBoard.filter((x) => !x.worktreeOf), p);
    if (!fresh && !already) throw new ProjectError(`${p}: não é um projeto do Claude Code que dê para importar`);
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
