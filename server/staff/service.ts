import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type {
  AccountUsage,
  AnyConnection,
  BrowserStatus,
  EngineOverride,
  FtpConnection,
  LaunchResult,
  McpServerInfo,
  Project,
  ProjectConnection,
  ServerInfo,
  StaffProfile,
  Task,
} from '../../shared/model';
import { PERSON_FIELDS } from '../../shared/person';
import type { VaultOptions } from '../secretVault';
import { isFtpConnection, listFtpServers, readFtpConnections, removeFtpConnection, saveFtpConnection, testFtpConnection, type FtpConnector } from './ftp';
import { keyFilesOf, listServers, readConnections, removeConnection, saveConnection, testConnection, writeStaffSshConfig } from './servers';

/** SSH completas e FTP com senha: o que dá para pôr numa ficha. */
async function allServers(projectPath: string, vault?: VaultOptions): Promise<ServerInfo[]> {
  return [...(await listServers(projectPath)), ...(await listFtpServers(projectPath, vault))];
}

/** Nomes de todas as conexões FTP do projeto, com ou sem senha: o Codex não aceita nenhuma na ficha (ver `codexProfileError`). */
async function ftpNames(projectPath: string, vault?: VaultOptions): Promise<string[]> {
  return (await readFtpConnections(projectPath, vault)).map((c) => c.name);
}
import type { ToolAdapter } from '../adapters/types';
import { effectiveBrowser } from '../browser';
import { MYCO_HOME, readConfig, setArchived, workspaceOf } from '../config';
import { librarySkillsOf } from '../skillLibrary';
import { listRoles } from '../roles';
import { readUsage } from '../usage';
import { atMostAutonomy } from '../taskFallback';
import { projectBudgetHit, usageStopHit, UsageStopError } from '../usageStop';
import { TEMP_IDLE_DAYS } from '../../shared/model';
import { codexModelOrNull, type CodexSpawn } from '../chat/codexArgs';
import type { CodexEnvStatus } from '../codexEnv';
import type { CodexModelsResult } from '../codexModels';
import { readCodexThread } from '../chat/codexProcess';
import { buildClaudeArgs, capAutonomy } from './ficha';
import { greeting, prepareCodexRun, prepareRun, sessionCwd, writeFicha, type LaunchContext } from './launch';
import { ensureWorktree, worktreeFor, type Worktree } from './worktree';
import { listMcpServers } from './mcp';
import { readSeal, sealViolation, writeSeal } from './seal';
import {
  archiveVersion,
  createProfile,
  ensureMemory,
  fichaFile,
  listProjectStaff,
  listVersions,
  memoryDir,
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
  assertFallbackRules,
  assertProfileRules,
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

/** O que um cargo preenche na ficha quando o pedido não traz a chave. canHire, servidores e navegador seguem as regras do hire. */
const ROLE_FIELDS = ['role', 'mission', 'rules', 'doneWhen', 'model', 'effort', 'autonomy', 'playbook', 'worktree'] as const;

/**
 * Com `roleId`, o cargo entra antes da validação: o que o pedido trouxe (inclusive null ou vazio) ganha do cargo.
 * Cargo que não existe é erro (não se contrata um cargo adivinhado).
 */
async function withRole(body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (raw.roleId === undefined || raw.roleId === null) return body;
  const id = String(raw.roleId);
  const role = (await listRoles()).find((r) => r.id === id);
  if (!role) throw new StaffError(`cargo não encontrado: ${id}`);
  const fromRole: Record<(typeof ROLE_FIELDS)[number], unknown> = {
    role: role.role,
    mission: role.mission,
    rules: role.rules,
    doneWhen: role.doneWhen,
    model: role.model || null, // '' (padrão do Claude Code) não passa no schema: vira null
    effort: role.effort,
    autonomy: role.autonomy,
    playbook: role.playbook,
    worktree: role.worktree,
  };
  const filled = Object.fromEntries(ROLE_FIELDS.filter((k) => !(k in raw) && fromRole[k] !== undefined).map((k) => [k, fromRole[k]]));
  return { ...filled, ...raw };
}

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
/** Aceito por compatibilidade (clientes antigos mandam). A propagação às cópias é sempre; o valor não muda nada. */
const ApplyToCopiesBody = z.object({ applyToCopies: z.boolean().optional() });
/** Apagar com tarefas abertas: `force` deixa as tarefas sem responsável (confirmado na tela). Sem corpo = sem force. */
const DeleteStaffBody = z.object({ force: z.boolean().default(false) });
const engineOf = (p: Pick<StaffProfile, 'engine'>) => p.engine ?? 'claude';

/**
 * A ficha como a conversa do motor secundário a enxerga (ver `chatSpawn`). Claude no lugar de Codex roda fora da sandbox: sem
 * Chrome, MCPs, servidores nem contratar. A autonomia é `aceitar edições` (o padrão), ou o modo que a conversa já tinha
 * (`o.autonomy`), nunca acima de `aceitar edições` (sem sandbox, `auto` daria ao Claude mais do que o Codex tinha) nem da
 * ficha Codex: se ela é `plan` ou `manual`, fica a dela. Modo desconhecido já chega como `manual` (ver tasks.ts).
 */
function asEngine(profile: StaffProfile, o: EngineOverride): StaffProfile {
  const base: StaffProfile = { ...profile, engine: o.engine, model: o.model, effort: o.effort ?? null, ...(o.autonomy && { autonomy: o.autonomy }) };
  if (o.engine === 'claude' && profile.engine === 'codex') {
    const teto = profile.autonomy;
    const autonomy = teto === 'plan' || teto === 'manual' ? teto : atMostAutonomy(atMostAutonomy(o.autonomy ?? 'acceptEdits', teto), 'acceptEdits');
    return { ...base, autonomy, browser: false, mcps: [], canHire: false, servers: [] };
  }
  return base;
}

/** `child` está dentro de `dir` (sem sair por `..` nem por outro caminho). */
function insideDir(dir: string, child: string): boolean {
  const root = path.resolve(dir) + path.sep;
  return path.resolve(child).startsWith(root);
}

export interface StaffServiceOptions {
  runDir: string;
  claudeConfigFile: string;
  /** Endereço do Claudio’s Club para as conversas do Claude (http://127.0.0.1:<porta>), nos textos da ficha. */
  mycoUrl: string;
  /** O mesmo para quem roda no Codex: o endereço que a sandbox alcança (http://127.0.0.2:<porta>, ver server/callers.ts). Sem ele, o `mycoUrl`. */
  codexUrl?: string;
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
  /** Alguma conversa deste funcionário, neste projeto, está trabalhando agora (outro projeto não conta). */
  isWorking?: (projectId: string, staffId: string) => boolean;
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
  /**
   * Catálogo de modelos do Codex da conta (o mesmo de GET /api/codex/models). Com ele, salvar uma ficha do Codex com modelo fora do
   * catálogo é recusado; catálogo indisponível (codex ausente ou falha): aceita e registra um aviso. Sem ele, não confere.
   */
  codexCatalog?: () => Promise<CodexModelsResult>;
  /** O Codex está ligado nas configurações (`codexReview`, o "usar o Codex")? Padrão: lê o config. Desligado, a conversa de quem roda no Codex não abre. */
  codexEnabled?: () => Promise<boolean>;
  /**
   * Confere o `codex` instalado (versão mínima 0.156.1 e `network_proxy`, ver server/codexEnv.ts). Com erro, a conversa de quem roda no Codex
   * não abre e a mensagem diz como atualizar. Sem esta função, não confere.
   */
  codexEnv?: () => Promise<CodexEnvStatus>;
  /** Aviso no log do servidor (padrão console.warn). */
  log?: (line: string) => void;
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
      const sshWrite = (s.sshWrite ?? []).map((n) => (n === from ? to : n));
      await saveProfile(project.path, { ...s, servers, sshWrite, updatedAt: new Date().toISOString() });
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
   * autonomia limitada à do gestor. Se algum gestor roda no Codex, o contratado nasce no Codex (`engine: 'codex'`, sem servidores
   * nem Chrome, autonomia no teto dele). Pedindo `engine: "claude"`, nasce Claude mas travado: autonomia `manual` (tudo passa pela
   * aprovação do usuário), sem Chrome, MCPs, servidores nem `canHire`, e selado (ver seal.ts) para não subir a própria autonomia.
   *
   * `caller`: quem chama, pelo token da conversa (ver callers.ts). Com ele, o gestor é quem chama e o `reportsTo` do pedido é descartado: quem
   * declara um gestor que não é ele não contrata em nome dele. Chamando uma conversa do Codex, valem as regras de gestor Codex mesmo que a
   * ficha dele tenha mudado de motor desde que a conversa abriu.
   */
  async hire(
    projectId: string,
    body: unknown,
    fromBrowser: boolean,
    caller?: { staffId: string | null; engine: 'claude' | 'codex' } | null,
  ): Promise<{ profile: StaffProfile; launch: LaunchResult | null } | null> {
    const project = await this.project(projectId);
    if (!project) return null;
    // Pedido sem a chave `mcps` nasce sem MCP (o default do schema é null = todos, só para fichas antigas).
    const bodyHasMcps = !!body && typeof body === 'object' && 'mcps' in body;
    const parsed = StaffInputSchema.safeParse(await withRole(body));
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'ficha inválida');
    const input = parsed.data;
    if (!bodyHasMcps) input.mcps = [];
    // Ficha nova sem `engine` é do Claude: o secundário não pode ser o mesmo motor, e servidor não vai ao secundário Codex.
    // FTP não vai ao Codex (o projeto diz quais são as conexões FTP).
    const ftpServers = await ftpNames(project.path, this.opts.vault);
    assertProfileRules({ ...input, sshWrite: input.sshWrite ?? [] }, ftpServers);
    assertFallbackRules({ engine: input.engine, servers: input.servers, fallback: input.fallback, ftpServers });

    if (!fromBrowser && caller) {
      if (!caller.staffId) throw new StaffError('só um funcionário (com ficha) contrata pela API');
      input.reportsTo = [caller.staffId];
    }
    const managers = await this.managers(project.path, input.reportsTo);
    const hirer = fromBrowser ? undefined : managers.find((m) => m.canHire);
    let lockedClaude = false; // Claude contratado por gestor no Codex: nasce selado (ver seal.ts)
    if (!fromBrowser) {
      if (!hirer) throw new StaffError('só um funcionário com permissão de contratar pode contratar pela API');
      // Gestor cuja ficha foi mexida fora do Claudio’s Club (um Codex que se rebaixou): não contrata (ver seal.ts).
      for (const m of managers) await this.guardSeal(project, m);
      input.autonomy = capAutonomy(input.autonomy, hirer.autonomy);
      input.canHire = false; // subfuncionário contratado por outro não contrata em cascata
      input.servers = input.servers.filter((s) => hirer.servers.includes(s)); // nem acessa servidor que o gestor não acessa
      input.browser = input.browser && hirer.browser; // nem usa o navegador se o gestor não usa
      if (hirer.mcps !== null) {
        // Nem MCP que o gestor não usa (se o gestor tem todos, `null`, o pedido vale como veio).
        const allowed = hirer.mcps;
        input.mcps = (input.mcps ?? allowed).filter((n) => allowed.includes(n));
      }
      // Quem tem gestor no Codex nasce no Codex (o padrão), com a autonomia dele no máximo e sem servidores nem Chrome. Pedindo
      // `engine: "claude"` (que roda fora da sandbox) nasce Claude travado: `manual`, sem Chrome, MCPs, servidores nem canHire.
      const codexManagers = managers.filter((m) => m.engine === 'codex');
      if (codexManagers.length || caller?.engine === 'codex') {
        input.servers = [];
        input.browser = false;
        if (input.engine === 'claude') {
          lockedClaude = true;
          input.autonomy = 'manual';
          input.mcps = [];
          input.canHire = false;
        } else {
          input.engine = 'codex';
          input.model = codexModelOrNull(input.model);
          for (const m of codexManagers) input.autonomy = capAutonomy(input.autonomy, m.autonomy);
          // O motor foi forçado a Codex: o secundário tem de ser outro motor, e o Codex não leva servidor (de novo, agora com o motor certo).
          assertFallbackRules({ engine: input.engine, servers: input.servers, fallback: input.fallback, ftpServers });
        }
      }
    }
    // A escrita SSH só vale para conexão que ficou na ficha (os filtros acima podem ter tirado servidores).
    input.sshWrite = (input.sshWrite ?? []).filter((n) => input.servers.includes(n));
    // Contratado pela API: a escrita SSH do subordinado é no máximo a do gestor que contratou (o pedido não amplia).
    if (hirer) input.sshWrite = input.sshWrite.filter((n) => (hirer.sshWrite ?? []).includes(n));
    await this.checkCodexModel(input.engine, input.model);

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
      await this.seal(project, profile, lockedClaude);
      await writeFicha(profile, await this.context(project, profile));
      return { profile, launch: null };
    }

    // A trava vale também para quem contrata pela API (sem como confirmar, só recusa).
    if (input.launch && !(fromBrowser && input.force)) await this.checkUsage(project.id, { engine: input.engine });
    let profile = await createProfile(project.path, project.id, input);
    await this.seal(project, profile, lockedClaude);
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
    await this.guardSeal(source, src); // não leva para a cópia uma ficha do Codex mexida por fora
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
      mcps: src.mcps ?? [], // "todos" da origem não são os MCPs deste projeto; a lista explícita segue
      knowledge: src.knowledge,
      rules: src.rules,
      doneWhen: src.doneWhen,
      ...(src.engine && { engine: src.engine }),
      model: src.model,
      effort: src.effort,
      canHire: src.canHire,
      playbook: src.playbook,
      worktree: src.worktree,
      servers: [],
      sshWrite: [],
      browser: src.browser,
      portraitDataUrl: portrait ? `data:${portrait.type};base64,${portrait.bytes.toString('base64')}` : null,
    };
    const now = new Date();
    const created = await createProfile(target.path, projectId, input, now);
    const profile: StaffProfile = { ...created, personId };
    await saveProfile(target.path, profile);
    await this.seal(target, profile, (await readSeal(this.opts.runDir, source.path, src.id))?.engine === 'claude'); // a trava do contratado por gestor no Codex vai junto

    // Memória: a de origem (com a procedência no topo) ou a padrão. Antes do .md: ensureMemory nunca sobrescreve.
    const oldMemory = withMemory ? await fs.readFile(memoryFile(source.path, src.id), 'utf8').catch(() => null) : null;
    if (oldMemory !== null) {
      await writeAtomic(memoryFile(target.path, profile.id), `Copiada de ${source.name} em ${now.toLocaleDateString('pt-BR')}\n\n${oldMemory}`);
    }
    // Arquivos de detalhe da memória (pasta irmã), se a origem tiver. fs.cp não segue links (dereference: false, o padrão).
    if (withMemory) {
      const srcDir = memoryDir(source.path, src.id);
      if (await fs.stat(srcDir).then((s) => s.isDirectory(), () => false)) {
        await fs.cp(srcDir, memoryDir(target.path, profile.id), { recursive: true });
      }
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

  /** O `personId` da ficha (gera e grava se faltar): a memória pessoal é da pessoa, então a tela precisa dele antes de editar. */
  async personOf(projectId: string, staffId: string): Promise<{ personId: string } | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    return { personId: await this.ensurePersonId(project.path, current) };
  }

  /** Ids das conversas de todas as fichas com este personId (em todos os projetos do quadro). */
  async sessionsOfPerson(personId: string): Promise<string[]> {
    const out: string[] = [];
    for (const project of (await this.adapter.listProjects()).filter((p) => p.exists && !p.worktreeOf)) {
      const copies = await listProjectStaff(project.path, project.id).catch(() => []);
      for (const s of copies) if (s.personId === personId) out.push(...s.sessions.map((x) => x.id));
    }
    return out;
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
   * Os campos da pessoa (PERSON_FIELDS e retrato) vão às cópias da mesma pessoa (ver applyToCopies). `copiesUpdated` = quantas
   * cópias mudaram (0 sem vínculo ou sem nada da pessoa mudando).
   */
  async update(projectId: string, staffId: string, body: unknown): Promise<(StaffProfile & { copiesUpdated: number }) | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    if (!project || !current) return null;
    const parsed = StaffInputSchema.safeParse(body);
    if (!parsed.success) throw new StaffError(parsed.error.issues[0]?.message ?? 'ficha inválida');
    const flags = ApplyToCopiesBody.safeParse(body);
    if (!flags.success) throw new StaffError('applyToCopies tem que ser true ou false');
    const { portraitDataUrl, launch: _launch, adoptSessionId: _adopt, force: _force, fallback, ...fields } = parsed.data;
    // Pedido sem `sshWrite` (a tela ainda não manda o campo): fica o que a ficha já tinha, para editar não zerar a escrita SSH.
    if (!(typeof body === 'object' && body !== null && 'sshWrite' in body)) fields.sshWrite = current.sshWrite ?? [];
    if (fields.reportsTo.includes(staffId)) throw new StaffError('um funcionário não pode reportar a si mesmo');
    await this.managers(project.path, fields.reportsTo);
    if (await this.wouldCycle(project.path, staffId, fields.reportsTo)) {
      throw new StaffError('esse vínculo criaria um ciclo (um subordinado não pode chefiar o próprio gestor)');
    }

    // O pedido pode não trazer o `engine` (fica o da ficha): as regras do Codex valem sobre a ficha já junta.
    const ftpServers = await ftpNames(project.path, this.opts.vault);
    assertProfileRules({ ...current, ...fields }, ftpServers);
    // Secundário: ausente = fica o da ficha; null = tira; objeto = troca.
    const nextFallback = fallback === undefined ? current.fallback : (fallback ?? undefined);
    assertFallbackRules({ ...current, ...fields, fallback: nextFallback, ftpServers });
    // Só confere o que mudou: um modelo que já estava na ficha (e que a conta deixou de aceitar) não trava uma edição qualquer;
    // quem roda no Codex tem o plano B (outro modelo na mensagem) para isso.
    const engine = fields.engine ?? current.engine;
    if (engine === 'codex' && (engine !== current.engine || fields.model !== current.model)) await this.checkCodexModel(engine, fields.model);
    const saved = await this.saveEdit(project, current, { ...current, ...fields, fallback: nextFallback, projectId }, portraitDataUrl);
    await this.seal(project, saved); // salvar pela tela confirma motor e autonomia (inclusive de uma ficha que foi mexida por fora)
    const copiesUpdated = saved.personId ? await this.applyToCopies(project, saved, portraitDataUrl) : 0;
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
   * Leva os campos da pessoa (PERSON_FIELDS) já salvos na origem às cópias da mesma pessoa, em todos os projetos do quadro
   * (sem worktrees, como o diretório). `portraitDataUrl` como no pedido: undefined não mexe no retrato das cópias; null
   * remove; data URL troca (vai o retrato da origem, já gravado). Cada cópia passa por saveEdit, com o lock dela; uma cópia
   * já igual não ganha versão nova. Uma falha não para as outras: vai para o log e não conta. Devolve quantas mudaram.
   */
  private async applyToCopies(source: Project, saved: StaffProfile, portraitDataUrl?: string | null): Promise<number> {
    const picture = portraitDataUrl === undefined || portraitDataUrl === null ? null : await readPortrait(source.path, saved);
    const dataUrl = portraitDataUrl === undefined ? undefined : picture ? `data:${picture.type};base64,${picture.bytes.toString('base64')}` : null;
    const text = Object.fromEntries(PERSON_FIELDS.map((k) => [k, saved[k]])) as Partial<StaffProfile>;
    const { model: _model, effort: _effort, ...common } = text;
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
            const igual = PERSON_FIELDS.every((k) => JSON.stringify(cur[k]) === JSON.stringify(saved[k]));
            if (igual && dataUrl === undefined) return;
            // Modelo e esforço só vão para cópia do mesmo motor (um alias do Claude não vale no Codex, nem `ultra` no Claude).
            const patch = engineOf(cur) === engineOf(saved) ? text : common;
            assertProfileRules({ ...cur, ...patch });
            await this.saveEdit(project, cur, { ...cur, ...patch, projectId: project.id }, dataUrl);
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

  /**
   * Volta a ficha para uma versão anterior (a atual também vai para o histórico). Com cópias da mesma pessoa, os campos
   * da pessoa restaurados vão para elas (mesmo caminho da edição): assim a volta também desfaz uma mudança que tinha
   * ido para as cópias, e nada diverge em silêncio.
   */
  async restore(projectId: string, staffId: string, version: string): Promise<StaffProfile | null> {
    const project = await this.project(projectId);
    const current = project ? await readProfile(project.path, staffId) : null;
    const old = project ? await readVersion(project.path, staffId, version) : null;
    if (!project || !current || !old) return null;
    await archiveVersion(project.path, current);
    // Sessões e retrato são do presente: só os campos da ficha voltam.
    // Rotinas também são do presente: voltar a ficha não desagenda nem reagenda nada.
    // O vínculo com as cópias também é do presente: a versão antiga pode não ter `personId`, e perdê-lo sairia do grupo.
    const next: StaffProfile = {
      ...old,
      id: current.id,
      projectId,
      personId: current.personId,
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
    await this.seal(project, next);
    await writeFicha(next, await this.context(project, next));
    this.opts.onChange?.(current, next);
    if (next.personId) await this.applyToCopies(project, next);
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
        if ((await this.archive.has(`staff:${s.id}`)) || this.opts.isWorking?.(project.id, s.id)) continue;
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
    if (this.opts.isWorking?.(projectId, staffId)) {
      throw new StaffBusyError(`${current.name} está trabalhando numa conversa agora: espere terminar para apagar`);
    }
    // Tarefa aberta (não pronta) como executora ou revisora: sem `force`, recusa; com ele, a tarefa fica sem responsável.
    const open = ((await this.opts.tasksOf?.(projectId)) ?? []).filter(
      (t) => (t.staffId === staffId || t.reviewerId === staffId) && t.status !== 'done',
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
    const targets = [fichaFile(project.path, staffId), memoryFile(project.path, staffId), memoryDir(project.path, staffId), path.join(dir, `${staffId}.history`)];
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
    await this.guardSeal(project, current); // `update` confirmaria (selaria) o que está no disco: uma ficha mexida por fora não passa por aqui
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
    await this.guardSeal(project, current);
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
   * `who`: para quem vai o trabalho. As duas travas leem o consumo do Claude: quem roda no Codex (outra conta) não passa por elas.
   */
  async checkUsage(projectId: string, who?: { staffId?: string | null; engine?: 'claude' | 'codex' }): Promise<void> {
    if (await this.runsOnCodex(projectId, who)) return;
    const [usage, config] = await Promise.all([(this.opts.readUsage ?? readUsage)(), readConfig()]);
    const hit = usageStopHit(usage, config.usageStop);
    if (hit) throw new UsageStopError(hit);
    const budget = config.projectBudgets[projectId];
    if (!budget || !this.opts.weekCost) return;
    const [week, project] = await Promise.all([this.opts.weekCost(projectId), this.project(projectId)]);
    const over = projectBudgetHit(usage, week, budget, project?.name ?? projectId);
    if (over) throw new UsageStopError(over);
  }

  private async runsOnCodex(projectId: string, who?: { staffId?: string | null; engine?: 'claude' | 'codex' }): Promise<boolean> {
    if (who?.engine) return who.engine === 'codex';
    if (!who?.staffId) return false;
    const project = await this.project(projectId);
    return !!project && (await readProfile(project.path, who.staffId))?.engine === 'codex';
  }

  /**
   * Ficha do Codex com modelo que a conta não tem (o caso do `gpt-6.1-sol`, configurado mas recusado com `model_not_found`) não é salva.
   * Sem catálogo (codex ausente, sem login, falha), não há como saber: aceita e deixa um aviso no log, sem travar o salvamento.
   */
  private async checkCodexModel(engine: string | undefined, model: string | null): Promise<void> {
    if (engine !== 'codex' || !model || !this.opts.codexCatalog) return;
    const warn = this.opts.log ?? ((line: string) => console.warn(`[staff] ${line}`));
    let catalog: CodexModelsResult | null = null;
    try {
      catalog = await this.opts.codexCatalog();
    } catch (err) {
      warn(`modelo ${model} do Codex salvo sem conferir: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!catalog.models.length) {
      warn(`modelo ${model} do Codex salvo sem conferir: catálogo indisponível (${catalog.reason ?? 'vazio'})`);
      return;
    }
    if (!catalog.models.some((m) => m.slug === model)) {
      throw new StaffError(`O modelo ${model} não está no catálogo do Codex desta conta. Escolha um destes: ${catalog.models.map((m) => m.slug).join(', ')}`);
    }
  }

  /**
   * Linha de comando para conversar pelo Claudio’s Club. Com ficha: autonomia, modelo, MCPs e identidade
   * da ficha (sessão nova quando `sessionId` é null). Sem ficha: só retoma a sessão, pedindo
   * aprovação para tudo. `forkFrom`: sessão nova como cópia desta (duplicar a conversa), na mesma
   * pasta da original.
   * `engineOverride`: a conversa roda no motor/modelo secundário (ver `asEngine`); a ficha gravada não muda.
   */
  async chatSpawn(
    projectId: string,
    sessionId: string | null,
    staffId: string | null,
    forkFrom?: string,
    engineOverride?: EngineOverride,
  ): Promise<{ sessionId: string; cwd: string; args: string[]; chosen?: boolean; engine?: 'claude' | 'codex'; codex?: CodexSpawn } | null> {
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
    // Motor da conversa: o da ficha, ou o secundário (`engineOverride`), montado como se a ficha fosse dele. Só a montagem muda:
    // o que grava a ficha (selo, JSON) segue o `profile` de verdade.
    const runProfile = engineOverride ? asEngine(profile, engineOverride) : profile;
    const codex = runProfile.engine === 'codex';
    // Antes de qualquer coisa que grave (worktree, ssh_config, ficha .md): uma ficha do Codex mexida por fora (motor ou autonomia
    // diferentes dos que o Claudio’s Club gravou) não abre, nem como Claude. Ver seal.ts.
    await this.guardSeal(project, profile);
    if (codex) await this.assertCodexUsable();
    const ctx = await this.context(project, runProfile, true);
    const cwd = sessionCwd(runProfile, ctx, forkFrom ?? sessionId);
    // Segunda barreira (a primeira é ao salvar a ficha): uma ficha antiga, ou editada à mão, com servidores no Codex não abre: recusa em vez de rodar.
    assertProfileRules(runProfile, await ftpNames(project.path, this.opts.vault));
    if (codex && forkFrom) throw new StaffError('duplicar a conversa ainda não existe para funcionário que roda no Codex');
    // Chrome só com a extensão instalada (vale só para esta conversa: a ficha salva segue como o dono escolheu). No Codex não há Chrome.
    const browser = codex ? false : await effectiveBrowser(runProfile.browser, this.opts.browserStatus);
    const codexRun = codex ? await prepareCodexRun(runProfile, ctx, id, cwd) : null;
    const run = codexRun ? null : await prepareRun({ ...runProfile, browser }, ctx, id, cwd);
    // Modelo e esforço: o da conversa (reabrir, ou a de origem ao duplicar) > o da ficha > o último escolhido no chat.
    const origin = profile.sessions.find((x) => x.id === (forkFrom ?? sessionId));
    if (!resume) {
      const now = new Date().toISOString();
      // A cópia nasce com a escolha da origem gravada: ao reabrir depois, sai igual.
      // Conversa no secundário: motor, modelo e esforço ficam na entrada (o boot re-registra; ver directFallback.ts). Sem autonomia: a da ficha vale a cada abertura.
      const entry = {
        id,
        startedAt: now,
        cwd,
        ...(forkFrom && origin?.model && { model: origin.model }),
        ...(forkFrom && origin?.effort && { effort: origin.effort }),
        ...(engineOverride && { fallback: { engine: engineOverride.engine, model: engineOverride.model, ...(engineOverride.effort && { effort: engineOverride.effort }) } }),
      };
      // Ficha fresca, na fila das trocas do chat: uma troca de modelo pode ter gravado algo desde a leitura lá em cima.
      await withProfileLock(project.path, staffId, async () => {
        const fresh = (await readProfile(project.path, staffId)) ?? profile;
        await saveProfile(project.path, { ...fresh, projectId, sessions: [...fresh.sessions, entry], updatedAt: now });
      });
    }
    // Com `engineOverride`, o modelo e o esforço são os do secundário (a escolha gravada na conversa não entra: ela é do principal).
    const effective: StaffProfile = {
      ...runProfile,
      browser,
      model: engineOverride ? runProfile.model : (origin?.model ?? profile.model ?? profile.lastModel ?? null),
      effort: engineOverride ? runProfile.effort : (origin?.effort ?? profile.effort ?? profile.lastEffort ?? null),
    };
    const chosen = (origin?.model || origin?.effort) && { chosen: true };
    if (codexRun) {
      // Uma ficha que trocou de motor pode ter ficado com o modelo do Claude (`opus`…): no Codex isso não vale, vai o padrão dele.
      const spawn: CodexSpawn = {
        autonomy: effective.autonomy,
        model: codexModelOrNull(effective.model),
        effort: effective.effort,
        instructions: codexRun.instructions,
        writableRoots: codexRun.writableRoots,
        readOnlyPaths: codexRun.readOnlyPaths,
        sshMcp: codexRun.sshMcp,
        secrets: { projectPath: project.path, home: os.homedir(), mycoHome: MYCO_HOME },
        threadId: resume ? await readCodexThread(codexRun.threadFile) : null,
        threadFile: codexRun.threadFile,
        mycoUrl: ctx.mycoUrl,
        // Lida a cada execução (não só ao abrir a conversa): a Configuração vale na próxima mensagem.
        internetAccess: async () => (await readConfig()).internetAccess,
      };
      return { sessionId: id, cwd, args: [], engine: 'codex', codex: spawn, ...chosen };
    }
    const args = buildClaudeArgs(effective, { ...run!, sessionId: id, resume, firstPrompt: null, ...(forkFrom && { forkFrom }) });
    return { sessionId: id, cwd, args, ...chosen };
  }

  /**
   * Pré-checagem da troca de motor no meio da tarefa (ver TaskService.onLimit): as mesmas barreiras que `chatSpawn` aplicaria
   * a uma conversa no motor `override` (selo, Codex usável, regras da ficha, consumo do motor do override, modelo), sem gravar
   * nada: sem selo novo, sem contexto, sem processo. Lança o erro que a conversa daria.
   */
  async assertOverrideRunnable(projectId: string, staffId: string, override: EngineOverride): Promise<void> {
    const project = await this.project(projectId);
    if (!project) throw new StaffError('projeto não encontrado');
    const profile = await readProfile(project.path, staffId);
    if (!profile) throw new StaffError('funcionário não encontrado neste projeto');
    const runProfile = asEngine({ ...profile, projectId }, override);
    const violation = sealViolation(profile, await readSeal(this.opts.runDir, project.path, profile.id));
    if (violation) throw new StaffError(violation);
    if (runProfile.engine === 'codex') await this.assertCodexUsable();
    assertProfileRules(runProfile);
    await this.checkUsage(projectId, { staffId, engine: runProfile.engine });
    await this.checkCodexModel(runProfile.engine, runProfile.model);
  }

  /** Grava (Codex ou Claude travado) ou apaga (outro motor) o selo da ficha. Só onde o Claudio’s Club decide motor e autonomia (ver seal.ts). */
  private seal(project: Project, profile: StaffProfile, lockedClaude = false): Promise<void> {
    return writeSeal(this.opts.runDir, project.path, profile, { lockedClaude });
  }

  /**
   * A ficha do disco bate com o selo? Não: recusa (StaffError). Ficha do Codex sem selo (anterior a ele, ou de outro computador) é selada
   * agora, com o que o disco diz. Ficha que nunca foi do Codex não tem selo e passa direto (o caminho do Claude não muda).
   */
  private async guardSeal(project: Project, profile: StaffProfile): Promise<void> {
    const seal = await readSeal(this.opts.runDir, project.path, profile.id);
    const violation = sealViolation(profile, seal);
    if (violation) throw new StaffError(violation);
    if (!seal && profile.engine === 'codex') await this.seal(project, profile);
  }

  /** O Codex serve para abrir uma conversa agora? Ligado nas configurações, na versão mínima e instalado. Lança StaffError com o que fazer. */
  private async assertCodexUsable(): Promise<void> {
    const on = await (this.opts.codexEnabled ?? (async () => (await readConfig()).codexReview))();
    if (!on) {
      throw new StaffError('O Codex está desligado nas configurações: ligue "Usar o Codex (GPT)" para abrir conversas de quem roda no Codex (ou troque o motor da ficha para o Claude).');
    }
    const env = await this.opts.codexEnv?.();
    if (env?.error) throw new StaffError(env.error);
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
    // Quem pode contratar vê os cargos prontos (roleId). Se a leitura falhar, a ficha sai sem a lista.
    const roles = profile.canHire
      ? await listRoles().then(
          (rs) => rs.map((r) => ({ id: r.id, label: r.label })),
          () => null,
        )
      : null;
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
      // A sandbox do Codex só alcança 127.0.0.2: a ficha dele cita esse endereço.
      mycoUrl: profile.engine === 'codex' ? (this.opts.codexUrl ?? this.opts.mycoUrl) : this.opts.mycoUrl,
      runDir: this.opts.runDir,
      claudeConfigFile: this.opts.claudeConfigFile,
      worktree,
      servers,
      // As chaves de todas as conexões SSH do projeto: nenhum funcionário precisa ler uma (quem lê é o ssh).
      serverKeys: await keyFilesOf(project.path),
      librarySkills: profile.skills.length ? await librarySkillsOf(profile.skills, this.opts.skillLibraryDir) : [],
      skillLibraryDir: this.opts.skillLibraryDir,
      codex: config.codexReview,
      internetAccess: config.internetAccess,
      // Claude contratado por gestor no Codex (selo `claude`) e ainda no "Pede tudo": a ficha conta o porquê.
      lockedByCodexManager: profile.autonomy === 'manual' && profile.engine !== 'codex' && (await readSeal(this.opts.runDir, project.path, profile.id))?.engine === 'claude',
      // A equipe dele: quem reporta a ele (os temporários encerrados já saíram do quadro, mas a ficha
      // não sabe disso; ficam de fora os que têm `ended`).
      team: everyone
        .filter((s) => s.id !== profile.id && s.reportsTo.includes(profile.id) && !s.ended)
        .map((s) => ({ id: s.id, name: s.name, role: s.role, mission: s.mission, ...(s.temporary && { temporary: true }) })),
      ...(roles && { roles }),
    };
  }

  /**
   * A sandbox do Codex (quem chama, pelo token) pode falar com este alvo? Só com a própria conversa e com as de quem reporta a ele (`reportsTo`
   * inclui quem chama). Com conversa e funcionário juntos, os dois têm que ser da mesma pessoa. Conversa sem ficha nunca chama nem é alvo.
   */
  async mayReach(
    projectId: string,
    caller: { staffId: string | null; sessionId: string },
    target: { sessionId: string | null; staffId: string | null },
  ): Promise<boolean> {
    const project = await this.project(projectId);
    if (!project || !caller.staffId) return false;
    if (target.sessionId === caller.sessionId) return !target.staffId || target.staffId === caller.staffId;
    const everyone = await listProjectStaff(project.path, project.id);
    const mine = (s: StaffProfile) => s.reportsTo.includes(caller.staffId!);
    if (target.sessionId) {
      const owner = everyone.find((s) => s.sessions.some((x) => x.id === target.sessionId));
      return !!owner && mine(owner) && (!target.staffId || target.staffId === owner.id);
    }
    const person = target.staffId ? everyone.find((s) => s.id === target.staffId) : undefined;
    return !!person && mine(person);
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
