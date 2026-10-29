import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import type { LibrarySkill } from '../shared/model';
import { parseFrontmatter, str } from './adapters/claude/frontmatter';
import { findSecret } from './chat/secrets';
import { MYCO_HOME } from './config';
import { writeAtomic } from './staff/store';

// Biblioteca de skills da conta: `~/.myco/skills/<nome>/SKILL.md`. Fica fora do ~/.claude, então
// nenhuma sessão do Claude Code vê sozinha; só quem tem a skill marcada na ficha. Ao abrir a
// conversa dele, o Claudio’s Club monta um plugin só com essas skills e passa com `--plugin-dir` (vale só para
// aquela sessão). No Claude Code elas aparecem como `myco:<nome>`.
//
// Pelo Claudio’s Club se edita só o SKILL.md: scripts e outros arquivos da pasta ficam como estão (código
// executável não se edita numa caixa de texto do navegador).

export const LIBRARY_DIR = path.join(MYCO_HOME, 'skills');
/** Nome do plugin da sessão: o prefixo das skills (`myco:<nome>`). */
export const PLUGIN_NAME = 'myco';
const TRASH = '.lixeira';

export class SkillError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED = new Set(['name', 'description']);

export const SkillInput = z.object({
  /** O nome atual, para editar (e renomear); ausente = skill nova. */
  originalName: z.string().regex(NAME).optional(),
  name: z.string().trim().regex(NAME, 'nome: letras minúsculas, números e hífen (até 64), começando por letra ou número'),
  description: z.string().trim().min(1, 'a descrição é o que faz a skill ser chamada: escreva quando usar').max(1024, 'descrição longa demais (até 1024)'),
  body: z.string().max(100_000, 'instruções longas demais (até 100 mil caracteres)'),
});

const skillFile = (dir: string, name: string) => path.join(dir, name, 'SKILL.md');

/** As skills da biblioteca, com nome, descrição e os outros arquivos da pasta. */
export async function listLibrary(dir = LIBRARY_DIR): Promise<LibrarySkill[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: LibrarySkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !NAME.test(e.name)) continue;
    const s = await readLibrarySkill(e.name, dir);
    if (s) out.push({ name: s.name, description: s.description, files: s.files, updatedAt: s.updatedAt });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readLibrarySkill(name: string, dir = LIBRARY_DIR) {
  if (!NAME.test(name)) return null;
  const file = skillFile(dir, name);
  const [text, st] = await Promise.all([fs.readFile(file, 'utf8').catch(() => null), fs.stat(file).catch(() => null)]);
  if (text === null || !st) return null;
  const fm = parseFrontmatter(text);
  const files = (await listFiles(path.join(dir, name))).filter((f) => f !== 'SKILL.md');
  return { name, description: str(fm.data.description) ?? '', body: fm.body.replace(/^\n+/, ''), files, updatedAt: st.mtime.toISOString(), extra: extraOf(fm.data) };
}

/** Cria ou edita o SKILL.md (renomear move a pasta). Os outros campos do frontmatter ficam. */
export async function saveLibrarySkill(body: unknown, dir = LIBRARY_DIR): Promise<LibrarySkill> {
  const parsed = SkillInput.safeParse(body);
  if (!parsed.success) throw new SkillError(parsed.error.issues[0]?.message ?? 'skill inválida');
  const s = parsed.data;
  // Skill vai para a sessão de quem a tem: segredo escrito nela iria junto, para o modelo.
  const secret = findSecret(`${s.description}\n${s.body}`);
  if (secret) throw new SkillError(`${secret.label} no texto da skill: tire e use uma variável de ambiente`);
  const prev = s.originalName ? await readLibrarySkill(s.originalName, dir) : null;
  if (s.originalName && !prev) throw new SkillError('skill não encontrada na biblioteca');
  if (s.name !== s.originalName && (await exists(path.join(dir, s.name)))) throw new SkillError(`já existe a skill ${s.name}`);
  if (prev && s.name !== s.originalName) await fs.rename(path.join(dir, s.originalName!), path.join(dir, s.name));
  const front = stringify({ name: s.name, description: s.description, ...(prev?.extra ?? {}) }).trimEnd();
  await writeAtomic(skillFile(dir, s.name), `---\n${front}\n---\n\n${s.body.replace(/\r\n/g, '\n').trimEnd()}\n`);
  const saved = (await readLibrarySkill(s.name, dir))!;
  return { name: saved.name, description: saved.description, files: saved.files, updatedAt: saved.updatedAt };
}

/** Tira da biblioteca: a pasta vai para `.lixeira` (dá para recuperar), nada é apagado. */
export async function removeLibrarySkill(name: string, dir = LIBRARY_DIR): Promise<boolean> {
  if (!NAME.test(name) || !(await exists(path.join(dir, name)))) return false;
  await fs.mkdir(path.join(dir, TRASH), { recursive: true });
  await fs.rename(path.join(dir, name), path.join(dir, TRASH, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  return true;
}

/**
 * Copia uma skill da conta (`~/.claude/skills/<nome>`, que todas as sessões veem) para a
 * biblioteca. Só copia: a original continua onde está (hooks e outras sessões podem depender
 * dela); para restringir de vez, você apaga a da conta depois.
 */
export async function copyToLibrary(name: string, accountSkillsDir: string, dir = LIBRARY_DIR): Promise<LibrarySkill> {
  if (!NAME.test(name)) throw new SkillError('nome de skill inválido');
  const src = path.join(accountSkillsDir, name);
  const st = await fs.lstat(src).catch(() => null);
  if (!st?.isDirectory()) throw new SkillError('só dá para copiar uma pasta de skill da conta (não um link nem as sincronizadas)');
  if (!(await exists(skillFile(accountSkillsDir, name)))) throw new SkillError('essa pasta não tem SKILL.md');
  if (await exists(path.join(dir, name))) throw new SkillError(`já existe a skill ${name} na biblioteca`);
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(src, path.join(dir, name), { recursive: true, errorOnExist: true, dereference: false });
  const saved = (await readLibrarySkill(name, dir))!;
  return { name: saved.name, description: saved.description, files: saved.files, updatedAt: saved.updatedAt };
}

/** Das skills de uma ficha, as que estão na biblioteca. */
export async function librarySkillsOf(names: string[], dir = LIBRARY_DIR): Promise<string[]> {
  const out: string[] = [];
  for (const n of [...new Set(names)]) if (NAME.test(n) && (await exists(skillFile(dir, n)))) out.push(n);
  return out;
}

/**
 * O plugin da sessão: só as skills da biblioteca que estão na ficha (as outras da lista são do
 * projeto ou da conta, e o Claude Code já acha). Copiadas a cada sessão: vale o que está na
 * biblioteca agora. Sem nenhuma, devolve null (nada de `--plugin-dir`).
 */
export async function buildSkillPlugin(names: string[], target: string, dir = LIBRARY_DIR): Promise<{ dir: string; skills: string[] } | null> {
  const found = await librarySkillsOf(names, dir);
  await fs.rm(target, { recursive: true, force: true });
  if (!found.length) return null;
  await writeAtomic(
    path.join(target, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills da biblioteca do Claudio’s Club para este funcionário', author: { name: 'Claudio’s Club' } }, null, 2) + '\n',
  );
  for (const n of found) await fs.cp(path.join(dir, n), path.join(target, 'skills', n), { recursive: true });
  return { dir: target, skills: found };
}

/** Os campos do frontmatter que o Claudio’s Club não edita (allowed-tools, disable-model-invocation…). */
function extraOf(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !RESERVED.has(k)));
}

async function listFiles(root: string, rel = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else out.push(p);
    if (out.length > 200) break;
  }
  return out;
}

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
