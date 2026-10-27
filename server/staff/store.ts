import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { StaffProfile } from '../../shared/model';
import { cronError } from '../../shared/cron';
import { listDir, tryJson } from '../adapters/claude/fsutil';
import { ensureMycoGitignore } from '../mycoGitignore';
import { slugify } from './ficha';

// Fichas ficam no próprio projeto: <projeto>/.myco/staff/<id>.json (+ .md gerado, memória e retrato).

export const AUTONOMY = ['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PLAYBOOKS = ['plan-big-execute-small', 'scout-then-build', 'review-gate'] as const;
const percent = z.number().min(1).max(100).nullable();
export const UsageStopSchema = z.object({ fiveHour: percent.default(null), sevenDay: percent.default(null) });
const line = (max: number) => z.string().trim().max(max);
const list = (max: number) => z.array(line(500)).max(max).default([]);

/** O que o questionário (ou um funcionário com permissão) envia. */
export const StaffInputSchema = z.object({
  name: line(60).min(1, 'informe o nome'),
  role: line(60).min(1, 'informe o cargo'),
  // Fichas antigas (e pedidos pela API) podem trazer um gestor só, como texto.
  reportsTo: z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? [] : typeof v === 'string' ? [v] : v),
    z.array(z.string().max(80)).max(10),
  ),
  mission: line(4000).min(1, 'informe a missão'),
  firstTask: line(4000).default(''),
  autonomy: z.enum(AUTONOMY).default('manual'),
  agents: list(100),
  skills: list(100),
  mcps: z.array(line(100)).max(100).nullable().default(null),
  knowledge: list(50),
  rules: list(50),
  doneWhen: line(2000).default(''),
  // Alias ou id de modelo: só caracteres seguros na linha de comando.
  model: z.string().regex(/^[\w.[\]-]{1,60}$/, 'modelo inválido').nullable().default(null),
  effort: z.enum(EFFORT).nullable().default(null),
  canHire: z.boolean().default(false),
  usageStop: UsageStopSchema.nullable().default(null),
  playbook: z.enum(PLAYBOOKS).nullable().default(null),
  worktree: z.boolean().default(false),
  servers: z.array(z.string().regex(/^[\w.-]{1,60}$/, 'servidor inválido')).max(30).default([]),
  browser: z.boolean().default(false),
  portraitDataUrl: z.string().max(3_000_000, 'retrato grande demais (máx. 2 MB)').nullable().optional(),
  launch: z.boolean().optional(),
  /** Sessão aberta fora do MyCo que passa a ser deste funcionário (ganha ficha, nome e retrato). */
  adoptSessionId: z.string().uuid().optional(),
  /** Abrir mesmo com o consumo acima da linha de parada (confirmado no MyCo). */
  force: z.boolean().optional(),
});
export type StaffInputParsed = z.infer<typeof StaffInputSchema>;

/** Rotina agendada: fica fora do questionário (editar a ficha não apaga as rotinas; pela API não se agenda). */
export const RoutineSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'id de rotina inválido'),
  name: line(60).min(1, 'dê um nome à rotina'),
  schedule: z
    .string()
    .trim()
    .max(100)
    .superRefine((v, ctx) => {
      const err = cronError(v);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `horário: ${err}` });
    }),
  message: line(4000).min(1, 'escreva a mensagem da rotina'),
  mode: z.enum(['continue', 'new']).default('continue'),
  enabled: z.boolean().default(true),
});
export const RoutinesSchema = z.array(RoutineSchema).max(10, 'no máximo 10 rotinas por funcionário');

const ProfileSchema = StaffInputSchema.omit({ portraitDataUrl: true, launch: true, adoptSessionId: true, force: true }).extend({
  id: z.string(),
  projectId: z.string(),
  portrait: z.string().nullable(),
  routines: RoutinesSchema.optional().catch(undefined),
  sessions: z.array(z.object({ id: z.string(), startedAt: z.string(), cwd: z.string().optional() })).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const staffDir = (projectPath: string) => path.join(projectPath, '.myco', 'staff');
export const fichaFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.md`);
export const memoryFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.memory.md`);
const profileFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.json`);

const SAFE_ID = /^[a-z0-9-]{1,40}$/;

export async function listProjectStaff(projectPath: string, projectId: string): Promise<StaffProfile[]> {
  const entries = await listDir(staffDir(projectPath));
  const out: StaffProfile[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const p = await readProfile(projectPath, e.name.slice(0, -5));
    // A pasta pode ter vindo de outro computador (repositório clonado): o id do projeto é o desta máquina.
    if (p) out.push({ ...p, projectId });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function readProfile(projectPath: string, id: string): Promise<StaffProfile | null> {
  if (!SAFE_ID.test(id)) return null;
  const raw = await fs.readFile(profileFile(projectPath, id), 'utf8').catch(() => null);
  if (raw === null) return null;
  const parsed = ProfileSchema.safeParse(tryJson(raw.replace(/^﻿/, '')));
  return parsed.success ? (parsed.data as StaffProfile) : null;
}

export async function saveProfile(projectPath: string, p: StaffProfile): Promise<void> {
  await writeAtomic(profileFile(projectPath, p.id), JSON.stringify(p, null, 2) + '\n');
}

export async function createProfile(
  projectPath: string,
  projectId: string,
  input: StaffInputParsed,
  now = new Date(),
  sessions: StaffProfile['sessions'] = [],
): Promise<StaffProfile> {
  const id = `${slugify(input.name)}-${randomBytes(2).toString('hex')}`;
  const { portraitDataUrl, launch: _launch, adoptSessionId: _adopt, force: _force, ...fields } = input;
  const portrait = portraitDataUrl ? await savePortrait(projectPath, id, portraitDataUrl) : null;
  const profile: StaffProfile = {
    ...fields,
    id,
    projectId,
    portrait,
    sessions,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await saveProfile(projectPath, profile);
  return profile;
}

const PORTRAIT_TYPES: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

async function savePortrait(projectPath: string, id: string, dataUrl: string): Promise<string> {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new StaffError('retrato inválido: use PNG, JPEG ou WebP');
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > 2 * 1024 * 1024) throw new StaffError('retrato grande demais (máx. 2 MB)');
  const name = `${id}.${PORTRAIT_TYPES[m[1]!]}`;
  await fs.mkdir(staffDir(projectPath), { recursive: true });
  await ensureMycoGitignore(projectPath);
  await fs.writeFile(path.join(staffDir(projectPath), name), bytes);
  return name;
}

export async function readPortrait(projectPath: string, p: StaffProfile): Promise<{ bytes: Buffer; type: string } | null> {
  if (!p.portrait || !/^[a-z0-9-]+\.(png|jpg|webp)$/.test(p.portrait)) return null;
  const bytes = await fs.readFile(path.join(staffDir(projectPath), p.portrait)).catch(() => null);
  if (!bytes) return null;
  const ext = p.portrait.split('.').pop()!;
  return { bytes, type: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` };
}

export async function replacePortrait(projectPath: string, p: StaffProfile, dataUrl: string): Promise<string> {
  await removePortrait(projectPath, p);
  return savePortrait(projectPath, p.id, dataUrl);
}

export async function removePortrait(projectPath: string, p: StaffProfile): Promise<null> {
  if (p.portrait && /^[a-z0-9-]+\.(png|jpg|webp)$/.test(p.portrait)) {
    await fs.rm(path.join(staffDir(projectPath), p.portrait), { force: true });
  }
  return null;
}

// ---- histórico de versões: <id>.history/<data>.json ----

const historyDir = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.history`);
const SAFE_VERSION = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export async function archiveVersion(projectPath: string, p: StaffProfile): Promise<string> {
  const version = new Date().toISOString().replace(/[:.]/g, '-');
  await writeAtomic(path.join(historyDir(projectPath, p.id), `${version}.json`), JSON.stringify(p, null, 2) + '\n');
  return version;
}

export async function listVersions(projectPath: string, id: string) {
  if (!SAFE_ID.test(id)) return [];
  const entries = (await listDir(historyDir(projectPath, id))).filter((e) => e.isFile() && e.name.endsWith('.json'));
  const out: Array<{ version: string; name: string; role: string; updatedAt: string }> = [];
  for (const e of entries) {
    const version = e.name.slice(0, -5);
    const p = await readVersion(projectPath, id, version);
    if (p) out.push({ version, name: p.name, role: p.role, updatedAt: p.updatedAt });
  }
  return out.sort((a, b) => b.version.localeCompare(a.version));
}

export async function readVersion(projectPath: string, id: string, version: string): Promise<StaffProfile | null> {
  if (!SAFE_ID.test(id) || !SAFE_VERSION.test(version)) return null;
  const raw = await fs.readFile(path.join(historyDir(projectPath, id), `${version}.json`), 'utf8').catch(() => null);
  const parsed = raw === null ? null : ProfileSchema.safeParse(tryJson(raw));
  return parsed?.success ? (parsed.data as StaffProfile) : null;
}

/** Cria a memória com um cabeçalho, se ainda não existir; nunca sobrescreve. */
export async function ensureMemory(projectPath: string, p: StaffProfile): Promise<void> {
  const file = memoryFile(projectPath, p.id);
  const header = `# Memória de ${p.name} — ${p.role}\n\nNotas curtas que ${p.name} acumula entre sessões (decisões, convenções, pendências).\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, header, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** Erro mostrado ao usuário (400), não falha interna. */
export class StaffError extends Error {}
