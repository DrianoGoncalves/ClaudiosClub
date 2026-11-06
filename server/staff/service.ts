import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type {
  AccountUsage,
  AnyConnection,
  BrowserStatus,
  FtpConnection,
  LaunchResult,
  McpServerInfo,
  Project,
  ProjectConnection,
  ServerInfo,
  StaffProfile,
  Task,
} from '../../shared/model';
import type { VaultOptions } from '../secretVault';
import { isFtpConnection, listFtpServers, readFtpConnections, removeFtpConnection, saveFtpConnection, testFtpConnection, type FtpConnector } from './ftp';
import { keyFilesOf, listServers, readConnections, removeConnection, saveConnection, testConnection, writeStaffSshConfig } from './servers';

/** SSH completas e FTP com senha: o que dá para pôr numa ficha. */
async function allServers(projectPath: string, vault?: VaultOptions): Promise<ServerInfo[]> {
  return [...(await listServers(projectPath)), ...(await listFtpServers(projectPath, vault))];
}
import type { ToolAdapter } from '../adapters/types';
import { effectiveBrowser } from '../browser';
import { readConfig, setArchived, workspaceOf } from '../config';
import { librarySkillsOf } from '../skillLibrary';
import { readUsage } from '../usage';
import { projectBudgetHit, usageStopHit, UsageStopError } from '../usageStop';
import { TEMP_IDLE_DAYS } from '../../shared/model';
import { buildClaudeArgs, capAutonomy } from './ficha';
import { greeting, prepareRun, sessionCwd, writeFicha, type LaunchContext } from './launch';
import { ensureWorktree, worktreeFor, type Worktree } from './worktree';
import { listMcpServers } from './mcp';
import {
  archiveVersion,
  createProfile,
  ensureMemory,
  fichaFile,
  listProjectStaff,
  listVersions,
  memoryFile,
  profileFile,
  readPortrait,
  readProfile,
  readVersion,
  removePortrait,
  replacePortrait,
  saveChatChoice,
  saveProfile,
  staffDir,
  StaffError,
  StaffInputSchema,
  type StaffInputParsed,
  RoutinesSchema,
  withProfileLock,
  writeAtomic,
} from './store';

/** Uma ficha na lista de todas as empresas (para copiar). Só estes campos: nada de memória, regras ou servidores. */
export interface StaffDirectoryPerson {
  projectId: string;
  projectName: string;
  staffId: string;
  name: string;
  role: string;
  mission: string;
  hasPortrait: boolean;
  updatedAt: string;
  /** Mesma pessoa em outras fichas (cópias): o id do grupo; null sem vínculo. */
  personId: string | null;
  /** Arquivado no quadro (mesma regra do quadro: `staff:<id>` no config). */
  archived: boolean;
  /** Gestores (ids de funcionários do mesmo projeto). Vazio = reporta a você. */
  reportsTo: string[];
}

/** Conflito com o estado atual (ex.: a conversa do funcionário está trabalhando): 409 na rota. */
export class StaffBusyError extends StaffError {}

/** Tarefas abertas da ficha, sem `force`: 409 com `code` e a quantidade, para a tela pedir a segunda confirmação. */
export class StaffOpenTasksError extends StaffBusyError {
  readonly code = 'open-tasks';
  constructor(
    message: string,
    readonly openTasks: number,
  ) {
    super(message);
  }
}

const ID_TEXT = /^[A-Za-z0-9-]+$/;
const PORTRAIT_FILE = /^[a-z0-9-]+\.(png|jpg|webp)$/;

const CopyBody = z.object({
  fromProjectId: z.string().regex(/^[A-Za-z0-9-]+$/, 'projeto de origem inválido').max(200),
  staffId: z.string().regex(/^[A-Za-z0-9-]+$/, 'funcionário inválido').max(40),
  withMemory: z.boolean().default(false),
  // Gestores no projeto de destino (ids de funcionários de lá). Conferidos antes de criar qualquer coisa.
  reportsTo: z.array(z.string().regex(/^[A-Za-z0-9-]+$/, 'gestor inválido').max(40)).max(10).default([]),
});

const StaffRefBody = z.object({
  projectId: z.string().regex(ID_TEXT, 'projeto inválido').max(200),
  staffId: z.string().regex(ID_TEXT, 'funcionário inválido').max(40),
});
const LinkBody = z.object({ from: StaffRefBody, to: StaffRefBody });
const UnlinkBody = StaffRefBody;
const ApplyToCopiesBody = z.object({ applyToCopies: z.boolean().optional() });
/** Apagar com tarefas abertas: `force` deixa as tarefas sem responsável (confirmado na tela). Sem corpo = sem force. */
const DeleteStaffBody = z.object({ force: z.boolean().default(false) });

/** Campos que a edição leva para as cópias da mesma pessoa. Nunca: vínculos, servidores, memória, conversas, rotinas, MCPs. */
const COPY_TEXT_FIELDS = ['name', 'role', 'mission', 'rules', 'doneWhen', 'model', 'effort', 'agents', 'skills'] as const;

/** `child` está dentro de `dir` (sem sair por `..` nem por outro caminho). */
function insideDir(dir: string, child: string): boolean {
  const root = path.resolve(dir) + path.sep;
  return path.resolve(child).startsWith(root);
}

export interface StaffServiceOptions {
  runDir: string;
  claudeConfigFile: string;
  mycoUrl: string;
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
  /** Abre uma conversa nova no Claudio’s Club e manda a mensagem (subfuncionário contratado pela API). */
  openChat?: (projectId: string, staffId: string, text: string) => Promise<string>;
  /** Alguma conversa do funcionário está trabalhando agora. */
  isWorking?: (staffId: string) => boolean;
  /** Tarefas do quadro do projeto (o delete recusa se alguma aberta aponta para a ficha). Padrão: nenhuma. */
  tasksOf?: (projectId: string) => Promise<Pick<Task, 'staffId' | 'reviewerId' | 'status'>[]>;
  /** Com `force`, solta as tarefas abertas da ficha (sem responsável; ver TaskService.releaseStaff). Sem ele, `force` recusa. */
  releaseTasks?: (projectId: string, staffId: string) => Promise<number>;
  /** Arquivados (config → `staff:<id>`); os testes trocam para não mexer no config de verdade. */
  archive?: { has: (key: string) => Promise<boolean>; set: (key: string, archived: boolean) => Promise<void> };
  /** Extensão do Chrome instalada? (padrão server/browser.ts; os testes trocam). */
  browserStatus?: () => Promise<BrowserStatus | null>;
  /** Cofre das senhas de FTP (padrão ~/.myco/secrets; os testes trocam). */
  vault?: VaultOptions;
  /** Cliente FTP do teste de conexão (padrão basic-ftp; os testes trocam). */
  ftpConnect?: FtpConnector;
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
    return project ? allServers(project.path, this.opts.vault) : null;
  }

  // ---- conexões SSH e FTP do projeto (só pelo Claudio’s Club: as rotas recusam pedido de funcionário) ----

  async listConnections(projectId: string): Promise<AnyConnection[] | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    return [...(await readConnections(project.path)), ...(await readFtpConnections(project.path, this.opts.vault))];
  }

  /** SSH. `originalName` no corpo: a conexão editada (renomear mantém o acesso de quem já tinha). */
  async saveConnection(projectId: string, body: unknown): Promise<ProjectConnection | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    const original = (body as { originalName?: unknown } | null)?.originalName;
    const originalName = typeof original === 'string' && original ? original : undefined;
    const wanted = (body as { name?: unknown } | null)?.name;
    // O nome é a referência na ficha: não repete entre SSH e FTP (nem só nas maiúsculas).
    if (typeof wanted === 'string' && (await readFtpConnections(project.path, this.opts.vault)).some((c) => c.name.toLowerCase() === wanted.trim().toLowerCase())) {
      throw new StaffError(`já existe uma conexão FTP ${wanted.trim()}`);
    }
    const saved = await saveConnection(project.path, body, originalName);
    if (originalName && originalName !== saved.name) await this.renameInFichas(project, originalName, saved.name);
    return saved;
  }

  /** FTP: criar ou editar (senha ausente na edição = mantém a do cofre). Nunca devolve a senha. */
  async saveFtpConnection(projectId: string, body: unknown): Promise<FtpConnection | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    const original = (body as { originalName?: unknown } | null)?.originalName;
    const saved = await saveFtpConnection(project.path, body, this.opts.vault);
    if (typeof original === 'string' && original && original !== saved.name) await this.renameInFichas(project, original, saved.name);
    return saved;
  }

  /** Renomear leva o acesso de quem já tinha (a ficha guarda o nome) e refaz o ssh_config dessas pessoas. */
  private async renameInFichas(project: Project, from: string, to: string): Promise<void> {
    for (const s of await listProjectStaff(project.path, project.id)) {
      if (!s.servers.includes(from)) continue;
      const servers = s.servers.map((n) => (n === from ? to : n));
      await saveProfile(project.path, { ...s, servers, updatedAt: new Date().toISOString() });
      await writeStaffSshConfig(project.path, s.id, servers);
    }
  }

  async removeConnection(projectId: string, name: string): Promise<boolean | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    if (await isFtpConnection(project.path, name)) return removeFtpConnection(project.path, name, this.opts.vault);
    return removeConnection(project.path, name);
  }

  async testConnection(projectId: string, name: string): Promise<{ ok: boolean; message: string } | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    if (await isFtpConnection(project.path, name)) return testFtpConnection(project.path, name, { vault: this.opts.vault, connect: this.opts.ftpConnect });
    return testConnection(project.path, name);
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
      input.browser = input.browser && hirer.browser; // nem usa o navegador se o gestor não usa
    }

    // Funcionário criado fora do Claudio’s Club: a sessão existente passa a ser dele, sem abrir outra.
    if (input.adoptSessionId) {
      if (!fromBrowser) throw new StaffError('só pelo Claudio’s Club');
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
    if (input.launch && !(fromBrowser && input.force)) await this.checkUsage(project.id);
    let profile = await createProfile(project.path, project.id, input);
    if (hirer) {
      // Contratado por outro funcionário: temporário, com quem contratou (ver end/sweepTemporaries).
      profile = { ...profile, hiredBy: hirer.id, temporary: true };
      await saveProfile(project.path, profile);
    }
    if (!input.launch || !this.opts.openChat) {
      // Sem sessão ainda, mas a ficha e a memória já ficam no projeto para conferir.
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: null };
    }
    // A sessão abre numa conversa do Claudio’s Club, nunca num terminal (pelo navegador ou pela API): fica à
    // vista no quadro, na fila de tarefas e na caixa "precisa de mim".
    try {
      const sessionId = await this.opts.openChat(project.id, profile.id, greeting(profile));
      const opened = (await readProfile(project.path, profile.id)) ?? profile;
      return { profile: opened, launch: { ok: true, sessionId, command: '', error: null } };
    } catch (err) {
      // Contratado, mas a conversa não começou (ex.: a worktree pedida não pôde ser criada).
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: { ok: false, sessionId: null, command: '', error: err instanceof Error ? err.message : String(err) } };
    }
  }

  /**
   * Fichas de todos os projetos do quadro. Arquivado não sai da lista (a regra é mostrar todos com fichas; só sai se for
   * excluído numa ação explícita). Ficam de fora só os worktrees (repetiriam a ficha da pasta principal), os que não
   * existem e as pastas que não dá para ler. Uma pasta ruim não derruba as demais.
   */
  async directory(): Promise<{ people: StaffDirectoryPerson[] }> {
    const projects = await this.adapter.listProjects();
    const people: StaffDirectoryPerson[] = [];
    for (const project of projects) {
      if (!project.exists || project.worktreeOf) continue;
      const staff = await listProjectStaff(project.path, project.id).catch(() => []);
      for (const s of staff) {
        people.push({
          projectId: project.id,
          projectName: project.name,
          staffId: s.id,
          name: s.name,
          role: s.role,
          mission: s.mission,
          hasPortrait: !!s.portrait,
          updatedAt: s.updatedAt,
          personId: s.personId ?? null,
          archived: await this.archive.has(`staff:${s.id}`),
          reportsTo: s.reportsTo,
        });
      }
    }
    return { people };
  }

  /**
   * Copia a ficha de outro projeto para este (só pelo Claudio’s Club). Vem o que é da pessoa: nome, cargo, missão, regras,
   * autonomia, modelo e esforço, agents, skills, MCPs, conhecimento, navegador, worktree e o retrato (cópia do arquivo).
   * Não vem o que é do projeto de origem: vínculos (reportsTo), servidores, conversas (sessions), última escolha do chat,
   * rotinas, histórico de versões, situação de temporário (hiredBy, temporary, ended) e a primeira tarefa (é do trabalho
   * de lá). Sem conversa aberta. `withMemory`: a memória de origem entra com uma linha de procedência no topo.
   */
  async copyFrom(projectId: string, body: unknown, fromBrowser: boolean): Promise<{ profile: StaffProfile } | null> {
    if (!fromBrowser) throw new StaffError('só pelo Claudio’s Club');
    const parsed = CopyBody.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'pedido inválido');
    const { fromProjectId, staffId, withMemory, reportsTo } = parsed.data;
    if (fromProjectId === projectId) throw new StaffError('a origem é este mesmo projeto');
    const target = await this.project(projectId);
    const source = await this.project(fromProjectId);
    const src = source ? await readProfile(source.path, staffId) : null;
    if (!target || !source || !src) return null;
    // Mesma checagem de `hire`: cada gestor tem que ser funcionário deste projeto (senão lança e nada é criado).
    await this.managers(target.path, reportsTo);

    // Mesma pessoa: a cópia herda o vínculo da origem (ou a origem ganha um agora, e a cópia entra no grupo).
    const personId = await this.ensurePersonId(source.path, src);
    const portrait = await readPortrait(source.path, src);
    const input: StaffInputParsed = {
      name: src.name,
      role: src.role,
      reportsTo,
      mission: src.mission,
      firstTask: '',
      autonomy: src.autonomy,
      agents: src.agents,
      skills: src.skills,
      mcps: src.mcps,
      knowledge: src.knowledge,
      rules: src.rules,
      doneWhen: src.doneWhen,
      model: src.model,
      effort: src.effort,
      canHire: src.canHire,
      playbook: src.playbook,
      worktree: src.worktree,
      servers: [],
      browser: src.browser,
      portraitDataUrl: portrait ? `data:${portrait.type};base64,${portrait.bytes.toString('base64')}` : null,
    };
    const now = new Date();
    const created = await createProfile(target.path, projectId, input, now);
    const profile: StaffProfile = { ...created, personId };
    await saveProfile(target.path, profile);

    // Memória: a de origem (com a procedência no topo) ou a padrão. Antes do .md: ensureMemory nunca sobrescreve.
    const oldMemory = withMemory ? await fs.readFile(memoryFile(source.path, src.id), 'utf8').catch(() => null) : null;
    if (oldMemory !== null) {
      await writeAtomic(memoryFile(target.path, profile.id), `Copiada de ${source.name} em ${now.toLocaleDateString('pt-BR')}\n\n${oldMemory}`);
    }
    await ensureMemory(target.path, profile);
    await writeFicha(profile, await this.context(target, profile));
    return { profile };
  }

  /**
   * O `personId` da ficha de origem; se não tem, gera um e grava só o JSON (sem versão nova, sem updatedAt). Com o
   * lock da ficha: duas cópias ao mesmo tempo não criam dois grupos.
   */
  private async ensurePersonId(projectPath: string, src: StaffProfile): Promise<string> {
    if (src.personId) return src.personId;
    return withProfileLock(projectPath, src.id, async () => {
      const fresh = (await readProfile(projectPath, src.id)) ?? src;
      if (fresh.personId) return fresh.personId;
      const personId = randomUUID();
      await saveProfile(projectPath, { ...fresh, personId });
      return personId;
    });
  }

  /** Grava o vínculo (ou tira, com null) da ficha, pelo lock dela. Não mexe em versão nem em updatedAt. */
  private async setPersonId(projectPath: string, staffId: string, personId: string | null): Promise<void> {
    await withProfileLock(projectPath, staffId, async () => {
      const fresh = await readProfile(projectPath, staffId);
      if (!fresh) return;
      const { personId: _old, ...rest } = fresh;
      await saveProfile(projectPath, personId ? { ...rest, personId } : rest);
    });
  }

  /**
   * Edita a ficha (só pelo navegador). A versão anterior vai para o histórico; sessões e data de
   * contratação ficam. Retrato: data URL troca, null remove, ausente mantém.
   */
  /**
   * `applyToCopies: true` leva a edição às cópias da mesma pessoa (ver applyToCopies). `copiesUpdated` vem sempre (0 quando
   * não se aplica).
   */
  async update(projectId: string, staffId: string, body: unknown): Promise<(StaffProfile & { copiesUpdated: number }) | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    const parsed = StaffInputSchema.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'ficha inválida');
    const flags = ApplyToCopiesBody.safeParse(body);
    if (!flags.success) throw new StaffError('applyToCopies tem que ser true ou false');
    const { portraitDataUrl, launch: _launch, adoptSessionId: _adopt, force: _force, ...fields } = parsed.data;
    if (fields.reportsTo.includes(staffId)) throw new StaffError('um funcionário não pode reportar a si mesmo');
    await this.managers(project.path, fields.reportsTo);
    if (await this.wouldCycle(project.path, staffId, fields.reportsTo)) {
      throw new StaffError('esse vínculo criaria um ciclo (um subordinado não pode chefiar o próprio gestor)');
    }

    const saved = await this.saveEdit(project, current, { ...current, ...fields, projectId }, portraitDataUrl);
    const copiesUpdated = flags.data.applyToCopies && saved.personId ? await this.applyToCopies(project, saved) : 0;
    return { ...saved, copiesUpdated };
  }

  /**
   * Uma edição gravada: a versão anterior vai para o histórico; retrato (data URL troca, null remove, ausente mantém);
   * JSON, .md e aviso às conversas abertas. É o caminho de salvar de toda edição, inclusive das cópias.
   */
  private async saveEdit(project: Project, current: StaffProfile, next: StaffProfile, portraitDataUrl: string | null | undefined): Promise<StaffProfile> {
    await archiveVersion(project.path, current);
    let portrait = current.portrait;
    if (portraitDataUrl === null) portrait = await removePortrait(project.path, current);
    else if (portraitDataUrl) portrait = await replacePortrait(project.path, current, portraitDataUrl);
    const saved: StaffProfile = { ...next, portrait, updatedAt: new Date().toISOString() };
    await saveProfile(project.path, saved);
    await writeFicha(saved, await this.context(project, saved));
    this.opts.onChange?.(current, saved);
    return saved;
  }

  /**
   * Leva a edição (já salva) às cópias da mesma pessoa, em todos os projetos do quadro (sem worktrees, como o diretório).
   * Só os campos de COPY_TEXT_FIELDS e o retrato. Cada cópia passa por saveEdit, com o lock dela. Uma falha não para as
   * outras: vai para o log e não conta. Devolve quantas foram atualizadas.
   */
  private async applyToCopies(source: Project, saved: StaffProfile): Promise<number> {
    const picture = await readPortrait(source.path, saved);
    const dataUrl = picture ? `data:${picture.type};base64,${picture.bytes.toString('base64')}` : null;
    const text = Object.fromEntries(COPY_TEXT_FIELDS.map((k) => [k, saved[k]])) as Partial<StaffProfile>;
    let updated = 0;
    for (const project of (await this.adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf)) {
      const copies = (await listProjectStaff(project.path, project.id).catch(() => [])).filter(
        (s) => s.personId === saved.personId && !(project.id === source.id && s.id === saved.id),
      );
      for (const c of copies) {
        try {
          await withProfileLock(project.path, c.id, async () => {
            const cur = await readProfile(project.path, c.id);
            if (!cur || cur.personId !== saved.personId) return;
            await this.saveEdit(project, cur, { ...cur, ...text, projectId: project.id }, dataUrl);
            updated++;
          });
        } catch (err) {
          console.warn(`[staff] cópia de ${saved.name} em ${project.name} (${c.id}) não atualizada: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return updated;
  }

  /** Troca as rotinas agendadas (só pelo Claudio’s Club). A ficha anterior vai para o histórico. */
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
      // O último modelo/esforço do chat também é do presente.
      lastModel: current.lastModel,
      lastEffort: current.lastEffort,
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
   * temporários: um funcionário seu não é encerrado por outro. Com `requestedBy` (um funcionário pela API), só quem
   * contratou esse temporário encerra.
   */
  async end(projectId: string, staffId: string, reason: string, requestedBy?: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    if (!current.temporary) throw new StaffError(`${current.name} não é temporário: só você arquiva, pelo quadro`);
    if (requestedBy !== undefined && current.hiredBy !== requestedBy) throw new StaffError(`só quem contratou ${current.name} encerra pela API`);
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

  /**
   * Liga duas fichas como a mesma pessoa. O `personId` é o do destino (`to`), senão o da origem (`from`), senão um novo.
   * Se `from` estava em outro grupo, o grupo inteiro dele (em todos os projetos) passa para o escolhido.
   */
  async link(body: unknown, fromBrowser: boolean): Promise<{ personId: string } | null> {
    if (!fromBrowser) throw new StaffError('só pelo Claudio’s Club');
    const parsed = LinkBody.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'pedido inválido');
    const { from, to } = parsed.data;
    if (from.projectId === to.projectId && from.staffId === to.staffId) throw new StaffError('é a mesma ficha: escolha duas');
    const [fromProject, toProject] = await Promise.all([this.project(from.projectId), this.project(to.projectId)]);
    const a = fromProject ? await readProfile(fromProject.path, from.staffId) : null;
    const b = toProject ? await readProfile(toProject.path, to.staffId) : null;
    if (!fromProject || !toProject || !a || !b) return null;
    const personId = b.personId ?? a.personId ?? randomUUID();
    if (a.personId && a.personId !== personId) await this.regroup(a.personId, personId);
    await this.setPersonId(fromProject.path, a.id, personId);
    await this.setPersonId(toProject.path, b.id, personId);
    return { personId };
  }

  /** Tira o vínculo só desta ficha (as outras cópias continuam no grupo). */
  async unlink(body: unknown, fromBrowser: boolean): Promise<{ ok: true } | null> {
    if (!fromBrowser) throw new StaffError('só pelo Claudio’s Club');
    const parsed = UnlinkBody.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'pedido inválido');
    const project = await this.project(parsed.data.projectId);
    const ficha = project ? await readProfile(project.path, parsed.data.staffId) : null;
    if (!project || !ficha) return null;
    await this.setPersonId(project.path, ficha.id, null);
    return { ok: true };
  }

  /** Todas as fichas do grupo `from` (em todos os projetos do quadro) passam para `to`. */
  private async regroup(from: string, to: string): Promise<void> {
    for (const project of (await this.adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf)) {
      for (const s of await listProjectStaff(project.path, project.id).catch(() => [])) {
        if (s.personId === from) await this.setPersonId(project.path, s.id, to);
      }
    }
  }

  /**
   * Apaga a ficha de vez: JSON, .md, memória, retrato e histórico de versões. Quem reportava a ela (no mesmo projeto)
   * perde esse gestor (versão anterior no histórico, .md refeito); `orphaned` lista os que ficaram sem gestor por isso.
   * Recusa (409) se uma conversa dela está trabalhando, mesmo com `force`. Com tarefas abertas (executora ou revisora),
   * recusa (409, code `open-tasks`, com `openTasks`) salvo `{ force: true }`: aí as tarefas ficam no quadro sem
   * responsável (ver releaseTasks). Fica de fora: o ssh_config (fica em .vps, fora de .myco/staff) e a worktree git.
   */
  async deleteStaff(projectId: string, staffId: string, fromBrowser: boolean, body?: unknown): Promise<{ ok: true; orphaned: string[] } | null> {
    if (!fromBrowser) throw new StaffError('só pelo Claudio’s Club');
    const parsed = DeleteStaffBody.safeParse(body ?? {});
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'pedido inválido');
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    if (this.opts.isWorking?.(staffId)) {
      throw new StaffBusyError(`${current.name} está trabalhando numa conversa agora: espere terminar para apagar`);
    }
    // Tarefa aberta (não pronta nem no ar) como executora ou revisora: sem `force`, recusa; com ele, a tarefa fica sem responsável.
    const open = ((await this.opts.tasksOf?.(projectId)) ?? []).filter(
      (t) => (t.staffId === staffId || t.reviewerId === staffId) && t.status !== 'done' && t.status !== 'live',
    ).length;
    if (open > 0 && !parsed.data.force) {
      throw new StaffOpenTasksError(
        `${current.name} tem ${open} tarefa(s) aberta(s) no quadro: apagar deixa essas tarefas sem responsável. Confirme para apagar mesmo assim.`,
        open,
      );
    }
    if (open > 0) {
      if (!this.opts.releaseTasks) throw new StaffError(`não dá para soltar as tarefas de ${current.name} sem o quadro de tarefas`);
      await this.opts.releaseTasks(projectId, staffId);
    }

    // Vínculos de quem reportava a ela: tira o id (idempotente: refazer depois de uma falha não muda nada a mais).
    const orphaned: string[] = [];
    for (const s of await listProjectStaff(project.path, project.id)) {
      if (s.id === staffId || !s.reportsTo.includes(staffId)) continue;
      await withProfileLock(project.path, s.id, async () => {
        const fresh = await readProfile(project.path, s.id);
        if (!fresh) return;
        const reportsTo = fresh.reportsTo.filter((id) => id !== staffId);
        await this.saveEdit(project, fresh, { ...fresh, reportsTo }, undefined);
        if (reportsTo.length === 0) orphaned.push(s.id);
      });
    }

    // Arquivos da ficha, todos dentro de .myco/staff (o id já passou pela checagem de readProfile; o retrato, pelo nome).
    const dir = staffDir(project.path);
    const targets = [fichaFile(project.path, staffId), memoryFile(project.path, staffId), path.join(dir, `${staffId}.history`)];
    if (current.portrait && PORTRAIT_FILE.test(current.portrait)) targets.push(path.join(dir, current.portrait));
    if (targets.some((t) => !insideDir(dir, t))) throw new StaffError('caminho fora de .myco/staff');
    for (const t of targets) await fs.rm(t, { recursive: true, force: true });
    // O JSON por último: se algo falhar antes, a ficha continua no quadro e dá para apagar de novo.
    await fs.rm(profileFile(project.path, staffId), { force: true });

    // Saiu do quadro (arquivado): o id não fica na lista de arquivados.
    if (await this.archive.has(`staff:${staffId}`)) await this.archive.set(`staff:${staffId}`, false);
    return { ok: true, orphaned };
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

  /**
   * Trava de consumo antes de trabalho novo (conversa ou contratação): a linha de parada da empresa
   * (5h/7d) e o orçamento do projeto. Lança UsageStopError quando passou.
   */
  async checkUsage(projectId: string): Promise<void> {
    const [usage, config] = await Promise.all([(this.opts.readUsage ?? readUsage)(), readConfig()]);
    const hit = usageStopHit(usage, config.usageStop);
    if (hit) throw new UsageStopError(hit);
    const budget = config.projectBudgets[projectId];
    if (!budget || !this.opts.weekCost) return;
    const [week, project] = await Promise.all([this.opts.weekCost(projectId), this.project(projectId)]);
    const over = projectBudgetHit(usage, week, budget, project?.name ?? projectId);
    if (over) throw new UsageStopError(over);
  }

  /**
   * Linha de comando para conversar pelo Claudio’s Club. Com ficha: autonomia, modelo, MCPs e identidade
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
      if (sessionId) return { sessionId, cwd: project.path, args: ['--resume', sessionId, '--permission-mode', 'manual'] };
      // Conversa nova sem ficha (ex.: a anterior ficou pesada): começa vazia, na pasta do projeto, pedindo antes de agir.
      const id = randomUUID();
      return { sessionId: id, cwd: project.path, args: ['--session-id', id, '--permission-mode', 'manual'] };
    }
    let profile = await readProfile(project.path, staffId);
    if (!profile) return null;
    profile = { ...profile, projectId };
    const resume = !!sessionId && !forkFrom;
    const id = resume ? sessionId! : randomUUID();
    const ctx = await this.context(project, profile, true);
    const cwd = sessionCwd(profile, ctx, forkFrom ?? sessionId);
    // Chrome só com a extensão instalada (vale só para esta conversa: a ficha salva segue como o dono escolheu).
    const browser = await effectiveBrowser(profile.browser, this.opts.browserStatus);
    const run = await prepareRun({ ...profile, browser }, ctx, id, cwd);
    // Modelo e esforço: o da conversa (reabrir, ou a de origem ao duplicar) > o da ficha > o último escolhido no chat.
    const origin = profile.sessions.find((x) => x.id === (forkFrom ?? sessionId));
    if (!resume) {
      const now = new Date().toISOString();
      // A cópia nasce com a escolha da origem gravada: ao reabrir depois, sai igual.
      const entry = { id, startedAt: now, cwd, ...(forkFrom && origin?.model && { model: origin.model }), ...(forkFrom && origin?.effort && { effort: origin.effort }) };
      // Ficha fresca, na fila das trocas do chat: uma troca de modelo pode ter gravado algo desde a leitura lá em cima.
      await withProfileLock(project.path, staffId, async () => {
        const fresh = (await readProfile(project.path, staffId)) ?? profile;
        await saveProfile(project.path, { ...fresh, projectId, sessions: [...fresh.sessions, entry], updatedAt: now });
      });
    }
    const effective: StaffProfile = {
      ...profile,
      browser,
      model: origin?.model ?? profile.model ?? profile.lastModel ?? null,
      effort: origin?.effort ?? profile.effort ?? profile.lastEffort ?? null,
    };
    const args = buildClaudeArgs(effective, { ...run, sessionId: id, resume, firstPrompt: null, ...(forkFrom && { forkFrom }) });
    return { sessionId: id, cwd, args, ...((origin?.model || origin?.effort) && { chosen: true }) };
  }

  /**
   * Guarda o modelo/esforço escolhido no seletor do chat (ver saveChatChoice): vale para aquela conversa
   * e vira o "último" do funcionário. Só o JSON: não reescreve a ficha .md nem avisa as conversas.
   */
  async rememberChoice(projectId: string, staffId: string, sessionId: string | null, choice: { model?: string; effort?: string }): Promise<void> {
    const project = await this.project(projectId);
    if (project) await saveChatChoice(project.path, staffId, sessionId, choice);
  }

  async portrait(projectId: string, staffId: string) {
    const project = await this.project(projectId);
    const profile = project ? await readProfile(project.path, staffId) : null;
    return project && profile ? readPortrait(project.path, profile) : null;
  }

  /** `createWorktree`: vai abrir uma sessão agora, então a worktree da ficha precisa existir. */
  private async context(project: Project, profile: StaffProfile, createWorktree = false): Promise<LaunchContext> {
    const [config, managers, servers, worktree, everyone] = await Promise.all([
      readConfig(),
      Promise.all(profile.reportsTo.map((id) => readProfile(project.path, id))),
      // O ssh_config dele é refeito a cada sessão e a cada mudança na ficha, só com as conexões dela:
      // vale o que está no .vps/config.json agora (e tirar da ficha corta o acesso).
      writeStaffSshConfig(project.path, profile.id, profile.servers).then(() => (profile.servers.length ? allServers(project.path, this.opts.vault) : [])),
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
      // A pasta, não o apelido: a ficha grava este nome dentro do projeto (`Projeto: …`).
      projectName: path.basename(project.path),
      projectPath: project.path,
      managerNames: managers.filter((m): m is StaffProfile => !!m).map((m) => `${m.name} (${m.role})`),
      mycoUrl: this.opts.mycoUrl,
      runDir: this.opts.runDir,
      claudeConfigFile: this.opts.claudeConfigFile,
      worktree,
      servers,
      // As chaves de todas as conexões SSH do projeto: nenhum funcionário precisa ler uma (quem lê é o ssh).
      serverKeys: await keyFilesOf(project.path),
      librarySkills: profile.skills.length ? await librarySkillsOf(profile.skills, this.opts.skillLibraryDir) : [],
      skillLibraryDir: this.opts.skillLibraryDir,
      // A equipe dele: quem reporta a ele (os temporários encerrados já saíram do quadro, mas a ficha
      // não sabe disso; ficam de fora os que têm `ended`).
      team: everyone
        .filter((s) => s.id !== profile.id && s.reportsTo.includes(profile.id) && !s.ended)
        .map((s) => ({ id: s.id, name: s.name, role: s.role, mission: s.mission, ...(s.temporary && { temporary: true }) })),
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
