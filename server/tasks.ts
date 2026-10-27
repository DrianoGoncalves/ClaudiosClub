import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TASK_STATUSES, type StaffProfile, type Task, type TaskCode, type TaskStatus, type TaskSummary } from '../shared/model';
import { writeAtomic } from './staff/store';
import { CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';

// Tarefas por projeto: `<projeto>/.myco/tasks.json`, ao lado das fichas. Cada tarefa vai para um
// funcionário; ao começar, abre uma conversa nova com a descrição. Ela anda sozinha:
//   planejando → fazendo  quando você aprova o plano no cartão de plano (o plano fica guardado);
//   fazendo → revisão     quando o turno dele termina (trabalhando → parado);
//   revisão → fazendo     quando você manda outra mensagem na conversa da tarefa.
// "Pronto" e "no ar" são suas (o deploy, por enquanto, é marcado à mão).

export class TaskError extends Error {}

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
const MAX_HISTORY = 30;

export const TaskInput = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120, 'título longo demais (máx. 120)'),
  description: z.string().trim().max(8000).default(''),
  staffId: z.string().regex(SAFE_ID).nullable().default(null),
});

export const TaskPatch = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120).optional(),
  description: z.string().trim().max(8000).optional(),
  staffId: z.string().regex(SAFE_ID).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  pr: z
    .string()
    .trim()
    .max(500)
    .regex(/^(https?:\/\/\S+)?$/, 'o PR precisa ser um link (https://…)')
    .transform((v) => v || null)
    .nullable()
    .optional(),
  branch: z.string().trim().max(200).transform((v) => v || null).nullable().optional(),
});

export interface TaskServiceDeps {
  /** Pasta do projeto (null: projeto não encontrado). */
  projectPath: (projectId: string) => Promise<string | null>;
  /** Projetos onde procurar tarefas quando chega um aviso de uma conversa (aprovou, terminou…). */
  projectIds: () => Promise<string[]>;
  readProfile: (projectId: string, staffId: string) => Promise<StaffProfile | null>;
  /** Abre uma conversa nova com o funcionário e manda a mensagem; devolve a sessão. */
  send: (projectId: string, staffId: string, text: string, force: boolean) => Promise<string>;
  /** Branch em que ele vai trabalhar (a da worktree dele, ou a atual do projeto). */
  branchFor: (projectPath: string, profile: StaffProfile) => Promise<string | null>;
}

type Role = 'work' | 'review' | 'deploy';

export class TaskService {
  /** sessionId → onde está a tarefa daquela conversa (e se é o trabalho, a revisão ou o deploy). */
  private readonly bySession = new Map<string, { projectId: string; taskId: string; role: Role }>();
  private indexed = false;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TaskServiceDeps) {}

  async list(projectId: string): Promise<Task[] | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return null;
    const tasks = await readTasks(dir);
    for (const t of tasks) {
      if (t.sessionId) this.bySession.set(t.sessionId, { projectId, taskId: t.id, role: 'work' });
      if (t.review?.sessionId) this.bySession.set(t.review.sessionId, { projectId, taskId: t.id, role: 'review' });
      if (t.deploy?.sessionId) this.bySession.set(t.deploy.sessionId, { projectId, taskId: t.id, role: 'deploy' });
    }
    return tasks;
  }

  async create(projectId: string, body: unknown): Promise<Task | null> {
    const input = parseOr(TaskInput, body);
    if (input.staffId) await this.staffOrThrow(projectId, input.staffId);
    const now = new Date().toISOString();
    const task: Task = {
      id: `t-${randomBytes(3).toString('hex')}`,
      title: input.title,
      description: input.description,
      status: 'todo',
      staffId: input.staffId,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: 'todo', by: 'you' }],
    };
    return (await this.mutate(projectId, (tasks) => [...tasks, task])) ? task : null;
  }

  async update(projectId: string, taskId: string, body: unknown): Promise<Task | null> {
    const patch = parseOr(TaskPatch, body);
    if (patch.staffId) await this.staffOrThrow(projectId, patch.staffId);
    return this.change(projectId, taskId, (t) => withPatch(t, patch, 'you'));
  }

  async remove(projectId: string, taskId: string): Promise<boolean> {
    let found = false;
    const ok = await this.mutate(projectId, (tasks) => {
      found = tasks.some((t) => t.id === taskId);
      return tasks.filter((t) => t.id !== taskId);
    });
    return !!ok && found;
  }

  /**
   * Começa: conversa nova com o funcionário, com o título e a descrição. Com a ficha em "só
   * planeja", a tarefa vai para "planejando"; senão, para "fazendo".
   */
  async start(projectId: string, taskId: string, force = false): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!dir || !task) return null;
    if (!task.staffId) throw new TaskError('escolha quem vai cuidar da tarefa');
    if (task.sessionId) throw new TaskError('a tarefa já começou: continue pela conversa dela');
    const profile = await this.staffOrThrow(projectId, task.staffId);
    const text = [`[Tarefa "${task.title}"]`, task.description, 'Quando terminar, responda com um resumo curto do que foi feito e do que falta.']
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, profile.id, text, force);
    const branch = await this.deps.branchFor(dir, profile).catch(() => null);
    this.bySession.set(sessionId, { projectId, taskId, role: 'work' });
    const next: TaskStatus = profile.autonomy === 'plan' ? 'planning' : 'doing';
    return this.change(projectId, taskId, (t) => moved({ ...t, sessionId, branch: branch ?? t.branch }, next, 'auto', `com ${profile.name}`));
  }

  /** O código da tarefa: onde está, o que mudou e se dá para mesclar. */
  async code(projectId: string, taskId: string): Promise<TaskCode | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    return readCode(dir, place);
  }

  /** Roda os testes onde está o código da tarefa e guarda o resultado no cartão. */
  async test(projectId: string, taskId: string): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    const command = await detectTest(dir);
    if (!command) throw new TaskError('não achei testes neste projeto (npm test, composer test ou phpunit)');
    const tests = await runTests(place.path, command);
    return this.change(projectId, taskId, (t) => ({ ...t, tests, updatedAt: new Date().toISOString() }));
  }

  /** Mescla a worktree no projeto (testes verdes, ou sem testes confirmado). A tarefa vai para "pronto". */
  async merge(projectId: string, taskId: string, skipTests = false): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    try {
      const m = await mergeCode(dir, place, task.title, { skipTests });
      return this.change(projectId, taskId, (t) =>
        moved({ ...t, tests: m.tests ?? t.tests ?? null, merged: { at: new Date().toISOString(), sha: m.sha, branch: m.branch, base: m.base } }, 'done', 'auto', `mesclado em ${m.base} (${m.sha})`),
      );
    } catch (err) {
      if (err instanceof CodeError && err.tests) await this.change(projectId, taskId, (t) => ({ ...t, tests: err.tests }));
      throw err;
    }
  }

  /** Pede a outro funcionário que revise o código da tarefa (numa conversa nova dele). */
  async requestReview(projectId: string, taskId: string, reviewerId: string, force = false): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    if (reviewerId === task.staffId) throw new TaskError('a revisão precisa ser de outro funcionário');
    const reviewer = await this.staffOrThrow(projectId, reviewerId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    const code = place ? await readCode(dir, place).catch(() => null) : null;
    const where = !code
      ? 'O projeto não é um repositório git: leia os arquivos citados na conversa da tarefa.'
      : code.where === 'worktree'
        ? `O código está na worktree \`${code.path}\` (branch \`${code.branch}\`), saindo de \`${code.base}\`. Veja com \`git -C "${code.path}" diff ${code.base}...HEAD\` e \`git -C "${code.path}" status\` (o que ainda não foi commitado).`
        : `As mudanças estão no próprio projeto, sem commit: veja com \`git diff HEAD\`.`;
    const files = code?.files.length ? `Arquivos: ${code.files.slice(0, 30).map((f) => `${f.path} (+${f.add} -${f.del})`).join(', ')}${code.files.length > 30 ? '…' : ''}` : '';
    const text = [
      `[Revisão da tarefa "${task.title}"]`,
      `${profile?.name ?? 'Um colega'} terminou a tarefa e ela precisa de revisão.`,
      task.description && `O que foi pedido:\n${task.description}`,
      where,
      files,
      'Responda com APROVADO, ou com a lista de ajustes (arquivo:linha e o porquê). Não mude o código: só revise.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, reviewer.id, text, force);
    this.bySession.set(sessionId, { projectId, taskId, role: 'review' });
    return this.change(projectId, taskId, (t) =>
      moved({ ...t, review: { staffId: reviewer.id, sessionId, at: new Date().toISOString() } }, 'review', 'auto', `revisão pedida a ${reviewer.name}`),
    );
  }

  /** Pede o deploy ao funcionário de infra, com o checklist (backup, estado antes e depois, runbook). */
  async requestDeploy(projectId: string, taskId: string, infraId: string, force = false): Promise<Task | null> {
    const { task } = await this.context(projectId, taskId);
    const infra = await this.staffOrThrow(projectId, infraId);
    if (!infra.servers.length) throw new TaskError(`${infra.name} não tem acesso a servidores na ficha`);
    const what = task.merged ? `o que foi mesclado em \`${task.merged.base}\` (commit ${task.merged.sha})` : `a entrega da tarefa${task.branch ? ` (branch \`${task.branch}\`)` : ''}`;
    const text = [
      `[Deploy da tarefa "${task.title}"]`,
      `Faça o deploy de ${what}.`,
      task.description && `O que a tarefa entrega:\n${task.description}`,
      'Checklist:\n1. Antes: confira o estado do servidor (serviços, espaço, versão no ar).\n2. Faça backup do que vai mudar.\n3. Publique.\n4. Depois: confira de novo e teste o que a tarefa entrega.\n5. Registre no runbook o que mudou e como desfazer.',
      'Peça minha confirmação antes de qualquer passo irreversível em produção. No fim, responda com o resumo e se ficou no ar.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, infra.id, text, force);
    this.bySession.set(sessionId, { projectId, taskId, role: 'deploy' });
    return this.change(projectId, taskId, (t) => {
      const at = new Date().toISOString();
      const history = [...t.history, { at, status: t.status, by: 'auto' as const, note: `deploy pedido a ${infra.name}` }].slice(-MAX_HISTORY);
      return { ...t, deploy: { staffId: infra.id, sessionId, at }, history, updatedAt: at };
    });
  }

  /** Aprovou o plano da conversa: planejando → fazendo, com o plano guardado. */
  async onPlanApproved(sessionId: string, plan: string): Promise<void> {
    await this.onSession(sessionId, 'work', (t) => (t.status === 'planning' || t.status === 'todo' ? moved({ ...t, plan }, 'doing', 'auto', 'plano aprovado') : { ...t, plan }));
  }

  /** Mandou mensagem na conversa da tarefa: em revisão, ela volta para "fazendo". */
  async onSent(sessionId: string): Promise<void> {
    await this.onSession(sessionId, 'work', (t) => (t.status === 'review' ? moved(t, 'doing', 'auto', 'você respondeu') : null));
  }

  /**
   * O turno de uma conversa da tarefa terminou. Do trabalho: fazendo → revisão. Da revisão ou do
   * deploy: anota que a resposta chegou (a tarefa não muda de coluna sozinha por isso).
   */
  async onTurnDone(sessionId: string): Promise<void> {
    await this.onSession(sessionId, 'work', (t) => (t.status === 'doing' ? moved(t, 'review', 'auto', 'turno terminou') : null));
    await this.onSession(sessionId, 'review', (t) => noteHandoff(t, 'review', 'revisão respondida'));
    await this.onSession(sessionId, 'deploy', (t) => noteHandoff(t, 'deploy', 'deploy respondeu'));
  }

  /**
   * Por projeto: tarefas em aberto (fora "pronto" e "no ar"), quantas esperam revisão e o último
   * deploy (a tarefa que foi para "no ar" mais recentemente). Projetos sem nada ficam de fora.
   */
  async summary(): Promise<Record<string, TaskSummary>> {
    const out: Record<string, TaskSummary> = {};
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'live').length;
      const live = tasks
        .filter((t) => t.status === 'live')
        .map((t) => ({ title: t.title, at: [...t.history].reverse().find((h) => h.status === 'live')?.at ?? t.updatedAt, by: t.deploy?.staffId ?? null }))
        .sort((a, b) => b.at.localeCompare(a.at))[0];
      if (open || live) out[projectId] = { open, review: tasks.filter((t) => t.status === 'review').length, lastDeploy: live ?? null };
    }
    this.indexed = true;
    return out;
  }

  private async context(projectId: string, taskId: string) {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!dir || !task) throw new TaskError('tarefa não encontrada');
    const profile = task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    return { dir, task, profile };
  }

  private async onSession(sessionId: string, role: Role, fn: (t: Task) => Task | null): Promise<void> {
    let where = this.bySession.get(sessionId);
    if (!where && !this.indexed) {
      await this.summary(); // primeira vez depois de subir: monta o índice sessão → tarefa
      where = this.bySession.get(sessionId);
    }
    if (where && where.role === role) await this.change(where.projectId, where.taskId, (t) => fn(t) ?? t);
  }

  private async change(projectId: string, taskId: string, fn: (t: Task) => Task): Promise<Task | null> {
    let out: Task | null = null;
    const ok = await this.mutate(projectId, (tasks) =>
      tasks.map((t) => {
        if (t.id !== taskId) return t;
        out = fn(t);
        return out;
      }),
    );
    return ok ? out : null;
  }

  /** Lê, muda e grava o arquivo do projeto, um pedido por vez (duas mudanças juntas não se perdem). */
  private async mutate(projectId: string, fn: (tasks: Task[]) => Task[]): Promise<boolean> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir) return false;
    const file = tasksFile(dir);
    const prev = this.queues.get(file) ?? Promise.resolve();
    const run = prev.then(async () => {
      const next = fn(await readTasks(dir));
      await writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
    });
    this.queues.set(file, run.catch(() => {}));
    await run;
    return true;
  }

  private async staffOrThrow(projectId: string, staffId: string): Promise<StaffProfile> {
    const p = await this.deps.readProfile(projectId, staffId);
    if (!p) throw new TaskError('funcionário não encontrado neste projeto');
    return p;
  }
}

const tasksFile = (dir: string) => path.join(dir, '.myco', 'tasks.json');

async function readTasks(dir: string): Promise<Task[]> {
  const raw = await fs.readFile(tasksFile(dir), 'utf8').catch(() => null);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw.replace(/^﻿/, '')) as unknown;
    return Array.isArray(data) ? (data as Task[]).filter((t) => t && typeof t.id === 'string' && TASK_STATUSES.includes(t.status)) : [];
  } catch {
    return [];
  }
}

/** A revisão ou o deploy respondeu: marca a hora e deixa uma linha no histórico (sem mudar de coluna). */
function noteHandoff(t: Task, kind: 'review' | 'deploy', note: string): Task | null {
  const h = t[kind];
  if (!h) return null;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY);
  return { ...t, [kind]: { ...h, doneAt: at }, history, updatedAt: at };
}

function moved(t: Task, status: TaskStatus, by: 'you' | 'auto', note?: string): Task {
  if (t.status === status) return t;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status, by, ...(note && { note }) }].slice(-MAX_HISTORY);
  return { ...t, status, updatedAt: at, history };
}

function withPatch(t: Task, p: z.infer<typeof TaskPatch>, by: 'you' | 'auto'): Task {
  const { status, ...fields } = p;
  const next: Task = { ...t, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), updatedAt: new Date().toISOString() };
  return status ? moved(next, status, by) : next;
}

function parseOr<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new TaskError(r.error.issues[0]?.message ?? 'tarefa inválida');
  return r.data;
}
