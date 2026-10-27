import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { BUILTIN_ROLES, type RoleEntry, type RoleTemplate } from '../shared/roles';
import { MYCO_HOME } from './config';
import { writeAtomic } from './staff/store';

// Cargos da empresa: os prontos (shared/roles.ts) + os seus, em ~/.myco/roles.json:
//   items:     os seus cargos e as suas versões dos prontos (mesmo id do pronto)
//   removed:   prontos que você tirou da lista
//   defaultId: o cargo que já vem preenchido ao contratar (null = começa em branco)
// Um pronto novo numa versão futura do MyCo aparece sozinho (não está em `removed`).

export class RoleError extends Error {}

const FILE = path.join(MYCO_HOME, 'roles.json');
const BUILTIN_IDS = new Set(BUILTIN_ROLES.map((r) => r.id));
const line = (max: number) => z.string().trim().max(max);

export const RoleInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'id de cargo inválido').optional(),
  label: line(60).min(1, 'dê um nome ao cargo'),
  role: line(60).min(1, 'informe o cargo que vai para a ficha'),
  mission: line(4000).min(1, 'informe a missão'),
  autonomy: z.enum(['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions']),
  rules: z.array(line(500)).max(50).default([]),
  doneWhen: line(2000).default(''),
  model: z.string().regex(/^[\w.[\]-]{0,60}$/, 'modelo inválido').default(''),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
  pickExecutors: z.boolean().optional(),
  playbook: z.enum(['plan-big-execute-small', 'scout-then-build', 'review-gate']).nullable().optional(),
  worktree: z.boolean().optional(),
  skills: z.array(z.string().max(100)).max(50).optional(),
  servers: z.boolean().optional(),
});

interface RolesFile {
  items: RoleTemplate[];
  removed: string[];
  defaultId: string | null;
}

export async function readRolesFile(file = FILE): Promise<RolesFile> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  try {
    const d = raw ? (JSON.parse(raw.replace(/^﻿/, '')) as Partial<RolesFile>) : {};
    const items = (Array.isArray(d.items) ? d.items : []).flatMap((r) => {
      const ok = RoleInput.safeParse(r);
      return ok.success && ok.data.id ? [{ ...ok.data, id: ok.data.id } as RoleTemplate] : [];
    });
    return { items, removed: Array.isArray(d.removed) ? d.removed.filter((x) => typeof x === 'string') : [], defaultId: typeof d.defaultId === 'string' ? d.defaultId : null };
  } catch {
    return { items: [], removed: [], defaultId: null };
  }
}

/** A lista que você vê: prontos (na sua versão, se editou) e depois os seus, na ordem de criação. */
export async function listRoles(file = FILE): Promise<RoleEntry[]> {
  const f = await readRolesFile(file);
  const mine = new Map(f.items.map((r) => [r.id, r]));
  const builtins = BUILTIN_ROLES.filter((r) => !f.removed.includes(r.id)).map((r) => ({
    ...(mine.get(r.id) ?? r),
    builtin: true,
    edited: mine.has(r.id),
    isDefault: f.defaultId === r.id,
  }));
  const custom = f.items.filter((r) => !BUILTIN_IDS.has(r.id)).map((r) => ({ ...r, builtin: false, edited: false, isDefault: f.defaultId === r.id }));
  return [...builtins, ...custom];
}

/** Cria (sem id) ou atualiza um cargo; editar um pronto guarda a sua versão dele. */
export async function saveRole(body: unknown, file = FILE): Promise<RoleEntry[]> {
  const parsed = RoleInput.safeParse(body);
  if (!parsed.success) throw new RoleError(parsed.error.issues[0]?.message ?? 'cargo inválido');
  const f = await readRolesFile(file);
  const id = parsed.data.id ?? uniqueId(parsed.data.label, f);
  const role = { ...parsed.data, id } as RoleTemplate;
  const exists = f.items.some((r) => r.id === id);
  if (!exists && !BUILTIN_IDS.has(id) && parsed.data.id) throw new RoleError('cargo não encontrado');
  f.items = exists ? f.items.map((r) => (r.id === id ? role : r)) : [...f.items, role];
  f.removed = f.removed.filter((x) => x !== id);
  await write(f, file);
  return listRoles(file);
}

/** Pronto: volta ao original. Seu: apaga. Pronto sem edição: tira da lista. */
export async function removeRole(id: string, file = FILE): Promise<RoleEntry[]> {
  const f = await readRolesFile(file);
  const edited = f.items.some((r) => r.id === id);
  if (BUILTIN_IDS.has(id)) {
    if (edited) f.items = f.items.filter((r) => r.id !== id);
    else if (!f.removed.includes(id)) f.removed.push(id);
  } else {
    if (!edited) throw new RoleError('cargo não encontrado');
    f.items = f.items.filter((r) => r.id !== id);
  }
  // Some da lista (seu apagado ou pronto tirado): deixa de ser o padrão. Voltar ao original, não.
  const gone = !BUILTIN_IDS.has(id) || !edited;
  if (gone && f.defaultId === id) f.defaultId = null;
  await write(f, file);
  return listRoles(file);
}

/** Traz de volta os prontos que você tirou da lista. */
export async function restoreBuiltins(file = FILE): Promise<RoleEntry[]> {
  const f = await readRolesFile(file);
  f.removed = [];
  await write(f, file);
  return listRoles(file);
}

/** O cargo que já vem preenchido ao contratar; null = começa em branco. */
export async function setDefaultRole(id: string | null, file = FILE): Promise<RoleEntry[]> {
  const f = await readRolesFile(file);
  if (id && !(await listRoles(file)).some((r) => r.id === id)) throw new RoleError('cargo não encontrado');
  f.defaultId = id;
  await write(f, file);
  return listRoles(file);
}

function uniqueId(label: string, f: RolesFile): string {
  const base =
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'cargo';
  const taken = new Set([...BUILTIN_IDS, ...f.items.map((r) => r.id)]);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

async function write(f: RolesFile, file: string) {
  await writeAtomic(file, JSON.stringify(f, null, 2) + '\n');
}
