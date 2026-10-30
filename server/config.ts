import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CONTEXT_SWITCHES, HEX_COLOR, PROJECT_COLORS, type AppConfig, type ProjectColor, type Workspace } from '../shared/model';
import { pathKey } from './adapters/claude/paths';

// Configuração do próprio Claudio’s Club, fora do ~/.claude: ~/.myco/config.json.

export const MYCO_HOME = process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco');
const CONFIG_FILE = path.join(MYCO_HOME, 'config.json');

const DEFAULTS: AppConfig = {
  companyName: 'Claudio’s Club',
  // Quem chega começa no simples; quem já tinha config (já usava) fica no avançado (ver readConfig).
  uiLevel: 'simple',
  archived: { projects: [], sessions: [] },
  // Para antes de esgotar: sobra margem para terminar o que está em andamento.
  usageStop: { fiveHour: 90, sevenDay: 95 },
  // O padrão do Claude Code: a mensagem entra no trabalho em andamento, sem interromper.
  sendWhileBusy: 'next',
  projectColors: {},
  projectNames: {},
  boardBackground: { light: null, dark: null },
  projectBudgets: {},
  // Segue numa conversa nova sozinho quando o assunto fecha e compensa (dá para voltar à anterior).
  contextSwitch: 'auto',
  // Desligado: gastar a sobra da cota é escolha de quem paga.
  optimizeQuota: false,
  // Escondida: o quadro começa só com os projetos; a sala de ~/.claude se liga no config.
  showUserScope: false,
  // Desligada: mandar o diff para outra empresa é escolha sua.
  codexReview: false,
  workspaces: [],
  projectWorkspaces: {},
};

const PRIORITY = z.enum(['now', 'next', 'later']);
const UI_LEVEL = z.enum(['simple', 'advanced']);
// Caneta ou #rrggbb; o hex vai para um estilo inline, então só passa o formato exato.
const COLOR = z.union([z.enum(PROJECT_COLORS), z.string().regex(HEX_COLOR).transform((s) => s.toLowerCase() as `#${string}`)]);
const HEX = z.string().regex(/^#[0-9a-f]{6}$/i, 'cor inválida (use #rrggbb)');
// Apelido do projeto: depois do trim, vazio apaga o apelido (volta ao nome da pasta).
const PROJECT_NAME = z
  .string()
  .trim()
  .max(60, 'máximo de 60 caracteres')
  .refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'nome com caractere de controle')
  .transform((s) => (s === '' ? null : s));

const percent = z.number().min(1).max(100).nullable();
const UsageStopFile = z.object({ fiveHour: percent.optional(), sevenDay: percent.optional() });

const ConfigFile = z
  .object({
    companyName: z.string().optional(),
    uiLevel: UI_LEVEL.optional().catch(undefined),
    archived: z
      .object({ projects: z.array(z.string()).optional(), sessions: z.array(z.string()).optional() })
      .optional(),
    usageStop: UsageStopFile.optional(),
    sendWhileBusy: PRIORITY.optional().catch(undefined),
    // Editado à mão, um valor estranho volta ao padrão sem derrubar o resto (ver readConfig).
    projectColors: z.record(z.string(), z.unknown()).optional().catch(undefined),
    projectNames: z.record(z.string(), z.unknown()).optional().catch(undefined),
    boardBackground: z
      .object({ light: HEX.nullable().optional().catch(undefined), dark: HEX.nullable().optional().catch(undefined) })
      .optional()
      .catch(undefined),
    projectBudgets: z.record(z.string(), z.unknown()).optional().catch(undefined),
    contextSwitch: z.enum(CONTEXT_SWITCHES).optional().catch(undefined),
    optimizeQuota: z.boolean().optional().catch(undefined),
    showUserScope: z.boolean().optional().catch(undefined),
    codexReview: z.boolean().optional().catch(undefined),
    workspaces: z.array(z.unknown()).optional().catch(undefined),
    projectWorkspaces: z.record(z.string(), z.unknown()).optional().catch(undefined),
  })
  .passthrough();

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WorkspaceFile = z.object({
  id: z.string().regex(WORKSPACE_ID),
  name: z.string().trim().min(1).max(40),
  background: z
    .object({ light: HEX.toLowerCase().nullable().catch(null).default(null), dark: HEX.toLowerCase().nullable().catch(null).default(null) })
    .catch({ light: null, dark: null })
    .default({ light: null, dark: null }),
});

export const WorkspaceInput = z.object({
  /** Ausente = workspace novo. */
  id: z.string().regex(WORKSPACE_ID).optional(),
  name: z.string().trim().min(1, 'dê um nome ao workspace').max(40, 'máximo de 40 caracteres'),
  /** Só o tema enviado muda; null volta ao fundo geral. */
  background: z.object({ light: HEX.toLowerCase().nullable().optional(), dark: HEX.toLowerCase().nullable().optional() }).optional(),
});

export class WorkspaceError extends Error {}

const BUDGET = z.number().int().min(1).max(100);

export const ConfigPatch = z.object({
  companyName: z.string().trim().min(1, 'nome vazio').max(40, 'máximo de 40 caracteres').optional(),
  uiLevel: UI_LEVEL.optional(),
  usageStop: z.object({ fiveHour: percent, sevenDay: percent }).optional(),
  sendWhileBusy: PRIORITY.optional(),
  contextSwitch: z.enum(CONTEXT_SWITCHES).optional(),
  optimizeQuota: z.boolean().optional(),
  showUserScope: z.boolean().optional(),
  codexReview: z.boolean().optional(),
  /** Por id de projeto: uma cor troca a da sala; null volta à padrão. Os outros projetos ficam como estão. */
  projectColors: z.record(z.string().min(1).max(200), COLOR.nullable()).optional(),
  /** Por id de projeto: só o apelido na tela (a pasta não muda); vazio ou null volta ao nome da pasta. */
  projectNames: z.record(z.string().min(1).max(200), PROJECT_NAME.nullable()).optional(),
  /** Só o tema enviado muda; null volta à cor padrão. */
  boardBackground: z
    .object({ light: HEX.toLowerCase().nullable().optional(), dark: HEX.toLowerCase().nullable().optional() })
    .optional(),
  /** Por id de projeto: % da cota de 7 dias (1–100); null tira o orçamento. Os outros ficam como estão. */
  projectBudgets: z.record(z.string().min(1).max(200), z.number().int('use um número inteiro').min(1).max(100).nullable()).optional(),
});

export const ArchiveRequest = z.object({
  kind: z.enum(['project', 'session']),
  id: z.string().min(1).max(200),
  archived: z.boolean(),
});

export async function readConfig(file = CONFIG_FILE): Promise<AppConfig> {
  const parsed = ConfigFile.safeParse(await readRaw(file));
  if (!parsed.success) return DEFAULTS;
  const d = parsed.data;
  return {
    // 'MyCo' era o nome padrão antes da troca de nome: quem não mudou passa a ver o novo.
    companyName: d.companyName && d.companyName !== 'MyCo' ? d.companyName : DEFAULTS.companyName,
    // Simples até você escolher o avançado, também para quem já tinha config de antes da opção.
    uiLevel: d.uiLevel ?? DEFAULTS.uiLevel,
    archived: { projects: d.archived?.projects ?? [], sessions: d.archived?.sessions ?? [] },
    usageStop: {
      fiveHour: d.usageStop?.fiveHour === undefined ? DEFAULTS.usageStop.fiveHour : d.usageStop.fiveHour,
      sevenDay: d.usageStop?.sevenDay === undefined ? DEFAULTS.usageStop.sevenDay : d.usageStop.sevenDay,
    },
    sendWhileBusy: d.sendWhileBusy ?? DEFAULTS.sendWhileBusy,
    projectColors: Object.fromEntries(
      Object.entries(d.projectColors ?? {}).filter((e): e is [string, ProjectColor] => COLOR.safeParse(e[1]).success),
    ),
    projectNames: Object.fromEntries(
      Object.entries(d.projectNames ?? {}).flatMap(([id, v]) => {
        const name = PROJECT_NAME.safeParse(v);
        return name.success && name.data ? [[id, name.data] as const] : [];
      }),
    ),
    boardBackground: { light: d.boardBackground?.light ?? null, dark: d.boardBackground?.dark ?? null },
    projectBudgets: Object.fromEntries(
      Object.entries(d.projectBudgets ?? {}).filter((e): e is [string, number] => BUDGET.safeParse(e[1]).success),
    ),
    contextSwitch: d.contextSwitch ?? DEFAULTS.contextSwitch,
    optimizeQuota: d.optimizeQuota ?? DEFAULTS.optimizeQuota,
    showUserScope: d.showUserScope ?? DEFAULTS.showUserScope,
    codexReview: d.codexReview ?? DEFAULTS.codexReview,
    ...readWorkspaces(d.workspaces, d.projectWorkspaces),
  };
}

/** Editado à mão, entrada estranha some; projeto de um workspace que não existe fica sem workspace. */
function readWorkspaces(rawList: unknown[] | undefined, rawMap: Record<string, unknown> | undefined) {
  const workspaces: Workspace[] = [];
  for (const w of rawList ?? []) {
    const parsed = WorkspaceFile.safeParse(w);
    if (parsed.success && !workspaces.some((x) => x.id === parsed.data.id)) workspaces.push(parsed.data);
  }
  const ids = new Set(workspaces.map((w) => w.id));
  const projectWorkspaces = Object.fromEntries(
    Object.entries(rawMap ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && ids.has(e[1])),
  );
  return { workspaces, projectWorkspaces };
}

/** O workspace de um projeto, ou null (sem workspace). */
export function workspaceOf(config: AppConfig, projectId: string): Workspace | null {
  const id = config.projectWorkspaces[projectId];
  return (id && config.workspaces.find((w) => w.id === id)) || null;
}

/** Pastas abertas pelo "Novo projeto": o Claude Code ainda não as conhece, então o Claudio’s Club lembra. */
export async function readExtraProjects(file = CONFIG_FILE): Promise<string[]> {
  const raw = await readRaw(file);
  const list = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).extraProjects : null;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : [];
}

export async function addExtraProject(dir: string, file = CONFIG_FILE): Promise<void> {
  await mutate(file, (raw) => {
    const list = Array.isArray(raw.extraProjects) ? raw.extraProjects.filter((p): p is string => typeof p === 'string') : [];
    return list.some((p) => pathKey(p) === pathKey(dir)) ? raw : { ...raw, extraProjects: [...list, path.resolve(dir)] };
  });
}

/** Os workspaces do arquivo já lido (dentro do `mutate`: duas mudanças juntas não se perdem). */
const workspacesIn = (raw: Record<string, unknown>) =>
  readWorkspaces(Array.isArray(raw.workspaces) ? raw.workspaces : undefined, raw.projectWorkspaces as Record<string, unknown> | undefined);

/** Cria (sem `id`) ou edita um workspace. O id sai do nome e não muda ao renomear. */
export async function saveWorkspace(body: unknown, file = CONFIG_FILE): Promise<AppConfig> {
  const parsed = WorkspaceInput.safeParse(body);
  if (!parsed.success) throw new WorkspaceError(parsed.error.issues[0]?.message ?? 'workspace inválido');
  const input = parsed.data;
  return mutate(file, (raw) => {
    const { workspaces } = workspacesIn(raw);
    if (input.id && !workspaces.some((w) => w.id === input.id)) throw new WorkspaceError('workspace não encontrado');
    if (workspaces.some((w) => w.id !== input.id && w.name.toLowerCase() === input.name.toLowerCase())) {
      throw new WorkspaceError(`já existe o workspace ${input.name}`);
    }
    const id = input.id ?? uniqueId(slug(input.name), new Set(workspaces.map((w) => w.id)));
    const prev = workspaces.find((w) => w.id === id);
    const bg = prev?.background ?? { light: null, dark: null };
    const workspace: Workspace = {
      id,
      name: input.name,
      background: {
        light: input.background?.light !== undefined ? input.background.light : bg.light,
        dark: input.background?.dark !== undefined ? input.background.dark : bg.dark,
      },
    };
    return { ...raw, workspaces: input.id ? workspaces.map((w) => (w.id === id ? workspace : w)) : [...workspaces, workspace] };
  });
}

/** Remove o workspace; os projetos dele ficam sem workspace (nada mais muda). */
export async function removeWorkspace(id: string, file = CONFIG_FILE): Promise<AppConfig> {
  return mutate(file, (raw) => {
    const { workspaces, projectWorkspaces } = workspacesIn(raw);
    if (!workspaces.some((w) => w.id === id)) throw new WorkspaceError('workspace não encontrado');
    return {
      ...raw,
      workspaces: workspaces.filter((w) => w.id !== id),
      projectWorkspaces: Object.fromEntries(Object.entries(projectWorkspaces).filter(([, w]) => w !== id)),
    };
  });
}

/** Põe o projeto num workspace; null tira (sem workspace). */
export async function setProjectWorkspace(projectId: string, workspaceId: string | null, file = CONFIG_FILE): Promise<AppConfig> {
  return mutate(file, (raw) => {
    const { workspaces, projectWorkspaces } = workspacesIn(raw);
    if (workspaceId !== null && !workspaces.some((w) => w.id === workspaceId)) throw new WorkspaceError('workspace não encontrado');
    const next = { ...projectWorkspaces };
    if (workspaceId === null) delete next[projectId];
    else next[projectId] = workspaceId;
    return { ...raw, projectWorkspaces: next };
  });
}

/** `Acme Labs` → `acme-labs`. */
function slug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'workspace'
  );
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

export async function updateConfig(patch: z.infer<typeof ConfigPatch>, file = CONFIG_FILE): Promise<AppConfig> {
  const { projectColors, projectNames, boardBackground, projectBudgets, ...rest } = patch;
  return mutate(file, (current) => {
    const next: Record<string, unknown> = { ...current, ...stripUndefined(rest) };
    // Cores, nomes, fundo e orçamentos mudam por partes: o que não veio no pedido fica como está.
    if (projectColors) next.projectColors = mergePartial(current.projectColors, projectColors);
    if (projectNames) next.projectNames = mergePartial(current.projectNames, projectNames);
    if (boardBackground) next.boardBackground = mergePartial(current.boardBackground, boardBackground);
    if (projectBudgets) next.projectBudgets = mergePartial(current.projectBudgets, projectBudgets);
    return next;
  });
}

/** Junta `patch` ao objeto gravado: null apaga a chave (volta ao padrão); undefined não mexe. */
function mergePartial(current: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const out = current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Arquiva ou desarquiva um projeto ou funcionário (só esconde do quadro). */
export async function setArchived(req: z.infer<typeof ArchiveRequest>, file = CONFIG_FILE): Promise<AppConfig> {
  return mutate(file, (current) => {
    const parsed = ConfigFile.safeParse(current);
    const archived = parsed.success ? (parsed.data.archived ?? {}) : {};
    const key = req.kind === 'project' ? 'projects' : 'sessions';
    const list = new Set(archived[key] ?? []);
    if (req.archived) list.add(req.id);
    else list.delete(req.id);
    return { ...current, archived: { ...archived, [key]: [...list] } };
  });
}

/** Lê, transforma e grava de forma atômica (arquivo temporário + rename), preservando chaves desconhecidas. */
async function mutate(
  file: string,
  fn: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<AppConfig> {
  const raw = await readRaw(file);
  const current = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const next = fn(current);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  return readConfig(file);
}

async function readRaw(file: string): Promise<unknown> {
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return {};
  try {
    // Editado à mão no Windows, o arquivo pode vir com BOM.
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    return {}; // corrompido: recomeça
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
