import os from 'node:os';
import path from 'node:path';

export interface ClaudeLocations {
  /** ~/.claude */
  home: string;
  /** ~/.claude.json (contém credenciais de conta: só a chave `projects` é lida). */
  configFile: string;
}

export function defaultLocations(): ClaudeLocations {
  return {
    home: process.env.MYCO_CLAUDE_HOME ?? path.join(os.homedir(), '.claude'),
    configFile: process.env.MYCO_CLAUDE_CONFIG ?? path.join(os.homedir(), '.claude.json'),
  };
}

/** Nome da pasta em ~/.claude/projects: todo caractere não alfanumérico vira "-". Não é reversível. */
export function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

const WORKTREE_SEGMENT = /[\\/]\.claude[\\/]worktrees[\\/]/;

export function worktreeParent(projectPath: string): string | null {
  const m = WORKTREE_SEGMENT.exec(projectPath);
  return m ? projectPath.slice(0, m.index) : null;
}

/** Compara caminhos como o sistema compara (sem distinção de caixa no Windows). */
export function pathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(pathKey(parent), pathKey(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
