import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MYCO_HOME } from './config';
import { ensureMycoGitignore } from './mycoGitignore';
import { writeAtomic } from './staff/store';

// Arquivos que o MyCo edita a pedido do usuário: a imagem do projeto (logo ou print) e as
// regras da conta (~/.claude/CLAUDE.md, que vale para todos os projetos).

export class FileError extends Error {}

const IMAGE_EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const imageDir = (projectPath: string) => path.join(projectPath, '.myco');

async function findImage(projectPath: string): Promise<{ file: string; ext: string; mtimeMs: number } | null> {
  for (const ext of ['png', 'jpg', 'webp']) {
    const file = path.join(imageDir(projectPath), `project.${ext}`);
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) return { file, ext, mtimeMs: st.mtimeMs };
  }
  return null;
}

/** URL da imagem com a data no fim, para o navegador não mostrar a antiga depois de trocar. */
export async function projectImageUrl(projectId: string, projectPath: string): Promise<string | null> {
  const img = await findImage(projectPath);
  return img ? `/api/projects/${projectId}/image?v=${Math.round(img.mtimeMs)}` : null;
}

export async function readProjectImage(projectPath: string): Promise<{ bytes: Buffer; type: string } | null> {
  const img = await findImage(projectPath);
  if (!img) return null;
  return { bytes: await fs.readFile(img.file), type: img.ext === 'jpg' ? 'image/jpeg' : `image/${img.ext}` };
}

/** Troca (data URL) ou remove (null) a imagem do projeto. */
export async function saveProjectImage(projectPath: string, dataUrl: string | null): Promise<void> {
  const old = await findImage(projectPath);
  if (old) await fs.rm(old.file, { force: true });
  if (dataUrl === null) return;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new FileError('imagem inválida: use PNG, JPEG ou WebP');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > 2 * 1024 * 1024) throw new FileError('imagem grande demais (máx. 2 MB)');
  await fs.mkdir(imageDir(projectPath), { recursive: true });
  await ensureMycoGitignore(projectPath);
  await fs.writeFile(path.join(imageDir(projectPath), `project.${IMAGE_EXT[m[1]!]}`), bytes);
}

const CLAUDE_HOME = process.env.MYCO_CLAUDE_HOME ?? path.join(os.homedir(), '.claude');

export function accountRulesFile(): string {
  return path.join(CLAUDE_HOME, 'CLAUDE.md');
}

export async function readAccountRules(file = accountRulesFile()): Promise<{ path: string; text: string | null }> {
  const text = await fs.readFile(file, 'utf8').catch(() => null);
  return { path: file, text };
}

/** Grava as regras da conta; a versão anterior vai para ~/.myco/backups. */
export async function saveAccountRules(text: string, file = accountRulesFile(), backups = path.join(MYCO_HOME, 'backups')) {
  if (text.length > 200_000) throw new FileError('texto grande demais');
  const previous = await fs.readFile(file, 'utf8').catch(() => null);
  if (previous !== null) {
    await writeAtomic(path.join(backups, `CLAUDE.md.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`), previous);
  }
  await writeAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
  return readAccountRules(file);
}
