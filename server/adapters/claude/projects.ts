import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Project } from '../../../shared/model';
import { exists, listDir, tryJson } from './fsutil';
import { encodeProjectDir, isInside, pathKey, worktreeParent, type ClaudeLocations } from './paths';
import { readTranscriptCwd } from './sessions';

// De ~/.claude.json só interessa a lista de projetos; o resto (inclusive `oauthAccount`) é descartado aqui.
const ConfigFile = z.object({ projects: z.record(z.unknown()).optional() });

export interface ProjectRef {
  /** Pasta em ~/.claude/projects (pode ainda não existir). */
  id: string;
  path: string;
}

export interface DiscoverOptions {
  /** Inclui projetos dentro da pasta temporária do sistema (pastas de teste, scratchpads). */
  includeTemp?: boolean;
  /** Pastas que entram mesmo sem histórico no Claude Code (o projeto demo), se existirem. */
  extraPaths?: string[];
}

/**
 * Projetos conhecidos = chaves de `projects` em ~/.claude.json
 * + `extraPaths` que existem (o projeto demo, antes da primeira conversa nele)
 * + pastas de ~/.claude/projects que não batem com nenhuma chave (caminho tirado do `cwd` do transcript).
 */
export async function discoverProjects(loc: ClaudeLocations, opts: DiscoverOptions = {}): Promise<ProjectRef[]> {
  const byKey = new Map<string, ProjectRef>();
  const add = (p: string, id?: string) => {
    const resolved = path.resolve(p);
    const key = pathKey(resolved);
    if (!byKey.has(key)) byKey.set(key, { id: id ?? encodeProjectDir(resolved), path: resolved });
  };

  for (const p of await readConfigProjectPaths(loc.configFile)) add(p);
  for (const p of opts.extraPaths ?? []) if (await exists(p)) add(p);

  const known = new Set([...byKey.values()].map((r) => r.id));
  const orphanDirs = (await listDir(path.join(loc.home, 'projects'))).filter(
    (e) => e.isDirectory() && !known.has(e.name),
  );
  for (const dir of orphanDirs) {
    const cwd = await readTranscriptCwd(path.join(loc.home, 'projects', dir.name));
    if (cwd) add(cwd, dir.name);
  }

  const tmp = os.tmpdir();
  return [...byKey.values()].filter((r) => opts.includeTemp || !isInside(r.path, tmp));
}

async function readConfigProjectPaths(configFile: string): Promise<string[]> {
  const raw = await fs.readFile(configFile, 'utf8').catch(() => null);
  if (raw === null) return [];
  const parsed = ConfigFile.safeParse(tryJson(raw));
  return parsed.success ? Object.keys(parsed.data.projects ?? {}) : [];
}

/**
 * Pasta `.claude` do projeto, ou null quando o projeto é a própria home do usuário:
 * aí `<projeto>/.claude` é o ~/.claude, e agents/skills já contam como escopo do usuário.
 */
export function projectClaudeDir(loc: ClaudeLocations, projectPath: string): string | null {
  const dir = path.join(projectPath, '.claude');
  return pathKey(dir) === pathKey(loc.home) ? null : dir;
}

export async function summarizeProject(loc: ClaudeLocations, ref: ProjectRef): Promise<Project> {
  const claudeDir = projectClaudeDir(loc, ref.path);
  const transcriptsDir = path.join(loc.home, 'projects', ref.id);
  const [projectExists, hasClaudeMd, hasNestedClaudeMd, agentEntries, skillEntries, transcripts] = await Promise.all([
    exists(ref.path),
    exists(path.join(ref.path, 'CLAUDE.md')),
    claudeDir ? exists(path.join(claudeDir, 'CLAUDE.md')) : false,
    claudeDir ? listDir(path.join(claudeDir, 'agents')) : [],
    claudeDir ? listDir(path.join(claudeDir, 'skills')) : [],
    transcriptStats(transcriptsDir),
  ]);
  return {
    id: ref.id,
    path: ref.path,
    name: path.basename(ref.path),
    exists: projectExists,
    worktreeOf: worktreeParent(ref.path),
    hasClaudeMd: hasClaudeMd || hasNestedClaudeMd,
    agentCount: agentEntries.filter((e) => e.name.endsWith('.md')).length,
    skillCount: skillEntries.filter((e) => e.isDirectory() || e.isSymbolicLink()).length,
    sessionCount: transcripts.count,
    lastActivityAt: transcripts.lastModified,
  };
}

async function transcriptStats(dir: string): Promise<{ count: number; lastModified: string | null }> {
  const files = (await listDir(dir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  const mtimes = await Promise.all(
    files.map((f) => fs.stat(path.join(dir, f.name)).then((s) => s.mtimeMs).catch(() => 0)),
  );
  const last = Math.max(0, ...mtimes);
  return { count: files.length, lastModified: last ? new Date(last).toISOString() : null };
}
