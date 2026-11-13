import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { findSecret } from '../../chat/secrets';
import { SkillError } from '../../skillLibrary';
import { linkInfo, listDir } from './fsutil';

// Editar e excluir as skills da conta (`~/.claude/skills/<nome>`) e do projeto (`<projeto>/.claude/skills/<nome>`)
// pelo Claudio’s Club. Só o SKILL.md é gravado (o resto da pasta fica como está) e nada é renomeado. Excluir manda a
// pasta inteira para a lixeira (recuperável). O servidor monta a pasta do escopo; o navegador só manda o nome.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_CONTENT = 200_000;
const TRASH = '.lixeira';

export const SkillRefInput = z.object({
  scope: z.enum(['project', 'user']),
  projectId: z.string().max(200).nullable().default(null),
  name: z.string().regex(NAME, 'nome: letras, números, _ e hífen (até 64), começando por letra ou número'),
});

export const SkillSaveInput = SkillRefInput.extend({
  content: z
    .string()
    .max(MAX_CONTENT, 'SKILL.md longo demais (até 200 mil caracteres)')
    .refine((s) => s.trim().length > 0, 'o SKILL.md está vazio'),
});

export const SkillDeleteInput = SkillRefInput.extend({
  // Só na confirmação (o aviso devolveu `hooks`). O servidor confere que é o mesmo conjunto antes de tirar qualquer coisa.
  removeHooks: z
    .array(z.object({ file: z.string().max(1000), event: z.string().max(100) }))
    .max(500)
    .optional(),
});

/** A pasta de skills de um escopo. `owner` é 'user' ou o id do projeto (vai no nome do backup e da lixeira). */
export interface SkillScope {
  scope: 'user' | 'project';
  owner: string;
  root: string;
}
export type SkillTarget = SkillScope & { name: string };

export interface SkillSource {
  name: string;
  content: string;
  /** Dá para salvar e apagar (sem link, dentro da pasta de skills e não sincronizada). */
  editable: boolean;
  /** Para onde aponta o link (pasta ou SKILL.md), quando é um. */
  link: string | null;
}

/** Um hook (no settings `file`, no evento `event`) que aponta para a skill. Nunca leva o texto do comando. */
export interface HookRef {
  file: string;
  event: string;
}

/**
 * Sem `removeHooks` e com hooks: `needsConfirm` (nada foi apagado). Com `removeHooks` (confirmados): `trash`, os hooks
 * tirados e os backups dos settings. Sem hooks e sem confirmação: só `trash`.
 */
export type DeleteSkillResult = { needsConfirm: true; hooks: HookRef[] } | { trash: string; removedHooks?: HookRef[]; settingsBackups?: string[] };

/** Pastas de settings que podem ter hooks para as skills: as da conta e as dos projetos dados. */
export function hookFilesOf(claudeHome: string, projectPaths: string[]): string[] {
  const names = ['settings.json', 'settings.local.json'];
  const files = [...names.map((f) => path.join(claudeHome, f)), ...projectPaths.flatMap((p) => names.map((f) => path.join(p, '.claude', f)))];
  return [...new Set(files)];
}

export async function readSkillSource(t: SkillTarget): Promise<SkillSource> {
  const found = await locate(t, 'read');
  const content = await fs.readFile(found.file, 'utf8');
  const editable = await locate(t, 'write').then(
    () => true,
    () => false,
  );
  return { name: t.name, content, editable, link: found.link };
}

/** Grava o SKILL.md inteiro. A versão anterior vai para `backupDir`. Não renomeia a pasta. */
export async function saveSkill(o: SkillTarget & { content: string; backupDir: string }): Promise<SkillSource> {
  // Skill vai para a sessão de quem a tem: segredo escrito nela iria junto, para o modelo (mesma regra da biblioteca).
  const secret = findSecret(o.content);
  if (secret) throw new SkillError(`${secret.label} no texto da skill: tire e use uma variável de ambiente`);
  const before = await locate(o, 'write');
  const previous = await fs.readFile(before.file, 'utf8');
  await fs.mkdir(o.backupDir, { recursive: true });
  await fs.writeFile(path.join(o.backupDir, `${tagOf(o)}.${stamp()}-${randomUUID().slice(0, 6)}.md`), previous, { flag: 'wx' });
  // Revalida logo antes de gravar: a pasta pode ter mudado desde a leitura acima.
  const now = await locate(o, 'write');
  await fs.writeFile(now.file, o.content);
  return readSkillSource(o);
}

/**
 * Manda a pasta da skill para a lixeira (`<backupDir>/.lixeira`). Antes, lê os settings dados (`hookFiles`) atrás de hooks
 * que apontem para ela. Achou e sem confirmação: não apaga nada e devolve `needsConfirm` com (arquivo, evento). Com
 * confirmação (`removeHooks`): confere que é o mesmo conjunto, faz backup de cada settings afetado em `settingsBackupDir`,
 * tira só esses hooks e manda a skill para a lixeira. Se isso falhar, os settings voltam ao backup.
 * Settings ilegível ou inválido bloqueia sempre. Nada do comando do hook vai para a mensagem.
 */
export async function deleteSkill(
  o: SkillTarget & { backupDir: string; settingsBackupDir: string; hookFiles: string[]; removeHooks?: HookRef[] },
): Promise<DeleteSkillResult> {
  const found = await locate(o, 'write');
  const plan = await planHooks(o.hookFiles, found.dir, o.name);
  if (!o.removeHooks) {
    if (plan.hooks.length > 0) return { needsConfirm: true, hooks: plan.hooks };
  } else if (!sameHooks(plan.hooks, o.removeHooks)) {
    throw new SkillError('os hooks mudaram desde o aviso: confirme de novo');
  }
  // Daqui para baixo mexe no disco: backup e settings novos primeiro, depois a lixeira. Se a lixeira falha, os settings voltam.
  const made: { file: string; backup: string }[] = [];
  try {
    if (plan.changes.length > 0) await fs.mkdir(o.settingsBackupDir, { recursive: true });
    for (const c of plan.changes) {
      const backup = path.join(o.settingsBackupDir, `${safeFileName(c.file)}.${stamp()}-${randomUUID().slice(0, 6)}.json`);
      await fs.writeFile(backup, c.raw, { flag: 'wx' });
      made.push({ file: c.file, backup });
      await writeAtomic(c.file, c.next);
    }
    const trash = await moveToTrash(o);
    return o.removeHooks ? { trash, removedHooks: plan.hooks, settingsBackups: made.map((m) => m.backup) } : { trash };
  } catch (err) {
    const stuck = await restoreSettings(made);
    if (stuck.length > 0) {
      throw new SkillError(`a exclusão falhou e não consegui restaurar ${stuck.join(', ')}: os backups estão em ${made.map((m) => m.backup).join(', ')}`);
    }
    throw err;
  }
}

/** Revalida a pasta logo antes de mover (ela pode ter virado link ou mudado de lugar) e manda para `<backupDir>/.lixeira`. */
async function moveToTrash(o: SkillTarget & { backupDir: string }): Promise<string> {
  const now = await locate(o, 'write');
  const trashDir = path.join(o.backupDir, TRASH);
  await fs.mkdir(trashDir, { recursive: true });
  const dest = path.join(trashDir, `${tagOf(o)}-${stamp()}-${randomUUID().slice(0, 8)}`);
  await moveDir(now.dir, dest);
  return dest;
}

interface Found {
  dir: string;
  file: string;
  link: string | null;
}

/**
 * Acha a pasta da skill pelo nome que está no disco (não monta caminho a partir do pedido). Para gravar ou apagar, recusa
 * link (pasta ou SKILL.md), pasta fora da raiz do escopo e as sincronizadas da conta. Leitura só informa o link.
 */
async function locate(t: SkillTarget, mode: 'read' | 'write'): Promise<Found> {
  const writing = mode === 'write';
  if (!NAME.test(t.name)) throw new SkillError('nome de skill inválido');
  if (writing && t.scope === 'user' && t.name.toLowerCase() === 'synced') throw new SkillError('as skills sincronizadas da conta são da conta: só leitura');
  if (!(await listDir(t.root)).some((e) => e.name === t.name)) throw new SkillError('skill não encontrada');
  const dir = path.join(t.root, t.name);
  const dirSt = await fs.lstat(dir).catch(() => null);
  if (!dirSt || !(dirSt.isDirectory() || dirSt.isSymbolicLink())) throw new SkillError('skill não encontrada');
  const file = path.join(dir, 'SKILL.md');
  const fileSt = await fs.lstat(file).catch(() => null);
  if (!fileSt || !(fileSt.isFile() || fileSt.isSymbolicLink())) throw new SkillError('essa pasta não tem SKILL.md');
  const linkOfDir = dirSt.isSymbolicLink();
  const link = linkOfDir ? await targetOf(dir) : fileSt.isSymbolicLink() ? await targetOf(file) : null;
  if (writing) {
    if (link !== null) {
      throw new SkillError(`${linkOfDir ? 'a pasta da skill' : 'o SKILL.md'} é um link (symlink ou junction) para ${link}: não dá para editar nem apagar pelo Claudio’s Club`);
    }
    const realRoot = await fs.realpath(t.root);
    const realDir = await fs.realpath(dir);
    if (!isInside(realRoot, realDir)) throw new SkillError('a skill não fica dentro da pasta de skills do escopo');
    const synced = t.scope === 'user' ? await fs.realpath(path.join(t.root, 'synced')).catch(() => null) : null;
    if (synced && isInside(synced, realDir)) throw new SkillError('as skills sincronizadas da conta são da conta: só leitura');
  }
  return { dir, file, link };
}

/** Caminho dentro da raiz (estrito: a própria raiz não conta). Compara sem caixa e com `\` e `/` iguais no Windows. */
function isInside(root: string, p: string): boolean {
  const key = (x: string) => {
    const r = path.resolve(x);
    return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
  };
  const rel = path.relative(key(root), key(p));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function targetOf(p: string): Promise<string> {
  const info = await linkInfo(p).catch(() => null);
  return info?.target ?? '(destino não lido)';
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

interface HookPlan {
  /** (settings, evento) com hook da skill. */
  hooks: HookRef[];
  /** Settings que mudam: o texto original (para o backup) e o texto novo. */
  changes: { file: string; raw: string; next: string }[];
}

/**
 * Lê os settings sem executar nada: quais (settings, evento) têm hook da skill e o texto novo de cada settings que muda.
 * Arquivo que não dá para ler ou entender bloqueia (sempre, com ou sem confirmação).
 */
async function planHooks(files: string[], dir: string, name: string): Promise<HookPlan> {
  const hooks: HookRef[] = [];
  const changes: HookPlan['changes'] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new SkillError(`não consigo ler ${file}: confira o arquivo antes de apagar a skill`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.replace(/^﻿/, ''));
    } catch {
      throw new SkillError(`${file} não é um JSON válido: corrija antes de apagar a skill`);
    }
    if (!isObj(json)) throw new SkillError(`${file} não é um objeto JSON: corrija antes de apagar a skill`);
    const hooksNode = json.hooks;
    if (hooksNode === undefined) continue;
    if (!isObj(hooksNode)) throw new SkillError(`o campo hooks de ${file} tem formato inválido: corrija antes de apagar a skill`);

    const nextHooks: Record<string, unknown> = {};
    let count = 0;
    for (const [event, groups] of Object.entries(hooksNode)) {
      const r = pruneEvent(groups, dir, name);
      if (!r) throw new SkillError(`hook de ${event} em ${file} aponta para esta skill num formato que não dá para tirar sozinho: tire o hook antes de apagar`);
      if (r.removed === 0) {
        nextHooks[event] = groups;
        continue;
      }
      hooks.push({ file, event });
      count++;
      if (r.groups.length > 0) nextHooks[event] = r.groups;
    }
    if (count === 0) continue;

    const next: Record<string, unknown> = { ...json };
    if (Object.keys(nextHooks).length > 0) next.hooks = nextHooks;
    else delete next.hooks;
    changes.push({ file, raw, next: JSON.stringify(next, null, 2) + '\n' });
  }
  return { hooks, changes };
}

/**
 * Tira de um evento os hooks (objetos com command/args) que apontam para a skill. Grupo `{ matcher?, hooks: [...] }` que
 * fica sem hooks sai; o resto fica igual. `null`: aponta para a skill numa forma que não dá para tirar com segurança.
 */
function pruneEvent(groups: unknown, dir: string, name: string): { groups: unknown[]; removed: number } | null {
  const points = (node: unknown) => commandStrings(node).some((c) => pointsAt(c, dir, name));
  if (!Array.isArray(groups)) return points(groups) ? null : { groups: [], removed: 0 };
  const out: unknown[] = [];
  let removed = 0;
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) {
      if (points(g)) return null;
      out.push(g);
      continue;
    }
    const { hooks, ...rest } = g;
    if (points(rest)) return null;
    const all = hooks as unknown[];
    const keep = all.filter((h) => !(isObj(h) && points(h)));
    const n = all.length - keep.length;
    removed += n;
    if (n === 0) out.push(g);
    else if (keep.length > 0) out.push({ ...g, hooks: keep });
  }
  return { groups: out, removed };
}

/** A confirmação tem de ser exatamente o que o servidor acha agora (sem ordem, sem sobra nem falta). */
function sameHooks(found: HookRef[], asked: HookRef[]): boolean {
  const key = (h: HookRef) => `${h.file}\n${h.event}`;
  const a = new Set(found.map(key));
  const b = new Set(asked.map(key));
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/** Devolve cada settings ao conteúdo do seu backup. Devolve os arquivos que não deu para restaurar. */
async function restoreSettings(made: { file: string; backup: string }[]): Promise<string[]> {
  const stuck: string[] = [];
  for (const m of made) {
    try {
      await writeAtomic(m.file, await fs.readFile(m.backup));
    } catch {
      stuck.push(m.file);
    }
  }
  return stuck;
}

/** Grava por arquivo temporário ao lado e troca pelo nome: quem lê nunca pega o settings pela metade. */
async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, data, { flag: 'wx' });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Nome do backup de um settings: o nome do arquivo e 8 dígitos do caminho (projetos com o mesmo nome não colidem). */
function safeFileName(file: string): string {
  const base = path.basename(file).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${base}-${createHash('sha256').update(file).digest('hex').slice(0, 8)}`;
}

/** Os `command` e `args` de qualquer hook dentro do nó (texto, nunca executado). */
function commandStrings(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) commandStrings(x, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'command' && typeof value === 'string') out.push(value);
    else if (key === 'args') {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) out.push(...value.filter((v): v is string => typeof v === 'string'));
    } else commandStrings(value, out);
  }
  return out;
}

/** O comando aponta para a pasta (caminho absoluto) ou para `skills/<nome>` (relativo, `~`, `%USERPROFILE%`). Barras e caixa não contam. */
function pointsAt(command: string, dir: string, name: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  const text = norm(command);
  const end = `(?=/|["' \\t]|$)`;
  const absolute = new RegExp(`${escapeRe(norm(dir))}${end}`);
  const relative = new RegExp(`(^|/)skills/${escapeRe(name.toLowerCase())}${end}`);
  return absolute.test(text) || relative.test(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  // Outro volume: copia e só apaga a origem depois da cópia inteira. Se a cópia falhar, a origem fica como está.
  try {
    await fs.cp(from, to, { recursive: true, errorOnExist: true, dereference: false });
  } catch (err) {
    await fs.rm(to, { recursive: true, force: true });
    throw err;
  }
  await fs.rm(from, { recursive: true });
}

const tagOf = (t: SkillScope & { name: string }) => `${t.scope}-${t.owner.replace(/[^A-Za-z0-9_-]/g, '_')}-${t.name}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
