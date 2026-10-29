import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Project } from '../shared/model';
import { isInside } from './adapters/claude/paths';

// "Novo projeto": cria uma pasta (com git, se quiser) ou abre uma que já existe. O Claudio’s Club só lista o
// que o Claude Code conhece, então a pasta entra numa lista própria (config.json → extraProjects)
// até a primeira conversa nela. Nada é sobrescrito: pasta nova que já existe é recusada.

export class ProjectError extends Error {}

// Nome de pasta que funciona no Windows, no macOS e no Linux: sem barras, `..`, `:`, `*`, aspas…
const FOLDER = /^[A-Za-z0-9][\w .-]{0,79}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const workspace = z.string().max(40).nullable().default(null);
const absolute = (what: string) => z.string().trim().min(1, `informe ${what}`).max(400).refine((p) => path.isAbsolute(p), `${what}: use o caminho completo`);

export const NewProjectInput = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('create'),
    parent: absolute('a pasta onde criar'),
    name: z
      .string()
      .trim()
      .regex(FOLDER, 'nome da pasta: letras, números, espaço, ponto, hífen ou _ (até 80)')
      .refine((n) => !RESERVED.test(n) && !/[. ]$/.test(n), 'esse nome de pasta não funciona no Windows'),
    git: z.boolean().default(true),
    workspaceId: workspace,
  }),
  z.object({ mode: z.literal('existing'), path: absolute('a pasta do projeto'), workspaceId: workspace }),
]);
export type NewProject = z.infer<typeof NewProjectInput>;

export function parseNewProject(body: unknown): NewProject {
  const r = NewProjectInput.safeParse(body);
  if (!r.success) throw new ProjectError(r.error.issues[0]?.message ?? 'projeto inválido');
  return r.data;
}

/** Cria a pasta ou confere a que já existe; devolve o caminho e se foi criada agora. */
export async function openProject(input: NewProject, tmpDir = os.tmpdir()): Promise<{ path: string; created: boolean }> {
  const dir = path.resolve(input.mode === 'create' ? path.join(input.parent, input.name) : input.path);
  // O quadro esconde o que está na pasta temporária (scratchpads, testes).
  if (isInside(dir, tmpDir)) throw new ProjectError('a pasta temporária do sistema não serve para projeto');
  if (input.mode === 'existing') {
    if (!(await isDir(dir))) throw new ProjectError('pasta não encontrada');
    return { path: dir, created: false };
  }
  if (!(await isDir(input.parent))) throw new ProjectError('a pasta onde criar não existe');
  try {
    await fs.mkdir(dir); // sem `recursive`: se já existe, falha (EEXIST)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectError(`já existe ${input.name} nessa pasta: use "pasta que já existe"`);
    throw new ProjectError('não deu para criar a pasta (permissão?)');
  }
  if (input.git) await gitInit(dir);
  return { path: dir, created: true };
}

/** A pasta-mãe da maioria dos projetos (onde um novo costuma ir); sem projetos, a home. */
export function usualParent(projects: Project[], home = os.homedir()): string {
  const count = new Map<string, number>();
  for (const p of projects) {
    if (!p.exists || p.worktreeOf) continue;
    const parent = path.dirname(p.path);
    count.set(parent, (count.get(parent) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? home;
}

/** Sem git, a pasta fica do mesmo jeito: só sem o painel de código. */
function gitInit(dir: string): Promise<void> {
  return new Promise((resolve) => execFile('git', ['-C', dir, 'init', '-q', '-b', 'main'], { windowsHide: true, timeout: 15_000 }, () => resolve()));
}

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);
