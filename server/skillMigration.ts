import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StaffProfile } from '../shared/model';
import { moveDir, NAME } from './adapters/claude/skillWrite';
import { convertSkills, isSkillRef, type KnownSkillNames } from './skillAccess';
import { writeAtomic } from './staff/store';

// Migração de uma vez para o novo modelo de skills (ver skillAccess.ts). Roda no boot, sem bloquear a subida. Nada é sobrescrito:
// o que não dá para mover (já existe na Global, ou é link) fica onde está e vai no relatório.

export interface LibraryMigration {
  moved: string[];
  conflicts: string[];
}

/**
 * Biblioteca do Club (`~/.myco/skills/<nome>`) → Global (`~/.claude/skills/<nome>`). Pré-checa cada pasta: se o destino já existe, ou
 * se é link, não mexe nela (vai em `conflicts`). O relatório grava em `recordFile` (`{moved, conflicts}`) e, com ele, a migração
 * fica feita: nova execução não toca em nada (`null`). Sem biblioteca, o relatório sai vazio.
 */
export async function migrateLibraryToGlobal(o: { libraryDir: string; globalDir: string; recordFile: string }): Promise<LibraryMigration | null> {
  if (await lexists(o.recordFile)) return null;
  const entries = await fs.readdir(o.libraryDir, { withFileTypes: true }).catch(() => []);
  const moved: string[] = [];
  const conflicts: string[] = [];
  const todo: Array<{ name: string; from: string; to: string }> = [];
  for (const e of entries) {
    if (e.name === '.lixeira' || e.name.startsWith('.')) continue;
    if (!(e.isDirectory() || e.isSymbolicLink())) continue;
    const from = path.join(o.libraryDir, e.name);
    const to = path.join(o.globalDir, e.name);
    if (!NAME.test(e.name)) {
      conflicts.push(`${e.name} (nome inválido para a Global)`);
      continue;
    }
    if (e.isSymbolicLink()) {
      conflicts.push(`${e.name} (é um link: não movido)`);
      continue;
    }
    if (await lexists(to)) {
      conflicts.push(`${e.name} (já existe na Global)`);
      continue;
    }
    todo.push({ name: e.name, from, to });
  }
  if (todo.length) await fs.mkdir(o.globalDir, { recursive: true });
  for (const t of todo) {
    await moveDir(t.from, t.to);
    moved.push(t.name);
  }
  const result = { moved, conflicts };
  await fs.mkdir(path.dirname(o.recordFile), { recursive: true });
  await writeAtomic(o.recordFile, JSON.stringify(result, null, 2) + '\n');
  return result;
}

export interface StaffSkillConversion {
  /** Fichas regravadas (projeto e id). */
  changed: Array<{ projectId: string; staffId: string }>;
  /** Projetos que não deu para ler (as fichas deles ficam como estão até a próxima tentativa). */
  skipped: string[];
}

/**
 * Converte o nome antigo das skills de cada ficha (ver convertSkills) e regrava só as que mudam. `known` dá os nomes que existem
 * no projeto (e na Global); `list` e `save` são as funções de leitura e gravação das fichas (os testes trocam).
 */
export async function convertStaffSkills(o: {
  projects: Array<{ id: string; path: string }>;
  known: (project: { id: string; path: string }) => Promise<KnownSkillNames>;
  list: (projectPath: string, projectId: string) => Promise<StaffProfile[]>;
  save: (projectPath: string, p: StaffProfile) => Promise<void>;
}): Promise<StaffSkillConversion> {
  const changed: StaffSkillConversion['changed'] = [];
  const skipped: string[] = [];
  for (const project of o.projects) {
    let known: KnownSkillNames;
    let staff: StaffProfile[];
    try {
      known = await o.known(project);
      staff = await o.list(project.path, project.id);
    } catch {
      skipped.push(project.id);
      continue;
    }
    for (const p of staff) {
      if (!p.skills.some((s) => !isSkillRef(s))) continue;
      const next = convertSkills(p.skills, known).skills;
      await o.save(project.path, { ...p, skills: next });
      changed.push({ projectId: project.id, staffId: p.id });
    }
  }
  return { changed, skipped };
}

/** Existe, mesmo que seja link quebrado (lstat, não stat). */
async function lexists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false,
  );
}
