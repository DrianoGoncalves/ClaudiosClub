import { promises as fs } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { z } from 'zod';
import { findSecret } from './chat/secrets';
import type { SkillScope } from './adapters/claude/skillWrite';
import { SkillError } from './skillLibrary';

// Criar uma skill nova na conta (Global) ou num projeto: em branco (SKILL.md com nome e descrição) ou como cópia de uma
// skill Global (cópia independente: depois, mexer numa não mexe na outra). Nada é sobrescrito: nome que já existe recusa.
// O navegador só manda o escopo e o id do projeto; a pasta sai de `resolveTarget` (ver skillScopeOf em index.ts).

/** Nome de skill nova: minúsculas, números e hífen (sem caminho, sem maiúscula). */
export const CREATE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_BODY = 100_000;
const RESERVED_USER = 'synced';

export const CreateSkillInput = z
  .object({
    scope: z.enum(['user', 'project']),
    projectId: z.string().max(200).nullable().optional(),
    name: z.string().regex(CREATE_NAME, 'nome: minúsculas, números e hífen (até 64), começando por letra ou número'),
    source: z.enum(['blank', 'copy']),
    description: z.string().trim().max(1024, 'descrição longa demais (até 1024)').optional(),
    body: z.string().max(MAX_BODY, 'instruções longas demais (até 100 mil caracteres)').optional(),
    from: z.string().max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source === 'blank' && !v.description) ctx.addIssue({ code: 'custom', path: ['description'], message: 'a descrição é o que faz a skill ser chamada: escreva quando usar' });
    if (v.source === 'copy' && !v.from) ctx.addIssue({ code: 'custom', path: ['from'], message: 'escolha a skill da conta que vai ser copiada' });
    if (v.source === 'copy' && v.scope !== 'project') ctx.addIssue({ code: 'custom', path: ['scope'], message: 'a cópia vai para um projeto (a da conta já é a Global)' });
    if (v.scope === 'user' && v.name === RESERVED_USER) ctx.addIssue({ code: 'custom', path: ['name'], message: 'synced é a pasta das skills da conta: escolha outro nome' });
  });

export interface CreateSkillOptions {
  /** A pasta de skills do escopo (o servidor monta a partir do id do projeto). */
  resolveTarget: (scope: 'user' | 'project', projectId: string | null) => Promise<SkillScope>;
  /** A pasta de skills da conta (`~/.claude/skills`), de onde sai a cópia. */
  globalRoot: string;
}

/**
 * Cria a skill e devolve o nome e quantos arquivos entraram. Recusa (sem gravar nada) nome inválido, nome que já existe, origem
 * com link, sem SKILL.md, grande demais ou com segredo. Lança `SkillError` com o motivo.
 */
export async function createSkill(raw: unknown, o: CreateSkillOptions): Promise<{ name: string; files: number }> {
  const parsed = CreateSkillInput.safeParse(raw);
  if (!parsed.success) throw new SkillError(parsed.error.issues[0]?.message ?? 'pedido inválido');
  const b = parsed.data;
  const target = await o.resolveTarget(b.scope, b.projectId ?? null);
  const taken = await fs.readdir(target.root).then(
    (names) => names.includes(b.name),
    () => false,
  );
  if (taken) throw new SkillError(`já existe a skill ${b.name}`);
  if (b.source === 'blank') return writeBlank(target.root, b.name, b.description ?? '', b.body ?? '');
  return copyFromGlobal(target.root, b.name, b.from ?? '', o.globalRoot);
}

/** Pasta nova (sem `recursive`: nunca reaproveita uma que já existe) e o SKILL.md do modelo em branco. */
async function writeBlank(root: string, name: string, description: string, body: string): Promise<{ name: string; files: number }> {
  // Skill vai para a sessão de quem a tem: segredo escrito nela iria junto, para o modelo.
  const secret = findSecret(`${description}\n${body}`);
  if (secret) throw new SkillError(`${secret.label} no texto da skill: tire e use uma variável de ambiente`);
  const text = `---\n${stringify({ name, description }).trimEnd()}\n---\n\n${body.replace(/\r\n/g, '\n').trimEnd()}\n`;
  const dir = await makeDir(root, name);
  try {
    await fs.writeFile(path.join(dir, 'SKILL.md'), text, { flag: 'wx' });
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { name, files: 1 };
}

/** Cópia de uma skill Global para o projeto: confere a origem inteira antes de copiar; depois, o `name:` vira o novo nome se mudou. */
async function copyFromGlobal(root: string, name: string, from: string, globalRoot: string): Promise<{ name: string; files: number }> {
  if (!CREATE_NAME.test(from) || from === RESERVED_USER) throw new SkillError('essa skill da conta não pode ser copiada');
  const src = path.join(globalRoot, from);
  const st = await fs.lstat(src).catch(() => null);
  if (!st) throw new SkillError(`não existe a skill ${from} na conta`);
  if (st.isSymbolicLink()) throw new SkillError(`${from} é um link (symlink ou junction): não copio`);
  if (!st.isDirectory()) throw new SkillError(`${from} não é uma pasta de skill`);
  const files = await walk(src);
  if (!files.some((f) => f.rel === 'SKILL.md')) throw new SkillError(`${from} não tem SKILL.md`);
  let total = 0;
  for (const f of files) {
    total += f.size;
    const buf = await fs.readFile(f.abs);
    if (buf.includes(0)) continue; // binário: não há texto para conferir
    const secret = findSecret(buf.toString('utf8'));
    if (secret) throw new SkillError(`${secret.label} em ${from}/${f.rel}: tire o segredo da skill antes de copiar`);
  }
  if (total > MAX_BYTES) throw new SkillError('skill grande demais para copiar (máx. 5 MB no total)');
  const dir = await makeDir(root, name);
  try {
    // A pasta de destino já existe (é a trava de makeDir): copia o conteúdo de cada item da origem para dentro dela.
    for (const e of await fs.readdir(src)) await fs.cp(path.join(src, e), path.join(dir, e), { recursive: true, errorOnExist: true, force: false, dereference: false });
    if (name !== from) {
      const md = path.join(dir, 'SKILL.md');
      await fs.writeFile(md, withName(await fs.readFile(md, 'utf8'), name));
    }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return { name, files: files.length };
}

/** Todos os arquivos da pasta. Link em qualquer nível recusa; mais de 200 arquivos recusa. */
async function walk(root: string, rel = '', out: Array<{ rel: string; abs: string; size: number }> = []): Promise<Array<{ rel: string; abs: string; size: number }>> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new SkillError(`${p} é um link (symlink ou junction): não copio uma skill com link dentro`);
    if (e.isDirectory()) {
      await walk(root, p, out);
      continue;
    }
    if (!e.isFile()) continue;
    const abs = path.join(root, p);
    out.push({ rel: p, abs, size: (await fs.stat(abs)).size });
    if (out.length > MAX_FILES) throw new SkillError(`skill com mais de ${MAX_FILES} arquivos: não copio`);
  }
  return out;
}

/** O `name:` do frontmatter vira o nome novo (ou entra, se não tinha). Sem frontmatter, ganha um. */
export function withName(md: string, name: string): string {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return `---\nname: ${name}\n---\n\n${md}`;
  const front = /^name:/m.test(m[1] ?? '') ? (m[1] ?? '').replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n${m[1] ?? ''}`;
  return `---\n${front}\n---${md.slice(m[0].length)}`;
}

/** Cria a pasta nova (sem `recursive`). Já existe: recusa. A pasta de skills é criada se faltar. */
async function makeDir(root: string, name: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const dir = path.join(root, name);
  try {
    await fs.mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new SkillError(`já existe a skill ${name}`);
    throw err;
  }
  return dir;
}
