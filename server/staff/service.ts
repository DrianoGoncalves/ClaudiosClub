import { randomUUID } from 'node:crypto';
import type { AccountUsage, LaunchResult, McpServerInfo, Project, ProjectConnection, ServerInfo, StaffProfile, UsageStop } from '../../shared/model';
import { keyFilesOf, listServers, readConnections, removeConnection, saveConnection, testConnection, writeSshConfig } from './servers';
import type { ToolAdapter } from '../adapters/types';
import { readConfig, setArchived, workspaceOf } from '../config';
import { librarySkillsOf } from '../skillLibrary';
import { readUsage } from '../usage';
import { projectBudgetHit, usageStopHit, UsageStopError } from '../usageStop';
import { TEMP_IDLE_DAYS } from '../../shared/model';
import { buildClaudeArgs, capAutonomy } from './ficha';
import { greeting, launchStaff, prepareRun, sessionCwd, writeFicha, type LaunchContext } from './launch';
import { ensureWorktree, worktreeFor, type Worktree } from './worktree';
import { listMcpServers } from './mcp';
import {
  archiveVersion,
  createProfile,
  listProjectStaff,
  listVersions,
  readPortrait,
  readProfile,
  readVersion,
  removePortrait,
  replacePortrait,
  saveProfile,
  StaffError,
  StaffInputSchema,
  RoutinesSchema,
} from './store';

export interface StaffServiceOptions {
  runDir: string;
  claudeConfigFile: string;
  mycoUrl: string;
  open?: LaunchContext['open'];
  /** Consumo 5h/7d (testes trocam). */
  readUsage?: () => Promise<AccountUsage>;
  /** Cria a worktree da ficha (testes trocam o git). */
  ensureWorktree?: (projectPath: string, staffId: string) => Promise<Worktree>;
  /** Biblioteca de skills da conta (padrão ~/.myco/skills; os testes trocam). */
  skillLibraryDir?: string;
  /** A ficha foi editada ou restaurada (as conversas abertas dela precisam saber). */
  onChange?: (prev: StaffProfile, next: StaffProfile) => void;
  /** Custo dos últimos 7 dias do projeto e da conta toda, para o orçamento por projeto. */
  weekCost?: (projectId: string) => Promise<{ project: number; total: number }>;
  /** Abre uma conversa nova no MyCo e manda a mensagem (subfuncionário contratado pela API). */
  openChat?: (projectId: string, staffId: string, text: string) => Promise<string>;
  /** Alguma conversa do funcionário está trabalhando agora. */
  isWorking?: (staffId: string) => boolean;
  /** Arquivados (config → `staff:<id>`); os testes trocam para não mexer no config de verdade. */
  archive?: { has: (key: string) => Promise<boolean>; set: (key: string, archived: boolean) => Promise<void> };
}

const configArchive = {
  has: async (key: string) => (await readConfig()).archived.sessions.includes(key),
  set: async (key: string, archived: boolean) => void (await setArchived({ kind: 'session', id: key, archived })),
};

/** Contratação e expediente dos funcionários (sessões com ficha). */
export class StaffService {
  constructor(
    private readonly adapter: ToolAdapter,
    private readonly opts: StaffServiceOptions,
  ) {}

  async listAll(projects: Project[]): Promise<StaffProfile[]> {
    const lists = await Promise.all(projects.filter((p) => p.exists).map((p) => listProjectStaff(p.path, p.id)));
    return lists.flat();
  }

  async listServers(projectId: string): Promise<ServerInfo[] | null> {
    const project = await this.project(projectId);
    return project ? listServers(project.path) : null;
  }

  // ---- conexões SSH do projeto (só pelo MyCo: as rotas recusam pedido de funcionário) ----

  async listConnections(projectId: string): Promise<ProjectConnection[] | null> {
    const project = await this.project(projectId);
    return project ? readConnections(project.path) : null;
  }

  /** `originalName` no corpo: a conexão editada (renomear mantém o acesso de quem já tinha). */
  async saveConnection(projectId: string, body: unknown): Promise<ProjectConnection | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    const original = (body as { originalName?: unknown } | null)?.originalName;
    const originalName = typeof original === 'string' && original ? original : undefined;
    const saved = await saveConnection(project.path, body, originalName);
    if (originalName && originalName !== saved.name) {
      for (const s of await listProjectStaff(project.path, project.id)) {
        if (!s.servers.includes(originalName)) continue;
        await saveProfile(project.path, { ...s, servers: s.servers.map((n) => (n === originalName ? saved.name : n)), updatedAt: new Date().toISOString() });
      }
    }
    return saved;
  }

  async removeConnection(projectId: string, name: string): Promise<boolean | null> {
    const project = await this.project(projectId);
    return project ? removeConnection(project.path, name) : null;
  }

  async testConnection(projectId: string, name: string): Promise<{ ok: boolean; message: string } | null> {
    const project = await this.project(projectId);
    return project ? testConnection(project.path, name) : null;
  }

  async listMcp(projectId: string): Promise<McpServerInfo[] | null> {
    const project = await this.project(projectId);
    return project ? listMcpServers(project.path, this.opts.claudeConfigFile) : null;
  }

  /**
   * Contrata. Pelo navegador (`fromBrowser`), qualquer ficha. Sem origem de navegador (um
   * funcionário chamando a API), só com `reportsTo` apontando para quem pode contratar, e com
   * autonomia limitada à do gestor.
   */
  async hire(
    projectId: string,
    body: unknown,
    fromBrowser: boolean,
  ): Promise<{ profile: StaffProfile; launch: LaunchResult | null } | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    const parsed = StaffInputSchema.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'ficha inválida');
    const input = parsed.data;

    const managers = await this.managers(project.path, input.reportsTo);
    const hirer = fromBrowser ? undefined : managers.find((m) => m.canHire);
    if (!fromBrowser) {
      if (!hirer) throw new StaffError('só um funcionário com permissão de contratar pode contratar pela API');
      input.autonomy = capAutonomy(input.autonomy, hirer.autonomy);
      input.canHire = false; // subfuncionário contratado por outro não contrata em cascata
      input.servers = input.servers.filter((s) => hirer.servers.includes(s)); // nem acessa servidor que o gestor não acessa
      input.usageStop = hirer.usageStop; // nem passa por cima da trava do gestor
      input.browser = input.browser && hirer.browser; // nem usa o navegador se o gestor não usa
    }

    // Funcionário criado fora do MyCo: a sessão existente passa a ser dele, sem abrir outra.
    if (input.adoptSessionId) {
      if (!fromBrowser) throw new StaffError('só pelo MyCo');
      const sessionId = input.adoptSessionId;
      const session = ((await this.adapter.getProjectSessions(project.id)) ?? []).find((s) => s.id === sessionId);
      if (!session) throw new StaffError('sessão não encontrada neste projeto');
      const owner = (await listProjectStaff(project.path, project.id)).find((s) => s.sessions.some((x) => x.id === sessionId));
      if (owner) throw new StaffError(`essa sessão já é de ${owner.name}`);
      const sessions = [{ id: sessionId, startedAt: session.startedAt ?? session.updatedAt }];
      const profile = await createProfile(project.path, project.id, input, new Date(), sessions);
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: null };
    }

    // A trava vale também para quem contrata pela API (sem como confirmar, só recusa).
    if (input.launch && !(fromBrowser && input.force)) await this.guardUsage(input.usageStop, project.id);
    let profile = await createProfile(project.path, project.id, input);
    if (hirer) {
      // Contratado por outro funcionário: temporário, com quem contratou (ver end/sweepTemporaries).
      profile = { ...profile, hiredBy: hirer.id, temporary: true };
      await saveProfile(project.path, profile);
    }
    if (!input.launch) {
      // Sem sessão ainda, mas a ficha e a memória já ficam no projeto para conferir.
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: null };
    }
    // Pela API, a sessão abre numa conversa do MyCo (não num terminal): fica à vista no quadro, na
    // fila de tarefas e na caixa "precisa de mim".
    if (hirer && this.opts.openChat) {
      try {
        const sessionId = await this.opts.openChat(project.id, profile.id, greeting(profile));
        const opened = (await readProfile(project.path, profile.id)) ?? profile;
        return { profile: opened, launch: { ok: true, sessionId, command: '', error: null } };
      } catch (err) {
        await writeFicha(profile, await this.context(project, profile));
        return { profile, launch: { ok: false, sessionId: null, command: '', error: err instanceof Error ? err.message : String(err) } };
      }
    }
    try {
      const { result, profile: launched } = await this.launchProfile(project, profile, false);
      return { profile: launched, launch: result };
    } catch (err) {
      // Contratado, mas a sessão não abriu (ex.: a worktree pedida não pôde ser criada).
      if (!(err instanceof StaffError)) throw err;
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: { ok: false, sessionId: null, command: '', error: err.message } };
    }
  }

  /**
   * Edita a ficha (só pelo navegador). A versão anterior vai para o histórico; sessões e data de
   * contratação ficam. Retrato: data URL troca, null remove, ausente mantém.
   */
  async update(projectId: string, staffId: string, body: unknown): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    const parsed = StaffInputSchema.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'ficha inválida');
    const { portraitDataUrl, launch: _launch, adoptSessionId: _adopt, force: _force, ...fields } = parsed.data;
    if (fields.reportsTo.includes(staffId)) throw new StaffError('um funcionário não pode reportar a si mesmo');
    await this.managers(project.path, fields.reportsTo);
    if (await this.wouldCycle(project.path, staffId, fields.reportsTo)) {
      throw new StaffError('esse vínculo criaria um ciclo (um subordinado não pode chefiar o próprio gestor)');
    }

    await archiveVersion(project.path, current);
    let portrait = current.portrait;
    if (portraitDataUrl === null) portrait = await removePortrait(project.path, current);
    else if (portraitDataUrl) portrait = await replacePortrait(project.path, current, portraitDataUrl);
    const next: StaffProfile = { ...current, ...fields, projectId, portrait, updatedAt: new Date().toISOString() };
    await saveProfile(project.path, next);
    await writeFicha(next, await this.context(project, next));
    this.opts.onChange?.(current, next);
    return next;
  }

  /** Troca as rotinas agendadas (só pelo MyCo). A ficha anterior vai para o histórico. */
  async setRoutines(projectId: string, staffId: string, body: unknown): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    const parsed = RoutinesSchema.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'rotina inválida');
    if (new Set(parsed.data.map((r) => r.id)).size !== parsed.data.length) throw new StaffError('rotinas com o mesmo id');
    await archiveVersion(project.path, current);
    const next: StaffProfile = { ...current, projectId, routines: parsed.data, updatedAt: new Date().toISOString() };
    await saveProfile(project.path, next);
    return next;
  }

  async versions(projectId: string, staffId: string) {
    const project = await this.project(projectId);
    return project ? listVersions(project.path, staffId) : null;
  }

  /** Volta a ficha para uma versão anterior (a atual também vai para o histórico). */
  async restore(projectId: string, staffId: string, version: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    const old = project ? await readVersion(project.path, staffId, version) : null;
    if (!project || !current || !old) return null;
    await archiveVersion(project.path, current);
    // Sessões e retrato são do presente: só os campos da ficha voltam.
    // Rotinas também são do presente: voltar a ficha não desagenda nem reagenda nada.
    const next: StaffProfile = {
      ...old,
      id: current.id,
      projectId,
      sessions: current.sessions,
      portrait: current.portrait,
      routines: current.routines,
      // Temporário ou efetivado é situação de agora, não da ficha antiga.
      hiredBy: current.hiredBy,
      temporary: current.temporary,
      ended: current.ended,
      updatedAt: new Date().toISOString(),
    };
    await saveProfile(project.path, next);
    await writeFicha(next, await this.context(project, next));
    this.opts.onChange?.(current, next);
    return next;
  }

  /**
   * Encerra um temporário: sai do quadro (arquivado; ficha, memória e conversas ficam). Só
   * temporários: um funcionário seu não é encerrado por outro.
   */
  async end(projectId: string, staffId: string, reason: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    if (!current.temporary) throw new StaffError(`${current.name} não é temporário: só você arquiva, pelo quadro`);
    const next: StaffProfile = { ...current, projectId, ended: { at: new Date().toISOString(), reason: reason.slice(0, 300) || 'encerrado' } };
    await saveProfile(project.path, next);
    await this.archive.set(`staff:${staffId}`, true);
    return next;
  }

  /** Efetivar: o temporário vira funcionário do projeto (e volta ao quadro, se tinha saído). */
  async keep(projectId: string, staffId: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    const next: StaffProfile = { ...current, projectId, temporary: false, ended: null, updatedAt: new Date().toISOString() };
    await saveProfile(project.path, next);
    await this.archive.set(`staff:${staffId}`, false);
    return next;
  }

  /**
   * Voltou ao quadro (desarquivado): o temporário recomeça a contar os dias parado a partir de
   * agora, senão a próxima varredura o tiraria de novo.
   */
  async restored(staffId: string): Promise<void> {
    for (const project of (await this.adapter.listProjects()).filter((p) => p.exists)) {
      const current = await readProfile(project.path, staffId);
      if (!current) continue;
      if (current.temporary) await saveProfile(project.path, { ...current, ended: null, updatedAt: new Date().toISOString() });
      return;
    }
  }

  /**
   * Temporários parados há mais de `days` dias (sem conversa, sem edição) saem do quadro. Quem
   * está trabalhando agora fica. Devolve os encerrados.
   */
  async sweepTemporaries(now = new Date(), days = TEMP_IDLE_DAYS): Promise<StaffProfile[]> {
    const out: StaffProfile[] = [];
    for (const project of (await this.adapter.listProjects()).filter((p) => p.exists)) {
      const temps = (await listProjectStaff(project.path, project.id)).filter((s) => s.temporary);
      if (!temps.length) continue;
      const sessions = (await this.adapter.getProjectSessions(project.id).catch(() => null)) ?? [];
      const touched = new Map(sessions.map((s) => [s.id, s.updatedAt]));
      for (const s of temps) {
        if ((await this.archive.has(`staff:${s.id}`)) || this.opts.isWorking?.(s.id)) continue;
        const last = [s.createdAt, s.updatedAt, ...s.sessions.map((x) => touched.get(x.id) ?? x.startedAt)].sort().at(-1)!;
        const idle = (now.getTime() - Date.parse(last)) / 86_400_000;
        if (idle < days) continue;
        const ended = await this.end(project.id, s.id, `parado há ${Math.floor(idle)} dias`);
        if (ended) out.push(ended);
      }
    }
    return out;
  }

  private get archive() {
    return this.opts.archive ?? configArchive;
  }

  /** Acrescenta um gestor a um funcionário (o "+" arrastado até outro funcionário no quadro). */
  async addManager(projectId: string, staffId: string, managerId: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    if (current.reportsTo.includes(managerId)) return current;
    const { id: _i, projectId: _p, portrait: _pt, sessions: _s, createdAt: _c, updatedAt: _u, ...fields } = current;
    return this.update(projectId, staffId, { ...fields, reportsTo: [...current.reportsTo, managerId] });
  }

  /**
   * Desfaz o vínculo com um gestor (a linha desfeita no quadro). Sem gestores, passa a reportar a você.
   * A ficha anterior vai para o histórico, então dá para voltar.
   */
  async removeManager(projectId: string, staffId: string, managerId: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    if (!current.reportsTo.includes(managerId)) return current;
    const { id: _i, projectId: _p, portrait: _pt, sessions: _s, createdAt: _c, updatedAt: _u, ...fields } = current;
    return this.update(projectId, staffId, { ...fields, reportsTo: current.reportsTo.filter((id) => id !== managerId) });
  }

  private async managers(projectPath: string, ids: string[]): Promise<StaffProfile[]> {
    const found = await Promise.all(ids.map((id) => readProfile(projectPath, id)));
    if (found.some((m) => !m)) throw new StaffError('gestor não encontrado neste projeto');
    return found as StaffProfile[];
  }

  /** `staffId` passaria a ser chefe (direto ou indireto) de si mesmo? */
  private async wouldCycle(projectPath: string, staffId: string, managerIds: string[]): Promise<boolean> {
    const seen = new Set<string>();
    const queue = [...managerIds];
    while (queue.length) {
      const id = queue.shift()!;
      if (id === staffId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const p = await readProfile(projectPath, id);
      if (p) queue.push(...p.reportsTo);
    }
    return false;
  }

  async launch(projectId: string, staffId: string, resume: boolean, force = false): Promise<LaunchResult | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    const profile = await readProfile(project.path, staffId);
    if (!profile) return null;
    if (!force) await this.guardUsage(profile.usageStop, projectId);
    return (await this.launchProfile(project, { ...profile, projectId }, resume)).result;
  }

  /**
   * Trava de consumo antes de trabalho novo (conversa, sessão no terminal). Lança
   * UsageStopError quando o 5h/7d passou da linha da ficha ou da empresa.
   */
  async checkUsage(projectId: string, staffId: string | null): Promise<void> {
    const project = staffId ? await this.project(projectId) : null;
    const profile = project && staffId ? await readProfile(project.path, staffId) : null;
    await this.guardUsage(profile?.usageStop ?? null, projectId);
  }

  /** Trava da conta (5h/7d, da ficha ou da empresa) e, com `projectId`, o orçamento do projeto. */
  private async guardUsage(own: UsageStop | null, projectId?: string) {
    const [usage, config] = await Promise.all([(this.opts.readUsage ?? readUsage)(), readConfig()]);
    const hit = usageStopHit(usage, config.usageStop, own);
    if (hit) throw new UsageStopError(hit);
    const budget = projectId ? config.projectBudgets[projectId] : undefined;
    if (!budget || !projectId || !this.opts.weekCost) return;
    const [week, project] = await Promise.all([this.opts.weekCost(projectId), this.project(projectId)]);
    const over = projectBudgetHit(usage, week, budget, project?.name ?? projectId);
    if (over) throw new UsageStopError(over);
  }

  /**
   * Linha de comando para conversar pelo MyCo. Com ficha: autonomia, modelo, MCPs e identidade
   * da ficha (sessão nova quando `sessionId` é null). Sem ficha: só retoma a sessão, pedindo
   * aprovação para tudo. `forkFrom`: sessão nova como cópia desta (duplicar a conversa), na mesma
   * pasta da original.
   */
  async chatSpawn(projectId: string, sessionId: string | null, staffId: string | null, forkFrom?: string) {
    const project = await this.project(projectId);
    if (!project) return null;
    if (!staffId) {
      if (forkFrom) {
        const id = randomUUID();
        return { sessionId: id, cwd: project.path, args: ['--resume', forkFrom, '--fork-session', '--session-id', id, '--permission-mode', 'manual'] };
      }
      return sessionId ? { sessionId, cwd: project.path, args: ['--resume', sessionId, '--permission-mode', 'manual'] } : null;
    }
    let profile = await readProfile(project.path, staffId);
    if (!profile) return null;
    profile = { ...profile, projectId };
    const resume = !!sessionId && !forkFrom;
    const id = resume ? sessionId! : randomUUID();
    const ctx = await this.context(project, profile, true);
    const cwd = sessionCwd(profile, ctx, forkFrom ?? sessionId);
    const run = await prepareRun(profile, ctx, id, cwd);
    if (!resume) {
      const now = new Date().toISOString();
      await saveProfile(project.path, { ...profile, sessions: [...profile.sessions, { id, startedAt: now, cwd }], updatedAt: now });
    }
    const args = buildClaudeArgs(profile, { ...run, sessionId: id, resume, firstPrompt: null, ...(forkFrom && { forkFrom }) });
    return { sessionId: id, cwd, args };
  }

  async portrait(projectId: string, staffId: string) {
    const project = await this.project(projectId);
    const profile = project ? await readProfile(project.path, staffId) : null;
    return project && profile ? readPortrait(project.path, profile) : null;
  }

  private async launchProfile(project: Project, profile: StaffProfile, resume: boolean) {
    return launchStaff(profile, await this.context(project, profile, true), { resume });
  }

  /** `createWorktree`: vai abrir uma sessão agora, então a worktree da ficha precisa existir. */
  private async context(project: Project, profile: StaffProfile, createWorktree = false): Promise<LaunchContext> {
    const [config, managers, servers, worktree, everyone] = await Promise.all([
      readConfig(),
      Promise.all(profile.reportsTo.map((id) => readProfile(project.path, id))),
      // O ssh_config é refeito a cada sessão: vale o que está no .vps/config.json agora.
      profile.servers.length ? writeSshConfig(project.path).then(() => listServers(project.path)) : [],
      !profile.worktree
        ? null
        : createWorktree
          ? (this.opts.ensureWorktree ?? ensureWorktree)(project.path, profile.id)
          : worktreeFor(project.path, profile.id),
      listProjectStaff(project.path, project.id),
    ]);
    return {
      company: config.companyName,
      // O workspace do projeto (aba do quadro) entra na ficha como contexto (cliente, área…).
      workspace: workspaceOf(config, project.id)?.name ?? null,
      projectName: project.name,
      projectPath: project.path,
      managerNames: managers.filter((m): m is StaffProfile => !!m).map((m) => `${m.name} (${m.role})`),
      mycoUrl: this.opts.mycoUrl,
      runDir: this.opts.runDir,
      claudeConfigFile: this.opts.claudeConfigFile,
      worktree,
      servers,
      serverKeys: profile.servers.length ? await keyFilesOf(project.path, profile.servers) : [],
      librarySkills: profile.skills.length ? await librarySkillsOf(profile.skills, this.opts.skillLibraryDir) : [],
      skillLibraryDir: this.opts.skillLibraryDir,
      // A equipe dele: quem reporta a ele (os temporários encerrados já saíram do quadro, mas a ficha
      // não sabe disso; ficam de fora os que têm `ended`).
      team: everyone
        .filter((s) => s.id !== profile.id && s.reportsTo.includes(profile.id) && !s.ended)
        .map((s) => ({ id: s.id, name: s.name, role: s.role, mission: s.mission, ...(s.temporary && { temporary: true }) })),
      open: this.opts.open,
    };
  }

  /**
   * Pode `managerId` passar trabalho para `staffId`? Só para quem reporta a ele (a API não deixa um
   * funcionário mandar tarefa para quem não é da equipe dele).
   */
  async isManagerOf(projectId: string, managerId: string, staffId: string): Promise<boolean> {
    const project = await this.project(projectId);
    const target = project ? await readProfile(project.path, staffId) : null;
    return !!target && target.reportsTo.includes(managerId) && !!(await readProfile(project!.path, managerId));
  }

  private async project(id: string): Promise<Project | null> {
    const p = (await this.adapter.listProjects()).find((x) => x.id === id);
    return p && p.exists ? p : null;
  }
}

export { StaffError };
