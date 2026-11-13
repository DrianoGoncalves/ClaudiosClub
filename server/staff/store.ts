import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { StaffProfile } from '../../shared/model';
import { cronError } from '../../shared/cron';
import { PERSONALITIES } from '../../shared/personality';
import { listDir, tryJson } from '../adapters/claude/fsutil';
import { ensureMycoGitignore } from '../mycoGitignore';
import { codexProfileError } from '../chat/codexArgs';
import { slugify } from './ficha';

// Fichas ficam no próprio projeto: <projeto>/.myco/staff/<id>.json (+ .md gerado, memória e retrato).

export const AUTONOMY = ['plan', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'] as const;
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const PLAYBOOKS = ['plan-big-execute-small', 'scout-then-build', 'review-gate'] as const;
// Alias ou id de modelo: só caracteres seguros na linha de comando.
const ModelSchema = z.string().regex(/^[\w.[\]-]{1,60}$/, 'modelo inválido');
const EffortSchema = z.enum(EFFORT);
// `ultra` só existe no Codex (os modelos Sol aceitam; os Luna vão até max): onde vale, ver `codexProfileError`.
const CodexEffortSchema = z.enum([...EFFORT, 'ultra']);
// Motor secundário (fallback quando o principal bate o limite): só o dado por enquanto. Regras que cruzam com o principal: `fallbackError`.
const FallbackSchema = z.object({
  engine: z.enum(['claude', 'codex']),
  // Vai para a linha de comando do motor: a mesma regra do modelo principal.
  model: ModelSchema,
  // Esforço do Codex (inclui `ultra`); no Claude o `ultra` é recusado em `fallbackError`.
  effort: CodexEffortSchema.optional(),
});
const line = (max: number) => z.string().trim().max(max);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const list = (max: number) => z.array(line(500)).max(max).default([]);

/** O que o questionário (ou um funcionário com permissão) envia, antes das regras que cruzam campos (ver `StaffInputSchema`). */
const StaffInputObject = z.object({
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
  // Escrita por MCP (ver StaffProfile.mcpWrite): ausente = livre. O nome é o do MCP na ficha; nomes reservados de objeto são recusados.
  // Os nomes são checados na entrada crua: o zod 4 descarta `__proto__` ao montar o record e troca a mensagem do refine de chave.
  mcpWrite: z
    .any()
    .superRefine((v, ctx) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const keys = Object.keys(v);
      if (keys.some((k) => RESERVED_KEYS.has(k))) ctx.addIssue({ code: 'custom', message: 'nome de MCP reservado' });
      else if (keys.some((k) => k.length < 1 || k.length > 100)) ctx.addIssue({ code: 'custom', message: 'nome de MCP com tamanho inválido (1 a 100 letras)' });
    })
    .pipe(
      z
        .record(z.string(), z.enum(['ask', 'deny'], { error: 'escrita do MCP: ask ou deny' }))
        .refine((r) => Object.keys(r).length <= 100, 'MCPs demais na política de escrita'),
    )
    .optional(),
  knowledge: list(50),
  rules: list(50),
  doneWhen: line(2000).default(''),
  // Ausente = claude. Com codex, `model` e `effort` são os do Codex (ver shared/model.ts).
  engine: z.enum(['claude', 'codex']).optional(),
  model: ModelSchema.nullable().default(null),
  effort: CodexEffortSchema.nullable().default(null),
  // Estilo de comunicação: null = sem estilo; ausente = fica o que a ficha já tinha (PATCH sem o campo); valor desconhecido vira null.
  personality: z.enum(PERSONALITIES).nullable().optional().catch(null),
  // Ausente = sem secundário; `null` no PATCH tira (como o retrato). Regras cruzadas: `assertFallbackRules`.
  fallback: FallbackSchema.nullable().optional(),
  canHire: z.boolean().default(false),
  playbook: z.enum(PLAYBOOKS).nullable().default(null),
  worktree: z.boolean().default(false),
  servers: z.array(z.string().regex(/^[\w.-]{1,60}$/, 'servidor inválido')).max(30).default([]),
  // Conexões SSH de `servers` com escrita liberada (ver `sshWriteError`).
  sshWrite: z.array(z.string().regex(/^[\w.-]{1,60}$/, 'servidor inválido')).max(30).default([]),
  browser: z.boolean().default(true),
  portraitDataUrl: z.string().max(3_000_000, 'retrato grande demais (máx. 2 MB)').nullable().optional(),
  launch: z.boolean().optional(),
  /** Sessão aberta fora do Claudio’s Club que passa a ser deste funcionário (ganha ficha, nome e retrato). */
  adoptSessionId: z.string().uuid().optional(),
  /** Abrir mesmo com o consumo acima da linha de parada (confirmado no Claudio’s Club). */
  force: z.boolean().optional(),
  /** Cargo pronto (ou seu) de server/roles.ts: preenche a ficha; o que vier no pedido ganha. Não vai para o perfil. */
  roleId: z.string().regex(/^[a-z0-9-]{1,40}$/, 'cargo inválido').optional(),
});

/**
 * O questionário com as regras que cruzam campos: quem roda no Codex não tem servidores na ficha e só ele usa o esforço `ultra`
 * (ver `codexProfileError`). Quem edita sem mandar `engine` também passa por `assertProfileRules` (junta com a ficha que já existe).
 */
/** Escrita SSH liberada só para conexão que está nos servidores da ficha (`sshWrite` ⊆ `servers`). Null = ok. */
export function sshWriteError(p: { servers: readonly string[]; sshWrite?: readonly string[] }): string | null {
  const fora = (p.sshWrite ?? []).filter((n) => !p.servers.includes(n));
  return fora.length ? `escrita liberada para conexão que não está nos servidores da ficha: ${fora.join(', ')}` : null;
}

export const StaffInputSchema = StaffInputObject.superRefine((v, ctx) => {
  const sshErr = sshWriteError(v);
  const error = sshErr ?? codexProfileError(v);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error, path: [sshErr ? 'sshWrite' : v.engine === 'codex' && v.servers.length ? 'servers' : 'effort'] });
});
export type StaffInputParsed = z.infer<typeof StaffInputSchema>;

/**
 * Confere a ficha inteira, já com os campos que não vieram no pedido (o `engine` que ficou da ficha antiga). Lança `StaffError`.
 * `ftpServers`: as conexões FTP do projeto. Quem tem o projeto em mãos passa; sem ele, o FTP no Codex não é conferido aqui (ver StaffService).
 */
export function assertProfileRules(p: Pick<StaffProfile, 'engine' | 'servers' | 'effort' | 'sshWrite'>, ftpServers?: readonly string[]): void {
  const error = sshWriteError(p) ?? codexProfileError({ ...p, ftpServers });
  if (error) throw new StaffError(error);
}

/**
 * Motor secundário: o que cruza com o motor principal e com os servidores da ficha (null = ok, ou sem secundário).
 * Reusa `codexProfileError`: conexão FTP não vai ao Codex (SSH vai), e `ultra` só existe no Codex (também vale para o secundário).
 */
export function fallbackError(p: { engine?: StaffProfile['engine']; servers: readonly string[]; fallback?: StaffProfile['fallback'] | null; ftpServers?: readonly string[] }): string | null {
  const fb = p.fallback;
  if (!fb) return null;
  if (fb.engine === (p.engine ?? 'claude')) return 'o motor secundário tem que ser diferente do principal';
  if (codexProfileError({ engine: fb.engine, servers: p.servers, ftpServers: p.ftpServers })) return 'o motor secundário Codex não aceita conexões FTP na ficha: tire as conexões FTP ou use o Claude como secundário';
  return codexProfileError({ engine: fb.engine, servers: [], effort: fb.effort });
}

/**
 * Lança `StaffError` se o secundário não combina com a ficha (ver `fallbackError`). Fica fora de `assertProfileRules`:
 * abrir conversa não deve travar por um secundário que ainda ninguém usa.
 */
export function assertFallbackRules(p: Parameters<typeof fallbackError>[0]): void {
  const error = fallbackError(p);
  if (error) throw new StaffError(error);
}

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

const ProfileSchema = StaffInputObject.omit({ portraitDataUrl: true, launch: true, adoptSessionId: true, force: true, roleId: true }).extend({
  id: z.string(),
  projectId: z.string(),
  portrait: z.string().nullable(),
  // Política de escrita editada à mão e inválida: o campo some na leitura (a ficha segue) em vez de derrubar a ficha. A escrita continua exigindo o formato (StaffInputSchema).
  mcpWrite: StaffInputObject.shape.mcpWrite.catch(undefined),
  // Ligação entre cópias da mesma pessoa; valor inválido é ignorado (ficha sem vínculo).
  personId: z.string().regex(/^[A-Za-z0-9-]{1,60}$/).optional().catch(undefined),
  // Valor inválido no arquivo: volta ao padrão (claude) em vez de derrubar a ficha.
  engine: z.enum(['claude', 'codex']).optional().catch(undefined),
  routines: RoutinesSchema.optional().catch(undefined),
  hiredBy: z.string().nullable().optional().catch(undefined),
  temporary: z.boolean().optional().catch(undefined),
  ended: z.object({ at: z.string(), reason: z.string() }).nullable().optional().catch(undefined),
  // Último modelo/esforço escolhido no chat (fora do questionário); valor inválido é ignorado.
  lastModel: ModelSchema.optional().catch(undefined),
  lastEffort: CodexEffortSchema.optional().catch(undefined),
  // Secundário inválido no arquivo: some (a ficha segue sem ele) em vez de derrubar a ficha.
  fallback: FallbackSchema.optional().catch(undefined),
  sessions: z
    .array(
      z.object({
        id: z.string(),
        startedAt: z.string(),
        cwd: z.string().optional(),
        // O que se escolheu no chat nesta conversa; valor inválido é ignorado.
        model: ModelSchema.optional().catch(undefined),
        effort: CodexEffortSchema.optional().catch(undefined),
        // Conversa trocada para o secundário (ver server/directFallback.ts): motor, modelo e esforço. O boot confere com a ficha atual.
        fallback: FallbackSchema.optional().catch(undefined),
      }),
    )
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).transform((p) => {
  // `ultra` só existe no Codex: numa ficha que voltou ao Claude (ou editada à mão) o valor sai em vez de ir para o `claude --effort`.
  const ultra = (e: unknown) => e === 'ultra';
  if (p.engine === 'codex' || !(ultra(p.effort) || ultra(p.lastEffort) || p.sessions.some((s) => ultra(s.effort)))) return p;
  const { lastEffort, ...rest } = p;
  return {
    ...rest,
    effort: ultra(p.effort) ? null : p.effort,
    ...(lastEffort && !ultra(lastEffort) && { lastEffort }),
    sessions: p.sessions.map(({ effort, ...s }) => (effort && !ultra(effort) ? { ...s, effort } : s)),
  };
});

export const staffDir = (projectPath: string) => path.join(projectPath, '.myco', 'staff');
export const fichaFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.md`);
export const memoryFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.memory.md`);
/** Pasta irmã da memória: arquivos de detalhe do índice. Não é criada aqui (o funcionário cria quando precisar). */
export const memoryDir = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.memory`);
export const profileFile = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.json`);

const SAFE_ID = /^[a-z0-9-]{1,40}$/;

/** O id de uma ficha pelo arquivo (`<id>.json` em .myco/staff); null se o arquivo não é ficha. */
const fichaIdOf = (e: { name: string; isFile(): boolean }) => (e.isFile() && e.name.endsWith('.json') && SAFE_ID.test(e.name.slice(0, -5)) ? e.name.slice(0, -5) : null);

/** O projeto tem algum arquivo de ficha? Só olha a pasta: não lê nem valida o conteúdo (listProjectStaff faz isso). */
export async function hasStaffFiles(projectPath: string): Promise<boolean> {
  return (await listDir(staffDir(projectPath))).some((e) => fichaIdOf(e) !== null);
}

export async function listProjectStaff(projectPath: string, projectId: string): Promise<StaffProfile[]> {
  const entries = await listDir(staffDir(projectPath));
  const out: StaffProfile[] = [];
  for (const e of entries) {
    const id = fichaIdOf(e);
    if (!id) continue;
    const p = await readProfile(projectPath, id);
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

/** Quem está lendo-e-gravando a ficha (por arquivo) espera a vez: duas trocas seguidas não perdem uma à outra. */
const profileQueues = new Map<string, Promise<unknown>>();

export function withProfileLock<T>(projectPath: string, staffId: string, fn: () => Promise<T>): Promise<T> {
  const key = profileFile(projectPath, staffId);
  const run = (profileQueues.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  profileQueues.set(key, tail);
  void tail.then(() => {
    if (profileQueues.get(key) === tail) profileQueues.delete(key);
  });
  return run;
}

export async function saveProfile(projectPath: string, p: StaffProfile): Promise<void> {
  await writeAtomic(profileFile(projectPath, p.id), JSON.stringify(p, null, 2) + '\n');
}

/**
 * Guarda o modelo/esforço escolhido no seletor do chat: na conversa (`sessionId`) e como "último" do
 * funcionário. Lê a ficha fresca do disco e grava só o JSON: sem .md, sem `updatedAt`, sem aviso de
 * "ficha atualizada" (o aviso sai de StaffService.update/restore, não daqui). Valor inválido é ignorado.
 */
export async function saveChatChoice(
  projectPath: string,
  staffId: string,
  sessionId: string | null,
  choice: { model?: string; effort?: string },
): Promise<void> {
  const model = ModelSchema.safeParse(choice.model);
  const codexEffort = CodexEffortSchema.safeParse(choice.effort);
  if (!model.success && !codexEffort.success) return;
  await withProfileLock(projectPath, staffId, async () => {
    const p = await readProfile(projectPath, staffId);
    if (!p) return;
    // `ultra` só vale para quem roda no Codex; para os outros, a escolha de esforço inválida é ignorada como sempre.
    const effort = p.engine === 'codex' ? codexEffort : EffortSchema.safeParse(choice.effort);
    if (!model.success && !effort.success) return;
    const next: StaffProfile = {
      ...p,
      ...(model.success && { lastModel: model.data }),
      ...(effort.success && { lastEffort: effort.data }),
      sessions: p.sessions.map((x) =>
        x.id === sessionId ? { ...x, ...(model.success && { model: model.data }), ...(effort.success && { effort: effort.data }) } : x,
      ),
    };
    await saveProfile(projectPath, next);
  });
}

export async function createProfile(
  projectPath: string,
  projectId: string,
  input: StaffInputParsed,
  now = new Date(),
  sessions: StaffProfile['sessions'] = [],
): Promise<StaffProfile> {
  const id = `${slugify(input.name)}-${randomBytes(2).toString('hex')}`;
  const { portraitDataUrl, launch: _launch, adoptSessionId: _adopt, force: _force, roleId: _role, fallback, ...fields } = input;
  const portrait = portraitDataUrl ? await savePortrait(projectPath, id, portraitDataUrl) : null;
  const profile: StaffProfile = {
    ...fields,
    ...(fallback && { fallback }),
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

export const historyDir = (projectPath: string, id: string) => path.join(staffDir(projectPath), `${id}.history`);
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

// Fila por arquivo (no processo): gravações no mesmo caminho rodam uma de cada vez.
// A entrada sai do mapa quando a fila esvazia.
const writeQueues = new Map<string, Promise<void>>();
// No Windows o rename pode falhar um instante (antivírus/indexador segurando o destino).
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 6;
const RENAME_BASE_MS = 20; // esperas: ~20, 40, 80, 160, 320 ms (com jitter de 50–100%): < 650 ms no total

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await sleep(RENAME_BASE_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2));
    }
  }
}

async function writeOnce(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined); // não deixa o .tmp largado
    throw err;
  }
}

export async function writeAtomic(file: string, text: string): Promise<void> {
  const resolved = path.resolve(file);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const run = (writeQueues.get(key) ?? Promise.resolve()).then(() => writeOnce(file, text));
  // A cauda nunca rejeita: a falha de uma gravação não trava as seguintes.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeQueues.set(key, tail);
  void tail.then(() => {
    if (writeQueues.get(key) === tail) writeQueues.delete(key);
  });
  return run;
}

/** Erro mostrado ao usuário (400), não falha interna. */
export class StaffError extends Error {}
