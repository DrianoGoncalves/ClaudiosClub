import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Skill } from '../../../shared/model';
import { errorMessage, exists, linkInfo, listDir } from './fsutil';
import { parseFrontmatter, str } from './frontmatter';

/** Lê `<dir>/<pasta>/SKILL.md`. Pastas via junction são carregadas pelo Claude Code. */
export async function readSkillsDir(dir: string, scope: Skill['scope']): Promise<Skill[]> {
  const entries = await listDir(dir);
  const candidates = entries.filter(
    (e) =>
      (e.isDirectory() || e.isSymbolicLink()) &&
      !e.name.startsWith('.') &&
      // ~/.claude/skills/synced guarda as skills da conta; lidas à parte.
      !(scope === 'user' && e.name === 'synced'),
  );
  const skills = await Promise.all(candidates.map((e) => readSkill(path.join(dir, e.name), scope)));
  return skills.filter((s): s is Skill => s !== null).sort((a, b) => a.name.localeCompare(b.name));
}

/** `~/.claude/skills/synced/<bucket>/<skill>/` — gerenciadas pela conta, somente leitura. */
export async function readSyncedSkills(claudeHome: string): Promise<Skill[]> {
  const root = path.join(claudeHome, 'skills', 'synced');
  const buckets = (await listDir(root)).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const lists = await Promise.all(buckets.map((b) => readSkillsDir(path.join(root, b.name), 'synced')));
  return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkill(dirPath: string, scope: Skill['scope']): Promise<Skill | null> {
  const skillFile = path.join(dirPath, 'SKILL.md');
  if (!(await exists(skillFile))) return null;
  const base = {
    id: `${scope}:${dirPath}`,
    name: path.basename(dirPath),
    scope,
    readOnly: scope === 'synced',
    dirPath,
  };
  const link = await linkInfo(dirPath).catch(() => ({ kind: 'file' as const, target: null }));
  try {
    const { data } = parseFrontmatter(await fs.readFile(skillFile, 'utf8'));
    return { ...base, label: str(data.name), description: str(data.description), link, error: null };
  } catch (err) {
    return { ...base, label: null, description: null, link, error: errorMessage(err) };
  }
}
