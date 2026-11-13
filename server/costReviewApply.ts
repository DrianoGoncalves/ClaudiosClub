// Botão "Aplicar" da revisão de custo (POST …/staff/<id>/cost-review/apply). Só pelo Claudio’s Club: um agente não muda a própria ficha.
// O servidor recalcula a revisão e aplica só os ajustes dos ids pedidos que ainda disparam. Ficha: só model/effort (e regra por acréscimo).
// Tarefa: para o próprio funcionário, pelo mesmo serviço do POST …/tasks. Nada vindo do cliente vale além dos ids e do período.
import { z } from 'zod';
import type { CodexEffort, CostReviewApplied, CostReviewApplyResult, StaffProfile, Task } from '../shared/model';
import { COST_REVIEW_FINDING_IDS } from '../shared/model';
import { buildCostReview, COST_REVIEW_MAX_DAYS } from './costReview';
import { readProfile } from './staff/store';
import { readTasks } from './tasks';

/** Igual ao limite de regras da ficha (StaffInputObject, list(50)). */
const FICHA_RULES_MAX = 50;
const APPLY_MAX_IDS = 20;

export class CostReviewApplyError extends Error {}

const KNOWN_IDS: readonly string[] = COST_REVIEW_FINDING_IDS;

/** O corpo do pedido: os ids dos achados (só conhecidos, sem repetir, até 20) e o período da revisão. */
export const CostReviewApplyBody = z.object({
  ids: z
    .array(z.string().refine((id) => KNOWN_IDS.includes(id), 'achado desconhecido'))
    .min(1, 'escolha ao menos um achado')
    .max(APPLY_MAX_IDS, `no máximo ${APPLY_MAX_IDS} achados`)
    .refine((ids) => new Set(ids).size === ids.length, 'achado repetido'),
  days: z
    .number({ error: (iss) => (iss.input === undefined ? undefined : 'days deve ser um número') })
    .int('days deve ser um inteiro')
    .min(1, 'days deve ser de 1 a 3650')
    .max(COST_REVIEW_MAX_DAYS, 'days deve ser de 1 a 3650'),
});

export interface CostReviewApplyInput {
  /** Só o Claudio’s Club pode aplicar (o token da conversa não). */
  fromBrowser: boolean;
  body: unknown;
  projectPath: string;
  projectId: string;
  staffId: string;
  /** ~/.claude/projects: onde ficam os transcripts (mesmo da revisão). */
  transcriptsDir: string;
  now?: number;
  /** Grava a ficha pelo mesmo caminho da edição pela tela (StaffService.update), com a ficha inteira. */
  updateFicha: (body: Record<string, unknown>) => Promise<unknown>;
  /** Cria e começa a tarefa do funcionário (start: true, sem gestor pedindo). Null = projeto não encontrado. */
  createTask: (task: { staffId: string; title: string; description: string }) => Promise<Task | null>;
}

type FichaPart = { model?: string | null; effort?: CodexEffort | null };

/** A ficha no formato da edição (StaffInputSchema): tudo o que vem da ficha, sem mexer em nada. */
function fichaBody(p: StaffProfile): Record<string, unknown> {
  return {
    name: p.name,
    role: p.role,
    reportsTo: p.reportsTo,
    mission: p.mission,
    firstTask: p.firstTask,
    autonomy: p.autonomy,
    agents: p.agents,
    skills: p.skills,
    mcps: p.mcps,
    knowledge: p.knowledge,
    rules: p.rules,
    doneWhen: p.doneWhen,
    ...(p.engine ? { engine: p.engine } : {}),
    model: p.model,
    effort: p.effort,
    canHire: p.canHire,
    playbook: p.playbook,
    worktree: p.worktree,
    servers: p.servers,
    browser: p.browser,
  };
}

/**
 * Aplica os ajustes pedidos. Devolve null se o projeto ou a ficha não existem (a rota responde 404).
 * A ficha e as regras vão numa gravação só (uma versão no histórico); as tarefas depois.
 */
export async function runCostReviewApply(input: CostReviewApplyInput): Promise<CostReviewApplyResult | null> {
  if (!input.fromBrowser) throw new CostReviewApplyError('só pelo Claudio’s Club');
  const parsed = CostReviewApplyBody.safeParse(input.body);
  if (!parsed.success) throw new CostReviewApplyError(parsed.error.issues[0]?.message ?? 'pedido inválido');
  const { ids, days } = parsed.data;

  const { projectPath, projectId, staffId } = input;
  const review = await buildCostReview({ projectPath, projectId, staffId, days, transcriptsDir: input.transcriptsDir, now: input.now ?? Date.now() });
  if (!review) return null;
  const profile = await readProfile(projectPath, staffId);
  if (!profile) return null;

  const applied: CostReviewApplied[] = [];
  const skipped: CostReviewApplyResult['skipped'] = [];
  const next: { model: string | null; effort: CodexEffort | null; rules: string[] } = {
    model: profile.model,
    effort: profile.effort,
    rules: [...profile.rules],
  };
  let fichaChanged = false;
  let rulesChanged = false;
  const openTitles = new Set((await readTasks(projectPath)).filter((t) => t.staffId === staffId && t.status !== 'done').map((t) => t.title));
  const pendingTasks: Array<{ item: CostReviewApplied; title: string; description: string }> = [];

  for (const id of ids) {
    const finding = review.findings.find((f) => f.id === id);
    if (!finding) {
      skipped.push({ id, reason: 'não dispara mais' });
      continue;
    }
    const fix = finding.fix;
    if (!fix) {
      skipped.push({ id, reason: 'sem ajuste automático' });
      continue;
    }

    if (fix.kind === 'ficha') {
      const before: FichaPart = {};
      const after: FichaPart = {};
      if (fix.model !== undefined && fix.model !== profile.model) {
        before.model = profile.model;
        after.model = fix.model;
        next.model = fix.model;
      }
      if (fix.effort !== undefined && fix.effort !== profile.effort) {
        before.effort = profile.effort;
        after.effort = fix.effort;
        next.effort = fix.effort;
      }
      if (Object.keys(after).length === 0) {
        skipped.push({ id, reason: 'já aplicado' });
        continue;
      }
      applied.push({ id, kind: 'ficha', before, after });
      fichaChanged = true;
      continue;
    }

    if (fix.kind === 'rule') {
      if (next.rules.some((r) => r.trim() === fix.text)) {
        skipped.push({ id, reason: 'já aplicado' });
        continue;
      }
      if (next.rules.length >= FICHA_RULES_MAX) {
        skipped.push({ id, reason: 'limite de regras da ficha' });
        continue;
      }
      next.rules.push(fix.text);
      applied.push({ id, kind: 'rule' });
      rulesChanged = true;
      continue;
    }

    // Tarefa: não cria outra enquanto houver uma aberta com o mesmo título.
    if (openTitles.has(fix.title)) {
      skipped.push({ id, reason: 'já aplicado' });
      continue;
    }
    const item: CostReviewApplied = { id, kind: 'task' };
    applied.push(item);
    pendingTasks.push({ item, title: fix.title, description: fix.description });
  }

  if (fichaChanged || rulesChanged) {
    await input.updateFicha({ ...fichaBody(profile), model: next.model, effort: next.effort, rules: next.rules });
  }
  for (const t of pendingTasks) {
    const task = await input.createTask({ staffId, title: t.title, description: t.description });
    if (!task) throw new CostReviewApplyError('projeto não encontrado');
    t.item.taskId = task.id;
  }

  return { applied, skipped };
}
