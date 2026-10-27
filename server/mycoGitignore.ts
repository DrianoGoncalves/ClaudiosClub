import { promises as fs } from 'node:fs';
import path from 'node:path';

// `<projeto>/.myco/.gitignore`: as imagens que o MyCo guarda no projeto (retratos e imagem do
// projeto) não vão para o git. Fica dentro de .myco, sem mexer no .gitignore do projeto; as fichas
// continuam versionáveis. Se você editou o arquivo, só as linhas que faltam são acrescentadas.

const HEADER = '# Gerado pelo MyCo: imagens (retratos e imagem do projeto) ficam fora do git.';
export const IGNORED_IMAGES = ['staff/*.png', 'staff/*.jpg', 'staff/*.webp', 'project.png', 'project.jpg', 'project.webp'];

export async function ensureMycoGitignore(projectPath: string): Promise<void> {
  const file = path.join(projectPath, '.myco', '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  const have = new Set((current ?? '').split(/\r?\n/).map((l) => l.trim()));
  const missing = IGNORED_IMAGES.filter((l) => !have.has(l));
  if (!missing.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const prefix = current === null ? `${HEADER}\n` : current.endsWith('\n') || current === '' ? '' : '\n';
  await fs.writeFile(file, `${current ?? ''}${prefix}${missing.join('\n')}\n`, 'utf8');
}
