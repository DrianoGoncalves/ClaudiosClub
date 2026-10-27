import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { PROJECT_COLORS, type AppConfig, type ProjectColor } from '../shared/model';

// Configuração do próprio MyCo, fora do ~/.claude: ~/.myco/config.json.

export const MYCO_HOME = process.env.MYCO_HOME ?? path.join(os.homedir(), '.myco');
const CONFIG_FILE = path.join(MYCO_HOME, 'config.json');

const DEFAULTS: AppConfig = {
  companyName: 'MyCo',
  archived: { projects: [], sessions: [] },
  // Para antes de esgotar: sobra margem para terminar o que está em andamento.
  usageStop: { fiveHour: 90, sevenDay: 95 },
  // O padrão do Claude Code: a mensagem entra no trabalho em andamento, sem interromper.
  sendWhileBusy: 'next',
  projectColors: {},
  boardBackground: { light: null, dark: null },
  projectBudgets: {},
};

const PRIORITY = z.enum(['now', 'next', 'later']);
const COLOR = z.enum(PROJECT_COLORS);
const HEX = z.string().regex(/^#[0-9a-f]{6}$/i, 'cor inválida (use #rrggbb)');

const percent = z.number().min(1).max(100).nullable();
const UsageStopFile = z.object({ fiveHour: percent.optional(), sevenDay: percent.optional() });

const ConfigFile = z
  .object({
    companyName: z.string().optional(),
    archived: z
      .object({ projects: z.array(z.string()).optional(), sessions: z.array(z.string()).optional() })
      .optional(),
    usageStop: UsageStopFile.optional(),
    sendWhileBusy: PRIORITY.optional().catch(undefined),
    // Editado à mão, um valor estranho volta ao padrão sem derrubar o resto (ver readConfig).
    projectColors: z.record(z.string(), z.unknown()).optional().catch(undefined),
    boardBackground: z
      .object({ light: HEX.nullable().optional().catch(undefined), dark: HEX.nullable().optional().catch(undefined) })
      .optional()
      .catch(undefined),
    projectBudgets: z.record(z.string(), z.unknown()).optional().catch(undefined),
  })
  .passthrough();

const BUDGET = z.number().int().min(1).max(100);

export const ConfigPatch = z.object({
  companyName: z.string().trim().min(1, 'nome vazio').max(40, 'máximo de 40 caracteres').optional(),
  usageStop: z.object({ fiveHour: percent, sevenDay: percent }).optional(),
  sendWhileBusy: PRIORITY.optional(),
  /** Por id de projeto: uma cor troca a da sala; null volta à padrão. Os outros projetos ficam como estão. */
  projectColors: z.record(z.string().min(1).max(200), COLOR.nullable()).optional(),
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
    companyName: d.companyName ?? DEFAULTS.companyName,
    archived: { projects: d.archived?.projects ?? [], sessions: d.archived?.sessions ?? [] },
    usageStop: {
      fiveHour: d.usageStop?.fiveHour === undefined ? DEFAULTS.usageStop.fiveHour : d.usageStop.fiveHour,
      sevenDay: d.usageStop?.sevenDay === undefined ? DEFAULTS.usageStop.sevenDay : d.usageStop.sevenDay,
    },
    sendWhileBusy: d.sendWhileBusy ?? DEFAULTS.sendWhileBusy,
    projectColors: Object.fromEntries(
      Object.entries(d.projectColors ?? {}).filter((e): e is [string, ProjectColor] => COLOR.safeParse(e[1]).success),
    ),
    boardBackground: { light: d.boardBackground?.light ?? null, dark: d.boardBackground?.dark ?? null },
    projectBudgets: Object.fromEntries(
      Object.entries(d.projectBudgets ?? {}).filter((e): e is [string, number] => BUDGET.safeParse(e[1]).success),
    ),
  };
}

export async function updateConfig(patch: z.infer<typeof ConfigPatch>, file = CONFIG_FILE): Promise<AppConfig> {
  const { projectColors, boardBackground, projectBudgets, ...rest } = patch;
  return mutate(file, (current) => {
    const next: Record<string, unknown> = { ...current, ...stripUndefined(rest) };
    // Cores, fundo e orçamentos mudam por partes: o que não veio no pedido fica como está.
    if (projectColors) next.projectColors = mergePartial(current.projectColors, projectColors);
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
