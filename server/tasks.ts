import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { TASK_STATUSES, type ChatItem, type HeldMessage, type StaffProfile, type Task, type TaskCode, type TaskHandoff, type TaskStatus, type TaskSummary, type TestRun } from '../shared/model';
import type { SecondOpinionInput } from './adapters/codex';
import { writeAtomic } from './staff/store';
import { checkpoint, CodeError, detectTest, locateCode, mergeCode, readCode, runTests } from './taskCode';

// Tarefas por projeto: `<projeto>/.myco/tasks.json`, ao lado das fichas. Cada tarefa vai para um
// funcionário; ao começar, abre uma conversa nova com a descrição. Ela anda sozinha:
//   planejando → fazendo  quando você aprova o plano no cartão de plano (o plano fica guardado);
//   fazendo → revisão     quando o turno dele termina (trabalhando → parado);
//   revisão → fazendo     quando você manda outra mensagem na conversa da tarefa;
//   revisão automática    com revisor marcado, ao entregar ele revisa sozinho (até 3 rodadas) e responde
//                         APROVADO ou REPROVADO na primeira linha. Aprovada: pronto (fica em revisão se
//                         falta mesclar a worktree). Reprovada: os ajustes vão para a conversa dele, e a
//                         tarefa volta para fazendo.
// "No ar" é sua (o deploy, por enquanto, é marcado à mão); "pronto" também sai sozinho na aprovação.
//
// Uma tarefa por vez por funcionário. Começar com ele ocupado (outra tarefa planejando ou fazendo,
// ou uma conversa dele trabalhando) põe na fila dele; quando ele fica livre, o Claudio’s Club manda primeiro
// os ajustes que você deixou em tarefas anteriores (guardados enquanto ele estava ocupado) e
// depois a próxima da fila, na ordem do quadro.

export class TaskError extends Error {}

const SAFE_ID = /^[a-z0-9-]{1,40}$/;
const MAX_HISTORY = 30;
/** Quantas revisões automáticas uma tarefa pede antes de ficar com você. */
const AUTO_REVIEW_ROUNDS = 3;

export const TaskInput = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120, 'título longo demais (máx. 120)'),
  description: z.string().trim().max(8000).default(''),
  staffId: z.string().regex(SAFE_ID).nullable().default(null),
  reviewerId: z.string().regex(SAFE_ID).nullable().default(null),
});

export const TaskPatch = z.object({
  title: z.string().trim().min(1, 'dê um título à tarefa').max(120).optional(),
  description: z.string().trim().max(8000).optional(),
  staffId: z.string().regex(SAFE_ID).nullable().optional(),
  reviewerId: z.string().regex(SAFE_ID).nullable().optional(),
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
  /** Tirar da fila (pôr é pelo "Começar"). */
  queued: z.literal(false).optional(),
});

export interface TaskServiceDeps {
  /** Pasta do projeto (null: projeto não encontrado). */
  projectPath: (projectId: string) => Promise<string | null>;
  /** Projetos onde procurar tarefas quando chega um aviso de uma conversa (aprovou, terminou…). */
  projectIds: () => Promise<string[]>;
  readProfile: (projectId: string, staffId: string) => Promise<StaffProfile | null>;
  /** Abre uma conversa nova com o funcionário e manda a mensagem; devolve a sessão. */
  send: (projectId: string, staffId: string, text: string, force: boolean) => Promise<string>;
  /** Avisa um funcionário (o gestor que pediu a tarefa): na conversa `sessionId`, ou na mais recente dele. */
  notify?: (projectId: string, staffId: string, text: string, sessionId?: string | null) => Promise<void>;
  /** A conversa do funcionário que está no meio de um turno agora (quem chamou a API), se for uma só. */
  requesterSession?: (staffId: string) => string | null;
  /** Roda os testes do projeto (os testes trocam); o comando vem de detectTest, nunca do pedido. */
  runTests?: (cwd: string, command: string) => Promise<TestRun>;
  /** A última resposta de uma conversa (o resumo da entrega). */
  lastText?: (sessionId: string) => string | null;
  /** Branch em que ele vai trabalhar (a da worktree dele, ou a atual do projeto). */
  branchFor: (projectPath: string, profile: StaffProfile) => Promise<string | null>;
  /** Alguma conversa dele no Claudio’s Club está trabalhando (turno ou segundo plano), fora `exceptSession`. */
  isWorking?: (staffId: string, exceptSession?: string) => boolean;
  /** Manda na conversa que já existe (os ajustes guardados). */
  sendTo?: (projectId: string, sessionId: string, staffId: string, text: string, images: string[]) => Promise<string>;
  /** Segunda opinião de outro modelo sobre o diff (o Codex, ver adapters/codex.ts); sem ele, indisponível. */
  secondOpinion?: (input: SecondOpinionInput) => Promise<string>;
}

type Role = 'work' | 'review' | 'deploy';

const OCCUPIED: TaskStatus[] = ['planning', 'doing'];

export class TaskService {
  /** sessionId → onde está a tarefa daquela conversa (e se é o trabalho, a revisão ou o deploy). */
  private readonly bySession = new Map<string, { projectId: string; taskId: string; role: Role }>();
  private indexed = false;
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Uma "vez de quem é" por funcionário: dois avisos juntos não começam duas tarefas. */
  private readonly kicks = new Map<string, Promise<void>>();

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

  /** `requestedBy`: o gestor (funcionário) que pediu, pela API; recebe o resumo na entrega. */
  async create(projectId: string, body: unknown, requestedBy: string | null = null): Promise<Task | null> {
    const input = parseOr(TaskInput, body);
    if (input.staffId) await this.staffOrThrow(projectId, input.staffId);
    await this.checkReviewer(projectId, input.reviewerId, input.staffId, true);
    const manager = requestedBy ? await this.staffOrThrow(projectId, requestedBy) : null;
    const now = new Date().toISOString();
    // A entrega volta para a conversa em que o gestor pediu (a que está no turno agora, chamando a
    // API), e não para a mais recente dele, que pode ser outro assunto.
    const task: Task = {
      ...(manager && { requestedBy: manager.id, requestedSession: this.deps.requesterSession?.(manager.id) ?? null }),
      id: `t-${randomBytes(3).toString('hex')}`,
      title: input.title,
      description: input.description,
      status: 'todo',
      staffId: input.staffId,
      reviewerId: input.reviewerId,
      sessionId: null,
      plan: null,
      branch: null,
      pr: null,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: 'todo', by: manager ? 'auto' : 'you', ...(manager && { note: `pedida por ${manager.name}` }) }],
    };
    return (await this.mutate(projectId, (tasks) => [...tasks, task])) ? task : null;
  }

  async update(projectId: string, taskId: string, body: unknown): Promise<Task | null> {
    const patch = parseOr(TaskPatch, body);
    if (patch.staffId) await this.staffOrThrow(projectId, patch.staffId);
    // Revisor e responsável não podem ser a mesma pessoa, mesmo quando só um dos dois muda.
    const dir = await this.deps.projectPath(projectId);
    const cur = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (cur)
      await this.checkReviewer(
        projectId,
        patch.reviewerId !== undefined ? patch.reviewerId : (cur.reviewerId ?? null),
        patch.staffId !== undefined ? patch.staffId : cur.staffId,
        patch.reviewerId !== undefined,
      );
    let before: Task | undefined;
    const out = await this.change(projectId, taskId, (t) => {
      before = t;
      const next = withPatch(t, patch, 'you');
      // Fora da fila: você tirou, trocou o responsável ou levou o cartão para outra coluna.
      const leaves = patch.queued === false || next.staffId !== t.staffId || next.status !== 'todo';
      return leaves && next.queuedAt ? { ...next, queuedAt: null, queuedForce: false } : next;
    });
    // Saiu de "fazendo" à mão (ou mudou de dono): quem estava com ela pode pegar a próxima.
    for (const s of new Set([before?.staffId, out?.staffId])) if (s) void this.kick(projectId, s);
    return out;
  }

  async remove(projectId: string, taskId: string): Promise<boolean> {
    let found: Task | undefined;
    const ok = await this.mutate(projectId, (tasks) => {
      found = tasks.find((t) => t.id === taskId);
      return tasks.filter((t) => t.id !== taskId);
    });
    if (found?.staffId) void this.kick(projectId, found.staffId);
    return !!ok && !!found;
  }

  /**
   * Começa: conversa nova com o funcionário, com o título e a descrição. Com a ficha em "só
   * planeja", a tarefa vai para "planejando"; senão, para "fazendo". Com ele ocupado, entra na
   * fila dele e começa sozinha quando ele ficar livre.
   */
  async start(projectId: string, taskId: string, force = false): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const tasks = dir ? await readTasks(dir) : [];
    const task = tasks.find((t) => t.id === taskId);
    if (!dir || !task) return null;
    if (!task.staffId) throw new TaskError('escolha quem vai cuidar da tarefa');
    if (task.sessionId) throw new TaskError('a tarefa já começou: continue pela conversa dela');
    const profile = await this.staffOrThrow(projectId, task.staffId);
    const staffId = task.staffId;
    // Na mesma vez do funcionário que a fila: dois "Começar" juntos não abrem duas conversas.
    return this.locked(projectId, staffId, async () => {
      const busyWith = occupant(await readTasks(dir), staffId, taskId);
      if (!busyWith && !this.deps.isWorking?.(staffId)) return this.startNow(projectId, taskId, profile, force);
      const note = busyWith ? `na fila de ${profile.name}, depois de “${busyWith.title}”` : `na fila de ${profile.name} (ele está numa conversa)`;
      return this.change(projectId, taskId, (t) => noted({ ...t, queuedAt: t.queuedAt ?? new Date().toISOString(), queuedForce: force }, note));
    });
  }

  private async startNow(projectId: string, taskId: string, profile: StaffProfile, force: boolean): Promise<Task | null> {
    const dir = await this.deps.projectPath(projectId);
    const task = dir ? (await readTasks(dir)).find((t) => t.id === taskId) : undefined;
    if (!dir || !task || task.sessionId) return null;
    const manager = task.requestedBy ? await this.deps.readProfile(projectId, task.requestedBy) : null;
    const text = [
      `[Tarefa "${task.title}"]`,
      manager ? `Pedida por ${manager.name} (${manager.role}), que vai conferir a sua entrega.` : '',
      task.description,
      'Quando terminar, responda com um resumo curto do que foi feito e do que falta.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const sessionId = await this.deps.send(projectId, profile.id, text, force);
    const branch = await this.deps.branchFor(dir, profile).catch(() => null);
    this.bySession.set(sessionId, { projectId, taskId, role: 'work' });
    const next: TaskStatus = profile.autonomy === 'plan' ? 'planning' : 'doing';
    return this.change(projectId, taskId, (t) =>
      moved({ ...t, sessionId, branch: branch ?? t.branch, queuedAt: null, queuedForce: false }, next, 'auto', `com ${profile.name}`),
    );
  }

  /**
   * Sua mensagem para a conversa de uma tarefa enquanto o funcionário está em outra: fica guardada
   * na tarefa e vai quando ele ficar livre. Devolve o motivo, ou null se pode mandar já.
   */
  async hold(sessionId: string, msg: { text: string; images?: string[] }): Promise<string | null> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return null;
    const tasks = (await this.list(where.projectId)) ?? [];
    const task = tasks.find((t) => t.id === where.taskId);
    if (!task?.staffId) return null;
    const busyWith = occupant(tasks, task.staffId, task.id);
    if (!busyWith && !this.deps.isWorking?.(task.staffId, sessionId)) return null;
    const name = (await this.deps.readProfile(where.projectId, task.staffId))?.name ?? 'ele';
    const reason = busyWith ? `espera ${name} terminar “${busyWith.title}”` : `espera ${name} terminar a conversa em que está`;
    const held: HeldMessage = { id: randomBytes(4).toString('hex'), at: new Date().toISOString(), text: msg.text, ...(msg.images?.length && { images: msg.images }), reason };
    await this.change(where.projectId, task.id, (t) => noted({ ...t, held: [...(t.held ?? []), held] }, `ajuste guardado: ${reason}`));
    return reason;
  }

  /** As mensagens guardadas desta conversa, como itens do chat. */
  async heldItems(sessionId: string): Promise<ChatItem[]> {
    const where = await this.where(sessionId);
    if (!where || where.role !== 'work') return [];
    const task = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    return (task?.held ?? []).map((m) => ({ kind: 'user', id: `h:${m.id}`, text: m.text, at: m.at, held: m.reason, ...(m.images?.length && { images: m.images.length }) }));
  }

  /**
   * Uma conversa do Claudio’s Club parou de trabalhar: se for de uma tarefa, a entrega anda; se for de um
   * funcionário, ele pode pegar o que espera.
   */
  async onIdle(sessionId: string, projectId: string | null, staffId: string | null): Promise<void> {
    await this.workDone(sessionId);
    if (projectId && staffId) await this.kick(projectId, staffId);
  }

  /** Rede de segurança (na subida e de tempos em tempos): quem tem fila ou ajuste esperando e está livre. */
  async tick(): Promise<void> {
    for (const projectId of await this.deps.projectIds()) {
      const tasks = (await this.list(projectId)) ?? [];
      const waiting = new Set(tasks.filter((t) => t.staffId && (t.queuedAt || t.held?.length)).map((t) => t.staffId!));
      for (const s of waiting) await this.kick(projectId, s);
    }
  }

  /** Um por vez por funcionário (começar, pegar a próxima, mandar ajustes). */
  private locked<T>(projectId: string, staffId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${projectId}:${staffId}`;
    const run = (this.kicks.get(key) ?? Promise.resolve()).then(fn);
    this.kicks.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** Se ele está livre: primeiro os ajustes guardados (o mais antigo antes), depois a próxima da fila. */
  private kick(projectId: string, staffId: string): Promise<void> {
    return this.locked(projectId, staffId, () => this.takeNext(projectId, staffId)).catch(() => {});
  }

  private async takeNext(projectId: string, staffId: string): Promise<void> {
    const tasks = (await this.list(projectId)) ?? [];
    if (occupant(tasks, staffId) || this.deps.isWorking?.(staffId)) return;
    const adjust = tasks
      .filter((t) => t.staffId === staffId && t.sessionId && t.held?.length)
      .sort((a, b) => a.held![0]!.at.localeCompare(b.held![0]!.at))[0];
    if (adjust && this.deps.sendTo) {
      const held = adjust.held!;
      const text = held.map((m) => m.text).filter(Boolean).join('\n\n');
      try {
        await this.deps.sendTo(projectId, adjust.sessionId!, staffId, text, held.flatMap((m) => m.images ?? []));
      } catch (err) {
        await this.change(projectId, adjust.id, (t) => noted(t, `o ajuste guardado não foi: ${(err as Error).message}`));
        return;
      }
      const sent = new Set(held.map((m) => m.id));
      await this.change(projectId, adjust.id, (t) => noted({ ...t, held: (t.held ?? []).filter((m) => !sent.has(m.id)) }, 'ajuste guardado enviado'));
      return;
    }
    const next = tasks.find((t) => t.staffId === staffId && t.status === 'todo' && t.queuedAt && !t.sessionId);
    if (!next) return;
    const profile = await this.deps.readProfile(projectId, staffId);
    if (!profile) return;
    try {
      await this.startNow(projectId, next.id, profile, !!next.queuedForce);
    } catch (err) {
      // Continua na fila (ex.: limite de consumo); "Começar" de novo tenta já.
      await this.change(projectId, next.id, (t) => noted(t, `não começou: ${(err as Error).message}`));
    }
  }

  /** O código da tarefa: onde está, o que mudou e se dá para mesclar. */
  async code(projectId: string, taskId: string): Promise<TaskCode | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    return readCode(dir, place, deliveredAt(task));
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

  /** Pede ao Codex uma segunda opinião sobre o diff da tarefa e guarda no cartão (só quando você pede). */
  async secondOpinion(projectId: string, taskId: string): Promise<Task | null> {
    if (!this.deps.secondOpinion) throw new TaskError('a segunda opinião não está disponível');
    const { task } = await this.context(projectId, taskId);
    const code = await this.code(projectId, taskId);
    if (!code?.diff.trim()) throw new TaskError('não há mudanças para revisar');
    const text = await this.deps.secondOpinion({ title: task.title, request: task.description, diff: code.diff, truncated: code.truncated });
    const at = new Date().toISOString();
    return this.change(projectId, taskId, (t) => noted({ ...t, secondOpinion: { at, text } }, 'segunda opinião do Codex'));
  }

  /** Mescla a worktree no projeto (testes verdes, ou sem testes confirmado). A tarefa vai para "pronto". */
  async merge(projectId: string, taskId: string, skipTests = false): Promise<Task | null> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree);
    if (!place) throw new TaskError('o projeto não é um repositório git');
    try {
      const m = await mergeCode(dir, place, task.title, { skipTests, upTo: deliveredAt(task) });
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
      'Responda com APROVADO ou REPROVADO na primeira linha, exatamente assim. Se reprovar, em seguida a lista de ajustes (arquivo:linha e o porquê). Não mude o código: só revise.',
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
   * O turno de uma conversa da tarefa terminou. Do trabalho: fazendo → revisão. Da revisão: anota a
   * resposta e o veredito, e com revisor automático aprova ou reprova (ver onReviewTurn). Do deploy:
   * anota que a resposta chegou (a tarefa não muda de coluna sozinha por isso).
   */
  async onTurnDone(sessionId: string): Promise<void> {
    await this.onReviewTurn(sessionId);
    await this.onSession(sessionId, 'deploy', (t) => noteHandoff(t, 'deploy', 'deploy respondeu'));
    await this.workDone(sessionId);
  }

  /**
   * A revisão respondeu: anota o veredito (APROVADO ou REPROVADO, na primeira linha). Só a revisão
   * atual da tarefa conta, e só com o revisor marcado nela é que o veredito move a tarefa: aprovada
   * vai para pronto; reprovada, os ajustes voltam para a conversa de trabalho.
   */
  private async onReviewTurn(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (where?.role !== 'review') return;
    const current = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId);
    const isCurrent = current?.review?.sessionId === sessionId;
    const reviewText = this.deps.lastText?.(sessionId) ?? null;
    const verdict = isCurrent ? parseVerdict(reviewText) : undefined;
    const task = await this.change(where.projectId, where.taskId, (t) => noteHandoff(t, 'review', 'revisão respondida', verdict) ?? t);
    if (!task || !isCurrent || !verdict || task.status !== 'review' || !task.reviewerId || task.reviewerId !== task.review?.staffId) return;
    const reviewer = (await this.deps.readProfile(where.projectId, task.reviewerId))?.name ?? 'o revisor';
    if (verdict === 'approved') return this.approve(where.projectId, task.id, reviewer);
    return this.reject(where.projectId, task.id, reviewer, reviewText ?? '');
  }

  /** Aprovada pelo revisor: pronto, a não ser que o código ainda esteja numa worktree por mesclar. */
  private async approve(projectId: string, taskId: string, reviewer: string): Promise<void> {
    const { dir, task, profile } = await this.context(projectId, taskId);
    const place = task.staffId ? await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null) : null;
    if (place?.where === 'worktree' && !task.merged) {
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `aprovada por ${reviewer}; falta mesclar`) : t));
      return;
    }
    await this.change(projectId, taskId, (t) => (t.status === 'review' ? moved(t, 'done', 'auto', `aprovada por ${reviewer}`) : t));
  }

  /**
   * Reprovada: a resposta do revisor vai para a conversa de trabalho, como ajuste. Com ele ocupado
   * (outra tarefa, ou outra conversa dele), o ajuste fica guardado e a tarefa segue em revisão; quando
   * a mensagem for enviada, ela volta para fazendo. Livre, a tarefa vai para fazendo e a mensagem
   * entra na conversa dele. Quando o turno dele terminar, a próxima rodada é pedida (workDone).
   */
  private async reject(projectId: string, taskId: string, reviewer: string, reviewText: string): Promise<void> {
    const { task } = await this.context(projectId, taskId);
    if (!task.staffId || !task.sessionId) {
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `reprovada por ${reviewer}, mas não tem conversa de trabalho: fica com você`) : t));
      return;
    }
    const staffId = task.staffId;
    const work = task.sessionId;
    const msg = [
      `[Revisão da tarefa "${task.title}"]`,
      `${reviewer} reprovou a entrega. Os ajustes, como ele escreveu:`,
      reviewText.trim().slice(0, 4000),
      'Faça os ajustes e, quando terminar, responda com um resumo curto do que mudou.',
    ].join('\n\n');
    await this.locked(projectId, staffId, async () => {
      const reason = await this.hold(work, { text: msg });
      if (reason) {
        await this.change(projectId, taskId, (t) => (t.status === 'review' ? noted(t, `reprovada por ${reviewer}`) : t));
        return;
      }
      await this.change(projectId, taskId, (t) => (t.status === 'review' ? moved(t, 'doing', 'auto', `reprovada por ${reviewer}`) : t));
      try {
        if (!this.deps.sendTo) throw new TaskError('sem envio para a conversa de trabalho');
        await this.deps.sendTo(projectId, work, staffId, msg, []);
      } catch (err) {
        // Não foi (limite de consumo, conversa fechada…): fica guardado e volta para revisão; o vigia manda depois.
        const error = (err as Error).message;
        const held: HeldMessage = { id: randomBytes(4).toString('hex'), at: new Date().toISOString(), text: msg, reason: `não foi enviado: ${error}` };
        await this.change(projectId, taskId, (t) => {
          const back = t.status === 'doing' ? moved(t, 'review', 'auto', `ajuste de ${reviewer} não foi enviado: ${error}`) : t;
          return { ...back, held: [...(back.held ?? []), held] };
        });
      }
    });
  }

  /** Entregue com revisor marcado: pede a revisão sozinho, até AUTO_REVIEW_ROUNDS rodadas. */
  private async autoReview(projectId: string, task: Task): Promise<void> {
    if (!task.reviewerId) return;
    if ((task.reviewRounds ?? 0) >= AUTO_REVIEW_ROUNDS) {
      await this.change(projectId, task.id, (t) => noted(t, `limite de ${AUTO_REVIEW_ROUNDS} revisões automáticas; fica com você`));
      return;
    }
    try {
      await this.requestReview(projectId, task.id, task.reviewerId);
      await this.change(projectId, task.id, (t) => ({ ...t, reviewRounds: (t.reviewRounds ?? 0) + 1 }));
    } catch (err) {
      await this.change(projectId, task.id, (t) => noted(t, `revisão automática não começou: ${(err as Error).message}`));
    }
  }

  /** O revisor: outro funcionário do projeto, e não quem faz a tarefa (`check`: confere se ele existe). */
  private async checkReviewer(projectId: string, reviewerId: string | null, staffId: string | null, check: boolean): Promise<void> {
    if (!reviewerId) return;
    if (reviewerId === staffId) throw new TaskError('a revisão precisa ser de outro funcionário');
    if (check && !(await this.deps.readProfile(projectId, reviewerId))) throw new TaskError('revisor não encontrado neste projeto');
  }

  /**
   * Fazendo → revisão, com o commit da entrega, e a vez passa para o que espera. Vem do vigia de
   * sessões (que lê de tempos em tempos e perde turno curto) e do processo da conversa no Claudio’s Club (que
   * sabe a hora exata); o segundo aviso não muda nada.
   */
  private async workDone(sessionId: string): Promise<void> {
    const where = await this.where(sessionId);
    if (where?.role !== 'work') return;
    const staffId = ((await this.list(where.projectId)) ?? []).find((t) => t.id === where.taskId)?.staffId;
    if (!staffId) return;
    // Na vez dele: a próxima tarefa só começa depois que a entrega desta tem o seu commit.
    const deliveredTask = await this.locked(where.projectId, staffId, async () => {
      let delivered: Task | null = null;
      await this.change(where.projectId, where.taskId, (t) => (t.status === 'doing' ? (delivered = moved(t, 'review', 'auto', 'turno terminou')) : t));
      if (delivered) {
        await this.markDelivery(where.projectId, delivered);
        // Pedida por um gestor: o Claudio’s Club roda os testes antes de avisar, e o gestor não gasta a conversa
        // dele (a mais longa e cara) rodando de novo.
        const tests = (delivered as Task).requestedBy ? await this.deliveryTests(where.projectId, delivered) : null;
        if (tests) delivered = (await this.change(where.projectId, where.taskId, (t) => ({ ...t, tests }))) ?? delivered;
        await this.tellManager(where.projectId, delivered, sessionId);
      }
      return delivered as Task | null;
    });
    void this.kick(where.projectId, staffId);
    // Fora da vez dele: a revisão automática (com revisor marcado) é pedida depois da entrega.
    if (deliveredTask) await this.autoReview(where.projectId, deliveredTask);
  }

  /**
   * Tarefa pedida por um gestor foi entregue: ele recebe, na conversa dele, quem entregou, o quê e
   * o resumo, para conferir.
   */
  private async tellManager(projectId: string, task: Task, sessionId: string): Promise<void> {
    if (!task.requestedBy || !this.deps.notify) return;
    const who = task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    const name = who?.name ?? 'O funcionário';
    const summary = (this.deps.lastText?.(sessionId) ?? '').trim().slice(0, 1500);
    const t = task.tests;
    const tests = t
      ? t.ok
        ? `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): passaram em ${Math.round(t.ms / 1000)} s. Não rode de novo.`
        : `Testes (\`${t.command}\`, rodados pelo Claudio’s Club): FALHARAM. Fim da saída:\n${t.output.slice(-800)}`
      : '';
    const text = [
      `[MyCo] ${name} entregou a tarefa “${task.title}” (id ${task.id}, agora em revisão no quadro).`,
      summary ? `O que ${name} disse:\n${summary}` : `${name} não deixou resumo: veja a conversa da tarefa.`,
      tests,
      t ? 'Confira o diff na medida do risco antes de dar como pronto.' : 'Confira (diff, testes) antes de dar como pronto.',
      'Ajuste vai para a pessoa, na conversa da tarefa dela, não refaça você.',
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.deps.notify(projectId, task.requestedBy, text, task.requestedSession ?? null).catch(() => {});
  }

  /** Os testes do projeto onde está o código da entrega (a worktree dele ou o próprio projeto). */
  private async deliveryTests(projectId: string, task: Task): Promise<TestRun | null> {
    const dir = await this.deps.projectPath(projectId);
    if (!dir || !task.staffId) return null;
    const command = await detectTest(dir);
    if (!command) return null;
    const profile = await this.deps.readProfile(projectId, task.staffId);
    const place = await locateCode(dir, task.staffId, !!profile?.worktree).catch(() => null);
    return (this.deps.runTests ?? runTests)(place?.path ?? dir, command);
  }

  /**
   * Foi para revisão numa worktree: commita a entrega com o título da tarefa e guarda o commit. A
   * próxima tarefa dele começa na mesma worktree; a mescla desta vai só até aqui.
   */
  private async markDelivery(projectId: string, task: Task): Promise<void> {
    const dir = await this.deps.projectPath(projectId);
    const profile = dir && task.staffId ? await this.deps.readProfile(projectId, task.staffId) : null;
    if (!dir || !profile?.worktree) return;
    const place = await locateCode(dir, task.staffId, true).catch(() => null);
    const sha = place ? await checkpoint(place, task.title).catch(() => null) : null;
    if (sha) await this.change(projectId, task.id, (t) => noted({ ...t, checkpoint: { sha, at: new Date().toISOString() } }, `entrega no commit ${sha.slice(0, 7)}`));
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
    const where = await this.where(sessionId);
    if (where && where.role === role) await this.change(where.projectId, where.taskId, (t) => fn(t) ?? t);
  }

  /** A conversa é de uma tarefa (o trabalho, a revisão ou o deploy dela)? */
  async isTaskSession(sessionId: string): Promise<boolean> {
    return !!(await this.where(sessionId));
  }

  private async where(sessionId: string) {
    if (!this.bySession.has(sessionId) && !this.indexed) await this.summary(); // primeira vez depois de subir: monta o índice sessão → tarefa
    return this.bySession.get(sessionId) ?? null;
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

/**
 * O veredito da revisão: a primeira linha não vazia, sem markdown, é APROVADO ou REPROVADO
 * (maiúsculas). Qualquer outra coisa é null e não decide nada.
 */
export function parseVerdict(text: string | null | undefined): 'approved' | 'rejected' | null {
  const first = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  // A linha só com a palavra: "APROVADO, mas o teste X falha" não aprova.
  const line = first.replace(/^[*#_`>\s]+/, '').replace(/[*_`.!:\s]+$/, '');
  if (line === 'APROVADO') return 'approved';
  if (line === 'REPROVADO') return 'rejected';
  return null;
}

/** A revisão ou o deploy respondeu: marca a hora e deixa uma linha no histórico (sem mudar de coluna). */
function noteHandoff(t: Task, kind: 'review' | 'deploy', note: string, verdict?: TaskHandoff['verdict']): Task | null {
  const h = t[kind];
  if (!h) return null;
  const at = new Date().toISOString();
  const history = [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY);
  return { ...t, [kind]: { ...h, doneAt: at, ...(verdict !== undefined && { verdict }) }, history, updatedAt: at };
}

/** A tarefa que ocupa o funcionário (planejando ou fazendo, com conversa aberta), fora `except`. */
function occupant(tasks: Task[], staffId: string, except?: string): Task | undefined {
  return tasks.find((t) => t.staffId === staffId && t.id !== except && t.sessionId && OCCUPIED.includes(t.status));
}

/**
 * Até onde vai a entrega desta tarefa: o commit dela, se ela não voltou a "fazendo" depois (aí o
 * trabalho novo dela ainda não tem commit e entra tudo).
 */
function deliveredAt(t: Task): string | null {
  return t.checkpoint && t.status !== 'doing' && t.status !== 'planning' ? t.checkpoint.sha : null;
}

/** Uma linha no histórico, sem mudar de coluna. */
function noted(t: Task, note: string): Task {
  const at = new Date().toISOString();
  return { ...t, history: [...t.history, { at, status: t.status, by: 'auto' as const, note }].slice(-MAX_HISTORY), updatedAt: at };
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
